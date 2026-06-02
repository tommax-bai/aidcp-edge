# aidcp-edge 浏览器 / CDP 现状盘点

更新时间：2026-06-02

## 结论摘要

- `aidcp-edge` 当前不是“只连接已有浏览器”或“只启动新浏览器”的单一模式，而是 **优先探测并复用已有 Chrome CDP 实例；若端口未就绪，则由 edge 自己启动一个新的 Chrome 进程**。证据见 `src/cdp/chrome-launcher.ts:5-8`、`src/cdp/chrome-launcher.ts:183-208`、`src/main.ts:52-62`。
- CDP 接入层使用的是 **原生 WebSocket + DevTools HTTP `/json` / `/json/version`**，**没有引入 Playwright、Puppeteer、chrome-remote-interface**。证据见 `src/cdp/client.ts:2-7`、`src/cdp/index.ts:2-10`、`README.md:11-12`、`package.json:16-22`。
- 连接建立流程是：**先通过 `http://host:port/json` 找到 page target，取其 `webSocketDebuggerUrl`，再用原生 WebSocket 连接该 ws endpoint**；不是直接 launch 后拿库内 browser 对象。证据见 `src/cdp/targets.ts:2-6`、`src/cdp/targets.ts:27-53`、`src/cdp/session.ts:44-47`。
- 登录态当前依赖 **Chrome user-data-dir 持久化复用**。首次启动独立 profile 时，会提示人工登录小红书并等待回车；后续复用同一 profile 时沿用已有登录态。代码里**没有单独的 cookie 导入/导出/注入逻辑**。证据见 `src/cdp/chrome-launcher.ts:6-9`、`src/cdp/chrome-launcher.ts:192-193`、`src/cdp/chrome-launcher.ts:211-252`，以及全仓检索未发现 cookie 管理实现。

## 1. 当前到底是“启动新浏览器”还是“连接已有浏览器”

### 1.1 实际行为：两者都支持，但默认策略是“先复用，后启动”

`src/main.ts` 启动时先读取 CDP host/port，随后无条件调用 `launchChrome()`，再调用 `attachToPage()`：

```45:62:src/main.ts
async function main(): Promise<void> {
  const cloudUrl = process.env.AIDCP_CLOUD_URL ?? 'ws://121.89.85.150:8787';
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
```

`launchChrome()` 的实现明确写了策略：

- 先 `GET /json/version` 探测端口；
- 若已有实例监听，则直接复用；
- 否则发现 Chrome 路径并 `spawn` 新进程。

```183:208:src/cdp/chrome-launcher.ts
 * 启动或复用 Chrome。
 * - 若 CDP 端口已就绪：直接复用（pid=null, reused=true）。
 * - 否则发现路径并 spawn 新进程，轮询直至 /json/version 就绪。
 * - 首次启动（profile 目录不存在）时提示人工登录并等待 Enter。
 */
export async function launchChrome(opts: ChromeLauncherOptions = {}): Promise<ChromeInstance> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  // ...

  // 1) 复用已有实例
  if (await probeCdp(host, port, fetchImpl)) {
    log(`[aidcp-edge] 检测到已有 Chrome 监听 ${host}:${port}，复用实例`);
    return { pid: null, reused: true, kill: () => undefined };
  }
```

继续往下看，端口未就绪时会真正启动 Chrome：

```210:218:src/cdp/chrome-launcher.ts
  const isFirstLaunch = !existsImpl(profileDir);
  const chromePath = discoverChromePath(opts.chromePath, existsImpl);
  const args = buildChromeArgs({ port, profileDir, headless, startUrl });

  log(`[aidcp-edge] 启动 Chrome: ${chromePath}`);
  const child: ChildProcess = spawnImpl(chromePath, args, {
    detached: false,
    stdio: 'ignore',
  });
```

### 1.2 不是 Playwright / Puppeteer 模式

仓库依赖里没有 Playwright、Puppeteer、chrome-remote-interface：

