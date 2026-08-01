/**
 * 验证码协助回执打包的**诚实性**（change restore-native-xiaohongshu-session-guards §3，任务 3.1 / 3.3 / 3.4 / 3.6）。
 *
 * 一句话不变量：`inputMode` 说的是**哪条执行路径驱动了这次协助**，只能由回执里的取证支撑，
 * MUST NOT 由「下发了什么」推断出来。迁移后的宿主恰恰是按请求载荷推断的：下发了文本、
 * 边缘整段忽略，回执照样标「点击并键入」，云端的版本偏斜探测器因此永久静默。
 *
 * 另一半同样要守住：`inputMode` **不是**「有没有真派发成字符」。云端那道判据诊断的是
 * 「客户端太旧」；把零派发也算进去，一个最新客户端「点位没点中输入框」的失败就会被
 * 控制台说成「客户端太旧、请重装」，诊断指向完全错误的方向。
 * 零派发这个事实由 `typeReport.typed` 单独承载，云端本来就收得到。
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
  const facts = buildCaptchaClickResultFacts({ text: 'ab12' }, { ok: false, reason: 'captcha_type_failed' }, 'synthetic');
  // 正向不变量而非 `notEqual(..., 'click_type')`：否定式在 inputMode 整格消失时**恒真**（假绿）。
  // 钉死具体取值，实现被删光就会红。
  assert.equal(
    facts.inputMode,
    'click',
    '回执没有携带任何键入取证，却按请求载荷推断成「点击并键入」——这正是要消灭的静默假成功',
  );
  assert.equal(facts.typeReport, undefined, '取证缺席时 MUST NOT 编造一份 typeReport');
});

/**
 * 最新客户端 + 点位没点中输入框（零派发）：MUST NOT 被云端诊断成「客户端太旧」。
 *
 * 这条是 `inputMode` 语义的另一半。回执带 `typeReport` ⇒ 键入执行路径确实跑过了
 * （聚焦探过、清空试过），只是焦点没落在输入框上所以一个字符都没打出去。
 * 若按 `typed > 0` 判 `inputMode`，这里会回落成 'click'，云端那道「客户端太旧」的
 * 版本偏斜判据就会误触发，操作员被指去重装客户端，而真因是点位没点中。
 */
test('captcha click result: 点位没点中输入框（零派发）MUST NOT 被诊断成「客户端太旧」', () => {
  const facts = buildCaptchaClickResultFacts(
    { text: 'ab12' },
    {
      ok: false,
      reason: 'captcha_input_not_focused',
      typeReport: { focus: 'none', typed: 0, submitted: false },
    },
    'synthetic',
  );
  assert.equal(
    facts.inputMode,
    'click_type',
    '键入执行路径跑过了（回执带取证），inputMode 就是 click_type——它说的是路径，不是派发量',
  );
  assert.equal(
    cloudTextNotExecuted(4, facts),
    false,
    '真因是点位没点中输入框；诊断绝不能被指向「客户端太旧、键入未执行」',
  );
  // 「一个字符都没打进去」这个事实并没有消失，它由 typed 单独承载。
  assert.equal(facts.typeReport?.typed, 0);
  // 焦点没落定是**结构确定**的失败：找不到目标就报 no_target，不压进兜底的 failed。
  assert.equal(facts.status, 'no_target');
  assert.deepEqual(facts.typeReport, { focus: 'none', typed: 0, submitted: false });
});

/**
 * 焦点档**读不到**（探针自己炸了）≠ 焦点确凿地不在可编辑元素上。
 *
 * 引擎侧对应 `captcha_input_focus_probe_failed`：取证整份缺席。此时既不许编一份 typeReport，
 * 也不许升级成 `no_target`——那是一句「结构确定的找不到目标」，而我们其实什么都没观测到。
 */
test('captcha click result: 焦点档读不到时不编取证、也不升级成 no_target', () => {
  const facts = buildCaptchaClickResultFacts(
    { text: 'ab12' },
    { ok: false, reason: 'captcha_input_focus_probe_failed' },
    'synthetic',
  );
  assert.equal(facts.typeReport, undefined, '读不到就整份缺席，MUST NOT 补一个看着确定的 none');
  assert.equal(
    facts.status,
    'failed',
    '什么都没观测到就不许声称「页面上没有输入框」（no_target）',
  );
  assert.equal(facts.reason, 'captcha_input_focus_probe_failed');
});

// ── 3.3 + 3.4：取证逐字段往返，且绝不夹带答案 ─────────────────────────────────

test('captcha click result: 取证六字段逐字段透传，键入路径跑过即标 click_type', () => {
  const facts = buildCaptchaClickResultFacts(
    { text: 'ab12' },
    { ok: true, reason: 'cleared', typeReport: { ...FULL_REPORT } },
    'synthetic',
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
    'synthetic',
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
  const facts = buildCaptchaClickResultFacts({}, { ok: true, reason: 'cleared' }, 'synthetic');
  assert.equal(facts.inputMode, 'click');
  assert.equal(facts.typeReport, undefined);
  assert.equal(facts.replayMode, 'synthetic');
});

// ── 3.6：云端「下发了文本却未键入」探测器的触发 / 不触发 ────────────────────────

test('captcha click result: 云端版本偏斜探测器只在「键入路径整段没跑」时触发', () => {
  // 老边缘忽略 text ⇒ 根本不产出 typeReport ⇒ 探测器如实响：这才是它要抓的那件事。
  const missing = buildCaptchaClickResultFacts({ text: 'ab12' }, { ok: false, reason: 'captcha_type_failed' }, 'synthetic');
  assert.equal(cloudTextNotExecuted(4, missing), true);

  // 最新边缘、键入路径跑过但零派发 ⇒ **不是**版本偏斜，绝不触发。
  const zeroDispatch = buildCaptchaClickResultFacts(
    { text: 'ab12' },
    { ok: false, reason: 'captcha_input_not_focused', typeReport: { focus: 'none', typed: 0, submitted: false } },
    'synthetic',
  );
  assert.equal(
    cloudTextNotExecuted(4, zeroDispatch),
    false,
    '零派发是「点位没点中」，不是「客户端太旧」——两件事不许共用一个信号',
  );

  const dispatched = buildCaptchaClickResultFacts(
    { text: 'ab12' },
    { ok: true, reason: 'cleared', typeReport: { ...FULL_REPORT } },
    'synthetic',
  );
  assert.equal(cloudTextNotExecuted(4, dispatched), false);

  // 纯点击的协助从来没下发过文本，探测器 MUST NOT 因为它是 'click' 就误报。
  const clickOnly = buildCaptchaClickResultFacts({}, { ok: true, reason: 'cleared' }, 'synthetic');
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
    'synthetic',
  );
  assert.equal(facts.typeReport?.typed, 3);
  assert.equal(facts.typeReport?.submitted, false);
  assert.equal(facts.inputMode, 'click_type');
});
