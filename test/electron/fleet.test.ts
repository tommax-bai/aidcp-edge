import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { decideRespawn as decideRespawnTs } from '../../src/supervise/respawn-policy.js';
import { imageTempPrefixFor } from '../../src/flows/image-uploader.js';
import { WECHAT_DEV_UNVERIFIED_WRITE_TOKEN as featureFlagToken } from '../../src/wechat-channels/feature-flags.js';

// fleet.cjs（多环境外壳纯决策层）单测：设置迁移 / 冻结 env 身份闸 / 错峰队列 / 内存预检 / 同账号检测。
const require = createRequire(import.meta.url);
const fleet = require('../../src/electron/fleet.cjs');

// ── 花名册归一 / 设置迁移 ──

test('normalizeEnvironments：去空 id、按 profileId 去重（同一分身绝不出现两次）', () => {
  const envs = fleet.normalizeEnvironments([
    { profileId: 'p1', name: 'A', platform: 'xiaohongshu' },
    { profileId: 'p1', name: 'A-dup' },
    { profileId: '', name: 'empty' },
    { userId: 'p2', name: 'B', platform: 'fb' },
    null,
  ]);
  assert.deepEqual(envs.map((e: { profileId: string }) => e.profileId), ['p1', 'p2']);
  assert.equal(envs[1].platform, 'facebook');
});

test('normalizeEnvironments：wechat_channels 原样保留且别名归一，不回落小红书', () => {
  const envs = fleet.normalizeEnvironments([
    { profileId: 'wc1', name: '视频号 A', platform: 'wechat_channels' },
    { profileId: 'wc2', name: '视频号 B', platform: 'wechat-channels' },
  ]);
  assert.deepEqual(envs.map((e: { platform: string }) => e.platform), ['wechat_channels', 'wechat_channels']);
});

test('normalizeEnvironments：仅保留受限的人工昵称来源标记，旧成员与未知来源不被误保护', () => {
  const envs = fleet.normalizeEnvironments([
    { profileId: 'manual', name: '人工名', nameSource: 'manual' },
    { profileId: 'legacy', name: '旧环境' },
    { profileId: 'forged', name: '伪来源', nameSource: 'platform' },
  ]);
  assert.equal(envs[0].nameSource, 'manual');
  assert.equal('nameSource' in envs[1], false);
  assert.equal('nameSource' in envs[2], false);
});

test('environmentWithOperatorAlias：人工期间保留系统影子，空内容恢复系统名并清除人工来源', () => {
  const manual = fleet.environmentWithOperatorAlias(
    { profileId: 'p1', name: 'Tianxing Bai', platform: 'facebook' },
    ' Tianxing Bai1 ',
    'Tianxing Bai',
  );
  assert.deepEqual(manual, {
    profileId: 'p1', name: 'Tianxing Bai1', systemName: 'Tianxing Bai', platform: 'facebook',
    nameSource: 'manual', nameSyncState: 'unsynced',
  });
  const refreshed = fleet.environmentWithOperatorAlias(manual, 'Tianxing Bai1', 'Tianxing Bai New');
  assert.equal(refreshed.name, 'Tianxing Bai1');
  assert.equal(refreshed.systemName, 'Tianxing Bai New');
  const cleared = fleet.environmentWithOperatorAlias(refreshed, '   ', '');
  assert.deepEqual(cleared, {
    profileId: 'p1', name: 'Tianxing Bai New', systemName: 'Tianxing Bai New', platform: 'facebook',
  });
});

test('normalizeEnvironment：系统影子和明确同步态可持久化，旧人工名不冒充已同步', () => {
  assert.deepEqual(fleet.normalizeEnvironment({
    profileId: 'p1', name: '人工名', systemName: '系统名', platform: 'facebook',
    nameSource: 'manual', nameSyncState: 'synced',
  }), {
    profileId: 'p1', name: '人工名', systemName: '系统名', platform: 'facebook',
    nameSource: 'manual', nameSyncState: 'synced',
  });
  const legacy = fleet.normalizeEnvironment({ profileId: 'p2', name: '旧人工名', nameSource: 'manual' });
  assert.equal(legacy.nameSource, 'manual');
  assert.equal('nameSyncState' in legacy, false, '旧记录由登录后的补同步流程识别');
});

