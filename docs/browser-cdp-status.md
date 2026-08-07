# aidcp-edge 浏览器 / CDP 现状盘点

> 🕒 **时点快照（原 2026-06-02 勘察）**：本文为某次勘察/联调记录，部分结论已随代码演进失效。**以代码为准**；下列与现状冲突处已就地更正/标注。

更新时间：2026-06-02

## 已完成能力 & 常见误判

- **「打开浏览器 → 访问小红书 → 浏览内容」这部分能力已实现且可用，属于已完成功能。** 后续联调或换开发机时，不要再把问题默认归因为“用户还没开浏览器 / 还没登录小红书”，也不要让用户重复执行这一步。
- 真发 / 联调时如果 edge 报 `未找到可用的 page target`，这通常**不是环境没就绪**，而是 edge 自身的 CDP target 发现 / 过滤逻辑没有命中，或 `spawn` 与复用实例发生错配：`9222` 上复用到的 Chrome，未必就是开着小红书登录页的那个实例。
- 正确排查顺序：
  1. 先执行 `curl http://127.0.0.1:9222/json/version` 和 `curl http://127.0.0.1:9222/json/list`，确认实际有哪些 target、`type`、`url`，以及是否存在 `webSocketDebuggerUrl`；
  2. 再对照代码里的 page target 过滤条件，确认是否因为 `type` / `url` 过滤过严，或命中了离屏副本等非预期 target；
  3. 最后判断 `9222` 复用到的 Chrome 实例，是否就是开着小红书登录页的那个实例；若实例错配，应连接正确实例，或改用正确的 `user-data-dir` / profile。
- 一句话原则：**遇到这类报错先查 edge 自身逻辑和实例复用，不要先把锅推给用户让其重开浏览器。**

## 结论摘要

- ⚠️ **结论已反转（以代码为准）**：`aidcp-edge` 现在 **默认自己拉起一个独立 Chrome（专用调试端口 + 独立 `user-data-dir`），并在探测到调试端口已被占用时「诚实拒绝」静默接管已在监听的 Chrome**——除非显式设置 `AIDCP_CDP_ALLOW_REUSE=true` 才走复用分支。旧文中“优先探测并复用已有实例”的框架已不成立。证据见 `chrome-launcher.ts` 顶部 doc 注释、`launchChrome()`（端口已占用且未开 `allowReuse` 时 `throw`，约 `chrome-launcher.ts:604-610`）、`src/main.ts` 的 `launchChrome(launchOpts)` 调用。
- CDP 接入层使用的是 **原生 WebSocket + DevTools HTTP `/json` / `/json/version`**，**没有引入 Playwright、Puppeteer、chrome-remote-interface**。证据见 `src/cdp/client.ts:2-7`、`src/cdp/index.ts:2-10`、`README.md:11-12`、`package.json:16-22`。
- 连接建立流程是：**先通过 `http://host:port/json` 找到 page target，取其 `webSocketDebuggerUrl`，再用原生 WebSocket 连接该 ws endpoint**；不是直接 launch 后拿库内 browser 对象。证据见 `src/cdp/targets.ts:2-6`、`src/cdp/targets.ts:27-53`、`src/cdp/session.ts:44-47`。
- 登录态当前依赖 **Chrome user-data-dir 持久化复用**，且 **每次启动都会主动校验登录态**（不再有“仅首次/profile 缺失才等待”的 `isFirstLaunch` 逻辑——该字段已删除）。校验口径见 `evaluateLoginState()` / `deriveLoginProbeResult()`：以 `web_session` cookie（httpOnly，经 `Network.getCookies` 读取）为主信号 + DOM 信号（导航头像、创作入口）兜底 + 登录弹窗一票否决；超时上限 `DEFAULT_LOGIN_TIMEOUT_MS = 5min`，手动回车仅作 TTY 兜底（`defaultWaitForLogin()`）。代码里仍**没有 cookie 导入/导出/注入逻辑**（`Network.setCookies` 未使用；`Network.getCookies` 仅做只读登录检测）。

## 1. 当前到底是“启动新浏览器”还是“连接已有浏览器”

### 1.1 实际行为：默认「自己拉起独立 Chrome」，端口被占用则诚实拒绝复用

