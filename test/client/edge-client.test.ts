import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EdgeClient, type CloudWebSocket } from '../../src/client/edge-client.js';
import { EDGE_BUILD_CAPABILITIES } from '../../src/client/build-capabilities.js';
import { COMMAND_DIAGNOSTIC_PREFIX } from '../../src/client/command-diagnostics.js';
import { makeEnvelope, type Envelope } from '../../src/comm/protocol.js';

class FakeWebSocket implements CloudWebSocket {
  private readonly listeners = {
    open: [] as Array<() => void>,
    close: [] as Array<() => void>,
    error: [] as Array<(ev: unknown) => void>,
    message: [] as Array<(ev: { data: unknown }) => void>,
  };

  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    for (const cb of this.listeners.close) cb();
  }

  addEventListener(type: 'open', cb: () => void): void;
  addEventListener(type: 'close', cb: () => void): void;
  addEventListener(type: 'error', cb: (ev: unknown) => void): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    cb: (() => void) | ((ev: unknown) => void) | ((ev: { data: unknown }) => void),
  ): void {
    (this.listeners[type] as Array<typeof cb>).push(cb);
  }

  emitOpen(): void {
    for (const cb of this.listeners.open) cb();
  }

  emitMessage(env: Envelope): void {
    const data = JSON.stringify(env);
    for (const cb of this.listeners.message) cb({ data });
  }
}

async function connectClient(
  ws: FakeWebSocket,
  options: {
    logger?: (message: string) => void;
    platform?: string;
    runner?: ConstructorParameters<typeof EdgeClient>[0]['runner'];
  } = {},
): Promise<EdgeClient> {
  const client = new EdgeClient({
    url: 'ws://test',
    edgeId: 'edge-1',
    platform: options.platform,
    runner: options.runner ?? {
      run: async () => ({
        actionId: 'noop',
        ok: true,
        outcome: 'success',
        attempts: 1,
        reason: 'ok',
      }),
    },
    wsFactory: () => ws,
    idGen: (() => {
      const ids = ['hello-1', 'send-1', 'send-2'];
      let index = 0;
      return () => ids[index++] ?? `id-${index}`;
    })(),
    clock: () => 1,
    logger: options.logger ?? (() => {}),
  });
  const connecting = client.connect();
  ws.emitOpen();
  await Promise.resolve();
  ws.emitMessage(makeEnvelope('welcome', 'hello-1', 1, { sessionId: 's1', serverVersion: 'v1' }));
  await connecting;
  ws.sent.length = 0;
  return client;
}

function diagnosticEvents(logs: string[]): Array<Record<string, unknown>> {
  return logs.filter((line) => line.startsWith(`${COMMAND_DIAGNOSTIC_PREFIX} `))
    .map((line) => JSON.parse(line.slice(COMMAND_DIAGNOSTIC_PREFIX.length + 1)) as Record<string, unknown>);
}

async function connectInteractionClient(
  ws: FakeWebSocket,
  negotiated: boolean,
  logger: (message: string) => void = () => {},
  extensions = true,
): Promise<EdgeClient> {
  const client = new EdgeClient({
    url: 'ws://test',
    edgeId: 'edge-wc-1',
    platform: 'wechat_channels',
    app: 'wechat_channels',
    capabilities: ['identity', 'auth.browser_sidecar', 'interaction_inbox_v1',
      'interaction_reply_recovery_v1', 'interaction_offboarding_v1', 'interaction_runtime_controls_v1',
      'interaction_browser_control_v1'],
    accountId: 'finder-a',
    runner: {
      run: async () => ({ actionId: 'noop', ok: false, outcome: 'escalated', attempts: 0, reason: 'api_only' }),
    },
    wsFactory: () => ws,
    idGen: () => 'hello-wc-1',
    clock: () => 1,
    logger,
  });
  const connecting = client.connect();
  ws.emitOpen();
  await Promise.resolve();
  ws.emitMessage(makeEnvelope('welcome', 'hello-wc-1', 1, {
    sessionId: 'session-wc-1',
    serverVersion: 'v1',
    ...(negotiated ? {
      capabilities: extensions
        ? ['interaction_inbox_v1', 'interaction_reply_recovery_v1', 'interaction_offboarding_v1', 'interaction_runtime_controls_v1',
          'interaction_browser_control_v1']
        : ['interaction_inbox_v1'],
      ...(extensions ? { interactionRecovery: { offboardPending: false } } : {}),
    } : {}),
  }));
  await connecting;
  ws.sent.length = 0;
  return client;
}

test('edge-client: hello carries platform metadata without changing message type', async () => {
  const ws = new FakeWebSocket();
  const client = new EdgeClient({
    url: 'ws://test',
    edgeId: 'edge-1',
    platform: 'xiaohongshu',
    app: 'xhs',
    capabilities: ['locating', 'cdp', 'like', 'browse'],
    runner: {
      run: async () => ({
        actionId: 'noop',
        ok: true,
        outcome: 'success',
        attempts: 1,
        reason: 'ok',
      }),
    },
    wsFactory: () => ws,
    idGen: () => 'hello-1',
    clock: () => 1,
    logger: () => {},
  });
  const connecting = client.connect();
  ws.emitOpen();
  await Promise.resolve();

  const sent = JSON.parse(ws.sent[0]) as Envelope;
  assert.equal(sent.type, 'hello');
  // 构建能力位由 EdgeClient 构造函数统一并入——main.ts 装配路径。
  assert.deepEqual(sent.payload, {
    edgeId: 'edge-1',
    platform: 'xiaohongshu',
    app: 'xhs',
    capabilities: ['locating', 'cdp', 'like', 'browse', 'captcha_assist_text_v1', 'client_core_browser_executor_v1', 'client_data_plane_automation_engine_v1', 'search_activity_receipt_v1', 'host_standby_decision_telemetry_v1'],
  });

  ws.emitMessage(makeEnvelope('welcome', 'hello-1', 1, { sessionId: 's1', serverVersion: 'v1' }));
  await connecting;
});

