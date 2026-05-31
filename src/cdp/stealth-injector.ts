/**
 * StealthInjector —— 反检测脚本注入（对抗小红书的自动化检测）。
 *
 * 背景见 docs/anti-detection.md §1（浏览器指纹防护）与 §4（CDP 特征隐藏）。
 *
 * CDP 原生方案（--remote-debugging-port）的"原罪"：连上调试端口后，页面侧能感知
 * 若干自动化特征（navigator.webdriver、缺失的 plugins/languages、异常的权限查询、
 * 被 toString 识破的注入函数等）。本模块在每个 page target attach 后，通过
 * `Page.addScriptToEvaluateOnNewDocument` 注入一段防护脚本，确保它在页面任何脚本
 * 之前执行（避免"先读后改"被识破）。
 *
 * 该 API 注册的脚本会持久到 session 结束：之后每次导航 / 新 document 都会自动重放，
 * 无需为每次页面加载重新注入。
 *
 * 策略（MVP / 一机一号）：
 * - 只抹除自动化痕迹，不伪造 Canvas/WebGL 指纹（保持真实，反而最安全，见 §1.2 方案 A）。
 * - 各维度保持自洽（§1.5），不引入与真实环境矛盾的值。
 *
 * 仅依赖 `send(method, params)` 这一最小子集（与 cdp/dom-provider.ts 的假客户端同形），
 * 因此测试里用一个 `{ send }` 对象即可注入。
 */

