import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fp = require('../../src/electron/ads-fingerprint.cjs') as {
  DEVICE_TEMPLATES: Array<{ key: string; os: string; uaSystemVersion: string; webglMode: string; deviceMemory: string }>;
  ADSPOWER_DESKTOP_UA_SYSTEM_VERSIONS: string[];
  FINGERPRINT_UI_LANGUAGE: string[];
  validateGuardrails: (f: Record<string, unknown>) => { ok: boolean; violations: string[] };
  assertOsCoherent: (t: { os: string }, f: Record<string, unknown>) => { ok: boolean; violations: string[] };
  buildFingerprintConfig: (t: unknown) => { ok: boolean; fingerprintConfig?: Record<string, any>; violations: string[] };
  getTemplate: (k: string) => { os: string } | undefined;
  osFromRenderer: (r: string) => string;
  osFromUaSystemVersion: (s: string) => string;
  osFromFonts: (f: string[]) => string;
};

// ── 护栏：device_memory 只允 2 的幂（探针：6→运行时 4） ──
test('护栏: device_memory 非 2 的幂（6/3/5）被拒，8/16 放行', () => {
  assert.equal(fp.validateGuardrails({ device_memory: '6' }).ok, false);
  assert.equal(fp.validateGuardrails({ device_memory: '3' }).ok, false);
  assert.equal(fp.validateGuardrails({ device_memory: '5' }).ok, false);
  assert.equal(fp.validateGuardrails({ device_memory: '8' }).ok, true);
  assert.equal(fp.validateGuardrails({ device_memory: '16' }).ok, true);
  assert.match(fp.validateGuardrails({ device_memory: '6' }).violations.join(), /device_memory/);
});

// ── 护栏：webgl 模式互斥（探针：'3' 无视 config、'2' 逐字 honor） ──
test("护栏: webgl='3' 带 webgl_config 被拒（会被静默忽略）", () => {
  const r = fp.validateGuardrails({ webgl: '3', webgl_config: { unmasked_renderer: 'x' } });
  assert.equal(r.ok, false);
  assert.match(r.violations.join(), /忽略|白传/);
});
test("护栏: webgl='2' 无 renderer 被拒；带 renderer 放行", () => {
  assert.equal(fp.validateGuardrails({ webgl: '2' }).ok, false);
  assert.equal(fp.validateGuardrails({ webgl: '2', webgl_config: { unmasked_renderer: 'ANGLE (NVIDIA, ... Direct3D11)' } }).ok, true);
});

test('护栏: webrtc local/real 被拒；proxy/disabled 放行', () => {
  assert.equal(fp.validateGuardrails({ webrtc: 'local' }).ok, false);
  assert.equal(fp.validateGuardrails({ webrtc: 'real' }).ok, false);
  assert.equal(fp.validateGuardrails({ webrtc: 'proxy' }).ok, true);
  assert.equal(fp.validateGuardrails({ webrtc: 'disabled' }).ok, true);
});

test('护栏: 噪声字段关闭被拒（canvas=0）', () => {
  assert.equal(fp.validateGuardrails({ canvas: '0' }).ok, false);
  assert.equal(fp.validateGuardrails({ canvas: '1', webgl_image: '1', audio: '1', client_rects: '1' }).ok, true);
});

test('护栏: fonts 跨 OS 混装被拒', () => {
  assert.equal(fp.validateGuardrails({ fonts: ['Segoe UI', 'Helvetica Neue'] }).ok, false);
  assert.equal(fp.osFromFonts(['Segoe UI', 'Calibri']), 'windows');
  assert.equal(fp.osFromFonts(['Helvetica Neue', 'Menlo']), 'macos');
});

