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
  UI_EVENT_PREFIX,
} from '../../src/flows/ui-event-lines.js';
import type { PublishCommandPayload, PublishCommandResultPayload } from '../../src/comm/protocol.js';

function cmd(kind: PublishCommandPayload['kind'], seq: number, params: unknown = {}, recordId = 83): PublishCommandPayload {
  return { recordId, seq, kind, params: params as PublishCommandPayload['params'] };
}

function res(payload: PublishCommandPayload, ok: boolean, error?: string): PublishCommandResultPayload {
  return { recordId: payload.recordId, seq: payload.seq, kind: payload.kind, ok, ...(error ? { error } : {}) };
}

function parseLine(line: string): { kind: string; publish?: { state: string; title?: string; code?: string } } {
  assert.ok(line.startsWith(`${UI_EVENT_PREFIX} `), `行必须以 ${UI_EVENT_PREFIX} 开头: ${line}`);
  assert.ok(!line.includes('\n'), '一事一行，绝不含换行');
  return JSON.parse(line.slice(UI_EVENT_PREFIX.length + 1));
}

test('ui-event-lines: submit_publish 成功 → published 行，带 fill_field 截获的标题与编号', () => {
  const t = new PublishUiEventTracker();
  const fill = cmd('fill_field', 3, { fieldType: 'title', value: '春日手作分享' });
  t.observe(fill);
  assert.equal(t.onResult(fill, res(fill, true)), null, 'fill_field 成功不产终态行');

  const submit = cmd('submit_publish', 8);
  t.observe(submit);
  const line = t.onResult(submit, res(submit, true));
  assert.ok(line, 'submit 成功必须产 published 行');
  const evt = parseLine(line!);
  assert.equal(evt.kind, 'publish');
  assert.equal(evt.publish?.state, 'published');
  assert.equal(evt.publish?.title, '春日手作分享');
  assert.equal(evt.publish?.code, publishCode(83));
});

test('ui-event-lines: 单条指令失败不在边缘抢判 failed（云端序列可能容错继续）', () => {
  const t = new PublishUiEventTracker();
  const tag = cmd('add_with_candidate', 5, { candidateKind: 'topic', candidates: ['a'] });
  t.observe(tag);
  assert.equal(t.onResult(tag, res(tag, false, 'no_target')), null, '中间步失败不得发 failed 行');
  const submit = cmd('submit_publish', 8);
  assert.equal(t.onResult(submit, res(submit, false, 'post_validation_failed')), null, 'submit 失败也由云端终判推 failed');
});

test('ui-event-lines: 在途回收 → failed 行；终态只发一次、published 后不改口', () => {
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
  const published = t2.onResult(submit, res(submit, true));
  assert.ok(published);
  const capture = cmd('capture_postId', 9, {}, 99);
  assert.equal(t2.onRecycled(capture), null, 'published 后同 recordId 不再改口 failed');
});

test('ui-event-lines: 标题未知时 published 行不带 title（宁缺毋假）', () => {
  const t = new PublishUiEventTracker();
  const submit = cmd('submit_publish', 8);
  const line = t.onResult(submit, res(submit, true));
  const evt = parseLine(line!);
  assert.equal(evt.publish?.state, 'published');
  assert.equal('title' in (evt.publish ?? {}), false);
  assert.equal(evt.publish?.code, '#83');
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

test('ui-event-lines: 空快照 / 坏 at → 不产行（缺数据不造数据）', () => {
  assert.deepEqual(uiSnapshotToLines({}), []);
  assert.deepEqual(
    uiSnapshotToLines({ lastPublish: { title: '标题', at: Number.NaN } }),
    [],
    'at 非有限数不发 lastPublish',
  );
  assert.deepEqual(uiSnapshotToLines({ lastPublish: { title: '  ', at: 1 } }), [], '空标题不发 lastPublish');
});