/** StealthInjector 需要的最小 CDP 能力（与 CdpClient 兼容） */
export interface StealthCdp {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/** Page.addScriptToEvaluateOnNewDocument 的返回结构 */
interface AddScriptResult {
  identifier: string;
}

/**
 * 构造要注入的反检测脚本源码。
 *
 * 该脚本在每个新 document 的"任意页面脚本之前"运行，逐项抹除自动化痕迹。
 * 所有改写都用一个保存原生 `toString` 的工具，把被覆盖的函数伪装成 `[native code]`，
 * 防止"注入函数被 toString 识破"（§4.3）。
 */
export function buildStealthScript(): string {
  // 注意：此函数体会被序列化为字符串注入到页面，因此不能引用任何 Node 侧变量。
  function stealth(): void {
    try {
      // —— 工具：把覆盖函数伪装成原生 [native code] —— §4.3
      const nativeToString = Function.prototype.toString;
      const fakeNative = new WeakMap<(...a: unknown[]) => unknown, string>();
      const patchedToString = function toString(this: (...a: unknown[]) => unknown): string {
        const faked = fakeNative.get(this);
        if (faked) return faked;
        return nativeToString.call(this);
      };
      // 让 patched toString 自身也表现为原生
      fakeNative.set(patchedToString, 'function toString() { [native code] }');
      (Function.prototype as unknown as Record<string, unknown>).toString = patchedToString;
      const markNative = (fn: (...a: unknown[]) => unknown, name: string): void => {
        fakeNative.set(fn, `function ${name}() { [native code] }`);
      };

      // —— §1.1 navigator.webdriver 清除 ——
      try {
        Object.defineProperty(Navigator.prototype, 'webdriver', {
          get: () => undefined,
          configurable: true,
          enumerable: false,
        });
      } catch {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
        } catch {
          /* ignore */
        }
      }

      // —— §1.2 删除 ChromeDriver / Selenium 残留变量 cdc_* / $cdc_ ——
      try {
        const w = window as unknown as Record<string, unknown>;
        for (const key of Object.keys(w)) {
          if (key.indexOf('cdc_') === 0 || key.indexOf('$cdc_') === 0) {
            try {
              delete w[key];
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }

      // —— §4.4 navigator.languages 非空且与 IP 一致（中国大陆）——
      try {
        if (!navigator.languages || navigator.languages.length === 0) {
          Object.defineProperty(Navigator.prototype, 'languages', {
            get: () => ['zh-CN', 'zh'],
            configurable: true,
          });
        }
      } catch {
        /* ignore */
      }

      // —— §4.4 navigator.plugins：headless 常为空；补一个正常 Chrome 插件列表 ——
      try {
        if (!navigator.plugins || navigator.plugins.length === 0) {
          const pluginData = [
            { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          ];
          const fakePlugins = pluginData.map((p) => {
            const plugin = Object.create(Plugin.prototype) as Record<string, unknown>;
            plugin.name = p.name;
            plugin.filename = p.filename;
            plugin.description = p.description;
            plugin.length = 1;
            return plugin;
          });
          const arr = fakePlugins as unknown as PluginArray;
          Object.defineProperty(Navigator.prototype, 'plugins', {
            get: () => arr,
            configurable: true,
          });
        }
      } catch {
        /* ignore */
      }

      // —— §4.4 navigator.permissions.query：Notification 应返回 'prompt' 而非 'denied' ——
      try {
        const perms = navigator.permissions;
        if (perms && typeof perms.query === 'function') {
          const originalQuery = perms.query.bind(perms);
          const patchedQuery = function query(
            this: Permissions,
            desc: PermissionDescriptor,
          ): Promise<PermissionStatus> {
            if (desc && desc.name === 'notifications') {
              const state =
                typeof Notification !== 'undefined' ? Notification.permission : 'prompt';
              // headless 下常为 'denied' 但 Notification.permission='default'，矛盾 → 对齐成 'prompt'
              const resolved =
                state === 'denied' ? 'prompt' : state === 'default' ? 'prompt' : state;
              return Promise.resolve({
                state: resolved,
                onchange: null,
                name: 'notifications',
                addEventListener: () => undefined,
                removeEventListener: () => undefined,
                dispatchEvent: () => false,
              } as unknown as PermissionStatus);
            }
            return originalQuery(desc);
          };
          markNative(patchedQuery as unknown as (...a: unknown[]) => unknown, 'query');
          (perms as unknown as Record<string, unknown>).query = patchedQuery;
        }
      } catch {
        /* ignore */
      }

      // —— §4.4 window.chrome 对象存在且结构正确（headless 可能缺失）——
      try {
        const w = window as unknown as Record<string, unknown>;
        if (!w.chrome) {
          w.chrome = {};
        }
        const chrome = w.chrome as Record<string, unknown>;
        if (!chrome.runtime) {
          chrome.runtime = {};
        }
        if (!chrome.app) {
          chrome.app = { isInstalled: false, InstallState: {}, RunningState: {} };
        }
        if (!chrome.csi) {
          const csi = function csi(): Record<string, number> {
            return { onloadT: Date.now(), startE: Date.now(), tran: 15 };
          };
          markNative(csi as unknown as (...a: unknown[]) => unknown, 'csi');
          chrome.csi = csi;
        }
        if (!chrome.loadTimes) {
          const loadTimes = function loadTimes(): Record<string, unknown> {
            return {};
          };
          markNative(loadTimes as unknown as (...a: unknown[]) => unknown, 'loadTimes');
          chrome.loadTimes = loadTimes;
        }
      } catch {
        /* ignore */
      }

      // —— §4.3 console.debug 检测绕过 ——
      // 某些检测脚本反复调用 console.debug 来制造可观测副作用以判断是否被调试器附着。
      // 这里把 console.debug 替换为一个伪装成原生、且行为温和的实现（不向真实控制台输出，
      // 避免被计时/副作用检测利用），并保持 toString 原生外观。
      try {
        const noopDebug = function debug(): void {
          /* swallow，避免被用来检测 CDP */
        };
        markNative(noopDebug as unknown as (...a: unknown[]) => unknown, 'debug');
        (console as unknown as Record<string, unknown>).debug = noopDebug;
      } catch {
        /* ignore */
      }

      // —— §4.4 iframe contentWindow 访问正常（防 cross-origin iframe trick）——
      // 有些检测创建 iframe 并读取其 contentWindow 上的 navigator 等，若注入未覆盖到
      // 子框架则露馅。addScriptToEvaluateOnNewDocument 默认会对子 frame 同样生效
      // （新 document 前置脚本会在每个 frame 的新 document 重放），因此子 document 也被
      // 覆盖；这里仅保留注释说明设计意图（§4.4），不做侵入式改写以免破坏正常 iframe 行为。
    } catch {
      /* 任何异常都不应影响页面，整体吞掉 */
    }
  }

  return `(${stealth.toString()})();`;
}

/**
 * 反检测脚本注入器。
 *
 * 用法：在 attachToPage 拿到 CdpClient 后调用 `inject(cdp)`，即可对该 session 的
 * 所有（当前与未来）document 生效。
 */
export interface StealthInjector {
  /** 注入所有反检测脚本到当前 CDP session */
  inject(cdp: StealthCdp): Promise<void>;
}

export interface CdpStealthInjectorOptions {
  /** 覆盖默认注入脚本（测试用） */
  scriptSource?: string;
  /** 注入前是否启用 Page 域（addScriptToEvaluateOnNewDocument 需要），默认 true */
  enablePageDomain?: boolean;
}

/**
 * 默认实现：先（可选）启用 Page 域，再注册 stealth 脚本为"新 document 前置脚本"。
 *
 * 注意调用顺序——必须 `Page.enable` 在前、`Page.addScriptToEvaluateOnNewDocument`
 * 在后，否则部分 Chrome 版本不会保留前置脚本。
 */
export class CdpStealthInjector implements StealthInjector {
  private readonly scriptSource: string;
  private readonly enablePageDomain: boolean;
  /** 上次注入返回的脚本标识（便于调试 / 后续移除） */
  lastIdentifier?: string;

  constructor(options: CdpStealthInjectorOptions = {}) {
    this.scriptSource = options.scriptSource ?? buildStealthScript();
    this.enablePageDomain = options.enablePageDomain ?? true;
  }

  async inject(cdp: StealthCdp): Promise<void> {
    if (this.enablePageDomain) {
      // Page 域可能已被上层启用；重复 enable 是幂等的，失败也不阻塞。
      await cdp.send('Page.enable').catch(() => undefined);
    }
    const res = await cdp.send<AddScriptResult>('Page.addScriptToEvaluateOnNewDocument', {
      source: this.scriptSource,
    });
    this.lastIdentifier = res?.identifier;
  }
}

/** 便捷函数：用默认配置注入一次反检测脚本。 */
export async function injectStealth(cdp: StealthCdp): Promise<void> {
  await new CdpStealthInjector().inject(cdp);
}
