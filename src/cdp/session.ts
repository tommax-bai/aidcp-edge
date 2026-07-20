/**
 * 边缘会话装配：发现 page target → 连接 CDP → 启用必要域 → 产出可直接喂给
 * LocatingEngine 的 DomProvider + ActionExecutor。
 *
 * 这是边缘端把"定位层引擎"接到"真实浏览器"的最小胶水层。
 */

import { CdpClient, type CdpClientOptions, type CdpReconnectOptions } from './client.js';
import { CdpDomProvider } from './dom-provider.js';
import { CdpActionExecutor } from './action-executor.js';
import { firstPageTarget, type CdpTarget, type DiscoverOptions } from './targets.js';
import { CdpStealthInjector, type StealthInjector } from './stealth-injector.js';

export interface EdgeSession {
  cdp: CdpClient;
  dom: CdpDomProvider;
  executor: CdpActionExecutor;
  /** 关闭底层 CDP 连接（终局：进程要退出了） */
  close(): void;
  /**
   * 冷待机释放浏览器层（change browser-slot-scheduling）：断开连接、进入「浏览器缺席」态，
   * 之后任何页面命令都会**响亮失败**而非静默假成功。可由 reattachSession() 原地复活。
   */
  detach(): void;
}

export interface AttachOptions extends DiscoverOptions {
  /** 仅附着 url 含该子串的页面 */
  urlIncludes?: string;
  /** 平台自定义 target 选择谓词；优先级高于 urlIncludes。 */
  targetPredicate?: (target: CdpTarget) => boolean;
  /** 透传给 CdpClient 的选项 */
  client?: CdpClientOptions;
  /**
   * 是否注入反检测脚本（默认 true）。
   * 注入用 Page.addScriptToEvaluateOnNewDocument，持久到 session 结束，
   * 每次新页面加载自动生效。详见 stealth-injector.ts。
   */
  stealth?: boolean;
  /** 注入器（测试用，默认 CdpStealthInjector） */
  stealthInjector?: StealthInjector;
  /**
   * CDP 断线重连：缺省启用（默认参数）；传 false 关闭；传对象覆盖参数。
   * 重连内化进 CdpClient（保实例换内层 WS），对云端透明、绝不重发 hello。
   */
  reconnect?: Partial<CdpReconnectOptions> | false;
  /** 是否启用 CDP Network domain（代理出口/接收流量观测使用）。 */
  network?: boolean;
}

/**
 * 指纹浏览器权限弹窗兜底（change browser-permission-prompt-defaults）。
 * 启动参数 `--deny-permission-prompts` 已在**新起**的浏览器上关掉权限弹窗；但复用一个已存活的
 * 浏览器时（AdsPower 交回运行中的 profile / self 复用已开的调试端口）拿不到该参数——此处经 CDP
 * 对默认浏览上下文把常见会弹窗的权限一律置 `denied`，等价「用户点了禁止通知/定位」，与真实浏览器
 * 观感一致、不抹掉任何 web API（不制造反检测破绽）。省略 origin ⇒ 对所有 origin 生效。
 * best-effort：任一权限名在某内核不被 setPermission 接受而 reject，也绝不影响 attach/续跑。
 */
const DENIED_BROWSER_PERMISSIONS = ['notifications', 'geolocation', 'camera', 'microphone'] as const;

export async function denyPermissionPrompts(cdp: CdpClient): Promise<void> {
  for (const name of DENIED_BROWSER_PERMISSIONS) {
    await cdp
      .send('Browser.setPermission', { permission: { name }, setting: 'denied' })
      .catch(() => undefined);
  }
}

