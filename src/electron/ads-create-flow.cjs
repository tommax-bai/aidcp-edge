// 创建环境编排（change adspower-auto-create-env task 4）。把写客户端 + 指纹引擎串成
// 「按一下建一个环境」的动作，并守住几条不变量：
//  - 诚实分离创建态/就绪态（C1/D2）：建成只标 UNVERIFIED（仅配置层/未验证/不可投产），
//    绝不把 user/create 回 id 当就绪；「真实/就绪」由 environment-readiness-verification 运行时置位。
//  - 绑定意图（C2/D7）：把 intendedAccountLabel + 模板 + 建号机写进分身 remark（随 user/list 读回），
//    供登录握手回写比对真实 accountId。
//  - 防连点双建（H5）：单飞互斥，创建在途时重入诚实返回「进行中」。
//  - 代理可选（edge-client-proxy-platform-persona-ux）：表单填了合法代理即随建号下发，
//    不填默认 no_proxy（与历史行为逐位等价）；非法输入经归一层诚实拒建、绝不静默降级。
//  - 不做本机台账（D8）：账本以 AdsPower user/list 为准（专用分组 + remark），此模块不落任何本机文件。

const { normalizeProxyInput } = require('./ads-proxy-config.cjs');

const STATUS = Object.freeze({ UNVERIFIED: 'unverified', READY: 'ready', VERIFY_FAILED: 'verify_failed' });
const REMARK_TAG = 'aidcp-env';

// change edge-environment-platform-select：每环境的运行时平台（决定启动时打开哪个平台首页、握手上报哪个平台）。
// 与核心 src/platform 的 PlatformId 对齐（xiaohongshu | facebook）；空/未知/旧环境一律回落 xiaohongshu（零回归）。
const DEFAULT_PLATFORM = 'xiaohongshu';
const SUPPORTED_PLATFORMS = Object.freeze(['xiaohongshu', 'facebook']);

/** 归一平台字符串到规范值；空/未知回落 xiaohongshu（shell 层不抛，honest fallback）。 */
function normalizePlatform(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!v || v === 'xhs' || v === 'redbook' || v === 'xiaohongshu') return 'xiaohongshu';
  if (v === 'facebook' || v === 'fb') return 'facebook';
  return DEFAULT_PLATFORM;
}

/** 把意图/模板/机器/平台编码进分身 remark（随 user/create 写入、user/list 读回）。 */
function encodeRemark({ intendedAccountLabel, template, machine, createdAt, platform } = {}) {
  return JSON.stringify({
    t: REMARK_TAG,
    acct: intendedAccountLabel || '',
    tpl: template || '',
    mach: machine || '',
    ts: createdAt || 0,
    plat: normalizePlatform(platform), // 每环境平台（缺省 xiaohongshu）
  });
}

/** 从 remark 解出本 change 写入的元信息；非本 change 的 remark 返回 null。 */
function parseRemark(remark) {
  try {
    const o = JSON.parse(String(remark));
    if (o && o.t === REMARK_TAG) {
      return {
        intendedAccountLabel: o.acct || '',
        template: o.tpl || '',
        machine: o.mach || '',
        createdAt: o.ts || 0,
        // 旧环境无 plat 字段 → 回落 xiaohongshu（零回归）。
        platform: normalizePlatform(o.plat),
      };
    }
  } catch {
    /* 非 JSON / 非本 change：忽略 */
  }
  return null;
}

/**
 * @param {{ writeApi: { createProfile: Function }, fingerprint: { getTemplate: Function, buildFingerprintConfig: Function }, nowImpl?: () => number }} deps
 */
function createCreateFlow(deps) {
  const writeApi = deps.writeApi;
  const fingerprint = deps.fingerprint;
  const now = deps.nowImpl || (() => Date.now());
  let inFlight = false;

  /**
   * 建一个环境。proxy 可选（渲染层原始输入）：填了经归一层校验后随建号下发，
   * 非法诚实拒建；缺省 no_proxy（与历史行为逐位等价）。
   * @returns {Promise<{ ok: boolean, userId?: string, status?: string, template?: string, intendedAccountLabel?: string, violations?: string[], error?: string, code?: number }>}
   */
  async function createEnvironment({ templateKey, intendedAccountLabel, machineLabel, groupId, name, platform, accountImport, proxy } = {}) {
    if (inFlight) {
      return { ok: false, error: '创建进行中，请等当前创建完成（防连点双建）' };
    }
    inFlight = true;
    try {
      if (!groupId) return { ok: false, status: 'rejected', error: '缺 groupId（应先建/取专用分组）' };
      const tpl = fingerprint.getTemplate(templateKey);
      if (!tpl) return { ok: false, status: 'rejected', error: `未知整机模板：${templateKey}` };

      const proxyNorm = normalizeProxyInput(proxy || {});
      if (!proxyNorm.ok) {
        // 与指纹护栏同款诚实拒建：绝不静默按 no_proxy 建号。
        return { ok: false, status: 'rejected', error: `代理输入不合法：${proxyNorm.error}` };
      }

      const built = fingerprint.buildFingerprintConfig(tpl);
      if (!built.ok) {
        // 护栏 / 四者一致断言未过 → 诚实拒建，不提交矛盾环境。
        return { ok: false, status: 'rejected', violations: built.violations, error: '指纹护栏/一致性断言未过：' + built.violations.join('；') };
      }

      const remark = encodeRemark({ intendedAccountLabel, template: templateKey, machine: machineLabel, createdAt: now(), platform });
      const r = await writeApi.createProfile({
        groupId,
        // 建号不写死设备模板名（change edge-adspower-name-follows-nickname）：标准建号路径 name 缺省 →
        // 不下发 name、交 AdsPower 默认命名（登录读到真实昵称后由主进程渐进改名跟随昵称）；
        // FB 批量导入路径仍显式传 name（profileNameForFacebookImport），原样下发。
        name,
        fingerprintConfig: built.fingerprintConfig,
        proxyConfig: proxyNorm.proxyConfig,
        remark,
        accountImport,
      });
      if (!r.ok) return { ok: false, error: r.error, code: r.code };

      // 关键红线：建成只标 UNVERIFIED，绝不当就绪。
      return {
        ok: true,
        userId: r.userId,
        // 带回实际写入 AdsPower 的环境名（= 上面 createProfile 的 name）：显式传了（FB 导入）则带回该名、
        // 标准建号未传则为空（AdsPower 默认命名，入册允许空名、由左栏显示兜底 + 登录后渐进改名跟随昵称，
        // change edge-adspower-name-follows-nickname）。
        name: name || '',
        status: STATUS.UNVERIFIED,
        template: templateKey,
        intendedAccountLabel: intendedAccountLabel || '',
        platform: normalizePlatform(platform),
      };
    } finally {
      inFlight = false;
    }
  }

  return { createEnvironment, encodeRemark, parseRemark, STATUS };
}

module.exports = { createCreateFlow, encodeRemark, parseRemark, normalizePlatform, STATUS, REMARK_TAG, DEFAULT_PLATFORM, SUPPORTED_PLATFORMS };