test('migrateEnvironments：旧单值 adsProfileId 向后兼容加载为单元素花名册', () => {
  const envs = fleet.migrateEnvironments({ adsProfileId: 'legacy1', adsProfileName: '老环境', platform: 'xiaohongshu' });
  assert.deepEqual(envs, [{ profileId: 'legacy1', name: '老环境', platform: 'xiaohongshu' }]);
});

test('migrateEnvironments：已有 environments 数组优先于旧单值', () => {
  const envs = fleet.migrateEnvironments({
    adsProfileId: 'legacy1',
    environments: [{ profileId: 'p1', name: 'A' }, { profileId: 'p2', name: 'B' }],
  });
  assert.deepEqual(envs.map((e: { profileId: string }) => e.profileId), ['p1', 'p2']);
});

test('legacyMirrorOf：首成员镜像回旧字段（回滚兼容）；空花名册镜像为空', () => {
  assert.deepEqual(fleet.legacyMirrorOf([{ profileId: 'p1', name: 'A', platform: 'facebook' }]), {
    adsProfileId: 'p1',
    adsProfileName: 'A',
    platform: 'facebook',
  });
  assert.equal(fleet.legacyMirrorOf([]).adsProfileId, '');
});

test('scopeFleetHandles：批量启动范围与实时未移除句柄求交集，空数组 fail closed', () => {
  const handles = [
    { envId: 'ads-xhs', removed: false },
    { envId: 'ads-fb', removed: false },
    { envId: 'ads-wechat', removed: true },
  ];
  assert.deepEqual(
    fleet.scopeFleetHandles(handles, ['ads-fb', 'ads-missing', 'ads-fb', {}, '']),
    [handles[1]],
  );
  assert.deepEqual(fleet.scopeFleetHandles(handles, []), []);
  assert.deepEqual(fleet.scopeFleetHandles(handles, undefined), [handles[0], handles[1]]);
});

test('nicknameSourceForPlatform：视频号真实昵称保留平台来源，环境名回落仍由调用方标 env', () => {
  assert.equal(fleet.nicknameSourceForPlatform('wechat_channels'), 'wechat_channels');
  assert.equal(fleet.nicknameSourceForPlatform('wechat-channels'), 'wechat_channels');
  assert.equal(fleet.nicknameSourceForPlatform('facebook'), 'facebook');
  assert.equal(fleet.nicknameSourceForPlatform('xiaohongshu'), 'xhs');
});

test('facebookBrowseModeFor：仅 dev 的 Facebook 分身真浏览，其他环境显式关闭', () => {
  assert.equal(fleet.facebookBrowseModeFor({ platform: 'facebook', cloudEnvKey: 'dev' }), 'on');
  assert.equal(fleet.facebookBrowseModeFor({ platform: 'fb', cloudEnvKey: 'DEV' }), 'on');
  assert.equal(fleet.facebookBrowseModeFor({ platform: 'facebook', cloudEnvKey: 'ol' }), 'off');
  assert.equal(fleet.facebookBrowseModeFor({ platform: 'facebook', cloudEnvKey: 'custom' }), 'off');
  assert.equal(fleet.facebookBrowseModeFor({ platform: 'xiaohongshu', cloudEnvKey: 'dev' }), 'off');
  assert.equal(fleet.facebookBrowseModeFor({}), 'off');
});

test('wechatUnverifiedWriteTestModeFor: only unpackaged named-dev WeChat receives the exact token', () => {
  assert.equal(fleet.WECHAT_DEV_UNVERIFIED_WRITE_TOKEN, featureFlagToken);
  assert.equal(
    fleet.wechatUnverifiedWriteTestModeFor({ platform: 'wechat_channels', cloudEnvKey: 'dev', isPackaged: false }),
    fleet.WECHAT_DEV_UNVERIFIED_WRITE_TOKEN,
  );
  assert.equal(
    fleet.wechatUnverifiedWriteTestModeFor({ platform: 'wechat-channels', cloudEnvKey: 'DEV', isPackaged: false }),
    fleet.WECHAT_DEV_UNVERIFIED_WRITE_TOKEN,
  );
  assert.equal(fleet.wechatUnverifiedWriteTestModeFor({ platform: 'wechat_channels', cloudEnvKey: 'dev', isPackaged: true }), '');
  assert.equal(fleet.wechatUnverifiedWriteTestModeFor({ platform: 'wechat_channels', cloudEnvKey: 'ol', isPackaged: false }), '');
  assert.equal(fleet.wechatUnverifiedWriteTestModeFor({ platform: 'facebook', cloudEnvKey: 'dev', isPackaged: false }), '');
});

