import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const fleet = require('../../src/electron/fleet.cjs');
const uiLogic = require('../../src/electron/renderer/ui-logic.js');
const mainSource = readFileSync(new URL('../../src/electron/main.cjs', import.meta.url), 'utf8');
const childStartupSource = readFileSync(new URL('../../src/electron/core-child-startup.cjs', import.meta.url), 'utf8');

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

test('自动启动排队上限 = 2 × 浏览器并发；这不是账号/环境上限', () => {
  assert.equal(fleet.maxQueuedStartsForSlots(10), 20);
  assert.equal(fleet.maxQueuedStartsForSlots(8), 16);
});

test('子进程对象等待 close 时不再虚占 OS 已退出的浏览器槽位', () => {
  assert.equal(fleet.childProcessIsRunning({ exitCode: null, signalCode: null }), true);
  assert.equal(fleet.childProcessIsRunning({ exitCode: 0, signalCode: null }), false);
  assert.equal(fleet.childProcessIsRunning({ exitCode: 1, signalCode: null }), false);
  assert.equal(fleet.childProcessIsRunning({ exitCode: null, signalCode: 'SIGTERM' }), false);
  assert.equal(fleet.childProcessIsRunning(undefined), false);

  const occupied = mainSource.slice(
    mainSource.indexOf('function occupiedSlots()'),
    mainSource.indexOf('\nfunction queuedStartCount()', mainSource.indexOf('function occupiedSlots()')),
  );
  assert.match(occupied, /fleet\.childProcessIsRunning\(h\.child\)/);

  const spawn = mainSource.slice(
    mainSource.indexOf('async function spawnEdgeChild('),
    mainSource.indexOf('\nfunction stopLoginPoller()', mainSource.indexOf('async function spawnEdgeChild(')),
  );
  const onExit = spawn.slice(
    spawn.indexOf('function onChildExit('),
    spawn.indexOf('function onChildClose(', spawn.indexOf('function onChildExit(')),
  );
  const onClose = spawn.slice(
    spawn.indexOf('function onChildClose('),
    spawn.indexOf('// 串行启动队列在此等待', spawn.indexOf('function onChildClose(')),
  );
  assert.match(childStartupSource, /child\.on\('exit', observers\.exit\)/);
  assert.match(onExit, /broadcastFleet\(\)[\s\S]{0,120}drainSlotWaiters\(\)/,
    'OS exit 必须立即推进槽位 FIFO，不得等 stdio close');
  assert.match(spawn, /CORE_CLOSE_DRAIN_GRACE_MS = 2_000/);
  assert.match(onExit, /setTimeout\([\s\S]{0,360}finalizeCoreExit\(code, signal\)[\s\S]{0,80}CORE_CLOSE_DRAIN_GRACE_MS/,
    'close 缺席时必须有界完成终局归因并清理 handle');
  assert.match(childStartupSource, /child\.on\('close', observers\.close\)/);
  assert.match(onClose, /coreExitFinalized \|\| handle\.child !== child/,
    '旧进程迟到的 close 不得 settle 新一代核心的启动队列');
});

test('启动排队准入：未满可加入、满时拒绝、同一环境重复请求幂等', () => {
  assert.deepEqual(fleet.startQueueAdmission({ queuedCount: 3, limit: 4 }), {
    ok: true, queued: 4, limit: 4, added: true,
  });
  assert.deepEqual(fleet.startQueueAdmission({ queuedCount: 4, limit: 4 }), {
    ok: false, queued: 4, limit: 4, added: false, reason: 'start_queue_full',
  });
  assert.deepEqual(fleet.startQueueAdmission({ queuedCount: 4, limit: 4, alreadyQueued: true }), {
    ok: true, queued: 4, limit: 4, added: false,
  });
});

test('客户端将等待浏览器执行位统一显示为“排队中”', () => {
  const status = { automationState: 'waiting_resource' };
  assert.equal(uiLogic.synthesizeHealth(status).label, '排队中');
  assert.equal(uiLogic.fleetLevel(status, Date.now()).label, '排队中');
});

test('平台能力：视频号使用独立临时通道且不适用人设，其他平台保持公共浏览器与人设', () => {
  assert.equal(fleet.browserUsageModeForPlatform('wechat_channels'), 'transient');
  assert.equal(fleet.personaApplicableForPlatform('wechat_channels'), false);
  assert.equal(fleet.browserUsageModeForPlatform('xiaohongshu'), 'persistent');
  assert.equal(fleet.personaApplicableForPlatform('xiaohongshu'), true);
  assert.equal(fleet.browserUsageModeForPlatform('facebook'), 'persistent');
  assert.equal(fleet.personaApplicableForPlatform('facebook'), true);
});

test('主进程从权威调度器结构化投影位次，不解析状态文案', () => {
  const start = mainSource.indexOf('function lifecycleQueueProjection(handle)');
  const end = mainSource.indexOf('\nfunction statusOf(handle)', start);
  assert.ok(start >= 0 && end > start, '主进程应存在独立队列投影函数');
  const block = mainSource.slice(start, end);
  assert.match(block, /slotWaiters\(\)\.findIndex/);
  assert.match(block, /launchQueue\.pendingPosition\(handle\.envId\)/);
  assert.match(block, /queueStage:\s*'preparing',\s*queuePosition:\s*lifecycleQueue\.pendingPosition\(handle\.envId\)/);
  assert.doesNotMatch(block, /lastMessage|match\(|parseInt|正则/, '位次不得从文案或日志解析');
  assert.match(mainSource, /\.\.\.lifecycleQueueProjection\(handle\)/, '结构化字段必须进入 statusOf 快照');
});

test('视频号临时通道与公共槽位分池，并投影容量 1 与精确 FIFO 位次', () => {
  const occupied = mainSource.slice(
    mainSource.indexOf('function occupiedSlots()'),
    mainSource.indexOf('\nfunction queuedStartCount()', mainSource.indexOf('function occupiedSlots()')),
  );
  assert.match(occupied, /!usesTransientBrowserLane\(h\)/, '视频号/API-only 核心不得占公共浏览器槽位');

  const snapshot = mainSource.slice(
    mainSource.indexOf('function fleetSnapshot()'),
    mainSource.indexOf('\nfunction broadcastFleet()', mainSource.indexOf('function fleetSnapshot()')),
  );
  assert.match(snapshot, /public:\s*\{[\s\S]*capacity: slotCapacity\(\)[\s\S]*occupied: occupiedSlots\(\)/);
  assert.match(snapshot, /transient: transientQueueSnapshot\(\)/);
  assert.match(mainSource, /function transientQueueSnapshot\(\)[\s\S]{0,220}capacity: 1/);

  const projection = mainSource.slice(
    mainSource.indexOf('function lifecycleQueueProjection(handle)'),
    mainSource.indexOf('\nfunction statusOf(handle)', mainSource.indexOf('function lifecycleQueueProjection(handle)')),
  );
  assert.match(projection, /queueStage: 'transient'/);
  assert.match(projection, /transientBrowserQueue\.pendingPosition\(handle\.transientBrowserQueueKey\)/);
  assert.match(mainSource, /if \(usesTransientBrowserLane\(handle\)\) return startTransientEnvironment\(handle, generation\);/,
    '视频号启动必须在公共 start/slot 准入之前分流');
});

test('视频号运行中只认当前进程内完整数据面证据，浏览器状态独立为关闭', () => {
  const axes = mainSource.slice(
    mainSource.indexOf('function lifecycleAxes(handle)'),
    mainSource.indexOf('\nfunction lifecycleQueueProjection(handle)', mainSource.indexOf('function lifecycleAxes(handle)')),
  );
  assert.match(axes, /transientRuntime\.authStatus === 'active'/);
  assert.match(axes, /transientRuntime\.identityMatches/);
  assert.match(axes, /transientRuntime\.connectorStarted/);
  assert.match(axes, /transientRuntime\.cloudNegotiated/);
  assert.match(axes, /!transientRuntime\.paused/);
  assert.match(axes, /!transientRuntime\.offboardPending/);
  assert.match(axes, /transientRuntime\.dataCapable/);
  assert.match(axes, /transientRuntime\.proofAt >= handle\.spawnedAtMs/,
    '历史登录或旧进程 ACK 不得证明当前进程运行中');
  assert.match(axes, /sidecarState === 'open'[\s\S]{0,100}\? 'ready'[\s\S]{0,180}: 'closed'/,
    'API-only 运行态不得反向伪造浏览器为打开');
  assert.match(axes, /interactionProvenRunning \? 'running' : 'ready'/);
});

test('增量状态与 fleet 快照共用完整生命周期投影', () => {
  const start = mainSource.indexOf('function updateStatus(handle, patch)');
  const end = mainSource.indexOf('\nfunction presencePatch', start);
  assert.ok(start >= 0 && end > start, '主进程应存在独立增量状态出口');
  const block = mainSource.slice(start, end);
  assert.match(block, /const payload = statusOf\(handle\);/, '每次 status:update 都必须重算四轴与权威队列位次');
  assert.doesNotMatch(block, /const payload = \{\s*\.\.\.handle\.status/, '不得再推送缺少生命周期投影的原始状态');
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

test('串行启动队列只投影当前可证明的待处理位次，并随优先级实时重排', async () => {
  const queue = fleet.createSerialLaunchQueue({ spacingMs: 0 });
  let releaseHead!: () => void;
  const headGate = new Promise<void>((resolve) => { releaseHead = resolve; });
  const head = queue.enqueue({
    key: 'head',
    kind: 'resume',
    run: async () => {
      await headGate;
      return true;
    },
  });
  const resume = queue.enqueue({ key: 'resume', kind: 'resume', run: async () => true });
  assert.equal(queue.pendingPosition('resume'), 1, '当前执行项已经出队，待处理项从 #1 开始');

  const task = queue.enqueue({ key: 'task', kind: 'task', run: async () => true });
  assert.equal(queue.pendingPosition('task'), 1, '任务唤醒按现有优先级排到普通续场前');
  assert.equal(queue.pendingPosition('resume'), 2);

  const manual = queue.enqueue({ key: 'manual', kind: 'manual', run: async () => true });
  assert.equal(queue.pendingPosition('manual'), 1);
  assert.equal(queue.pendingPosition('task'), 2);
  assert.equal(queue.pendingPosition('resume'), 3);
  assert.equal(queue.pendingPosition('head'), null, '正在执行的项不是排队项，不伪造 #0/#1');
  assert.equal(queue.pendingPosition('missing'), null);

  releaseHead();
  await Promise.all([head, manual, task, resume]);
});

test('串行启动队列可取消尚未执行的同环境旧代启动与唤醒项', async () => {
  const queue = fleet.createSerialLaunchQueue({ spacingMs: 0 });
  let releaseHead!: () => void;
  const gate = new Promise<void>((resolve) => { releaseHead = resolve; });
  const ran: string[] = [];
  const head = queue.enqueue({ key: 'head', run: async () => { await gate; return true; } });
  const staleStart = queue.enqueue({ key: 'env-a', run: async () => { ran.push('start'); return true; } });
  const staleWake = queue.enqueue({ key: 'env-a:wake', run: async () => { ran.push('wake'); return true; } });
  assert.equal(queue.cancel('env-a'), 1);
  assert.equal(queue.cancel('env-a:wake'), 1);
  assert.equal(queue.pendingPosition('env-a'), null);
  assert.equal(queue.pendingPosition('env-a:wake'), null);
  releaseHead();
  const [, startResult, wakeResult] = await Promise.all([head, staleStart, staleWake]);
  assert.equal(startResult.reason, 'cancelled');
  assert.equal(wakeResult.reason, 'cancelled');
  assert.deepEqual(ran, [], '旧代队列项不得打开浏览器');
});

test('主进程把执行阶段绑定当前操作代，旧核心输出、唤醒和退避不得跨代写状态', () => {
  assert.match(mainSource, /lifecycleGeneration:\s*0/);
  assert.match(mainSource, /function advanceLifecycleGeneration\([\s\S]*lifecycleQueue\.cancel\?\.\(handle\.envId\)[\s\S]*launchQueue\.cancel\?\.\(`\$\{handle\.envId\}:wake`\)/);
  assert.match(mainSource, /handleEdgeOutput\(handle, chunk\.toString\(\), false, generation\)/);
  assert.match(mainSource, /if \(!isCurrentLifecycleGeneration\(handle, generation\)\) return;/);
  assert.match(mainSource, /next\.loopStageGeneration = handle\.lifecycleGeneration/);
  assert.match(mainSource, /status\.loopStageGeneration === handle\.lifecycleGeneration/);
  assert.match(mainSource, /next\.loopStageBrowserIndependent = evt\.loopStage !== null && evt\.browserIndependent === true/);
  assert.match(mainSource, /currentLoopExecutable = currentLoopRunning[\s\S]*browserState === 'ready'[\s\S]*loopStageBrowserIndependent === true/,
    '浏览器阶段只有在浏览器真实就绪时才是运行中，显式浏览器无关任务除外');
  assert.match(mainSource, /rearmWakeRetry\(handle, generation = handle && handle\.lifecycleGeneration, retryCause = 'wake_failed'\)[\s\S]*handle\.stopRequested[\s\S]*isCurrentLifecycleGeneration/);
});

test('start_queue_full 是未入队退避，不再谎称仍在队列中', () => {
  const start = mainSource.indexOf('function denyWakeNow(handle, detail)');
  const end = mainSource.indexOf('\nfunction armWakeDeadline', start);
  const block = mainSource.slice(start, end);
  assert.match(block, /本次未入队，将按退避计划重试/);
  assert.match(block, /仍在权威队列中/);
  assert.doesNotMatch(block, /仍在队列中，浏览器继续起/);
});

test('启动排队已满与真实唤醒失败使用不同退避文案', () => {
  const retryStart = mainSource.indexOf('function rearmWakeRetry(');
  const retryEnd = mainSource.indexOf('\nfunction wakeColdStandby', retryStart);
  const retryBlock = mainSource.slice(retryStart, retryEnd);
  assert.match(retryBlock, /retryCause === 'start_queue_full' \? '启动排队已满' : '唤醒失败'/);

  const queueFullStart = mainSource.indexOf('function wakeColdStandby(');
  const queueFullEnd = mainSource.indexOf('\nfunction onColdStandbyWakeFailed', queueFullStart);
  const queueFullBlock = mainSource.slice(queueFullStart, queueFullEnd);
  assert.match(queueFullBlock, /denyWakeNow\(handle, 'start_queue_full'\)[\s\S]*rearmWakeRetry\(handle, generation, 'start_queue_full'\)/);

  const failureStart = mainSource.indexOf('function onColdStandbyWakeFailed(');
  const failureEnd = mainSource.indexOf('\nfunction startControlPlaneOnly', failureStart);
  const failureBlock = mainSource.slice(failureStart, failureEnd);
  assert.match(failureBlock, /denyWakeNow\(handle, `wake_failed:\$\{reason\}`\)[\s\S]*rearmWakeRetry\(handle, expectedGeneration, 'wake_failed'\)/);
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
// 界面可设的两个上限（浏览器并发 / 启动排队）。
//
// 权威口径只有一处（主进程），渲染层只显示不重算。优先级 界面设置 > 启动环境变量 > 按内存自动推——
// 与云端环境选择同一套。0 / 空 = 未设 = 自动，绝不能被读成「上限 0」（那等于整机停摆）。
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

test('两个上限：界面设置 > 启动环境变量 > 按内存自动推', () => {
  const auto = fleet.resolveSlotSettings({ freeBytes: 7000 * MB, perEnvBytes: 700 * MB });
  assert.equal(auto.capacity, 10);
  assert.equal(auto.capacitySource, 'auto');
  assert.equal(auto.maxQueuedStarts, 20, '未设时启动排队上限 = 2 × 浏览器并发');
  assert.equal(auto.maxQueuedStartsSource, 'auto');

  const byEnv = fleet.resolveSlotSettings({ freeBytes: 7000 * MB, perEnvBytes: 700 * MB, slotEnv: 6 });
  assert.equal(byEnv.capacity, 6);
  assert.equal(byEnv.capacitySource, 'env');
  assert.equal(byEnv.maxQueuedStarts, 12, '自动排队上限跟着实际生效的浏览器并发走');

  const bySetting = fleet.resolveSlotSettings({ freeBytes: 7000 * MB, perEnvBytes: 700 * MB, slotEnv: 6, slotSetting: 3 });
  assert.equal(bySetting.capacity, 3, '界面设置压过启动参数');
  assert.equal(bySetting.capacitySource, 'setting');
  assert.equal(bySetting.autoCapacity, 10, '自动推算值仍如实带出，供界面说明「自动会是多少」');
});

test('启动排队上限可单独设定，且不派生任何账号/环境创建限制', () => {
  const v = fleet.resolveSlotSettings({ freeBytes: 3500 * MB, perEnvBytes: 700 * MB, maxQueuedStartsSetting: 20 });
  assert.equal(v.capacity, 5);
  assert.equal(v.maxQueuedStarts, 20);
  assert.equal(v.maxQueuedStartsSource, 'setting');
  assert.equal(v.autoMaxQueuedStarts, 10);
  assert.equal('maxAccounts' in v, false, '运行设置不得再产出环境创建上限');
});

test('0 / 空 / 负数 = 未设 = 自动，绝不解读成「上限 0」', () => {
  for (const v of [0, '', null, undefined, -3, 'abc']) {
    assert.equal(fleet.normalizeSlotLimit(v), 0, `${JSON.stringify(v)} 应归一为 0（自动）`);
    assert.equal(fleet.normalizeStartQueueLimit(v), 0, `${JSON.stringify(v)} 的排队上限应归一为 0（自动）`);
  }
  const zeroed = fleet.resolveSlotSettings({ freeBytes: 7000 * MB, perEnvBytes: 700 * MB, slotSetting: 0, maxQueuedStartsSetting: 0 });
  assert.equal(zeroed.capacity, 10, '0 是「自动」不是「不许开浏览器」');
  assert.equal(zeroed.maxQueuedStarts, 20);
  assert.equal(fleet.normalizeSlotLimit(999), 64, '浏览器并发上界保持 64');
  assert.equal(fleet.normalizeStartQueueLimit(999), 256, '启动排队上界为 256');
  assert.equal(
    fleet.resolveSlotSettings({ freeBytes: 7000 * MB, perEnvBytes: 700 * MB, maxQueuedStartsSetting: 999 }).maxQueuedStarts,
    256,
    '主进程设置解析应把启动排队上限截断到 256',
  );
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

test('底层读数工具带 TTL 缓存；Edge 主进程只会在启动时调用它一次', () => {
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
  assert.equal(calls, 2, '工具本身仍可刷新；主进程契约负责只在启动时取一次快照');
});

test('真机上这台 16GB Mac 的启动快照可推算 4 个浏览器并发', () => {
  const usable = fleet.parseVmStatAvailableBytes(VM_STAT_REAL) - fleet.MEM_RESERVE_BYTES_DEFAULT;
  const cap = fleet.resolveSlotCapacity({ freeBytes: usable, perEnvBytes: 700 * MB });
  assert.equal(cap, 4, '≈3409MB ÷ 700MB = 4 个槽位');
});

test('3202MB 启动快照 ÷ 700MB 固定推算为 4', () => {
  assert.equal(fleet.resolveSlotCapacity({ freeBytes: 3202 * MB, perEnvBytes: 700 * MB }), 4);
});

// ---------------------------------------------------------------------------
// 「槽位被别人占着」不是失败原因，是排队原因。
//
// 一版之前：一律当场拒 + 丢弃请求 → 把 1:2 废掉（12 账号 6 槽位，6 个账号永久趴在「未启动」，
// 后来槽位空出来也没人取）。
// 上一版：按「有没有人在死线上等」分流，有人等就当场判失败 → 把「有人在等」误当成「所以该失败」。
// 现在：**谁都不判失败**。调用方的死线只决定「什么时候回话」，绝不决定「要不要把浏览器开起来」。

test('槽位拒绝不再按 kind 分流：那个 policy 函数必须不存在', () => {
  assert.equal(
    (fleet as { slotRefusalPolicy?: unknown }).slotRefusalPolicy,
    undefined,
    '按「你是谁」判失败是错的：排在队里的任务 ≠ 不可能完成的任务',
  );
});

test('等槽位 FIFO：严格先来后到，带死线者也不许插队（否则纯等待者永远排不上、饿死）', () => {
  const waiters = [
    { envId: 'c', slotWaitingSince: 3_000 },
    { envId: 'a', slotWaitingSince: 1_000 },
    { envId: 'b', slotWaitingSince: 2_000 },
  ];
  const order = fleet.orderSlotWaiters(waiters) as Array<{ envId: string }>;
  assert.deepEqual(order.map((w) => w.envId), ['a', 'b', 'c']);
  // 12 账号的机器上带死线的唤醒是**连续到达**的：一旦让它们按优先级插队，1:2 里多挂的那一半
  // （纯等待者）会被无限期挤到后面。死线只换「早点回话」，不换「插到别人前面」。
  const withDeadline = [
    { envId: 'waiter', slotWaitingSince: 1_000 },
    { envId: 'urgent', slotWaitingSince: 9_000, wakeDeadlineAt: 1 },
  ];
  const ordered = fleet.orderSlotWaiters(withDeadline) as Array<{ envId: string }>;
  assert.equal(ordered[0].envId, 'waiter', '带死线也不插队');
});
