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
  /** 关闭底层 CDP 连接 */
  close(): void;
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
 * 启用定位/执行所需 CDP 域 + 注入反检测 + 权限弹窗兜底。首次 attach 与断线重连共用，避免口径漂移。
 * Input.enable（坐标点击/按键所需）也在此——重连后新 WS 必须重启用，否则点击/输入失效。
 */
async function reEnableAndInject(
  cdp: CdpClient,
  opts: { stealth?: boolean; injector: StealthInjector },
): Promise<void> {
  await cdp.send('Runtime.enable').catch(() => undefined);
  await cdp.send('Page.enable').catch(() => undefined);
  await cdp.send('Input.enable').catch(() => undefined);
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
export async function attachToPage(options: AttachOptions = {}): Promise<EdgeSession> {
  const target = await firstPageTarget(options);
  const injector = options.stealthInjector ?? new CdpStealthInjector();

  // 断线重连配置（缺省启用）：重发现按域名硬过滤（默认 xiaohongshu.com，绝不落无关 tab），
  // 重连后用 reEnableAndInject 重启用域 + 重注入反检测。
  let reconnect: CdpReconnectOptions | undefined;
  if (options.reconnect !== false) {
    const host = options.host ?? '127.0.0.1';
    const port = options.port ?? 9222;
    const doFetch = options.fetchImpl ?? globalThis.fetch;
    reconnect = {
      ...(typeof options.reconnect === 'object' ? options.reconnect : {}),
      rediscoverTarget: async () => {
        const t = await firstPageTarget({
          ...options,
          urlIncludes: options.urlIncludes ?? 'xiaohongshu.com',
        });
        return t.webSocketDebuggerUrl;
      },
      onReconnected: async (c) => {
        await reEnableAndInject(c, { stealth: options.stealth, injector });
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

  const cdp = new CdpClient(target.webSocketDebuggerUrl, { ...options.client, reconnect });
  await cdp.connect();
  // 启用所需域 + 注入反检测（与重连共用同一函数）。
  await reEnableAndInject(cdp, { stealth: options.stealth, injector });

  return {
    cdp,
    dom: new CdpDomProvider(cdp),
    executor: new CdpActionExecutor(cdp),
    close: () => cdp.close(),
  };
}