// ── 冻结 spawn env + 身份闸 ──

test('buildEnvSpawnEnv：注入 AIDCP_ADS_USER_ID、剔除继承的身份/端口键（防串号）', () => {
  const built = fleet.buildEnvSpawnEnv({
    environment: { profileId: 'p9', name: 'X', platform: 'xiaohongshu' },
    processEnv: {
      AIDCP_CLOUD_URL: 'ws://example:8787',
      AIDCP_ACCOUNT_ID: 'poisoned-account',
      AIDCP_EDGE_ID: 'poisoned-shared-edge',
      AIDCP_ADS_USER_ID: 'poisoned-profile',
      AIDCP_CDP_PORT: '9222',
      AIDCP_CHROME_PROFILE: '/tmp/x',
      AIDCP_WECHAT_UNVERIFIED_WRITE_TEST_MODE: fleet.WECHAT_DEV_UNVERIFIED_WRITE_TOKEN,
    },
    providerEnv: { AIDCP_ADS_API_KEY: 'k' },
  });
  assert.equal(built.ok, true);
  assert.equal(built.envId, 'ads-p9');
  assert.equal(built.env.AIDCP_ADS_USER_ID, 'p9');
  assert.equal(built.env.AIDCP_BROWSER_PROVIDER, 'adspower');
  assert.equal(built.env.AIDCP_CLOUD_URL, 'ws://example:8787'); // 其余继承保留（逃生阀）
  // 身份/端口键必须被剔除：任何一个泄漏都会钉死身份 → 云端互踢/串号
  for (const key of [
    'AIDCP_ACCOUNT_ID',
    'AIDCP_EDGE_ID',
    'AIDCP_CDP_PORT',
    'AIDCP_CHROME_PROFILE',
    'AIDCP_WECHAT_UNVERIFIED_WRITE_TEST_MODE',
  ]) {
    assert.equal(key in built.env, false, `${key} 不应泄漏进子进程 env`);
  }
});

test('buildEnvSpawnEnv：视频号平台原子注入 AIDCP_PLATFORM', () => {
  const built = fleet.buildEnvSpawnEnv({
    environment: { profileId: 'wc-profile', name: '视频号', platform: 'wechat_channels' },
    processEnv: {},
    providerEnv: {},
  });
  assert.equal(built.ok, true);
  assert.equal(built.env.AIDCP_PLATFORM, 'wechat_channels');
  assert.equal(built.env.AIDCP_ADS_USER_ID, 'wc-profile');
});

test('buildEnvSpawnEnv：缺分身 id（将回落主机名共享身份）→ 诚实拒绝（红线）', () => {
  const built = fleet.buildEnvSpawnEnv({ environment: { profileId: '' }, processEnv: {}, providerEnv: {} });
  assert.equal(built.ok, false);
  assert.match(built.reason, /拒绝启动/);
});

// ── 错峰串行队列 ──

test('createStaggerQueue：相邻任务开始间隔 ≥ spacing；单任务失败不阻塞其余', async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const queue = fleet.createStaggerQueue({
    spacingMs: 1100,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms; // 模拟时间推进
    },
  });
  const startedAt: number[] = [];
  const r1 = queue.enqueue(async () => {
    startedAt.push(clock);
    return 'a';
  });
  const r2 = queue.enqueue(async () => {
    startedAt.push(clock);
    throw new Error('boom'); // 失败被吞成 { ok:false }，不断链
  });
  const r3 = queue.enqueue(async () => {
    startedAt.push(clock);
    return 'c';
  });
  assert.equal(await r1, 'a');
  const failed = await r2;
  assert.equal(failed.ok, false);
  assert.match(failed.error, /boom/);
  assert.equal(await r3, 'c'); // 前一任务失败，队列继续
  // 相邻开始间隔 ≥ 1100ms
  for (let i = 1; i < startedAt.length; i++) {
    assert.ok(startedAt[i] - startedAt[i - 1] >= 1100, `第 ${i} 个任务与前一个间隔不足: ${startedAt[i] - startedAt[i - 1]}`);
  }
  assert.equal(sleeps.length >= 2, true);
});

