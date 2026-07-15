import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchClick,
  dispatchKeystrokes,
  InputDispatchDeadlineError,
  type BrowseCdp,
} from '../../src/browse/cdp-util.js';
import { TaskTakeoverError } from '../../src/execution/takeover.js';

/**
 * 最小 CDP 桩：只实现 send（与 cdp-util 的依赖口径一致），记录全部调用。
 * failOn 用来模拟"某一类输入事件在真实浏览器里失败"（如 press 时 CDP 断连）。
 */
class FakeCdp implements BrowseCdp {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];

  constructor(private readonly failOn?: { type: string; error: Error }) {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (this.failOn && params?.type === this.failOn.type) throw this.failOn.error;
    return {} as T;
  }

  /** 鼠标事件的 type 序列（mouseMoved / mousePressed / mouseReleased），保序。 */
  mouseTypes(): string[] {
    return this.calls
      .filter((c) => c.method === 'Input.dispatchMouseEvent')
      .map((c) => String(c.params?.type));
  }

  /** 真正写进页面的字符（Input.insertText 的实参），保序。 */
  insertedText(): string[] {
    return this.calls
      .filter((c) => c.method === 'Input.insertText')
      .map((c) => String(c.params?.text));
  }
}

/** 注入 sleep：绝不真等墙钟。 */
const noSleep = async (): Promise<void> => undefined;

/** 轨迹确定性：0.5 ≥ 0.15 ⇒ 不 overshoot；jitter/控制点偏移全部取常量。 */
const fixedRandom = (): number => 0.5;

/**
 * 禁区 #1 的不变量：按下-松开是原子区。
 * 事件序列里 MUST NOT 出现「有 mousePressed 却没有紧随其后的 mouseReleased」——
 * 裸按下 = 此后所有 mouseMoved 变成拖拽/框选，页面被不可见污染。
 */
function assertPressReleasePaired(types: string[]): void {
  const pressed = types.filter((t) => t === 'mousePressed').length;
  const released = types.filter((t) => t === 'mouseReleased').length;
  assert.equal(pressed, released, `按下(${pressed})与松开(${released})数量不匹配: ${types.join(',')}`);
  types.forEach((t, i) => {
    if (t !== 'mousePressed') return;
    assert.equal(types[i + 1], 'mouseReleased', `mousePressed 之后必须紧跟 mouseReleased: ${types.join(',')}`);
  });
}

test('dispatchKeystrokes: 接管落在下一字符写出之前，且接管优先于死线', async () => {
  const cdp = new FakeCdp();
  let checkpointCalls = 0;

  // 死线构造成「第 2 个字符写出后即已过期」：
  // 若实现把死线检查排在 checkpoint 之前，第 3 次安全检查会先抛 InputDispatchDeadlineError。
  // 断言的正是这个顺序不许写反——一次让路被报成 fill_deadline_exceeded，下游就分不清
  // 「未开始（可重派）」与「超预算失败」。
  const deadlineAt = 1000;
  const clock = (): number => (cdp.insertedText().length >= 2 ? deadlineAt : 0);

  let thrown: unknown;
  try {
    await dispatchKeystrokes(cdp, '一二三四五', {
      sleep: noSleep,
      deadlineAt,
      clock,
      checkpoint: () => {
        checkpointCalls++;
        if (checkpointCalls === 3) throw new TaskTakeoverError();
      },
    });
    assert.fail('被接管时 MUST 抛出，绝不静默返回已输入字符数');
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown instanceof TaskTakeoverError, `应抛 TaskTakeoverError，实际: ${String(thrown)}`);
  assert.ok(
    !(thrown instanceof InputDispatchDeadlineError),
    '接管 MUST NOT 被降级成死线超时',
  );
  // checkpoint 在这一字符的 CDP 写之前 ⇒ 第 3 个字符一个键都没落到页面上。
  assert.deepEqual(cdp.insertedText(), ['一', '二']);
  assert.equal(checkpointCalls, 3);
});

test('dispatchClick: 任意取消/死线点都不留下「按下未松开」', async () => {
  const clickOpts = {
    from: { x: 0, y: 0 },
    random: fixedRandom,
    sleep: noSleep,
    hoverDwellMs: 20,
  };

  // 基线：不取消时点击完整成对，并数出安全检查点总数（逐帧 hover + dwell 前 + 按下前）。
  const baseline = new FakeCdp();
  let total = 0;
  await dispatchClick(baseline, 300, 400, { ...clickOpts, checkpoint: () => { total++; } });
  assertPressReleasePaired(baseline.mouseTypes());
  assert.deepEqual(baseline.mouseTypes().slice(-2), ['mousePressed', 'mouseReleased']);
  assert.ok(total >= 3, `安全检查点至少含 hover 帧 + dwell 前 + 按下前，实际 ${total}`);

  // 逐个安全检查点取消：press 与 release 之间没有任何检查点，因此不论在哪一处让路，
  // 都不许出现裸 mousePressed。这条断言正是守着「那一行不许再长回来」。
  for (let k = 1; k <= total; k++) {
    const cdp = new FakeCdp();
    let n = 0;
    await assert.rejects(
      dispatchClick(cdp, 300, 400, {
        ...clickOpts,
        checkpoint: () => {
          n++;
          if (n === k) throw new TaskTakeoverError();
        },
      }),
      TaskTakeoverError,
      `第 ${k} 个安全检查点取消时应抛 TaskTakeoverError`,
    );
    assertPressReleasePaired(cdp.mouseTypes());
  }

  // 死线场景同理（clock 一开始就过期）。
  const deadline = new FakeCdp();
  await assert.rejects(
    dispatchClick(deadline, 300, 400, {
      ...clickOpts,
      deadlineAt: 1000,
      clock: () => 1000,
    }),
    InputDispatchDeadlineError,
  );
  assertPressReleasePaired(deadline.mouseTypes());
});

test('dispatchClick: mousePressed 抛错时仍补发 mouseReleased，且原始异常原样上抛', async () => {
  const boom = new Error('CDP 在按下时断了');
  const cdp = new FakeCdp({ type: 'mousePressed', error: boom });

  let thrown: unknown;
  try {
    await dispatchClick(cdp, 300, 400, { from: { x: 0, y: 0 }, random: fixedRandom, sleep: noSleep });
    assert.fail('press 失败必须上抛');
  } catch (err) {
    thrown = err;
  }

  // finally 里的补发 release MUST NOT 覆盖/吞掉原始异常。
  assert.equal(thrown, boom);
  assert.deepEqual(cdp.mouseTypes().slice(-2), ['mousePressed', 'mouseReleased']);
  assertPressReleasePaired(cdp.mouseTypes());
});