```16:22:package.json
  "devDependencies": {
    "@types/jsdom": "^21.1.7",
    "@types/node": "^22.10.0",
    "jsdom": "^25.0.1",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  }
```

README 和 CDP 出口文件也明确声明是原生 WebSocket：

```11:12:README.md
- **CDP 接入层（`src/cdp/`）** — 用**原生 WebSocket** 连接 Chrome DevTools Protocol
  （不依赖 Playwright / chrome-remote-interface），把引擎接到真实浏览器：
```

```2:10:src/cdp/index.ts
/**
 * CDP 接入层公共出口（原生 WebSocket，无 Playwright / chrome-remote-interface 依赖）。
 */
export * from './client.js';
export * from './targets.js';
export * from './dom-provider.js';
export * from './action-executor.js';
export * from './session.js';
export * from './chrome-launcher.js';
export * from './stealth-injector.js';
```

## 2. CDP 连接是怎么建立的

### 2.1 先走 DevTools HTTP，再连 `webSocketDebuggerUrl`

`src/cdp/targets.ts` 负责通过 DevTools HTTP 端点发现 target：

```27:53:src/cdp/targets.ts
export async function listTargets(options: DiscoverOptions = {}): Promise<CdpTarget[]> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 9222;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (!doFetch) throw new Error('global fetch 不可用（需 Node>=18）；请注入 fetchImpl');
  const res = await doFetch(`http://${host}:${port}/json`);
  if (!res.ok) {
    throw new Error(`DevTools /json 请求失败: HTTP ${res.status}`);
  }
  const data = (await res.json()) as CdpTarget[];
  return data;
}

export async function firstPageTarget(
  options: DiscoverOptions & { urlIncludes?: string } = {},
): Promise<CdpTarget> {
  const targets = await listTargets(options);
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const match = options.urlIncludes
    ? pages.find((t) => t.url.includes(options.urlIncludes!))
    : pages[0];
  if (!match) {
    throw new Error('未找到可用的 page target（确认 Chrome 已用 --remote-debugging-port 启动）');
  }
  return match;
}
```

`attachToPage()` 再把 `webSocketDebuggerUrl` 交给 `CdpClient`：

```44:56:src/cdp/session.ts
export async function attachToPage(options: AttachOptions = {}): Promise<EdgeSession> {
  const target = await firstPageTarget(options);
  const cdp = new CdpClient(target.webSocketDebuggerUrl, options.client);
  await cdp.connect();
  await cdp.send('Runtime.enable').catch(() => undefined);
  await cdp.send('Page.enable').catch(() => undefined);

  if (options.stealth !== false) {
    const injector = options.stealthInjector ?? new CdpStealthInjector();
    await injector.inject(cdp);
  }
```

`CdpClient` 本身就是一个最小原生 WS RPC 客户端：

```87:111:src/cdp/client.ts
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = this.wsFactory(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => {
        this.connected = true;
        settled = true;
        resolve();
      });
      ws.addEventListener('error', (ev) => {
        if (!settled) {
          settled = true;
          reject(new Error(`CDP WS 连接失败: ${describeError(ev)}`));
        }
      });
      ws.addEventListener('close', () => {
        this.connected = false;
        this.failAllPending(new Error('CDP WS 已关闭'));
      });
      ws.addEventListener('message', (ev) => this.onMessage(ev.data));
    });
  }
