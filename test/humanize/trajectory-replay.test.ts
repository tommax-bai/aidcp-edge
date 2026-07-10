import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTrajectory, replayTrajectory, type MouseEventSink } from '../../src/humanize/trajectory-replay.js';
import type { CaptchaAssistTrajectoryPayload } from '../../src/comm/protocol.js';

const okTraj = (): CaptchaAssistTrajectoryPayload => ({
  v: 1,
  samples: [
    { x: 0.1, y: 0.1, t: 0 },
    { x: 0.9, y: 0.9, t: 100 },
  ],
  clicks: [1],
});

test('sanitizeTrajectory: 合法轨迹放行', () => {
  assert.ok(sanitizeTrajectory(okTraj(), 1));
});

test('sanitizeTrajectory: 各类畸形一律判无效（回落合成）', () => {
  assert.equal(sanitizeTrajectory(undefined, 1), null);
  assert.equal(sanitizeTrajectory({ ...okTraj(), v: 2 as unknown as 1 }, 1), null, '版本不符');
  assert.equal(sanitizeTrajectory({ ...okTraj(), samples: [] }, 1), null, '空样本');
  assert.equal(sanitizeTrajectory({ ...okTraj(), clicks: [1, 0] }, 1), null, 'clicks 长度≠点数');
  assert.equal(sanitizeTrajectory({ ...okTraj(), clicks: [5] }, 1), null, 'clicks 下标越界');
  assert.equal(
    sanitizeTrajectory({ v: 1, samples: [{ x: 1.5, y: 0.1, t: 0 }], clicks: [0] }, 1),
    null,
    '坐标越界',
  );
  const tooMany = { v: 1 as const, samples: Array.from({ length: 251 }, (_, i) => ({ x: 0.5, y: 0.5, t: i })), clicks: [0] };
  assert.equal(sanitizeTrajectory(tooMany, 1), null, '样本超上限');
});

class FakeSink implements MouseEventSink {
  readonly calls: Array<{ type: unknown; x: unknown; y: unknown }> = [];
  async send(_method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ type: params?.type, x: params?.x, y: params?.y });
    return {};
  }
}

test('replayTrajectory: press 落权威点，且 press 前补一帧 move 到权威点（消瞬移伪影）', async () => {
  const sink = new FakeSink();
  // crop 全图 400×400；point 权威 (0.5,0.5)→(200,200)；但按下样本坐标 (0.9,0.9)→(360,360) 故意不同。
  await replayTrajectory(
    sink,
    { x: 0, y: 0, width: 400, height: 400 },
    [{ x: 0.5, y: 0.5 }],
    okTraj(),
    () => 0.5, // 亚像素=0、停顿确定
    async () => {},
  );

  const events = sink.calls.filter((c) => c.type === 'mouseMoved' || c.type === 'mousePressed' || c.type === 'mouseReleased');
  const pressIdx = events.findIndex((e) => e.type === 'mousePressed');
  assert.ok(pressIdx > 0, '有 mousePressed');
  // 落点权威 (200,200)，非样本漂移点 (360,360)。
  assert.deepEqual([events[pressIdx].x, events[pressIdx].y], [200, 200]);
  // press 前一帧必须是 move 到权威点 (200,200)（mousedown 坐标 == 最后 mousemove 坐标）。
  assert.equal(events[pressIdx - 1].type, 'mouseMoved');
  assert.deepEqual([events[pressIdx - 1].x, events[pressIdx - 1].y], [200, 200]);
  // press 次数 == 点数。
  assert.equal(events.filter((e) => e.type === 'mousePressed').length, 1);
});

test('replayTrajectory: 多点非单调 clicks 也各按到正确权威点', async () => {
  const sink = new FakeSink();
  // 两点：A 权威 (0.25,0.25)→(100,100)，B 权威 (0.75,0.75)→(300,300)。
  // clicks=[3,1] → 点 A 在样本 3 按、点 B 在样本 1 按（非单调），按样本下标查表各按各的。
  const traj: CaptchaAssistTrajectoryPayload = {
    v: 1,
    samples: [
      { x: 0.1, y: 0.1, t: 0 },
      { x: 0.75, y: 0.75, t: 50 },
      { x: 0.5, y: 0.5, t: 100 },
      { x: 0.25, y: 0.25, t: 150 },
    ],
    clicks: [3, 1],
  };
  await replayTrajectory(
    sink,
    { x: 0, y: 0, width: 400, height: 400 },
    [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.75 }],
    traj,
    () => 0.5,
    async () => {},
  );
  const presses = sink.calls.filter((c) => c.type === 'mousePressed');
  assert.equal(presses.length, 2);
  // 样本序：s=1 按点 B(300,300)，s=3 按点 A(100,100)。
  assert.deepEqual([presses[0].x, presses[0].y], [300, 300]);
  assert.deepEqual([presses[1].x, presses[1].y], [100, 100]);
});