test('edge-client: reports browser readiness separately from Cloud transport readiness', async () => {
  const ws = new FakeWebSocket();
  const client = new EdgeClient({
    url: 'ws://test',
    edgeId: 'edge-browser-state',
    platform: 'facebook',
    app: 'facebook',
    browserState: 'absent',
    runner: {
      run: async () => ({
        actionId: 'noop',
        ok: true,
        outcome: 'success',
        attempts: 1,
        reason: 'ok',
      }),
    },
    wsFactory: () => ws,
    idGen: (() => {
      const ids = ['hello-browser-state', 'browser-ready'];
      let index = 0;
      return () => ids[index++] ?? `id-${index}`;
    })(),
    clock: () => 1,
    logger: () => {},
  });

  const connecting = client.connect();
  ws.emitOpen();
  await Promise.resolve();
  const hello = JSON.parse(ws.sent[0]) as Envelope;
  assert.equal(hello.type, 'hello');
  assert.equal((hello.payload as { browserState?: string }).browserState, 'absent');

  ws.emitMessage(makeEnvelope('welcome', 'hello-browser-state', 1, { sessionId: 's1', serverVersion: 'v1' }));
  await connecting;
  ws.sent.length = 0;

  client.reportBrowserStatus({ state: 'ready', reason: 'wake_completed' });
  const status = JSON.parse(ws.sent[0]) as Envelope;
  assert.equal(status.type, 'browser.status');
  assert.deepEqual(status.payload, { state: 'ready', reason: 'wake_completed' });
});

test('edge-client: hello error envelope fail-closed and never becomes connected', async () => {
  const ws = new FakeWebSocket();
  const logs: string[] = [];
  const client = new EdgeClient({
    url: 'ws://test',
    edgeId: 'edge-rejected',
    runner: { run: async () => ({ actionId: 'noop', ok: false, outcome: 'escalated', attempts: 0, reason: 'unused' }) },
    wsFactory: () => ws,
    idGen: () => 'hello-rejected',
    clock: () => 1,
    logger: (line) => logs.push(line),
    reconnect: false,
  });

  const connecting = client.connect();
  ws.emitOpen();
  await Promise.resolve();
  assert.equal(client.isConnected(), false, 'transport open is not a Cloud session');
  ws.emitMessage(makeEnvelope('error', 'hello-rejected', 1, {
    code: 'account_mismatch',
    message: '账号与环境绑定不一致',
  }));

  await assert.rejects(connecting, /Cloud 握手失败 \[account_mismatch\]: 账号与环境绑定不一致/);
  assert.equal(client.isConnected(), false);
  assert.equal(client.getSessionId(), undefined);
  assert.ok(logs.some((line) => line.includes('Cloud 握手未成立')));
  assert.ok(logs.every((line) => !line.includes('已握手')));
});

test('edge-client: malformed welcome without session identity fails closed', async () => {
  for (const payload of [
    { serverVersion: 'v1' },
    { sessionId: 's1' },
    { sessionId: '   ', serverVersion: 'v1' },
  ]) {
    const ws = new FakeWebSocket();
    const client = new EdgeClient({
      url: 'ws://test',
      edgeId: 'edge-malformed',
      runner: { run: async () => ({ actionId: 'noop', ok: false, outcome: 'escalated', attempts: 0, reason: 'unused' }) },
      wsFactory: () => ws,
      idGen: () => 'hello-malformed',
      clock: () => 1,
      logger: () => {},
      reconnect: false,
    });
    const connecting = client.connect();
    ws.emitOpen();
    await Promise.resolve();
    ws.emitMessage(makeEnvelope('welcome', 'hello-malformed', 1, payload as never));
    await assert.rejects(connecting, /welcome 缺少有效 sessionId\/serverVersion/);
    assert.equal(client.isConnected(), false);
    assert.equal(client.getSessionId(), undefined);
  }
});

test('edge-client: hello carries optional account nickname for display enrichment', async () => {
  const ws = new FakeWebSocket();
  const client = new EdgeClient({
    url: 'ws://test',
    edgeId: 'edge-1',
    platform: 'facebook',
    app: 'fb',
    capabilities: ['identity', 'overlay', 'comment'],
    accountId: '1234567890',
    accountNickname: 'Test User',
    runner: {
      run: async () => ({
        actionId: 'noop',
        ok: true,
        outcome: 'success',
        attempts: 1,
        reason: 'ok',
      }),
    },
    wsFactory: () => ws,
    idGen: () => 'hello-1',
    clock: () => 1,
    logger: () => {},
  });
  const connecting = client.connect();
  ws.emitOpen();
  await Promise.resolve();

  const sent = JSON.parse(ws.sent[0]) as Envelope;
  assert.equal(sent.type, 'hello');
  assert.deepEqual(sent.payload, {
    edgeId: 'edge-1',
    platform: 'facebook',
    app: 'fb',
    capabilities: ['identity', 'overlay', 'comment', 'captcha_assist_text_v1', 'client_core_browser_executor_v1', 'client_data_plane_automation_engine_v1', 'search_activity_receipt_v1', 'host_standby_decision_telemetry_v1'],
    accountId: '1234567890',
    accountNickname: 'Test User',
  });

  ws.emitMessage(makeEnvelope('welcome', 'hello-1', 1, { sessionId: 's1', serverVersion: 'v1' }));
  await connecting;
});

