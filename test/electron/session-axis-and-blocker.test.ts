import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// change harden-edge-blocker-and-session-axis
//
// 两根状态轴各自被一个**证明不了它的信号**驱动：
//   ① 阻断浮层标记会被「浏览会话结束」顺带清掉——浏览停下来证明不了阻断被处理掉了，
//      而且浏览停下来恰恰常常正是因为那个浮层还挡着。
//   ② 会话运行态由中文措辞推断，而那些措辞的发射点已从生产构建剪除 ⇒ 该轴停在错值、零告警。
//
// 两者**因果耦合**：② 的修复正是在给「会话结束」造一个活信号源。所以 ① 必须同批拆掉——
// 否则这个 change 会亲手把一个正被人工处置的阻断态抹掉。

const require = createRequire(import.meta.url);

const uiEvents = require('../../src/electron/ui-events.cjs') as {
  nativeSessionAxisEvent: (line: string) => 'running' | 'idle' | null;
  NATIVE_SESSION_EVENT_PREFIX: string;
  NATIVE_SESSION_READY_EVENT: string;
  NATIVE_SESSION_STOPPED_EVENT: string;
};

const readSource = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const electronMainSource = readSource('src/electron/main.cjs');
const nativeBrowseSessionSource = readSource('src/native-page-engine/browse-session.ts');

// ── ① 阻断浮层：只认显式解除 ──────────────────────────────────────────────────

test('blocker: 会话结束 MUST NOT 出现在阻断态的清除条件里（本 change 的主断言）', () => {
  const setAt = electronMainSource.indexOf("if (evt.type === 'popup') next.overlayBlocked = true;");
  assert.notEqual(setAt, -1, '未找到阻断态的置位处');
  const clearLine = electronMainSource.slice(
    electronMainSource.indexOf('\n', setAt) + 1,
    electronMainSource.indexOf('\n', electronMainSource.indexOf('\n', setAt) + 1),
  );
  assert.match(clearLine, /next\.overlayBlocked = false/, '未找到阻断态的清除处');
  assert.equal(
    clearLine.includes('session_end'),
    false,
    '清除条件不得含「会话结束」：浏览停下来证明不了阻断被处理掉了',
  );
  assert.ok(clearLine.includes('popup_cleared'), '显式解除必须仍是清除路径');
});

test('blocker: 清除路径有且只有一条，且其条件不得被额外条件放宽', () => {
  // 两种绕过都要挡住：① 在别处新增一个置假点；② 在既有那一行的条件上再或一个事件。
  // 后者是变异自查里真实发生过的绕过——只按「这行提到了 popup_cleared」放行，
  // 会把 `popup_cleared || session_end` 一并放过去。所以这里按**条件全等**判。
  const clearing = electronMainSource
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /overlayBlocked\s*=\s*false/.test(line));
  assert.equal(clearing.length, 1, `阻断态的清除路径必须有且只有一条，实测 ${clearing.length} 条：\n${clearing.join('\n')}`);
  assert.equal(
    clearing[0],
    "else if (evt.type === 'popup_cleared') next.overlayBlocked = false;",
    '清除条件 MUST 恰为显式解除本身，不得再或上任何其它事件',
  );
});

// ── ② 会话轴：由结构化引擎事件驱动 ────────────────────────────────────────────

test('session-axis: 结构化会话行驱动运行态（不含任何退役路径的中文措辞）', () => {
  assert.equal(
    uiEvents.nativeSessionAxisEvent('[native-page] session.event event=session_ready platform=facebook'),
    'running',
  );
  assert.equal(
    uiEvents.nativeSessionAxisEvent('[native-page] session.event event=session_stopped platform=facebook reason=local_stop'),
    'idle',
  );
});

test('session-axis: 其它会话事件与无关行 MUST NOT 动这根轴', () => {
  for (const line of [
    '[native-page] session.event event=blocking_detected platform=facebook kind=captcha',
    '[native-page] session.event event=command_failed platform=xiaohongshu',
    '[native-page] xiaohongshu Native-only browse session ready', // 非事件行，仅措辞相近
    '[browse] 浏览循环结束，预计休息约 3 分钟后继续', // 退役路径的中文措辞：绝不再认
    '',
  ]) {
    assert.equal(uiEvents.nativeSessionAxisEvent(line), null, `不该动这根轴：${line}`);
  }
});

test('session-axis: 已退役的中文措辞规则不得再出现在状态推导里', () => {
  for (const phrase of ['自动浏览已启动', '启动自动浏览循环', '启动命令驱动浏览循环', '唤醒重启浏览循环']) {
    assert.equal(
      electronMainSource.includes(`message.includes('${phrase}')`),
      false,
      `「${phrase}」的发射点已随退役浏览循环剪出生产构建，MUST NOT 再据它写会话轴`,
    );
  }
  assert.equal(
    electronMainSource.includes("next.session = message.includes('后继续')"),
    false,
    'MUST NOT 再由中文措辞合成 resting',
  );
});

test('session-axis: 每一个匹配串都仍有发射方（本轴当年就是这么死的）', () => {
  // 沿用 change admit-browser-standby-on-live-facts 的写入方存在断言：匹配串必须能在引擎源码里
  // 找到发射点。会话轴当年正是「匹配串还在、发射它的那条路径已退役」而静默冻结的。
  assert.ok(
    nativeBrowseSessionSource.includes("this.logger(`[native-page] session.event"),
    '引擎侧结构化会话行的发射点已不在，会话轴不得再依赖它',
  );
  for (const literal of [uiEvents.NATIVE_SESSION_READY_EVENT, uiEvents.NATIVE_SESSION_STOPPED_EVENT]) {
    assert.ok(
      nativeBrowseSessionSource.includes(`this.diagnostic('${literal}'`),
      `事件名「${literal}」在引擎侧已无发射方，会话轴不得再依赖它`,
    );
  }
});

test('session-axis: MUST NOT 回到冷待机准入闸——即便它现在有了活写入方', () => {
  // 结构断言（对应规格 browser-cold-standby 新增场景）。理由不是写入方死活，而是姿态非身份：
  // 这根轴描述「此刻在不在跑」，不描述「要被操作的是哪个对象」。
  const standbySource = readSource('src/electron/browser-cold-standby.cjs');
  const at = standbySource.indexOf('function shouldEnterColdStandby');
  assert.notEqual(at, -1, '未找到准入函数');
  const body = standbySource.slice(at, standbySource.indexOf('\nfunction ', at + 1));
  assert.equal(body.includes('status.session'), false, '准入不得读会话轴');
  assert.equal(body.includes('nativeSessionAxis'), false, '准入不得读会话轴的新来源');
});
