/**
 * ui-event-lines（edge-companion-ui 6.4/8.1）：核心侧 [ui-event] 行构造。
 * 红线断言：一事一行、宁缺毋假（空昵称不发 identity / 无标题不带 title）、
 * 终态一次不改口、单条指令失败不在边缘抢判 failed。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PublishUiEventTracker,
  uiSnapshotToLines,
  publishCode,
  writeNoteStageLine,
  UI_EVENT_PREFIX,
} from '../../src/flows/ui-event-lines.js';
import type { PublishCommandPayload, PublishCommandResultPayload } from '../../src/comm/protocol.js';

function cmd(kind: PublishCommandPayload['kind'], seq: number, params: unknown = {}, recordId = 83): PublishCommandPayload {
  return { taskId: 'task-publish-1', recordId, seq, kind, params: params as PublishCommandPayload['params'] };
}

function res(payload: PublishCommandPayload, ok: boolean, error?: string): PublishCommandResultPayload {
  return { recordId: payload.recordId, seq: payload.seq, kind: payload.kind, ok, ...(error ? { error } : {}) };
}

function parseLine(line: string): Record<string, any> {
  assert.ok(line.startsWith(`${UI_EVENT_PREFIX} `), `行必须以 ${UI_EVENT_PREFIX} 开头: ${line}`);
  assert.ok(!line.includes('\n'), '一事一行，绝不含换行');
  return JSON.parse(line.slice(UI_EVENT_PREFIX.length + 1));
}

test('ui-event-lines: submit 成功先报 submitted，同页 postId 成功才报 published', () => {
  const t = new PublishUiEventTracker();
  const fill = cmd('fill_field', 3, { fieldType: 'title', value: '春日手作分享' });
  t.observe(fill);
  assert.equal(t.onResult(fill, res(fill, true)), null, 'fill_field 成功不产终态行');

  const submit = cmd('submit_publish', 8);
  t.observe(submit);
  const submitted = t.onResult(submit, res(submit, true));
  assert.ok(submitted, '页面接受提交必须产 submitted 行');
  const evt = parseLine(submitted!);
  assert.equal(evt.kind, 'publish');
  assert.equal(evt.publish?.state, 'submitted');
  assert.equal(evt.publish?.title, '春日手作分享');
  assert.equal(evt.publish?.code, publishCode(83));

  const capture = cmd('capture_postId', 9);
  const published = t.onResult(capture, res(capture, true));
  assert.ok(published, '同页取得 postId 才产 published 行');
  assert.equal(parseLine(published!).publish?.state, 'published');
});

test('ui-event-lines: 发布指令执行期间产出写笔记 loopStage presence', () => {
  const evt = parseLine(writeNoteStageLine());
  assert.equal(evt.kind, 'presence');
  assert.equal(evt.type, 'write_note');
  assert.equal(evt.loopStage, 'write');
  assert.match(evt.presence, /写笔记/);
  assert.equal(evt.sentence, undefined, '只切状态，不塞活动流');
});

test('ui-event-lines: 单条指令失败不在边缘抢判 failed（云端序列可能容错继续）', () => {
  const t = new PublishUiEventTracker();
  const tag = cmd('add_with_candidate', 5, { candidateKind: 'topic', candidates: ['a'] });
  t.observe(tag);
  assert.equal(t.onResult(tag, res(tag, false, 'no_target')), null, '中间步失败不得发 failed 行');
  const submit = cmd('submit_publish', 8);
  assert.equal(t.onResult(submit, res(submit, false, 'post_validation_failed')), null, 'submit 失败也由云端终判推 failed');
});

test('ui-event-lines: 在途回收 → failed 行；已 submitted 不倒写失败，published 后不改口', () => {
  const t = new PublishUiEventTracker();
  const fill = cmd('fill_field', 3, { fieldType: 'title', value: '标题' });
  t.observe(fill);
  const recycled = t.onRecycled(fill);
  assert.ok(recycled, '在途回收是边缘确定的终态失败');
  const evt = parseLine(recycled!);
  assert.equal(evt.publish?.state, 'failed');
  assert.equal(evt.publish?.title, '标题');
  assert.equal(t.onRecycled(fill), null, '终态只发一次');

  const t2 = new PublishUiEventTracker();
  const submit = cmd('submit_publish', 8, {}, 99);
  const submitted = t2.onResult(submit, res(submit, true));
  assert.ok(submitted);
  const capture = cmd('capture_postId', 9, {}, 99);
  assert.equal(t2.onRecycled(capture), null, 'submitted 后同 recordId 不倒写 failed');
});

test('ui-event-lines: 标题未知时 submitted/published 行都不带 title（宁缺毋假）', () => {
  const t = new PublishUiEventTracker();
  const submit = cmd('submit_publish', 8);
  const submitted = t.onResult(submit, res(submit, true));
  const evt = parseLine(submitted!);
  assert.equal(evt.publish?.state, 'submitted');
  assert.equal('title' in (evt.publish ?? {}), false);
  const capture = cmd('capture_postId', 9);
  const line = t.onResult(capture, res(capture, true));
  const published = parseLine(line!);
  assert.equal(published.publish?.state, 'published');
  assert.equal('title' in (published.publish ?? {}), false);
  assert.equal(published.publish?.code, '#83');
});

test('ui-event-lines: uiSnapshotToLines 全量快照 → identity + lastPublish 两行', () => {
  const lines = uiSnapshotToLines({
    account: { id: 'acc-1', nickname: '晚风手作' },
    lastPublish: { title: '上一篇', at: 1730000000000 },
  });
  assert.equal(lines.length, 2);
  const [identity, lastPublish] = lines.map(parseLine) as Array<Record<string, any>>;
  assert.equal(identity.kind, 'identity');
  assert.deepEqual(identity.account, { id: 'acc-1', name: '晚风手作' });
  assert.equal(lastPublish.kind, 'lastPublish');
  assert.deepEqual(lastPublish.lastPublish, { title: '上一篇', at: 1730000000000 });
});

test('ui-event-lines: 空昵称绝不发 identity（壳有环境名/尾4位兜底链，空名会顶掉兜底）', () => {
  assert.deepEqual(uiSnapshotToLines({ account: { id: 'acc-1', nickname: '' } }), []);
  assert.deepEqual(uiSnapshotToLines({ account: { id: 'acc-1', nickname: '   ' } }), []);
  assert.deepEqual(uiSnapshotToLines({ account: { id: 'acc-1' } }), []);
});

test('ui-event-lines: 审批状态推送 → publish 行透传 state/title/code', () => {
  const lines = uiSnapshotToLines({ publish: { state: 'pending', title: '候审笔记', code: '#84' } });
  assert.equal(lines.length, 1);
  const evt = parseLine(lines[0]);
  assert.equal(evt.kind, 'publish');
  assert.deepEqual(evt.publish, { state: 'pending', title: '候审笔记', code: '#84' });
});

test('ui-event-lines: 稿件预览转发正文/话题/配图，并限制图片协议与数量', () => {
  const lines = uiSnapshotToLines({
    publish: { state: 'pending', title: '洗稿标题', code: '#85' },
    publishPreview: {
      recordId: 85,
      code: '#85',
      kind: 'rewrite',
      title: '洗稿标题',
      content: '正文第一段\n正文第二段',
      topics: ['生活', '旅行'],
      images: ['https://cdn.example.com/1.jpg', 'javascript:alert(1)', 'https://cdn.example.com/2.jpg'],
      contentVersion: 1,
      updatedAt: 1730000000000,
    },
  });
  const preview = lines.map(parseLine).find((line) => line.kind === 'publishPreview');
  assert.ok(preview);
  assert.deepEqual(preview.publishPreview.images, ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg']);
  assert.equal(preview.publishPreview.content, '正文第一段\n正文第二段');
  assert.equal(preview.publishPreview.contentVersion, 1);
});

test('ui-event-lines: uiSnapshotToLines forwards account daily usage for Electron summary', () => {
  const lines = uiSnapshotToLines({
    dailyUsage: {
      asOf: 1730000001000,
      quotaLevel: 'normal',
      totals: { view: 12, like: 3, collect: 1, comment: 0, follow: 2, publish: 1 },
      quotas: { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
      saturated: ['publish'],
      windows: {
        minute: {
          startedAt: 1729999941000,
          windowMs: 60000,
          expiresAt: 1730000061000,
          refreshAt: 1730000061000,
          releaseAt: 1730000041000,
          totals: { view: 4, like: 3, collect: 0, comment: 0, follow: 0, publish: 0 },
          quotas: { view: 8, like: 3, collect: 2, comment: 1, follow: 1, publish: 1 },
          saturated: ['like'],
        },
        session: {
          active: true,
          startedAt: 1730000000000,
          windowMs: 600000,
          expiresAt: 1730000600000,
          totals: { view: 2, like: 1, collect: 0, comment: 0, follow: 0, publish: 0 },
          quotas: { like: 10, collect: 5, comment: 2, follow: 3 },
          saturated: [],
        },
      },
    },
  });
  assert.equal(lines.length, 1);
  const evt = parseLine(lines[0]);
  assert.equal(evt.kind, 'dailyUsage');
  assert.deepEqual(evt.dailyUsage, {
    asOf: 1730000001000,
    quotaLevel: 'normal',
    totals: { view: 12, like: 3, collect: 1, comment: 0, follow: 2, publish: 1 },
    quotas: { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
    saturated: ['publish'],
    windows: {
      minute: {
        startedAt: 1729999941000,
        windowMs: 60000,
        expiresAt: 1730000061000,
        refreshAt: 1730000061000,
        releaseAt: 1730000041000,
        totals: { view: 4, like: 3, collect: 0, comment: 0, follow: 0, publish: 0 },
        quotas: { view: 8, like: 3, collect: 2, comment: 1, follow: 1, publish: 1 },
        saturated: ['like'],
      },
      session: {
        active: true,
        startedAt: 1730000000000,
        windowMs: 600000,
        expiresAt: 1730000600000,
        totals: { view: 2, like: 1, collect: 0, comment: 0, follow: 0, publish: 0 },
        quotas: { like: 10, collect: 5, comment: 2, follow: 3 },
        saturated: [],
      },
    },
  });
});

test('ui-event-lines: uiSnapshotToLines forwards sanitized browser standby hint', () => {
  const lines = uiSnapshotToLines({
    browserStandby: {
      enabled: true,
      eligible: true,
      reason: ' view_quota:hour ',
      waitMs: 1_800_000.8,
      wakeAt: 1730001801000,
      generatedAt: 1730000001000,
      source: 'risk',
      minWaitMs: 1_200_000,
      warmupMs: 90_000,
    },
  });
  assert.equal(lines.length, 1);
  const evt = parseLine(lines[0]);
  assert.equal(evt.kind, 'browserStandby');
  assert.deepEqual(evt.browserStandby, {
    enabled: true,
    eligible: true,
    reason: 'view_quota:hour',
    waitMs: 1_800_000,
    wakeAt: 1730001801000,
    generatedAt: 1730000001000,
    source: 'risk',
    minWaitMs: 1_200_000,
    warmupMs: 90_000,
  });
});

test('ui-event-lines: malformed browser standby hint is dropped', () => {
  assert.deepEqual(
    uiSnapshotToLines({
      browserStandby: {
        enabled: true,
        eligible: true,
        reason: '',
        waitMs: 1,
        wakeAt: 1,
        generatedAt: 1,
        source: 'risk',
        minWaitMs: 1,
        warmupMs: 1,
      },
    }),
    [],
  );
});

test('ui-event-lines: 空快照 / 坏 at → 不产行（缺数据不造数据）', () => {
  assert.deepEqual(uiSnapshotToLines({}), []);
  assert.deepEqual(
    uiSnapshotToLines({ lastPublish: { title: '标题', at: Number.NaN } }),
    [],
    'at 非有限数不发 lastPublish',
  );
  assert.deepEqual(uiSnapshotToLines({ lastPublish: { title: '  ', at: 1 } }), [], '空标题不发 lastPublish');
});

// 人设绑定态三态（change persona-bound-tristate）：true / false 都必须转成行给外壳；
// 只转 true 的话，权威的「未绑」在核心里就被吞掉，外壳只能靠计时猜——猜错就给已设置人设的账号误弹向导。
test('ui-event-lines: personaBound 三态 → true/false 都出行，缺省不出行', () => {
  const boundLine = uiSnapshotToLines({ personaBound: true });
  assert.equal(boundLine.length, 1);
  assert.match(boundLine[0], /"kind":"personaBound"/);
  assert.match(boundLine[0], /"personaBound":true/);

  const unboundLine = uiSnapshotToLines({ personaBound: false });
  assert.equal(unboundLine.length, 1, '权威「未绑」必须发出去，绝不吞掉');
  assert.match(unboundLine[0], /"personaBound":false/);

  assert.deepEqual(uiSnapshotToLines({}), [], '未知（字段缺省）不发行：外壳保持未知，未知永不弹窗');
});