test('edge-client: hello always advertises the captcha_assist_text_v1 build capability (merged in constructor, dedup, caps absent)', async () => {
  // design D8：构建能力位在 EdgeClient 构造函数内统一并入 hello.capabilities，与传入哪个 driver 能力无关。
  // 覆盖三种入参：能力缺省（undefined）、已含该位（不重复）、寻常 driver 列表——三条都必带且只带一次。
  for (const caps of [undefined, ['captcha_assist_text_v1'], ['locating', 'browse']] as Array<string[] | undefined>) {
    const ws = new FakeWebSocket();
    const client = new EdgeClient({
      url: 'ws://test',
      edgeId: 'edge-cap',
      ...(caps ? { capabilities: caps } : {}),
      runner: { run: async () => ({ actionId: 'noop', ok: true, outcome: 'success', attempts: 1, reason: 'ok' }) },
      wsFactory: () => ws,
      idGen: () => 'hello-cap',
      clock: () => 1,
      logger: () => {},
    });
    const connecting = client.connect();
    ws.emitOpen();
    await Promise.resolve();
    const hello = JSON.parse(ws.sent[0]) as Envelope<{ capabilities: string[] }>;
    const built = hello.payload.capabilities.filter((c) => c === 'captcha_assist_text_v1');
    assert.deepEqual(built, ['captcha_assist_text_v1'], `caps=${JSON.stringify(caps)} 应恰含一次构建能力位`);
    for (const c of EDGE_BUILD_CAPABILITIES) assert.ok(hello.payload.capabilities.includes(c));
    ws.emitMessage(makeEnvelope('welcome', 'hello-cap', 1, { sessionId: 's1', serverVersion: 'v1' }));
    await connecting;
  }
});

test('edge-client: wechat_channels hello declares controls capability and keeps its welcome snapshot', async () => {
  const ws = new FakeWebSocket();
  const client = new EdgeClient({
    url: 'ws://test',
    edgeId: 'edge-wc-1',
    platform: 'wechat_channels',
    app: 'wechat_channels',
    capabilities: ['identity', 'interaction_inbox_v1', 'interaction_reply_recovery_v1', 'interaction_offboarding_v1', 'interaction_runtime_controls_v1', 'interaction_browser_control_v1', 'interaction_test_data_reset_v1'],
    runner: { run: async () => ({ actionId: 'noop', ok: false, outcome: 'escalated', attempts: 0, reason: 'api_only' }) },
    wsFactory: () => ws,
    idGen: () => 'hello-wc-1',
    clock: () => 1,
    logger: () => {},
  });
  const connecting = client.connect();
  ws.emitOpen();
  await Promise.resolve();
  const hello = JSON.parse(ws.sent[0]) as Envelope<{ capabilities: string[]; platform: string }>;
  assert.equal(hello.payload.platform, 'wechat_channels');
  assert.ok(hello.payload.capabilities.includes('interaction_inbox_v1'));
  assert.ok(hello.payload.capabilities.includes('interaction_reply_recovery_v1'));
  assert.ok(hello.payload.capabilities.includes('interaction_offboarding_v1'));
  assert.ok(hello.payload.capabilities.includes('interaction_runtime_controls_v1'));
  assert.ok(hello.payload.capabilities.includes('interaction_browser_control_v1'));
  assert.ok(hello.payload.capabilities.includes('interaction_test_data_reset_v1'));
  // 构建能力位由 EdgeClient 构造函数统一并入（design D8）——wechat-channels/runtime.ts 装配路径。
  assert.ok(hello.payload.capabilities.includes('captcha_assist_text_v1'));
  ws.emitMessage(makeEnvelope('welcome', 'hello-wc-1', 1, {
    sessionId: 'session-wc-1',
    serverVersion: 'v1',
    capabilities: ['interaction_inbox_v1', 'interaction_reply_recovery_v1', 'interaction_offboarding_v1', 'interaction_runtime_controls_v1', 'interaction_browser_control_v1', 'interaction_test_data_reset_v1'],
    interactionRecovery: { offboardPending: false },
    interactionRuntime: {
      accountId: 'env-a', envKey: 'env-a', version: 2,
      commentsReadEnabled: true, commentsReplyEnabled: false,
      dmReadEnabled: true, dmSendTextEnabled: false, dmSendImageEnabled: false,
    },
  }));
  await connecting;
  assert.equal(client.isInteractionInboxNegotiated(), true);
  assert.equal(client.supportsCapability('interaction_reply_recovery_v1'), true);
  assert.equal(client.supportsCapability('interaction_offboarding_v1'), true);
  assert.equal(client.supportsCapability('interaction_browser_control_v1'), true);
  assert.equal(client.hasPendingInteractionOffboard(), false);
  assert.equal(client.getInteractionRuntimeControls()?.version, 2);
});

test('edge-client: negotiated runtime-control updates reach the active route and malformed payloads are rejected', async () => {
  const ws = new FakeWebSocket();
  const logs: string[] = [];
  const client = await connectInteractionClient(ws, true, (message) => logs.push(message));
  const calls: Envelope[] = [];
  client.onInteractionCommand((env) => calls.push(env));
  const payload = {
    accountId: 'env-a', envKey: 'env-a', version: 3,
    commentsReadEnabled: true, commentsReplyEnabled: false,
    dmReadEnabled: false, dmSendTextEnabled: false, dmSendImageEnabled: false as const,
  };
  ws.emitMessage(makeEnvelope('interaction.runtime.controls', 'controls-3', 2, payload));
  ws.emitMessage(makeEnvelope('interaction.runtime.controls', 'controls-bad', 2, { ...payload, dmSendImageEnabled: true } as never));
  assert.deepEqual(calls.map((env) => env.type), ['interaction.runtime.controls']);
  assert.ok(logs.some((line) => line.includes('拒绝非法 interaction')));
});