// ── 四者一致断言：H6 现场（Mac 画像 + Windows renderer） ──
test('断言: Mac 模板 + Windows/Direct3D11 renderer → 违规', () => {
  const macTpl = { os: 'macos' };
  const badFp = {
    random_ua: { ua_system_version: ['Mac OS X 13'] },
    webgl: '2',
    webgl_config: { unmasked_renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  };
  const a = fp.assertOsCoherent(macTpl, badFp);
  assert.equal(a.ok, false);
  assert.match(a.violations.join(), /renderer 家族 OS/);
});

test('断言: 缺 ua_system_version（未 pin OS）→ 违规', () => {
  const a = fp.assertOsCoherent({ os: 'windows' }, { webgl: '3' });
  assert.equal(a.ok, false);
  assert.match(a.violations.join(), /pin OS|ua_auto/);
});

test('断言: 非桌面 OS（linux）→ 违规', () => {
  const a = fp.assertOsCoherent({ os: 'linux' }, { random_ua: { ua_system_version: ['Linux'] } });
  assert.equal(a.ok, false);
  assert.match(a.violations.join(), /非桌面/);
});

test('osFromRenderer/osFromUaSystemVersion 家族判定', () => {
  assert.equal(fp.osFromRenderer('ANGLE (NVIDIA, ... Direct3D11 ...)'), 'windows');
  assert.equal(fp.osFromRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro)'), 'macos');
  assert.equal(fp.osFromRenderer('ANGLE (Intel, Mesa Intel(R) Xe Graphics, OpenGL 4.6)'), 'linux');
  assert.equal(fp.osFromUaSystemVersion('iPhone'), 'mobile');
  assert.equal(fp.osFromUaSystemVersion('Windows 10'), 'windows');
});

// ── 所有内置模板都能构造出自洽合法环境、且都显式 pin 桌面 OS ──
test('所有 DEVICE_TEMPLATES 构造出 ok 且自洽，均 pin 桌面 OS', () => {
  assert.ok(fp.DEVICE_TEMPLATES.length >= 4);
  for (const t of fp.DEVICE_TEMPLATES) {
    const r = fp.buildFingerprintConfig(t);
    assert.equal(r.ok, true, `${t.key} 应构造成功，违规：${r.violations.join('; ')}`);
    assert.ok(['windows', 'macos'].includes(t.os), `${t.key} 必须桌面 OS`);
    const built = r.fingerprintConfig!;
    // 显式 pin OS
    assert.ok(built.random_ua && built.random_ua.ua_system_version[0] === t.uaSystemVersion, `${t.key} 应 pin ua_system_version`);
    assert.ok(fp.ADSPOWER_DESKTOP_UA_SYSTEM_VERSIONS.includes(t.uaSystemVersion), `${t.key} ua_system_version 必须是 AdsPower 可匹配枚举`);
    // 噪声开、webrtc 非 local/real、device_memory 2 的幂
    assert.equal(built.canvas, '1');
    assert.notEqual(built.webrtc, 'local');
    assert.equal(built.location, 'block', `${t.key} 应默认拒绝页面地理位置授权`);
    assert.equal(built.location_switch, '1', `${t.key} 指纹地理位置仍应随代理 IP`);
    assert.ok(['2', '4', '8', '16'].includes(built.device_memory));
    // webgl='3' 不带 config；'2' 带 OS 匹配 renderer
    if (built.webgl === '3') assert.equal(built.webgl_config, undefined, `${t.key} webgl='3' 不应带 config`);
    if (built.webgl === '2') assert.ok(built.webgl_config && built.webgl_config.unmasked_renderer, `${t.key} webgl='2' 应带 renderer`);
  }
});

test('AdsPower 不支持的 ua_system_version 在提交前被拒', () => {
  const template = {
    key: 'bad-macos',
    os: 'macos',
    uaSystemVersion: 'Mac OS X 14_4',
    kernel: '148',
    deviceMemory: '16',
    hardwareConcurrency: '12',
    screenResolution: '1512_982',
    webglMode: '3',
  };
  const r = fp.buildFingerprintConfig(template);
  assert.equal(r.ok, false);
  assert.match(r.violations.join('; '), /ua_system_version=Mac OS X 14_4/);
  assert.match(r.violations.join('; '), /AdsPower 支持枚举/);
});

// ── C1（facebook-locale-pin-en-us）：界面语言钉死 en-US、时区仍随 IP、pin 不触发一致性拒建 ──
test('语言 pin: 每个模板产物 language=[en-US]、language_switch 关闭、时区仍 based-on-IP', () => {
  assert.deepEqual(fp.FINGERPRINT_UI_LANGUAGE, ['en-US'], '语言常量单点应为 en-US');
  for (const t of fp.DEVICE_TEMPLATES) {
    const r = fp.buildFingerprintConfig(t);
    assert.equal(r.ok, true, `${t.key}: ${r.violations.join('; ')}`);
    const built = r.fingerprintConfig!;
    assert.deepEqual(built.language, ['en-US'], `${t.key} 界面语言应钉 en-US`);
    assert.equal(built.language_switch, '0', `${t.key} 语言不应随代理 IP`);
    assert.equal(built.automatic_timezone, '1', `${t.key} 时区仍应随代理 IP（语言 pin 与时区独立、并存无冲突）`);
  }
});

test('语言 pin: language 不进四者一致断言，pin en-US 不触发 coherence 拒建', () => {
  const macTpl = fp.DEVICE_TEMPLATES.find((t) => t.os === 'macos')!;
  const r = fp.buildFingerprintConfig(macTpl);
  assert.equal(r.ok, true, r.violations.join('; '));
  const a = fp.assertOsCoherent(macTpl, r.fingerprintConfig!);
  assert.equal(a.ok, true, `language=en-US 不应触发 OS 不一致：${a.violations.join('; ')}`);
  assert.doesNotMatch(a.violations.join(), /language|语言/, 'language 不是 OS 一致性字段');
});

test("webgl='2' 内置模板的 renderer 与其声明 OS 家族一致", () => {
  for (const t of fp.DEVICE_TEMPLATES.filter((x) => x.webglMode === '2')) {
    const r = fp.buildFingerprintConfig(t);
    assert.equal(r.ok, true, `${t.key}: ${r.violations.join('; ')}`);
    const rOs = fp.osFromRenderer(r.fingerprintConfig!.webgl_config.unmasked_renderer);
    assert.equal(rOs, t.os, `${t.key} renderer OS 应 == ${t.os}`);
  }
});
