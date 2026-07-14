import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fleet = require('../../src/electron/fleet.cjs');

// ---------------------------------------------------------------------------
// change browser-slot-scheduling：槽位池 + 串行启动队列
//
// 同机能同时开几个浏览器由内存顶死（每个 headful 环境约 700MB；AdsPower 本身不限并发）。
// 旧的错峰队列只保证「相邻开始间隔 ≥1.1s」——10 个环境仍会几乎同时冷启、把内存打爆。
// 这条队列是「起完一个再起下一个」。
// ---------------------------------------------------------------------------

test('槽位上限 = 可用内存 ÷ 单环境估值；override 优先；至少 1', () => {
  const MB = 1024 * 1024;
  assert.equal(fleet.resolveSlotCapacity({ freeBytes: 7000 * MB, perEnvBytes: 700 * MB }), 10);
  assert.equal(fleet.resolveSlotCapacity({ freeBytes: 5000 * MB, perEnvBytes: 700 * MB }), 7);
  assert.equal(fleet.resolveSlotCapacity({ freeBytes: 100 * MB, perEnvBytes: 700 * MB }), 1, '0 槽位 = 整台机器停摆，绝不允许');
  assert.equal(fleet.resolveSlotCapacity({ freeBytes: 7000 * MB, perEnvBytes: 700 * MB, override: 4 }), 4);
});

test('可设置账号数上限 = 2 × 槽位（1:2，用户定案）', () => {
  assert.equal(fleet.maxAccountsForSlots(10), 20);
  assert.equal(fleet.maxAccountsForSlots(8), 16);
});

test('单环境内存估值默认取实测口径 700MB（旧的 1GB 是没量过的设计缺省）', () => {
  assert.equal(fleet.PER_ENV_BYTES_DEFAULT, 700 * 1024 * 1024);
});

test('串行启动队列：起完一个再起下一个（绝不并发冷启）', async () => {
  const queue = fleet.createSerialLaunchQueue({ spacingMs: 0 });
  let concurrent = 0;
  let peak = 0;
  const order: string[] = [];
  const slowLaunch = (key: string) => async () => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    order.push(key);
    await new Promise((r) => setTimeout(r, 20));
    concurrent -= 1;
    return true;
  };

  const results = await Promise.all([
    queue.enqueue({ key: 'a', kind: 'resume', run: slowLaunch('a') }),
    queue.enqueue({ key: 'b', kind: 'resume', run: slowLaunch('b') }),
    queue.enqueue({ key: 'c', kind: 'resume', run: slowLaunch('c') }),
  ]);

  assert.equal(peak, 1, '任何时刻只有一个环境在启动');
  assert.deepEqual(order, ['a', 'b', 'c'], '同级 FIFO');
  assert.deepEqual(results.map((r: { ok: boolean }) => r.ok), [true, true, true]);
});

test('优先级：手动任务 > 带任务的唤醒 > 普通续场恢复', async () => {
  const queue = fleet.createSerialLaunchQueue({ spacingMs: 0 });
  const order: string[] = [];
  const run = (key: string) => async () => {
    order.push(key);
    await new Promise((r) => setTimeout(r, 5));
    return true;
  };

  // 先塞一个占住队列，后面三个才会真正参与排序。
  const head = queue.enqueue({ key: 'head', kind: 'resume', run: run('head') });
  const rest = Promise.all([
    queue.enqueue({ key: 'resume-1', kind: 'resume', run: run('resume-1') }),
    queue.enqueue({ key: 'manual-1', kind: 'manual', run: run('manual-1') }),
    queue.enqueue({ key: 'task-1', kind: 'task', run: run('task-1') }),
  ]);
  await Promise.all([head, rest]);

  assert.deepEqual(order, ['head', 'manual-1', 'task-1', 'resume-1']);
});

test('一个环境启动失败绝不阻塞队列里其余环境', async () => {
  const queue = fleet.createSerialLaunchQueue({ spacingMs: 0 });
  const done: string[] = [];
  const results = await Promise.all([
    queue.enqueue({
      key: 'boom',
      kind: 'resume',
      run: async () => {
        throw new Error('分身未登录');
      },
    }),
    queue.enqueue({
      key: 'ok',
      kind: 'resume',
      run: async () => {
        done.push('ok');
        return true;
      },
    }),
  ]);

  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /分身未登录/, '如实带出失败原因');
  assert.equal(results[1].ok, true);
  assert.deepEqual(done, ['ok'], '后一个照常启动');
});

