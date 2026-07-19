// AdsPower-first fingerprint creation.
//
// The shell now chooses only an OS family and a few safety constraints. AdsPower
// generates the remaining per-profile fingerprint details during user/create.
// Keep this file from drifting back into a small list of complete machine shapes.

const POWERS_OF_2 = Object.freeze(['2', '4', '8', '16']); // deviceMemory 合法集（≤16；navigator.deviceMemory 上限 8，16 视内核而定）
const REALISTIC_CORES = Object.freeze(['2', '4', '6', '8', '12', '16']);
const ALLOWED_WEBRTC = Object.freeze(['proxy', 'disabled']); // 禁 local/real（真机 IP 泄露）
const NOISE_FIELDS = Object.freeze(['canvas', 'webgl_image', 'audio', 'client_rects']);
const DEFAULT_KERNEL = '148'; // 须为本机已安装内核；ua_auto 会随机分 OS + 触发按分身下载，故 pin（见探针 1.4）
// AdsPower random_ua.ua_system_version 是离散枚举，不接受 13_6 / 14_4 这类补丁版本。
const ADSPOWER_DESKTOP_UA_SYSTEM_VERSIONS = Object.freeze(['Windows 10', 'Windows 11', 'Mac OS X 10', 'Mac OS X 11', 'Mac OS X 12', 'Mac OS X 13']);

// 界面 chrome 语言钉死规范 en-US（change facebook-locale-pin-en-us / C1）——单点常量便于回滚 / 灰度。
// 现状「语言随代理 IP」会让中国代理号突现中文 UI，令下游按钮/状态的文字识别跨国家/跨语言群组时漂移、
// 漏判 fail-closed 跳过；钉英文让识别单语化。已真机探针实证（2026-07-11，本机 AdsPower CLI chrome_149）：
// language_switch:'0' + language:['en-US'] → navigator.languages=['en-US','en']、Accept-Language 英文、
// **不随 IP**，且时区仍随 IP 独立。language 不进 assertOsCoherent（非 OS 一致性字段）；内容语言不受影响。
const FINGERPRINT_UI_LANGUAGE = Object.freeze(['en-US']);

// OS 标志字体（跨 OS 混装即矛盾）。
const WIN_FONTS = /segoe ui|calibri|consolas|cambria|tahoma/i;
const MAC_FONTS = /helvetica neue|san francisco|sf pro|\.sf ns|monaco|menlo/i;

const OS_FAMILIES = Object.freeze([
  { key: 'windows', label: 'Windows', os: 'windows', uaSystemVersions: Object.freeze(['Windows 10', 'Windows 11']), kernel: DEFAULT_KERNEL },
  { key: 'macos', label: 'macOS', os: 'macos', uaSystemVersions: Object.freeze(['Mac OS X 12', 'Mac OS X 13']), kernel: DEFAULT_KERNEL },
]);

const LEGACY_OS_FAMILY_ALIASES = Object.freeze({
  'win11-intel': 'windows',
  'win11-nvidia': 'windows',
  'win11-nvidia-custom': 'windows',
  'macos-m2': 'macos',
  'macos-m3': 'macos',
});

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
function uaSystemVersionsOf(fp) {
  const raw = fp && fp.random_ua ? fp.random_ua.ua_system_version : null;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  return raw ? [String(raw)] : [];
}

