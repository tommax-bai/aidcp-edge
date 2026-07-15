import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacebookLikeExecutor } from '../../src/facebook/like-executor.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

/**
 * feed 两段点赞（探针 P4，change facebook-feed-inline-browse task 2b）：
 *  - feed 态：单击「留下心情」只弹反应选择器浮层、按钮不翻转 → 现役单击执行器会 state_unchanged 误判失败；
 *    补第二段（点浮层「赞」项）才提交。
 *  - detail 态：单击即翻转（directToggle），picker 不弹、不触发第二段。
 *  - 独立见证 observation（surface + page-derived noteId）：shadow / 真点都带。
 */

/**
 * 阶段化 CDP 桩：verify 可给数组（逐轮推进）；picker-locate / observation 可控；
 * 记录 Input.dispatchMouseEvent 的 mousePressed（feed 两段提交走 CDP 坐标点击，不是 in-page click）。
 * feed 两段场景：verify 前几轮 reacted:false（picker 弹着），坐标点提交后转 reacted:true。
 */
function fakeCdp(phases: {
  resolve?: unknown;
  rect?: unknown;
  locate?: unknown;
  click?: unknown;
  verify?: unknown | unknown[];
  pickerLocate?: unknown;
  observation?: unknown;
  onEval?: (expr: string) => void;
  onPress?: (x: number, y: number) => void;
}): BrowseCdp {
  let verifyCall = 0;
  const pick = (v: unknown | unknown[], i: number): unknown => (Array.isArray(v) ? v[Math.min(i, v.length - 1)] : v);
  return {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Input.dispatchMouseEvent') {
        if (params?.type === 'mousePressed') phases.onPress?.(Number(params.x), Number(params.y));
        return {} as never;
      }
      if (method !== 'Runtime.evaluate') return {} as never;
      const expr = String(params?.expression ?? '');
      phases.onEval?.(expr);
      let value: unknown = {};
      if (expr.includes('/*aidcp:resolve*/')) value = phases.resolve ?? { status: 'ok', targetId: 'fb:AAA' };
      else if (expr.includes('/*aidcp:rect*/')) value = phases.rect ?? { found: true, top: 120, bottom: 500, viewportH: 800 };
      else if (expr.includes('/*aidcp:locate*/')) value = phases.locate ?? { found: true, already: false, label: '留下心情', text: '' };
      else if (expr.includes('/*aidcp:click*/')) value = phases.click ?? { clicked: true };
      // picker-locate（原 probe+commit 合并）：只回「赞」项坐标，提交由 dispatchClick 走 CDP press/release。
      else if (expr.includes('/*aidcp:picker-commit*/')) value = phases.pickerLocate ?? { found: true, cx: 100, cy: 100, fromX: 60, fromY: 200 };
      else if (expr.includes('/*aidcp:observation*/')) value = phases.observation ?? { found: false };
      else if (expr.includes('/*aidcp:verify*/')) value = pick(phases.verify ?? { tagged: true, identityMatch: true, found: true, reacted: true }, verifyCall++);
      else if (expr.includes('/*aidcp:cleartag*/')) value = { cleared: true };
      return { result: { value: JSON.stringify(value) } } as never;
    },
  };
}

const noSleep = { sleep: async () => {}, random: () => 0.5 };
const fastOpts = { verifyTimeoutMs: 200, verifyPollMs: 5, settleMs: 0, scrollRounds: 2 };
const NOTE = 'https://www.facebook.com/groups/111/posts/AAA/';