> ⚠️ 本节结论相对原快照已反转。当前默认是 **edge 自己 spawn 一个独立 Chrome（专用调试端口 + 独立 `user-data-dir`）**；探测到调试端口上已有 Chrome 在监听时，**默认 `throw` 拒绝静默接管**，只有显式 `AIDCP_CDP_ALLOW_REUSE=true` 才走复用分支。下方旧版“先复用、后启动”的描述已不成立。
>
> 🔁 **再反转（change `adspower-browser-provider`）**：上面这段「edge 自己 spawn Chrome」只是 **`self` provider** 的行为；运行时**默认 provider 已是 `adspower`**（`AIDCP_BROWSER_PROVIDER` 缺省 = `adspower`，`src/cdp/browser-provider.ts` 的 `selectBrowserProvider`），由 AdsPower 本地 API 托管指纹浏览器、拿其 `debug_port` 交给现成 `attachToPage`。本节描述的 `launchChrome()` 自起/复用逻辑，仅在显式 `AIDCP_BROWSER_PROVIDER=self`（以及 `launch-multinode` / Electron 桌面版两条钉死 self 的路径）时才走。adspower 缺 `AIDCP_ADS_USER_ID` 时**诚实报错、绝不回落 self**。

`src/main.ts` 启动时先读取 CDP host/port，随后调用 `launchChrome()`，再调用 `attachToPage()`：

```text:src/main.ts (main() 启动段)
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

`launchChrome()`（`src/cdp/chrome-launcher.ts`）当前的实际策略是：

- 先 `GET /json/version` 探测端口（`probeCdp()`）；
- **若端口已被占用：默认 `throw` 诚实拒绝**（红线：绝不静默接管陌生浏览器、绝不假装成功）；仅当显式 `allowReuse`（环境变量 `AIDCP_CDP_ALLOW_REUSE` ∈ `1/true/yes`）时，才复用该实例（必要时 `ensurePageTarget()` 兜底新开标签 + 校验登录态）；
- **端口空闲（默认路径）：发现 Chrome 路径并 `spawn` 一个独立 `user-data-dir` 的新进程**，轮询 `/json/version` 直至就绪，再校验登录态。

```text:src/cdp/chrome-launcher.ts (launchChrome ~604)
  // 1) 端口上已有 Chrome：默认诚实拒绝静默接管（红线：绝不静默假成功）。
  if (await probeCdp(host, port, fetchImpl)) {
    if (!allowReuse) {
      throw new Error(
        `[aidcp-edge] 调试端口 ${host}:${port} 上已有 Chrome 在运行——拒绝静默接管陌生浏览器实例。` +
          `本节点须使用独立的调试端口与用户数据目录；如确属同一节点的有意复用，显式设置 AIDCP_CDP_ALLOW_REUSE=true。`,
      );
    }
    log(`[aidcp-edge] 检测到已有 Chrome 监听 ${host}:${port}（AIDCP_CDP_ALLOW_REUSE 已开启），复用实例`);
    await ensurePage(host, port, startUrl, fetchImpl, log);
    await waitForLogin({ /* 复用实例也需校验登录态 */ });
    return { pid: null, reused: true, kill: () => undefined, killAndConfirmDead: async () => true };
  }
