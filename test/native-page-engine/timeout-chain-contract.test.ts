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
  const match = new RegExp(`\\b${name}\\b[^=\\n]*=\\s*Duration::from_secs\\((\\d+)\\)`).exec(source);
  assert.ok(match, `未在源码中找到 Duration 常量 ${name}`);
  return Number(match![1]) * 1_000;
}

const browseSession = read('src/native-page-engine/browse-session.ts');
const client = read('src/native-page-engine/client.ts');
const runtime = read('src/native-page-engine/runtime.ts');
const engine = read('native/page-engine/src/engine.rs');
const facebookFeed = read('native/page-engine/src/facebook/feed.rs');
const facebookReels = read('native/page-engine/src/facebook/reels.rs');

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
    name: '普通命令（默认档）',
    request: constMs(browseSession, 'DEFAULT_NATIVE_COMMAND_TIMEOUT_MS'),
    admission: constMs(client, 'MAX_NATIVE_TIMEOUT_MS'),
    ceiling: constMs(engine, 'DEFAULT_COMMAND_TIMEOUT_MS'),
  },
];

const sessionTimeout = constMs(runtime, 'FACEBOOK_NATIVE_SESSION_TIMEOUT_MS');

test('Reels entry 的两个 30s 就绪窗与两个 15s 身份窗装得进现有滚动预算', () => {
  const readyMs = durationMs(facebookFeed, 'FACEBOOK_REELS_ENTRY_READY_TIMEOUT');
  const identityMs = durationMs(facebookReels, 'FACEBOOK_REEL_IDENTITY_HYDRATION_TIMEOUT');
  const entryReadyUses = facebookFeed.match(
    /wait_for_facebook_ready\(session, FACEBOOK_REELS_ENTRY_READY_TIMEOUT\)/g,
  )?.length ?? 0;
  const namedWaitsMs = readyMs * 2 + identityMs * 2;
  const nonWaitMarginMs = 30_000;
  const scroll = FAMILIES.find((family) => family.name === 'Feed 滚动');

  assert.equal(readyMs, 30_000, 'Reels entry 每次文档就绪窗必须是 30s');
  assert.equal(entryReadyUses, 2, '初次与唯一重试导航必须共用同一个 30s 就绪窗');
  assert.ok(scroll, '未找到 Facebook Feed/Reels 滚动预算');
  assert.ok(
    namedWaitsMs + nonWaitMarginMs <= scroll!.request,
    `Reels entry 具名等待 ${namedWaitsMs}ms + 非等待余量 ${nonWaitMarginMs}ms`
      + ` > 滚动请求预算 ${scroll!.request}ms`,
  );
  assert.ok(scroll!.request <= scroll!.admission, 'Reels entry 请求必须穿过 Edge 准入上限');
  assert.ok(scroll!.request <= scroll!.ceiling, 'Reels entry 请求必须穿过 Native 命令天花板');
  assert.ok(scroll!.request <= sessionTimeout, 'Facebook 会话上限不得夹短 Reels entry 请求');
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

test('会话超时必须同时穿过边缘准入与引擎协议准入，否则整个 Facebook 会话开不起来', () => {
  // 这两道是「四处同步」之外的第 ⑤⑥ 处，2026-07-29 清点才发现：
  //   - 边缘 openSession 会拿会话超时去过 validateProbeInput（曾复用加群上限）；
  //   - 引擎 protocol.rs 在入口再卡一次。
  // 任一处小于会话超时，失败形态都不是「某条命令变慢」，而是 session.open 直接被拒、
  // **整个 Facebook 平台一条命令都发不出去**。
  const edgeAdmission = constMs(client, 'MAX_FACEBOOK_SESSION_TIMEOUT_MS');
  const engineAdmission = constMs(read('native/page-engine/src/protocol.rs'), 'MAX_FACEBOOK_TIMEOUT_MS');
  assert.ok(
    sessionTimeout <= edgeAdmission,
    `会话超时 ${sessionTimeout}ms > 边缘准入 ${edgeAdmission}ms ⇒ openSession 抛 invalid_request，FB 全线不可用`,
  );
  assert.ok(
    sessionTimeout <= engineAdmission,
    `会话超时 ${sessionTimeout}ms > 引擎协议准入 ${engineAdmission}ms ⇒ session.open 被引擎拒，FB 全线不可用`,
  );
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

test('会话超时不得把任何 Facebook 命令天花板静默夹回', () => {
  // 引擎算预算时取 `session_timeout_ms.min(ceiling)`：会话超时小于天花板 ⇒ 天花板失效，且无任何报错。
  // 发布填正文那条在引擎里显式绕过 min()，不受此约束，故不参与比较。
  const ceilings = [
    ...FAMILIES.map((family) => family.ceiling),
    constMs(engine, 'FACEBOOK_COMMENT_TIMEOUT_MS'),
    constMs(engine, 'FACEBOOK_PUBLISH_SELECT_MODE_TIMEOUT_MS'),
  ];
  const highest = Math.max(...ceilings);
  assert.ok(
    sessionTimeout >= highest,
    `会话超时 ${sessionTimeout}ms < 最高命令天花板 ${highest}ms ⇒ 天花板被静默夹回，改了等于没改`,
  );
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
  assert.ok(largestRequest <= sessionTimeout, `评论最大请求 ${largestRequest}ms > 会话超时 ${sessionTimeout}ms`);

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
