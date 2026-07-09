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
 *  - 对支持 browse 的平台，登录完成后创建 BrowseSession 并 start()：自动浏览 explore feed、
 *    打开笔记、提取内容上报云端、按云端决策（like / browse.next / search / session.end）动作。
 *
 * 环境变量：
 *  - AIDCP_CLOUD_URL       云端 WS 地址（默认 ws://127.0.0.1:8787）
 *  - AIDCP_EDGE_ID         边缘节点标识（不设则按节点隔离边界派生唯一稳定值：adspower→ads-<分身id> / self→self-<目录末段> / 兜底→host-<主机名>；绝不回落共享常量）
 *  - AIDCP_PLATFORM        平台装配：xiaohongshu | xhs | facebook | fb（默认 xiaohongshu）
 *  - AIDCP_BROWSER_PROVIDER 浏览器 provider：self | adspower（**默认 adspower**；self 自起真实指纹 Chrome）
 *  - AIDCP_ADS_USER_ID     adspower 模式必填：目标 AdsPower profile id（缺则诚实报错、绝不回落 self）
 *  - AIDCP_ADS_API_BASE    AdsPower 本地 API 基址（默认 http://local.adspower.net:50325）
 *  - AIDCP_ADS_API_KEY     AdsPower 安全校验 API key（作 Bearer，可选）
 *  - AIDCP_STEALTH         反检测注入 on|off（缺省随 provider：self=on / adspower=off，反检测两层均交 AdsPower：自动化痕迹由 cdp_mask 掩盖、指纹由 profile 的 fingerprint_config 生成）
 *  - AIDCP_CDP_HOST        CDP host（默认 127.0.0.1；self 模式用）
 *  - AIDCP_CDP_PORT        CDP 端口（默认 9222；self 模式用，adspower 端口由 browser/start 动态返回）
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

// 入口级全局 WebSocket 兜底：Electron 自带 Node 20 无全局 WebSocket，须在其它导入前安装。
import './websocket-polyfill.js';
import {
  applyBrowserParking,
  attachToPage,
  browserParkingConfigFromEnv,
  installBrowserParkingStdinControl,
  selectBrowserProvider,
  type BrowserLaunchOptions,
} from './cdp/index.js';
import { selectPlatformDriver } from './platform/index.js';
import { FacebookCommentExecutor, FacebookCommentHandler, FacebookJoinExecutor } from './facebook/index.js';
import { EdgeClient } from './client/edge-client.js';
import { registerPersonaStdinCommands } from './client/persona-onboarding.js';
import { deriveEdgeId } from './client/edge-id.js';
import { CloudElementSelector } from './client/cloud-selector.js';
import { LikeStepRunner } from './client/like-runner.js';
import { publishPost } from './flows/publish-post.js';
import { PublishCommandDispatcher } from './flows/publish-command-handlers.js';
import { PublishUiEventTracker, uiSnapshotToLines, writeNoteStageLine } from './flows/ui-event-lines.js';
import { ImageUploader, imageTempPrefixFor, sweepImageTempDirs } from './flows/image-uploader.js';
import { CdpFileInputSetter } from './cdp/file-input-setter.js';
import { AnchorCache } from './locating/cache.js';
import { buildPublishApprovalRequestId } from './publish/approval-gate.js';
import type { PublishResultPayload, PublishCommandResultPayload } from './comm/protocol.js';
import {
  BrowseSession,
  CdpFeedScroller,
  CdpModalController,
  CdpNotificationMonitor,
  WatcherSupervisor,
  IdentityWatcher,
  CdpLoginModalWatcher,
  evalRaw,
  extractNoteContent,
  captureBlockingOverlaySnapshot,
  CaptchaAssistHandler,
  createOverlayReportGate,
  type BlockingOverlaySnapshot,
  type BrowseSessionOptions,
  type OverlayMonitor,
} from './browse/index.js';
import type { IdentityDecision, SelfIdentityResult } from './cdp/self-identity.js';

function verifiedAccountNickname(idRes: SelfIdentityResult, decision: IdentityDecision): string | undefined {
  if (!idRes.ok || decision.kind !== 'use') return undefined;
  if (decision.accountId !== idRes.identity.accountId) return undefined;
  const nickname = idRes.identity.displayName?.trim();
  return nickname || undefined;
}

