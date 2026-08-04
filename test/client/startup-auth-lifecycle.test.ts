import assert from 'node:assert/strict';
import test from 'node:test';
import type { CoreLifecycleCommand } from '../../src/client/core-lifecycle.js';
import { settleStartupAuthLifecycleInterrupt } from '../../src/client/startup-auth-lifecycle.js';

function harness(closeResults: boolean[], commands: CoreLifecycleCommand[] = []) {
  const calls: string[] = [];
  let commandIndex = 0;
  return {
    calls,
    deps: {
      closeOwnedBrowser: async () => {
        calls.push('close-browser');
        return closeResults.shift() ?? false;
      },
      reportBrowserClosed: async () => {
        calls.push('browser-closed');
        return true;
      },
      reportPaused: () => { calls.push('paused'); },
      reportResumed: () => { calls.push('resumed'); },
      reportCloseFailed: () => { calls.push('close-failed'); },
      releaseInterrupt: (command: CoreLifecycleCommand) => { calls.push(`release:${command}`); },
      nextCommand: async () => {
        const command = commands[commandIndex++];
        if (!command) throw new Error('unexpected lifecycle wait');
        calls.push(`next:${command}`);
        return command;
      },
      exit: (code: number) => { calls.push(`exit:${code}`); },
      logger: (line: string) => { calls.push(`log:${line}`); },
    },
  };
}

test('startup auth close confirms the owned browser before core exit', async () => {
  const h = harness([true]);
  const result = await settleStartupAuthLifecycleInterrupt('close', h.deps);
  assert.equal(result, 'exited');
  assert.deepEqual(h.calls, ['close-browser', 'browser-closed', 'exit:0']);
});

test('startup auth close failure blocks until an explicit close retry succeeds', async () => {
  const h = harness([false, true], ['close']);
  const result = await settleStartupAuthLifecycleInterrupt('close', h.deps);
  assert.equal(result, 'exited');
  assert.deepEqual(h.calls, [
    'close-browser',
    'close-failed',
    'release:close',
    'next:close',
    'close-browser',
    'browser-closed',
    'exit:0',
  ]);
});

test('startup auth close failure resumes only after an explicit resume command', async () => {
  const h = harness([false], ['resume']);
  const result = await settleStartupAuthLifecycleInterrupt('close', h.deps);
  assert.equal(result, 'resume');
  assert.deepEqual(h.calls, [
    'close-browser',
    'close-failed',
    'release:close',
    'next:resume',
    'resumed',
  ]);
});

test('startup auth waits when browser closure is proven but evidence delivery fails', async () => {
  const h = harness([true, true], ['pause_and_exit']);
  let reports = 0;
  h.deps.reportBrowserClosed = async () => {
    h.calls.push('browser-closed');
    reports += 1;
    return reports > 1;
  };
  const result = await settleStartupAuthLifecycleInterrupt('close', h.deps);
  assert.equal(result, 'exited');
  assert.deepEqual(h.calls, [
    'close-browser',
    'browser-closed',
    'close-failed',
    'release:close',
    'next:pause_and_exit',
    'close-browser',
    'browser-closed',
    'paused',
    'exit:0',
  ]);
});