test('edge-client: old Cloud cannot activate interaction commands or cause a retry loop', async () => {
  const ws = new FakeWebSocket();
  const logs: string[] = [];
  const client = await connectInteractionClient(ws, false, (message) => logs.push(message));
  const calls: Envelope[] = [];
  client.onInteractionCommand((env) => calls.push(env));
  ws.emitMessage(makeEnvelope('interaction.sync.request', 'sync-old-cloud', 2, {
    requestId: 'request-1',
    envKey: 'env-a',
    accountId: 'finder-a',
    platform: 'wechat_channels',
    channel: 'comment',
    scopeExternalId: null,
    reason: 'scheduled',
    requestedAt: 1,
  }));
  assert.equal(client.isInteractionInboxNegotiated(), false);
  assert.equal(calls.length, 0);
  assert.equal(ws.sent.length, 0);
  assert.ok(logs.some((line) => line.includes('未协商')));
});

test('edge-client: negotiated offboarding without an explicit false welcome barrier is fail-closed', async () => {
  const ws = new FakeWebSocket();
  const client = new EdgeClient({
    url: 'ws://test', edgeId: 'edge-wc-1', platform: 'wechat_channels', app: 'wechat_channels',
    capabilities: ['interaction_inbox_v1', 'interaction_offboarding_v1'], accountId: 'finder-a',
    runner: { run: async () => ({ actionId: 'noop', ok: false, outcome: 'escalated', attempts: 0, reason: 'api_only' }) },
    wsFactory: () => ws, idGen: () => 'hello-wc-1', clock: () => 1, logger: () => {},
  });
  const connecting = client.connect();
  ws.emitOpen();
  await Promise.resolve();
  ws.emitMessage(makeEnvelope('welcome', 'hello-wc-1', 1, {
    sessionId: 'session-wc-1', serverVersion: 'v1',
    capabilities: ['interaction_inbox_v1', 'interaction_offboarding_v1'],
  }));
  await connecting;
  assert.equal(client.hasPendingInteractionOffboard(), true);
});

test('edge-client: negotiated interaction sync/send/reopen/browser-control and late ack reach the dedicated active route', async () => {
  const ws = new FakeWebSocket();
  const client = await connectInteractionClient(ws, true);
  const calls: Envelope[] = [];
  client.onInteractionCommand((env) => calls.push(env));
  ws.emitMessage(makeEnvelope('interaction.sync.request', 'sync-1', 2, {
    requestId: 'request-1', envKey: 'env-a', accountId: 'finder-a', platform: 'wechat_channels',
    channel: 'comment', scopeExternalId: null, reason: 'scheduled', requestedAt: 1,
  }));
  ws.emitMessage(makeEnvelope('interaction.reply.send', 'send-1', 2, {
    jobId: 'job-1', attemptId: 'attempt-1', idempotencyKey: 'a'.repeat(64),
    envKey: 'env-a', accountId: 'finder-a', platform: 'wechat_channels', channel: 'dm',
    target: { threadExternalId: 'thread-1', inboundMessageExternalId: 'message-1', parentExternalId: null },
    content: { type: 'text', text: 'hello' }, expiresAt: 100,
  }));
  ws.emitMessage(makeEnvelope('interaction.auth.reopen', 'reopen-1', 2, {
    requestId: 'reopen-request-1', envKey: 'env-a', accountId: 'finder-a', platform: 'wechat_channels',
    reason: 'user_requested', requestedAt: 1,
  }));
  ws.emitMessage(makeEnvelope('interaction.browser.control', 'browser-open-1', 2, {
    requestId: 'browser-control-request-1', envKey: 'env-a', accountId: 'finder-a', platform: 'wechat_channels',
    action: 'open', requestedAt: 1,
  }));
  ws.emitMessage(makeEnvelope('interaction.sync.ack', 'late-ack-1', 2, {
    batchId: 'batch-1', envKey: 'env-a', accountId: 'finder-a', platform: 'wechat_channels',
    channel: 'dm', scopeExternalId: 'thread-1', status: 'duplicate', cursorAfter: 'cursor-1',
    persisted: { threads: 1, messages: 1 }, errorCode: null, receivedAt: 2,
  }));
  assert.deepEqual(calls.map((env) => env.type), [
    'interaction.sync.request',
    'interaction.reply.send',
    'interaction.auth.reopen',
    'interaction.browser.control',
    'interaction.sync.ack',
  ]);
});

test('edge-client: recovery/offboard commands require their negotiated extension capabilities', async () => {
  const ws = new FakeWebSocket();
  const client = await connectInteractionClient(ws, true);
  const calls: Envelope[] = [];
  client.onInteractionCommand((env) => calls.push(env));
  ws.emitMessage(makeEnvelope('interaction.reply.result.ack', 'ack-1', 2, {
    jobId: 'job-1', attemptId: 'attempt-1', idempotencyKey: 'a'.repeat(64), envKey: 'env-a',
    accountId: 'finder-a', platform: 'wechat_channels', status: 'accepted', errorCode: null, receivedAt: 2,
  }));
  ws.emitMessage(makeEnvelope('interaction.offboard.command', 'offboard-1', 2, {
    offboardId: 'offboard-1', envKey: 'env-a', accountId: 'finder-a', platform: 'wechat_channels',
    reason: 'environment_unbind', requestedAt: 2, expiresAt: 100,
  }));
  assert.deepEqual(calls.map((env) => env.type), [
    'interaction.reply.result.ack', 'interaction.offboard.command',
  ]);
});

