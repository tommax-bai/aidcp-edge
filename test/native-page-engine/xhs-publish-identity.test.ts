import assert from 'node:assert/strict';
import test from 'node:test';
import { installXhsDom, runXhsRouter as run } from './xhs-dom-fixture.js';

const MANAGE_URL = 'https://creator.xiaohongshu.com/new/note-manager?source=official';
const TARGET_TIME = Date.parse('2026-07-22T18:45:00+08:00');

function receiptOf(result: { output: { kind: string; value: Record<string, unknown> } }): Record<string, unknown> {
  assert.equal(result.output.kind, 'publish_receipt');
  return result.output.value;
}

test('E7 unbound immediate capture never guesses the first old note or creator query id', async () => {
  installXhsDom(
    '<main><a href="https://www.xiaohongshu.com/explore/old-note?xsec_token=old">旧帖</a></main>',
    'https://creator.xiaohongshu.com/publish/success?id=editor-session-7',
  );

  const result = await run({ kind: 'publish_capture_post_id', params: { recordId: 7, seq: 10 } });
  const receipt = receiptOf(result);

  assert.equal(result.effectPhase, 'ambiguous');
  assert.equal(receipt.ok, false);
  assert.equal(receipt.value, undefined);
  assert.equal(receipt.postUrl, undefined);
  assert.equal(receipt.error, 'publish_evidence_not_found');
});

test('E7 scheduled capture requires the complete Beijing date and minute', async () => {
  installXhsDom(`
    <main>
      <div class="note-card" data-note-id="old-scheduled">
        <span class="title">Exact title</span><span class="status">定时发布</span><time>2026-07-21 18:45</time>
      </div>
    </main>
  `, MANAGE_URL);

  const result = await run({
    kind: 'publish_capture_scheduled',
    params: { recordId: 7, seq: 11, scheduledTitle: 'Exact title', publishTime: TARGET_TIME },
  });

  assert.equal(receiptOf(result).ok, false, '同标题、同时分但日期不同的旧稿不能冒充目标定时稿');
  assert.equal(receiptOf(result).error, 'scheduled_record_not_found');
});

test('E7 generic UI data-id is not a scheduled platform identity', async () => {
  installXhsDom(`
    <main>
      <div class="note-card" data-id="ui-row-7">
        <span class="title">Exact title</span><span class="status">定时发布</span><time>2026-07-22 18:45</time>
      </div>
    </main>
  `, MANAGE_URL);

  const result = await run({
    kind: 'publish_capture_scheduled',
    params: { recordId: 7, seq: 12, scheduledTitle: 'Exact title', publishTime: TARGET_TIME },
  });

  assert.equal(receiptOf(result).ok, false);
  assert.equal(receiptOf(result).error, 'scheduled_platform_id_unavailable');
});

test('E7 scheduled capture returns the unique platform note id after full identity match', async () => {
  installXhsDom(`
    <main>
      <div class="note-card" data-note-id="scheduled-target">
        <span class="title">Exact title</span><span class="status">定时发布</span><time>2026年07月22日 18:45</time>
      </div>
      <div class="note-card" data-note-id="scheduled-other">
        <span class="title">Exact title</span><span class="status">定时发布</span><time>2026年07月21日 18:45</time>
      </div>
    </main>
  `, MANAGE_URL);

  const result = await run({
    kind: 'publish_capture_scheduled',
    params: { recordId: 7, seq: 13, scheduledTitle: 'Exact title', publishTime: TARGET_TIME },
  });

  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(receiptOf(result).ok, true);
  assert.equal(receiptOf(result).value, 'scheduled-target');
});

test('E7 reconciliation reports a still-scheduled target as pending', async () => {
  installXhsDom(`
    <main>
      <div class="note-card" data-note-id="scheduled-target">
        <span class="title">Exact title</span><span class="status">待发布</span><time>2026-07-22 18:45</time>
      </div>
    </main>
  `, MANAGE_URL);

  const result = await run({
    kind: 'publish_reconcile_scheduled',
    params: {
      recordId: 7,
      seq: 14,
      scheduledTitle: 'Exact title',
      scheduledPlatformId: 'scheduled-target',
      publishTime: TARGET_TIME,
    },
  });

  assert.equal(receiptOf(result).ok, false);
  assert.equal(receiptOf(result).error, 'scheduled_pending');
});

test('E7 reconciliation confirms one published row only with a matching tokenized public URL', async () => {
  installXhsDom(`
    <main>
      <div class="note-card" data-note-id="public-target">
        <span class="title">Exact title</span><span class="status">已发布</span><time>2026-07-22 18:45</time>
        <a href="https://www.xiaohongshu.com/explore/public-target?xsec_token=public-token">查看笔记</a>
      </div>
    </main>
  `, MANAGE_URL);

  const result = await run({
    kind: 'publish_reconcile_scheduled',
    params: {
      recordId: 7,
      seq: 15,
      scheduledTitle: 'Exact title',
      scheduledPlatformId: 'scheduled-internal-id',
      publishTime: TARGET_TIME,
    },
  });

  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(receiptOf(result).ok, true);
  assert.equal(receiptOf(result).value, 'public-target');
  assert.equal(
    receiptOf(result).postUrl,
    'https://www.xiaohongshu.com/explore/public-target?xsec_token=public-token',
  );
});

test('E7 reconciliation keeps a published id without a usable public URL unconfirmed', async () => {
  installXhsDom(`
    <main>
      <div class="note-card" data-note-id="public-target">
        <span class="title">Exact title</span><span class="status">已发布</span><time>2026-07-22 18:45</time>
        <a href="https://www.xiaohongshu.com/explore/public-target">裸详情链</a>
      </div>
    </main>
  `, MANAGE_URL);

  const result = await run({
    kind: 'publish_reconcile_scheduled',
    params: { recordId: 7, seq: 16, scheduledTitle: 'Exact title', publishTime: TARGET_TIME },
  });

  assert.equal(receiptOf(result).ok, false);
  assert.equal(receiptOf(result).error, 'public_link_unavailable');
});

test('E7 missing scheduled identity returns a typed publish receipt', async () => {
  installXhsDom('<main></main>', MANAGE_URL);

  for (const kind of ['publish_capture_scheduled', 'publish_reconcile_scheduled']) {
    const result = await run({ kind, params: { recordId: 7, seq: 17 } });
    assert.equal(result.output.kind, 'publish_receipt');
    assert.equal(receiptOf(result).ok, false);
    assert.equal(receiptOf(result).error, 'scheduled_identity_missing');
  }
});
