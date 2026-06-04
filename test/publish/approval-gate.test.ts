import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPublishApprovalSignalPath,
  waitForPublishApproval,
} from '../../src/publish/approval-gate.js';

test('approval gate: approved true resolves and consumes signal', async () => {
  const removed: string[] = [];
  const result = await waitForPublishApproval({
    requestId: 'req-1',
    signalDir: '/tmp',
    now: () => 0,
    timeoutMs: 5_000,
    pollIntervalMs: 100,
    readSignal: async () =>
      JSON.stringify({
        requestId: 'req-1',
        approved: true,
        ts: 1,
        payload: { title: 't', content: 'c', tags: ['x'] },
      }),
    removeSignal: async (path) => {
      removed.push(path);
    },
  });

  assert.deepEqual(result, {
    ok: true,
    requestId: 'req-1',
    signalPath: buildPublishApprovalSignalPath('req-1'),
    approved: true,
    signal: {
      requestId: 'req-1',
      approved: true,
      ts: 1,
      payload: { title: 't', content: 'c', tags: ['x'] },
    },
  });
  assert.deepEqual(removed, [buildPublishApprovalSignalPath('req-1')]);
});

test('approval gate: approved false rejects explicitly', async () => {
  const result = await waitForPublishApproval({
    requestId: 'req-2',
    now: () => 0,
    timeoutMs: 5_000,
    pollIntervalMs: 100,
    readSignal: async () =>
      JSON.stringify({
        requestId: 'req-2',
        approved: false,
        ts: 2,
        payload: { title: 't', content: 'c', tags: ['x'] },
      }),
    removeSignal: async () => undefined,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'approval_rejected');
  assert.equal(result.approved, false);
});

test('approval gate: missing signal times out', async () => {
  let nowValue = 0;
  const sleeps: number[] = [];
  const result = await waitForPublishApproval({
    requestId: 'req-3',
    timeoutMs: 250,
    pollIntervalMs: 100,
    now: () => nowValue,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowValue += ms;
    },
    readSignal: async () => {
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    },
  });

  assert.deepEqual(sleeps, [100, 100]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'approval_timeout');
});

test('approval gate: invalid signal fails fast', async () => {
  const result = await waitForPublishApproval({
    requestId: 'req-4',
    timeoutMs: 5_000,
    pollIntervalMs: 100,
    now: () => 0,
    readSignal: async () =>
      JSON.stringify({
        requestId: 'wrong-request-id',
        approved: true,
        ts: 3,
        payload: { title: 't', content: 'c', tags: ['x'] },
      }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signal_request_id_mismatch:wrong-request-id');
});