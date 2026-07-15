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
  reattachSession,
  browserParkingConfigFromEnv,
  installBrowserParkingStdinControl,
  selectBrowserProvider,
  waitForLoginIdentity,
  resolveStartupIdentity,
  type BrowserLaunchOptions,
  type ReadSelfIdentityOptions,
} from './cdp/index.js';
import { selectPlatformDriver } from './platform/index.js';
import { runWechatChannelsRuntime } from './wechat-channels/runtime.js';
import {
  FacebookBrowseSession,
  FacebookCommentExecutor,
  FacebookCommentHandler,
  FacebookJoinExecutor,
  FacebookPublishExecutor,
  parseFacebookBrowseMode,
  readFacebookIdentityPageContext,
  usesFacebookBrowseSession,
} from './facebook/index.js';
import { EdgeClient } from './client/edge-client.js';
import { registerPersonaStdinCommands } from './client/persona-onboarding.js';
import { registerPublishApprovalStdinCommands } from './client/publish-approval-onboarding.js';
import {
  CoreLifecycleController,
  parseCoreLifecycleCommand,
  type CoreLifecycleCommand,
} from './client/core-lifecycle.js';
import { deriveEdgeId } from './client/edge-id.js';
import { CloudElementSelector } from './client/cloud-selector.js';
import { LikeStepRunner } from './client/like-runner.js';
import { PublishCommandDispatcher } from './flows/publish-command-handlers.js';
import { EdgeTaskCoordinator } from './execution/edge-task-coordinator.js';
import { CommitWindowGuard, combineCommitWindows } from './execution/commit-window.js';
import { abortForTakeover, TaskTakeoverError, type TakeoverCtx } from './execution/takeover.js';
import { PublishUiEventTracker, uiSnapshotToLines, writeNoteStageLine } from './flows/ui-event-lines.js';
import { ImageUploader, imageTempPrefixFor, sweepImageTempDirs } from './flows/image-uploader.js';
import { CdpFileInputSetter } from './cdp/file-input-setter.js';
import { AnchorCache } from './locating/cache.js';
import type { EngineOptions } from './locating/engine.js';
import type {
  PublishCommandResultPayload,
  EdgeTaskAcquirePayload,
  EdgeTaskReleasePayload,
} from './comm/protocol.js';
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
  type EdgeBrowseSession,
} from './browse/index.js';
import type { IdentityDecision, SelfIdentityResult } from './cdp/self-identity.js';

/**
 * 发布路径的定位引擎参数（change lease-strict-preemption 4.3）。
 *
 * **值 = 今天的默认值，行为逐字节不变**。意义在于把这条路径的等待上界从「两处默认值意外相乘」
 * （引擎默认最多 3 轮 × 云端选元素默认 200s 上限）变成**发布路径自己写下的一个数**，给后续的
 * 边-云预算对齐留一个单点。
 *
 * selectTimeoutMs MUST > 云端单次模型调用天花板 180s：压小了会把一次尚在进行的合法 thinking 选择
 * 误判成 llm_error，而引擎见 llm_error 立刻升级上报、不再重试 ⇒ 一条本可成功的发布指令被判失败，
 * 而发布失败在云端是不可逆终态。
 *
 * 注：真实等待上界并非 3×200s——云端挂起时选择器转 llm_error、引擎立刻停手不进第 2 轮，所以
 * 「云端不回话」这一档的上界是 1×200s；三轮相乘只在「每轮都在 200s 内成功回一个没匹配上」时才凑得齐。
 */
const PUBLISH_ENGINE_OPTIONS: EngineOptions = { maxAttempts: 3, selectTimeoutMs: 200_000 };

function verifiedAccountNickname(idRes: SelfIdentityResult, decision: IdentityDecision): string | undefined {
  if (!idRes.ok || decision.kind !== 'use') return undefined;
  if (decision.accountId !== idRes.identity.accountId) return undefined;
  const nickname = idRes.identity.displayName?.trim();
  return nickname || undefined;
}

