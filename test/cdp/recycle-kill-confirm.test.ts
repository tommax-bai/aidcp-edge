import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { launchChrome } from '../../src/cdp/index.js';

/** 记录 kill 信号的假子进程 + spawn。 */
function makeKillSpawn(pid = 5151) {
  const killSignals: (NodeJS.Signals | undefined)[] = [];
  let sigkillSent = false;
  const child = {
    pid,
    on: () => child,
    stderr: { on: () => undefined },
    kill: (sig?: NodeJS.Signals) => {
      killSignals.push(sig);
      if (sig === 'SIGKILL') sigkillSent = true;
      return true;
    },
  } as unknown as ChildProcess;
  const spawnImpl = (() => child) as unknown as typeof import('node:child_process').spawn;
  return { spawnImpl, killSignals, isSigkillSent: () => sigkillSent };
}

const noSleep = async () => undefined;
const baseOpts = (sp: ReturnType<typeof makeKillSpawn>, fetchImpl: typeof fetch) => ({
  host: '127.0.0.1',
  port: 9222,
  chromePath: '/x/chrome',
  fetchImpl,
  spawnImpl: sp.spawnImpl,
  existsImpl: () => true,
  sleepImpl: noSleep,
  logImpl: () => undefined,
  clearSingletonLockImpl: () => undefined,
  waitForLoginImpl: async () => {},
});

test('复用实例 killAndConfirmDead 为 no-op、直接 true（绝不回收外部浏览器）', async () => {
  // 端口已就绪 → 复用分支
  const sp = makeKillSpawn();
  const fetchImpl = (async () => ({ ok: true }) as Response) as unknown as typeof fetch;
  const inst = await launchChrome({
    ...baseOpts(sp, fetchImpl),
    allowReuse: true,
    ensurePageTargetImpl: async () => {},
  });
  assert.equal(inst.reused, true);
  const freed = await inst.killAndConfirmDead();
  assert.equal(freed, true);
  assert.equal(sp.killSignals.length, 0, '复用实例绝不 kill 外部 Chrome');
});

test('独占实例：SIGTERM 即释放端口 → 确认 true、不升级 SIGKILL', async () => {
  const sp = makeKillSpawn();
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    if (n === 1) return { ok: false } as Response; // 复用探测：端口空 → spawn 分支
    if (n === 2) return { ok: true } as Response; // ready 探测
    return { ok: false } as Response; // kill 阶段：端口已释放
  }) as unknown as typeof fetch;
  const inst = await launchChrome(baseOpts(sp, fetchImpl));
  assert.equal(inst.reused, false);
  const freed = await inst.killAndConfirmDead({ sigtermGraceMs: 50, sigkillGraceMs: 50, pollMs: 1 });
  assert.equal(freed, true);
  assert.deepEqual(sp.killSignals, [undefined], '只发一次 SIGTERM（默认信号），不升级');
});

test('独占实例：SIGTERM 未释放端口 → 升级 SIGKILL 后确认 true（BLOCKER②）', async () => {
  const sp = makeKillSpawn();
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    if (n === 1) return { ok: false } as Response; // 复用探测
    if (n === 2) return { ok: true } as Response; // ready
    return { ok: !sp.isSigkillSent() } as Response; // 端口存活直到 SIGKILL 后才释放
  }) as unknown as typeof fetch;
  const inst = await launchChrome(baseOpts(sp, fetchImpl));
  const freed = await inst.killAndConfirmDead({ sigtermGraceMs: 20, sigkillGraceMs: 500, pollMs: 1 });
  assert.equal(freed, true, 'SIGKILL 升级后端口释放、确认 true');
  assert.equal(sp.killSignals.includes('SIGKILL'), true, '优雅终止超时应升级 SIGKILL');
});