test('排队等待计入唤醒死线：轮到它时已超死线 → 立刻诚实失败，绝不再启动一个没人等的浏览器', async () => {
  let clock = 0;
  const queue = fleet.createSerialLaunchQueue({
    spacingMs: 0,
    now: () => clock,
    sleep: async () => {},
  });
  let launched = 0;

  const first = queue.enqueue({
    key: 'slow',
    kind: 'resume',
    run: async () => {
      launched += 1;
      clock += 200_000; // 这一个起了很久，把后面那个的死线耗过去了
      return true;
    },
  });
  const second = queue.enqueue({
    key: 'expired',
    kind: 'task',
    deadlineAt: 180_000, // 180s 唤醒死线
    run: async () => {
      launched += 1;
      return true;
    },
  });

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'deadline_exceeded');
  assert.equal(launched, 1, '超死线的那个绝不启动——它会白占一个槽位，而且早已没人在等它了');
});

// ---------------------------------------------------------------------------
// 界面可设的两个上限（并发数 / 最大账号数）。
//
// 权威口径只有一处（主进程），渲染层只显示不重算。优先级 界面设置 > 启动环境变量 > 按内存自动推——
// 与云端环境选择同一套。0 / 空 = 未设 = 自动，绝不能被读成「上限 0」（那等于整机停摆）。
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

test('两个上限：界面设置 > 启动环境变量 > 按内存自动推', () => {
  const auto = fleet.resolveSlotSettings({ freeBytes: 7000 * MB, perEnvBytes: 700 * MB });
  assert.equal(auto.capacity, 10);
  assert.equal(auto.capacitySource, 'auto');
  assert.equal(auto.maxAccounts, 20, '未设时账号上限 = 2 × 槽位');
  assert.equal(auto.maxAccountsSource, 'auto');

  const byEnv = fleet.resolveSlotSettings({ freeBytes: 7000 * MB, perEnvBytes: 700 * MB, slotEnv: 6 });
  assert.equal(byEnv.capacity, 6);
  assert.equal(byEnv.capacitySource, 'env');
  assert.equal(byEnv.maxAccounts, 12, '账号上限跟着实际生效的槽位走，而不是自动推算值');

  const bySetting = fleet.resolveSlotSettings({ freeBytes: 7000 * MB, perEnvBytes: 700 * MB, slotEnv: 6, slotSetting: 3 });
  assert.equal(bySetting.capacity, 3, '界面设置压过启动参数');
  assert.equal(bySetting.capacitySource, 'setting');
  assert.equal(bySetting.autoCapacity, 10, '自动推算值仍如实带出，供界面说明「自动会是多少」');
});

test('账号上限可单独设定；设到 1:2 之上必须诚实告警而非静默接受', () => {
  const v = fleet.resolveSlotSettings({ freeBytes: 3500 * MB, perEnvBytes: 700 * MB, maxAccountsSetting: 20 });
  assert.equal(v.capacity, 5);
  assert.equal(v.maxAccounts, 20);
  assert.equal(v.maxAccountsSource, 'setting');
  assert.equal(v.autoMaxAccounts, 10);
  assert.equal(v.maxAccountsExceedsRatio, true, '20 个账号抢 5 个槽位：部分账号可能永远排不上，必须说出来');

  const within = fleet.resolveSlotSettings({ freeBytes: 3500 * MB, perEnvBytes: 700 * MB, maxAccountsSetting: 8 });
  assert.equal(within.maxAccountsExceedsRatio, false);
});

test('0 / 空 / 负数 = 未设 = 自动，绝不解读成「上限 0」', () => {
  for (const v of [0, '', null, undefined, -3, 'abc']) {
    assert.equal(fleet.normalizeSlotLimit(v), 0, `${JSON.stringify(v)} 应归一为 0（自动）`);
  }
  const zeroed = fleet.resolveSlotSettings({ freeBytes: 7000 * MB, perEnvBytes: 700 * MB, slotSetting: 0, maxAccountsSetting: 0 });
  assert.equal(zeroed.capacity, 10, '0 是「自动」不是「不许开浏览器」');
  assert.equal(zeroed.maxAccounts, 20);
  assert.equal(fleet.normalizeSlotLimit(999), 64, '上界 64：防手滑多打一个零把机器拖垮');
});

// ---------------------------------------------------------------------------
// 可用内存读数：MUST NOT 用 os.freemem() 当「可用内存」。
//
// 真机复现（16GB MacBook，系统自报可用 48%）：os.freemem() 只报 221MB —— 它不含 inactive
// 那 3.6GB 可回收的文件缓存。单环境估值 700MB，于是**每一条开浏览器路径**都被内存闸拦死，
// 客户端报「本机可用内存不足（需约 700MB，仅剩 418MB）」、整台机器一个浏览器都开不起来。
// 下面的样本就是那台机器上 `vm_stat` 的真实输出。

