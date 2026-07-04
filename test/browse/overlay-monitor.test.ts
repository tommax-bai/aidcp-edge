import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CdpOverlayMonitor,
  classifyOverlay,
  captureBlockingOverlaySnapshot,
  buildClassifyOverlayJs,
  buildBlockingOverlaySnapshotJs,
  isBlockingKind,
  type OverlayKind,
} from '../../src/browse/overlay-monitor.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

/** 返回值由 ref.value 控制的假 CDP（Runtime.evaluate 回传该值）；ref.throwIt 时抛错。 */
function fakeCdp(ref: { value: unknown; throwIt?: boolean }): BrowseCdp {
  return {
    send: async () => {
      if (ref.throwIt) throw new Error('CDP boom');
      return { result: { value: ref.value } } as never;
    },
  };
}

/** 让 start() 的在途首个 tick 落定（避免与后续手动 tick 竞争）。 */
function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

test('classifyOverlay: 透传 evaluate 返回的类别；非法值兜底为 none', async () => {
  assert.equal(await classifyOverlay(fakeCdp({ value: 'captcha' })), 'captcha');
  assert.equal(await classifyOverlay(fakeCdp({ value: 'login' })), 'login');
  assert.equal(await classifyOverlay(fakeCdp({ value: 'dismissible' })), 'dismissible');
  assert.equal(await classifyOverlay(fakeCdp({ value: 'unknown' })), 'unknown');
  assert.equal(await classifyOverlay(fakeCdp({ value: 'none' })), 'none');
  assert.equal(await classifyOverlay(fakeCdp({ value: 'garbage' })), 'none');
});

test('isBlockingKind: login/captcha/unknown 阻断；none/dismissible 不阻断', () => {
  assert.equal(isBlockingKind('login'), true);
  assert.equal(isBlockingKind('captcha'), true);
  assert.equal(isBlockingKind('unknown'), true);
  assert.equal(isBlockingKind('none'), false);
  assert.equal(isBlockingKind('dismissible'), false);
});

test('CdpOverlayMonitor.tick: 状态翻转触发一次 onTransition；同状态不重复触发', async () => {
  const ref = { value: 'none' as unknown };
  const monitor = new CdpOverlayMonitor(fakeCdp(ref));
  const transitions: Array<[OverlayKind, OverlayKind]> = [];
  monitor.start((from, to) => transitions.push([from, to]));
  monitor.stop();
  await flush();
  transitions.length = 0; // 丢弃启动期噪声

  assert.equal(monitor.state, 'none');
  ref.value = 'captcha';
  await monitor.tick();
  assert.equal(monitor.state, 'captcha');
  await monitor.tick(); // 同状态：不应再触发
  assert.equal(transitions.length, 1, '同状态不应重复触发');
  assert.deepEqual(transitions[0], ['none', 'captcha']);

  ref.value = 'none';
  await monitor.tick();
  assert.equal(monitor.state, 'none');
  assert.equal(transitions.length, 2);
  assert.deepEqual(transitions[1], ['captcha', 'none']);
});

test('CdpOverlayMonitor.tick: 探测失败保持上一状态（sticky，不刷假翻转）', async () => {
  const ref = { value: 'none' as unknown, throwIt: false };
  const monitor = new CdpOverlayMonitor(fakeCdp(ref));
  const transitions: Array<[OverlayKind, OverlayKind]> = [];
  monitor.start((from, to) => transitions.push([from, to]));
  monitor.stop();
  await flush();
  transitions.length = 0;

  ref.value = 'captcha';
  await monitor.tick();
  assert.equal(monitor.state, 'captcha');

  ref.throwIt = true; // 探测抛错
  await monitor.tick();
  assert.equal(monitor.state, 'captcha', '探测失败应保持上一状态');
  assert.equal(transitions.length, 1, '探测失败不应产生翻转');

  ref.throwIt = false;
  ref.value = 'none';
  await monitor.tick();
  assert.equal(monitor.state, 'none');
  assert.equal(transitions.length, 2);
});

test('CdpOverlayMonitor.probeNow: fresh 探测；CDP 失败原样抛出', async () => {
  const ref = { value: 'captcha' as unknown, throwIt: false };
  const monitor = new CdpOverlayMonitor(fakeCdp(ref));
  assert.equal(await monitor.probeNow(), 'captcha');
  ref.throwIt = true;
  await assert.rejects(() => monitor.probeNow());
});

test('CdpOverlayMonitor.stop: 停止后即便定时器回调触发也不再 tick', async () => {
  const captured: Array<() => void> = [];
  let ticks = 0;
  const ref = { value: 'none' as unknown };
  const cdp: BrowseCdp = {
    send: async () => {
      ticks++;
      return { result: { value: ref.value } } as never;
    },
  };
  const monitor = new CdpOverlayMonitor(cdp, {
    pollMs: 1,
    setTimer: (fn) => {
      captured.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
  });
  monitor.start();
  await flush();
  const ticksAfterStart = ticks; // 首个 tick 已发生
  monitor.stop();
  captured[0]?.(); // 模拟定时器到点
  await flush();
  assert.equal(ticks, ticksAfterStart, 'stop 后定时器回调不应再触发 tick');
});

test('buildClassifyOverlayJs: 生成的 JS 含各类指纹与返回分支', () => {
  const js = buildClassifyOverlayJs();
  assert.match(js, /安全验证/); // 验证码文案
  assert.match(js, /扫码登录/); // 登录文案
  assert.match(js, /geetest/); // 厂商 host 指纹
  assert.match(js, /'captcha'/);
  assert.match(js, /'login'/);
  assert.match(js, /'dismissible'/);
  assert.match(js, /'unknown'/);
  assert.match(js, /'none'/);
});

test('captureBlockingOverlaySnapshot: normalizes text, DOM features, and first URL', async () => {
  const snapshot = await captureBlockingOverlaySnapshot(
    fakeCdp({
      value: {
        kind: 'unknown',
        firstDetectedUrl: 'https://www.xiaohongshu.com/explore',
        capturedAt: 123,
        text: 'content unavailable',
        dom: {
          tag: 'div',
          className: 'global-mask',
          rect: { x: 0, y: 0, width: 1280, height: 720 },
          hasIframe: false,
          hasClose: false,
          matchReasons: ['large_rect', 'fixed_or_absolute', 'no_close_control'],
        },
        candidates: [{ tag: 'div', text: 'content unavailable' }],
      },
    }),
    'unknown',
  );

  assert.equal(snapshot.kind, 'unknown');
  assert.equal(snapshot.firstDetectedUrl, 'https://www.xiaohongshu.com/explore');
  assert.equal(snapshot.text, 'content unavailable');
  assert.equal(snapshot.dom?.tag, 'div');
  assert.equal(snapshot.dom?.className, 'global-mask');
  assert.deepEqual(snapshot.dom?.matchReasons, ['large_rect', 'fixed_or_absolute', 'no_close_control']);
  assert.equal(snapshot.candidates.length, 1);
});

test('buildBlockingOverlaySnapshotJs: generated JS captures first URL and DOM feature fields', () => {
  const js = buildBlockingOverlaySnapshotJs('unknown');
  assert.match(js, /firstDetectedUrl/);
  assert.match(js, /matchReasons/);
  assert.match(js, /hasIframe/);
  assert.match(js, /hasClose/);
});
