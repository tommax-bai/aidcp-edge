import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayReportGate, type OverlayReportKind } from '../../src/browse/overlay-report-gate.js';

interface GateHarness {
  gate: ReturnType<typeof createOverlayReportGate>;
  detected: OverlayReportKind[];
  clearedCount: () => number;
  /** 触发所有在途的延后确认（模拟确认窗到点）。 */
  fireScheduled: () => void;
  setStillUnknown: (v: boolean) => void;
}

function makeGate(): GateHarness {
  const detected: OverlayReportKind[] = [];
  let cleared = 0;
  let stillUnknown = true;
  const scheduled: Array<() => void> = [];
  const gate = createOverlayReportGate({
    sendDetected: (k) => detected.push(k),
    sendCleared: () => {
      cleared += 1;
    },
    isStillUnknown: () => stillUnknown,
    schedule: (fn) => {
      scheduled.push(fn);
    },
    confirmMs: 2000,
  });
  return {
    gate,
    detected,
    clearedCount: () => cleared,
    fireScheduled: () => {
      const fns = scheduled.splice(0);
      for (const fn of fns) fn();
    },
    setStillUnknown: (v) => {
      stillUnknown = v;
    },
  };
}

test('overlay-report-gate: 一闪而过的 unknown（确认前自愈）不上报、不发孤儿 cleared', () => {
  const h = makeGate();
  // none→unknown：仅排程确认，尚未上报
  h.gate.onTransition('none', 'unknown');
  assert.deepEqual(h.detected, [], '进入 unknown 当轮不得立即上报');
  // 确认窗到点前遮罩自愈：unknown→none
  h.gate.onTransition('unknown', 'none');
  // 现在触发在途确认——episode 已翻篇，应被 epoch 作废
  h.fireScheduled();
  assert.deepEqual(h.detected, [], '瞬时 unknown 自愈后确认到点不得补报');
  assert.equal(h.clearedCount(), 0, '从未上报过 detected，不得发孤儿 cleared');
});

test('overlay-report-gate: 持续 unknown 经确认后上报一次，自愈发配对 cleared', () => {
  const h = makeGate();
  h.gate.onTransition('none', 'unknown');
  // 确认窗到点仍为 unknown → 上报一次
  h.setStillUnknown(true);
  h.fireScheduled();
  assert.deepEqual(h.detected, ['unknown'], '持续 unknown 确认后上报一次');
  // 自愈
  h.gate.onTransition('unknown', 'none');
  assert.equal(h.clearedCount(), 1, '报过 detected 的 episode 自愈发一次配对 cleared');
});

test('overlay-report-gate: 确认到点但已自愈成非 unknown（isStillUnknown=false）不上报', () => {
  const h = makeGate();
  h.gate.onTransition('none', 'unknown');
  h.setStillUnknown(false); // 确认时监测态已不是 unknown
  h.fireScheduled();
  assert.deepEqual(h.detected, [], 'isStillUnknown=false 时确认不得上报');
  h.gate.onTransition('unknown', 'none');
  assert.equal(h.clearedCount(), 0, '未上报则不发 cleared');
});

test('overlay-report-gate: captcha 指纹即时上报、不经确认窗（不弱化真验证码）', () => {
  const h = makeGate();
  h.gate.onTransition('none', 'captcha');
  assert.deepEqual(h.detected, ['captcha'], 'captcha 必须当轮同步即时上报');
  h.gate.onTransition('captcha', 'none');
  assert.equal(h.clearedCount(), 1, 'captcha 自愈发配对 cleared');
});

test('overlay-report-gate: unknown→captcha 升级即时报 captcha，且不因在途确认双报', () => {
  const h = makeGate();
  h.gate.onTransition('none', 'unknown'); // 排程 unknown 确认
  h.gate.onTransition('unknown', 'captcha'); // 同 episode 升级为真验证码
  assert.deepEqual(h.detected, ['captcha'], 'unknown→captcha 应即时报 captcha');
  // 在途的 unknown 确认到点：本 episode 已报 captcha，不得再补报 unknown
  h.fireScheduled();
  assert.deepEqual(h.detected, ['captcha'], '在途 unknown 确认不得在已报 captcha 后双报');
  h.gate.onTransition('captcha', 'none');
  assert.equal(h.clearedCount(), 1, '整个 episode 自愈只发一次 cleared');
});

test('overlay-report-gate: login/dismissible 之间的切换不产生任何云端上报', () => {
  const h = makeGate();
  h.gate.onTransition('none', 'login');
  h.gate.onTransition('login', 'dismissible');
  h.gate.onTransition('dismissible', 'none');
  h.fireScheduled();
  assert.deepEqual(h.detected, [], 'login/dismissible 不入云端上报闸');
  assert.equal(h.clearedCount(), 0, 'login/dismissible 不发 cleared');
});
