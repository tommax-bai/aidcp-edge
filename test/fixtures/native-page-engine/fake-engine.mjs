import { createInterface } from 'node:readline';

const mode = process.env.AIDCP_FAKE_ENGINE_MODE || 'success';

if (mode === 'exit') {
  process.exit(23);
}

if (mode === 'malformed') {
  process.stdout.write('not-json\n');
  setInterval(() => undefined, 1000);
} else {
  process.stdout.write(`${JSON.stringify({
    type: 'ready',
    protocolVersion: 2,
    manifest: {
      engineVersion: 'test',
      platformAdapterVersion: 'multi-platform-test',
      platformAdapters: [
        { platform: 'xiaohongshu', adapterVersion: 'xiaohongshu-test' },
        { platform: 'facebook', adapterVersion: 'facebook-test' },
        { platform: 'wechat_channels', adapterVersion: 'wechat-channels-test' },
      ],
      capabilityDigest: 'a'.repeat(64),
    },
  })}\n`);

  let activeTaskId = 'probe-task';
  let pendingCommand;
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const request = JSON.parse(line);
    if (mode === 'hang') return;
    if (request.type === 'session_open') {
      if (mode === 'native-error') {
        process.stdout.write(`${JSON.stringify({
          type: 'response',
          protocolVersion: 2,
          id: request.id,
          ok: false,
          error: { code: 'no_matching_target', message: 'no matching page target was found' },
        })}\n`);
        return;
      }
      activeTaskId = request.taskId;
      process.stdout.write(`${JSON.stringify({
        type: 'response',
        protocolVersion: 2,
        id: request.id,
        ok: true,
        result: {
          sessionId: request.sessionId,
          taskId: request.taskId,
          state: 'ready',
          targetId: 'target-1',
          lastCommandId: 0,
        },
      })}\n`);
      return;
    }
    if (request.type === 'session_status') {
      process.stdout.write(`${JSON.stringify({
        type: 'response',
        protocolVersion: 2,
        id: request.id,
        ok: true,
        result: {
          sessionId: request.sessionId,
          taskId: activeTaskId,
          state: 'ready',
          targetId: 'target-1',
          lastCommandId: 1,
        },
      })}\n`);
      return;
    }
    if (request.type === 'command') {
      if (mode === 'cancel') {
        pendingCommand = request;
        return;
      }
      const result = request.command?.kind === 'browse_scroll'
        ? { kind: 'page_cards', value: { cards: [{ index: 0, title: 'Native card', likeCount: 1, collectCount: 2 }] } }
        : {
          kind: 'page_probe',
          value: {
            targetId: 'target-1',
            origin: 'https://www.xiaohongshu.com',
            path: '/explore',
            readyState: 'complete',
            pageKind: 'explore',
            signals: {
              feedCardCount: 12,
              noteDetailCount: 0,
              loginWallCount: 0,
              captchaSignalCount: 0,
              captchaSignalCount: 0,
              dialogCount: 0,
              profileSignalCount: 0,
              notificationSignalCount: 0,
              publishSignalCount: 0,
              errorSignalCount: 0,
              mainCount: 1,
            },
          },
        };
      process.stdout.write(`${JSON.stringify({
        type: 'command_result',
        protocolVersion: 2,
        id: 'command_unrelated',
        sessionId: request.sessionId,
        taskId: request.taskId,
        commandId: request.commandId,
        ok: true,
        effectPhase: 'confirmed',
        reasonCode: 'confirmed',
        result: {},
      })}\n`);
      process.stdout.write(`${JSON.stringify({
        type: 'command_result',
        protocolVersion: 2,
        id: request.id,
        sessionId: request.sessionId,
        taskId: request.taskId,
        commandId: request.commandId,
        ok: true,
        effectPhase: 'confirmed',
        reasonCode: 'confirmed',
        result,
      })}\n`);
      return;
    }
    if (request.type === 'cancel' && mode === 'cancel') {
      process.stdout.write(`${JSON.stringify({
        type: 'response',
        protocolVersion: 2,
        id: request.id,
        ok: true,
        result: {
          accepted: true,
          state: 'cancellation_requested',
          commandId: request.commandId,
        },
      })}\n`);
      if (pendingCommand) {
        process.stdout.write(`${JSON.stringify({
          type: 'command_result',
          protocolVersion: 2,
          id: pendingCommand.id,
          sessionId: pendingCommand.sessionId,
          taskId: pendingCommand.taskId,
          commandId: pendingCommand.commandId,
          ok: false,
          effectPhase: 'not_started',
          reasonCode: 'cancelled',
          error: { code: 'cancelled', message: 'native page command cancelled before dispatch' },
        })}\n`);
        pendingCommand = undefined;
      }
      return;
    }
    if (request.type === 'session_close') {
      process.stdout.write(`${JSON.stringify({
        type: 'response',
        protocolVersion: 2,
        id: request.id,
        ok: true,
        result: {
          sessionId: request.sessionId,
          taskId: activeTaskId,
          state: 'closed',
          targetId: 'target-1',
          lastCommandId: 1,
        },
      })}\n`);
      return;
    }
    if (request.type === 'shutdown') {
      process.stdout.write(`${JSON.stringify({
        type: 'response',
        protocolVersion: 2,
        id: request.id,
        ok: true,
        result: { state: 'shutting_down' },
      })}\n`, () => process.exit(0));
    }
  });
}