```

### 2.2 连接对象是 page target，不是 browser-level 抽象

当前 attach 逻辑只挑 `type === 'page'` 的 target，并且默认取第一个 page，或按 `urlIncludes` 过滤后取匹配页。也就是说：

- 不是 attach 到 browser target；
- 不是多 page 管理器；
- 不是自动新建 tab；
- 依赖目标 Chrome 中已经存在一个可调试 page。

证据见 `src/cdp/targets.ts:40-52`。

## 3. 是否有 launch / spawn 浏览器进程代码

有，而且是仓库内正式实现，不是测试桩。

### 3.1 启动方式

通过 Node `child_process.spawn()` 直接启动本机 Chrome 可执行文件，并传入固定参数：

```155:180:src/cdp/chrome-launcher.ts
export function buildChromeArgs(opts: {
  port: number;
  profileDir: string;
  headless: boolean;
  startUrl: string;
}): string[] {
  const args = [
    `--remote-debugging-port=${opts.port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    `--user-data-dir=${opts.profileDir}`,
  ];
  if (opts.headless) {
    args.push('--headless=new');
  }
  args.push(opts.startUrl);
  return args;
}
```

这说明当前实现是：

- **不是** Puppeteer `launch()`
- **不是** Playwright `chromium.launch()`
- **不是** 通过第三方库 attach
- **而是** 直接启动 Chrome 二进制，并要求它暴露 `--remote-debugging-port`

### 3.2 Chrome 路径发现

Chrome 路径优先级：

1. 显式传入 `chromePath`
2. 环境变量 `AIDCP_CHROME_PATH`
3. Windows 常见安装路径
4. macOS 默认路径 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`

证据：

```84:108:src/cdp/chrome-launcher.ts
 * 发现 chrome.exe 路径。优先级：
 * 1. 显式 chromePath / 环境变量 AIDCP_CHROME_PATH
 * 2. Windows 常见路径
 * 3. macOS 路径
 * 都找不到则抛出明确错误。
 */
export function discoverChromePath(
  explicit?: string,
  existsImpl: (p: string) => boolean = existsSync,
): string {
  const fromEnv = explicit ?? process.env.AIDCP_CHROME_PATH;
  if (fromEnv) {
    if (!existsImpl(fromEnv)) {
      throw new Error(`指定的 Chrome 路径不存在: ${fromEnv}`);
    }
    return fromEnv;
  }
  const candidates = [...windowsChromePaths(), ...macChromePaths()];
```

## 4. 连接参数怎么配

## 4.1 参数总表

| 参数 | 默认值 | 来源 | 用途 | 证据 |
|---|---|---|---|---|
| `AIDCP_CDP_HOST` | `127.0.0.1` | env | DevTools HTTP / WS 连接 host | `src/main.ts:48`、`src/cdp/targets.ts:28`、`src/cdp/chrome-launcher.ts:190` |
| `AIDCP_CDP_PORT` | `9222` | env | DevTools HTTP / WS 连接端口 | `src/main.ts:49`、`src/cdp/targets.ts:29`、`src/cdp/chrome-launcher.ts:191` |
| `AIDCP_PAGE_URL` | 无 | env | 只附着 URL 包含该子串的 page | `src/main.ts:50`、`src/main.ts:60-61`、`src/cdp/session.ts:22-26` |
| `AIDCP_CHROME_PATH` | 自动发现 | env | 指定 Chrome 可执行文件 | `src/main.ts:54`、`src/cdp/chrome-launcher.ts:24-25`、`src/cdp/chrome-launcher.ts:94-99` |
| `AIDCP_CHROME_PROFILE` | `~/.aidcp-chrome-profile` | env | 指定 `user-data-dir` | `src/main.ts:55`、`src/cdp/chrome-launcher.ts:26-27`、`src/cdp/chrome-launcher.ts:61`、`src/cdp/chrome-launcher.ts:192` |
| `AIDCP_CHROME_HEADLESS` | `false` | env | 是否 headless | `src/main.ts:56`、`src/cdp/chrome-launcher.ts:28-29`、`src/cdp/chrome-launcher.ts:193` |
| `AIDCP_EXPLORE_URL` | `https://www.xiaohongshu.com/explore` | env | 自动浏览起始页 | `src/main.ts:126`、`src/browse/browse-session.ts:94` |

### 4.2 当前没有 config 文件或 CLI 参数层

本次排查范围内，浏览器 / CDP 连接参数都来自：

- `process.env`
- `launchChrome()` / `attachToPage()` 的函数参数

没有发现：

- 独立 config 文件读取逻辑
- 命令行参数解析器（如 `commander` / `yargs`）
- `.json` / `.yaml` 配置装载

启动脚本也只是：

```10:15:package.json
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsx --test test/**/*.test.ts",
    "start": "tsx src/main.ts"
  },
```

### 4.3 默认端口与 endpoint 细节

- 默认 host：`127.0.0.1`
- 默认 port：`9222`
- 探测 endpoint：`http://host:port/json/version`
- target 列表 endpoint：`http://host:port/json`
- 实际 CDP 连接 endpoint：来自 target 的 `webSocketDebuggerUrl`

证据：

```115:123:src/cdp/chrome-launcher.ts
export async function probeCdp(
  host: string,
  port: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  if (!fetchImpl) throw new Error('global fetch 不可用（需 Node>=18）；请注入 fetchImpl');
  try {
    const res = await fetchImpl(`http://${host}:${port}/json/version`);
    return res.ok;
```

```27:33:src/cdp/targets.ts
export async function listTargets(options: DiscoverOptions = {}): Promise<CdpTarget[]> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 9222;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (!doFetch) throw new Error('global fetch 不可用（需 Node>=18）；请注入 fetchImpl');
  const res = await doFetch(`http://${host}:${port}/json`);
```

## 5. 登录态 / 用户 profile / cookie 现在怎么处理

### 5.1 当前方案：复用 `user-data-dir`，靠浏览器 profile 保持登录态

`chrome-launcher` 默认使用独立 profile 目录：

```59:63:src/cdp/chrome-launcher.ts
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9222;
const DEFAULT_PROFILE_DIR = join(homedir(), '.aidcp-chrome-profile');
const DEFAULT_START_URL = 'https://www.xiaohongshu.com/explore';
```

首次启动时，如果 profile 目录不存在，会提示人工登录：

```248:252:src/cdp/chrome-launcher.ts
  if (isFirstLaunch) {
    log('[aidcp-edge] 请在浏览器中登录小红书，登录完成后按 Enter 继续...');
    await waitForLogin();
  }
```

对应测试也明确验证了“首次启动等待登录、非首次不等待”：

```192:230:test/cdp/chrome-launcher.test.ts
test('launchChrome 首次启动（profile 不存在）等待人工登录', async () => {
  // ...
  await launchChrome({
    chromePath: 'C:/chrome.exe',
    profileDir: '/data/new-profile',
    // chrome 存在，但 profile 目录不存在 -> 首次启动
    existsImpl: (p) => p === 'C:/chrome.exe',
    waitForLoginImpl: async () => {
      waited = true;
    },
  });
  assert.equal(waited, true);
});

test('launchChrome 非首次启动（profile 已存在）不等待登录', async () => {
  // ...
  await launchChrome({
    chromePath: 'C:/chrome.exe',
    profileDir: '/data/profile',
    existsImpl: () => true,
    waitForLoginImpl: async () => {
      waited = true;
    },
  });
  assert.equal(waited, false);
});
```

### 5.2 没有发现 cookie 级别管理

本次对 `src/`、`docs/`、`test/` 的检索中，没有发现以下实现：

- `Network.getCookies` / `Network.setCookies`
- cookie 文件导入导出
- 登录态同步服务
- 小红书 token / session 专门管理器

因此当前登录态方案可以明确归纳为：

1. 让 Chrome 使用固定 `user-data-dir`
2. 人工在该 profile 中完成一次登录
3. 后续 edge 复用该 profile，沿用浏览器本地持久化的 cookie / storage / session

### 5.3 对“连接已有浏览器”的登录态含义

如果用户不是让 edge 自己启动，而是自己先手动启动一个带 `--remote-debugging-port` 的 Chrome，那么登录态同样来自那个浏览器实例所使用的 `--user-data-dir`。README 的示例就是这种模式：

```42:45:README.md
# 1) 以远程调试端口启动 Chrome
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/aidcp-profile
```

## 6. `src/main.ts` 启动时如何初始化浏览器 / CDP

启动顺序如下：

1. 读取 env：`AIDCP_CDP_HOST` / `AIDCP_CDP_PORT` / `AIDCP_PAGE_URL` / `AIDCP_CHROME_*`
2. 调用 `launchChrome()`：复用已有实例或启动新实例
3. 调用 `attachToPage()`：发现 page target，连接 `webSocketDebuggerUrl`
4. 启用 `Input` 域
5. 再装配云端 client、browse session、publish flow 等业务层

关键证据：

```52:67:src/main.ts
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

  await session.cdp.send('Input.enable').catch(() => undefined);
```

退出时只会 kill 自己启动的 Chrome；复用的实例不会被关闭：

```160:162:src/main.ts
    session.close();
    // 仅当 Chrome 由本进程启动时才 kill（复用的实例不动）
    chrome.kill();
```

结合 `launchChrome()` 的返回值设计（复用实例时 `kill` 是空操作），说明“连接已有浏览器”是正式支持的运行方式。证据见 `src/cdp/chrome-launcher.ts:204-208`、`src/cdp/chrome-launcher.ts:254-267`。

## 7. 反检测 / 拟人化模块与浏览器启动的关系

### 7.1 反检测分两层：启动参数 + attach 后脚本注入

第一层是 Chrome 启动参数：

```168:174:src/cdp/chrome-launcher.ts
    // —— 反检测启动参数（见 docs/anti-detection.md §1.1 / §4.1）——
    // 关闭 Blink 的 AutomationControlled 特征：使 navigator.webdriver 不再被置 true。
    '--disable-blink-features=AutomationControlled',
    // 去掉"正受到自动化控制"信息栏提示。
    '--disable-infobars',
    // 注意：刻意不加 --enable-automation（它会让 UA 暴露调试态、弹出自动化提示）。
    `--user-data-dir=${opts.profileDir}`,
```

第二层是 attach 后通过 `Page.addScriptToEvaluateOnNewDocument` 注入 stealth 脚本：

```256:264:src/cdp/stealth-injector.ts
  async inject(cdp: StealthCdp): Promise<void> {
    if (this.enablePageDomain) {
      await cdp.send('Page.enable').catch(() => undefined);
    }
    const res = await cdp.send<AddScriptResult>('Page.addScriptToEvaluateOnNewDocument', {
      source: this.scriptSource,
    });
    this.lastIdentifier = res?.identifier;
  }
```

`attachToPage()` 默认会自动注入：

```52:56:src/cdp/session.ts
  if (options.stealth !== false) {
    const injector = options.stealthInjector ?? new CdpStealthInjector();
    await injector.inject(cdp);
  }
```

### 7.2 拟人化模块不负责启动浏览器

`src/humanize/index.ts` 的职责是浏览执行层的随机化与节奏控制，不负责浏览器进程生命周期或 CDP 建连。浏览器启动 / 连接逻辑集中在 `src/cdp/` 与 `src/main.ts`。检索结果中也未发现 humanize 模块调用 `spawn`、`launch`、`connect`。

### 7.3 反检测与“连接已有浏览器”兼容

即使是连接用户手动启动的 Chrome，只要 edge 成功 attach 到 page，`attachToPage()` 仍会注入 stealth 脚本。因此：

- 手动启动浏览器时，启动参数层反检测是否生效，取决于用户是否自己带上对应 flags；
- attach 后脚本层反检测仍会由 edge 自动执行。

手动检查脚本也明确支持“先手动启动 Chrome，再附着检查 stealth”：

```11:18:test/manual/check-stealth.ts
 * 前置：先启动 Chrome（headful，建议）：
 *   chrome --remote-debugging-port=9222 --user-data-dir=<某 profile>
 * 或直接 `npm start` 让 chrome-launcher 拉起，再在另一个终端跑本脚本。
 *
 * 运行：
 *   npx tsx test/manual/check-stealth.ts
 *   # 可选：自定义检测站点
 *   AIDCP_STEALTH_CHECK_URL=https://bot.sannysoft.com npx tsx test/manual/check-stealth.ts
```

## 8. 文档 / 测试里对连接方式的说明

### 8.1 README

README 仍然主要展示“用户自己先启动一个带远程调试端口的 Chrome，再 attach”的接入方式：

```40:55:README.md
### 接入真实 Chrome

```bash
# 1) 以远程调试端口启动 Chrome
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/aidcp-profile

# 2) 在代码中附着到页面
```

```ts
import { attachToPage } from 'aidcp-edge';
import { LocatingEngine, AnchorCache /* ... */ } from 'aidcp-edge';

const session = await attachToPage({ host: '127.0.0.1', port: 9222 });
```

这和 `src/main.ts` 当前“自动启动 / 复用 Chrome”的行为相比，README 有一定滞后：README 更像库级接入说明，而不是 edge 进程运行说明。

### 8.2 测试

`test/cdp/chrome-launcher.test.ts` 已覆盖：

- 复用已有实例
- 端口空闲时 spawn
- 启动参数正确
- 首次启动等待人工登录
- 非首次启动不等待登录

这说明“自动启动 / 复用 Chrome + profile 登录态”是已实现且被测试覆盖的正式能力，而不是临时脚本。

### 8.3 现有联调文档

`docs/publish-e2e-checklist.md` 已经把“已登录浏览器 + CDP 远程调试端口”写成真机联调建议：

```338:347:docs/publish-e2e-checklist.md
1. 准备一个已登录小红书的浏览器用户目录
2. 以远程调试方式启动浏览器，例如带 CDP 端口
3. 打开目标站点并确认账号已登录、可进入创作相关页面
4. 清理可能干扰的弹窗、草稿恢复提示、风控提示
5. 记录起始 URL、域名、页面标题、是否 SPA

### 3.2 接入方式建议

- 使用“已登录浏览器 + CDP 远程调试端口”接入
```

## 9. 真机联调应该怎么接入一个“已登录小红书”的浏览器

基于当前实现，**最稳妥的接入方式是“用户自己先启动一个已登录 profile 的 Chrome，并暴露 remote debugging port；edge 只负责复用并 attach”**。这样可以避免 edge 首次启动时还要等待人工登录，也更符合真机联调场景。

### 9.1 推荐步骤（手动先起浏览器，再起 edge）

#### macOS 示例

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.aidcp-chrome-profile"
```

然后在该浏览器里：

1. 打开 `https://www.xiaohongshu.com/`
2. 确认账号已登录
3. 打开目标页面（建议先落到小红书首页、explore、或后续要联调的发布入口页）

再启动 edge：

```bash
AIDCP_CDP_HOST=127.0.0.1 \
AIDCP_CDP_PORT=9222 \
AIDCP_CHROME_PROFILE="$HOME/.aidcp-chrome-profile" \
npm start
```

说明：

- 因为 9222 端口已经有 Chrome 在监听，`launchChrome()` 会走“复用已有实例”分支，不会重复启动新浏览器。证据见 `src/cdp/chrome-launcher.ts:204-208`。
- 若需要只附着某个特定页面，可额外设置 `AIDCP_PAGE_URL`，例如：

```bash
AIDCP_CDP_HOST=127.0.0.1 \
AIDCP_CDP_PORT=9222 \
AIDCP_PAGE_URL=xiaohongshu.com \
npm start
```

### 9.2 备选步骤（让 edge 自己拉起浏览器）

如果本机还没有启动 Chrome，也可以直接：

```bash
AIDCP_CHROME_PROFILE="$HOME/.aidcp-chrome-profile" npm start
```

首次启动时 edge 会：

1. 自动启动 Chrome
2. 打开默认起始页 `https://www.xiaohongshu.com/explore`
3. 提示“请在浏览器中登录小红书，登录完成后按 Enter 继续...”

证据见 `src/cdp/chrome-launcher.ts:62`、`src/cdp/chrome-launcher.ts:248-252`。

但对“真机联调发布”来说，这种方式不如手动先起浏览器稳定，因为：

- 你通常希望先人工确认账号、页面、草稿态、风控态；
- 你可能希望使用一个明确准备好的 profile；
- 你可能希望先打开特定发布入口页，而不是默认 explore。

## 10. 现状离“真机联调发布”还差什么

### 10.1 已具备的基础能力

- 已具备 **连接真实 Chrome CDP** 的能力；
- 已具备 **自动启动或复用已有 Chrome** 的能力；
- 已具备 **复用固定 profile 保持登录态** 的能力；
- 已具备 **按 URL 过滤附着 page** 的基础能力；
- 已具备 **反检测启动参数 + attach 后 stealth 注入**；
- 已有相关单测与手动检查脚本。

### 10.2 主要缺口 / 风险

#### 缺口 1：没有“发布联调专用 attach 策略”

当前 `firstPageTarget()` 只会：

- 取第一个 page，或
- 取 URL 包含某子串的第一个 page

这对真机联调发布来说偏弱。若用户同时开了多个小红书 tab、多个站点 tab，可能 attach 到错误页面。证据见 `src/cdp/targets.ts:40-52`。

#### 缺口 2：没有显式登录态校验 / preflight

虽然 profile 可复用登录态，但 edge 启动后没有：

- 检查当前是否已登录小红书
- 检查是否落在正确域名
- 检查是否存在草稿恢复 / 风控 / 实名认证阻断

这部分目前只在 `docs/publish-e2e-checklist.md:312-347` 里作为联调 checklist 提醒，还没有固化成程序化 preflight。

#### 缺口 3：没有 cookie / session 级别的备份与迁移能力

当前登录态完全依赖 profile 目录。风险是：

- profile 损坏或被占用时，恢复成本高；
- 无法方便地在机器间迁移登录态；
- 无法做更细粒度的登录态诊断。

#### 缺口 4：README 与当前运行模式存在认知差

README 主要描述“手动启动 Chrome 后 attach”，但 `src/main.ts` 已经实现“自动启动 / 复用”。对后续联调同学来说，容易误解 edge 当前到底负责到哪一层。

#### 缺口 5：反检测启动参数在“手动先起浏览器”模式下依赖用户自觉

如果用户自己启动 Chrome 时没有带：

- `--disable-blink-features=AutomationControlled`
- `--disable-infobars`

那么只能依赖 attach 后脚本层 stealth，启动参数层的收益拿不到。对真实小红书页面联调可能有影响。证据见 `src/cdp/chrome-launcher.ts:168-174`。

## 11. 建议的真机联调 SOP（基于当前现状）

1. 准备一个专用 Chrome profile，例如 `~/.aidcp-chrome-profile`
2. 用该 profile 手动启动 Chrome，并显式打开 `--remote-debugging-port=9222`
3. 在浏览器中登录小红书，确认账号状态正常
4. 手动打开目标页面，并清理草稿恢复、弹窗、风控提示
5. 启动 edge，必要时设置 `AIDCP_PAGE_URL` 限定 attach 页面
6. 若怀疑反检测问题，可先运行 `npx tsx test/manual/check-stealth.ts` 做一次人工检查

推荐命令：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --disable-blink-features=AutomationControlled \
  --disable-infobars \
  --user-data-dir="$HOME/.aidcp-chrome-profile"
```

```bash
AIDCP_CDP_HOST=127.0.0.1 \
AIDCP_CDP_PORT=9222 \
AIDCP_PAGE_URL=xiaohongshu.com \
AIDCP_CHROME_PROFILE="$HOME/.aidcp-chrome-profile" \
npm start
```

## 12. 一句话判断

截至当前代码现状，`aidcp-edge` 的浏览器接入能力可以概括为：

> **基于原生 WebSocket CDP，优先复用已有 `--remote-debugging-port` Chrome，必要时自行启动一个带独立 `user-data-dir` 的 Chrome；登录态依赖 profile 复用，不做 cookie 级别管理。**