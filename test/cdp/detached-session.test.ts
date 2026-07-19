import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDetachedSession } from '../../src/cdp/session.js';

test('detached session starts browser-absent and page commands fail loudly without opening a socket', async () => {
  let sockets = 0;
  const session = createDetachedSession({
    client: {
      wsFactory: () => {
        sockets += 1;
        throw new Error('must not create a socket before wake');
      },
    },
  });

  assert.equal(session.cdp.isDetached(), true);
  assert.equal(session.cdp.isControlReady(), false);
  await assert.rejects(session.cdp.send('Runtime.evaluate', { expression: '1' }), /浏览器已释放/);
  assert.equal(sockets, 0);
  session.close();
});
