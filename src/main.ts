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
import { publishPost } from './flows/publish-post.js';
import { PublishCommandDispatcher } from './flows/publish-command-handlers.js';
import { ImageUploader } from './flows/image-uploader.js';
import { CdpFileInputSetter } from './cdp/file-input-setter.js';
import { AnchorCache } from './locating/cache.js';
import { buildPublishApprovalRequestId } from './publish/approval-gate.js';
import type { PublishResultPayload, PublishCommandResultPayload } from './comm/protocol.js';
import {
  BrowseSession,
  CdpFeedScroller,
  CdpModalController,
  CdpOverlayMonitor,
  CdpNotificationMonitor,
  WatcherSupervisor,
  evalRaw,
  extractNoteContent,
  type OverlayKind,
  type BrowseSessionOptions,
} from './browse/index.js';

/** 启动时清扫上一轮崩溃残留的配图临时目录（finally-unlink 在 SIGKILL/OOM 时跑不到）。仅命中 aidcp-img-* 前缀。 */
async function sweepImageTempDirs(): Promise<void> {
  try {
    const { readdir, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const base = tmpdir();
    const entries = await readdir(base).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((name) => name.startsWith('aidcp-img-'))
        .map((name) => rm(join(base, name), { recursive: true, force: true }).catch(() => undefined)),
    );
  } catch {
    // best-effort，清扫失败不阻断启动。
  }
}