test('edge-client: base-only Cloud cannot activate recovery/offboard/browser-control commands', async () => {
  const ws = new FakeWebSocket();
  const logs: string[] = [];
  const client = await connectInteractionClient(ws, true, (message) => logs.push(message), false);
  const calls: Envelope[] = [];
  client.onInteractionCommand((env) => calls.push(env));
  ws.emitMessage(makeEnvelope('interaction.reply.reconcile', 'reconcile-unsupported', 2, {
    reconcileId: 'reconcile-1', envKey: 'env-a', accountId: 'finder-a', platform: 'wechat_channels',
    attempts: [], requestedAt: 2,
  }));
  ws.emitMessage(makeEnvelope('interaction.offboard.command', 'offboard-unsupported', 2, {
    offboardId: 'offboard-1', envKey: 'env-a', accountId: 'finder-a', platform: 'wechat_channels',
    reason: 'environment_unbind', requestedAt: 2, expiresAt: 100,
  }));
  ws.emitMessage(makeEnvelope('interaction.browser.control', 'browser-control-unsupported', 2, {
    requestId: 'browser-control-request-1', envKey: 'env-a', accountId: 'finder-a', platform: 'wechat_channels',
    action: 'open', requestedAt: 2,
  }));
  assert.equal(calls.length, 0);
  assert.equal(client.isInteractionInboxNegotiated(), true);
  assert.equal(client.supportsCapability('interaction_reply_recovery_v1'), false);
  assert.equal(client.supportsCapability('interaction_offboarding_v1'), false);
  assert.equal(client.supportsCapability('interaction_browser_control_v1'), false);
  assert.ok(logs.some((line) => line.includes('未协商')));
});

test('edge-client: malformed negotiated interaction payload is rejected before the handler', async () => {
  const ws = new FakeWebSocket();
  const logs: string[] = [];
  const client = await connectInteractionClient(ws, true, (message) => logs.push(message));
  const calls: Envelope[] = [];
  client.onInteractionCommand((env) => calls.push(env));
  ws.emitMessage(makeEnvelope('interaction.sync.request', 'sync-invalid', 2, {
    requestId: 'request-1', envKey: 'env-a', accountId: 'finder-a', platform: 'wechat_channels',
    channel: 'comment', scopeExternalId: null, reason: 'scheduled', requestedAt: 1,
    cookie: 'must-not-be-accepted',
  } as never));
  assert.equal(calls.length, 0);
  assert.ok(logs.some((line) => line.includes('拒绝非法 interaction')));
});

test('edge-client: reportNoteContent 收到 note.ack 正常 resolve', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);

  const promise = client.reportNoteContent({
    noteId: 'test-note-1',
    title: '测试笔记',
    summary: '内容',
    author: '作者',
    likeCount: 100,
    collectCount: 50,
  });

  // 模拟云端回 note.ack
  const sent = JSON.parse(ws.sent[0]);
  ws.emitMessage(makeEnvelope('note.ack', sent.id, 2, { received: true }));

  const resp = await promise;
  assert.equal(resp.type, 'note.ack');
  assert.deepEqual(resp.payload, { received: true });
});

/**
 * 平台段入口闸活性证明（change recategorize-nonpage-commands）：现役词汇无平台段命令、闸休眠，
 * 这两条用例是它活着的唯一证明——批 4 改名后第一条真实平台段命令到来时，闸已经在了。
 */
test('edge-client: 平台段与会话平台不符的命令被精确拒收（platform_mismatch，先于未登记检查）', async () => {
  const ws = new FakeWebSocket();
  const logs: string[] = [];
  await connectClient(ws, { logger: (m: string) => logs.push(m), platform: 'xiaohongshu' });
  ws.emitMessage(makeEnvelope('facebook.fake.command' as never, 'pm-1', 2, {} as never));
  assert.ok(logs.some((l) => l.includes('platform_mismatch') && l.includes('facebook.fake.command')),
    '发往 xiaohongshu 会话的 facebook.* 命令必须以 platform_mismatch 拒收，而非落进 operation_unclassified');
});

test('edge-client: 平台段匹配但未登记的命令仍走 fail-closed 未登记拒收', async () => {
  const ws = new FakeWebSocket();
  const logs: string[] = [];
  await connectClient(ws, { logger: (m: string) => logs.push(m), platform: 'xiaohongshu' });
  ws.emitMessage(makeEnvelope('xiaohongshu.fake.command' as never, 'pm-2', 2, {} as never));
  assert.ok(logs.some((l) => l.includes('operation_unclassified') && l.includes('xiaohongshu.fake.command')),
    '平台对了但没登记，闸放行到未登记检查——两道闸各答各的问题');
});

test('edge-client: xiaohongshu.feed.scroll 路由到 browseHandler', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws, { platform: 'xiaohongshu' });
  const calls: Envelope[] = [];
  client.onBrowseCommand((env) => calls.push(env));

  ws.emitMessage(makeEnvelope('xiaohongshu.feed.scroll', 'cmd-1', 2, { reason: 'scroll' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'xiaohongshu.feed.scroll');
});

test('edge-client: xiaohongshu.note.open 路由到 browseHandler', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws, { platform: 'xiaohongshu' });
  const calls: Envelope[] = [];
  client.onBrowseCommand((env) => calls.push(env));

  ws.emitMessage(makeEnvelope('xiaohongshu.note.open', 'cmd-2', 2, { index: 3, reason: 'open' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'xiaohongshu.note.open');
  assert.equal((calls[0].payload as any).index, 3);
});

