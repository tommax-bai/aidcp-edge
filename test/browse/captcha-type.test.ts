import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTCHA_TEXT_MAX_LEN,
  clearFocusedField,
  dispatchHumanTyping,
  keySpecFor,
  probeFocus,
  readFocusedText,
  validateCaptchaText,
} from '../../src/browse/captcha-type.js';
import { InputDispatchDeadlineError, type BrowseCdp } from '../../src/browse/cdp-util.js';

interface FocusShape {
  tier?: 'editable' | 'opaque' | 'none';
  tag?: string;
}

class FakeCdp implements BrowseCdp {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  /** 依次返回的回读文本；用完停在最后一个。 */
  private readIdx = 0;
  constructor(
    private readonly opts: { focus?: FocusShape; readTexts?: (string | null)[] } = {},
  ) {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Runtime.evaluate') {
      const expr = String(params?.expression ?? '');
      if (expr.includes('activeElement') && expr.includes('tier')) {
        return { result: { value: this.opts.focus ?? { tier: 'editable', tag: 'INPUT' } } } as T;
      }
      if (expr.includes('isContentEditable') && expr.includes('textContent')) {
        const texts = this.opts.readTexts ?? [''];
        const text = texts[Math.min(this.readIdx, texts.length - 1)];
        this.readIdx += 1;
        return { result: { value: { text } } } as T;
      }
      return { result: { value: true } } as T;
    }
    return {} as T;
  }

  keyEvents(): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => c.params ?? {});
  }
}

const noSleep = async (): Promise<void> => {};

// ── 键位表 / 校验 ────────────────────────────────────────────────────────────

test('键位表：数字/字母/上档标点各得真实基键，表外字符诚实拒绝', () => {
  assert.deepEqual(keySpecFor('7'), { key: '7', code: 'Digit7', windowsVirtualKeyCode: 0x37, needsShift: false });
  assert.deepEqual(keySpecFor('a'), { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 0x41, needsShift: false });
  assert.deepEqual(keySpecFor('A'), { key: 'A', code: 'KeyA', windowsVirtualKeyCode: 0x41, needsShift: true });
  // '!' 是 Shift+1 —— 派发的必须是真实存在的基键，不是凭空造的 'Exclamation'。
  assert.deepEqual(keySpecFor('!'), { key: '!', code: 'Digit1', windowsVirtualKeyCode: 0x31, needsShift: true });
  // 表外：中文 / 控制字符 / 多字符。
  assert.equal(keySpecFor('中'), undefined);
  assert.equal(keySpecFor('\n'), undefined);
  assert.equal(keySpecFor('ab'), undefined);
});

test('答案校验：空/超长/表外字符整单拒绝，正常 ASCII 放行', () => {
  assert.deepEqual(validateCaptchaText('3n7k'), { ok: true });
  assert.deepEqual(validateCaptchaText(''), { ok: false, reason: 'empty' });
  assert.deepEqual(validateCaptchaText('x'.repeat(CAPTCHA_TEXT_MAX_LEN + 1)), { ok: false, reason: 'too_long' });
  assert.deepEqual(validateCaptchaText('验证码'), { ok: false, reason: 'unsupported_char' });
  // 换行是功能键的入口 —— 字符集边界是机制，必须挡住。
  assert.deepEqual(validateCaptchaText('ab\ncd'), { ok: false, reason: 'unsupported_char' });
});

// ── 真实键事件（本 change 的反检测红线）──────────────────────────────────────

test('键入：键事件数与字符数一一对应，且零 Input.insertText', async () => {
  const cdp = new FakeCdp();
  const typed = await dispatchHumanTyping(cdp, '3n7k', { random: () => 0.5, sleep: noSleep, clock: () => 0 });

  assert.equal(typed, 4);
  const events = cdp.keyEvents();
  const downs = events.filter((e) => e.type === 'keyDown');
  const ups = events.filter((e) => e.type === 'keyUp');
  assert.equal(downs.length, 4, '每个字符恰好一个 keyDown');
  assert.equal(ups.length, 4, '每个字符恰好一个 keyUp');
  // 「键事件数与字符数不匹配」是厂商成熟判据 —— insertText 产生 0 个键事件，绝不能出现。
  assert.equal(cdp.calls.filter((c) => c.method === 'Input.insertText').length, 0);
  // keyDown MUST 带 text ⇒ 产生真实 keypress 形态。
  assert.deepEqual(downs.map((e) => e.text), ['3', 'n', '7', 'k']);
  assert.deepEqual(downs.map((e) => e.code), ['Digit3', 'KeyN', 'Digit7', 'KeyK']);
});

