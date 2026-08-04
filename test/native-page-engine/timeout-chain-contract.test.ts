import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// change restore-facebook-post-join-comment-continuity
//
// 同一条命令的时间上限**分布在四层**，且跨两种语言：
//   ① 请求值   src/native-page-engine/browse-session.ts
//   ② 准入校验 src/native-page-engine/client.ts        （超上限 ⇒ invalid_request，命令根本不下发）
//   ③ 会话超时 src/native-page-engine/runtime.ts       （引擎取 session.min(ceiling)，小了就**静默夹回**）
//   ④ 引擎天花板 native/page-engine/src/engine.rs
//
// 四层任缺其一都**不会有编译错误**，`npm run typecheck` 也完全无感，但失败形态截然不同：
//   漏 ② ⇒ 命令毫秒级被拒（2026-07-29 真机：每次首帖开帖都被拒，云端却报「群内没有可评论帖子」）；
//   漏 ③ ⇒ 看着改了其实没生效，天花板被悄悄夹回旧值，没有任何日志。
//
// 本文件按**源码字面量**对账，不 import 常量——因为 ①②③ 都是模块私有、④ 还在 Rust 里。
// 这是这类跨语言常量组唯一可机械化的守卫。

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), 'utf8');

/** 取 `const NAME ... = 12_345;`（TS 与 Rust 同形），剥掉注释防止说明文字里的数字被当成定义。 */
function constMs(source: string, name: string): number {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const match = new RegExp(`\\b${name}\\b[^=\\n]*=\\s*([0-9_]+)`).exec(stripped);
  assert.ok(match, `未在源码中找到常量 ${name}——常量被改名时本守卫必须当场失败，而不是静默放行`);
  return Number(match![1]!.replace(/_/g, ''));
}

function durationMs(source: string, name: string): number {
  const secs = new RegExp(`\\b${name}\\b[^=\\n]*=\\s*Duration::from_secs\\((\\d+)\\)`).exec(source);
  if (secs) return Number(secs[1]) * 1_000;
  const millis = new RegExp(`\\b${name}\\b[^=\\n]*=\\s*Duration::from_millis\\(([0-9_]+)\\)`)
    .exec(source);
  assert.ok(millis, `未在源码中找到 Duration 常量 ${name}`);
  return Number(millis![1]!.replace(/_/g, ''));
}

/** 取 `const NAME: usize = 8;` 这类计数常量。 */
function countConst(source: string, name: string): number {
  const match = new RegExp(`\\b${name}\\b[^=\\n]*=\\s*([0-9_]+)`).exec(source);
  assert.ok(match, `未在源码中找到计数常量 ${name}`);
  return Number(match![1]!.replace(/_/g, ''));
}

const browseSession = read('src/native-page-engine/browse-session.ts');
const client = read('src/native-page-engine/client.ts');
const runtime = read('src/native-page-engine/runtime.ts');
const engine = read('native/page-engine/src/engine.rs');
const facebookFeed = read('native/page-engine/src/facebook/feed.rs');
const facebookReels = read('native/page-engine/src/facebook/reels.rs');
const facebookShared = read('native/page-engine/src/facebook/shared.rs');
const facebookRuntime = read('native/page-engine/src/facebook/runtime.rs');
const facebookSession = read('native/page-engine/src/facebook/session.rs');