async function main(): Promise<void> {
  // Electron 子进程 IPC 可能在浏览器/身份初始化完成前抵达；先窄解析并排队，待生命周期资源
  // 全部就绪后按原顺序交付。绝不把未知 IPC 当生命周期命令。
  const pendingLifecycleCommands: CoreLifecycleCommand[] = [];
  let dispatchLifecycleCommand: ((command: CoreLifecycleCommand) => void) | undefined;
  /**
   * 外壳说「这次没轮到你」（槽位/内存暂时不够，你排在队列里，但你的调用方等不到了）。
   *
   * **不是生命周期命令**（不进 parseCoreLifecycleCommand，不动状态机）：浏览器该起还是会起、
   * 这个环境仍在等槽位队列里。它只做一件事——**立刻放行所有卡在浏览器闸上的等待者去诚实作答**，
   * 而不是让它们对着空气干等满 180s 的唤醒死线。外壳槽位拒绝时一言不发，正是旧版把调用方吊死的根因。
   */
  let onWakeDenied: ((detail: string) => void) | undefined;
  const parseWakeDenied = (message: unknown): string | undefined => {
    if (!message || typeof message !== 'object') return undefined;
    const m = message as { type?: unknown; detail?: unknown };
    if (m.type !== 'lifecycle.wake_denied') return undefined;
    return typeof m.detail === 'string' && m.detail ? m.detail : 'wake_denied';
  };
  process.on('message', (message: unknown) => {
    const denied = parseWakeDenied(message);
    if (denied !== undefined) {
      onWakeDenied?.(denied);
      return;
    }
    const command = parseCoreLifecycleCommand(message);
    if (!command) return;
    if (dispatchLifecycleCommand) dispatchLifecycleCommand(command);
    else pendingLifecycleCommands.push(command);
  });

  const cloudUrl = process.env.AIDCP_CLOUD_URL ?? 'ws://121.89.85.150:8787';
  const platformDriver = selectPlatformDriver({ env: process.env });
  console.log(
    `[aidcp-edge] 平台装配 platform=${platformDriver.platform} app=${platformDriver.app} capabilities=${platformDriver.capabilities.join(',')}`,
  );
  if (platformDriver.runtimeKind === 'interaction') {
    await runWechatChannelsRuntime(platformDriver);
    return;
  }
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
  // 启动期登录等待门预算（change adspower-first-login-wait-gate）：adspower 首登有界等待上限（ms）。
  // 默认 5min（人工扫码量级）；设 0 / 非法 / 负 = 关等待门（即刻停手，但仍经真退出端点，不复活僵尸）。
  // self 模式有壳侧登录门、不走此门；看护 / headless / 无人值守场景应显式注入短值或 0。
  const loginWaitMs = (() => {
    const raw = process.env.AIDCP_ADSPOWER_LOGIN_WAIT_MS;
    if (raw === undefined) return 300_000;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();

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
  // let（非 const）：冷待机唤醒会**重开浏览器**，新一代的 ChromeInstance 与调试端口必须整体换掉——
  // AdsPower 每次启动的 debug_port 都不同，留着旧的会让后续所有生命周期闭包对着一个死端口操作。
  let { instance: chrome, endpoint } = await provider.launch(launchOpts);

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
  // 停放校验失败会抛（bounds 与兜底位都过不了可见性探针）；绝不能因此跳过下面的 stdin 控制通道安装，
  // 否则 control-ready 永不发出、「显示浏览器 / 重置位置」被永久禁用（静默假死）。故此处吞异常、只记日志。
  try {
    await applyBrowserParking(session.cdp, parkingConfig, (m) => console.log(m));
  } catch (e) {
    console.log(`[browser-parking] apply failed at startup: ${(e as Error).message}`);
  }
  installBrowserParkingStdinControl(session.cdp, parkingConfig, (m) => console.log(m));
  // Runtime/Page/Input 域启用 + 反检测注入均在 attachToPage 内（reEnableAndInject，与断线重连共用）。

  // 收口真退出端点（change adspower-first-login-wait-gate）：本进程带 IPC 通道 + stdin 控制读取器两个常驻句柄，
  // 仅置 process.exitCode 后 return 会钉死事件循环、挂成存活僵尸（看护的 child-exit 永不触发→有界重起不 engage；
  // 外壳「启动」因僵尸 child 仍在而空操作）。process.exit 硬终止、无视常驻句柄（与 main.ts 尾部 catch、lifecycle exit 同款）。
  const terminateNow = (code: number): never => {
    try {
      session.close();
    } catch {
      /* best-effort */
    }
    process.exit(code);
  };

  // 身份确立（account-identity-from-login 1.2 + adspower-first-login-wait-gate）：从登录态读出本节点真实稳定账号 id 作握手身份。
  // self 模式登录态由壳侧登录门保证；adspower 模式无壳侧门——新建环境=全新未登录分身，首读必 halt。故 adspower 首读 halt 时
  // 不即刻停手，进【有界等待登录门】等操作者扫码；读出真 id 无缝续握手，超时/中断诚实【干净停止】。红线不变：只在读出真实
  // 稳定 id 时握手，超时绝不猜、绝不回落 default；所有 halt 都经 terminateNow 真退出（绝不 bare-return 挂僵尸）。
  {
    // adspower 首读 allowNavigate=false：登录页无「我」锚点，navigate 兜底既接不住新登录又只带误导航风险（task 1.5）。self 维持默认。
    const firstReadOpts: ReadSelfIdentityOptions = { logger: (m) => console.log(m) };
    if (provider.kind === 'adspower') firstReadOpts.allowNavigate = false;
    const idRes = await platformDriver.readIdentity(session.cdp, firstReadOpts);
    const decision = platformDriver.decideIdentity(idRes, overrideAccountId);

    const action = await resolveStartupIdentity({
      providerKind: provider.kind,
      initialDecision: decision,
      override: overrideAccountId,
      loginWaitMs,
      decideIdentity: (r, o) => platformDriver.decideIdentity(r, o),
      logger: (m) => console.log(m),
      waitForLogin: () => {
        console.log(
          `[aidcp-edge] 请在浏览器里扫码登录目标账号（等待登录中，最长 ${Math.round(loginWaitMs / 1000)}s）…`,
        );
        console.log('[browser-parking] awaiting-login'); // 外壳可识别的等待态状态行（task 1.4 / 4.1）
        return waitForLoginIdentity(session.cdp, {
          timeoutMs: loginWaitMs,
          logger: (m) => console.log(m),
          // 平台无关就地重读（allowNavigate=false、单次扫描）：不 hammer CDP、不骚扰二维码页。
          readIdentity: (cdp) =>
            platformDriver.readIdentity(cdp, { allowNavigate: false, hydrateTimeoutMs: 0, logger: () => undefined }),
          // 中断：等待早窗唯一被搁置的中断路径是经 IPC 堆进 pendingLifecycleCommands 的暂停/关闭；非破坏性探测（find 不 splice），
          // 成功续跑后仍由下方 dispatchLifecycleCommand 一次性派发这些排队命令（不双派发）。
          pollInterrupt: () => {
            const cmd = pendingLifecycleCommands.find((c) => c === 'pause' || c === 'close');
            return cmd ?? null;
          },
        });
      },
    });

    if (action.kind === 'terminate') {
      if (action.reason === 'login_wait_timeout') {
        console.error(
          `[aidcp-edge] ✗ 等待登录超时（${Math.round(loginWaitMs / 1000)}s 内未完成登录）→ 诚实停手（干净停止、不自动重起）。请在浏览器登录目标账号后点「启动」重试。`,
        );
      } else if (action.reason.startsWith('interrupted:')) {
        const cmd = action.reason.slice('interrupted:'.length);
        console.log(`[aidcp-edge] 等待登录期间收到「${cmd}」→ 干净停止（不自动重起），可在浏览器登录后点「启动/恢复」重来。`);
      } else {
        // 常规诚实停手（self / override 失败仍 halt / adspower 关等待门 / 等待后仍 halt）。
        const haltReason = 'reason' in decision ? decision.reason : '';
        console.error(`[aidcp-edge] ✗ 身份确立失败：登录态读不出稳定账号 id（${haltReason}）。`);
        console.error(
          '[aidcp-edge]   已停手（不握手、不连云端）。请确认该节点浏览器已登录目标账号后重启；如确需指定身份，可设 AIDCP_ACCOUNT_ID 覆盖。',
        );
      }
      terminateNow(action.code);
    } else {
      const resolved = action.decision;
      if (resolved.kind === 'use-override-after-read-fail') {
        console.warn(`[aidcp-edge] ⚠ 登录态读不出稳定 id（${resolved.reason}），改用 AIDCP_ACCOUNT_ID 覆盖值=${resolved.accountId}。`);
      } else if (resolved.mismatch) {
        console.warn(
          `[aidcp-edge] ⚠ AIDCP_ACCOUNT_ID 覆盖值(${resolved.mismatch.override}) ≠ 登录态真实 id(${resolved.mismatch.real})——以覆盖值为准，但身份与实际登录账号不一致，请确认是否预期。`,
        );
      }
      accountId = resolved.accountId;
      // 昵称仅在首读成功（in-place 恒 null / navigate 才有）时取；等待路径 idRes 为首读失败结果，verifiedAccountNickname 自然返回 undefined。
      accountNickname = verifiedAccountNickname(idRes, resolved);
      const display = accountNickname ? ` (${accountNickname})` : '';
      const source = 'source' in resolved ? resolved.source : 'env-override';
      console.log(`[aidcp-edge] 账号身份已确立: ${accountId}${display} [source=${source}]`);
    }
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
  const browserStartupId = `${edgeId}:${process.pid}:${Date.now().toString(36)}`;

  // 建号自助人设 stdin 桥（change edge-persona-keyword-generation）：身份已确立、client 就绪后装上，
  // 桌面壳经 stdin 下发 persona.generate/persist → 打到云端 → stdout [persona-reply] 回桥。
  registerPersonaStdinCommands(client, (m) => console.log(m));
  registerPublishApprovalStdinCommands(client, (m) => console.log(m));

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
  // 抢占取消登记（change lease-strict-preemption 5.3）：每条在途发布 dispatch 的**真取消**句柄——
  //   abort() 触发本命令的接管（abortForTakeover），settled 在 dispatch 真收敛时 resolve。
  //   协调器 writers.cancelPublish 遍历触发 abort + 有界等 settled；未收敛即抛（判控制面故障 yield_timeout）。
  //   与 inFlightPublishes（断连/回收路径的诚实失败回执）分工不同：前者取消、后者只发回执。
  const inFlightPublishCancels = new Map<string, { abort: () => void; settled: Promise<void> }>();
  // 提交窗口守卫（change lease-strict-preemption 5.1）：页面写者进入不可逆提交动作前 enter()、确认后 dispose()。
  //   publishGuard 归发布写者（XHS runSubmit + FB publish-executor）；browseGuard 归浏览写者（XHS 评论/通知分类、FB 评论/加群）。
  //   在此集中创建、下注入各写者（enter/exit），并（批 B-2b 激活时）经 combineCommitWindows 聚合喂给协调器 writers 探针。
  //   系统同一时刻至多一个独占写者在跑 ⇒ 至多一个窗口开着。
  const publishGuard = new CommitWindowGuard();
  const browseGuard = new CommitWindowGuard();
  // 退出码契约（看护进程 launch-multinode 据此决定是否重起）：
  //   0            = 关机（SIGINT/SIGTERM），不重起；
  //   EXIT_RECYCLE = 可恢复终态回收，请重起（sysexits EX_TEMPFAIL=75：临时失败、邀请重试）。
  const EXIT_RECYCLE = 75;
  // 平台无关的命令会话句柄：小红书=BrowseSession，Facebook=FacebookBrowseSession（EdgeBrowseSession 契约）。
  let browse: EdgeBrowseSession | undefined;
  // 关浏览器前等浏览循环排空的预算。有界是刚性要求：某个动作卡住时，无界等待会把冷待机 / 退出本身卡死
  // （浏览器关不掉 = 待机失效、回收挂僵尸），比原 bug 更糟。超时即诚实告警后照常关。
  const BROWSE_DRAIN_MS = Math.max(0, Number(process.env.AIDCP_BROWSE_DRAIN_MS ?? 5_000) || 5_000);
  // 排空超时绝不静默：浏览器即将在一个仍在进行的原子操作下被关掉，这是操作者需要知道的事实。
  const reportBrowseDrainTimeout = (drained: boolean, reason: string): void => {
    if (drained) return;
    console.warn(
      `[aidcp-edge] ⚠ 浏览循环未在 ${BROWSE_DRAIN_MS}ms 内排空（reason=${reason}）：仍按计划关闭浏览器，` +
        '在途动作会被中止并如实回执（不伪造成功）。',
    );
  };
  let overlayMonitor: OverlayMonitor | undefined;
  let watcherSupervisor: WatcherSupervisor | undefined;
  let identityWatcher: IdentityWatcher | undefined;
  let requestShutdown: ((reason: string) => void) | undefined;
  let coldStandbyActive = false;
  let coldStandbyWakeRequested = false;
  /** 当前唤醒请求所携带的最早死线（调用方等不下去的时刻）。见 requestColdStandbyWake 的闩升级语义。 */
  let coldStandbyWakeDeadlineAt: number | undefined;
  let coldStandbyCloudRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let coldStandbyCloudRetrying = false;
  const coldStandbyCloudRetryMs = Math.max(
    5_000,
    Number(process.env.AIDCP_STANDBY_CLOUD_RETRY_MS ?? 30_000) || 30_000,
  );
  const sendLifecycleIpc = (payload: Record<string, unknown>): void => {
    if (typeof process.send === 'function' && process.connected) process.send(payload);
  };
  const clearColdStandbyCloudRetry = (): void => {
    if (coldStandbyCloudRetryTimer) clearTimeout(coldStandbyCloudRetryTimer);
    coldStandbyCloudRetryTimer = undefined;
    coldStandbyCloudRetrying = false;
  };
  const notifyColdStandbyCloudDegraded = (reason: string): void => {
    sendLifecycleIpc({ type: 'lifecycle.standby_cloud_degraded', reason });
  };
  const notifyColdStandbyCloudReconnected = (): void => {
    sendLifecycleIpc({ type: 'lifecycle.standby_cloud_reconnected' });
  };
  const scheduleColdStandbyCloudReconnect = (reason: string): void => {
    if (!coldStandbyActive || coldStandbyCloudRetryTimer || coldStandbyCloudRetrying) return;
    notifyColdStandbyCloudDegraded(reason);
    coldStandbyCloudRetryTimer = setTimeout(() => {
      coldStandbyCloudRetryTimer = undefined;
      if (!coldStandbyActive) return;
      coldStandbyCloudRetrying = true;
      client.connect()
        .then(() => {
          coldStandbyCloudRetrying = false;
          if (!coldStandbyActive) return;
          console.log('[aidcp-edge] 冷待机期间云端后台重连成功；继续保持待机，等待唤醒');
          notifyColdStandbyCloudReconnected();
        })
        .catch((err) => {
          coldStandbyCloudRetrying = false;
          if (!coldStandbyActive) return;
          const message = (err as Error)?.message || String(err);
          console.warn(`[aidcp-edge] 冷待机期间云端后台重连失败：${message}；继续待机并稍后重试`);
          scheduleColdStandbyCloudReconnect('standby_cloud_retry_failed');
        });
    }, coldStandbyCloudRetryMs);
    (coldStandbyCloudRetryTimer as { unref?: () => void }).unref?.();
  };
  /**
   * 请求外壳恢复浏览器。
   *
   * 闩（`coldStandbyWakeRequested`）防的是「反复打扰外壳」，**不是**「一个 reason 赢了就永远不许别人说话」。
   * 旧写法是后者：一条待机期的浏览命令先把闩锁上，随后**带死线**的云端任务请求就一个字节都发不出去，
   * 外壳永远不知道有人正在死线上等——于是那个任务只能干等到自己的死线。
   * 所以：闩记住当前死线；**新请求带来更早的死线就重发 IPC 升级**（外壳幂等更新已有等待者，不重复入队）。
   */
  const requestColdStandbyWake = (reason: string, deadlineAt?: number): void => {
    if (!coldStandbyActive) return;
    const earlier = deadlineAt !== undefined
      && (coldStandbyWakeDeadlineAt === undefined || deadlineAt < coldStandbyWakeDeadlineAt);
    if (coldStandbyWakeRequested && !earlier) return;
    coldStandbyWakeRequested = true;
    if (earlier) coldStandbyWakeDeadlineAt = deadlineAt;
    else if (coldStandbyWakeDeadlineAt === undefined) coldStandbyWakeDeadlineAt = deadlineAt;
    clearColdStandbyCloudRetry();
    console.log(
      `[aidcp-edge] 冷待机期间收到唤醒触发 (${reason})，请求外壳恢复浏览器`
        + (coldStandbyWakeDeadlineAt !== undefined ? `（死线还剩 ${Math.max(0, coldStandbyWakeDeadlineAt - Date.now())}ms）` : ''),
    );
    sendLifecycleIpc({ type: 'lifecycle.wake_requested', reason, deadlineAt: coldStandbyWakeDeadlineAt });
  };
  /** 唤醒有了结论（成功 / 失败 / 外壳说这次没轮到）→ 复位闩，否则这个账号此后再也不会请求唤醒 = 永久停摆。 */
  const clearColdStandbyWakeLatch = (): void => {
    coldStandbyWakeRequested = false;
    coldStandbyWakeDeadlineAt = undefined;
  };
  /**
   * 唤醒死线（change browser-slot-scheduling）：冷启 30–90s + 外壳串行启动队列的排队时间 + 余量。
   * **必须小于云端 240s 空转看门狗**——否则一个正在正常唤醒的账号会被云端当成卡死、杀掉整个会话。
   */
  const WAKE_DEADLINE_MS = Math.max(30_000, Number(process.env.AIDCP_WAKE_DEADLINE_MS ?? 180_000) || 180_000);
  let wakeWaiters: Array<(ok: boolean) => void> = [];
  /** 唤醒有了结论（成功 / 失败 / 外壳说这次没轮到）→ 一次性放行所有等待者。绝不让任何一个吊死到死线。 */
  const settleWake = (ok: boolean): void => {
    const waiters = wakeWaiters;
    wakeWaiters = [];
    for (const w of waiters) w(ok);
  };
  onWakeDenied = (detail: string): void => {
    console.warn(`[aidcp-edge] 外壳暂时给不出浏览器槽位（${detail}）：本次诚实作答，环境仍在等槽位队列里`);
    clearColdStandbyWakeLatch(); // 否则此后再无任何唤醒请求发得出去 = 这个账号永久停摆
    settleWake(false);
  };
  /**
   * **唯一的浏览器闸**（change browser-slot-scheduling）：所有要碰浏览器的动作都走它。
   *
   * 浏览器在 → 直接放行。浏览器被冷待机收起 → 请求外壳唤醒（外壳持槽位池与串行启动队列，唤醒必须
   * 经它过内存准入，核心不得自己偷偷开浏览器）→ 有界等待 → 就绪则放行，否则**诚实失败**。
   * MUST NOT 静默无动作，MUST NOT 回一句假的「浏览器故障」。
   */
  const ensureBrowserAwake = (reason: string, deadlineAt?: number): Promise<boolean> => {
    if (!coldStandbyActive) return Promise.resolve(true);
    requestColdStandbyWake(reason, deadlineAt);
    // 等待上界 = 自己的死线与调用方死线取小。调用方（云端 acquire）的死线是外部的、不可谈判的：
    // 它到点就走人，我们再等下去只是对着空气等。
    const budgetMs = deadlineAt === undefined
      ? WAKE_DEADLINE_MS
      : Math.max(0, Math.min(WAKE_DEADLINE_MS, deadlineAt - Date.now()));
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        console.warn(`[aidcp-edge] ⚠ 唤醒未在 ${budgetMs}ms 死线内完成（reason=${reason}）：诚实判失败`);
        finish(false);
      }, budgetMs);
      (timer as { unref?: () => void }).unref?.();
      wakeWaiters.push(finish);
    });
  };
  const taskCoordinator = new EdgeTaskCoordinator({
    browse: {
      quiesceForTask: () => browse?.quiesceForTask() ?? Promise.resolve(0),
      resumeAfterTask: () => browse?.resumeAfterTask() ?? Promise.resolve(),
    },
    // 页面写者注册表探针（change lease-strict-preemption 5.2/5.3/5.9）：**接线即激活抢占引擎**。
    //   - inCommitWindow/commitWindowRemainingMs：六站提交窗口聚合（enter/exit 在各写者内）；窗口内绝不强杀，回 window_busy + 剩余预算。
    //   - publishInFlight：在途发布写（独立于租约）→ 封住普通浏览导航，绝不让恢复导航把发布页导走（治 5.9 假成功）。
    //   - cancelPublish：抢占/让位时真取消在途发布并有界等收敛；未收敛即抛（协调器判控制面故障 yield_timeout）。
    writers: {
      ...combineCommitWindows([publishGuard, browseGuard]),
      publishInFlight: () => inFlightPublishes.size > 0,
      cancelPublish: async (timeoutMs?: number): Promise<number> => {
        const entries = [...inFlightPublishCancels.values()];
        if (entries.length === 0) return 0;
        for (const entry of entries) entry.abort(); // 触发接管（abortForTakeover）：下一个安全取消点抛出、dispatch 就地作废
        const budget = timeoutMs && timeoutMs > 0 ? timeoutMs : Number(process.env.AIDCP_TASK_QUIESCE_MS) || 30_000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`publish_cancel_timeout_${budget}ms`)), budget);
          timer.unref?.();
        });
        try {
          // allSettled 在全部 dispatch 真收敛时 resolve；超预算未收敛 → timeout 抛出 → 协调器判控制面故障。
          await Promise.race([Promise.allSettled(entries.map((entry) => entry.settled)), timeout]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        return entries.length;
      },
    },
    canAcquire: () => session.cdp.isControlReady(),
    // 「浏览器被我们自己收起来了」≠「浏览器坏了」。前者叫得醒，后者才是 cdp_unhealthy。
    browserAbsent: () => coldStandbyActive,
    requestWake: (deadlineAt) => ensureBrowserAwake('edge_task', deadlineAt),
    onAcquired: (payload) => {
      try {
        client.send('edge.task.acquired', payload);
      } catch (err) {
        console.error('[aidcp-edge] edge.task.acquired 回传失败:', err);
      }
    },
    onReleased: (payload) => {
      try {
        client.send('edge.task.released', payload);
      } catch (err) {
        console.error('[aidcp-edge] edge.task.released 回传失败:', err);
      }
    },
    logger: (message) => console.log(message),
  });
  session.cdp.on('cdp.control_recovered', () => taskCoordinator.resumeAfterControlRecovery());

  // §7 回收契约：把全部在途发布诚实判失败（须在关闭云端连接之前发，确保失败回执发得出去）。
  // 云端 WS 已断时 send 会 best-effort 失败，但本地 in-flight 必须立刻清掉，避免重连后重放旧发布。
  const failInFlightPublishesHonestly = (reason: string): void => {
    for (const [, failer] of inFlightPublishes) failer(reason);
    inFlightPublishes.clear();
  };

  client.on('cloud.disconnected', () => {
    failInFlightPublishesHonestly('cloud_ws_disconnected');
    taskCoordinator.reset('cloud_ws_disconnected');
    browse?.discardQueuedCloudCommands('cloud_ws_disconnected');
  });
  client.on('cloud.reconnected', () => {
    if (coldStandbyActive) {
      clearColdStandbyCloudRetry();
      console.log('[aidcp-edge] 冷待机期间云端已重连；继续保持待机，等待唤醒');
      return;
    }
    const reconnPacing = client.getPacing();
    browse?.applyPacingSnapshot(reconnPacing?.opFloorsMs, reconnPacing?.tempo);
    browse?.recoverAfterCloudReconnect().catch((err) => {
      console.error('[aidcp-edge] 云端重连后浏览恢复失败:', err);
    });
  });
  client.on('cloud.unrecoverable', () => {
    if (coldStandbyActive) {
      console.warn('[aidcp-edge] 冷待机期间云端重连耗尽；保持冷待机，不回收重启浏览器');
      scheduleColdStandbyCloudReconnect('cloud_reconnect_exhausted');
      return;
    }
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
  client.onEdgeTaskCommand((env) => {
    if (env.type === 'edge.task.acquire') {
      taskCoordinator.acquire(env.payload as EdgeTaskAcquirePayload);
    } else if (env.type === 'edge.task.release') {
      taskCoordinator.release(env.payload as EdgeTaskReleasePayload);
    }
  });

  // 指令驱动发布：云端逐条下发 publish.command，边缘逐条执行 + 后置校验 + 如实回报（onPublishAtomCommand，见下）。
  // 遗留整页发布处理器 client.onPublishCommand（publish.request）已删除（change lease-strict-preemption 5.8）：
  //   全程不过租约闸、云端已无发送方（只发 publish.command），保留只会绕过抢占/租约在途发布假成功修复链。
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
  const facebookImageUploader = new ImageUploader({
    fileInputSetter: new CdpFileInputSetter(session.cdp, {
      inputSelector: String.raw`(() => {
        const visible = (el) => {
          if (!el || !el.getBoundingClientRect) return false;
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle ? getComputedStyle(el) : null;
          return r.width > 0 && r.height > 0 && (!s || (s.display !== 'none' && s.visibility !== 'hidden'));
        };
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).filter(visible);
        const root = dialogs[0] || document;
        const inputs = Array.from(root.querySelectorAll('input[type=file]'));
        return inputs.find((input) => /image|jpg|jpeg|png|webp|gif/i.test(input.getAttribute('accept') || '')) || inputs[0] || null;
      })()`,
    }),
    dom: session.dom,
    tempDirPrefix: imageTempPrefix,
    hasThumbnail: (root) => {
      try {
        const labels = Array.from(root.querySelectorAll('[aria-label],[title]')).map((el) =>
          `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`,
        );
        if (labels.some((label) => /(remove|delete|移除|删除|刪除).{0,12}(photo|image|attachment|照片|图片|圖片|附件)/i.test(label))) return true;
        const docBody = 'body' in root ? root.body : null;
        const text = (docBody?.innerText ?? root.textContent ?? '').replace(/\s+/g, ' ');
        return /(photo attached|image attached|attachment attached|已添加照片|已加入照片|已添加图片|已添加附件|đã thêm ảnh)/i.test(text);
      } catch {
        return false;
      }
    },
  });
  const facebookPublishExecutor = new FacebookPublishExecutor({
    cdp: session.cdp,
    uploader: facebookImageUploader,
    commitWindow: publishGuard, // 5.1：FB 发布提交窗口与 XHS 共用同一 publishGuard
  });
  const publishDispatcher = new PublishCommandDispatcher(
    {
      dom: session.dom,
      executor: session.executor,
      selector,
      cache: publishCache,
    },
    PUBLISH_ENGINE_OPTIONS,
    Date.now,
    imageUploader,
    // 注入原始 CDP：navigate_entry 直达发布页 + select_mode 直驱点「上传图文」（发布页特殊 UI，通用选择器不可靠）。
    session.cdp,
    undefined,
    facebookPublishExecutor,
    publishGuard, // 5.1：XHS runSubmit 提交窗口
  );
  // 陪伴界面事件（edge-companion-ui 6.4）：发布终态的本地事实经 [ui-event] 行直达桌面壳。
  const publishUiEvents = new PublishUiEventTracker();
  client.onPublishAtomCommand((env) => {
    if (!taskCoordinator.canExecute(env.payload.taskId)) {
      client.send(
        'publish.command.result',
        {
          recordId: env.payload.recordId,
          seq: env.payload.seq,
          kind: env.payload.kind,
          ok: false,
          error: 'task_lease_mismatch',
        },
        env.id,
      );
      console.warn(
        `[aidcp-edge] 拒绝无效发布租约 taskId=${env.payload.taskId || '-'} current=${taskCoordinator.currentTaskId ?? '-'}`,
      );
      return;
    }
    taskCoordinator.touch(env.payload.taskId);
    // 抢占取消上下文（5.3）：per-command AbortController = 本命令的接管世代令牌（局部，绝不存进单例字段 → 见 takeover.ts 契约）。
    const abort = new AbortController();
    const takeoverCtx: TakeoverCtx = {
      checkpoint: () => {
        if (abort.signal.aborted) throw new TaskTakeoverError();
      },
      signal: abort.signal,
    };
    const settled = (async () => {
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
        result = await publishDispatcher.dispatch(env.payload, takeoverCtx);
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
        inFlightPublishCancels.delete(env.id);
        // 在途发布收敛 → 若协调器空闲则恢复浏览（否则 publishInFlight 闸会让浏览在 dispatch 结束后永久冻结，复核 finding C）。
        taskCoordinator.notifyPublishSettled();
      }
      const uiLine = publishUiEvents.onResult(env.payload, result);
      if (uiLine) console.log(uiLine);
      try {
        client.send('publish.command.result', result, env.id);
      } catch (sendErr) {
        console.error('[aidcp-edge] publish.command.result 回传失败:', sendErr);
      }
    })();
    settled.catch(() => {}); // IIFE 自包含（内部已 try/catch）不应抛；防御性避免意外 unhandledRejection
    inFlightPublishCancels.set(env.id, { abort: () => abortForTakeover(abort), settled });
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
    if (env.type === 'captcha.assist.click') {
      const clickPayload = env.payload as { taskId?: string; incidentId: string; snapshotId: string };
      const taskId = clickPayload.taskId;
      if (!taskId || !taskCoordinator.canExecute(taskId)) {
        client.send('captcha.assist.click_result', {
          incidentId: clickPayload.incidentId,
          snapshotId: clickPayload.snapshotId,
          edgeId,
          ...(accountId ? { accountId } : {}),
          status: 'failed',
          reason: 'task_lease_mismatch',
          checkedAt: Date.now(),
        });
        return;
      }
      taskCoordinator.touch(taskId);
    }
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
      commitWindow: browseGuard, // 5.1：FB 评论回车提交窗口
    });
    const fbJoinExecutor = platformDriver.capabilities.includes('join')
      ? new FacebookJoinExecutor({
          cdp: session.cdp,
          overlayMonitor,
          logger: (m) => console.log(m),
          commitWindow: browseGuard, // 5.1/5.10b：FB 加群短确认窗口
        })
      : undefined;
    const fbCommentHandler = new FacebookCommentHandler({
      executor: fbCommentExecutor,
      ...(fbJoinExecutor ? { joinExecutor: fbJoinExecutor } : {}),
      client,
      logger: (m) => console.log(m),
    });
    client.onBrowseCommand((env) => {
      if (coldStandbyActive) {
        requestColdStandbyWake(`cloud_command:${env.type}`);
        return;
      }
      const taskId = (env.payload as { taskId?: unknown } | undefined)?.taskId;
      const ownedTaskId = typeof taskId === 'string' ? taskId : undefined;
      if (!taskCoordinator.canExecute(ownedTaskId)) {
        console.warn(
          `[aidcp-edge] Facebook 命令被任务租约抑制 type=${env.type} taskId=${ownedTaskId ?? '-'} current=${taskCoordinator.currentTaskId ?? '-'}`,
        );
        return;
      }
      if (ownedTaskId) taskCoordinator.touch(ownedTaskId);
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
  // Facebook 声明 browse → 装配闸解析到 FacebookBrowseSession（绝不小红书 BrowseSession；co-landing 不变量）。
  const useFacebookBrowse = usesFacebookBrowseSession(platformDriver);
  const autoBrowse = wantsAutoBrowse && supportsBrowse && !useFacebookBrowse;
  if (wantsAutoBrowse && !supportsBrowse) {
    console.warn(`[aidcp-edge] platform=${platformDriver.platform} does not support browse; BrowseSession will not start.`);
  }
  if (useFacebookBrowse) {
    // —— Facebook 浏览+点赞闭环（change facebook-browse-and-like-loop）——
    // FacebookBrowseSession 独占单槽 browseHandler，【内含】评论/加群委托（声明 browse 后旧 comment-only 注册闸
    // `(comment||join)&&!browse` 不再触发）。浏览/点赞由 AIDCP_FB_BROWSE_AUTO（off/shadow/on）门控，评论/加群始终服务。
    overlayMonitor = platformDriver.createOverlayMonitor(session.cdp);
    // FB 浏览高危动作会触发验证码 / FB 软限流（overlay.ts 归类 unknown）。把 captcha/unknown 翻转上报云端
    // （risk.captcha_detected/cleared）：驱动远程验证码协助 + FB 限流退避（account-nurture-discipline-spine 云端
    // facebook-throttle-signals 依赖此信号把账号迁至 restricted）。复用小红书同一套上报闸（unknown 延后确认 /
    // captcha 即时 fail-closed / detected-cleared 严格配对）。执行器另有每步 fresh 复检做本地 fail-closed。
    {
      const overlayConfirmMs = Number(process.env.AIDCP_OVERLAY_CONFIRM_MS ?? 2000);
      const isCloudBlockingOverlay = (kind: string): kind is 'captcha' | 'unknown' => kind === 'captcha' || kind === 'unknown';
      let overlaySnapshotPromise: Promise<BlockingOverlaySnapshot | undefined> | undefined;
      const resetOverlaySnapshot = (): void => {
        overlaySnapshotPromise = undefined;
      };
      const primeOverlaySnapshot = (kind: 'captcha' | 'unknown'): void => {
        if (overlaySnapshotPromise) return;
        overlaySnapshotPromise = captureBlockingOverlaySnapshot(session.cdp, kind).catch(() => undefined);
      };
      const sendOverlayDetected = (kind: 'captcha' | 'unknown'): void => {
        void (async () => {
          primeOverlaySnapshot(kind);
          const overlay = await overlaySnapshotPromise;
          let url = overlay?.firstDetectedUrl ?? '';
          if (!url) {
            try {
              url = await evalRaw<string>(session.cdp, 'location.href');
            } catch {
              /* best-effort */
            }
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
          console.warn(`[aidcp-edge] ⚠ Facebook 检测到${kind === 'captcha' ? '验证码' : '未知阻断/限流'}，已上报云端`);
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
        },
        isStillUnknown: () => overlayMonitor?.state === 'unknown',
        schedule: (fn, ms) => {
          setTimeout(fn, ms);
        },
        confirmMs: overlayConfirmMs,
      });
      // 用 WatcherSupervisor 托管 overlayMonitor 生命周期（CDP 不可恢复→停避免僵尸轮询；重连→重启），
      // 取代裸 overlayMonitor.start()（否则会话失联后监测体空轮询到进程退出）。
      const fbSupervisor = new WatcherSupervisor();
      watcherSupervisor = fbSupervisor;
      fbSupervisor.register(overlayMonitor, (from, to) => {
        if (isCloudBlockingOverlay(to) && !isCloudBlockingOverlay(from)) primeOverlaySnapshot(to);
        if (!isCloudBlockingOverlay(to)) resetOverlaySnapshot();
        overlayReportGate.onTransition(from, to);
      });
      session.cdp.on?.('cdp.unrecoverable', () => fbSupervisor.stopAll());
      session.cdp.on?.('cdp.reconnected', () => fbSupervisor.startAll());
      fbSupervisor.startAll();
    }
    const fbCommentExecutor = new FacebookCommentExecutor({
      cdp: session.cdp,
      getAccountId: () => accountId,
      overlayMonitor,
      logger: (m) => console.log(m),
      commitWindow: browseGuard, // 5.1：FB 评论回车提交窗口
    });
    const fbJoinExecutor = new FacebookJoinExecutor({
      cdp: session.cdp,
      overlayMonitor,
      logger: (m) => console.log(m),
      commitWindow: browseGuard, // 5.1/5.10b：FB 加群短确认窗口
    });
    const fbCommentHandler = new FacebookCommentHandler({
      executor: fbCommentExecutor,
      joinExecutor: fbJoinExecutor,
      client,
      logger: (m) => console.log(m),
    });
    browse = new FacebookBrowseSession(
      {
        cdp: session.cdp,
        client,
        commentHandler: fbCommentHandler,
        overlayMonitor,
        logger: (m) => console.log(m),
      },
      {
        feedUrl: process.env.AIDCP_EXPLORE_URL ?? platformDriver.defaultStartUrl,
        startupId: browserStartupId,
        tempo: client.getPacing()?.tempo,
      },
    );
    const fbSession = browse;
    client.onBrowseCommand((env) => {
      if (coldStandbyActive) {
        requestColdStandbyWake(`cloud_command:${env.type}`);
        return;
      }
      const taskId = (env.payload as { taskId?: unknown } | undefined)?.taskId;
      const ownedTaskId = typeof taskId === 'string' ? taskId : undefined;
      if (!taskCoordinator.canExecute(ownedTaskId)) {
        console.warn(
          `[aidcp-edge] Facebook 命令被任务租约抑制 type=${env.type} taskId=${ownedTaskId ?? '-'} current=${taskCoordinator.currentTaskId ?? '-'}`,
        );
        return;
      }
      if (ownedTaskId) taskCoordinator.touch(ownedTaskId);
      fbSession.onCloudCommand(env).catch((err) => {
        console.error(`[aidcp-edge] 执行 Facebook 命令 ${env.type} 失败:`, err);
      });
    });
    // 交接现在有界且会诚实抛出（change lease-strict-preemption）。此处是**全新会话**（零在飞写者），
    // 必然瞬时收敛；catch 只为不让一个诚实异常炸掉装配流程。
    if (taskCoordinator.blocksBrowse) {
      await browse.quiesceForTask().catch((err) => {
        console.warn(`[aidcp-edge] 注册 Facebook 会话时交接未收敛：${(err as Error).message}`);
      });
    }
    // 不 await：会话长跑，与命令收发并行。start() 内部据 AIDCP_FB_BROWSE_AUTO 决定是否自动进 feed。
    browse.start().catch((err) => {
      console.error('[aidcp-edge] Facebook 浏览会话异常:', err);
    });
    console.log(`[aidcp-edge] Facebook 浏览会话已注册（mode=${parseFacebookBrowseMode()}，含评论/加群委托）`);
  }
  if (autoBrowse) {
    const browseOpts: BrowseSessionOptions = {};
    browseOpts.exploreUrl = process.env.AIDCP_EXPLORE_URL ?? platformDriver.defaultStartUrl;
    browseOpts.startupId = browserStartupId;
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
        commitWindow: browseGuard, // 5.1：XHS 评论提交 + 通知分类栏目点击窗口
      },
      browseOpts,
    );
    // 云端异步推送的浏览控制命令统一转发到 BrowseSession 执行
    client.onBrowseCommand((env) => {
      if (coldStandbyActive) {
        requestColdStandbyWake(`cloud_command:${env.type}`);
        return;
      }
      if (!browse) {
        console.log(`[aidcp-edge] 收到云端命令 ${env.type} 但浏览会话未创建，忽略`);
        return;
      }
      const taskId = (env.payload as { taskId?: unknown } | undefined)?.taskId;
      const ownedTaskId = typeof taskId === 'string' ? taskId : undefined;
      // pacing.update 是轻量档位刷新（change pacing-fallback-hardening）：不触碰页面 / 不入队 / 不唤醒，
      // MUST 穿透任务租约闸——否则独占任务（发布 / 评论 / 验证码恢复）窗口内的升档会被丢弃，
      // 而云端乐观推送不重发同值 → 边缘永停在旧档。onCloudCommand 顶端会即时应用并返回。
      if (env.type !== 'pacing.update' && !taskCoordinator.canExecute(ownedTaskId)) {
        console.warn(
          `[aidcp-edge] 任务租约抑制命令 type=${env.type} taskId=${ownedTaskId ?? '-'} current=${taskCoordinator.currentTaskId ?? '-'}`,
        );
        return;
      }
      if (ownedTaskId) taskCoordinator.touch(ownedTaskId);
      browse.onCloudCommand(env).catch((err) => {
        console.error(`[aidcp-edge] 执行云端命令 ${env.type} 失败:`, err);
      });
    });
    // 同上：全新会话必然瞬时收敛，catch 只为不让诚实异常炸掉装配流程。
    if (taskCoordinator.blocksBrowse) {
      await browse.quiesceForTask().catch((err) => {
        console.warn(`[aidcp-edge] 注册浏览会话时交接未收敛：${(err as Error).message}`);
      });
    }
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
    const confirmLoggedOut = platformDriver.platform === 'facebook'
      ? async () => overlayMonitor?.state === 'login' || (await readFacebookIdentityPageContext(session.cdp)) === 'creator-login'
      : () => loginWall.isOpen();
    identityWatcher = new IdentityWatcher(session.cdp, accountId!, {
      intervalMs: Number(process.env.AIDCP_IDENTITY_CHECK_MS ?? 30_000),
      threshold: Number(process.env.AIDCP_IDENTITY_FAIL_THRESHOLD ?? 2),
      logger: (m) => console.log(m),
      readIdentity: platformDriver.readIdentity,
      ...(platformDriver.platform === 'facebook' ? { pageContext: () => readFacebookIdentityPageContext(session.cdp) } : {}),
      confirmLoggedOut,
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
  const lifecycle = new CoreLifecycleController({
    deactivate: async (reason) => {
      coldStandbyActive = false;
      clearColdStandbyCloudRetry();
      console.log(`\n[aidcp-edge] 自动运营停用流程启动（reason=${reason}）...`);
      // 暂停/关闭/回收都先诚实终止在途发布，绝不让半截命令跨恢复重放。
      failInFlightPublishesHonestly(reason);
      watcherSupervisor?.stopAll();
      // 终态关闭：用 closeAndWait()（非 close()/stop()）——置 closing 使停用窗口内迟到的云端命令绝不唤醒
      // 浏览循环，并**等循环真正退出原子区再往下走**。下面 session.close() 会切 CDP、随后 closeOwnedBrowser()
      // 杀浏览器；若不等排空，循环醒来还会摸页面，调用直接打在死 CDP 上（同冷待机那条 bug）。
      reportBrowseDrainTimeout((await browse?.closeAndWait(BROWSE_DRAIN_MS)) ?? true, reason);
      // 诚实下线：等边-云连接真正关闭再继续（有界），使云端立即停止把本节点当路由目标。
      try {
        await client.closeAndWait(1500);
      } catch {
        /* best-effort */
      }
      session.close();
    },
    closeOwnedBrowser: async () => {
      // 仅最终关闭才到这里；pause/resume-preserve 明确绕过。复用模式绝不回收外部浏览器。
      if (chrome.reused) {
        console.log('[aidcp-edge] 复用模式：只诚实退出，不回收本进程不拥有的外部 Chrome');
        return true;
      }
      try {
        const freed = await chrome.killAndConfirmDead();
        if (!freed) {
          console.warn(
            '[aidcp-edge] ⚠ 升级 SIGKILL 后调试端口仍未确认释放，继续退出（看护重起时 clearStaleSingletonLock 会再判活拒启）',
          );
        }
        return freed;
      } catch (error) {
        console.warn(`[aidcp-edge] ⚠ 浏览器最终回收异常：${(error as Error)?.message || String(error)}`);
        return false;
      }
    },
    enterStandby: async () => {
      console.log('\n[aidcp-edge] 冷待机流程启动：停止自动化、释放浏览器层、关闭浏览器、保留云端连接...');
      clearColdStandbyCloudRetry();
      // 释放 ⊥ 在跑租约（change browser-slot-scheduling）：任务持着执行权时绝不把浏览器从它底下抽走。
      // 待机请求推迟到租约结束后由外壳再判（这里如实拒绝，不静默降级成「等一会儿再偷偷关」）。
      if (taskCoordinator.hasActiveLease()) {
        console.log('[aidcp-edge] 有任务租约在跑，拒绝进入冷待机（绝不把浏览器从正在执行的任务底下抽走）');
        return false;
      }
      if (chrome.reused) {
        console.log('[aidcp-edge] 复用模式：不回收本进程不拥有的外部 Chrome，拒绝进入冷待机');
        return false;
      }
      coldStandbyActive = true;
      clearColdStandbyWakeLatch();
      failInFlightPublishesHonestly('cold_standby');
      watcherSupervisor?.stopAll();
      // 关浏览器前必须等浏览循环真正退出原子区（红线）：stop() 只是请求停止，循环可能正卡在首屏扫描 /
      // 停留等待里，醒来后照样摸页面——那时浏览器已被下面 killAndConfirmDead() 杀掉，调用直接打在死 CDP 上。
      // 用 stopAndWait（非 closeAndWait）：待机是**可回来的**，close() 的 closing 是终态、唤醒后就再也起不来了。
      reportBrowseDrainTimeout((await browse?.stopAndWait(BROWSE_DRAIN_MS)) ?? true, 'cold_standby');
      // 释放浏览器层：断开 CDP 并进入「浏览器缺席」态。必须**在杀浏览器之前**——否则 WS 被动断开会被
      // 当成意外掉线、触发有界重连，最后把连接对象搞成一个 recovering/unavailable 的僵尸（今天的 bug）。
      // 释放后任何页面命令都会响亮失败，绝不静默假成功。
      session.detach();
      try {
        const freed = await chrome.killAndConfirmDead();
        if (!freed) {
          console.warn('[aidcp-edge] ⚠ 冷待机浏览器关闭状态未能确认，拒绝进入冷待机');
          coldStandbyActive = false;
          clearColdStandbyCloudRetry();
          return false;
        }
        return true;
      } catch (error) {
        console.warn(`[aidcp-edge] ⚠ 冷待机关闭浏览器异常：${(error as Error)?.message || String(error)}`);
        coldStandbyActive = false;
        clearColdStandbyCloudRetry();
        return false;
      }
    },
    /**
     * 冷待机唤醒：**原地重建浏览器层**（change browser-slot-scheduling）。核心进程不重启、云端连接不断开。
     *
     * 重建当作**新的一代浏览器**：绝不假设还登着——重新确认登录态与账号身份。身份读不出来（未登录 /
     * 需验证）即诚实判唤醒失败、留在待机态，绝不把一个没登录的浏览器当就绪、更不回落默认账号。
     */
    wakeFromStandby: async () => {
      console.log('\n[aidcp-edge] 唤醒：重开浏览器 + 原地重建浏览器层（核心进程与云端连接不动）...');
      try {
        // 1) 重开浏览器。新一代 = 新的调试端口，整体换掉 chrome / endpoint / attachOpts。
        const relaunched = await provider.launch(launchOpts);
        chrome = relaunched.instance;
        endpoint = relaunched.endpoint;
        attachOpts.host = endpoint.host;
        attachOpts.port = endpoint.port;

        // 2) 把既有的会话对象重新附着上去（保住 CdpClient 身份 → 十几个持有者与订阅者全程无感）。
        //    重连配置在这里被重新构造，classify/rediscover 闭包里的端口随之更新——不换它，唤醒后第一次
        //    瞬断就会拿旧端口探活、探不到即误判「进程已死 = 终局」，把可续跑的连接直接判死。
        await reattachSession(session, attachOpts);

        // 3) 停放（最小化 / 移出视野）要重新施加：新浏览器窗口不继承上一代的位置。
        try {
          await applyBrowserParking(session.cdp, parkingConfig, (m) => console.log(m));
        } catch (e) {
          console.log(`[browser-parking] apply failed after wake: ${(e as Error).message}`);
        }

        // 4) 重新确认登录态与身份（红线：新一代浏览器，绝不假设还登着）。
        const idRes = await platformDriver.readIdentity(session.cdp, { logger: (m) => console.log(m) });
        const decision = platformDriver.decideIdentity(idRes, overrideAccountId);
        if (decision.kind === 'halt') {
          console.error(
            `[aidcp-edge] ✗ 唤醒后身份确认失败（${decision.reason}）：浏览器起来了但读不出登录身份。` +
              '如实判唤醒失败、留在待机态（可再次唤醒），绝不以默认账号开跑。',
          );
          session.detach();
          await chrome.killAndConfirmDead().catch(() => undefined);
          return false;
        }
        if (decision.accountId !== accountId) {
          // 换号：走既有的身份重建路径（它会按新 id 重连云端、rebaseline 监测体、重启浏览循环）。
          console.warn(`[aidcp-edge] 唤醒后发现账号已变（${accountId} → ${decision.accountId}），走身份重新确立路径`);
          coldStandbyActive = false;
          clearColdStandbyWakeLatch();
          await reestablishIdentity();
          return true;
        }

        // 5) 恢复自动化：监测体重挂、浏览循环重开（注意顺序——先出待机态，否则循环起手就被待机守卫挡回）。
        coldStandbyActive = false;
        clearColdStandbyWakeLatch();
        clearColdStandbyCloudRetry();
        identityWatcher?.rebaseline(accountId!);
        watcherSupervisor?.startAll();
        const wakePacing = client.getPacing();
        browse?.applyPacingSnapshot(wakePacing?.opFloorsMs, wakePacing?.tempo);
        browse?.start().catch((err) => console.error('[aidcp-edge] 唤醒后浏览会话异常:', err));
        console.log('[aidcp-edge] ✓ 唤醒完成：浏览器已重建、身份已确认、自动化已恢复');
        return true;
      } catch (error) {
        console.warn(`[aidcp-edge] ⚠ 唤醒失败：${(error as Error)?.message || String(error)}；留在待机态，可再次唤醒`);
        // 半开的浏览器绝不留着占内存槽位——它既不能干活、又挡着别的账号。
        try {
          session.detach();
          await chrome.killAndConfirmDead().catch(() => undefined);
        } catch {
          /* best-effort */
        }
        return false;
      }
    },
    exit: (code) => process.exit(code),
    onPaused: () => {
      if (typeof process.send === 'function' && process.connected) {
        process.send({ type: 'lifecycle.paused' });
      }
    },
    onCloseFailed: () => {
      if (typeof process.send === 'function' && process.connected) {
        process.send({ type: 'lifecycle.close_failed' });
      }
    },
    onStandby: () => {
      if (typeof process.send === 'function' && process.connected) {
        process.send({ type: 'lifecycle.standby' });
      }
    },
    onWoken: () => {
      settleWake(true); // 放行所有卡在浏览器闸上的动作
      sendLifecycleIpc({ type: 'lifecycle.woken' });
    },
    // 唤醒失败必须让外壳知道：它要如实呈现「唤醒失败」并把槽位还回池子，绝不把这个环境当成已就绪。
    onWakeFailed: (reason) => {
      // 闩必须复位。不复位 = requestColdStandbyWake 此后永远早退 = 这个账号在本进程生命周期内
      // 对所有后续云端任务静默停摆（比槽位争用严重一个量级：它连「排队」都排不上）。
      clearColdStandbyWakeLatch();
      settleWake(false); // 立刻放行等待者去诚实失败，绝不让它们吊到 180s 死线
      sendLifecycleIpc({ type: 'lifecycle.wake_failed', reason });
    },
    logger: (message) => console.log(message),
  });

  dispatchLifecycleCommand = (command) => {
    void lifecycle.request(command).catch((error) => {
      console.error(`[aidcp-edge] lifecycle.${command} 处理失败:`, error);
    });
  };
  for (const command of pendingLifecycleCommands.splice(0)) dispatchLifecycleCommand(command);

  const shutdown = (opts: { exitCode: number; recycle: boolean; reason: string }): Promise<void> => {
    // 已请求回收则即便随后信号撞入也以回收码退出（真终态不被掩成 clean exit，MAJOR⑤）。
    const exitCode = recycleRequested ? EXIT_RECYCLE : opts.exitCode;
    return lifecycle.shutdown({ exitCode, reason: opts.reason, preserveBrowser: false });
  };
  requestShutdown = (reason: string): void => {
    if (recycleRequested) return;
    recycleRequested = true;
    void shutdown({ exitCode: EXIT_RECYCLE, recycle: true, reason });
  };

  // Input 超时的结果不确定：已由 CdpClient 封住后续页面写。若浏览器由本节点启动并拥有，则回收并让看护
  // 建一个新的 CDP 安全边界；复用的外部浏览器绝不强杀，只保留 unavailable 供操作者显式重启。
  const recycleOrHoldUnavailableBrowser = (): void => {
    // 冷待机：浏览器是我们自己关的，"控制不可用"是预期终局而非故障——绝不据此回收自杀
    // （与下方 cdp.unrecoverable 的守卫同口径；缺了它，待机期一条在途 Input 就能把核心杀掉）。
    if (coldStandbyActive) {
      console.log('[aidcp-edge] CDP 控制不可用发生在冷待机期间（浏览器已被有意关闭）；保留云端连接，等待外壳唤醒');
      return;
    }
    if (chrome.reused) {
      console.warn('[aidcp-edge] CDP 输入控制不可用：复用的外部浏览器不会被自动关闭；请人工重启浏览器客户端后恢复');
      return;
    }
    console.warn('[aidcp-edge] CDP 输入控制不可用：浏览器由本节点拥有，诚实下线并回收重启以建立新的控制边界');
    requestShutdown?.('cdp_control_unavailable');
  };
  session.cdp.on('cdp.control_unavailable', recycleOrHoldUnavailableBrowser);
  // attach 初始 enable 阶段若已经发生输入超时，订阅发生得较晚也必须按同一所有权边界处理。
  if (!session.cdp.isControlReady()) recycleOrHoldUnavailableBrowser();

  // CDP 终态（重连不可恢复）→ 诚实下线 + 回收退出（请重起）。autoBrowse 与否都接，节点失去浏览器即回收。
  session.cdp.on('cdp.unrecoverable', () => {
    if (coldStandbyActive) {
      console.log('[aidcp-edge] CDP 因冷待机关闭浏览器而不可用；保留云端连接，等待外壳唤醒');
      return;
    }
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
