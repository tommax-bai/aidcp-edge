'use strict';

function cleanLabel(value, fallback = '当前账号') {
  const label = String(value || '').trim().replace(/\s+/g, ' ');
  return (label || fallback).slice(0, 80);
}

function browserPersonaNoticeForStatus(status, envName) {
  const current = status && typeof status === 'object' ? status : {};
  // 三态（change persona-bound-tristate）：只有云端**权威说未绑**（=== false）才提示；未知（null/缺省）
  // 一律不提示。旧写法 `!== true` 把「还没收到信号」也当成未绑，会误扰已设置人设的账号。
  const active = current.auth === 'logged in' && current.cloud === 'connected' && current.personaBound === false;
  if (!active) return { active: false };
  const accountName = current.account && typeof current.account.name === 'string' ? current.account.name : '';
  return {
    active: true,
    accountLabel: cleanLabel(accountName || envName),
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
