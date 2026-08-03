import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  finalizeNonRetryableSetupTerminal,
  initializeOwnedCoreChild,
  setupTerminalExitDisposition,
} = require('../../src/electron/core-child-startup.cjs');
const fleet = require('../../src/electron/fleet.cjs');

class FakeStream extends EventEmitter {}

class FakeChild extends EventEmitter {
  pid: number | undefined;
  stdout: FakeStream | null | undefined;
  stderr: FakeStream | null | undefined;
  killSignals: string[] = [];
  emitKillError = false;

  constructor({ pid = 4312, streams = true }: { pid?: number | null; streams?: boolean } = {}) {
    super();
    this.pid = pid === null ? undefined : pid;
    this.stdout = streams ? new FakeStream() : null;
    this.stderr = streams ? new FakeStream() : undefined;
  }

  kill(signal = 'SIGTERM') {
    this.killSignals.push(signal);
    if (this.emitKillError) {
      this.emit('error', new Error(`${signal} delivery failed`));
      return false;
    }
    return true;
  }
}

function noopObservers(overrides: Record<string, (...args: any[]) => void> = {}) {
  return {
    stdout() {},
    stderr() {},
    message() {},
    spawnError() {},
    runtimeError() {},
    exit() {},
    close() {},
    ...overrides,
  };
}

test('owned child installs terminal and optional stream observers before successful setup projection', () => {
  const handle = { child: null as FakeChild | null, spawnCloudKey: 'ol' };
  const child = new FakeChild();
  const launchReady = Promise.resolve(true);
  let projectedTarget = '';

  const result = initializeOwnedCoreChild({
    handle,
    child,
    createLaunchReady: () => launchReady,
    observers: noopObservers(),
    prepare() {
      assert.equal(handle.child, child, 'ownership must exist before setup');
      for (const event of ['error', 'exit', 'close', 'message']) {
        assert.ok(child.listenerCount(event) > 0, `${event} observer must exist before setup`);
      }
      assert.ok(child.stdout && child.stdout.listenerCount('data') > 0);
      assert.ok(child.stderr && child.stderr.listenerCount('data') > 0);
      projectedTarget = handle.spawnCloudKey;
      return true;
    },
    onSetupFailure() { assert.fail('successful setup must not report failure'); },
    settleLaunchFailure() { assert.fail('successful setup must not settle failure'); },
    releaseStartReservation() {},
    requestTermination() { assert.fail('successful setup must not terminate child'); },
  });

  assert.equal(result.ok, true);
  assert.equal(result.launchReady, launchReady);
  assert.equal(projectedTarget, 'ol');
  assert.deepEqual(child.killSignals, []);
});

test('failed spawn with missing stdout/stderr reaches spawn-error cleanup instead of throwing first', () => {
  const handle = { child: null as FakeChild | null };
  const child = new FakeChild({ pid: null, streams: false });
  let spawnErrors = 0;
  let runtimeErrors = 0;

  initializeOwnedCoreChild({
    handle,
    child,
    createLaunchReady: () => Promise.resolve(false),
    observers: noopObservers({
      spawnError() {
        spawnErrors += 1;
        handle.child = null;
      },
      runtimeError() { runtimeErrors += 1; },
    }),
    prepare: () => true,
    onSetupFailure() {},
    settleLaunchFailure() {},
    releaseStartReservation() {},
    requestTermination() {},
  });

  child.emit('error', new Error('spawn ENOENT'));
  assert.equal(spawnErrors, 1);
  assert.equal(runtimeErrors, 0);
  assert.equal(handle.child, null);
});