function assertOsCoherent(osFamily, fp) {
  const declared = osFamily && osFamily.os;
  const v = [];
  if (declared !== 'windows' && declared !== 'macos') {
    v.push(`OS family=${declared} 非桌面（仅支持 windows/macos；探针实测不 pin OS 会随机分到 iPhone/Linux）`);
  }
  const uaVersions = uaSystemVersionsOf(fp);
  if (uaVersions.length === 0) {
    v.push('未显式 pin OS（random_ua.ua_system_version 缺失）——MUST 钉死，勿放任 ua_auto 随机分 OS');
  } else {
    for (const version of uaVersions) {
      const uaOs = osFromUaSystemVersion(version);
      if (uaOs === 'unknown') v.push(`UA 系统版本(${version}) 未知，无法证明 OS 一致`);
      else if (uaOs !== declared) v.push(`UA 的 OS(${uaOs}) != 声明 OS(${declared})`);
    }
  }

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
 * 由 OS family 构造最小 fingerprint_config（AdsPower 生成为主 + 护栏 + 一致断言）。
 * @returns {{ ok: boolean, fingerprintConfig?: object, violations: string[], osFamily: object, template: object }}
 */
function buildFingerprintConfig(osFamily) {
  const t = osFamily || {};
  const kernel = t.kernel || DEFAULT_KERNEL;
  const uaSystemVersions = Array.isArray(t.uaSystemVersions)
    ? t.uaSystemVersions.map(String).filter(Boolean)
    : (t.uaSystemVersion ? [String(t.uaSystemVersion)] : []);
  const familyViolations = [];
  if (uaSystemVersions.length === 0) {
    familyViolations.push('ua_system_version 为空，无法约束 AdsPower 生成的桌面 OS');
  }
  for (const version of uaSystemVersions) {
    if (!ADSPOWER_DESKTOP_UA_SYSTEM_VERSIONS.includes(version)) {
      familyViolations.push(`ua_system_version=${version} 不在 AdsPower 支持枚举内（合法：${ADSPOWER_DESKTOP_UA_SYSTEM_VERSIONS.join('/')}）`);
    }
  }
  const fp = {
    automatic_timezone: '1', // 时区随代理 IP
    language_switch: '0', // 语言钉死 en-US（不随代理 IP）——见 FINGERPRINT_UI_LANGUAGE
    language: [...FINGERPRINT_UI_LANGUAGE], // 规范界面语言，令下游文字识别单语化；内容语言不受影响
    location: 'block', // 默认拒绝页面地理位置授权弹窗
    location_switch: '1', // 指纹地理位置仍随代理 IP（与授权策略独立）
    webrtc: 'proxy', // 替换成代理 IP（禁 local/real）
    canvas: '1',
    webgl_image: '1',
    audio: '1',
    client_rects: '1',
    media_devices: '1',
    webgl: '3',
    browser_kernel_config: { version: kernel, type: 'chrome' },
    random_ua: { ua_browser: ['chrome'], ua_version: [kernel], ua_system_version: uaSystemVersions },
    do_not_track: 'default',
    flash: 'block',
    scan_port_type: '1',
  };

  const g = validateGuardrails(fp);
  const a = assertOsCoherent(t, fp);
  const violations = [...familyViolations, ...g.violations, ...a.violations];
  if (violations.length > 0) return { ok: false, violations, osFamily: t, template: t };
  return { ok: true, fingerprintConfig: fp, violations: [], osFamily: t, template: t };
}

function normalizeOsFamilyKey(key) {
  const raw = String(key || '').trim().toLowerCase();
  return LEGACY_OS_FAMILY_ALIASES[raw] || raw;
}

function getOsFamily(key) {
  const normalized = normalizeOsFamilyKey(key);
  return OS_FAMILIES.find((t) => t.key === normalized);
}

// Compatibility for old callers/tests. This resolves to an OS family, not a
// complete machine template.
function getTemplate(key) {
  return getOsFamily(key);
}

module.exports = {
  OS_FAMILIES,
  // Compatibility export for legacy template callers. Do not add fixed machine
  // shapes here; the canonical list is OS_FAMILIES.
  DEVICE_TEMPLATES: OS_FAMILIES,
  POWERS_OF_2,
  REALISTIC_CORES,
  ALLOWED_WEBRTC,
  DEFAULT_KERNEL,
  ADSPOWER_DESKTOP_UA_SYSTEM_VERSIONS,
  FINGERPRINT_UI_LANGUAGE,
  osFromUaSystemVersion,
  osFromRenderer,
  osFromFonts,
  validateGuardrails,
  assertOsCoherent,
  buildFingerprintConfig,
  normalizeOsFamilyKey,
  getOsFamily,
  getTemplate,
};