test('键入：上档字符用真实 Shift 键包裹，且 Shift 必被松开', async () => {
  const cdp = new FakeCdp();
  await dispatchHumanTyping(cdp, 'aB', { random: () => 0.5, sleep: noSleep, clock: () => 0 });

  const events = cdp.keyEvents();
  const shiftDowns = events.filter((e) => e.key === 'Shift' && e.type === 'rawKeyDown');
  const shiftUps = events.filter((e) => e.key === 'Shift' && e.type === 'keyUp');
  assert.equal(shiftDowns.length, 1, '只有 B 需要 Shift');
  assert.equal(shiftUps.length, 1, 'Shift MUST 被松开——卡住会把后续全部字符变成上档');
  // 'B' 的 keyDown 必须带 Shift modifier。
  const bDown = events.find((e) => e.type === 'keyDown' && e.text === 'B');
  assert.equal(bDown?.modifiers, 8);
  // 'a' 不带。
  const aDown = events.find((e) => e.type === 'keyDown' && e.text === 'a');
  assert.equal(aDown?.modifiers, 0);
});

test('键入：keyDown 抛错也必补发 keyUp（绝不留卡住的按键）', async () => {
  const cdp = new FakeCdp();
  const orig = cdp.send.bind(cdp);
  cdp.send = (async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown') {
      cdp.calls.push({ method, params });
      throw new Error('cdp exploded');
    }
    return orig(method, params);
  }) as typeof cdp.send;

  await assert.rejects(
    () => dispatchHumanTyping(cdp, 'x', { random: () => 0.5, sleep: noSleep, clock: () => 0 }),
    /cdp exploded/,
    '原始异常 MUST NOT 被 finally 覆盖',
  );
  assert.equal(cdp.keyEvents().filter((e) => e.type === 'keyUp').length, 1, 'keyUp 必补发');
});

// ── 取消 / 预算（诚实计数）──────────────────────────────────────────────────

test('键入：被抢占 → 抛出且已派发数如实（MUST NOT 回退到意图长度）', async () => {
  const cdp = new FakeCdp();
  let n = 0;
  class Takeover extends Error {}
  await assert.rejects(
    () =>
      dispatchHumanTyping(cdp, 'abcdef', {
        random: () => 0.5,
        sleep: noSleep,
        clock: () => 0,
        checkpoint: () => {
          if (n++ >= 2) throw new Takeover('taken over');
        },
      }),
    Takeover,
  );
  // 取消缝在「这一字符的 CDP 写尚未发出」处 ⇒ 恰好派发了 2 个字符，不多不少。
  assert.equal(cdp.keyEvents().filter((e) => e.type === 'keyDown' && e.key !== 'Shift').length, 2);
});

test('键入：超预算 → InputDispatchDeadlineError，且接管优先于死线', async () => {
  const cdp = new FakeCdp();
  await assert.rejects(
    () => dispatchHumanTyping(cdp, 'abc', { random: () => 0.5, sleep: noSleep, clock: () => 5000, deadlineAt: 1000 }),
    InputDispatchDeadlineError,
  );
  // 同时命中接管与死线时，MUST 抛接管——下游靠异常类型区分「未开始（可重派）」与「超预算失败」。
  class Takeover extends Error {}
  await assert.rejects(
    () =>
      dispatchHumanTyping(cdp, 'abc', {
        random: () => 0.5,
        sleep: noSleep,
        clock: () => 5000,
        deadlineAt: 1000,
        checkpoint: () => {
          throw new Takeover('taken over');
        },
      }),
    Takeover,
  );
});

// ── RTT 补偿（节奏不被传输层压平）────────────────────────────────────────────

test('键入：RTT 补偿从下一次等待中扣除往返', async () => {
  // 合成一个 20ms 的 CDP 往返。random 恒定 ⇒ flight/dwell 各自恒定（具体值由 Box-Muller 决定，
  // 不在此假设——测试只断言「后续 flight 比首个 flight 恰好少一个 RTT」这个关系）。
  const RTT = 20;
  let clockMs = 0;
  const cdp = new FakeCdp();
  // 按结构区分 flight 与 dwell：flight 发生在该字符的 keyDown **之前**，dwell 在其 keyDown 之后。
  // 靠数值区分会误判——dwell 与「flight 减 RTT」可能恰好撞值。
  const flights: number[] = [];
  const orig = cdp.send.bind(cdp);
  cdp.send = (async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown') clockMs += RTT;
    return orig(method, params);
  }) as typeof cdp.send;
  // 判别器按 keyDown/keyUp 的**配对状态**，不按计数、更不按数值：
  //   flight 在字符边界上（downs === ups，上一字符已收尾）；dwell 夹在 keyDown 与 keyUp 之间（downs === ups+1）。
  // 早前按「downs === 序号」判会把 dwell 也误记成 flight，而 dwell 恰好撞上 flight-RTT 的值 ⇒ 假绿。
  const count = (type: string): number => cdp.keyEvents().filter((e) => e.type === type && e.key !== 'Shift').length;

  await dispatchHumanTyping(cdp, 'abcdefgh', {
    random: () => 0.5,
    sleep: async (ms: number) => {
      if (count('keyDown') === count('keyUp')) flights.push(ms);
      clockMs += ms;
    },
    clock: () => clockMs,
    medianMs: 110,
  });

  assert.ok(flights.length >= 3, `应观察到多次 flight 等待，实际 ${flights.length}`);
  const first = flights[0]; // 首字符无前序往返可扣 = 未补偿的原始采样值
  assert.ok(
    flights.slice(1).every((w) => w === first - RTT),
    `后续等待 MUST 恰好扣除实测 RTT（期望 ${first - RTT}，实际 ${JSON.stringify(flights.slice(1))}）`,
  );
  // 不补偿则实际键间隔 = 采样值 + RTT（整体右移）；重载下 RTT 上百毫秒会把对数正态压平成常数。
});