const VM_STAT_REAL = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               13388.
Pages active:                            236265.
Pages inactive:                          236028.
Pages speculative:                         1538.
Pages throttled:                              0.
Pages wired down:                        168628.
Pages purgeable:                           6953.
`;

test('darwin：可用内存按 free + inactive + speculative 算，不是 os.freemem()', () => {
  const bytes = fleet.parseVmStatAvailableBytes(VM_STAT_REAL);
  const mb = Math.round(bytes / MB);
  // (13388 + 236028 + 1538) × 16384B ≈ 3921MB —— 而 os.freemem() 在这台机器上只报 221MB。
  assert.equal(mb, 3921);
  assert.ok(mb > 700, '这台机器明明开得起浏览器，旧读数却把它判成开不起');

  const available = fleet.availableMemoryBytes({
    platform: 'darwin',
    exec: () => VM_STAT_REAL,
    freemem: () => 221 * MB,
    now: () => 1_000,
    cache: { at: -Infinity, bytes: 0 },
  });
  assert.equal(Math.round(available / MB), 3921, 'darwin 走 vm_stat，绝不回落到 freemem');
});

test('linux：可用内存取 /proc/meminfo 的 MemAvailable', () => {
  const meminfo = 'MemTotal:       16316420 kB\nMemFree:          221000 kB\nMemAvailable:    4014080 kB\n';
  assert.equal(fleet.parseMemAvailableBytes(meminfo), 4014080 * 1024);
  const available = fleet.availableMemoryBytes({
    platform: 'linux',
    readFile: () => meminfo,
    freemem: () => 221 * MB,
    now: () => 1_000,
    cache: { at: -Infinity, bytes: 0 },
  });
  assert.equal(available, 4014080 * 1024);
});

test('探测失败 / 未知平台 → 回落 os.freemem()（只许偏保守，绝不假装内存充裕）', () => {
  const boom = fleet.availableMemoryBytes({
    platform: 'darwin',
    exec: () => { throw new Error('vm_stat not found'); },
    freemem: () => 900 * MB,
    now: () => 1_000,
    cache: { at: -Infinity, bytes: 0 },
  });
  assert.equal(Math.round(boom / MB), 900);

  const unknown = fleet.availableMemoryBytes({
    platform: 'sunos',
    freemem: () => 900 * MB,
    now: () => 1_000,
    cache: { at: -Infinity, bytes: 0 },
  });
  assert.equal(Math.round(unknown / MB), 900);

  const garbage = fleet.availableMemoryBytes({
    platform: 'darwin',
    exec: () => 'not vm_stat output at all',
    freemem: () => 900 * MB,
    now: () => 1_000,
    cache: { at: -Infinity, bytes: 0 },
  });
  assert.equal(Math.round(garbage / MB), 900, '解析不出来也要回落，不能当成 0 把机器锁死');
});

test('读数带 TTL 缓存：准入闸每次开浏览器都问，不该每次都 spawn 一个 vm_stat', () => {
  let calls = 0;
  const cache = { at: -Infinity, bytes: 0 };
  let clock = 1_000;
  const read = () => fleet.availableMemoryBytes({
    platform: 'darwin',
    exec: () => { calls += 1; return VM_STAT_REAL; },
    freemem: () => 0,
    now: () => clock,
    cache,
  });
  read();
  read();
  assert.equal(calls, 1, 'TTL 内复用缓存');
  clock += 5_000;
  read();
  assert.equal(calls, 2, '过了 TTL 重新读——内存是会变的，不能一辈子只读一次');
});

test('真机上这台 16GB Mac 必须能开浏览器（端到端：读数 → 准入闸）', () => {
  const usable = fleet.parseVmStatAvailableBytes(VM_STAT_REAL) - fleet.MEM_RESERVE_BYTES_DEFAULT;
  const admission = fleet.ramAdmission({ plannedCount: 1, freeBytes: usable, perEnvBytes: 700 * MB });
  assert.equal(admission.ok, true, '3.9GB 可用、留 512MB 余量后仍装得下一个 700MB 的浏览器');
  const cap = fleet.resolveSlotCapacity({ freeBytes: usable, perEnvBytes: 700 * MB });
  assert.equal(cap, 4, '≈3409MB ÷ 700MB = 4 个槽位');
});
