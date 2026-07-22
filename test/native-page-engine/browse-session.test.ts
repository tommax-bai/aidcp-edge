import assert from 'node:assert/strict';
import test from 'node:test';
import type { EdgeClient } from '../../src/client/edge-client.js';
import type {
  ActionCompletedPayload,
  Envelope,
  MessageType,
  PageCardsPayload,
} from '../../src/comm/protocol.js';
import { NativeBrowseSession } from '../../src/native-page-engine/browse-session.js';
import type {
  NativePageCommand,
  NativePageCommandExecution,
} from '../../src/native-page-engine/client.js';
import type { NativePageRuntime } from '../../src/native-page-engine/runtime.js';

function envelope<T extends MessageType>(type: T, payload: Record<string, unknown>): Envelope {
  return { v: 2, type, id: `env-${type}`, ts: Date.now(), payload } as Envelope;
}

function harness(execute: (
  ownerId: string,
  command: NativePageCommand,
) => Promise<NativePageCommandExecution>) {
  const executions: Array<{ ownerId: string; command: NativePageCommand }> = [];
  const actions: ActionCompletedPayload[] = [];
  const cards: PageCardsPayload[] = [];
  const closedOwners: string[] = [];
  const runtime = {
    async execute(ownerId: string, command: NativePageCommand) {
      executions.push({ ownerId, command });
      return execute(ownerId, command);
    },
    async closeOwner(ownerId: string) { closedOwners.push(ownerId); },
  } as unknown as NativePageRuntime;
  const client = {
    reportActionCompleted(payload: ActionCompletedPayload) { actions.push(payload); },
    reportPageCards(payload: PageCardsPayload) { cards.push(payload); },
  } as unknown as EdgeClient;
  const session = new NativeBrowseSession({ runtime, client, startupId: 'startup-native-test' });
  return { session, executions, actions, cards, closedOwners };
}

const searchPayload = {
  taskId: 'task-comment-1',
  activityId: 'activity-search-1',
  purpose: 'task_targeting',
  scope: 'global',
  keyword: 'AI Agent实战',
};

test('quiesced Native session admits the coordinator-owned task command', async () => {
  const h = harness(async () => ({
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: { kind: 'page_cards', value: { cards: [{ index: 0, title: 'result' }] } },
  }));
  await h.session.quiesceForTask();

  await h.session.onCloudCommand(envelope('search.execute', searchPayload));

  assert.equal(h.executions.length, 1);
  assert.equal(h.executions[0]?.ownerId, searchPayload.taskId);
  assert.equal(h.executions[0]?.command.kind, 'search_execute');
  assert.equal(h.cards.length, 1);
  assert.equal(h.actions.length, 1);
  assert.deepEqual(h.actions[0], {
    action: 'search',
    ok: true,
    activityId: searchPayload.activityId,
    purpose: searchPayload.purpose,
    scope: searchPayload.scope,
    actuated: true,
    searchOutcome: 'results_ready',
    resultCount: 1,
  });
});

test('quiesced Native session rejects ordinary browse without touching runtime', async () => {
  const h = harness(async () => assert.fail('runtime must not execute ordinary browse while quiesced'));
  await h.session.quiesceForTask();

  await h.session.onCloudCommand(envelope('page.scroll', { reason: 'ordinary' }));

  assert.equal(h.executions.length, 0);
  assert.deepEqual(h.actions, [{ action: 'page.scroll', ok: false, reason: 'native_session_quiesced' }]);
});

test('pre-actuation Native search rejection keeps one valid correlated terminal', async () => {
  const h = harness(async () => assert.fail('runtime must not execute an unowned search while quiesced'));
  await h.session.quiesceForTask();

  await h.session.onCloudCommand(envelope('search.execute', {
    ...searchPayload,
    taskId: undefined,
  }));

  assert.equal(h.executions.length, 0);
  assert.deepEqual(h.actions, [{
    action: 'search',
    ok: false,
    reason: 'native_session_quiesced',
    activityId: searchPayload.activityId,
    purpose: searchPayload.purpose,
    scope: searchPayload.scope,
    actuated: false,
    searchOutcome: 'not_submitted',
  }]);
});

test('Native empty search cards report no_results exactly once', async () => {
  const h = harness(async () => ({
    ok: true,
    effectPhase: 'confirmed',
    reasonCode: 'confirmed',
    output: { kind: 'page_cards', value: { cards: [] } },
  }));
  await h.session.quiesceForTask();

  await h.session.onCloudCommand(envelope('search.execute', searchPayload));

  assert.equal(h.cards.length, 1);
  assert.deepEqual(h.actions, [{
    action: 'search',
    ok: true,
    activityId: searchPayload.activityId,
    purpose: searchPayload.purpose,
    scope: searchPayload.scope,
    actuated: true,
    searchOutcome: 'no_results',
    resultCount: 0,
  }]);
});

test('Native search execution error preserves effect-phase honesty and correlation', async () => {
  const error = Object.assign(new Error('CDP execution failed'), {
    code: 'cdp_error',
    detail: { effectPhase: 'ambiguous' },
  });
  const h = harness(async () => { throw error; });
  await h.session.quiesceForTask();

  await h.session.onCloudCommand(envelope('search.execute', searchPayload));

  assert.equal(h.actions.length, 1);
  assert.deepEqual(h.actions[0], {
    action: 'search',
    ok: false,
    reason: 'native_effect_ambiguous',
    activityId: searchPayload.activityId,
    purpose: searchPayload.purpose,
    scope: searchPayload.scope,
    actuated: true,
    searchOutcome: 'failed_after_submit',
  });
});
