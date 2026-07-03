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
    createEnvironment: (a: Record<string, unknown>) => Promise<{ ok: boolean; userId?: string; status?: string; violations?: string[]; error?: string; intendedAccountLabel?: string }>;
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
  assert.equal(r.status, STATUS.UNVERIFIED, '建成只标未验证，绝不当就绪');
  assert.equal(w.calls.length, 1);
  const body = w.calls[0] as any;
  assert.equal(body.groupId, 'g1');
  assert.deepEqual(body.proxyConfig, { proxy_soft: 'no_proxy' }, '代理手工、默认 no_proxy');
  assert.ok(body.fingerprintConfig && body.fingerprintConfig.random_ua, '带上构造好的 fingerprint_config');
  const meta = parseRemark(body.remark);
  assert.ok(meta);
  assert.equal(meta!.intendedAccountLabel, 'A');
  assert.equal(meta!.template, 'win11-intel');
  assert.equal(meta!.machine, 'mac-01');
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