test('createStaggerQueue：带 key 的前置准备项暴露当前等待位次，执行项不冒充排队', async () => {
  const queue = fleet.createStaggerQueue({ spacingMs: 0 });
  let releaseHead!: () => void;
  const gate = new Promise<void>((resolve) => { releaseHead = resolve; });
  const head = queue.enqueue(async () => {
    await gate;
    return true;
  }, 'head');
  await Promise.resolve();
  const second = queue.enqueue(async () => true, 'second');
  const third = queue.enqueue(async () => true, 'third');
  assert.equal(queue.pendingPosition('head'), null);
  assert.equal(queue.pendingPosition('second'), 1);
  assert.equal(queue.pendingPosition('third'), 2);
  releaseHead();
  await Promise.all([head, second, third]);
  assert.equal(queue.pendingPosition('second'), null);
});

// ── 同账号铺多环境检测 ──

test('duplicateAccountGroups：同账号两环境成组；无账号/单环境不报', () => {
  const groups = fleet.duplicateAccountGroups([
    { envId: 'ads-1', accountId: 'acct-a' },
    { envId: 'ads-2', accountId: 'acct-a' },
    { envId: 'ads-3', accountId: 'acct-b' },
    { envId: 'ads-4', accountId: '' },
  ]);
  assert.deepEqual(groups, [{ accountId: 'acct-a', envIds: ['ads-1', 'ads-2'] }]);
});

// ── parity：CJS 副本与 TS 原件语义逐位一致（改任一份必须同步另一份）──

test('decideRespawn parity：CJS 副本与 src/supervise/respawn-policy.ts 输出逐位一致', () => {
  const opts = { maxConsecutiveFailures: 5, backoffBaseMs: 1000, backoffMaxMs: 30000, healthyUptimeMs: 60000 };
  const exitCodes = [null, 0, 1, 137];
  const uptimes = [0, 1000, 59999, 60000, 3600000];
  const streaks = [0, 1, 4, 5, 6];
  for (const shuttingDown of [false, true]) {
    for (const exitCode of exitCodes) {
      for (const uptimeMs of uptimes) {
        for (const prevStreak of streaks) {
          const input = { exitCode, uptimeMs, prevStreak, shuttingDown };
          assert.deepEqual(
            fleet.decideRespawn(input, opts),
            decideRespawnTs(input, opts),
            `input=${JSON.stringify(input)}`,
          );
        }
      }
    }
  }
});

test('imageTempNamespace parity：外壳侧与核心侧同公式（清扫边界一致）', () => {
  for (const edgeId of ['ads-p1', 'self-node-1', 'host-my.Mac (2)', '', 'x'.repeat(80)]) {
    assert.equal(`aidcp-img-${fleet.imageTempNamespace(edgeId)}-`, imageTempPrefixFor(edgeId));
  }
});

test('classifyAdsInUse：真实同账号并发占用拒启 → 判终局并解析占用账号', () => {
  const line =
    '[aidcp-edge] 启动失败: Error: [aidcp-edge] AdsPower browser-profile/start 失败：code=-1 ' +
    'msg=[k1eioggp] is being used by [tommax.bai@gmail.com] and is not allowed to open（诚实失败，不回落 self）';
  const r = fleet.classifyAdsInUse(line);
  assert.equal(r.inUse, true);
  assert.equal(r.account, 'tommax.bai@gmail.com');
});

test('classifyAdsInUse：中文本地化占用文案（无账号）也判终局', () => {
  const r = fleet.classifyAdsInUse('AdsPower browser-profile/start 失败：该环境正在使用中，已在其它设备打开');
  assert.equal(r.inUse, true);
  assert.equal(r.account, undefined);
});

test('classifyAdsInUse：普通崩溃 / 缺内核 / 无关失败 / 空 → 一律不判终局（防误判）', () => {
  // 缺内核（可恢复态，走另一条特判，绝不能被误当终局）
  assert.equal(fleet.classifyAdsInUse('AdsPower browser-profile/start 失败：SunBrowser 148 is not ready').inUse, false);
  // 连云失败（有「启动失败」上下文但无占用签名）
  assert.equal(fleet.classifyAdsInUse('[aidcp-edge] 启动失败: Error: 连接云端失败 ECONNREFUSED').inUse, false);
  // 有占用签名但无 browser-profile/start 上下文（不满足双闸）
  assert.equal(fleet.classifyAdsInUse('some proxy is being used by another process').inUse, false);
  // 空输入
  assert.equal(fleet.classifyAdsInUse('').inUse, false);
  assert.equal(fleet.classifyAdsInUse(undefined).inUse, false);
});
