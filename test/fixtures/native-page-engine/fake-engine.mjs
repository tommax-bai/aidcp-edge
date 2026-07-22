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
    protocolVersion: 1,
    engineVersion: 'test',
  })}\n`);

  const lines = createInterface({ input: process.stdin });
  lines.once('line', (line) => {
    const request = JSON.parse(line);
    if (mode === 'hang') {
      setInterval(() => undefined, 1000);
      return;
    }
    if (mode === 'native-error') {
      process.stdout.write(`${JSON.stringify({
        type: 'response',
        protocolVersion: 1,
        id: request.id,
        ok: false,
        error: { code: 'no_matching_target', message: 'no matching page target was found' },
      })}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({
      type: 'response',
      protocolVersion: 1,
      id: 'probe_unrelated',
      ok: true,
      result: {},
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'response',
      protocolVersion: 1,
      id: request.id,
      ok: true,
      result: {
        targetId: 'target-1',
        origin: 'https://www.xiaohongshu.com',
        path: '/explore',
        readyState: 'complete',
        pageKind: 'explore',
        signals: {
          feedCardCount: 12,
          noteDetailCount: 0,
          loginWallCount: 0,
          dialogCount: 0,
          profileSignalCount: 0,
          mainCount: 1,
        },
      },
    })}\n`);
  });
}