/** 每个命令族：① 请求值 → ② 准入上限 → ④ 引擎天花板。 */
const FAMILIES = [
  {
    name: 'Feed 滚动',
    request: constMs(browseSession, 'FACEBOOK_FEED_SCROLL_TIMEOUT_MS'),
    admission: constMs(client, 'MAX_FACEBOOK_FEED_SCROLL_TIMEOUT_MS'),
    ceiling: constMs(engine, 'FACEBOOK_FEED_SCROLL_TIMEOUT_MS'),
  },
  {
    name: '加群',
    request: constMs(browseSession, 'FACEBOOK_GROUP_JOIN_TIMEOUT_MS'),
    admission: constMs(client, 'MAX_FACEBOOK_GROUP_JOIN_TIMEOUT_MS'),
    ceiling: constMs(engine, 'FACEBOOK_GROUP_JOIN_TIMEOUT_MS'),
  },
  {
    name: '首帖开帖',
    request: constMs(browseSession, 'FACEBOOK_FIRST_POST_OPEN_TIMEOUT_MS'),
    admission: constMs(client, 'MAX_FACEBOOK_FIRST_POST_OPEN_TIMEOUT_MS'),
    ceiling: constMs(engine, 'FACEBOOK_FIRST_POST_OPEN_TIMEOUT_MS'),
  },
  {
    name: 'Facebook 未专门化命令',
    request: constMs(browseSession, 'FACEBOOK_DEFAULT_COMMAND_TIMEOUT_MS'),
    admission: constMs(client, 'MAX_FACEBOOK_DEFAULT_COMMAND_TIMEOUT_MS'),
    ceiling: constMs(engine, 'FACEBOOK_DEFAULT_COMMAND_TIMEOUT_MS'),
  },
  {
    name: '普通命令（默认档）',
    request: constMs(browseSession, 'DEFAULT_NATIVE_COMMAND_TIMEOUT_MS'),
    admission: constMs(client, 'MAX_NATIVE_TIMEOUT_MS'),
    ceiling: constMs(engine, 'DEFAULT_COMMAND_TIMEOUT_MS'),
  },
];

const protocol = read('native/page-engine/src/protocol.rs');

/**
 * 剥掉 Rust 注释。**必须剥**：本文件解析的两处（平台枚举、准入 match）上方都有文档注释，
 * 而那些注释里逐字出现平台名与常量名——不剥就会把说明文字解析成定义。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** 引擎认得的平台**全集**（`pub enum Platform` 的变体）。守卫的覆盖面以它为准，不另抄一份。 */
function platformVariants(source: string): string[] {
  const match = /pub enum Platform\s*\{([^}]*)\}/.exec(stripComments(source));
  assert.ok(match, '未找到 Platform 枚举 —— 参照物没了，本闸失去意义');
  return match![1]!.split(',').map((part) => part.trim()).filter(Boolean);
}

