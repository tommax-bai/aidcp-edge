import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const flowMod = require('../../src/electron/ads-create-flow.cjs') as {
  createCreateFlow: (deps: {
    writeApi: { createProfile: (a: Record<string, unknown>) => Promise<{ ok: boolean; userId?: string; error?: string }> };
    fingerprint: { getTemplate: (k: string) => unknown; buildFingerprintConfig: (t: unknown) => { ok: boolean; fingerprintConfig?: unknown; violations: string[] } };
    nowImpl?: () => number;
  }) => {
    createEnvironment: (a: Record<string, unknown>) => Promise<{ ok: boolean; userId?: string; name?: string; status?: string; violations?: string[]; error?: string; intendedAccountLabel?: string }>;
    parseRemark: (r: string) => { intendedAccountLabel: string; template: string; machine: string } | null;
    encodeRemark: (o: Record<string, unknown>) => string;
    STATUS: { UNVERIFIED: string };
  };
  parseRemark: (r: string) => { intendedAccountLabel: string; template: string; machine: string } | null;
  encodeRemark: (o: Record<string, unknown>) => string;
  STATUS: { UNVERIFIED: string };
};
const realFingerprint = require('../../src/electron/ads-fingerprint.cjs');
const { createCreateFlow, parseRemark, encodeRemark, STATUS } = flowMod;

function recordingWriteApi(result: { ok: boolean; userId?: string; error?: string } = { ok: true, userId: 'u-new' }) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    createProfile: async (arg: Record<string, unknown>) => {
      calls.push(arg);
      return result;
    },
  };
}

test('happy path: 用真指纹引擎构造、remark 编码意图/模板/机器、proxy=no_proxy、只标未验证', async () => {
  const w = recordingWriteApi({ ok: true, userId: 'u-new' });
  const flow = createCreateFlow({ writeApi: w, fingerprint: realFingerprint, nowImpl: () => 1700000000000 });
  const r = await flow.createEnvironment({ templateKey: 'win11-intel', intendedAccountLabel: 'A', machineLabel: 'mac-01', groupId: 'g1' });

  assert.equal(r.ok, true);
  assert.equal(r.userId, 'u-new');
  assert.equal(r.name, '', '标准建号不写死模板名（change edge-adspower-name-follows-nickname）：不显式传 name → 回执 name 为空、入册允许空名（AdsPower 默认命名 + 登录后渐进改名跟随昵称）');
  assert.equal(r.status, STATUS.UNVERIFIED, '建成只标未验证，绝不当就绪');
  assert.equal(w.calls.length, 1);
  const body = w.calls[0] as any;
  assert.equal(body.name, undefined, '标准建号不把设备模板名写进 user/create 的 name（缺省 → AdsPower 默认命名）');
  assert.equal(body.groupId, 'g1');
  assert.deepEqual(body.proxyConfig, { proxy_soft: 'no_proxy' }, '不填代理 → 缺省仍 no_proxy（零回归）');
  assert.ok(body.fingerprintConfig && body.fingerprintConfig.random_ua, '带上构造好的 fingerprint_config');
  assert.equal(body.fingerprintConfig.location, 'block', 'user/create 指纹配置默认 Block 地理位置授权');
  assert.equal(body.fingerprintConfig.location_switch, '1', 'IP-based 指纹地理位置保持开启');
  const meta = parseRemark(body.remark);
  assert.ok(meta);
  assert.equal(meta!.intendedAccountLabel, 'A');
  assert.equal(meta!.template, 'win11-intel');
  assert.equal(meta!.machine, 'mac-01');
});

test('显式传 name（FB 导入路径）→ 返回体原样带回该名（edge-env-name-live-sync）', async () => {
  const w = recordingWriteApi({ ok: true, userId: 'u-fb' });
  const flow = createCreateFlow({ writeApi: w, fingerprint: realFingerprint });
  const r = await flow.createEnvironment({ templateKey: 'win11-intel', groupId: 'g1', name: 'Facebook import 1' });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'Facebook import 1', '显式 name 应原样回执，与写入 AdsPower 的 name 一致');
  assert.equal((w.calls[0] as any).name, 'Facebook import 1', 'user/create body 也应带该 name');
});