/**
 * 页面级 JS 对话框接管（change lease-strict-preemption task 3.4）。
 *
 * **Page.enable 一旦开着，浏览器就不再自动处理 alert / confirm / beforeunload —— 页面会一直阻塞，
 * 直到有人显式 handleJavaScriptDialog。而我们全仓从来没有任何处理器。**
 * 后果：离开一个填了字的编辑器页触发「离开此页 / 保存草稿？」确认框 → 浏览器就此冻住，
 * 连最高优先级的抢占者拿到执行权后也只能对着一个死页面。这是今天就在的雷，抢占会把它踩成常态。
 *
 * 一律 accept（= 放弃编辑、允许离开）：我们从不主动使用 JS 对话框，任何弹出的对话框都是平台侧的
 * 离开确认 / 提示。相比「让浏览器永久冻住」，接受它永远是更小的代价。每一次都记日志，绝不静默。
 */
function takeOverJavaScriptDialogs(cdp: CdpClient, log: (m: string) => void): void {
  cdp.on('Page.javascriptDialogOpening', (params) => {
    const p = (params ?? {}) as { type?: string; message?: string };
    log(
      `[cdp] 页面弹出 JS 对话框（type=${p.type ?? '?'} message=${JSON.stringify((p.message ?? '').slice(0, 60))}）→ accept（放弃编辑、允许离开）。` +
        `不接管的话页面会一直阻塞在这里。`,
    );
    void cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined);
  });
}

/**
 * 启用定位/执行所需 CDP 域 + 注入反检测 + 权限弹窗兜底。首次 attach 与断线重连共用，避免口径漂移。
 * Input.enable（坐标点击/按键所需）也在此——重连后新 WS 必须重启用，否则点击/输入失效。
 */
async function reEnableAndInject(
  cdp: CdpClient,
  opts: { stealth?: boolean; injector: StealthInjector; network?: boolean },
): Promise<void> {
  await cdp.send('Runtime.enable').catch(() => undefined);
  await cdp.send('Page.enable').catch(() => undefined);
  await cdp.send('Input.enable').catch(() => undefined);
  if (opts.network) await cdp.send('Network.enable').catch(() => undefined);
  // 权限弹窗兜底：与启动参数 --deny-permission-prompts 形成双保险，覆盖复用/重连拿不到该参数的浏览器。
  await denyPermissionPrompts(cdp);
  if (opts.stealth !== false) {
    await opts.injector.inject(cdp);
  }
}

/**
 * 附着到本机 Chrome 的一个 page，返回边缘会话。
 * 默认连接 127.0.0.1:9222。
 *
 * attach 完成后会立即注入反检测脚本（除非 options.stealth === false），
 * 确保后续每个新 document 在任何页面脚本之前被打补丁。
 */
/**
 * 断线重连配置（缺省启用）：重发现按域名硬过滤（默认 xiaohongshu.com，绝不落无关 tab），
 * 重连后用 reEnableAndInject 重启用域 + 重注入反检测。
 *
 * **必须是函数、不能内联**（change browser-slot-scheduling）：它的 classify 闭包把 host:port 焊死在
 * 里面，而 AdsPower 每次启动的调试端口都不同。冷待机唤醒后浏览器是新起的、端口变了，必须拿**新的**
 * AttachOptions 重新构造一份——沿用旧的，唤醒后第一次瞬断就会拿旧端口探活、探不到即误判「进程已死 =
 * 终局」，把一个本可续跑的连接直接判死并触发整进程回收。
 */