async function main(): Promise<void> {
  const cloudUrl = process.env.AIDCP_CLOUD_URL ?? 'ws://121.89.85.150:8787';
  const platformDriver = selectPlatformDriver({ env: process.env });
  console.log(
    `[aidcp-edge] 平台装配 platform=${platformDriver.platform} app=${platformDriver.app} capabilities=${platformDriver.capabilities.join(',')}`,
  );
  // 节点身份（edgeId）：缺省按节点隔离边界派生【唯一且稳定】的值，绝不回落共享常量（旧 'edge-local' 致同机/跨机
  // 两个裸 npm start 互踢的根因，见 edge-id.ts）。唯一→根除互踢与下行串号；稳定→保住云端「同节点重连顶替」。
  const edgeIdDerivation = deriveEdgeId();
  const edgeId = edgeIdDerivation.edgeId;
  if (edgeIdDerivation.warning) console.warn(`[aidcp-edge] ⚠ ${edgeIdDerivation.warning}`);
  console.log(`[aidcp-edge] 节点身份 edgeId=${edgeId} [source=${edgeIdDerivation.source}]`);
  // 配图临时目录按环境命名空间隔离：清扫/下载都只在 aidcp-img-<本edgeId>- 名下（多环境并行不串扫）。
  const imageTempPrefix = imageTempPrefixFor(edgeId);
  await sweepImageTempDirs(imageTempPrefix);
  // hello 身份（account-identity-from-login）：默认从「登录后读出的真实稳定 id」确立（见 attachToPage 之后）；
  // 环境变量 AIDCP_ACCOUNT_ID 降级为【可选覆盖】（预置/特殊场景的逃生阀）。
  const overrideAccountId = process.env.AIDCP_ACCOUNT_ID;
  let accountId: string | undefined;
  let accountNickname: string | undefined;
  const machineLabel = process.env.AIDCP_MACHINE_LABEL;
  const remoteAddr = process.env.AIDCP_REMOTE_ADDR;
  const cdpHost = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
  const cdpPort = Number(process.env.AIDCP_CDP_PORT ?? 9222);
  const pageUrl = process.env.AIDCP_PAGE_URL;

  // 浏览器启动层可插拔（change adspower-browser-provider）：默认 adspower（AdsPower 指纹浏览器托管，
  // 拿 debug_port 喂现成 attach）；AIDCP_BROWSER_PROVIDER=self 时改为自起真实指纹 Chrome。
  const provider = selectBrowserProvider({
    startUrl: process.env.AIDCP_EXPLORE_URL ?? platformDriver.defaultStartUrl,
    logImpl: (m) => console.log(m),
  });
  console.log(`[aidcp-edge] 准备浏览器（provider=${provider.kind}，CDP ${cdpHost}:${cdpPort}）...`);
  const launchOpts: BrowserLaunchOptions = { host: cdpHost, port: cdpPort };
  if (process.env.AIDCP_CHROME_PATH) launchOpts.chromePath = process.env.AIDCP_CHROME_PATH;
  if (process.env.AIDCP_CHROME_PROFILE) launchOpts.profileDir = process.env.AIDCP_CHROME_PROFILE;
  if (process.env.AIDCP_CHROME_HEADLESS === 'true') launchOpts.headless = true;
  const parkingConfig = browserParkingConfigFromEnv(process.env);
  if (process.env.AIDCP_BROWSER_PARKING_LAUNCH_POSITION) {
    const [leftRaw, topRaw] = process.env.AIDCP_BROWSER_PARKING_LAUNCH_POSITION.split(',');
    const left = Number(leftRaw);
    const top = Number(topRaw);
    if (Number.isFinite(left) && Number.isFinite(top)) launchOpts.windowPosition = { left, top };
  }
  // 登录等待上限（self 模式）：看护重起的子进程无 TTY、无从扫码，登录态应已持久化且秒级命中——
  // launch-multinode 会注入较短值（~45s），使「登录态丢失」按崩溃快速计入重起预算而非干等 5min。
  // 单机首登（裸 npm start）不设此 env，沿用 5min 默认以容纳人工扫码。
  // adspower 模式登录态由其 profile 持久化、此项不参与；身份统一由下方 readSelfIdentity 把关。
  if (process.env.AIDCP_CHROME_LOGIN_TIMEOUT_MS) {
    launchOpts.loginTimeoutMs = Number(process.env.AIDCP_CHROME_LOGIN_TIMEOUT_MS);
  }
  const { instance: chrome, endpoint } = await provider.launch(launchOpts);

  // 反检测恰一层生效：self 默认开 edge 自研 stealth；adspower 默认关、反检测整层交 AdsPower——
  // 自动化痕迹由 cdp_mask（browser/start 字段，藏 navigator.webdriver 等 CDP 特征）掩盖、
  // 指纹由 profile 的 fingerprint_config（Canvas/WebGL/UA/时区…）生成（edge 再叠一层会不自洽）。
  // AIDCP_STEALTH=on|off 可显式覆盖。
  const stealthEnv = process.env.AIDCP_STEALTH?.toLowerCase();
  const stealth = stealthEnv ? !['off', 'false', '0', 'no'].includes(stealthEnv) : provider.kind !== 'adspower';

  console.log(`[aidcp-edge] 连接浏览器 CDP ${endpoint.host}:${endpoint.port}（stealth=${stealth ? 'on' : 'off'}）...`);
  const attachOpts: Parameters<typeof attachToPage>[0] = { host: endpoint.host, port: endpoint.port, stealth };
  if (pageUrl) attachOpts.urlIncludes = pageUrl;
  else if (provider.kind === 'adspower') {
    attachOpts.urlIncludes = platformDriver.attachUrlIncludes;
    attachOpts.targetPredicate = (target) => platformDriver.isAllowedTargetUrl(target.url);
  }
  const session = await attachToPage(attachOpts);
  console.log('[aidcp-edge] 已附着到 page，CDP 就绪（反检测脚本已注入）');
  await applyBrowserParking(session.cdp, parkingConfig, (m) => console.log(m));
  installBrowserParkingStdinControl(session.cdp, parkingConfig, (m) => console.log(m));
  // Runtime/Page/Input 域启用 + 反检测注入均在 attachToPage 内（reEnableAndInject，与断线重连共用）。

  // 身份确立（account-identity-from-login 1.2）：登录态在 self 模式由 launchChrome 的登录等待保证、
  // 在 adspower 模式由其 profile 持久化；此处统一从登录态读出本节点真实稳定账号 id，作为握手身份。
  // env 覆盖优先；读不出即诚实停手、绝不回落 default（adspower 模式失败同样不回落 self）。
  {
    const idRes = await platformDriver.readIdentity(session.cdp, { logger: (m) => console.log(m) });
    const decision = platformDriver.decideIdentity(idRes, overrideAccountId);
    if (decision.kind === 'halt') {
      // 红线「绝不静默以默认账号/默认人设开跑」：诚实停手——不握手、不连云端、绝不猜或回落 default。
      console.error(`[aidcp-edge] ✗ 身份确立失败：登录态读不出稳定账号 id（${decision.reason}）。`);
      console.error(
        '[aidcp-edge]   已停手（不握手、不连云端）。请确认该节点浏览器已登录目标账号后重启；如确需指定身份，可设 AIDCP_ACCOUNT_ID 覆盖。',
      );
      try {
        session.close();
      } catch {
        /* best-effort */
      }
      process.exitCode = 1;
      return;
    }
    if (decision.kind === 'use-override-after-read-fail') {
      console.warn(`[aidcp-edge] ⚠ 登录态读不出稳定 id（${decision.reason}），改用 AIDCP_ACCOUNT_ID 覆盖值=${decision.accountId}。`);
    } else if (decision.mismatch) {
      console.warn(
        `[aidcp-edge] ⚠ AIDCP_ACCOUNT_ID 覆盖值(${decision.mismatch.override}) ≠ 登录态真实 id(${decision.mismatch.real})——以覆盖值为准，但身份与实际登录账号不一致，请确认是否预期。`,
      );
    }
    accountId = decision.accountId;
    accountNickname = verifiedAccountNickname(idRes, decision);
    const display = accountNickname ? ` (${accountNickname})` : '';
    const source = 'source' in decision ? decision.source : 'env-override';
    console.log(`[aidcp-edge] 账号身份已确立: ${accountId}${display} [source=${source}]`);
  }

  // 先声明 runner（延迟赋值），打破 client/selector/runner 的相互依赖
  let runner: LikeStepRunner | undefined;

  const client = new EdgeClient({
    url: cloudUrl,
    edgeId,
    platform: platformDriver.platform,
    app: platformDriver.app,
    capabilities: [...platformDriver.edgeCapabilities],
    ...(accountId ? { accountId } : {}),
    ...(accountNickname ? { accountNickname } : {}),
    ...(machineLabel ? { machineLabel } : {}),
    ...(remoteAddr ? { remoteAddr } : {}),
    runner: {
      run: (step) => {
        if (!runner) throw new Error('runner 尚未就绪');
        return runner.run(step);
      },
    },
  });

  // 建号自助人设 stdin 桥（change edge-persona-keyword-generation）：身份已确立、client 就绪后装上，
  // 桌面壳经 stdin 下发 persona.generate/persist → 打到云端 → stdout [persona-reply] 回桥。
  registerPersonaStdinCommands(client, (m) => console.log(m));

  const selector = new CloudElementSelector(client);
  runner = new LikeStepRunner({
    dom: session.dom,
    executor: session.executor,
    selector,
  });
  const publishCache = new AnchorCache();

  // §7 在途发布追踪：回收若撞上在途发布，先把它诚实判失败（让审批/通知侧看到失败而非半成品），
  // 绝不静默丢弃让其跨重起被重复触发 → 真账号重复发帖。值为「按各自结果形状诚实判失败」的闭包。
  const inFlightPublishes = new Map<string, (reason: string) => void>();
  // 退出码契约（看护进程 launch-multinode 据此决定是否重起）：
  //   0            = 关机（SIGINT/SIGTERM），不重起；
  //   EXIT_RECYCLE = 可恢复终态回收，请重起（sysexits EX_TEMPFAIL=75：临时失败、邀请重试）。
  const EXIT_RECYCLE = 75;
  let browse: BrowseSession | undefined;
  let overlayMonitor: OverlayMonitor | undefined;
  let watcherSupervisor: WatcherSupervisor | undefined;
  let identityWatcher: IdentityWatcher | undefined;
  let requestShutdown: ((reason: string) => void) | undefined;

  // §7 回收契约：把全部在途发布诚实判失败（须在关闭云端连接之前发，确保失败回执发得出去）。
  // 云端 WS 已断时 send 会 best-effort 失败，但本地 in-flight 必须立刻清掉，避免重连后重放旧发布。
  const failInFlightPublishesHonestly = (reason: string): void => {
    for (const [, failer] of inFlightPublishes) failer(reason);
    inFlightPublishes.clear();
  };

  client.on('cloud.disconnected', () => {
    failInFlightPublishesHonestly('cloud_ws_disconnected');
    browse?.discardQueuedCloudCommands('cloud_ws_disconnected');
  });
  client.on('cloud.reconnected', () => {
    const reconnPacing = client.getPacing();
    browse?.applyPacingSnapshot(reconnPacing?.opFloorsMs, reconnPacing?.tempo);
    browse?.recoverAfterCloudReconnect().catch((err) => {
      console.error('[aidcp-edge] 云端重连后浏览恢复失败:', err);
    });
  });
  client.on('cloud.unrecoverable', () => {
    console.warn('[aidcp-edge] 云端重连耗尽 → 诚实下线 + 回收退出（请重起）');
    if (requestShutdown) {
      requestShutdown('cloud_ws_unrecoverable');
    } else {
      process.exitCode = EXIT_RECYCLE;
    }
  });

  // 红线（edge-companion-ui 8.1 评审修正）：全部云端主动消息处理器 MUST 在 connect() 之前注册。
  // 云端在 welcome 回发后立刻推 hello 快照（ui.snapshot）——若 welcome 与快照同一批 socket 读到达，
  // 两帧在同一宏任务内派发，connect() 的续体（微任务）还没来得及跑注册代码，后注册的处理器
  // 会静默漏掉首帧。注册本身不需要活连接，先注册零成本。
  client.onPublishCommand((env) => {
    void (async () => {
      console.log(writeNoteStageLine());
      // §7 在途登记：回收若撞上这条在途发布，按 publish.result 形状诚实判失败（同 env.id 回执）。
      inFlightPublishes.set(env.id, (reason) => {
        try {
          client.send('publish.result', { ok: false, error: `[recycled] ${reason}` }, env.id);
        } catch {
          /* 连接可能已在关闭中；best-effort */
        }
      });
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
      } finally {
        inFlightPublishes.delete(env.id);
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
    tempDirPrefix: imageTempPrefix,
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
  // 陪伴界面事件（edge-companion-ui 6.4）：发布终态的本地事实经 [ui-event] 行直达桌面壳。
  const publishUiEvents = new PublishUiEventTracker();
  client.onPublishAtomCommand((env) => {
    void (async () => {
      console.log(writeNoteStageLine());
      publishUiEvents.observe(env.payload);
      // §7 在途登记：按 publish.command.result 形状诚实判失败（带 recordId/seq/kind，同 env.id 回执）。
      inFlightPublishes.set(env.id, (reason) => {
        try {
          client.send(
            'publish.command.result',
            {
              recordId: env.payload.recordId,
              seq: env.payload.seq,
              kind: env.payload.kind,
              ok: false,
              error: `[recycled] ${reason}`,
            },
            env.id,
          );
        } catch {
          /* best-effort */
        }
        const recycledLine = publishUiEvents.onRecycled(env.payload);
        if (recycledLine) console.log(recycledLine);
      });
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
      } finally {
        inFlightPublishes.delete(env.id);
      }
      const uiLine = publishUiEvents.onResult(env.payload, result);
      if (uiLine) console.log(uiLine);
      try {
        client.send('publish.command.result', result, env.id);
      } catch (sendErr) {
        console.error('[aidcp-edge] publish.command.result 回传失败:', sendErr);
      }
    })();
  });

  // 陪伴界面数据快照（edge-companion-ui 8.1）：云端 ui.snapshot（昵称/最近发布/审批状态）
  // 转成 [ui-event] 行打到 stdout，由 Electron 壳解析驱动标题带与发布卡。
  client.onUiSnapshot((env) => {
    for (const uiLine of uiSnapshotToLines(env.payload)) console.log(uiLine);
  });

  const captchaAssist = new CaptchaAssistHandler({
    cdp: session.cdp,
    client,
    edgeId,
    getAccountId: () => accountId,
    getOverlayMonitor: () => overlayMonitor,
    logger: (m) => console.log(m),
  });
  client.onCaptchaAssistCommand((env) => {
    if (env.type !== 'captcha.assist.capture' && env.type !== 'captcha.assist.click') return;
    captchaAssist.handle(env.type, env.payload).catch((err) => {
      console.error(`[aidcp-edge] 验证码协助指令 ${env.type} 处理失败:`, err);
    });
  });

  // —— Facebook 定向评论处理器（change facebook-scheduled-comment，静默丢弃坑修复）——
  // comment-only 平台（声明 'comment' 但不声明 'browse'，如 Facebook）：注册独立评论处理器，
  // 把云端 search.execute/note.open/interaction.comment 翻成 FacebookCommentExecutor 调用并诚实回执。
  // 绝不锁在 if(autoBrowse) 内——否则 Facebook（无 browse 能力）永不注册 browseHandler，
  // 这三条已在白名单的命令会被 `browseHandler?.()` 可选链静默吞、零回执 → 云端干等超时挂死。
  // 与小红书（browse+comment）的 BrowseSession 单槽 browseHandler 互斥：仅 comment-only 平台走这里。
  const facebookCommandDriver =
    (platformDriver.capabilities.includes('comment') || platformDriver.capabilities.includes('join')) &&
    !platformDriver.capabilities.includes('browse');
  if (facebookCommandDriver) {
    // 该平台的旁路弹窗监测体后台常开：执行器每步操作前 fresh 复检登录/验证码（fail-closed）。
    overlayMonitor = platformDriver.createOverlayMonitor(session.cdp);
    overlayMonitor.start();
    const fbCommentExecutor = new FacebookCommentExecutor({
      cdp: session.cdp,
      getAccountId: () => accountId,
      overlayMonitor,
      logger: (m) => console.log(m),
    });
    const fbJoinExecutor = platformDriver.capabilities.includes('join')
      ? new FacebookJoinExecutor({
          cdp: session.cdp,
          overlayMonitor,
          logger: (m) => console.log(m),
        })
      : undefined;
    const fbCommentHandler = new FacebookCommentHandler({
      executor: fbCommentExecutor,
      ...(fbJoinExecutor ? { joinExecutor: fbJoinExecutor } : {}),
      client,
      logger: (m) => console.log(m),
    });
    client.onBrowseCommand((env) => {
      void fbCommentHandler.handle(env);
    });
    console.log(`[aidcp-edge] Facebook 定向评论处理器已注册（platform=${platformDriver.platform}）`);
  }

  // 处理器全部就位后才握手（见上方红线注释：hello 快照紧随 welcome，注册晚一步就漏帧）。
  await client.connect();
  console.log(`[aidcp-edge] 已连接云端 ${cloudUrl}，等待命令 ...`);

  // —— 自动浏览会话 ——
  // 身份失效 → 退回无身份态、重新确立、按新 id 重连（account-identity-from-login 1.3/1.4）。
  // 复用同一 session.cdp（浏览器不重启、端口/目录不重分 = 节点初始化不动），只重跑「身份确立」。
  // 重新确立前先回到能读出身份的消费端首页（触发失效时可能停在创作发布页/弹层态、无「我」锚点）。
  const reestablishHomeUrl = process.env.AIDCP_EXPLORE_URL ?? platformDriver.defaultStartUrl;
  let reestablishing = false;
  const reestablishIdentity = async (): Promise<void> => {
    if (reestablishing) return;
    reestablishing = true;
    try {
      const r = identityWatcher?.lastReason;
      const reasonStr = r ? (r.kind === 'changed' ? `换号→${r.newId}` : '登出/过期') : '未知';
      console.warn(
        `[aidcp-edge] 身份失效（${reasonStr}）→ 退回无身份态：停账号作用域操作 + 断开云端，重新确立身份（浏览器不重启、端口/目录不重分）...`,
      );
      watcherSupervisor?.stopAll();
      browse?.stop();
      // 断连前先把在途发布诚实判失败（须在关 WS 之前，失败回执才发得出去），云端不被无限期挂起等结果。
      failInFlightPublishesHonestly(`identity_flip:${reasonStr}`);
      client.close();
      // 先回到消费端首页再判身份：触发失效时可能停在创作发布页/弹层态（无「我」锚点），直接原地读会无谓停摆。
      // readSelfIdentity 的 hydrate 有界重试会等锚点渲染出来；导航失败则退回原地读（与旧行为同、不更坏）。
      try {
        await session.cdp.send('Page.navigate', { url: reestablishHomeUrl });
      } catch {
        /* best-effort */
      }
      const idRes = await platformDriver.readIdentity(session.cdp, { logger: (m) => console.log(m) });
      const decision = platformDriver.decideIdentity(idRes, overrideAccountId);
      if (decision.kind === 'halt') {
        console.error(
          `[aidcp-edge] ✗ 重新确立身份失败（${decision.reason}）：停在无身份态、不重连云端、绝不回落 default。请在该节点重新登录目标账号后重启。`,
        );
        return; // 留在无身份态，不静默以默认账号开跑（红线）
      }
      accountId = decision.accountId;
      accountNickname = verifiedAccountNickname(idRes, decision);
      client.setAccountIdentity(accountId, accountNickname);
      await client.connect();
      const display = accountNickname ? ` (${accountNickname})` : '';
      console.log(
        `[aidcp-edge] 身份重新确立: ${accountId}${display}，已按新 id 重连云端（云端按新账号拆旧会话 + 重过就绪闸）`,
      );
      identityWatcher?.rebaseline(accountId);
      // 重连重注入节奏快照（pacing-floor-config-min-interval 设计 §4.3 最严重缺口）：BrowseSession 只构造一次，
      // identity 翻转复用同一对象；须在 connect()（新 welcome 已到）之后、start() 之前把新 floors/tempo 灌进去，
      // 否则连接级快照在唯一原地重连路径上退化成进程级、风控升级到不了边缘节奏层。
      const reconnPacing = client.getPacing();
      browse?.applyPacingSnapshot(reconnPacing?.opFloorsMs, reconnPacing?.tempo);
      browse?.start().catch((err) => console.error('[aidcp-edge] 浏览会话异常:', err));
      watcherSupervisor?.startAll();
    } catch (err) {
      console.error('[aidcp-edge] 重新确立身份过程出错:', err);
    } finally {
      reestablishing = false;
    }
  };

  const wantsAutoBrowse = process.env.AIDCP_AUTO_BROWSE !== 'false';
  const supportsBrowse = platformDriver.capabilities.includes('browse');
  const autoBrowse = wantsAutoBrowse && supportsBrowse;
  if (wantsAutoBrowse && !supportsBrowse) {
    console.warn(`[aidcp-edge] platform=${platformDriver.platform} does not support browse; BrowseSession will not start.`);
  }
  if (autoBrowse) {
    const browseOpts: BrowseSessionOptions = {};
    browseOpts.exploreUrl = process.env.AIDCP_EXPLORE_URL ?? platformDriver.defaultStartUrl;
    // 节奏快照（pacing-floor-config-min-interval 设计 §4.3）：welcome 下发的每类操作 floor 区间 + tempo
    // 透传进 BrowseSession；detail_dwell 区间复活死参数 dwellFloorMs（详情页停留兜底 floor 源）。
    // 缺省（旧云端未下发）→ 全用内置默认、非零降级、无回归。
    const initialPacing = client.getPacing();
    if (initialPacing) {
      browseOpts.opFloorsMs = initialPacing.opFloorsMs;
      browseOpts.tempo = initialPacing.tempo;
      const dd = initialPacing.opFloorsMs?.detail_dwell;
      if (dd && typeof dd.minMs === 'number' && typeof dd.maxMs === 'number') {
        browseOpts.dwellFloorMs = { min: dd.minMs, max: dd.maxMs };
      }
    }
    // 旁路弹窗监测体：后台持续判类（登录/验证码/运营/未知），闸门读其缓存状态停手。
    overlayMonitor = platformDriver.createOverlayMonitor(session.cdp);
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
    // 仅 captcha/unknown 上报（login 只本地暂停、沿用现状不打扰云端）。判定逻辑抽在 overlay-report-gate：
    // 低置信 unknown → 延后一轮确认仍在才报（滤掉离页返回途中 token 失效详情 300031 墙这类瞬时坏页误报）；
    // captcha 指纹 → 即时 fail-CLOSED（绝不弱化真验证码）；detected/cleared 严格配对、杜绝孤儿 cleared。
    const overlayConfirmMs = Number(process.env.AIDCP_OVERLAY_CONFIRM_MS ?? 2000);
    const isCloudBlockingOverlay = (kind: string): kind is 'captcha' | 'unknown' =>
      kind === 'captcha' || kind === 'unknown';
    let overlaySnapshotPromise: Promise<BlockingOverlaySnapshot | undefined> | undefined;

    const resetOverlaySnapshot = (): void => {
      overlaySnapshotPromise = undefined;
    };
    const primeOverlaySnapshot = (kind: 'captcha' | 'unknown'): void => {
      if (overlaySnapshotPromise) return;
      overlaySnapshotPromise = captureBlockingOverlaySnapshot(session.cdp, kind).catch((err) => {
        console.warn('[aidcp-edge] 阻断遮罩现场快照采集失败:', err instanceof Error ? err.message : String(err));
        return undefined;
      });
    };
    const readPrimedOverlaySnapshot = async (kind: 'captcha' | 'unknown'): Promise<BlockingOverlaySnapshot | undefined> => {
      primeOverlaySnapshot(kind);
      return overlaySnapshotPromise;
    };
    const sendOverlayDetected = (kind: 'captcha' | 'unknown'): void => {
      void (async () => {
        const overlay = await readPrimedOverlaySnapshot(kind);
        let url = '';
        if (overlay?.firstDetectedUrl) {
          url = overlay.firstDetectedUrl;
        }
        try {
          if (!url) url = await evalRaw<string>(session.cdp, 'location.href');
        } catch {
          /* best-effort，URL 取不到不影响上报 */
        }
        try {
          client.send('risk.captcha_detected', {
            edgeId,
            kind,
            url,
            ...(overlay ? { overlay } : {}),
            ...(accountId ? { accountId } : {}),
          });
        } catch (err) {
          console.error('[aidcp-edge] risk.captcha_detected 上报失败:', err);
        }
        console.warn('[aidcp-edge] 阻断遮罩现场快照:', {
          kind,
          firstDetectedUrl: overlay?.firstDetectedUrl ?? url,
          text: overlay?.text,
          dom: overlay?.dom,
        });
        console.warn(
          `[aidcp-edge] ⚠ 检测到${kind === 'captcha' ? '验证码' : '未知阻断'}弹窗，已本地暂停并上报云端，等待人工处理`,
        );
      })();
    };
    const overlayReportGate = createOverlayReportGate({
      sendDetected: sendOverlayDetected,
      sendCleared: () => {
        try {
          client.send('risk.captcha_cleared', { edgeId, ...(accountId ? { accountId } : {}) });
        } catch (err) {
          console.error('[aidcp-edge] risk.captcha_cleared 上报失败:', err);
        }
        resetOverlaySnapshot();
        console.log('[aidcp-edge] 阻断弹窗已清除，恢复浏览');
      },
      isStillUnknown: () => overlayMonitor?.state === 'unknown',
      schedule: (fn, ms) => {
        setTimeout(fn, ms);
      },
      confirmMs: overlayConfirmMs,
    });
    watcherSupervisor = new WatcherSupervisor();
    // ① 弹窗监测：类别翻转交上报闸决策（unknown 延后确认、captcha 即时、cleared 配对）。login 只本地暂停、不打扰云端。
    watcherSupervisor.register(overlayMonitor, (from, to) => {
      if (isCloudBlockingOverlay(to) && !isCloudBlockingOverlay(from)) primeOverlaySnapshot(to);
      if (!isCloudBlockingOverlay(to)) resetOverlaySnapshot();
      overlayReportGate.onTransition(from, to);
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
    // ③ 身份持续校验（account-identity-from-login 1.4）：周期就地重读自己的稳定 id，
    //    连续判失效（登出/过期/换号）→ 退回无身份态、重新确立、按新 id 重连。
    // 正向登出探针：消费页读不出本人锚点时，用登录浮层是否可见区分「真登出」与「无侧栏页/弹层态」。
    // 复用已校准的登录弹窗检测（排除笔记详情容器、不锁混淆 class）。
    const loginWall = new CdpLoginModalWatcher(session.cdp);
    identityWatcher = new IdentityWatcher(session.cdp, accountId!, {
      intervalMs: Number(process.env.AIDCP_IDENTITY_CHECK_MS ?? 30_000),
      threshold: Number(process.env.AIDCP_IDENTITY_FAIL_THRESHOLD ?? 2),
      logger: (m) => console.log(m),
      confirmLoggedOut: () => loginWall.isOpen(),
    });
    watcherSupervisor.register(identityWatcher, (from, to) => {
      if (from === 'healthy' && to === 'invalid') void reestablishIdentity();
    });
    // CDP 重连联动：不可恢复（重连耗尽、终态）→ 停掉全部后台监测体。否则它们继续对已死的 client 空轮询、
    // 每 pollMs 刷一行「探测失败(保持上一状态)」僵尸日志直到进程退出（旧码只有 SIGINT 才 stopAll）。
    // 重连成功 → 重启（start() 幂等：未停则 no-op；曾停则干净恢复，避免恢复的 session 后台盲跑/停摆）。
    const supervisor = watcherSupervisor; // 闭包内捕获已窄化的非空引用
    session.cdp.on('cdp.unrecoverable', () => {
      console.warn('[aidcp-edge] CDP 重连不可恢复，停止后台监测体（避免僵尸轮询）');
      supervisor.stopAll();
    });
    session.cdp.on('cdp.reconnected', () => {
      console.log('[aidcp-edge] CDP 已重连，重启后台监测体');
      supervisor.startAll();
    });
    supervisor.startAll();
    console.log('[aidcp-edge] 自动浏览已启动（含弹窗 + 通知未读旁路监测）');
  }

  // —— 退出 / 回收统一路径（节点终态诚实下线 + 看护可重起；真关机干净退出）——
  let recycleRequested = false;
  let shuttingDown = false;
  const shutdown = async (opts: { exitCode: number; recycle: boolean; reason: string }): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // 已请求回收则即便随后信号撞入也以回收码退出（真终态不被掩成 clean exit，MAJOR⑤）。
    const exitCode = recycleRequested ? EXIT_RECYCLE : opts.exitCode;
    console.log(`\n[aidcp-edge] 退出流程启动（reason=${opts.reason} recycle=${opts.recycle} exitCode=${exitCode}）...`);
    // ① 回收：先诚实判失败在途发布（关 WS 之前），绝不留半截/跨重起重复发帖。
    if (opts.recycle) failInFlightPublishesHonestly(opts.reason);
    watcherSupervisor?.stopAll();
    // 终态关闭：用 close()（非 stop()）置 closing，使关机异步窗口内迟到的云端命令绝不唤醒重启浏览循环
    // （change restore-auto-resume A②）。identity 重连的 stop-then-restart 仍用 stop()（非终态）。
    browse?.close();
    // ② 诚实下线：等边-云连接真正关闭再继续（BLOCKER①），使云端立即停止把本节点当路由目标。
    try {
      await client.closeAndWait(1500);
    } catch {
      /* best-effort */
    }
    session.close();
    // ③ 仅当本进程独占（非复用）该 Chrome 时才回收：杀进程并确认端口/登录锁释放（BLOCKER②，超时升级 SIGKILL）。
    //    复用模式只诚实退出、绝不回收外部浏览器（killAndConfirmDead 对复用实例为 no-op）。
    if (chrome.reused) {
      console.log('[aidcp-edge] 复用模式：只诚实退出，不回收本进程不拥有的外部 Chrome');
    } else {
      try {
        const freed = await chrome.killAndConfirmDead();
        if (!freed) {
          console.warn(
            '[aidcp-edge] ⚠ 升级 SIGKILL 后调试端口仍未确认释放，继续退出（看护重起时 clearStaleSingletonLock 会再判活拒启）',
          );
        }
      } catch {
        /* best-effort */
      }
    }
    process.exit(exitCode);
  };
  requestShutdown = (reason: string): void => {
    if (recycleRequested) return;
    recycleRequested = true;
    void shutdown({ exitCode: EXIT_RECYCLE, recycle: true, reason });
  };

  // CDP 终态（重连不可恢复）→ 诚实下线 + 回收退出（请重起）。autoBrowse 与否都接，节点失去浏览器即回收。
  session.cdp.on('cdp.unrecoverable', () => {
    console.warn('[aidcp-edge] CDP 重连不可恢复（终态）→ 诚实下线 + 回收退出（请重起）');
    requestShutdown?.('cdp_unrecoverable');
  });

  process.on('SIGINT', () => void shutdown({ exitCode: 0, recycle: false, reason: 'SIGINT' }));
  process.on('SIGTERM', () => void shutdown({ exitCode: 0, recycle: false, reason: 'SIGTERM' }));
}

main().catch((err) => {
  console.error('[aidcp-edge] 启动失败:', err);
  // 红线「快速失败 + 可见」：致命启动失败（含 client.connect() 连云失败）立即非零退出，
  // 让桌面外壳的 edgeProcess.on('exit') 立刻看见并弹窗 + 通知；绝不退避重试掩盖未连通。
  process.exit(1);
});