/** `session.open` 准入的 match 臂：平台变体 → 它实际受哪条准入常量约束。 */
function admissionArms(source: string): Map<string, string> {
  const body = /const fn session_open_timeout_admission[^{]*\{([\s\S]*?)\n\}/
    .exec(stripComments(source));
  assert.ok(body, '未找到 session.open 准入函数 —— 它被改名或改写时本闸必须当场失败，而不是静默放行');
  const arms = new Map<string, string>();
  for (const arm of body![1]!.matchAll(/Platform::(\w+)\s*=>\s*([A-Z][A-Z0-9_]*)/g)) {
    arms.set(arm[1]!, arm[2]!);
  }
  return arms;
}

const facebookSessionTimeout = constMs(runtime, 'FACEBOOK_NATIVE_SESSION_TIMEOUT_MS');

/**
 * **每条平台道**的会话超时链。上一次事故的形态是：宿主把默认道的会话超时抬了，
 * 引擎默认道的准入没跟上 ⇒ 小红书与微信视频号的 `session.open` 全被门口拒掉六天，
 * 而当时的守卫五条断言**全在 Facebook 那条道上**，一路是绿的。
 *
 * `platforms` 用的是 Rust `Platform` 变体名 —— 与引擎准入 match 臂同一套标识，
 * 好让「守卫覆盖了哪些平台」可以被机械核对，而不是又一份手抄名单。
 */
const SESSION_LANES = [
  {
    name: 'Facebook 道',
    platforms: ['Facebook'],
    sessionTimeout: facebookSessionTimeout,
    edgeAdmission: constMs(client, 'MAX_FACEBOOK_SESSION_TIMEOUT_MS'),
    engineAdmissionConst: 'MAX_FACEBOOK_TIMEOUT_MS',
    clampableCeilings: (): number[] => [
      ...FAMILIES.map((family) => family.ceiling),
      constMs(engine, 'FACEBOOK_COMMENT_TIMEOUT_MS'),
      constMs(engine, 'FACEBOOK_PUBLISH_SELECT_MODE_TIMEOUT_MS'),
    ],
  },
  {
    name: '默认道（小红书 / 微信视频号）',
    platforms: ['Xiaohongshu', 'WechatChannels'],
    sessionTimeout: constMs(runtime, 'DEFAULT_NATIVE_SESSION_TIMEOUT_MS'),
    edgeAdmission: constMs(client, 'MAX_NATIVE_TIMEOUT_MS'),
    engineAdmissionConst: 'MAX_TIMEOUT_MS',
    clampableCeilings: (): number[] => [constMs(engine, 'DEFAULT_COMMAND_TIMEOUT_MS')],
  },
];

const READY_MS = durationMs(facebookShared, 'FACEBOOK_READY_TIMEOUT');
const READY_FIRST_PROBE_MS = durationMs(facebookShared, 'FACEBOOK_READY_FIRST_PROBE_DELAY');
const READY_INTERVAL_MS = durationMs(facebookShared, 'FACEBOOK_READY_PROBE_INTERVAL');
/** 一次**顺利**导航的就绪开销：首探前置 + 一轮间隔的抖动余量。 */
const READY_NOMINAL_MS = READY_FIRST_PROBE_MS + READY_INTERVAL_MS;

test('Facebook 文档就绪窗只有一个，且没有调用点自带窗口', () => {
  // 前一版把 30s 只给了 Reels 入口，其余十三处留在 8s——于是会话首屏扫描照旧 8s 判死，
  // 同一条缺陷换个入口又发作。改成「窗口不进签名」之后，漂移就不再需要靠人去逐处核对。
  // 只看生产段：Rust 单测里逐字写着同一个字面量（它们也在守这件事），连测试一起扫会自证失败。
  const productionOnly = (source: string): string => source.split('#[cfg(test)]')[0]!;
  const nativeFacebook = [facebookFeed, facebookReels, facebookShared, facebookRuntime, facebookSession]
    .map(productionOnly);
  for (const source of nativeFacebook) {
    assert.ok(
      !/wait_for_facebook_ready\(session,/.test(source),
      '就绪等待 MUST NOT 接受调用点传入的窗口——那正是上一轮漂移的入口',
    );
  }
  assert.equal(READY_MS, 30_000, '共用文档就绪窗必须是 30s');
  assert.equal(READY_FIRST_PROBE_MS, 3_000, '首探前置等待必须是 3s');
  assert.equal(READY_INTERVAL_MS, 2_000, '首探之后的探测间隔必须是 2s');
  assert.ok(
    READY_FIRST_PROBE_MS < READY_MS,
    '首探前置等待若吃满整个窗口，这个等待就一次也探不到',
  );
});

/**
 * 各族「最坏内层链 ≤ 本族外层预算」。
 *
 * 模型口径（写死在这里，改窗口时必须重算）：**一条命令里只按一次病态就绪计**——
 * 就绪窗跑满 30s 的那次必然以失败告终、命令当场收尾；其余导航按顺利情形计
 * （首探 3s + 一轮间隔）。两次同时病态的命令会撞上外层墙钟，拿到的是合成超时而不是具名回执；
 * 这一档**明确接受**：那种形态下命令本来就要失败，且滚动 / 开帖类失败是非终局、云端会重驱。
 */
const INNER_CHAINS = [
  {
    name: '首屏扫描（Feed 滚动族）',
    family: 'Feed 滚动',
    waits: () => READY_MS
      + durationMs(facebookShared, 'FACEBOOK_FEED_SETTLE_NAV')
      + countConst(facebookShared, 'FACEBOOK_FEED_SCROLL_ROUNDS')
        * durationMs(facebookShared, 'FACEBOOK_FEED_SETTLE_IN_PLACE')
      + durationMs(facebookShared, 'FACEBOOK_IDENTITY_COMMAND_BUDGET'),
  },
  {
    name: 'Reels 入口（Feed 滚动族）',
    family: 'Feed 滚动',
    waits: () => READY_MS + READY_NOMINAL_MS
      + durationMs(facebookReels, 'FACEBOOK_REEL_IDENTITY_HYDRATION_TIMEOUT') * 2,
  },
  {
    name: '详情开帖',
    family: 'Facebook 未专门化命令',
    waits: () => READY_MS + durationMs(facebookShared, 'FACEBOOK_DETAIL_HYDRATION_TIMEOUT'),
  },
  {
    name: '首页刷新（两次导航）',
    family: 'Facebook 未专门化命令',
    waits: () => READY_MS + READY_NOMINAL_MS
      + durationMs(facebookShared, 'FACEBOOK_FEED_SETTLE_IN_PLACE') * 2,
  },
  {
    name: '搜索',
    family: 'Facebook 未专门化命令',
    waits: () => READY_MS
      + durationMs(facebookShared, 'FACEBOOK_FEED_SETTLE_NAV')
      + countConst(facebookShared, 'FACEBOOK_FEED_SCROLL_ROUNDS')
        * durationMs(facebookShared, 'FACEBOOK_FEED_SETTLE_IN_PLACE'),
  },
  {
    name: '群内首帖开帖（含一次纠正导航）',
    family: '首帖开帖',
    waits: () => READY_MS + READY_NOMINAL_MS * 2
      + durationMs(facebookShared, 'FACEBOOK_GROUP_ROOT_LANDING_TIMEOUT') * 2
      + durationMs(facebookRuntime, 'FIRST_POST_EDITOR_TIMEOUT')
      + durationMs(facebookRuntime, 'FIRST_POST_DETAIL_TIMEOUT'),
  },
];

test('每条内层链在其所属命令族的预算内留得下诚实回执', () => {
  const receiptMarginMs = 10_000;
  for (const chain of INNER_CHAINS) {
    const family = FAMILIES.find((entry) => entry.name === chain.family);
    assert.ok(family, `${chain.name}：找不到所属命令族 ${chain.family}`);
    const total = chain.waits() + receiptMarginMs;
    assert.ok(
      total <= family!.request,
      `${chain.name}：具名内层链 + 回执余量 ${total}ms > ${chain.family} 请求预算 ${family!.request}ms`
        + '（外层先到点 ⇒ 具名失败被改判成合成超时）',
    );
    assert.ok(
      family!.request <= facebookSessionTimeout,
      `${chain.family}：请求 ${family!.request}ms 会被 Facebook 会话上限 ${facebookSessionTimeout}ms 静默夹回`,
    );
  }
});

test('每个 Facebook 命令族的请求值都能穿过准入校验与引擎天花板', () => {
  for (const family of FAMILIES) {
    assert.ok(
      family.request <= family.admission,
      `${family.name}：请求 ${family.request}ms > 准入上限 ${family.admission}ms ⇒ 命令会被判 invalid_request、根本不下发`,
    );
    assert.ok(
      family.request <= family.ceiling,
      `${family.name}：请求 ${family.request}ms > 引擎天花板 ${family.ceiling}ms ⇒ 预算被夹回，放宽无效`,
    );
  }
});

test('每条平台道的会话超时都必须同时穿过边缘准入与引擎协议准入', () => {
  // 这两道是「四处同步」之外的第 ⑤⑥ 处，2026-07-29 清点才发现：
  //   - 边缘 openSession 会拿会话超时去过 validateProbeInput（曾复用加群上限）；
  //   - 引擎 protocol.rs 在入口再卡一次。
  // 任一处小于会话超时，失败形态都不是「某条命令变慢」，而是 session.open 直接被拒、
  // **那个平台一条命令都发不出去**。
  //
  // ⚠️ 本条 2026-07-29 加进来时只验了 Facebook 那条道，而回归恰好落在默认道上：
  // 默认道会话超时 30_000 → 45_000，引擎默认道准入留在 30_000，小红书与微信视频号
  // 全线不可用六天，本文件一路是绿的。**逐道验，不是逐平台验。**
  for (const lane of SESSION_LANES) {
    const engineAdmission = constMs(protocol, lane.engineAdmissionConst);
    assert.ok(
      lane.sessionTimeout <= lane.edgeAdmission,
      `${lane.name}：会话超时 ${lane.sessionTimeout}ms > 边缘准入 ${lane.edgeAdmission}ms`
      + ' ⇒ openSession 抛 invalid_request，该道全线不可用',
    );
    assert.ok(
      lane.sessionTimeout <= engineAdmission,
      `${lane.name}：会话超时 ${lane.sessionTimeout}ms > 引擎协议准入 ${engineAdmission}ms`
      + `（${lane.engineAdmissionConst}）⇒ session.open 被引擎门口拒，该道全线不可用`,
    );
  }
});

test('引擎准入特判的平台集合必须与守卫覆盖的平台道逐一对应', () => {
  // 这条才是上一次事故的真修复。只把某个常量抬上去，是把同一枚地雷挪到下一个平台：
  // 守卫的道表若是手抄的，它在「新增平台没被覆盖」时恰好是绿的（memory hand-copied-name-lists）。
  // 所以覆盖面不由本文件声明，而是从引擎源码里读出来对账。
  const variants = platformVariants(protocol);
  const arms = admissionArms(protocol);
  const covered = new Map<string, { laneName: string; constName: string }>();
  for (const lane of SESSION_LANES) {
    for (const platform of lane.platforms) {
      covered.set(platform, { laneName: lane.name, constName: lane.engineAdmissionConst });
    }
  }

  for (const variant of variants) {
    assert.ok(
      arms.has(variant),
      `平台 ${variant} 没有在 session.open 准入里选过道 —— 带兜底 else 的写法会让它静默落进默认道`,
    );
    assert.ok(
      covered.has(variant),
      `平台 ${variant} 没有对应的守卫道 —— 它的会话超时链无人对账，正是上一次停摆六天的形态`,
    );
  }
  for (const [variant, constName] of arms) {
    const lane = covered.get(variant);
    assert.ok(lane, `平台 ${variant} 在引擎准入里选了 ${constName}，守卫却没有覆盖它的道`);
    assert.equal(
      constName,
      lane!.constName,
      `平台 ${variant}：引擎按 ${constName} 准入，守卫却按 ${lane!.constName} 对账 ⇒ 验的不是同一个数`,
    );
  }
  for (const variant of covered.keys()) {
    assert.ok(
      variants.includes(variant),
      `守卫道表里的 ${variant} 已不在引擎的平台枚举里 —— 覆盖率看着满，其实在空转`,
    );
  }
});

test('评论提交前预留必须装得下它自己那一段，且给回执留余量', () => {
  // 预留 = 命令死线里**扣给提交段**的时间；它必须装下「回读 + 就地确认」，还要剩下够把回执交出去。
  // 这条不变式在原值上就是破的（12s 恰好等于 3s + 9s，零余量），机械 ×1.5 后仍是零余量。
  const comment = read('native/page-engine/src/facebook/comment.rs');
  const reserve = constMs(comment, 'FACEBOOK_COMMENT_PRE_SUBMIT_RESERVE_MS');
  const readbackSecs = /FACEBOOK_COMMENT_READBACK_BUDGET[^=]*=\s*Duration::from_secs\((\d+)\)/.exec(comment);
  assert.ok(readbackSecs, '未找到回读预算常量');
  const ackMs = /就地确认轮询窗[\s\S]{0,200}?Duration::from_millis\(([0-9_]+)\)/.exec(comment);
  assert.ok(ackMs, '未找到就地确认轮询窗');
  const inner = Number(readbackSecs![1]) * 1_000 + Number(ackMs![1]!.replace(/_/g, ''));
  assert.ok(
    reserve >= inner + 2_000,
    `提交前预留 ${reserve}ms 装不下自身 ${inner}ms + 回执余量 2000ms ⇒ 字打完了却没时间提交`,
  );
});

test('每条平台道的会话超时都不得把它能夹回的命令天花板静默夹回', () => {
  // 引擎算预算时取 `session_timeout_ms.min(ceiling)`：会话超时小于天花板 ⇒ 天花板失效，且无任何报错。
  // 发布填正文那条在引擎里显式绕过 min()，不受此约束，故不参与比较。
  for (const lane of SESSION_LANES) {
    const highest = Math.max(...lane.clampableCeilings());
    assert.ok(
      lane.sessionTimeout >= highest,
      `${lane.name}：会话超时 ${lane.sessionTimeout}ms < 最高命令天花板 ${highest}ms`
      + ' ⇒ 天花板被静默夹回，改了等于没改',
    );
  }
});

test('评论的长度感知预算在四层里自洽，且长评论真的装得下', () => {
  const base = constMs(browseSession, 'FACEBOOK_COMMENT_TIMEOUT_BASE_MS');
  const perChar = constMs(browseSession, 'FACEBOOK_COMMENT_TIMEOUT_PER_CHAR_MS');
  const floor = constMs(browseSession, 'FACEBOOK_COMMENT_TIMEOUT_FLOOR_MS');
  const max = constMs(browseSession, 'FACEBOOK_COMMENT_TIMEOUT_MAX_MS');
  const slack = constMs(browseSession, 'FACEBOOK_COMMENT_RESPONSE_SLACK_MS');
  const admission = constMs(client, 'MAX_FACEBOOK_COMMENT_TIMEOUT_MS');
  const ceiling = constMs(engine, 'FACEBOOK_COMMENT_TIMEOUT_MS');

  assert.ok(floor <= max, `下限 ${floor}ms 必须 ≤ 上限 ${max}ms`);
  assert.ok(base < max, `基数 ${base}ms 必须 < 上限 ${max}ms，否则公式退化成常量`);
  // 边端请求 = 云端预算 − 余量，最大取到 max − slack；它必须能穿过 ② 与 ④。
  const largestRequest = max - slack;
  assert.ok(largestRequest <= admission, `评论最大请求 ${largestRequest}ms > 准入上限 ${admission}ms`);
  assert.ok(largestRequest <= ceiling, `评论最大请求 ${largestRequest}ms > 引擎天花板 ${ceiling}ms`);
  assert.ok(largestRequest <= facebookSessionTimeout, `评论最大请求 ${largestRequest}ms > 会话超时 ${facebookSessionTimeout}ms`);

  // per-char 系数必须明显高于逐字输入的实测均速，否则固定开销一挤就撞 deadline。
  // 实测约 165ms/字符（native input.rs：对数正态中位 110ms + 标点 ×1.4 + 8% 概率 300–600ms 停顿）。
  const MEASURED_PER_CHAR_MS = 165;
  assert.ok(
    perChar >= MEASURED_PER_CHAR_MS * 1.5,
    `per-char ${perChar}ms 相对实测 ${MEASURED_PER_CHAR_MS}ms/字符余量不足；`
    + '2026-07-29 真机上 220ms 就是这样被固定开销挤爆的',
  );

  // 上限能装下多长的评论：预算 − 固定开销（找编辑框/滚动/聚焦/提交后等待/reload/校验，实测约 30s）
  // 除以实测每字成本。这条把"上限够不够"变成可执行不变量，而不是靠人脑估。
  const FIXED_OVERHEAD_MS = 30_000;
  const supportedChars = Math.floor((max - FIXED_OVERHEAD_MS) / MEASURED_PER_CHAR_MS);
  assert.ok(
    supportedChars >= 800,
    `当前上限 ${max}ms 只装得下约 ${supportedChars} 字符的评论；越南语招聘长文常见 700+ 字符`,
  );
});
