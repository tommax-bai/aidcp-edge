/**
 * 验证码协助回执打包的**诚实性**（change restore-native-xiaohongshu-session-guards §3，任务 3.1 / 3.3 / 3.4 / 3.6）。
 *
 * 一句话不变量：`inputMode: 'click_type'` 是一个**关于已经发生的事**的断言，
 * 只能由回执里「确有字符派发」这一取证支撑；它 MUST NOT 由「下发了什么」推断出来。
 * 迁移后的宿主恰恰是按请求载荷推断的：下发了文本、一个字符都没打进去，回执照样标「点击并键入」，
 * 云端的版本偏斜探测器因此永久静默。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptchaClickResultFacts } from '../../src/captcha/click-result.js';
import type { CaptchaAssistTypeReportPayload } from '../../src/comm/protocol.js';

/**
 * 云端「下发了文本却未键入」的判据，就地重演（事实源：
 * aidcp-cloud/src/comm/captcha-assist.ts 的 onClickResult —— `textLen > 0 && inputMode !== 'click_type'`）。
 *
 * 这是**本地重演**，不是边到边：云端那半由 cloud 仓的 test/comm/captcha-assist.test.ts 承接。
 * 判据一旦在云端改动，这里会静默过期——它锁的是「边缘打出的形状会不会触发那个条件」，
 * 不是「云端真的这么判」。
 */
function cloudTextNotExecuted(textLen: number, facts: { inputMode?: string }): boolean {
  return textLen > 0 && facts.inputMode !== 'click_type';
}

const FULL_REPORT: CaptchaAssistTypeReportPayload = {
  focus: 'editable',
  focusTag: 'INPUT',
  cleared: 'verified',
  typed: 4,
  verified: 'match',
  submitted: true,
};

// ── 3.1：取证缺席时，绝不谎报「点击并键入」 ────────────────────────────────────

test('captcha click result: 下发了文本但回执不带任何键入取证时，MUST NOT 标 click_type', () => {
  const facts = buildCaptchaClickResultFacts({ text: 'ab12' }, { ok: false, reason: 'captcha_type_failed' });
  // 正向不变量而非 `notEqual(..., 'click_type')`：否定式在 inputMode 整格消失时**恒真**（假绿）。
  // 钉死具体取值，实现被删光就会红。
  assert.equal(
    facts.inputMode,
    'click',
    '回执没有携带任何键入取证，却按请求载荷推断成「点击并键入」——这正是要消灭的静默假成功',
  );
  assert.equal(facts.typeReport, undefined, '取证缺席时 MUST NOT 编造一份 typeReport');
});

test('captcha click result: 取证在场但零派发（焦点没落定）仍不是 click_type', () => {
  const facts = buildCaptchaClickResultFacts(
    { text: 'ab12' },
    {
      ok: false,
      reason: 'captcha_input_not_focused',
      typeReport: { focus: 'none', typed: 0, submitted: false },
    },
  );
  assert.equal(facts.inputMode, 'click');
  // 焦点没落定是**结构确定**的失败：找不到目标就报 no_target，不压进兜底的 failed。
  assert.equal(facts.status, 'no_target');
  assert.deepEqual(facts.typeReport, { focus: 'none', typed: 0, submitted: false });
});

// ── 3.3 + 3.4：取证逐字段往返，且绝不夹带答案 ─────────────────────────────────

test('captcha click result: 取证六字段逐字段透传，确有派发才标 click_type', () => {
  const facts = buildCaptchaClickResultFacts(
    { text: 'ab12' },
    { ok: true, reason: 'cleared', typeReport: { ...FULL_REPORT } },
  );
  assert.equal(facts.status, 'cleared');
  assert.equal(facts.inputMode, 'click_type');
  assert.deepEqual(facts.typeReport, FULL_REPORT);
});

test('captcha click result: 打包出的载荷绝不携带答案本身', () => {
  // 引擎侧若哪天多回了一格（哪怕是误带答案），打包必须只取白名单里的六格——
  // 这是结构保证，不是一句注释。
  const facts = buildCaptchaClickResultFacts(
    { text: 'ab12' },
    {
      ok: true,
      reason: 'cleared',
      typeReport: { ...FULL_REPORT, text: 'ab12', answer: 'ab12' } as unknown as CaptchaAssistTypeReportPayload,
    },
  );
  assert.deepEqual(Object.keys(facts.typeReport ?? {}).sort(), [
    'cleared',
    'focus',
    'focusTag',
    'submitted',
    'typed',
    'verified',
  ]);
  assert.equal(JSON.stringify(facts).includes('ab12'), false);
});

test('captcha click result: 纯点击（未下发文本）不带取证，inputMode 为 click', () => {
  const facts = buildCaptchaClickResultFacts({}, { ok: true, reason: 'cleared' });
  assert.equal(facts.inputMode, 'click');
  assert.equal(facts.typeReport, undefined);
  assert.equal(facts.replayMode, 'synthetic');
});

// ── 3.6：云端「下发了文本却未键入」探测器的触发 / 不触发 ────────────────────────

test('captcha click result: 云端版本偏斜探测器在取证缺席时触发、在确有派发时不触发', () => {
  const missing = buildCaptchaClickResultFacts({ text: 'ab12' }, { ok: false, reason: 'captcha_type_failed' });
  assert.equal(cloudTextNotExecuted(4, missing), true);

  const zeroDispatch = buildCaptchaClickResultFacts(
    { text: 'ab12' },
    { ok: false, reason: 'captcha_input_not_focused', typeReport: { focus: 'none', typed: 0, submitted: false } },
  );
  assert.equal(cloudTextNotExecuted(4, zeroDispatch), true);

  const dispatched = buildCaptchaClickResultFacts(
    { text: 'ab12' },
    { ok: true, reason: 'cleared', typeReport: { ...FULL_REPORT } },
  );
  assert.equal(cloudTextNotExecuted(4, dispatched), false);

  // 纯点击的协助从来没下发过文本，探测器 MUST NOT 因为它是 'click' 就误报。
  const clickOnly = buildCaptchaClickResultFacts({}, { ok: true, reason: 'cleared' });
  assert.equal(cloudTextNotExecuted(0, clickOnly), false);
});

// ── 3.5 的宿主半边：部分派发照实回报，不得被打包层抹平 ─────────────────────────

test('captcha click result: 中途中断的部分派发照实回报，不得回退成请求文本长度', () => {
  const facts = buildCaptchaClickResultFacts(
    { text: 'abcdef' },
    {
      ok: false,
      reason: 'preempted_by_task',
      typeReport: { focus: 'editable', focusTag: 'INPUT', cleared: 'verified', typed: 3, submitted: false },
    },
  );
  assert.equal(facts.typeReport?.typed, 3);
  assert.equal(facts.typeReport?.submitted, false);
  assert.equal(facts.inputMode, 'click_type');
});
