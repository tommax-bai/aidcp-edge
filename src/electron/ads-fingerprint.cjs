// 指纹环境「整机模板 + 薄护栏 + OS 四者一致断言」（change adspower-auto-create-env task 3）。
//
// 设计（据 2026-07-03 真机探针 scripts/adspower-fingerprint-probe.ts 定案）：
//  - **最大化委托 AdsPower 生成**：默认 webgl='3'（random matching，AdsPower 按 OS 给自洽随机 renderer），
//    ua_auto 不用（探针实测会随机分 OS、甚至分到 iPhone），改**显式 pin OS**（random_ua.ua_system_version）
//    + 显式内核版本；aidcp 只挑「这是台什么机器」（整机模板）+ 极薄护栏 + 提交前一致断言。
//  - **护栏（实测支撑）**：device_memory 只允 2 的幂（探针：6→运行时读到 4，不忠实下发）；webgl 模式互斥
//    （'3' 无视 webgl_config、'2' 逐字 honor）→ '3' 时禁带 config、'2' 时必带 OS 匹配 renderer；webrtc 禁
//    local/real（泄真机 IP）；canvas/webgl_image/audio/client_rects 噪声必开；不启用「每次启动重随机指纹」。
//  - **四者一致断言**：声明 OS == UA 的 OS(ua_system_version) == 字体的 OS(若显式设) == renderer 家族 OS(若 '2')，
//    任一不符拒建（探针现场：AdsPower 会照单全收 Mac 画像 + Windows renderer 的矛盾，故必须自己断言）。

const POWERS_OF_2 = Object.freeze(['2', '4', '8', '16']); // deviceMemory 合法集（≤16；navigator.deviceMemory 上限 8，16 视内核而定）
const REALISTIC_CORES = Object.freeze(['2', '4', '6', '8', '12', '16']);
const ALLOWED_WEBRTC = Object.freeze(['proxy', 'disabled']); // 禁 local/real（真机 IP 泄露）
const NOISE_FIELDS = Object.freeze(['canvas', 'webgl_image', 'audio', 'client_rects']);
const DEFAULT_KERNEL = '148'; // 须为本机已安装内核；ua_auto 会随机分 OS + 触发按分身下载，故 pin（见探针 1.4）

// OS 标志字体（跨 OS 混装即矛盾）。
const WIN_FONTS = /segoe ui|calibri|consolas|cambria|tahoma/i;
const MAC_FONTS = /helvetica neue|san francisco|sf pro|\.sf ns|monaco|menlo/i;

