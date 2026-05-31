/**
 * 边缘会话装配：发现 page target → 连接 CDP → 启用必要域 → 产出可直接喂给
 * LocatingEngine 的 DomProvider + ActionExecutor。
 *
 * 这是边缘端把"定位层引擎"接到"真实浏览器"的最小胶水层。
 */

import { CdpClient, type CdpClientOptions } from './client.js';
import { CdpDomProvider } from './dom-provider.js';
import { CdpActionExecutor } from './action-executor.js';
import { firstPageTarget, type DiscoverOptions } from './targets.js';
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
  const cdp = new CdpClient(target.webSocketDebuggerUrl, options.client);
  await cdp.connect();
  // 启用定位/执行所需的最小域（evaluate 不强制 enable，但启用便于后续扩展）
  await cdp.send('Runtime.enable').catch(() => undefined);
  await cdp.send('Page.enable').catch(() => undefined);

  // attach 后立即注入反检测脚本（在启用 Page 域之后）。
  if (options.stealth !== false) {
    const injector = options.stealthInjector ?? new CdpStealthInjector();
    await injector.inject(cdp);
  }

  return {
    cdp,
    dom: new CdpDomProvider(cdp),
    executor: new CdpActionExecutor(cdp),
    close: () => cdp.close(),
  };
}
