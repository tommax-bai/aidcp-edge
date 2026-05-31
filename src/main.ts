/**
 * aidcp-edge 边缘端启动入口（自动浏览 + 点赞垂直切片）。
 *
 * 装配：
 *  - 自动启动 / 复用本机 Chrome（由 chrome-launcher 管理生命周期）；
 *  - 连接本机 Chrome CDP（默认 127.0.0.1:9222），附着到一个 page，
 *    得到 DomProvider / ActionExecutor；
 *  - 连接云端 WS（默认 ws://127.0.0.1:8787），握手上线；
 *  - 元素选择委托云端（CloudElementSelector）；
 *  - 用 LikeStepRunner 执行云端下发的命令，结果回传云端；
 *  - 登录完成后创建 BrowseSession 并 start()：自动浏览 explore feed、打开笔记、
 *    提取内容上报云端、按云端决策（like / browse.next / search / session.end）动作。
 *
 * 环境变量：
 *  - AIDCP_CLOUD_URL       云端 WS 地址（默认 ws://127.0.0.1:8787）
 *  - AIDCP_EDGE_ID         边缘节点标识（默认 edge-local）
 *  - AIDCP_CDP_HOST        CDP host（默认 127.0.0.1）
 *  - AIDCP_CDP_PORT        CDP 端口（默认 9222）
 *  - AIDCP_PAGE_URL        仅附着 url 含该子串的页面（默认取第一个 page）
 *  - AIDCP_CHROME_PATH     Chrome 可执行文件路径（可选，缺省自动发现）
 *  - AIDCP_CHROME_PROFILE  user-data-dir 路径（可选，默认 ~/.aidcp-chrome-profile）
 *  - AIDCP_CHROME_HEADLESS 设为 'true' 启用 headless（默认 false，因需人工登录）
 *  - AIDCP_EXPLORE_URL     explore 页 URL（默认小红书 explore）
 *  - AIDCP_AUTO_BROWSE     设为 'false' 关闭自动浏览（默认开启）
 *
 * Chrome 由本进程自动启动并在退出时关闭；若检测到端口已有实例则复用，不重复启动。
 * 运行：npm start
 */

import { attachToPage, launchChrome } from './cdp/index.js';
import { EdgeClient } from './client/edge-client.js';
import { CloudElementSelector } from './client/cloud-selector.js';
import { LikeStepRunner } from './client/like-runner.js';
import {
  BrowseSession,
  CdpFeedScroller,
  CdpModalController,
  extractNoteContent,
  type BrowseSessionOptions,
} from './browse/index.js';

async function main(): Promise<void> {
  const cloudUrl = process.env.AIDCP_CLOUD_URL ?? 'ws://127.0.0.1:8787';
  const edgeId = process.env.AIDCP_EDGE_ID ?? 'edge-local';
  const cdpHost = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
  const cdpPort = Number(process.env.AIDCP_CDP_PORT ?? 9222);
  const pageUrl = process.env.AIDCP_PAGE_URL;

  console.log(`[aidcp-edge] 准备 Chrome（CDP ${cdpHost}:${cdpPort}）...`);
  const launchOpts: Parameters<typeof launchChrome>[0] = { host: cdpHost, port: cdpPort };
  if (process.env.AIDCP_CHROME_PATH) launchOpts.chromePath = process.env.AIDCP_CHROME_PATH;
  if (process.env.AIDCP_CHROME_PROFILE) launchOpts.profileDir = process.env.AIDCP_CHROME_PROFILE;
  if (process.env.AIDCP_CHROME_HEADLESS === 'true') launchOpts.headless = true;
  const chrome = await launchChrome(launchOpts);

  console.log(`[aidcp-edge] 连接本机 Chrome CDP ${cdpHost}:${cdpPort} ...`);
  const attachOpts: Parameters<typeof attachToPage>[0] = { host: cdpHost, port: cdpPort };
  if (pageUrl) attachOpts.urlIncludes = pageUrl;
  const session = await attachToPage(attachOpts);
  console.log('[aidcp-edge] 已附着到 page，CDP 就绪（反检测脚本已注入）');

  // 启用 Input 域（坐标点击 / 按键）；evaluate 已在 attachToPage 启用。
  await session.cdp.send('Input.enable').catch(() => undefined);

  // 先声明 runner（延迟赋值），打破 client/selector/runner 的相互依赖
  let runner: LikeStepRunner | undefined;

  const client = new EdgeClient({
    url: cloudUrl,
    edgeId,
    app: 'xhs',
    capabilities: ['locating', 'cdp', 'like', 'browse'],
    runner: {
      run: (step) => {
        if (!runner) throw new Error('runner 尚未就绪');
        return runner.run(step);
      },
    },
  });

  const selector = new CloudElementSelector(client);
  runner = new LikeStepRunner({
    dom: session.dom,
    executor: session.executor,
    selector,
  });

  await client.connect();
  console.log(`[aidcp-edge] 已连接云端 ${cloudUrl}，等待命令 ...`);

  // —— 自动浏览会话 ——
  let browse: BrowseSession | undefined;
  const autoBrowse = process.env.AIDCP_AUTO_BROWSE !== 'false';
  if (autoBrowse) {
    const browseOpts: BrowseSessionOptions = {};
    if (process.env.AIDCP_EXPLORE_URL) browseOpts.exploreUrl = process.env.AIDCP_EXPLORE_URL;
    browse = new BrowseSession(
      {
        dom: session.dom,
        cdp: session.cdp,
        client,
        scroller: new CdpFeedScroller(session.cdp),
        noteExtractor: extractNoteContent,
        modalCtrl: new CdpModalController(session.cdp),
        stepRunner: runner,
      },
      browseOpts,
    );
    // 云端可主动下发 session.end 提前结束本次浏览
    client.onBrowseCommand((env) => {
      if (env.type === 'session.end') {
        console.log('[aidcp-edge] 云端请求结束浏览会话');
        browse?.stop();
      }
    });
    // 不 await：浏览循环长跑，与命令收发并行
    browse.start().catch((err) => {
      console.error('[aidcp-edge] 浏览会话异常:', err);
    });
    console.log('[aidcp-edge] 自动浏览已启动');
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[aidcp-edge] 收到退出信号，关闭连接 ...');
    browse?.stop();
    client.close();
    session.close();
    // 仅当 Chrome 由本进程启动时才 kill（复用的实例不动）
    chrome.kill();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[aidcp-edge] 启动失败:', err);
  process.exitCode = 1;
});
