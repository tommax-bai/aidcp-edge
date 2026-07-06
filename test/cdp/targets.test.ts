import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstPageTarget } from '../../src/cdp/targets.js';

function fetchTargets(targets: unknown[]): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => targets,
  })) as unknown as typeof fetch;
}

test('firstPageTarget: targetPredicate selects platform-allowed tab before urlIncludes', async () => {
  const target = await firstPageTarget({
    fetchImpl: fetchTargets([
      { id: '1', type: 'page', title: 'xhs', url: 'https://www.xiaohongshu.com/explore', webSocketDebuggerUrl: 'ws://xhs' },
      { id: '2', type: 'page', title: 'fb', url: 'https://www.facebook.com/', webSocketDebuggerUrl: 'ws://fb' },
    ]),
    urlIncludes: 'xiaohongshu.com',
    targetPredicate: (t) => t.url.includes('facebook.com'),
  });
  assert.equal(target.webSocketDebuggerUrl, 'ws://fb');
});

test('firstPageTarget: urlIncludes remains backward-compatible without predicate', async () => {
  const target = await firstPageTarget({
    fetchImpl: fetchTargets([
      { id: '1', type: 'page', title: 'fb', url: 'https://www.facebook.com/', webSocketDebuggerUrl: 'ws://fb' },
      { id: '2', type: 'page', title: 'xhs', url: 'https://www.xiaohongshu.com/explore', webSocketDebuggerUrl: 'ws://xhs' },
    ]),
    urlIncludes: 'xiaohongshu.com',
  });
  assert.equal(target.webSocketDebuggerUrl, 'ws://xhs');
});