test('fb-like 两段: feed 单击不翻转+弹 picker → 坐标点「赞」项提交 → ok（feed 见证）', async () => {
  let pickerCommitted = false;
  const presses: { x: number; y: number }[] = [];
  const cdp = fakeCdp({
    // 单击后 verify 先 reacted:false（picker 弹着），坐标点提交后 reacted:true。
    verify: [
      { tagged: true, identityMatch: true, found: true, reacted: false, label: '留下心情', text: '' },
      { tagged: true, identityMatch: true, found: true, reacted: true, label: '从iQIYI的帖子中移除赞', text: '赞' },
    ],
    pickerLocate: { found: true, cx: 320, cy: 240, fromX: 300, fromY: 300 },
    observation: { found: true, surface: 'feed', noteId: 'fb:AAA', author: 'iQIYI', textPreviewHead: '正文头', reactionText: '3,830', articleIndex: 2 },
    onEval: (e) => {
      if (e.includes('/*aidcp:picker-commit*/')) pickerCommitted = true;
    },
    onPress: (x, y) => presses.push({ x, y }),
  });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE });
  assert.equal(r.ok, true);
  assert.equal(r.executed, true);
  assert.equal(pickerCommitted, true, 'feed 态必须补第二段定位「赞」项');
  assert.ok(
    presses.some((p) => Math.abs(p.x - 320) <= 20 && Math.abs(p.y - 240) <= 20),
    'feed 两段提交必须对浮层「赞」项坐标(320,240)派发 CDP mousePressed（in-page click 对浮层无效）',
  );
  assert.equal(r.observation?.surface, 'feed');
  assert.equal(r.observation?.noteId, 'fb:AAA');
  assert.equal(r.observation?.articleIndex, 2);
});

test('fb-like 两段: detail 单击即翻转（directToggle）→ 不弹 picker、不补第二段 → ok（detail 见证）', async () => {
  let pickerCommitted = false;
  const cdp = fakeCdp({
    verify: { tagged: true, identityMatch: true, found: true, reacted: true, label: '赞', text: '赞' },
    pickerLocate: { found: false, cx: 0, cy: 0, fromX: null, fromY: null },
    observation: { found: true, surface: 'detail', noteId: 'fb:AAA', author: '大白', textPreviewHead: '详情头', reactionText: '10' },
    onEval: (e) => {
      if (e.includes('/*aidcp:picker-commit*/')) pickerCommitted = true;
    },
  });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE });
  assert.equal(r.ok, true);
  assert.equal(pickerCommitted, false, 'detail 单击即翻转，绝不补第二段（防重复点成撤销）');
  assert.equal(r.observation?.surface, 'detail');
});

test('fb-like 两段: 单击不翻转且无 picker → state_unchanged（诚实失败，不假成功）', async () => {
  const cdp = fakeCdp({
    verify: { tagged: true, identityMatch: true, found: true, reacted: false, label: '留下心情', text: '' },
    pickerLocate: { found: false, cx: 0, cy: 0, fromX: null, fromY: null }, // 没弹浮层
  });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'state_unchanged');
  assert.equal(r.executed, true);
});

test('fb-like 两段: 补了第二段（坐标点提交）仍不翻转 → state_unchanged（只补一次，不无限点）', async () => {
  let commitCount = 0;
  let pressCount = 0;
  const cdp = fakeCdp({
    verify: { tagged: true, identityMatch: true, found: true, reacted: false, label: '留下心情', text: '' },
    pickerLocate: { found: true, cx: 320, cy: 240, fromX: 300, fromY: 300 },
    onEval: (e) => {
      if (e.includes('/*aidcp:picker-commit*/')) commitCount++;
    },
    onPress: () => pressCount++,
  });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'state_unchanged');
  assert.equal(commitCount, 1, '两段只补一次（定位）');
  assert.equal(pressCount, 1, '坐标提交只派发一次 press（不无限点，防重复点成撤销）');
});

test('fb-like 两段: shadow 也现读独立见证（不点击）', async () => {
  const cdp = fakeCdp({
    observation: { found: true, surface: 'feed', noteId: 'fb:AAA', author: 'iQIYI', articleIndex: 1 },
  });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE, shadow: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'shadow');
  assert.equal(r.executed, false);
  assert.equal(r.observation?.surface, 'feed');
  assert.equal(r.observation?.noteId, 'fb:AAA');
});