test('edge-client: xiaohongshu.note.close 路由到 browseHandler', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws, { platform: 'xiaohongshu' });
  const calls: Envelope[] = [];
  client.onBrowseCommand((env) => calls.push(env));

  ws.emitMessage(makeEnvelope('xiaohongshu.note.close', 'cmd-3', 2, { reason: 'close' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'xiaohongshu.note.close');
});

// change facebook-browse-and-like-loop（task 4.4）：FB 浏览/点赞独立命令 MUST 放行到 browseHandler，
// 绝不落入「其他主动消息暂忽略」被静默丢弃（typecheck 抓不到白名单遗漏）。词汇批 4 起 FB 浏览命令
// 带 facebook. 平台段；此断言锁死它们不被误从白名单移除而回归静默丢弃。
const FB_BROWSE_COMMANDS = ['facebook.feed.scroll', 'facebook.note.open', 'facebook.note.close', 'interaction.like', 'navigation.back'] as const;
for (const type of FB_BROWSE_COMMANDS) {
  test(`edge-client: Facebook 浏览命令 ${type} 路由到 browseHandler（不得静默丢弃）`, async () => {
    const ws = new FakeWebSocket();
    const client = await connectClient(ws, { platform: 'facebook' });
    const calls: Envelope[] = [];
    client.onBrowseCommand((env) => calls.push(env));

    ws.emitMessage(makeEnvelope(type, `fb-${type}`, 2, { thinkMs: 0 }));
    assert.equal(calls.length, 1, `${type} 应被路由到 browseHandler 而非在入口丢弃`);
    assert.equal(calls[0].type, type);
  });
}

test('edge-client: 平台段命令与无平台段控制命令混发均正常路由', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws, { platform: 'xiaohongshu' });
  const calls: Envelope[] = [];
  client.onBrowseCommand((env) => calls.push(env));

  ws.emitMessage(makeEnvelope('xiaohongshu.feed.scroll', 'cmd-4', 2, { reason: 'next' }));
  ws.emitMessage(makeEnvelope('session.end', 'cmd-5', 2, { reason: 'end' }));
  ws.emitMessage(makeEnvelope('xiaohongshu.search.execute', 'cmd-6', 2, { keyword: 'AI' }));

  assert.equal(calls.length, 3);
  assert.equal(calls[0].type, 'xiaohongshu.feed.scroll');
  assert.equal(calls[1].type, 'session.end');
  assert.equal(calls[2].type, 'xiaohongshu.search.execute');
});

// 回归：通知巡视（软中断离开流程）自身的命令 MUST 放行到 browseHandler。
// 历史 bug：入口路由白名单漏接 notification.*，命令在到达处理器前被静默丢弃，
// 导致巡视无回执 → 恢复链（excursion_resumer）永不收敛 → 浏览永挂 → 会话被看门狗杀。
// 与 cloud command-bridge 的 open_notifications/browse_notification_*/notification_back_home 映射一一对应。
const NOTIFICATION_EXCURSION_COMMANDS = [
  'xiaohongshu.notification.open',
  'xiaohongshu.notification.browse_comments',
  'xiaohongshu.notification.browse_likes',
  'xiaohongshu.notification.browse_follows',
  'xiaohongshu.notification.back_home',
] as const;

for (const type of NOTIFICATION_EXCURSION_COMMANDS) {
  test(`edge-client: ${type} 路由到 browseHandler（不得静默丢弃）`, async () => {
    const ws = new FakeWebSocket();
    const client = await connectClient(ws, { platform: 'xiaohongshu' });
    const calls: Envelope[] = [];
    client.onBrowseCommand((env) => calls.push(env));

    ws.emitMessage(makeEnvelope(type, `cmd-${type}`, 2, { thinkMs: 0 }));

    assert.equal(calls.length, 1, `${type} 应被路由到 browseHandler 而非在入口丢弃`);
    assert.equal(calls[0].type, type);
  });
}

// 回归：浏览闭环互动命令（点赞 / 收藏 / 关注 / 发评论）MUST 放行到 browseHandler。
// 历史 bug：入口路由白名单漏接 interaction.comment，云端 sendCommand action=comment 已发（飞书已审通过），
// 但命令在到达处理器前被静默丢弃 → 评论永不发出、无回执（实测 8 发 / 0 执行 / 0 回执）。
// 与 cloud command-bridge 的 comment→interaction.comment / like→interaction.like 映射一一对应（§2 第4处同步点）。
const INTERACTION_COMMANDS = [
  'interaction.like',
  'interaction.collect',
  'interaction.follow',
  'interaction.comment',
  // 评论点赞（AIDCP_COMMENT_LIKE）：2026-07-03 发现的同类存量缺口——cloud comment_like→
  // interaction.like_comment 已下发但白名单漏接、browse-session 处理分支永不可达；修复后锁死。
  'interaction.like_comment',
] as const;

for (const type of INTERACTION_COMMANDS) {
  test(`edge-client: ${type} 路由到 browseHandler（不得静默丢弃）`, async () => {
    const ws = new FakeWebSocket();
    const client = await connectClient(ws);
    const calls: Envelope[] = [];
    client.onBrowseCommand((env) => calls.push(env));

    ws.emitMessage(makeEnvelope(type, `cmd-${type}`, 2, { thinkMs: 0 }));

    assert.equal(calls.length, 1, `${type} 应被路由到 browseHandler 而非在入口丢弃`);
    assert.equal(calls[0].type, type);
  });
}