```

> 其中 `allowReuse` 默认值取自 `opts.allowReuse ?? AIDCP_CDP_ALLOW_REUSE`；返回值 `ChromeInstance` 现新增 `killAndConfirmDead`（回收路径：终止本进程独占的 Chrome 并确认端口释放，复用实例为 no-op）。

端口空闲时（默认路径）才真正 `spawn` 启动 Chrome（注意：**已无 `isFirstLaunch` 分支**——无论是否首次，启动就绪后都统一 `waitForLogin()` 校验登录态）：

```text:src/cdp/chrome-launcher.ts (launchChrome 默认 spawn 分支)
  const chromePath = discoverChromePath(opts.chromePath, existsImpl);
  clearLock(profileDir, log); // 清理崩溃残留的单例锁（仅在确认无存活进程持有时清，否则诚实失败）
  const args = buildChromeArgs({ port, profileDir, headless, startUrl });

  log(`[aidcp-edge] 启动 Chrome: ${chromePath}`);
  const child: ChildProcess = spawnImpl(chromePath, args, {
    detached: false,
    stdio: ['ignore', 'ignore', 'pipe'],
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

`attachToPage()` 再把 `webSocketDebuggerUrl` 交给 `CdpClient`，连接后统一走 `reEnableAndInject()` 启用 CDP 域并注入反检测（重连后也复用同一函数；`Input.enable` 为坐标点击/按键所必需）：

```ts:src/cdp/session.ts attachToPage() / reEnableAndInject()
export async function attachToPage(options: AttachOptions = {}): Promise<EdgeSession> {
  const target = await firstPageTarget(options);
  const cdp = new CdpClient(target.webSocketDebuggerUrl, options.client);
  await cdp.connect();
  // 启用域 + 注入反检测，重连后也走同一函数重启用
  await reEnableAndInject(cdp, { stealth: options.stealth, injector });
  // ...
}

async function reEnableAndInject(cdp, opts) {
  await cdp.send('Runtime.enable').catch(() => undefined);
  await cdp.send('Page.enable').catch(() => undefined);
  await cdp.send('Input.enable').catch(() => undefined); // 坐标点击/按键所需
  if (opts.stealth !== false) await opts.injector.inject(cdp);
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

```ts:src/cdp/chrome-launcher.ts buildChromeArgs()
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

```ts:src/cdp/chrome-launcher.ts discoverChromePath()
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
| `AIDCP_CDP_ALLOW_REUSE` | `false` | env | 是否允许复用端口上已在监听的 Chrome（`1`/`true`/`yes` 视为开启）；默认诚实拒绝静默接管 | `src/cdp/chrome-launcher.ts` `launchChrome()`（`allowReuse` 约 597 行、端口占用判定约 604 行） |
| `AIDCP_CHROME_LOGIN_TIMEOUT_MS` | `300000`（5min） | env | 登录态等待超时；看护子进程可注入更短值 | `src/cdp/chrome-launcher.ts` `DEFAULT_LOGIN_TIMEOUT_MS`、`src/main.ts` `loginTimeoutMs` 注入 |
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

```ts:src/cdp/chrome-launcher.ts probeCdp()
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

```ts:src/cdp/chrome-launcher.ts 默认常量
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9222;
const DEFAULT_PROFILE_DIR = join(homedir(), '.aidcp-chrome-profile');
const DEFAULT_START_URL = 'https://www.xiaohongshu.com/explore';
```

> ⚠️ 原快照此处写的是“仅首次启动 / profile 目录不存在（`isFirstLaunch`）才等待人工登录、按 Enter 继续”。**该模型已废弃**——`isFirstLaunch` 字段已删除。

**当前模型：每次启动都自动校验登录态。** 无论是新建 profile 还是复用旧 profile，`launchChrome()` 在 Chrome 就绪后都会调用 `waitForLogin()`（`defaultWaitForLogin()`）轮询检测登录态，检测通过才继续；超时上限 `DEFAULT_LOGIN_TIMEOUT_MS = 5min`（`src/main.ts` 可经 `AIDCP_CHROME_LOGIN_TIMEOUT_MS` 注入更短值给看护子进程）。手动回车**仅作 TTY 兜底**（`shouldAllowManualEnterFallback()`：`AIDCP_LOGIN_WAIT_MODE=manual` 或 stdin 为 TTY 时才挂上 Enter 监听），不再是主路径。

登录态判定口径见 `evaluateLoginState()` + `deriveLoginProbeResult()`：

- **主正信号**：`web_session` cookie（httpOnly，经 CDP `Network.getCookies` 读取，显式限定 `urls: xiaohongshu.com`）；
- **DOM 兜底**：导航区用户头像 && 创作入口（“创作中心/发布笔记/我的主页”），仅在读不到 `web_session` 时挽救，避免死等；
- **一票否决**（高于所有正信号）：URL 含 `/login`，或页面出现登录弹窗（扫码/手机号/验证码登录等）——即便 `web_session` 残留但已失效也判未登录。

### 5.2 没有 cookie 级别的写入/迁移管理（但已有只读 cookie 探测）

> ⚠️ 更正：原快照说 `Network.getCookies` 也“未发现”。现在 **`Network.getCookies` 已被使用**——`evaluateLoginState()` 用它只读地读取 httpOnly 的 `web_session` cookie 来判定登录态。

仍然没有以下实现（不构成 cookie 级别的写入/迁移能力）：

- `Network.setCookies`（写入/注入 cookie）——仍未使用；
- cookie 文件导入导出；
- 登录态同步服务；
- 小红书 token / session 专门管理器。

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
2. 调用 `launchChrome()`：**默认 spawn 一个独立 Chrome**（端口被占用且未开 `AIDCP_CDP_ALLOW_REUSE` 时诚实拒绝；就绪后统一校验登录态）
3. 调用 `attachToPage()`：发现 page target，连接 `webSocketDebuggerUrl`，并在内部 `reEnableAndInject()` 中启用 `Runtime` / `Page` / **`Input`** 域 + 注入反检测（与断线重连共用同一路径）
4. 从登录态读出本节点真实账号 id（`readSelfIdentity` + `decideHandshakeIdentity`）作为握手身份
5. 再装配云端 client、browse session、publish flow 等业务层

关键证据：

```text:src/main.ts (main() 装配段)
  const launchOpts: Parameters<typeof launchChrome>[0] = { host: cdpHost, port: cdpPort };
  if (process.env.AIDCP_CHROME_PATH) launchOpts.chromePath = process.env.AIDCP_CHROME_PATH;
  if (process.env.AIDCP_CHROME_PROFILE) launchOpts.profileDir = process.env.AIDCP_CHROME_PROFILE;
  if (process.env.AIDCP_CHROME_HEADLESS === 'true') launchOpts.headless = true;
  const chrome = await launchChrome(launchOpts);

  const attachOpts: Parameters<typeof attachToPage>[0] = { host: cdpHost, port: cdpPort };
  if (pageUrl) attachOpts.urlIncludes = pageUrl;
  const session = await attachToPage(attachOpts);
  // Runtime/Page/Input 域启用 + 反检测注入均在 attachToPage 内（reEnableAndInject，与断线重连共用）。
```

退出 / 回收时**仅当本进程独占（非复用）该 Chrome 才回收**；复用实例只诚实退出，绝不回收外部浏览器：

```text:src/main.ts (shutdown 路径)
    session.close();
    // ③ 仅当本进程独占（非复用）才回收：杀进程并确认端口/登录锁释放（超时升级 SIGKILL）。
    if (chrome.reused) {
      console.log('[aidcp-edge] 复用模式：只诚实退出，不回收本进程不拥有的外部 Chrome');
    } else {
      const freed = await chrome.killAndConfirmDead();
      // freed=false：升级 SIGKILL 后端口仍未确认释放，继续退出（看护重起时由 clearStaleSingletonLock 再判活）。
    }
```

注意：回收已从早期“无条件 `chrome.kill()`”改为 **`chrome.reused` 分支 + `killAndConfirmDead()`**（优雅 SIGTERM → 轮询端口 → 必要时升级 SIGKILL 并确认调试端口释放）。复用实例的 `kill` / `killAndConfirmDead` 均为 no-op。证据见 `src/cdp/chrome-launcher.ts` 的 `ChromeInstance` / `launchChrome()` 返回值、`src/main.ts` 的 `shutdown()`。

## 7. 反检测 / 拟人化模块与浏览器启动的关系

### 7.1 反检测分两层：启动参数 + attach 后脚本注入

第一层是 Chrome 启动参数：

```ts:src/cdp/chrome-launcher.ts buildChromeArgs() 反检测参数
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

`attachToPage()` 默认会自动注入（在 `reEnableAndInject()` 内，与 `Input.enable` 同处）：

```ts:src/cdp/session.ts reEnableAndInject()
  await cdp.send('Input.enable').catch(() => undefined);
  if (opts.stealth !== false) await opts.injector.inject(cdp); // injector 由 attachToPage 创建并传入
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

`test/cdp/chrome-launcher.test.ts` 已覆盖（节选，以测试名为准）：

- **探测到端口已有 Chrome 时默认诚实报错（拒绝静默接管，不 spawn）**；
- **显式 `allowReuse` 时才复用已有实例**；
- 端口空闲时 spawn 并传入正确参数（含反检测参数、不含 `--enable-automation`）；
- 自己启动的实例 `kill` 会真正调用 `child.kill`；
- **非首次启动（profile 已存在）仍验证登录态**（不再是“非首次不等待登录”）；
- 登录态判定：`web_session` 命中即已登录、登录提示一票否决、`/login` URL 一律未登录、`getCookies` 限定 xiaohongshu 作用域、失败退回 DOM 信号兜底；
- `ensurePageTarget` 在复用实例无可用标签时 PUT/GET 新开标签；
- `clearStaleSingletonLock` 的清理 / 诚实失败分支。

这说明“默认 spawn 独立 Chrome（端口占用诚实拒绝 / 显式才复用）+ 每次启动校验登录态”是已实现且被测试覆盖的正式能力，而不是临时脚本。

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

> ⚠️ 接入方式相对原快照已变更。**默认推荐：直接 `npm start` 让 edge 自己拉起一个独立 Chrome（专用调试端口 + 独立 `user-data-dir`），首登在该窗口扫码即可，登录态自动检测后续跑。** 因为 edge 默认会**诚实拒绝**接管已在监听调试端口的陌生 Chrome，原先“先手动起 Chrome 于 9222 再 `npm start`”的配方在默认配置下会直接报错退出。

若确需复用一个你手动启动并已登录的 Chrome（同一节点的有意复用），**必须显式设置 `AIDCP_CDP_ALLOW_REUSE=true`**，否则 edge 会因端口被占用而拒绝启动。

### 9.1 备选步骤（手动先起浏览器，再让 edge 复用）

> 仅当你确需复用一个已手动启动并登录好的 Chrome 时用本节，且**必须带 `AIDCP_CDP_ALLOW_REUSE=true`**，否则 edge 会因 9222 端口被占用而拒绝启动。多节点同机务必各用独立调试端口 + 独立 `user-data-dir`。

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

再启动 edge（**注意 `AIDCP_CDP_ALLOW_REUSE=true` 不可省略**）：

```bash
AIDCP_CDP_ALLOW_REUSE=true \
AIDCP_CDP_HOST=127.0.0.1 \
AIDCP_CDP_PORT=9222 \
AIDCP_CHROME_PROFILE="$HOME/.aidcp-chrome-profile" \
npm start
```

说明：

- 9222 端口已有 Chrome 在监听时，`launchChrome()` 默认会 `throw` 拒绝静默接管；只有显式 `AIDCP_CDP_ALLOW_REUSE=true` 才走复用分支（复用前会 `ensurePageTarget()` 兜底新开标签 + 校验登录态）。证据见 `src/cdp/chrome-launcher.ts` 的 `launchChrome()`（端口占用判定约 604 行）。
- 若需要只附着某个特定页面，可额外设置 `AIDCP_PAGE_URL`，例如：

```bash
AIDCP_CDP_ALLOW_REUSE=true \
AIDCP_CDP_HOST=127.0.0.1 \
AIDCP_CDP_PORT=9222 \
AIDCP_PAGE_URL=xiaohongshu.com \
npm start
```

### 9.2 推荐步骤（默认：让 edge 自己拉起浏览器）

最简单、也是默认推荐的方式——直接：

```bash
AIDCP_CHROME_PROFILE="$HOME/.aidcp-chrome-profile" npm start
```

启动时 edge 会：

1. 自动 spawn 一个独立 Chrome（专用调试端口 + 独立 `user-data-dir`）
2. 打开默认起始页 `https://www.xiaohongshu.com/explore`
3. **自动检测登录态**：未登录时打印“请在浏览器中登录小红书，系统将自动检测登录态后继续”，你在该窗口扫码登录即可；检测到 `web_session` / 登录信号后自动继续（超时 5min）。手动回车仅在 TTY 下作兜底。

证据见 `src/cdp/chrome-launcher.ts` 的 `DEFAULT_START_URL` / `launchChrome()` 默认 spawn 分支、`defaultWaitForLogin()` / `evaluateLoginState()`。

真机联调发布时，你仍可在该 edge 拉起的窗口里人工确认账号、页面、草稿态、风控态；若希望落到特定发布入口页而非默认 explore，可设置 `AIDCP_EXPLORE_URL` / `AIDCP_PAGE_URL`。只有在“必须复用一个已经手动起好的 Chrome”时，才退回 §9.1 并显式 `AIDCP_CDP_ALLOW_REUSE=true`。

## 10. 现状离“真机联调发布”还差什么

### 10.1 已具备的基础能力

- 已具备 **连接真实 Chrome CDP** 的能力；
- 已具备 **默认自动 spawn 独立 Chrome（专用调试端口 + 独立 `user-data-dir`）** 的能力；端口被占用时诚实拒绝，显式 `AIDCP_CDP_ALLOW_REUSE=true` 才复用；
- 已具备 **复用固定 profile 保持登录态 + 每次启动自动校验登录态**（`web_session` cookie + DOM 信号 + 登录弹窗否决）的能力；
- 已具备 **按 URL 过滤附着 page** 的基础能力；
- 已具备 **反检测启动参数 + attach 后 stealth 注入**；
- 已具备 **登录弹窗 / 验证码 / 未知阻断的旁路监测**（`CdpOverlayMonitor`，命中即本地暂停并按类上报云端）；
- 已有相关单测与手动检查脚本。

### 10.2 主要缺口 / 风险

#### 缺口 1：没有“发布联调专用 attach 策略”

当前 `firstPageTarget()` 只会：

- 取第一个 page，或
- 取 URL 包含某子串的第一个 page

这对真机联调发布来说偏弱。若用户同时开了多个小红书 tab、多个站点 tab，可能 attach 到错误页面。证据见 `src/cdp/targets.ts:40-52`。

#### 缺口 2（已大幅收口）：登录态校验 / 阻断检测已程序化

> ⚠️ 原快照说“没有显式登录态校验 / preflight”——**已不成立**。当前已有：

- ✅ **启动即校验是否已登录小红书**：`evaluateLoginState()`（`web_session` cookie + 导航头像/创作入口 DOM 信号），未登录则 `waitForLogin()` 阻塞等待至超时；
- ✅ **登录弹窗 / 验证码 / 未知阻断检测**：`CdpOverlayMonitor` 后台持续判类（login/captcha/unknown），命中即本地暂停、必要时上报云端（`captcha.detected`，词汇批 7 前旧名 `risk.captcha_detected`）；
- 仍偏弱：未单独做“正确域名/落地页”硬校验，也未单独识别“草稿恢复 / 实名认证”等具体阻断子类（这部分仍以 `docs/publish-e2e-checklist.md` 的联调 checklist 提醒为主）。

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

> ⚠️ 原快照的 SOP（先手动起 9222 上的 Chrome 再 `npm start`）在默认配置下会**失败**——端口被占用会触发诚实拒绝。下面以「让 edge 自己拉起独立 Chrome」为默认路径。

**默认路径（推荐）：让 edge 自己拉起独立 Chrome**

1. 准备/指定一个专用 `user-data-dir`，例如 `~/.aidcp-chrome-profile`（首次为空也可，扫码登录后即持久化）
2. 直接启动 edge，让它 spawn 独立 Chrome（反检测启动参数由 `buildChromeArgs()` 自动带上，无需手填 flag）
3. 在 edge 拉起的窗口里登录小红书并确认账号状态——edge 会自动检测登录态后继续（超时 5min）
4. 必要时设置 `AIDCP_EXPLORE_URL` / `AIDCP_PAGE_URL` 落到特定页面
5. 若怀疑反检测问题，可另起终端跑 `npx tsx test/manual/check-stealth.ts` 做一次人工检查

```bash
AIDCP_CHROME_PROFILE="$HOME/.aidcp-chrome-profile" \
AIDCP_EXPLORE_URL=https://www.xiaohongshu.com/explore \
npm start
```

**备选路径：复用一个你手动起好的已登录 Chrome（必须开 reuse 开关）**

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --disable-blink-features=AutomationControlled \
  --disable-infobars \
  --user-data-dir="$HOME/.aidcp-chrome-profile"
```

```bash
AIDCP_CDP_ALLOW_REUSE=true \
AIDCP_CDP_HOST=127.0.0.1 \
AIDCP_CDP_PORT=9222 \
AIDCP_PAGE_URL=xiaohongshu.com \
AIDCP_CHROME_PROFILE="$HOME/.aidcp-chrome-profile" \
npm start
```

（省略 `AIDCP_CDP_ALLOW_REUSE=true` 时，edge 会因 9222 端口被占用而拒绝启动。）

## 12. 一句话判断

截至当前代码现状，`aidcp-edge` 的浏览器接入能力可以概括为：

> **基于原生 WebSocket CDP，默认自行 spawn 一个带专用调试端口 + 独立 `user-data-dir` 的 Chrome；探测到端口已被占用时诚实拒绝静默接管，仅 `AIDCP_CDP_ALLOW_REUSE=true` 才复用。登录态依赖 profile 复用，且每次启动都自动校验（`web_session` cookie + DOM 信号 + 登录弹窗否决），仍不做 cookie 级别的写入/迁移管理。**