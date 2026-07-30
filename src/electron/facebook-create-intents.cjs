// Facebook 建环境时的「运行方式」与「全局免审」意图归一（change environment-level-rule-mode-and-approval）。
//
// 呈现层给出的是四选一的运行方式，Cloud operation policy 是唯一权威；Edge 只提交模式意图，
// 不保存或提交规则/消费节奏数字。免审是与运行方式完全独立的事实。本模块是主进程侧唯一的翻译与门禁点：
//   * 平台门禁：只有 Facebook 才允许携带这些意图，其它平台一旦带上就整请求拒绝（不靠渲染层隐藏兜底）。
//   * 互斥门禁：兼容的慢启动/规则布尔意图绝不允许同时为真；统一模式本身天然互斥。
//   * 免审只接受既定的两个模式取值；只有「全局免审」才真的下发字段，「按来源规则」等同于不下发。
'use strict';

const RUN_MODES = Object.freeze(['normal', 'cold_start', 'rule', 'consumption']);
const OPERATION_MODES = Object.freeze(['persona', 'slow_start', 'rule', 'consumption']);
const OPERATION_MODE_BY_RUN_MODE = Object.freeze({
  normal: 'persona',
  cold_start: 'slow_start',
  rule: 'rule',
  consumption: 'consumption',
});
const APPROVAL_MODES = Object.freeze(['source_rules', 'auto_approve_all']);

// 只有这四个键属于本模块管辖的意图；平台门禁按「键是否出现」判定，出现即视为意图。
const INTENT_KEYS = Object.freeze(['facebookRunMode', 'slowStartEnabled', 'facebookRuleModeEnabled', 'commentApprovalMode']);
const INTENT_LABELS = Object.freeze({
  facebookRunMode: '运行方式',
  slowStartEnabled: '慢启动',
  facebookRuleModeEnabled: '规则模式',
  commentApprovalMode: '全局免审',
});

function providedKeys(source) {
  return INTENT_KEYS.filter((key) => (
    Object.prototype.hasOwnProperty.call(source, key)
    && source[key] !== undefined
    && source[key] !== null
  ));
}

function readBooleanIntent(source, key) {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return { present: false };
  const value = source[key];
  if (value === undefined || value === null) return { present: false };
  if (typeof value !== 'boolean') {
    return { present: true, error: `${INTENT_LABELS[key]}意图只接受开或关，本次创建已拒绝` };
  }
  return { present: true, value };
}

/**
 * 归一一次创建请求里的运行方式 / 免审意图。
 *
 * 返回 { ok:true, runMode, facebookOperationMode, slowStartEnabled, facebookRuleModeEnabled,
 * commentApprovalMode }：
 *   runMode 只在 Facebook 时为四选一之一，其它平台为 null；
 *   facebookOperationMode 是交给 Cloud 的统一模式意图，Edge 不附带任何节奏参数；
 *   commentApprovalMode 只可能是 'auto_approve_all' 或 null（null = 不下发该字段，保持按来源规则）。
 * 任一门禁不过 → { ok:false, error }，调用方必须在创建任何本地环境之前整请求拒绝。
 */
function resolveFacebookCreationIntents({ platform, opts } = {}) {
  const source = opts && typeof opts === 'object' ? opts : {};
  const provided = providedKeys(source);

  if (platform !== 'facebook') {
    if (provided.length > 0) {
      const labels = provided.map((key) => INTENT_LABELS[key]).join('、');
      return {
        ok: false,
        error: `只有 Facebook 环境有运行方式与全局免审配置，本次请求携带了「${labels}」，已整体拒绝`,
      };
    }
    return {
      ok: true,
      runMode: null,
      facebookOperationMode: null,
      slowStartEnabled: false,
      facebookRuleModeEnabled: false,
      commentApprovalMode: null,
    };
  }

  let runMode = null;
  if (provided.includes('facebookRunMode')) {
    const raw = String(source.facebookRunMode).trim();
    if (!RUN_MODES.includes(raw)) {
      return { ok: false, error: '运行方式只能是普通、冷启动、规则或消费四者之一，本次创建已拒绝' };
    }
    runMode = raw;
  }

  const explicitSlowStart = readBooleanIntent(source, 'slowStartEnabled');
  if (explicitSlowStart.error) return { ok: false, error: explicitSlowStart.error };
  const explicitRuleMode = readBooleanIntent(source, 'facebookRuleModeEnabled');
  if (explicitRuleMode.error) return { ok: false, error: explicitRuleMode.error };

  const derived = runMode
    ? { slowStartEnabled: runMode === 'cold_start', facebookRuleModeEnabled: runMode === 'rule' }
    : null;
  if (derived) {
    // 同时给运行方式和与之矛盾的单项意图 = 调用方自相矛盾；按哪一边执行都是替调用方猜，故整请求拒绝。
    if (explicitSlowStart.present && explicitSlowStart.value !== derived.slowStartEnabled) {
      return { ok: false, error: '运行方式与慢启动意图互相矛盾，本次创建已拒绝' };
    }
    if (explicitRuleMode.present && explicitRuleMode.value !== derived.facebookRuleModeEnabled) {
      return { ok: false, error: '运行方式与规则模式意图互相矛盾，本次创建已拒绝' };
    }
  }

  const slowStartEnabled = derived ? derived.slowStartEnabled : explicitSlowStart.value === true;
  const facebookRuleModeEnabled = derived ? derived.facebookRuleModeEnabled : explicitRuleMode.value === true;
  if (slowStartEnabled && facebookRuleModeEnabled) {
    return { ok: false, error: '慢启动与规则模式不能同时开启，请只选择冷启动或规则，本次创建已拒绝' };
  }

  let commentApprovalMode = null;
  if (provided.includes('commentApprovalMode')) {
    const raw = String(source.commentApprovalMode).trim();
    if (!APPROVAL_MODES.includes(raw)) {
      return { ok: false, error: '全局免审意图取值无法识别，本次创建已拒绝' };
    }
    commentApprovalMode = raw === 'auto_approve_all' ? 'auto_approve_all' : null;
  }

  const resolvedRunMode = runMode
    || (slowStartEnabled ? 'cold_start' : facebookRuleModeEnabled ? 'rule' : 'normal');
  return {
    ok: true,
    runMode: resolvedRunMode,
    facebookOperationMode: OPERATION_MODE_BY_RUN_MODE[resolvedRunMode],
    slowStartEnabled,
    facebookRuleModeEnabled,
    commentApprovalMode,
  };
}

module.exports = {
  RUN_MODES,
  OPERATION_MODES,
  OPERATION_MODE_BY_RUN_MODE,
  APPROVAL_MODES,
  INTENT_KEYS,
  resolveFacebookCreationIntents,
};