function buildReconnect(options: AttachOptions, injector: StealthInjector): CdpReconnectOptions | undefined {
  if (options.reconnect === false) return undefined;
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 9222;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  return {
    ...(typeof options.reconnect === 'object' ? options.reconnect : {}),
    rediscoverTarget: async () => {
      const t = await firstPageTarget({
        ...options,
        urlIncludes: options.urlIncludes ?? 'xiaohongshu.com',
      });
      return t.webSocketDebuggerUrl;
    },
    onReconnected: async (c) => {
      await reEnableAndInject(c, { stealth: options.stealth, injector, network: options.network });
    },
    // 终态快判（进入退避循环前）：① 浏览器进程级端点 /json/version 不可达 → 进程已死 = 终态；
    // ② 进程在但找不到可用 page target → 页面归零（窗口被关/标签崩，经验不可恢复）= 终态；
    // ③ 进程在且页面 target 仍在 → 'retry' 走有界重连透明续跑。
    classify: async () => {
      try {
        const res = await doFetch(`http://${host}:${port}/json/version`);
        if (!res.ok) return 'terminal';
      } catch {
        return 'terminal'; // 端口拒连：进程级终态
      }
      try {
        await firstPageTarget({
          ...options,
          urlIncludes: options.urlIncludes ?? 'xiaohongshu.com',
        });
        return 'retry'; // 页面 target 在，可重连
      } catch {
        return 'terminal'; // 页面归零，经验不可恢复
      }
    },
  };
}

export async function attachToPage(options: AttachOptions = {}): Promise<EdgeSession> {
  const target = await firstPageTarget(options);
  const injector = options.stealthInjector ?? new CdpStealthInjector();
  const reconnect = buildReconnect(options, injector);

  const cdp = new CdpClient(target.webSocketDebuggerUrl, { ...options.client, reconnect });
  await cdp.connect();
  // 对话框接管**只注册一次**：事件订阅表随 CdpClient 存活、跨重连保留（见 CdpClient 的原地释放注释），
  // 放进 reEnableAndInject 会每次重连叠一个监听器。
  takeOverJavaScriptDialogs(cdp, (m) => console.log(m));
  // 启用所需域 + 注入反检测（与重连共用同一函数）。
  await reEnableAndInject(cdp, { stealth: options.stealth, injector, network: options.network });

  return {
    cdp,
    dom: new CdpDomProvider(cdp),
    executor: new CdpActionExecutor(cdp),
    close: () => cdp.close(),
    detach: () => cdp.detach(),
  };
}

/**
 * 无浏览器控制面启动（change browser-slot-cloud-presence）：先构造一套对象身份稳定的 session，
 * 但立刻置为 detached。DomProvider / ActionExecutor / 所有事件订阅者从第一刻就攥住同一个 CdpClient；
 * 后续取得槽位后由 reattachSession() 原地复活，绝不需要重建整套运行时。
 */
export function createDetachedSession(options: Pick<AttachOptions, 'client'> = {}): EdgeSession {
  const cdp = new CdpClient('ws://127.0.0.1:0/browser-absent', options.client);
  takeOverJavaScriptDialogs(cdp, (m) => console.log(m));
  cdp.detach();
  return {
    cdp,
    dom: new CdpDomProvider(cdp),
    executor: new CdpActionExecutor(cdp),
    close: () => cdp.close(),
    detach: () => cdp.detach(),
  };
}

/**
 * 唤醒重建（change browser-slot-scheduling）：把**已有的** EdgeSession 重新附着到新一代浏览器。
 *
 * 不新建 CdpClient / DomProvider / ActionExecutor —— 十几个长期存活的组件在构造时就攥住了这三个对象，
 * 新建它们等于让所有持有者拿着过期句柄。这里保住对象身份，只换连接内层（socket + target + 重连配置）
 * 并重启用 CDP 域、重注入反检测。持有者与订阅者全程无感。
 *
 * `options` MUST 是**新一代浏览器**的 AttachOptions（新的 host/port）。
 * 失败即抛：调用方据此诚实报「唤醒失败」，会话保持待机、可再次唤醒；绝不把半死的连接当就绪。
 */
export async function reattachSession(session: EdgeSession, options: AttachOptions = {}): Promise<void> {
  const target = await firstPageTarget(options);
  const injector = options.stealthInjector ?? new CdpStealthInjector();
  await session.cdp.reattach(target.webSocketDebuggerUrl, buildReconnect(options, injector));
  await reEnableAndInject(session.cdp, { stealth: options.stealth, injector, network: options.network });
}