test('edge-client: facebook.group.join 路由到 browseHandler（Facebook 命令处理器），不得静默丢弃', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws, { platform: 'facebook' });
  const calls: Envelope[] = [];
  client.onBrowseCommand((env) => calls.push(env));

  ws.emitMessage(makeEnvelope('facebook.group.join', 'cmd-group-join', 2, { groupUrl: 'https://www.facebook.com/groups/1' }));

  assert.equal(calls.length, 1, 'facebook.group.join 应被路由到 handler 而非在入口丢弃');
  assert.equal(calls[0].type, 'facebook.group.join');
});

test('edge-client: edge.task.acquire/release 路由到任务控制处理器', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  const calls: Envelope[] = [];
  client.onEdgeTaskCommand((env) => calls.push(env));
  ws.emitMessage(makeEnvelope('edge.task.acquire', 'task-acquire', 2, {
    taskId: 'task-1', kind: 'publish', priority: 'human', leaseMs: 60_000,
  }));
  ws.emitMessage(makeEnvelope('edge.task.release', 'task-release', 3, {
    taskId: 'task-1', outcome: 'completed',
  }));
  assert.deepEqual(calls.map((env) => env.type), ['edge.task.acquire', 'edge.task.release']);
});
// 回归：陪伴界面数据快照（ui.snapshot，cloud 主动推送）MUST 路由到 onUiSnapshot 处理器，
// 不得在入口静默丢弃（§2 第4处同步点；edge-companion-ui 8.1）。
test('edge-client: ui.snapshot 路由到 uiSnapshotHandler（不得静默丢弃）', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  const calls: Envelope[] = [];
  client.onUiSnapshot((env) => calls.push(env));

  ws.emitMessage(
    makeEnvelope('ui.snapshot', 'cmd-ui-snapshot', 2, {
      account: { id: 'acc-1', nickname: '晚风手作' },
      lastPublish: { title: '一篇笔记', at: 1730000000000 },
    }),
  );

  assert.equal(calls.length, 1, 'ui.snapshot 应被路由到 uiSnapshotHandler 而非在入口丢弃');
  assert.equal(calls[0].type, 'ui.snapshot');
  assert.equal((calls[0].payload as { account?: { nickname?: string } }).account?.nickname, '晚风手作');
});

test('edge-client: ui.snapshot 未注册处理器时不抛错（静默容忍）', async () => {
  const ws = new FakeWebSocket();
  await connectClient(ws);
  // 不注册 onUiSnapshot，直接推送——不应抛异常
  ws.emitMessage(makeEnvelope('ui.snapshot', 'cmd-ui-snapshot-2', 2, {}));
});

test('edge-client: captcha assist capture/click 路由到 captchaAssistHandler（不得静默丢弃）', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  const calls: Envelope[] = [];
  client.onCaptchaAssistCommand((env) => calls.push(env));

  ws.emitMessage(makeEnvelope('captcha.assist.capture', 'cap-1', 2, { incidentId: 'incident-1', reason: 'refresh' }));
  ws.emitMessage(
    makeEnvelope('captcha.assist.click', 'click-1', 2, {
      incidentId: 'incident-1',
      snapshotId: 'snap-1',
      points: [{ x: 0.25, y: 0.75 }],
    }),
  );

  assert.deepEqual(calls.map((env) => env.type), ['captcha.assist.capture', 'captcha.assist.click']);
});

// 回归（change pacing-fallback-hardening）：中途风控档位刷新 pacing.update MUST 放行到 browseHandler，
// 漏白名单则在入口静默丢弃 → 边缘兜底节奏收不到升档（同 notification.* 活锁前车）。
test('edge-client: pacing.update 路由到 browseHandler（不得静默丢弃）', async () => {
  const ws = new FakeWebSocket();
  const client = await connectClient(ws);
  const calls: Envelope[] = [];
  client.onBrowseCommand((env) => calls.push(env));

  ws.emitMessage(makeEnvelope('pacing.update', 'cmd-pu', 2, { tempo: 1.6 }));

  assert.equal(calls.length, 1, 'pacing.update 应被路由到 browseHandler 而非在入口丢弃');
  assert.equal(calls[0].type, 'pacing.update');
  assert.equal((calls[0].payload as { tempo: number }).tempo, 1.6);
});

test('edge-client: unclassified active message fails closed before any handler', async () => {
  const ws = new FakeWebSocket();
  const logs: string[] = [];
  const client = new EdgeClient({
    url: 'ws://test',
    edgeId: 'edge-unclassified',
    runner: {
      run: async () => ({ actionId: 'noop', ok: true, outcome: 'success', attempts: 1, reason: 'unused' }),
    },
    wsFactory: () => ws,
    idGen: () => 'hello-unclassified',
    clock: () => 1,
    logger: (line) => logs.push(line),
  });
  const calls: Envelope[] = [];
  client.onBrowseCommand((env) => calls.push(env));
  client.onInteractionCommand((env) => calls.push(env));

  const connecting = client.connect();
  ws.emitOpen();
  await Promise.resolve();
  ws.emitMessage(makeEnvelope('welcome', 'hello-unclassified', 1, { sessionId: 's1', serverVersion: 'v1' }));
  await connecting;
  ws.emitMessage({ v: 2, type: 'future.command', id: 'unknown-1', ts: 2, payload: {} } as unknown as Envelope);

  assert.equal(calls.length, 0);
  assert.ok(logs.some((line) => line.includes('operation_unclassified type=future.command')));
});