test('post-spawn setup throw releases siblings but retains ownership across kill error until one terminal finalizer', async () => {
  const handle = { child: null as FakeChild | null, setupFailure: null as null | { summary: string } };
  const child = new FakeChild();
  child.emitKillError = true;
  let settleReady: ((value: boolean) => void) | undefined;
  const launchReady = new Promise<boolean>((resolve) => { settleReady = resolve; });
  let released = 0;
  let siblingAdvanced = false;
  let spawnErrors = 0;
  let runtimeErrors = 0;
  let finalizations = 0;
  const finalize = () => {
    if (handle.child !== child) return;
    finalizations += 1;
    handle.child = null;
  };

  const result = initializeOwnedCoreChild({
    handle,
    child,
    createLaunchReady: () => launchReady,
    observers: noopObservers({
      spawnError() {
        spawnErrors += 1;
        handle.child = null;
      },
      runtimeError() { runtimeErrors += 1; },
      exit: finalize,
      close: finalize,
    }),
    prepare() { throw new ReferenceError('status projection alias is not defined'); },
    onSetupFailure() { handle.setupFailure = { summary: '核心进程启动后初始化失败' }; },
    settleLaunchFailure() { settleReady?.(false); },
    releaseStartReservation() {
      released += 1;
      siblingAdvanced = true;
    },
    requestTermination() { child.kill('SIGTERM'); },
  });

  assert.equal(result.ok, false);
  assert.equal(await result.launchReady, false);
  assert.equal(released, 1);
  assert.equal(siblingAdvanced, true);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  assert.equal(runtimeErrors, 1, 'kill error after a confirmed spawn is non-terminal');
  assert.equal(spawnErrors, 0);
  assert.equal(handle.child, child, 'a potentially live child must retain ownership');
  assert.deepEqual(handle.setupFailure, { summary: '核心进程启动后初始化失败' });

  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  assert.equal(finalizations, 1);
  assert.equal(handle.child, null);
});

test('setup-failure disposition preserves stable cause and retries even after graceful SIGTERM exit 0', () => {
  const disposition = setupTerminalExitDisposition(
    { summary: '核心进程启动后初始化失败', retry: true },
    0,
    null,
  );
  assert.deepEqual(disposition, {
    retry: true,
    exitedAbnormally: true,
    respawnExitCode: 1,
    message: '核心进程启动后初始化失败。',
    failureSummary: '核心进程启动后初始化失败',
    observedExitCode: 0,
    observedSignal: null,
  });
  assert.deepEqual(
    fleet.decideRespawn(
      { exitCode: disposition.respawnExitCode, uptimeMs: 100, prevStreak: 0, shuttingDown: false },
      { maxConsecutiveFailures: 5, backoffBaseMs: 1_000, backoffMaxMs: 30_000, healthyUptimeMs: 60_000 },
    ),
    { action: 'respawn', delayMs: 1_000, streak: 1 },
  );
});

test('known proxy setup terminal is reprojected only after reap and never requests automatic respawn', () => {
  const handle = { child: null as FakeChild | null };
  const disposition = setupTerminalExitDisposition(
    { kind: 'proxy_authority_unavailable', summary: '原环境代理安全记录不可用', retry: false },
    null,
    'SIGTERM',
  );
  let projected = { edge: 'starting', session: 'running', core: 'online', browser: 'starting' };
  let broadcastSnapshot: typeof projected | null = null;
  const finalized = finalizeNonRetryableSetupTerminal({
    terminal: { kind: 'proxy_authority_unavailable', summary: disposition.failureSummary, retry: false },
    explicitOverride: false,
    childStillOwned: handle.child !== null,
    projectFailure() {
      assert.equal(handle.child, null, 'terminal projection must happen after child ownership clears');
      projected = { edge: 'stopped', session: 'idle', core: 'stopped', browser: 'closed' };
    },
    broadcast() { broadcastSnapshot = { ...projected }; },
  });

  assert.equal(disposition.retry, false);
  assert.equal(disposition.exitedAbnormally, false);
  assert.equal(disposition.respawnExitCode, null);
  assert.equal(disposition.failureSummary, '原环境代理安全记录不可用');
  assert.equal(finalized, true);
  assert.deepEqual(broadcastSnapshot, {
    edge: 'stopped',
    session: 'idle',
    core: 'stopped',
    browser: 'closed',
  });

  handle.child = new FakeChild();
  assert.equal(finalizeNonRetryableSetupTerminal({
    terminal: { kind: 'proxy_authority_unavailable', summary: '原环境代理安全记录不可用', retry: false },
    explicitOverride: false,
    childStillOwned: true,
    projectFailure() { assert.fail('must not project a reaped terminal while child is still owned'); },
    broadcast() { assert.fail('must not broadcast terminal while child is still owned'); },
  }), false);

  handle.child = null;
  assert.equal(finalizeNonRetryableSetupTerminal({
    terminal: { kind: 'proxy_authority_unavailable', summary: '原环境代理安全记录不可用', retry: false },
    explicitOverride: true,
    childStillOwned: false,
    projectFailure() { assert.fail('explicit user terminal must keep authority'); },
    broadcast() { assert.fail('explicit user terminal must keep authority'); },
  }), false);
});