async function main(): Promise<void> {
  await sweepImageTempDirs();
  const cloudUrl = process.env.AIDCP_CLOUD_URL ?? 'ws://121.89.85.150:8787';
  const edgeId = process.env.AIDCP_EDGE_ID ?? 'edge-local';
  // hello 身份（用于云端风控归属与验证码定位；均可选，缺省云端安全降级）。
  const accountId = process.env.AIDCP_ACCOUNT_ID;
  const machineLabel = process.env.AIDCP_MACHINE_LABEL;
  const remoteAddr = process.env.AIDCP_REMOTE_ADDR;
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
    ...(accountId ? { accountId } : {}),
    ...(machineLabel ? { machineLabel } : {}),
    ...(remoteAddr ? { remoteAddr } : {}),
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
  const publishCache = new AnchorCache();

  await client.connect();
  console.log(`[aidcp-edge] 已连接云端 ${cloudUrl}，等待命令 ...`);

  client.onPublishCommand((env) => {
    void (async () => {
      let result: PublishResultPayload;
      try {
        const requestId = buildPublishApprovalRequestId();
        client.send('publish.approval_request', {
          requestId,
          title: env.payload.title,
          content: env.payload.content,
          tags: env.payload.tags,
          edgeId,
        });
        result = await publishPost(
          {
            dom: session.dom,
            executor: session.executor,
            selector,
            cache: publishCache,
          },
          {},
          env.payload,
          // A 阶段4：人审默认必过（AC-PUB）——缺省/任何非 'false' 值都挂闸；仅显式 AIDCP_REAL_PUBLISH=false 才跳过（本地开发）。
          process.env.AIDCP_REAL_PUBLISH !== 'false'
            ? {
                requestId,
                pollIntervalMs: Number(process.env.AIDCP_PUBLISH_APPROVAL_POLL_MS ?? 2_000),
                timeoutMs: Number(process.env.AIDCP_PUBLISH_APPROVAL_TIMEOUT_MS ?? 300_000),
                consumeSignal: process.env.AIDCP_PUBLISH_APPROVAL_CONSUME !== 'false',
              }
            : undefined,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = { ok: false, error: `[unknown] ${message}` };
      }
      try {
        client.send('publish.result', result, env.id);
      } catch (sendErr) {
        console.error('[aidcp-edge] publish.result 回传失败:', sendErr);
      }
    })();
  });

  // A 阶段1 指令驱动发布：云端逐条下发 publish.command，边缘逐条执行 + 后置校验 + 如实回报。
  // 与上面 publish.request 旧整页路径并行（地基阶段不删旧路）。
  // 配图收口：CDP 文件输入桥 + 上传器（复用 session.cdp 单例，绝不重建）。
  // task-0 实机校准（小红书创作平台发布页，图文模式）注入真实选择器：
  // - 文件输入：图文模式下页面唯一 input[type=file] 是 input.upload-input（accept jpg/png/webp）。
  // - 成功态：上传后预览区出现带 src 的缩略图（.img-preview-area img）；input.files 被 XHS 清零，绝不以 files.length 判定。
  const imageUploader = new ImageUploader({
    fileInputSetter: new CdpFileInputSetter(session.cdp, {
      inputSelector: "document.querySelector('input.upload-input[type=file]') || document.querySelector('input[type=file]')",
    }),
    dom: session.dom,
    hasThumbnail: (root) => {
      try {
        return Array.from(root.querySelectorAll('.img-preview-area img, img#creator-preview-image-0')).some(
          (img) => (img.getAttribute('src') || '').length > 0,
        );
      } catch {
        return false;
      }
    },
  });
  const publishDispatcher = new PublishCommandDispatcher(
    {
      dom: session.dom,
      executor: session.executor,
      selector,
      cache: publishCache,
    },
    {},
    Date.now,
    imageUploader,
    // 注入原始 CDP：navigate_entry 直达发布页 + select_mode 直驱点「上传图文」（发布页特殊 UI，通用选择器不可靠）。
    session.cdp,
  );
  client.onPublishAtomCommand((env) => {
    void (async () => {
      let result: PublishCommandResultPayload;
      try {
        result = await publishDispatcher.dispatch(env.payload);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = {
          recordId: env.payload.recordId,
          seq: env.payload.seq,
          kind: env.payload.kind,
          ok: false,
          error: `dispatch_error: ${message}`,
        };
      }
      try {
        client.send('publish.command.result', result, env.id);
      } catch (sendErr) {
        console.error('[aidcp-edge] publish.command.result 回传失败:', sendErr);
      }
    })();
  });

  // —— 自动浏览会话 ——
  let browse: BrowseSession | undefined;
  let overlayMonitor: CdpOverlayMonitor | undefined;
  let watcherSupervisor: WatcherSupervisor | undefined;
  const autoBrowse = process.env.AIDCP_AUTO_BROWSE !== 'false';
  if (autoBrowse) {
    const browseOpts: BrowseSessionOptions = {};
    if (process.env.AIDCP_EXPLORE_URL) browseOpts.exploreUrl = process.env.AIDCP_EXPLORE_URL;
    // 旁路弹窗监测体：后台持续判类（登录/验证码/运营/未知），闸门读其缓存状态停手。
    overlayMonitor = new CdpOverlayMonitor(session.cdp);
    browse = new BrowseSession(
      {
        dom: session.dom,
        cdp: session.cdp,
        client,
        scroller: new CdpFeedScroller(session.cdp),
        noteExtractor: extractNoteContent,
        modalCtrl: new CdpModalController(session.cdp),
        overlayMonitor,
        stepRunner: runner,
      },
      browseOpts,
    );
    // 云端异步推送的浏览控制命令统一转发到 BrowseSession 执行
    client.onBrowseCommand((env) => {
      if (!browse) {
        console.log(`[aidcp-edge] 收到云端命令 ${env.type} 但浏览会话未创建，忽略`);
        return;
      }
      browse.onCloudCommand(env).catch((err) => {
        console.error(`[aidcp-edge] 执行云端命令 ${env.type} 失败:`, err);
      });
    });
    // 不 await：浏览循环长跑，与命令收发并行
    browse.start().catch((err) => {
      console.error('[aidcp-edge] 浏览会话异常:', err);
    });

    // 启动旁路监测：类别翻转进 captcha/unknown 时上报云端（人工升级）；离开时上报已清除。
    // 仅 captcha/unknown 上报（login 只本地暂停、沿用现状不打扰云端）。
    const isBlockingCloud = (k: OverlayKind): boolean => k === 'captcha' || k === 'unknown';
    watcherSupervisor = new WatcherSupervisor();
    // ① 弹窗监测：翻转进 captcha/unknown 上报云端（人工升级）；离开上报已清除。login 只本地暂停、不打扰云端。
    watcherSupervisor.register(overlayMonitor, (from, to) => {
      if (isBlockingCloud(to) && !isBlockingCloud(from)) {
        void (async () => {
          let url = '';
          try {
            url = await evalRaw<string>(session.cdp, 'location.href');
          } catch {
            /* best-effort，URL 取不到不影响上报 */
          }
          try {
            client.send('risk.captcha_detected', { edgeId, kind: to as 'captcha' | 'unknown', url, ...(accountId ? { accountId } : {}) });
          } catch (err) {
            console.error('[aidcp-edge] risk.captcha_detected 上报失败:', err);
          }
          console.warn(
            `[aidcp-edge] ⚠ 检测到${to === 'captcha' ? '验证码' : '未知阻断'}弹窗，已本地暂停并上报云端，等待人工处理`,
          );
        })();
      } else if (!isBlockingCloud(to) && isBlockingCloud(from)) {
        try {
          client.send('risk.captcha_cleared', { edgeId, ...(accountId ? { accountId } : {}) });
        } catch (err) {
          console.error('[aidcp-edge] risk.captcha_cleared 上报失败:', err);
        }
        console.log('[aidcp-edge] 阻断弹窗已清除，恢复浏览');
      }
    });
    // ② 通知未读监测：无→有 上报 notification.detected（云端协调器据此巡视「评论和@」）。
    const notificationMonitor = new CdpNotificationMonitor(session.cdp);
    watcherSupervisor.register(notificationMonitor, (from, to) => {
      if (to === true && from === false) {
        const epoch = notificationMonitor.nextEpoch();
        const unreadCount = notificationMonitor.lastCount;
        try {
          client.send('notification.detected', { edgeId, epoch, unreadCount, ...(accountId ? { accountId } : {}) });
          console.log(`[aidcp-edge] 检测到「消息」未读(epoch=${epoch}, count=${unreadCount})，已上报云端`);
        } catch (err) {
          console.error('[aidcp-edge] notification.detected 上报失败:', err);
        }
      }
    });
    watcherSupervisor.startAll();
    console.log('[aidcp-edge] 自动浏览已启动（含弹窗 + 通知未读旁路监测）');
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[aidcp-edge] 收到退出信号，关闭连接 ...');
    watcherSupervisor?.stopAll();
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