test('edge-client: Cloud rebind closes only the old transport and completes a fresh hello', async () => {
  const oldWs = new FakeWebSocket();
  const newWs = new FakeWebSocket();
  const urls: string[] = [];
  const client = new EdgeClient({
    url: 'ws://old-cloud',
    edgeId: 'edge-rebind',
    runner: { run: async () => ({ actionId: 'noop', ok: true, outcome: 'success', attempts: 1, reason: 'unused' }) },
    wsFactory: (url) => {
      urls.push(url);
      return urls.length === 1 ? oldWs : newWs;
    },
    idGen: (() => {
      const ids = ['hello-old', 'hello-new'];
      let index = 0;
      return () => ids[index++] ?? `id-${index}`;
    })(),
    clock: () => 1,
    logger: () => {},
  });
  const connecting = client.connect();
  oldWs.emitOpen();
  await Promise.resolve();
  oldWs.emitMessage(makeEnvelope('welcome', 'hello-old', 1, { sessionId: 'old-session', serverVersion: 'v1' }));
  await connecting;

  const rebinding = client.rebind('wss://new-cloud');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(urls.length, 2, 'new socket must be installed before its open event is emitted');
  newWs.emitOpen();
  await Promise.resolve();
  newWs.emitMessage(makeEnvelope('welcome', 'hello-new', 1, { sessionId: 'new-session', serverVersion: 'v2' }));
  await rebinding;

  assert.deepEqual(urls, ['ws://old-cloud', 'wss://new-cloud']);
  assert.equal(client.getSessionId(), 'new-session');
  assert.equal(client.isConnected(), true);
  await client.closeAndWait();
});

test('edge-client: active browse command emits received then dispatched without exposing payload content', async () => {
  const ws = new FakeWebSocket();
  const logs: string[] = [];
  const client = await connectClient(ws, { logger: (line) => logs.push(line), platform: 'facebook' });
  let routed = false;
  client.onBrowseCommand(() => { routed = true; });

  ws.emitMessage(makeEnvelope('facebook.search.execute', 'search-secret-id', 1, {
    keyword: '绝密关键词',
    source: 'manager',
    maxResults: 12,
    container: 'https://www.facebook.com/groups/private?token=secret',
  }));

  assert.equal(routed, true);
  const events = diagnosticEvents(logs);
  assert.deepEqual(events.map((event) => event.stage), ['received', 'dispatched']);
  assert.equal(events[0].type, 'facebook.search.execute');
  assert.match(String(events[0].summary), /搜索词 5 字/);
  assert.match(String(events[0].summary), /已限定搜索容器/);
  assert.doesNotMatch(logs.join('\n'), /绝密关键词|facebook\.com|token=secret|search-secret-id/);
});

test('edge-client: command without a handler is rejected and never presented as executed', async () => {
  const ws = new FakeWebSocket();
  const logs: string[] = [];
  await connectClient(ws, { logger: (line) => logs.push(line), platform: 'xiaohongshu' });

  ws.emitMessage(makeEnvelope('xiaohongshu.note.open', 'note-open-1', 1, {
    noteId: 'private-note-id',
    url: 'https://example.test/secret?auth=token',
    surface: 'detail',
    purpose: 'read',
  }));

  const events = diagnosticEvents(logs);
  assert.deepEqual(events.map((event) => event.stage), ['received', 'rejected']);
  assert.equal(events[1].reason, 'handler_unavailable');
  assert.doesNotMatch(logs.join('\n'), /private-note-id|example\.test|auth=token/);
});

test('edge-client: plan diagnostics expose local step result but not plan/action/result text', async () => {
  const ws = new FakeWebSocket();
  const logs: string[] = [];
  await connectClient(ws, {
    logger: (line) => logs.push(line),
    runner: {
      run: async () => ({
        actionId: 'private-action-id',
        ok: false,
        outcome: 'escalated',
        attempts: 1,
        reason: 'private-result-detail',
      }),
    },
  });

  ws.emitMessage(makeEnvelope('plan.response', 'plan-private-id', 1, {
    reason: 'private-model-reason',
    steps: [{ actionId: 'private-action-id', op: 'input', goal: 'private-goal', value: 'private-value' }],
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const events = diagnosticEvents(logs);
  assert.deepEqual(events.map((event) => event.stage), ['received', 'dispatched', 'failed']);
  assert.equal(events[2].reason, 'step_failed');
  assert.doesNotMatch(
    logs.join('\n'),
    /private-model-reason|private-action-id|private-result-detail|private-goal|private-value|plan-private-id/,
  );
});

test('edge-client: unnegotiated interaction command is visibly rejected without reply disclosure', async () => {
  const ws = new FakeWebSocket();
  const logs: string[] = [];
  await connectInteractionClient(ws, false, (line) => logs.push(line));

  ws.emitMessage(makeEnvelope('interaction.reply.send', 'reply-private-id', 1, {
    jobId: 'job-secret',
    attemptId: 'attempt-secret',
    idempotencyKey: 'idempotency-secret',
    envKey: 'env-secret',
    accountId: 'account-secret',
    platform: 'wechat_channels',
    channel: 'dm',
    target: {
      threadExternalId: 'thread-secret',
      inboundMessageExternalId: 'message-secret',
      parentExternalId: null,
    },
    content: { type: 'text', text: '绝密私信正文' },
    expiresAt: Date.now() + 60_000,
  }));

  const events = diagnosticEvents(logs);
  assert.deepEqual(events.map((event) => event.stage), ['received', 'rejected']);
  assert.equal(events[1].reason, 'capability_not_negotiated');
  assert.doesNotMatch(logs.join('\n'), /绝密私信正文|job-secret|thread-secret|account-secret|reply-private-id/);
});