/** 一套内部自洽的桌面整机模板。webgl 默认 '3'（委托，最稳）；'2' 需自带 OS 匹配 renderer。 */
const DEVICE_TEMPLATES = Object.freeze([
  { key: 'win11-intel', os: 'windows', uaSystemVersion: 'Windows 10', kernel: DEFAULT_KERNEL, deviceMemory: '8', hardwareConcurrency: '8', screenResolution: '1920_1080', webglMode: '3' },
  { key: 'win11-nvidia', os: 'windows', uaSystemVersion: 'Windows 10', kernel: DEFAULT_KERNEL, deviceMemory: '16', hardwareConcurrency: '16', screenResolution: '2560_1440', webglMode: '3' },
  { key: 'win11-nvidia-custom', os: 'windows', uaSystemVersion: 'Windows 10', kernel: DEFAULT_KERNEL, deviceMemory: '16', hardwareConcurrency: '12', screenResolution: '1920_1080', webglMode: '2',
    webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { key: 'macos-m2', os: 'macos', uaSystemVersion: 'Mac OS X 13_6', kernel: DEFAULT_KERNEL, deviceMemory: '8', hardwareConcurrency: '8', screenResolution: '1728_1117', webglMode: '3' },
  { key: 'macos-m3', os: 'macos', uaSystemVersion: 'Mac OS X 14_4', kernel: DEFAULT_KERNEL, deviceMemory: '16', hardwareConcurrency: '12', screenResolution: '1512_982', webglMode: '3' },
]);

/** 从各带 OS 信息的字段推断 OS 家族；返回 'windows'|'macos'|'linux'|'mobile'|'unknown'。 */
function osFromUaSystemVersion(s) {
  const v = String(s || '').toLowerCase();
  if (/windows/.test(v)) return 'windows';
  if (/mac os x|macos/.test(v)) return 'macos';
  if (/iphone|ipad|ios|android/.test(v)) return 'mobile';
  if (/linux|x11|ubuntu|cros/.test(v)) return 'linux';
  return 'unknown';
}
function osFromRenderer(r) {
  const v = String(r || '').toLowerCase();
  if (/direct3d|d3d11|d3d9/.test(v)) return 'windows';
  if (/metal|apple/.test(v)) return 'macos';
  if (/mesa|opengl es|swiftshader|llvmpipe/.test(v)) return 'linux';
  return 'unknown';
}
function osFromFonts(fonts) {
  if (!Array.isArray(fonts)) return 'unknown';
  const joined = fonts.join(' ');
  const win = WIN_FONTS.test(joined);
  const mac = MAC_FONTS.test(joined);
  if (win && mac) return 'mixed'; // 跨 OS 混装
  if (win) return 'windows';
  if (mac) return 'macos';
  return 'unknown';
}

/**
 * 薄静态护栏：校验一个 fingerprint_config 是否踩合法值/模式红线。
 * @returns {{ ok: boolean, violations: string[] }}
 */
function validateGuardrails(fp) {
  const v = [];
  if (!fp || typeof fp !== 'object') return { ok: false, violations: ['fingerprint_config 为空'] };

  if (fp.device_memory != null && !POWERS_OF_2.includes(String(fp.device_memory))) {
    v.push(`device_memory=${fp.device_memory} 非 2 的幂（合法：${POWERS_OF_2.join('/')}）——探针实测 6→运行时 4，不忠实下发`);
  }
  if (fp.hardware_concurrency != null && !REALISTIC_CORES.includes(String(fp.hardware_concurrency))) {
    v.push(`hardware_concurrency=${fp.hardware_concurrency} 非常见真实值（${REALISTIC_CORES.join('/')}）`);
  }
  const mode = fp.webgl != null ? String(fp.webgl) : undefined;
  if (mode != null && mode !== '0' && mode !== '2' && mode !== '3') {
    v.push(`webgl 模式=${mode} 未知（仅 0 跟随 / 2 自定义 / 3 随机匹配）`);
  }
  // webgl 模式互斥（探针：'3' 无视 config、'2' 逐字 honor）
  if (mode === '3' && fp.webgl_config) {
    v.push("webgl='3'(随机匹配) 时传 webgl_config 会被静默忽略——白传，MUST NOT 带（要锁家族改 webgl='2'）");
  }
  if (mode === '2' && (!fp.webgl_config || !fp.webgl_config.unmasked_renderer)) {
    v.push("webgl='2'(自定义) 必须带 webgl_config.unmasked_renderer（否则无渲染器可锁）");
  }
  if (fp.webrtc != null && !ALLOWED_WEBRTC.includes(String(fp.webrtc))) {
    v.push(`webrtc=${fp.webrtc} 禁用（仅 ${ALLOWED_WEBRTC.join('/')}；local/real 会泄本机真实 IP）`);
  }
  for (const n of NOISE_FIELDS) {
    if (fp[n] != null && String(fp[n]) !== '1') {
      v.push(`${n}=${fp[n]} 噪声未开——同机多号共享真 GPU 会撞哈希，MUST 为 '1'`);
    }
  }
  if (osFromFonts(fp.fonts) === 'mixed') {
    v.push('fonts 跨 OS 混装（同时含 Windows 与 macOS 独占字体）——直接矛盾');
  }
  return { ok: v.length === 0, violations: v };
}

/**
 * 四者一致断言：声明 OS 与 UA/字体/renderer 各带 OS 信息的字段是否全一致、且为桌面（非 mobile/linux 意外）。
 * @param {{os:string}} template
 * @param {object} fp
 * @returns {{ ok: boolean, violations: string[], declaredOs: string }}
 */
function assertOsCoherent(template, fp) {
  const declared = template && template.os;
  const v = [];
  if (declared !== 'windows' && declared !== 'macos') {
    v.push(`模板 OS=${declared} 非桌面（仅支持 windows/macos；探针实测不 pin OS 会随机分到 iPhone/Linux）`);
  }
  const uaOs = fp.random_ua && Array.isArray(fp.random_ua.ua_system_version)
    ? osFromUaSystemVersion(fp.random_ua.ua_system_version[0])
    : (fp.random_ua ? osFromUaSystemVersion(fp.random_ua.ua_system_version) : 'unknown');
  if (uaOs !== 'unknown' && uaOs !== declared) v.push(`UA 的 OS(${uaOs}) != 声明 OS(${declared})`);
  if (uaOs === 'unknown') v.push('未显式 pin OS（random_ua.ua_system_version 缺失）——MUST 钉死，勿放任 ua_auto 随机分 OS');

  if (String(fp.webgl) === '2' && fp.webgl_config && fp.webgl_config.unmasked_renderer) {
    const rOs = osFromRenderer(fp.webgl_config.unmasked_renderer);
    if (rOs !== 'unknown' && rOs !== declared) {
      v.push(`renderer 家族 OS(${rOs}) != 声明 OS(${declared})——如「Mac 画像 + Windows/Direct3D11 renderer」的一眼假`);
    }
  }
  if (fp.fonts) {
    const fOs = osFromFonts(fp.fonts);
    if (fOs !== 'unknown' && fOs !== 'mixed' && fOs !== declared) v.push(`字体 OS(${fOs}) != 声明 OS(${declared})`);
  }
  return { ok: v.length === 0, violations: v, declaredOs: declared };
}

/**
 * 由整机模板构造 fingerprint_config（委托生成为主 + 护栏 + 一致断言）。
 * @returns {{ ok: boolean, fingerprintConfig?: object, violations: string[], template: object }}
 */
function buildFingerprintConfig(template) {
  const t = template || {};
  const kernel = t.kernel || DEFAULT_KERNEL;
  const fp = {
    automatic_timezone: '1', // 时区随代理 IP
    language_switch: '1', // 语言随代理 IP
    location_switch: '1',
    webrtc: 'proxy', // 替换成代理 IP（禁 local/real）
    canvas: '1',
    webgl_image: '1',
    audio: '1',
    client_rects: '1',
    media_devices: '1',
    webgl: String(t.webglMode || '3'),
    device_memory: String(t.deviceMemory || '8'),
    hardware_concurrency: String(t.hardwareConcurrency || '8'),
    screen_resolution: t.screenResolution || 'none',
    browser_kernel_config: { version: kernel, type: 'chrome' },
    random_ua: { ua_browser: ['chrome'], ua_version: [kernel], ua_system_version: [t.uaSystemVersion] },
    do_not_track: 'default',
    flash: 'block',
    scan_port_type: '1',
  };
  // webgl='2' 才带 config（'3' 带会被忽略、护栏拦）。
  if (String(t.webglMode) === '2' && t.webglRenderer) {
    fp.webgl_config = { unmasked_vendor: t.webglVendor || '', unmasked_renderer: t.webglRenderer };
  }

  const g = validateGuardrails(fp);
  const a = assertOsCoherent(t, fp);
  const violations = [...g.violations, ...a.violations];
  if (violations.length > 0) return { ok: false, violations, template: t };
  return { ok: true, fingerprintConfig: fp, violations: [], template: t };
}

function getTemplate(key) {
  return DEVICE_TEMPLATES.find((t) => t.key === key);
}

module.exports = {
  DEVICE_TEMPLATES,
  POWERS_OF_2,
  REALISTIC_CORES,
  ALLOWED_WEBRTC,
  DEFAULT_KERNEL,
  osFromUaSystemVersion,
  osFromRenderer,
  osFromFonts,
  validateGuardrails,
  assertOsCoherent,
  buildFingerprintConfig,
  getTemplate,
};
