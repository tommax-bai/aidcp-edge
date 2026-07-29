/**
 * aidcp-edge 边缘端启动入口（自动浏览 + 点赞垂直切片）。
 *
 * 装配：
 *  - 自动启动 / 复用本机 Chrome（由 chrome-launcher 管理生命周期）；
 *  - 连接本机 Chrome CDP（默认 127.0.0.1:9222），附着到一个 page，
 *    得到 DomProvider / ActionExecutor；
 *  - 连接云端 WS（默认 ws://127.0.0.1:8787），握手上线；
 *  - 小红书与 Facebook 页面命令只交给 Native Page Engine；
 *  - 对支持 browse 的平台，登录完成后创建对应的 EdgeBrowseSession 并 start()：自动浏览 feed、
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
 *  - AIDCP_CDP_PORT        CDP 端口（默认 9222；self 模式用，adspower 端口由 V2 browser-profile/start 动态返回）
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
  createDetachedSession,
  reattachSession,
  browserParkingConfigFromEnv,
  installBrowserParkingStdinControl,
  readCurrentHref,
  selectBrowserProvider,
  waitForLoginIdentity,
  resolveStartupIdentity,
  type BrowserLaunchOptions,
  type ChromeInstance,
  type LaunchedBrowser,
  type ReadSelfIdentityOptions,
  ProxyRuntimeObserver,
  requireActiveProxyEgressMatch,
} from './cdp/index.js';
import { selectPlatformDriver, startupIdentityReadPolicy } from './platform/index.js';
import { runWechatChannelsRuntime } from './wechat-channels/runtime.js';
import { EdgeClient, CloudHandshakeRejectedError } from './client/edge-client.js';
import { automationUiSnapshot, operationDescriptorFor } from './client/operation-registry.js';
import { registerPersonaStdinCommands } from './client/persona-onboarding.js';
import { registerPublishApprovalStdinCommands } from './client/publish-approval-onboarding.js';
import {
  CoreLifecycleController,
  parseCoreLifecycleCommand,
  type CoreLifecycleCommand,
} from './client/core-lifecycle.js';
import { deriveEdgeId } from './client/edge-id.js';
import { EdgeTaskCoordinator } from './execution/edge-task-coordinator.js';
import { CommitWindowGuard, combineCommitWindows } from './execution/commit-window.js';
import { abortForTakeover, TaskTakeoverError, type TakeoverCtx } from './execution/takeover.js';
import { PublishUiEventTracker, uiSnapshotToLines, writeNoteStageLine } from './flows/ui-event-lines.js';
import { imageTempPrefixFor, sweepImageTempDirs } from './flows/image-uploader.js';
import type {
  PublishCommandResultPayload,
  EdgeTaskAcquirePayload,
  EdgeTaskReleasePayload,
  Envelope,
} from './comm/protocol.js';
import type { EdgeBrowseSession } from './browse/edge-browse-session.js';
import type { IdentityDecision, SelfIdentityResult } from './cdp/self-identity.js';
import {
  NativeBrowseSession,
  NativePageRuntime,
  NativePublishExecutor,
  nativeActionNameForCommand,
  readNativeFacebookIdentity,
} from './native-page-engine/index.js';
import {
  applyWakeIdentityResettlement,
  createIdentityReestablishment,
  judgeAutomationResume,
  judgeWakeIdentityResettlement,
  IdentityRevalidator,
  observedAccountIdFromDecision,
  DEFAULT_IDENTITY_CHECK_MS,
  DEFAULT_IDENTITY_FAIL_THRESHOLD,
  DEFAULT_OBSERVATION_INTERVAL_MS,
  PERIODIC_IDENTITY_READ_HYDRATE_MS,
  type IdentityInvalidReason,
} from './native-page-engine/identity-guard.js';
import {
  buildCaptchaClickResultFacts,
  type NativeCaptchaClickReceipt,
} from './captcha/click-result.js';

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
  type CloudRebindRequest = {
    type: 'lifecycle.cloud_rebind';
    requestId: string;
    url: string;
    targetKey: string;
  };
  const pendingCloudRebindRequests: CloudRebindRequest[] = [];
  let dispatchCloudRebind: ((request: CloudRebindRequest) => void) | undefined;
  const parseCloudRebind = (message: unknown): CloudRebindRequest | null => {
    if (!message || typeof message !== 'object') return null;
    const raw = message as Partial<CloudRebindRequest>;
    if (raw.type !== 'lifecycle.cloud_rebind'
        || typeof raw.requestId !== 'string' || !raw.requestId
        || typeof raw.url !== 'string' || !/^wss?:\/\//i.test(raw.url)
        || typeof raw.targetKey !== 'string' || !raw.targetKey) return null;
    return raw as CloudRebindRequest;
  };
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
    const rebind = parseCloudRebind(message);
    if (rebind) {
      if (dispatchCloudRebind) dispatchCloudRebind(rebind);
      else pendingCloudRebindRequests.push(rebind);
      return;
    }
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
  const startBrowserAbsent = process.env.AIDCP_START_BROWSER_ABSENT === '1';
  const startAutomationPaused = process.env.AIDCP_AUTOMATION_PAUSED_AT_START === '1';
  const controlAccountId = process.env.AIDCP_CONTROL_ACCOUNT_ID?.trim() || undefined;
  if (startBrowserAbsent && !controlAccountId) {
    throw new Error('AIDCP_START_BROWSER_ABSENT=1 需要可信 AIDCP_CONTROL_ACCOUNT_ID；拒绝猜测账号');
  }
  let accountId: string | undefined;
  let accountNickname: string | undefined;
  /**
   * 最近一次**从页面上实测**到的账号 id（与握手身份 `accountId` 是两回事：后者可能是
   * `AIDCP_ACCOUNT_ID` 覆盖值）。运行期校验体的基线只能用它——校验体比的是页面读出来的 id，
   * 基线拿覆盖值，在「覆盖值 ≠ 真实登录账号」这个被显式支持的组合下两者永不相等，
   * 于是每 2×节拍就把会话整个拆一遍重建一遍，日志里却只有一句「✓ 身份已重新确立」。
   */
  let observedAccountId: string | undefined;
  const machineLabel = process.env.AIDCP_MACHINE_LABEL;
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
  let chrome: ChromeInstance | undefined;
  let endpoint = { host: cdpHost, port: cdpPort };
  let activeProxyTakeover: LaunchedBrowser['activeProxyTakeover'];
  if (!startBrowserAbsent) {
    const launched = await provider.launch(launchOpts);
    chrome = launched.instance;
    endpoint = launched.endpoint;
    activeProxyTakeover = launched.activeProxyTakeover;
  } else {
    console.log(`[aidcp-edge] 浏览器槽位缺席：以控制面待机态启动（accountId=${controlAccountId}），暂不调用 provider.launch`);
  }

  // 反检测恰一层生效：self 默认开 edge 自研 stealth；adspower 默认关、反检测整层交 AdsPower——
  // 自动化痕迹由 cdp_mask（V2 browser-profile/start 字段，藏 navigator.webdriver 等 CDP 特征）掩盖、
  // 指纹由 profile 的 fingerprint_config（Canvas/WebGL/UA/时区…）生成（edge 再叠一层会不自洽）。
  // AIDCP_STEALTH=on|off 可显式覆盖。
  const stealthEnv = process.env.AIDCP_STEALTH?.toLowerCase();
  const stealth = stealthEnv ? !['off', 'false', '0', 'no'].includes(stealthEnv) : provider.kind !== 'adspower';

  if (!startBrowserAbsent) {
    console.log(`[aidcp-edge] 连接浏览器 CDP ${endpoint.host}:${endpoint.port}（stealth=${stealth ? 'on' : 'off'}）...`);
  }
  const attachOpts: Parameters<typeof attachToPage>[0] = { host: endpoint.host, port: endpoint.port, stealth };
  const observesFacebookProxy = provider.kind === 'adspower' && platformDriver.platform === 'facebook';
  const observesConfiguredProxy = provider.kind === 'adspower'
    && Boolean(process.env.AIDCP_ADS_PROXY_AUTHORITY_FD?.trim());
  const observesProxyRuntime = observesFacebookProxy || observesConfiguredProxy;
  if (observesProxyRuntime) attachOpts.network = true;
  if (pageUrl) attachOpts.urlIncludes = pageUrl;
  else if (provider.kind === 'adspower') {
    attachOpts.urlIncludes = platformDriver.attachUrlIncludes;
    attachOpts.targetPredicate = (target) => platformDriver.isAllowedTargetUrl(target.url);
  }
  const session = startBrowserAbsent ? createDetachedSession() : await attachToPage(attachOpts);
  const proxyRuntime = observesProxyRuntime
    ? new ProxyRuntimeObserver({
        cdp: session.cdp,
        probeUrl: process.env.AIDCP_EGRESS_PROBE_URL ?? '',
        emit: (event) => console.log(`[ui-event] ${JSON.stringify(event)}`),
      })
    : undefined;
  const verifyActiveProxyTakeover = async (
    evidence: LaunchedBrowser['activeProxyTakeover'],
  ): Promise<void> => {
    if (!evidence) return;
    const snapshot = proxyRuntime ? await proxyRuntime.startGeneration() : undefined;
    const matched = requireActiveProxyEgressMatch({
      profileId: evidence.profileId,
      expectedEgressIp: evidence.expectedEgressIp,
      browserEgressIp: snapshot?.browserIp,
    });
    console.log(
      `[aidcp-edge] AdsPower Active profile=${evidence.profileId} 真实出口匹配本次权威代理` +
        `（egress=${matched.browserEgressIp}），接管现有浏览器`,
    );
  };
  if (!startBrowserAbsent) {
    if (activeProxyTakeover) await verifyActiveProxyTakeover(activeProxyTakeover);
    else if (proxyRuntime) void proxyRuntime.startGeneration();
  }
  let parkingControlInstalled = !startBrowserAbsent;
  if (!startBrowserAbsent) console.log('[aidcp-edge] 已附着到 page，CDP 就绪（反检测脚本已注入）');
  // 停放校验失败会抛（bounds 与兜底位都过不了可见性探针）；绝不能因此跳过下面的 stdin 控制通道安装，
  // 否则 control-ready 永不发出、「显示浏览器 / 重置位置」被永久禁用（静默假死）。故此处吞异常、只记日志。
  if (!startBrowserAbsent) {
    try {
      await applyBrowserParking(session.cdp, parkingConfig, (m) => console.log(m));
    } catch (e) {
      console.log(`[browser-parking] apply failed at startup: ${(e as Error).message}`);
    }
    installBrowserParkingStdinControl(session.cdp, parkingConfig, (m) => console.log(m));
  }
  // Runtime/Page/Input 域启用 + 反检测注入均在 attachToPage 内（reEnableAndInject，与断线重连共用）。

  // 浏览器平台的页面理解与执行统一由 Native Page Engine 持有。运行时在身份首读前建立，
  // 因为 Facebook 身份本身也是页面/登录态派生能力，不能再穿过 TypeScript CDP 边界。
  const nativePageRuntime = NativePageRuntime.fromEnvironment(
    () => ({ host: endpoint.host, port: endpoint.port }),
    platformDriver.platform,
  );
  const readPlatformIdentity = (options: ReadSelfIdentityOptions): Promise<SelfIdentityResult> => (
    platformDriver.platform === 'facebook'
      ? readNativeFacebookIdentity(nativePageRuntime, options)
      : platformDriver.readIdentity(session.cdp, options)
  );

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
  if (startBrowserAbsent) {
    accountId = controlAccountId;
    console.log(`[aidcp-edge] 控制面账号身份已确立: ${accountId} [source=cloud-bound-bootstrap; browser=absent]`);
  } else {
    // Facebook AdsPower 可能刚附着在 about:blank：首读显式允许一次消费端首页 bootstrap，再有界等本人锚点；
    // XHS AdsPower 仍保持登录页纯就地读，绝不新增误导航。运行期复读另行显式 allowNavigate=false。
    const firstReadOpts: ReadSelfIdentityOptions = {
      ...startupIdentityReadPolicy(platformDriver.platform, provider.kind),
      logger: (m) => console.log(m),
    };
    const idRes = await readPlatformIdentity(firstReadOpts);
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
          readIdentity: () =>
            readPlatformIdentity({ allowNavigate: false, hydrateTimeoutMs: 1_000, logger: () => undefined }),
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
      // 实测值单独记一份：它才是运行期校验体的基线口径（覆盖值不是）。读不出实测值时留空，
      // 绝不用覆盖值冒充「实测到的」。
      observedAccountId = observedAccountIdFromDecision(resolved);
      // 昵称仅从本次首读且与最终数字 id 一致的已验证结果取；等待路径 idRes 仍是首读失败结果，自然不携昵称。
      accountNickname = verifiedAccountNickname(idRes, resolved);
      const display = accountNickname ? ` (${accountNickname})` : '';
      const source = 'source' in resolved ? resolved.source : 'env-override';
      console.log(`[aidcp-edge] 账号身份已确立: ${accountId}${display} [source=${source}]`);
    }
  }

  const client = new EdgeClient({
    url: cloudUrl,
    edgeId,
    platform: platformDriver.platform,
    app: platformDriver.app,
    capabilities: [
      ...platformDriver.edgeCapabilities,
      ...(startBrowserAbsent ? ['browser_absent_v1'] : []),
    ],
    ...(accountId ? { accountId } : {}),
    ...(accountNickname ? { accountNickname } : {}),
    ...(machineLabel ? { machineLabel } : {}),
    runner: {
      run: async (step) => ({
        actionId: step.actionId,
        ok: false,
        outcome: 'escalated',
        attempts: 0,
        reason: 'platform_plan_handler_unavailable',
      }),
    },
  });
  const pendingPageCommands: Envelope[] = [];
  let pageCommandHandler: ((env: Envelope) => void) | undefined;
  const dispatchOrQueuePageCommand = (env: Envelope): void => {
    if (pageCommandHandler) {
      pageCommandHandler(env);
      return;
    }
    if (pendingPageCommands.length >= 100) {
      client.reportActionCompleted({ action: env.type, ok: false, reason: 'page_executor_startup_queue_full' });
      return;
    }
    pendingPageCommands.push(env);
  };
  const installPageCommandHandler = (handler: (env: Envelope) => void): void => {
    pageCommandHandler = handler;
    for (const env of pendingPageCommands.splice(0)) handler(env);
  };
  client.onBrowseCommand(dispatchOrQueuePageCommand);
  if (platformDriver.platform === 'xiaohongshu') client.onPlanCommand(dispatchOrQueuePageCommand);
  const browserStartupId = `${edgeId}:${process.pid}:${Date.now().toString(36)}`;

  // 建号自助人设 stdin 桥（change edge-persona-keyword-generation）：身份已确立、client 就绪后装上，
  // 桌面壳经 stdin 下发 persona.generate/persist → 打到云端 → stdout [persona-reply] 回桥。
  registerPersonaStdinCommands(client, (m) => console.log(m));
  registerPublishApprovalStdinCommands(client, (m) => console.log(m));

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
  // 平台无关的命令会话句柄（EdgeBrowseSession 契约）。小红书与 Facebook 现在都由 Native 浏览会话承接；
  // 迁前那条按平台分叉到 JavaScript Facebook 会话的装配已随恒假块一并删除，别按旧注释去找它。
  let browse: EdgeBrowseSession | undefined;
  // 同一个会话对象的 Native 具体类型句柄。`EdgeBrowseSession` 契约里没有周期观测的三个方法
  // （suspendObservation / resumeObservation / observationStatus），而生命周期托管与身份校验都要用它们。
  // 在装配处一并赋上，避免为此去动平台无关的 `EdgeBrowseSession` 契约。
  let nativeBrowse: NativeBrowseSession | undefined;
  // 运行期身份持续校验体（§5）。装配在自动浏览会话之后；无浏览器 / 启动即暂停时「装配但不启动」。
  let identityGuard: IdentityRevalidator | undefined;
  // 启动校验体（含失效回调 → 身份重立链）。回调闭包要捕获浏览会话，故在装配处赋值。
  let startIdentityGuard: (() => void) | undefined;
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
  let requestShutdown: ((reason: string) => void) | undefined;
  let coldStandbyActive = startBrowserAbsent;
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
  /**
   * 浏览器缺席时，云端直达页面命令不能被静默吞掉。
   *
   * 正常独占任务会先 acquire，待浏览器真实唤醒后再下发页面命令；这里兜住乱序、旧云端或自动浏览
   * 直达命令。请求外壳唤醒的同时回明确失败，让调用方在 woken 后决定是否重试。pacing.update 不触碰
   * 页面，直接应用到待机会话，不占浏览器槽位。
   */
  const handleBrowserAbsentCommand = (env: Envelope): boolean => {
    if (!coldStandbyActive) return false;
    const operation = operationDescriptorFor(env.type);
    if (!operation) {
      console.warn(`[aidcp-edge] operation_unclassified type=${env.type}; rejected without browser wake`);
      return true;
    }
    if (operation.browser === 'forbidden') {
      if (env.type !== 'pacing.update') return false;
      const payload = (env.payload ?? {}) as {
        opFloorsMs?: Parameters<EdgeBrowseSession['applyPacingSnapshot']>[0];
        tempo?: number;
      };
      browse?.applyPacingSnapshot(payload.opFloorsMs, payload.tempo);
      return true;
    }
    requestColdStandbyWake(`cloud_command:${env.type}`);
    const action = nativeActionNameForCommand(env.type);
    console.warn(`[aidcp-edge] 浏览器尚未启动，命令 ${env.type} 回执 ${action}:browser_absent_wake_requested`);
    client.reportActionCompleted({ action, ok: false, reason: 'browser_absent_wake_requested' });
    return true;
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
    // 任务与发布写者都已收敛、浏览恢复到安全边界后，只通知 Electron 重新应用最新待机提示。
    // 是否真关浏览器仍由外壳 + 核心既有安全闸共同决定，绝不在此直接关闭。
    onIdle: () => sendLifecycleIpc({ type: 'lifecycle.task_idle' }),
    logger: (message) => console.log(message),
  });
  session.cdp.on('cdp.control_recovered', () => taskCoordinator.resumeAfterControlRecovery());

  /**
   * 被任务租约抑制的命令必须**回执**，不得只打日志就 return（change
   * restore-facebook-post-join-comment-continuity；前置登记见 facebook-first-post-comment-confirmation 5.6）。
   *
   * 真机实例：一条 page.scroll 与其所属任务的 release 在同一毫秒到达，命令被丢弃、云端毫无信号，
   * 只能等满自己的步超时。这正是本项目禁止的「静默丢弃」形状——云端分不清「命令没触达页面」
   * 与「命令执行了但页面没结果」。回执沿用 browser_absent 那条既有形状：成功位为假 + 具名原因。
   */
  const reportLeaseSuppressed = (env: Envelope, ownedTaskId: string | undefined, lane: string): void => {
    const action = nativeActionNameForCommand(env.type);
    console.warn(
      `[aidcp-edge] ${lane} 命令被任务租约抑制 type=${env.type} taskId=${ownedTaskId ?? '-'} current=${taskCoordinator.currentTaskId ?? '-'} 回执 ${action}:task_lease_suppressed`,
    );
    client.reportActionCompleted({ action, ok: false, reason: 'task_lease_suppressed' });
  };

  // 发布原子与浏览命令复用同一个 Native 会话串行边界；切换 owner 时旧会话先有界关闭。
  const nativePublishExecutor = new NativePublishExecutor(
    nativePageRuntime,
    imageTempPrefix,
    publishGuard,
  );

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

  // Cloud 切换只重绑控制传输。先等页面租约/提交窗口归零并把浏览循环收敛到安全边界；
  // 浏览器、CDP、provider 与槽位所有权全程不动。失败时浏览器保持原开/关态并停在安全边界。
  let cloudRebindChain = Promise.resolve();
  dispatchCloudRebind = (request) => {
    cloudRebindChain = cloudRebindChain.then(async () => {
      const sendResult = (payload: Record<string, unknown>): void => sendLifecycleIpc({
        requestId: request.requestId,
        targetKey: request.targetKey,
        ...payload,
      });
      let quiesced = false;
      try {
        const deadline = Date.now() + 30_000;
        while ((taskCoordinator.hasActiveLease() || inFlightPublishes.size > 0) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (taskCoordinator.hasActiveLease() || inFlightPublishes.size > 0) {
          throw new Error('page_work_drain_timeout');
        }
        browse?.discardQueuedCloudCommands('cloud_rebind');
        if (browse && !coldStandbyActive) {
          await browse.quiesceForTask();
          quiesced = true;
        }
        await client.rebind(request.url);
        if (quiesced) await browse?.resumeAfterTask();
        sendResult({ type: 'lifecycle.cloud_rebound', ok: true, browserAbsent: coldStandbyActive });
      } catch (error) {
        const reason = (error as Error)?.message || String(error);
        sendResult({ type: 'lifecycle.cloud_rebind_failed', ok: false, reason, browserAbsent: coldStandbyActive });
      }
    });
  };
  for (const request of pendingCloudRebindRequests.splice(0)) dispatchCloudRebind(request);

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
        const publishPlatform = env.payload.platform ?? 'xiaohongshu';
        if (publishPlatform === platformDriver.platform) {
          result = await nativePublishExecutor.dispatch(env.payload, takeoverCtx.signal);
        } else {
          result = {
            recordId: env.payload.recordId,
            seq: env.payload.seq,
            kind: env.payload.kind,
            ok: false,
            error: 'platform_publish_executor_unavailable',
          };
        }
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

  // ui.snapshot 在新能力下只承载自动化运行投影。旧 Cloud 可能仍夹带 persona/publish/account 数据，
  // 必须在引擎边界丢弃；客户端的数据管理真态由 Electron main 通过 customer-auth HTTP 主动拉取。
  client.onUiSnapshot((env) => {
    for (const uiLine of uiSnapshotToLines(automationUiSnapshot(env.payload))) console.log(uiLine);
  });

  const nativeCaptchaLive = new Map<string, symbol>();
  const clampCaptchaHint = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.max(min, Math.min(max, Math.round(parsed)));
  };
  const captureNativeCaptcha = async (
    ownerId: string,
    incidentId: string,
    payload: Record<string, unknown>,
    previousSnapshotId?: string,
  ): Promise<{ snapshotId: string; jpegBase64: string }> => {
    const execution = await nativePageRuntime!.execute(ownerId, {
      kind: 'captcha_capture',
      params: {
        incidentId,
        ...(typeof payload.maxImageWidth === 'number' ? { maxImageWidth: payload.maxImageWidth } : {}),
        ...(typeof payload.maxImageHeight === 'number' ? { maxImageHeight: payload.maxImageHeight } : {}),
        ...(typeof payload.quality === 'number' ? { quality: payload.quality } : {}),
      },
    });
    if (execution.output?.kind !== 'captcha_snapshot') throw new Error('native captcha snapshot result mismatch');
    const snapshot = execution.output.value as {
      incidentId: string; snapshotId: string; width: number; height: number; jpegBase64: string;
    };
    if (snapshot.snapshotId !== previousSnapshotId) {
      client.send('captcha.assist.snapshot', {
        incidentId: snapshot.incidentId,
        edgeId,
        ...(accountId ? { accountId } : {}),
        snapshotId: snapshot.snapshotId,
        capturedAt: Date.now(),
        kind: 'captcha',
        viewport: { width: snapshot.width, height: snapshot.height },
        crop: { x: 0, y: 0, width: snapshot.width, height: snapshot.height },
        image: { mime: 'image/jpeg', data: snapshot.jpegBase64, width: snapshot.width, height: snapshot.height },
      });
    }
    return { snapshotId: snapshot.snapshotId, jpegBase64: snapshot.jpegBase64 };
  };
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
      nativeCaptchaLive.delete(clickPayload.incidentId);
    }
    const payload = env.payload as unknown as Record<string, unknown>;
    const incidentId = String(payload.incidentId ?? '');
    const ownerId = `captcha:${incidentId}`;
    void (async () => {
      if (env.type === 'captcha.assist.capture') {
        nativeCaptchaLive.delete(incidentId);
        const first = await captureNativeCaptcha(ownerId, incidentId, payload);
        const live = payload.live && typeof payload.live === 'object' ? payload.live as Record<string, unknown> : undefined;
        if (live) {
          const token = Symbol(incidentId);
          nativeCaptchaLive.set(incidentId, token);
          const intervalMs = clampCaptchaHint(live.intervalMs, 1_000, 600, 2_000);
          const maxDurationMs = clampCaptchaHint(live.maxDurationMs, 30_000, 3_000, 60_000);
          const maxFrames = clampCaptchaHint(live.maxFrames, Math.ceil(maxDurationMs / intervalMs), 1, 50);
          void (async () => {
            const startedAt = Date.now();
            let lastSnapshotId = first.snapshotId;
            for (let index = 1; index < maxFrames && Date.now() - startedAt < maxDurationMs; index += 1) {
              await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
              if (nativeCaptchaLive.get(incidentId) !== token) return;
              try {
                const next = await captureNativeCaptcha(ownerId, incidentId, { ...payload, quality: 35 }, lastSnapshotId);
                if (next.snapshotId === lastSnapshotId) continue;
                lastSnapshotId = next.snapshotId;
              } catch (error) {
                console.warn(`[aidcp-edge] Native 验证码实时抓帧失败 incident=${incidentId}:`, error);
              }
            }
            if (nativeCaptchaLive.get(incidentId) === token) nativeCaptchaLive.delete(incidentId);
          })();
        }
        return;
      }
      const execution = await nativePageRuntime.execute(ownerId, {
        kind: 'captcha_click',
        params: {
          incidentId,
          snapshotId: String(payload.snapshotId ?? ''),
          points: Array.isArray(payload.points) ? payload.points : [],
          ...(typeof payload.settleMs === 'number' ? { settleMs: payload.settleMs } : {}),
          ...(typeof payload.text === 'string' ? { text: payload.text } : {}),
          ...(payload.submit === 'enter' ? { submit: 'enter' } : {}),
        },
      });
      const receipt = execution.output?.kind === 'action_receipt'
        ? execution.output.value as NativeCaptchaClickReceipt
        : undefined;
      client.send('captcha.assist.click_result', {
        incidentId,
        snapshotId: String(payload.snapshotId ?? ''),
        edgeId,
        ...(accountId ? { accountId } : {}),
        ...buildCaptchaClickResultFacts(payload, receipt),
        checkedAt: Date.now(),
      });
    })().catch((err) => {
      console.error(`[aidcp-edge] Native 验证码协助 ${env.type} 失败:`, err);
      if (env.type === 'captcha.assist.click') {
        client.send('captcha.assist.click_result', {
          incidentId,
          snapshotId: String(payload.snapshotId ?? ''),
          edgeId,
          ...(accountId ? { accountId } : {}),
          status: 'failed',
          reason: err instanceof Error ? err.message : String(err),
          checkedAt: Date.now(),
        });
      }
    });
  });

  // 处理器全部就位后才握手（见上方红线注释：hello 快照紧随 welcome，注册晚一步就漏帧）。
  await client.connect();
  console.log(`[aidcp-edge] 已连接云端 ${cloudUrl}，等待命令 ...`);

  // —— 自动浏览会话 ——
  const wantsAutoBrowse = process.env.AIDCP_AUTO_BROWSE !== 'false';
  const supportsBrowse = platformDriver.capabilities.includes('browse');
  const autoBrowse = wantsAutoBrowse && supportsBrowse;
  if (wantsAutoBrowse && !supportsBrowse) {
    console.warn(`[aidcp-edge] platform=${platformDriver.platform} does not support browse; NativeBrowseSession will not start.`);
  }
  if (autoBrowse) {
    const nativeSession = new NativeBrowseSession({
      runtime: nativePageRuntime,
      client,
      startupId: browserStartupId,
      platform: platformDriver.platform === 'facebook' ? 'facebook' : 'xiaohongshu',
      edgeId,
      getAccountId: () => accountId,
      logger: (message) => console.log(message),
      commitWindow: browseGuard,
    });
    browse = nativeSession;
    nativeBrowse = nativeSession;
    const routeNativeCommand = (env: Envelope): void => {
      if (handleBrowserAbsentCommand(env)) return;
      const taskId = (env.payload as { taskId?: unknown } | undefined)?.taskId;
      const ownedTaskId = typeof taskId === 'string' ? taskId : undefined;
      if (env.type !== 'pacing.update' && !taskCoordinator.canExecute(ownedTaskId)) {
        reportLeaseSuppressed(env, ownedTaskId, 'Native');
        return;
      }
      if (ownedTaskId) taskCoordinator.touch(ownedTaskId);
      nativeSession.onCloudCommand(env).catch((err) => {
        console.error(`[aidcp-edge] 执行 Native 命令 ${env.type} 失败:`, err);
      });
    };
    installPageCommandHandler(routeNativeCommand);
    if (taskCoordinator.blocksBrowse) {
      await browse.quiesceForTask().catch((err) => {
        console.warn(`[aidcp-edge] 注册 Native 会话时交接未收敛：${(err as Error).message}`);
      });
    }
    if (!coldStandbyActive && !startAutomationPaused) {
      browse.start().catch((err) => console.error('[aidcp-edge] Native 浏览会话异常:', err));
    }
    console.log(`[aidcp-edge] ${platformDriver.platform} 页面执行已切换为 Native-only（无 shadow、无 JavaScript fallback）`);

    // —— 运行期身份持续校验 + 身份重立链（§5）——
    // 身份是持续校验的状态，不是握手时定死一次：只在启动与冷待机唤醒各读一次，长跑会话中途换号 /
    // 掉登录一秒都发现不了，之后全部记账挂在错账号上。判定表与重立链在 native-page-engine/identity-guard.ts
    // （纯注入、可单测），这里只做薄接线。
    const identityCheckMs = (() => {
      const n = Number(process.env.AIDCP_IDENTITY_CHECK_MS ?? DEFAULT_IDENTITY_CHECK_MS);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDENTITY_CHECK_MS;
    })();
    const identityFailThreshold = (() => {
      const n = Number(process.env.AIDCP_IDENTITY_FAIL_THRESHOLD ?? DEFAULT_IDENTITY_FAIL_THRESHOLD);
      return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_IDENTITY_FAIL_THRESHOLD;
    })();
    // 正向登出探针读数的陈旧预算按周期观测的**实配**节拍推导。这里与 NativeBrowseSession 读同一个 env
    // （它的节拍事实源在会话内、未公开），两处默认值一致；改一处务必对齐另一处。
    const observationIntervalMs = (() => {
      const n = Number(process.env.AIDCP_NATIVE_OBSERVATION_MS ?? DEFAULT_OBSERVATION_INTERVAL_MS);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_OBSERVATION_INTERVAL_MS;
    })();
    // 身份读取一律 allowNavigate:false —— 只读、不导航，绝不每轮把页面拽走（红线）。
    // 平台分叉已在装配层由 `readPlatformIdentity` 做掉（Facebook 走 Native cookie 派生、其它走 TS CDP
    // 就地扫描，两条都不导航），校验体与重立链只消费它，自己不认平台。
    //
    // **水合预算由调用方给，两个调用方要的东西完全不同**：周期校验读不出就跳过（30s 后还有下一拍），
    // 给小预算；重立链的「归位后重读」跟在一次整页重载后面，必须给足（判据与常量都在 identity-guard.ts）。
    // 早先两处共用一个写死 1s 的闭包，于是换号场景必然在 1s 内读不出 → 判 halt → 一个只是换了个号的
    // 健康节点被永久停在无身份态（把「页面还没渲染完」判成终局失败）。
    const readIdentityInPlace = (options: ReadSelfIdentityOptions = {}): Promise<SelfIdentityResult> =>
      readPlatformIdentity({ ...options, allowNavigate: false });
    identityGuard = new IdentityRevalidator(observedAccountId ?? accountId ?? '', {
      intervalMs: identityCheckMs,
      threshold: identityFailThreshold,
      observationIntervalMs,
      logger: (message) => console.log(message),
      // 分域判据按平台走（driver 上的纯函数）：小红书分消费端 / 创作子域 / 创作登录页，Facebook 域内
      // 一律可读。写死成小红书判据会让 FB 侧每拍「跳过」、永远读不到身份——装了但永久空转。
      readPageContext: async () => platformDriver.classifyIdentityContext(await readCurrentHref(session.cdp)),
      readIdentity: () => readIdentityInPlace({
        hydrateTimeoutMs: PERIODIC_IDENTITY_READ_HYDRATE_MS,
        logger: () => undefined,
      }),
      // 正向登出探针取周期阻断观测的读数（sticky 缓存）。陈旧 / 暂停 / 从未成功探测过一律判「无法确认」
      // 并跳过——绝不压成「真登出」（「读不到」与「没有」是两态）。判据在 identity-guard.probeLogout()。
      observationStatus: () => nativeSession.observationStatus(),
    });
    const consumerHomeUrl = process.env.AIDCP_EXPLORE_URL ?? platformDriver.defaultStartUrl;
    const reestablishIdentity = createIdentityReestablishment({
      logger: (message) => console.log(message),
      suspendObservation: (reason) => nativeSession.suspendObservation(reason),
      stopBrowse: async () => {
        reportBrowseDrainTimeout(await nativeSession.stopAndWait(BROWSE_DRAIN_MS), 'identity_flip');
      },
      failInFlightPublishesHonestly,
      hasActiveLease: () => taskCoordinator.hasActiveLease(),
      resetTaskCoordinator: (reason) => taskCoordinator.reset(reason),
      disconnectCloud: async () => {
        // 断连失败不中断重立（下面的 connect() 会重建连接），但**绝不静默吞掉**：
        // 关连接抛异常意味着底层 ws 状态可疑，后面那次重连若也出问题，这一行是唯一的线索。
        await client.closeAndWait(1500).catch((error: unknown) => {
          console.warn(
            `[identity-guard] 断开云端连接时报错（照常继续重立，随后会按新身份重连）：${error instanceof Error ? error.message : String(error)}`,
          );
        });
      },
      navigateToConsumerHome: () => session.cdp.send('Page.navigate', { url: consumerHomeUrl }).then(() => undefined),
      // 读取选项由链条给（足量水合预算），宿主原样转发、只补一条日志——绝不在这里替它决定预算。
      readIdentity: (options) => readIdentityInPlace({ ...options, logger: (m) => console.log(m) }),
      decideIdentity: (res) => platformDriver.decideIdentity(res, overrideAccountId),
      nicknameFor: verifiedAccountNickname,
      applyIdentity: (nextAccountId, nickname) => {
        accountId = nextAccountId;
        // 校验体的基线口径 = 页面上读出来的 id。重立链交上来的就是实测值，两处必须同步前进。
        observedAccountId = nextAccountId;
        accountNickname = nickname;
        client.setAccountIdentity(accountId, accountNickname);
      },
      generation: () => identityGuard?.generation ?? 0,
      reportHalt: (reason) => {
        // 让外壳看得见这个终局：halt 之后浏览停了、观测停了、云端连接被 intentionalClose 关掉
        // （既不自动重连、也不 emit 断连事件）。不发这条 IPC，桌面客户端左栏会一直显示「运行中 /
        // 已连接云端」，运营看不到任何角标——那正是静默假成功的产品层形态。
        sendLifecycleIpc({ type: 'lifecycle.identity_halted', reason });
      },
      reportIdentityRestored: (restoredAccountId) => {
        // 与上面的 halt 通告成对：外壳收到 halt 之后会把红角标**闩住**（此后任何一行普通日志都不许
        // 把徽标翻回运行中），闩住的代价是它只能被显式解除。不发这条，一次真正的身份重立之后核心
        // 已经健康、浏览也跑起来了，左栏却仍挂着不可撤销的红「运行期身份确立失败」。
        sendLifecycleIpc({ type: 'lifecycle.identity_restored', accountId: restoredAccountId });
      },
      connectCloud: () => client.connect(),
      rebaseline: (nextAccountId) => identityGuard?.rebaseline(nextAccountId),
      resumeObservation: () => nativeSession.resumeObservation(),
      startBrowse: () => {
        nativeSession.start().catch((err) => console.error('[aidcp-edge] 身份重立后浏览会话异常:', err));
      },
    });
    startIdentityGuard = (): void => {
      if (!accountId) return; // 无身份态不启动校验体：没有基线可比，跑起来只会每拍打日志。
      identityGuard?.start((reason: IdentityInvalidReason) => {
        // 链条回执 MUST 回喂校验体：判失效之后校验体停在「重立中」抑制判定，而这条回执是它唯一的出口。
        // 少喂一次，暂停→恢复之后运行期身份校验就永久哑火（装了但永久不工作），换号再也测不出来。
        void reestablishIdentity(reason)
          .then((outcome) => identityGuard?.noteReestablishmentOutcome(outcome))
          .catch((err) => {
            // 链条已自带兜底（返回 crashed），能走到这里说明连兜底本身都抛了。状态机照样必须收口。
            console.error('[aidcp-edge] 身份重立链异常（自动化保持停止，等待人工介入）:', err);
            identityGuard?.noteReestablishmentOutcome({
              kind: 'crashed',
              reason: err instanceof Error ? err.message : String(err),
            });
          });
      });
    };
    if (!coldStandbyActive && !startAutomationPaused) startIdentityGuard();
  }
  // —— 退出 / 回收统一路径（节点终态诚实下线 + 看护可重起；真关机干净退出）——
  let recycleRequested = false;
  const lifecycle = new CoreLifecycleController({
    pauseAutomation: async () => {
      console.log('\n[aidcp-edge] 正在暂停自动化：客户端核心、Cloud 连接与浏览器资源保持不变...');
      failInFlightPublishesHonestly('user_pause');
      taskCoordinator.reset('user_pause');
      // 身份校验体随自动化一起停：暂停期若判失效，重立链会把浏览重新拉起来 —— 那是对「暂停」的违背。
      // stop() 同时递增代际，把**已经在途**的一次校验与一条重立链一起作废（只清定时器拦不住它们：
      // 一条没拦住的在途链条会在暂停期间关掉云端连接、几秒后又把浏览拉起来）。
      identityGuard?.stop();
      reportBrowseDrainTimeout((await browse?.stopAndWait(BROWSE_DRAIN_MS)) ?? true, 'user_pause');
    },
    resumeAutomation: async () => {
      if (coldStandbyActive) throw new Error('browser_absent_use_wake');
      // 身份准入：恢复自动化不带来任何新的身份事实（判据与理由在 identity-guard.ts）。停在无身份终局
      // 时放行，就是把冷待机那条路上的同一个洞换个入口再挖一遍——浏览重新跑起来、云端始终没连上、
      // 判定首行永久早退。如实拒绝（与上面「浏览器缺席请走唤醒」同口径：抛出 = 保持暂停态）。
      const resumeVerdict = judgeAutomationResume(identityGuard?.health ?? 'healthy');
      if (resumeVerdict.kind === 'refuse') {
        console.error(`[aidcp-edge] ✗ 拒绝恢复自动化：${resumeVerdict.reason}`);
        throw new Error('identity_halted_relogin_required');
      }
      // 周期观测的恢复责任在这里（幂等：没停过就是空操作）。暂停期间可能有一条在途的身份重立链被
      // 叫停在「已暂停观测」的位置——链条**故意不**自己恢复（叫停的另两条路径马上就要关浏览器，
      // 那时恢复观测＝对着已 detach 的 CDP 空轮询到唤醒）。不在这里补，浏览会重开但观测永远起不来
      // （会话侧 scheduleProbe 见 suspended 直接早退）：阻断观测从此全盲，且没有任何人会发现。
      nativeBrowse?.resumeObservation();
      browse?.start().catch((error) => {
        console.error('[aidcp-edge] 恢复自动化失败:', error);
      });
      startIdentityGuard?.();
    },
    deactivate: async (reason) => {
      coldStandbyActive = false;
      clearColdStandbyCloudRetry();
      console.log(`\n[aidcp-edge] 自动运营停用流程启动（reason=${reason}）...`);
      identityGuard?.stop();
      // 暂停/关闭/回收都先诚实终止在途发布，绝不让半截命令跨恢复重放。
      failInFlightPublishesHonestly(reason);
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
      await nativePageRuntime?.shutdown().catch((error) => {
        console.warn('[aidcp-edge] Native Page Engine 关闭失败:', error);
      });
      session.close();
    },
    closeOwnedBrowser: async () => {
      // 仅最终关闭才到这里；pause/resume-preserve 明确绕过。复用模式绝不回收外部浏览器。
      if (!chrome) return true;
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
      if (!chrome) return true;
      if (chrome.reused) {
        console.log('[aidcp-edge] 复用模式：不回收本进程不拥有的外部 Chrome，拒绝进入冷待机');
        return false;
      }
      coldStandbyActive = true;
      clearColdStandbyWakeLatch();
      failInFlightPublishesHonestly('cold_standby');
      // 身份校验体随待机停手：浏览器马上就要被关掉，再读页面只会每拍打一行「无法判定」。
      identityGuard?.stop();
      // 关浏览器前必须等浏览循环真正退出原子区（红线）：stop() 只是请求停止，循环可能正卡在首屏扫描 /
      // 停留等待里，醒来后照样摸页面——那时浏览器已被下面 killAndConfirmDead() 杀掉，调用直接打在死 CDP 上。
      // 用 stopAndWait（非 closeAndWait）：待机是**可回来的**，close() 的 closing 是终态、唤醒后就再也起不来了。
      reportBrowseDrainTimeout((await browse?.stopAndWait(BROWSE_DRAIN_MS)) ?? true, 'cold_standby');
      // 周期阻断观测必须显式**置暂停**，不能只靠 stopAndWait 的停表：一个在途的探针跑完后会在
      // `.finally` 里重新武装定时器（会话侧的 scheduleProbe 不查「已请求停止」），于是待机期探针会
      // 对着已 detach 的 CDP 一路空轮询。suspendObservation 幂等，唤醒时由 resumeObservation 对称恢复。
      nativeBrowse?.suspendObservation('cold_standby');
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
        proxyRuntime?.suspendGeneration('browser_standby');
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
    wakeFromStandby: async (resumeAutomation) => {
      console.log('\n[aidcp-edge] 唤醒：重开浏览器 + 原地重建浏览器层（核心进程与云端连接不动）...');
      try {
        // 1) 重开浏览器。新一代 = 新的调试端口，整体换掉 chrome / endpoint / attachOpts。
        const relaunched = await provider.launch(launchOpts);
        chrome = relaunched.instance;
        endpoint = relaunched.endpoint;
        activeProxyTakeover = relaunched.activeProxyTakeover;
        attachOpts.host = endpoint.host;
        attachOpts.port = endpoint.port;

        // 2) 把既有的会话对象重新附着上去（保住 CdpClient 身份 → 十几个持有者与订阅者全程无感）。
        //    重连配置在这里被重新构造，classify/rediscover 闭包里的端口随之更新——不换它，唤醒后第一次
        //    瞬断就会拿旧端口探活、探不到即误判「进程已死 = 终局」，把可续跑的连接直接判死。
        await reattachSession(session, attachOpts);
        if (activeProxyTakeover) await verifyActiveProxyTakeover(activeProxyTakeover);
        else void proxyRuntime?.startGeneration();

        // 3) 停放（最小化 / 移出视野）要重新施加：新浏览器窗口不继承上一代的位置。
        try {
          await applyBrowserParking(session.cdp, parkingConfig, (m) => console.log(m));
        } catch (e) {
          console.log(`[browser-parking] apply failed after wake: ${(e as Error).message}`);
        }
        if (!parkingControlInstalled) {
          installBrowserParkingStdinControl(session.cdp, parkingConfig, (m) => console.log(m));
          parkingControlInstalled = true;
        }

        // 4) 重新确认登录态与身份（红线：新一代浏览器，绝不假设还登着）。
        const idRes = await readPlatformIdentity({
          ...startupIdentityReadPolicy(platformDriver.platform, provider.kind),
          logger: (m) => console.log(m),
        });
        const decision = platformDriver.decideIdentity(idRes, overrideAccountId);
        if (decision.kind === 'halt') {
          console.error(
            `[aidcp-edge] ✗ 唤醒后身份确认失败（${decision.reason}）：浏览器起来了但读不出登录身份。` +
              '如实判唤醒失败、留在待机态（可再次唤醒），绝不以默认账号开跑。',
          );
          // 这条路径要把浏览器杀回槽位，在途发布必然跟着死。与下面「账号已变」分支同口径：先诚实回执，
          // 否则审批 / 通知侧永远等不到结果（云端无限期挂起等一个再也不会来的回执）。
          failInFlightPublishesHonestly('browser_wake_identity_failed');
          session.detach();
          proxyRuntime?.suspendGeneration('wake_identity_failed');
          await chrome?.killAndConfirmDead().catch(() => undefined);
          return false;
        }
        // 唤醒后的身份收口判据（纯函数，判据与用例都在 identity-guard.ts）：这一代浏览器里实测到 id
        // 了吗、上一局是不是正停在无身份终局上。副作用在下面统一施加，绝不在这里边判边做。
        const resettlement = judgeWakeIdentityResettlement(decision, identityGuard?.health ?? 'healthy');
        if (resettlement.kind === 'wake_rejected') {
          // 上一局停在无身份终局，而这次唤醒没能实测出身份（只有 AIDCP_ACCOUNT_ID 覆盖值顶着）。
          // 放它回来 = 浏览跑着、外壳显示运行中，而身份校验是死的、云端是断的。如实判唤醒失败，
          // 与上面「唤醒后身份确认失败」同口径（留在待机态、可再次唤醒）。
          console.error(`[aidcp-edge] ✗ ${resettlement.reason}：上一局停在无身份终局，本次唤醒未能解除它，如实判唤醒失败。`);
          failInFlightPublishesHonestly('browser_wake_identity_unmeasured');
          session.detach();
          proxyRuntime?.suspendGeneration('wake_identity_unmeasured');
          await chrome?.killAndConfirmDead().catch(() => undefined);
          return false;
        }
        // 新一代浏览器里刚实测到的 id（读不出实测值则不覆盖旧值）。
        observedAccountId = observedAccountIdFromDecision(decision) ?? observedAccountId;
        if (decision.accountId !== accountId) {
          // 控制面引导是“上一次握手”的持久事实，允许陈旧；但绝不允许它覆盖新浏览器里的真实账号。
          // 在任何页面动作恢复前，先以刚读出的真实身份换 Cloud 会话并拿到严格 welcome。
          console.warn(`[aidcp-edge] 唤醒后发现账号已变（${accountId} → ${decision.accountId}），先重建 Cloud 会话再恢复浏览器动作`);
          failInFlightPublishesHonestly('browser_wake_identity_changed');
          await client.closeAndWait(1500).catch(() => undefined);
          accountId = decision.accountId;
          accountNickname = verifiedAccountNickname(idRes, decision);
          client.setAccountIdentity(accountId, accountNickname);
          await client.connect();
          console.log(`[aidcp-edge] 唤醒身份已按真实账号 ${accountId} 重建 Cloud 会话`);
        }

        // 5) 恢复自动化：监测体重挂、浏览循环重开（注意顺序——先出待机态，否则循环起手就被待机守卫挡回）。
        coldStandbyActive = false;
        clearColdStandbyWakeLatch();
        clearColdStandbyCloudRetry();
        const wakePacing = client.getPacing();
        browse?.applyPacingSnapshot(wakePacing?.opFloorsMs, wakePacing?.tempo);
        // 与 enterStandby 的 suspendObservation('cold_standby') 对称：整批重启周期观测（幂等）。
        nativeBrowse?.resumeObservation();
        // 身份侧的收口（重设基线 / 补回云端 / 通告外壳）与「要不要恢复自动化」**无关**：外壳完全可以
        // 把一个暂停中的节点唤醒，那时身份照样重新确认过了。把它们关进恢复自动化那个分支，就是给
        // 「暂停中被唤醒」这条真实路径留一个永久失效态（判据、理由与用例都在 identity-guard.ts）。
        await applyWakeIdentityResettlement(resettlement, resumeAutomation, {
          logger: (message) => console.log(message),
          rebaseline: (nextBaseline) => identityGuard?.rebaseline(nextBaseline),
          cloudLinkAttached: () => client.isConnected(),
          restoreCloudLink: () => client.connect(),
          reportIdentityRestored: (restoredAccountId) => {
            sendLifecycleIpc({ type: 'lifecycle.identity_restored', accountId: restoredAccountId });
          },
          startBrowse: () => {
            browse?.start().catch((err) => console.error('[aidcp-edge] 唤醒后浏览会话异常:', err));
          },
          startIdentityGuard: () => startIdentityGuard?.(),
        });
        console.log(`[aidcp-edge] ✓ 唤醒完成：浏览器已重建、身份已确认、自动化${resumeAutomation ? '已恢复' : '保持暂停'}`);
        return true;
      } catch (error) {
        console.warn(`[aidcp-edge] ⚠ 唤醒失败：${(error as Error)?.message || String(error)}；留在待机态，可再次唤醒`);
        // 半开的浏览器绝不留着占内存槽位——它既不能干活、又挡着别的账号。
        try {
          session.detach();
          proxyRuntime?.suspendGeneration('wake_failed');
          await chrome?.killAndConfirmDead().catch(() => undefined);
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
    onResumed: () => {
      if (typeof process.send === 'function' && process.connected) {
        process.send({ type: 'lifecycle.resumed' });
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
  }, startBrowserAbsent ? 'standby' : startAutomationPaused ? 'paused' : 'active', startAutomationPaused);

  dispatchLifecycleCommand = (command) => {
    void lifecycle.request(command).catch((error) => {
      console.error(`[aidcp-edge] lifecycle.${command} 处理失败:`, error);
    });
  };
  for (const command of pendingLifecycleCommands.splice(0)) dispatchLifecycleCommand(command);
  if (startBrowserAbsent) {
    // 浏览器从未打开，不需要再跑 enterStandby；这里只向外壳确认“核心+Cloud 已在线、浏览器缺席”。
    sendLifecycleIpc({ type: 'lifecycle.standby' });
  }

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

  let executorFailureTransitioning = false;
  const isolateExecutorFailure = (reason: string): void => {
    if (coldStandbyActive || executorFailureTransitioning) return;
    executorFailureTransitioning = true;
    console.warn(`[aidcp-edge] 浏览器执行器故障（${reason}）：终止页面工作并释放执行器；客户端核心与 Cloud 保持在线`);
    failInFlightPublishesHonestly(reason);
    taskCoordinator.reset(reason);
    browse?.discardQueuedCloudCommands(reason);
    // 周期观测停在**这里**、而不是在冷待机成功路径上，理由是决定性的：本函数末尾请求的冷待机
    // 在「有活跃租约」或「复用外部浏览器」时会被 enterStandby 直接拒绝（return false），而
    // coldStandbyActive 仍是 false —— 此时连接已经是终态、待机又没进去，把停手挂在待机路径上就会漏，
    // 探针对着一条已死的连接一路空轮询到进程退出。本函数是 cdp.unrecoverable 与
    // cdp.control_unavailable 两条终态路径的共同收口，且自带 executorFailureTransitioning 去重闩，
    // 与 suspendObservation 的幂等叠加不会重复打日志。**别顺手把它挪进 enterStandby。**
    nativeBrowse?.suspendObservation(reason);
    // 身份校验体同理：连接死了就读不出身份，留着只会每拍打一行「无法确认」。
    identityGuard?.stop();
    sendLifecycleIpc({ type: 'lifecycle.executor_failed', reason });
    void lifecycle.request('standby').finally(() => {
      executorFailureTransitioning = false;
    });
  };

  // Input 超时的结果不确定：已由 CdpClient 封住后续页面写。若浏览器由本节点启动并拥有，则回收并让看护
  // 建一个新的 CDP 安全边界；执行器故障不得把客户端核心或 Cloud 投影为离线。
  const recycleOrHoldUnavailableBrowser = (): void => {
    // 冷待机：浏览器是我们自己关的，"控制不可用"是预期终局而非故障——绝不据此回收自杀
    // （与下方 cdp.unrecoverable 的守卫同口径；缺了它，待机期一条在途 Input 就能把核心杀掉）。
    if (coldStandbyActive) {
      console.log('[aidcp-edge] CDP 控制不可用发生在冷待机期间（浏览器已被有意关闭）；保留云端连接，等待外壳唤醒');
      return;
    }
    if (!chrome) {
      console.log('[aidcp-edge] 浏览器缺席态没有可回收实例；保留控制面等待唤醒');
      return;
    }
    if (chrome.reused) {
      console.warn('[aidcp-edge] CDP 输入控制不可用：复用的外部浏览器不会被自动关闭；请人工重启浏览器客户端后恢复');
      sendLifecycleIpc({
        type: 'lifecycle.executor_failed',
        reason: 'cdp_control_unavailable_external_browser',
        teardown: false,
      });
      return;
    }
    isolateExecutorFailure('cdp_control_unavailable');
  };
  session.cdp.on('cdp.control_unavailable', recycleOrHoldUnavailableBrowser);
  // attach 初始 enable 阶段若已经发生输入超时，订阅发生得较晚也必须按同一所有权边界处理。
  if (!session.cdp.isControlReady()) recycleOrHoldUnavailableBrowser();

  // CDP 终态只终止并释放浏览器执行器；核心与 Cloud 连接继续提供 browser-independent 操作。
  session.cdp.on('cdp.unrecoverable', () => {
    if (coldStandbyActive) {
      console.log('[aidcp-edge] CDP 因冷待机关闭浏览器而不可用；保留云端连接，等待外壳唤醒');
      return;
    }
    isolateExecutorFailure('cdp_unrecoverable');
  });

  // 重连成功 → 整批重启周期观测与身份校验（两者都幂等：没停过是空操作，停过则干净恢复）。
  // 少了这一半，任何一次「连接掉了又回来」都会让观测与校验永久哑火——外部看到的是「一切正常」，
  // 实际是传感层全灭（静默假成功）。
  session.cdp.on('cdp.reconnected', () => {
    // 待机期由 wakeFromStandby 统一恢复，此处不抢：那时浏览器还没重建，起了也只是对空页面轮询。
    if (coldStandbyActive) return;
    nativeBrowse?.resumeObservation();
    // 暂停态不重开身份校验：它一旦判失效就会走重立链、把浏览重新拉起来，那是对「暂停」的违背。
    // 恢复自动化时由 resumeAutomation 统一开。
    if (lifecycle.state === 'active') startIdentityGuard?.();
  });

  process.on('SIGINT', () => void shutdown({ exitCode: 0, recycle: false, reason: 'SIGINT' }));
  process.on('SIGTERM', () => void shutdown({ exitCode: 0, recycle: false, reason: 'SIGTERM' }));
}

main().catch((err) => {
  // 云端**拒绝**握手 ≠ 连不上云端（change risk-state-cross-process-integrity，task 9.1）。
  // 拒绝是云端看清了本节点是谁之后作出的裁决，重试一万次答案不变；渲染成「云端离线 / 连接失败」
  // 会把运营推去查网络，而真正要做的是把这个节点接到正确的云端、或改配置。
  // 故这里原样呈现云端给的拒绝码与人话说明（如 platform_mismatch / missing_account_id）。
  // 注：账号归属已改为「跟随当次会话」，云端不再产生 execution_target_mismatch 这个拒绝
  // （change risk-target-follows-active-session），故不再对它作特判追加处理办法。
  if (err instanceof CloudHandshakeRejectedError) {
    console.error(`[aidcp-edge] 云端拒绝本节点握手 [${err.code}]：${err.detail}`);
    process.exit(1);
  }
  console.error('[aidcp-edge] 启动失败:', err);
  // 红线「快速失败 + 可见」：致命启动失败（含 client.connect() 连云失败）立即非零退出，
  // 让桌面外壳的 edgeProcess.on('exit') 立刻看见并弹窗 + 通知；绝不退避重试掩盖未连通。
  process.exit(1);
});
