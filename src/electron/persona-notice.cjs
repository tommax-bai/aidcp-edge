'use strict';

const { resolveEnvironmentDisplayName } = require('./renderer/environment-display-name.cjs');

function cleanLabel(value, fallback = '当前账号') {
  const label = String(value || '').trim().replace(/\s+/g, ' ');
  return (label || fallback).slice(0, 80);
}

/**
 * 受控页「去设置人设」横幅的判定。
 *
 * `facebookRuleMode` 是该环境**已读到的**云端权威规则模式事实，形如 `{ platform, enabled }`：
 * `platform` 是调用方已解析规范化的平台 id，`enabled` 是云端配置真值。
 * null / undefined = 还没读到（或读失败）——那一律按未启用处理。
 */
function browserPersonaNoticeForStatus(status, environment, facebookRuleMode) {
  const current = status && typeof status === 'object' ? status : {};
  // 三态（change persona-bound-tristate）：只有云端**权威说未绑**（=== false）才提示；未知（null/缺省）
  // 一律不提示。旧写法 `!== true` 把「还没收到信号」也当成未绑，会误扰已设置人设的账号。
  const active = current.auth === 'logged in' && current.cloud === 'connected' && current.personaBound === false;
  if (!active) return { active: false };
  // 规则模式免人设（change facebook-rule-mode-without-persona）：Facebook 账号若其环境已启用规则模式，
  // 「没有人设」就是它的正常运行态，不是待办——横幅会让运营去补一份规则模式根本不读的配置，还会把
  // 「正在按规则跑」误传成「没跑起来」。
  // 判据只认已读到的云端权威配置：读不到 / 读失败 / 未启用一律按未启用处理（fail-closed 回既有横幅），
  // 绝不本地推断。与 `renderer/ui-logic.js` 的 facebookRuleModeWithoutPersona 同一条判据，两处须同步。
  if (facebookRuleMode && typeof facebookRuleMode === 'object'
      && facebookRuleMode.platform === 'facebook'
      && facebookRuleMode.enabled === true) return { active: false };
  const row = environment && typeof environment === 'object'
    ? {
      envId: environment.envId,
      name: environment.name,
      nameSource: environment.nameSource,
      status: current,
    }
    : { name: environment, status: current };
  const display = resolveEnvironmentDisplayName(row);
  return {
    active: true,
    accountLabel: cleanLabel(display.name),
  };
}

function browserPersonaNoticeKey(notice) {
  const normalized = notice && notice.active === true
    ? { active: true, accountLabel: cleanLabel(notice.accountLabel) }
    : { active: false };
  return JSON.stringify(normalized);
}

module.exports = {
  browserPersonaNoticeForStatus,
  browserPersonaNoticeKey,
};
