// 创建环境编排（change adspower-auto-create-env task 4）。把写客户端 + 指纹引擎串成
// 「按一下建一个环境」的动作，并守住几条不变量：
//  - 诚实分离创建态/就绪态（C1/D2）：建成只标 UNVERIFIED（仅配置层/未验证/不可投产），
//    绝不把 user/create 回 id 当就绪；「真实/就绪」由 environment-readiness-verification 运行时置位。
//  - 绑定意图（C2/D7）：把 intendedAccountLabel + 模板 + 建号机写进分身 remark（随 user/list 读回），
//    供登录握手回写比对真实 accountId。
//  - 防连点双建（H5）：单飞互斥，创建在途时重入诚实返回「进行中」。
//  - 代理全程手工（本按钮不碰，用户定）：默认 no_proxy 建号，不下发/不校验/不去重代理。
//  - 不做本机台账（D8）：账本以 AdsPower user/list 为准（专用分组 + remark），此模块不落任何本机文件。

const STATUS = Object.freeze({ UNVERIFIED: 'unverified', READY: 'ready', VERIFY_FAILED: 'verify_failed' });
const REMARK_TAG = 'aidcp-env';

/** 把意图/模板/机器编码进分身 remark（随 user/create 写入、user/list 读回）。 */
function encodeRemark({ intendedAccountLabel, template, machine, createdAt } = {}) {
  return JSON.stringify({
    t: REMARK_TAG,
    acct: intendedAccountLabel || '',
    tpl: template || '',
    mach: machine || '',
    ts: createdAt || 0,
  });
}

/** 从 remark 解出本 change 写入的元信息；非本 change 的 remark 返回 null。 */
function parseRemark(remark) {
  try {
    const o = JSON.parse(String(remark));
    if (o && o.t === REMARK_TAG) {
      return { intendedAccountLabel: o.acct || '', template: o.tpl || '', machine: o.mach || '', createdAt: o.ts || 0 };
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
   * 建一个环境。代理不传（默认 no_proxy，手工在 AdsPower 侧配）。
   * @returns {Promise<{ ok: boolean, userId?: string, status?: string, template?: string, intendedAccountLabel?: string, violations?: string[], error?: string, code?: number }>}
   */
  async function createEnvironment({ templateKey, intendedAccountLabel, machineLabel, groupId, name } = {}) {
    if (inFlight) {
      return { ok: false, error: '创建进行中，请等当前创建完成（防连点双建）' };
    }
    inFlight = true;
    try {
      if (!groupId) return { ok: false, status: 'rejected', error: '缺 groupId（应先建/取专用分组）' };
      const tpl = fingerprint.getTemplate(templateKey);
      if (!tpl) return { ok: false, status: 'rejected', error: `未知整机模板：${templateKey}` };

      const built = fingerprint.buildFingerprintConfig(tpl);
      if (!built.ok) {
        // 护栏 / 四者一致断言未过 → 诚实拒建，不提交矛盾环境。
        return { ok: false, status: 'rejected', violations: built.violations, error: '指纹护栏/一致性断言未过：' + built.violations.join('；') };
      }

      const remark = encodeRemark({ intendedAccountLabel, template: templateKey, machine: machineLabel, createdAt: now() });
      const r = await writeApi.createProfile({
        groupId,
        name: name || templateKey,
        fingerprintConfig: built.fingerprintConfig,
        proxyConfig: { proxy_soft: 'no_proxy' }, // 代理手工，本按钮不碰
        remark,
      });
      if (!r.ok) return { ok: false, error: r.error, code: r.code };

      // 关键红线：建成只标 UNVERIFIED，绝不当就绪。
      return {
        ok: true,
        userId: r.userId,
        status: STATUS.UNVERIFIED,
        template: templateKey,
        intendedAccountLabel: intendedAccountLabel || '',
      };
    } finally {
      inFlight = false;
    }
  }

  return { createEnvironment, encodeRemark, parseRemark, STATUS };
}

module.exports = { createCreateFlow, encodeRemark, parseRemark, STATUS, REMARK_TAG };