// ── change edge-client-proxy-platform-persona-ux：创建可选填代理 ──
test('带合法 proxy 输入 → user_proxy_config 随建号下发（proxy_soft=other）', async () => {
  const w = recordingWriteApi({ ok: true, userId: 'u-new' });
  const flow = createCreateFlow({ writeApi: w, fingerprint: realFingerprint });
  const r = await flow.createEnvironment({
    templateKey: 'win11-intel',
    groupId: 'g1',
    proxy: { proxyType: 'socks5', proxyHost: '1.2.3.4', proxyPort: '1080' },
  });
  assert.equal(r.ok, true);
  const body = w.calls[0] as any;
  assert.deepEqual(body.proxyConfig, { proxy_soft: 'other', proxy_type: 'socks5', proxy_host: '1.2.3.4', proxy_port: '1080' });
});

test('非法 proxy 输入 → 诚实拒建、不发请求（绝不静默按 no_proxy 建号）', async () => {
  const w = recordingWriteApi();
  const flow = createCreateFlow({ writeApi: w, fingerprint: realFingerprint });
  const r = await flow.createEnvironment({
    templateKey: 'win11-intel',
    groupId: 'g1',
    proxy: { proxyType: 'http', proxyHost: 'h.example', proxyPort: '70000' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'rejected');
  assert.match(String(r.error), /代理输入不合法/);
  assert.equal(w.calls.length, 0);
});

test('未知模板 → 诚实拒建，不调 createProfile', async () => {
  const w = recordingWriteApi();
  const flow = createCreateFlow({ writeApi: w, fingerprint: realFingerprint });
  const r = await flow.createEnvironment({ templateKey: 'no-such', groupId: 'g1' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'rejected');
  assert.equal(w.calls.length, 0);
});

test('缺 groupId → 拒建', async () => {
  const w = recordingWriteApi();
  const flow = createCreateFlow({ writeApi: w, fingerprint: realFingerprint });
  const r = await flow.createEnvironment({ templateKey: 'win11-intel' });
  assert.equal(r.ok, false);
  assert.equal(w.calls.length, 0);
});

test('护栏/断言未过 → 拒建并带 violations（stub 指纹）', async () => {
  const w = recordingWriteApi();
  const stubFp = {
    getTemplate: () => ({ os: 'macos' }),
    buildFingerprintConfig: () => ({ ok: false, violations: ['renderer 家族 OS(windows) != 声明 OS(macos)'] }),
  };
  const flow = createCreateFlow({ writeApi: w, fingerprint: stubFp });
  const r = await flow.createEnvironment({ templateKey: 'x', groupId: 'g1' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'rejected');
  assert.match((r.violations || []).join(), /renderer 家族 OS/);
  assert.equal(w.calls.length, 0, '断言未过 MUST NOT 提交');
});

test('写失败 → 传播 ok:false，status 不为 ready', async () => {
  const w = recordingWriteApi({ ok: false, error: 'code=-1 quota' });
  const flow = createCreateFlow({ writeApi: w, fingerprint: realFingerprint });
  const r = await flow.createEnvironment({ templateKey: 'win11-intel', groupId: 'g1' });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /quota/);
  assert.notEqual(r.status, 'ready');
});

test('单飞互斥：创建在途时重入返回「进行中」，不双建（H5）', async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const calls: Array<Record<string, unknown>> = [];
  const slowWrite = {
    createProfile: async (arg: Record<string, unknown>) => {
      calls.push(arg);
      await gate; // 挂起，模拟建号在途
      return { ok: true, userId: 'u1' };
    },
  };
  const flow = createCreateFlow({ writeApi: slowWrite, fingerprint: realFingerprint });
  const p1 = flow.createEnvironment({ templateKey: 'win11-intel', groupId: 'g1' }); // 在途
  const r2 = await flow.createEnvironment({ templateKey: 'win11-intel', groupId: 'g1' }); // 重入
  assert.equal(r2.ok, false);
  assert.match(String(r2.error), /进行中/);
  release();
  const r1 = await p1;
  assert.equal(r1.ok, true);
  assert.equal(calls.length, 1, '只建了一个');
});

test('parseRemark: 往返 + 非本 change 备注返回 null', () => {
  const enc = encodeRemark({ intendedAccountLabel: 'B', template: 'macos-m2', machine: 'm2', createdAt: 1 });
  const dec = parseRemark(enc);
  assert.equal(dec!.intendedAccountLabel, 'B');
  assert.equal(dec!.template, 'macos-m2');
  assert.equal(parseRemark('运维随手写的普通备注'), null);
  assert.equal(parseRemark('{"foo":1}'), null);
});

// ── change edge-environment-platform-select：每环境平台写进 remark + 回读 ──

test('创建时选平台 → remark 带 plat、回执带 platform', async () => {
  const w = recordingWriteApi({ ok: true, userId: 'u-fb' });
  const flow = createCreateFlow({ writeApi: w, fingerprint: realFingerprint });
  const r = (await flow.createEnvironment({ templateKey: 'win11-intel', groupId: 'g1', platform: 'facebook' } as any)) as any;
  assert.equal(r.ok, true);
  assert.equal(r.platform, 'facebook', '回执带归一化后的平台');
  const meta = parseRemark((w.calls[0] as any).remark) as any;
  assert.equal(meta.platform, 'facebook', 'remark 里 plat=facebook');
});

test('Facebook 导入资料只透传给 createProfile，不写进 remark', async () => {
  const w = recordingWriteApi({ ok: true, userId: 'u-fb-import' });
  const flow = createCreateFlow({ writeApi: w, fingerprint: realFingerprint });
  const accountImport = {
    username: 'fb@example.com',
    password: 'secret-password',
    fakey: 'SECRET2FA',
    cookie: '[{"name":"c_user","value":"100000000000001"}]',
    domainName: 'facebook.com',
    repeatConfig: [4],
  };
  const r = (await flow.createEnvironment({
    templateKey: 'win11-intel',
    groupId: 'g1',
    platform: 'facebook',
    intendedAccountLabel: '',
    accountImport,
  } as any)) as any;
  assert.equal(r.ok, true);
  assert.deepEqual((w.calls[0] as any).accountImport, accountImport);
  assert.doesNotMatch(String((w.calls[0] as any).remark), /fb@example.com|secret-password|SECRET2FA|c_user/);
});

test('创建不传平台 → 回落 xiaohongshu（零回归）', async () => {
  const w = recordingWriteApi({ ok: true, userId: 'u-xhs' });
  const flow = createCreateFlow({ writeApi: w, fingerprint: realFingerprint });
  const r = (await flow.createEnvironment({ templateKey: 'win11-intel', groupId: 'g1' })) as any;
  assert.equal(r.platform, 'xiaohongshu');
  const meta = parseRemark((w.calls[0] as any).remark) as any;
  assert.equal(meta.platform, 'xiaohongshu');
});

test('normalizePlatform: 别名归一 + 未知/空回落 xiaohongshu', () => {
  const { normalizePlatform } = flowMod as any;
  assert.equal(normalizePlatform('fb'), 'facebook');
  assert.equal(normalizePlatform('Facebook'), 'facebook');
  assert.equal(normalizePlatform('xhs'), 'xiaohongshu');
  assert.equal(normalizePlatform(''), 'xiaohongshu');
  assert.equal(normalizePlatform(undefined), 'xiaohongshu');
  assert.equal(normalizePlatform('instagram'), 'xiaohongshu', '未知平台 shell 层回落而非抛错');
});

test('parseRemark: 旧环境（无 plat 字段）回读平台回落 xiaohongshu', () => {
  // 模拟 change 前写入的 remark（无 plat 键）。
  const legacy = JSON.stringify({ t: 'aidcp-env', acct: 'A', tpl: 'win11-intel', mach: 'm', ts: 1 });
  const dec = parseRemark(legacy) as any;
  assert.equal(dec.platform, 'xiaohongshu');
});