test('键入：真实随机源下键间隔保留方差（MUST NOT 只断言字符数——那在节奏被压平时照样绿）', async () => {
  const cdp = new FakeCdp();
  const waits: number[] = [];
  const typed = await dispatchHumanTyping(cdp, 'abcdefghijklmnopqrst', {
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    clock: () => 0,
  });
  assert.equal(typed, 20);
  const flights = waits.filter((_, i) => i % 2 === 0);
  const mean = flights.reduce((a, b) => a + b, 0) / flights.length;
  const sd = Math.sqrt(flights.reduce((a, b) => a + (b - mean) ** 2, 0) / flights.length);
  // 变异系数：机器等周期 ⇒ 0。对数正态 σ=0.35 ⇒ 理论 CV≈0.36；给足下界容纳采样噪声。
  assert.ok(sd / mean > 0.15, `键间隔变异系数过低（${(sd / mean).toFixed(3)}）= 节奏被压平成常数`);
});

// ── 焦点三态 ────────────────────────────────────────────────────────────────

test('焦点探针：三态分级', async () => {
  assert.deepEqual(await probeFocus(new FakeCdp({ focus: { tier: 'editable', tag: 'INPUT' } })), {
    tier: 'editable',
    tag: 'INPUT',
  });
  // 厂商挂 tabindex 的 canvas 会真拿焦点 ⇒ opaque（打但验不了），MUST NOT fail-closed。
  assert.deepEqual(await probeFocus(new FakeCdp({ focus: { tier: 'opaque', tag: 'CANVAS' } })), {
    tier: 'opaque',
    tag: 'CANVAS',
  });
  assert.deepEqual(await probeFocus(new FakeCdp({ focus: { tier: 'none', tag: 'BODY' } })), {
    tier: 'none',
    tag: 'BODY',
  });
});

test('焦点探针：形状异常一律判 none（宁可报没落到目标，绝不猜成可编辑）', async () => {
  assert.equal((await probeFocus(new FakeCdp({ focus: {} }))).tier, 'none');
  assert.equal((await probeFocus(new FakeCdp({ focus: { tier: 'garbage' as never } }))).tier, 'none');
});

// ── 清空三态 ────────────────────────────────────────────────────────────────

test('清空：editable 回读为空 → verified', async () => {
  const cdp = new FakeCdp({ readTexts: [''] });
  assert.equal(await clearFocusedField(cdp, 'editable'), 'verified');
  assert.equal(cdp.keyEvents().filter((e) => e.key === 'Backspace' && e.type === 'keyDown').length, 1);
});

test('清空：editable 但回读仍有残文 → attempted（绝不声称清空了）', async () => {
  const cdp = new FakeCdp({ readTexts: ['残'] });
  assert.equal(await clearFocusedField(cdp, 'editable'), 'attempted');
});

test('清空：opaque 只能尽力 → attempted，且用键盘全选（修饰键不外泄到动作词汇）', async () => {
  const cdp = new FakeCdp({ focus: { tier: 'opaque', tag: 'IFRAME' } });
  assert.equal(await clearFocusedField(cdp, 'opaque'), 'attempted');
  const events = cdp.keyEvents();
  const selectAll = events.find((e) => e.code === 'KeyA' && e.type === 'rawKeyDown');
  assert.ok(selectAll, 'opaque 路径用键盘全选');
  assert.ok(Number(selectAll?.modifiers) > 0, '全选必带修饰键');
  assert.equal(events.filter((e) => e.code === 'KeyA' && e.type === 'keyUp').length, 1, '全选键必松开');
  assert.equal(events.filter((e) => e.key === 'Backspace' && e.type === 'keyDown').length, 1);
});

test('回读：非可读元素回 null（不可验证，绝不当成空）', async () => {
  const cdp = new FakeCdp({ readTexts: [null] });
  assert.equal(await readFocusedText(cdp), null);
});
