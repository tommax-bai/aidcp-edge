'use strict';

// 「上次发布」历史态的环境归属判定（change env-switch-last-publish-reset）。
// ui-state.json 全局单文件曾不分账号：切换环境后旧账号的发布内容滞留在新账号名下
// （云端快照对无发布记录的账号宁缺毋假、不发覆盖，链路上没有清空语义）。
// 收敛规则：历史态带环境归属键持久化；异键 / 缺键（旧版文件）一律不采纳，
// 发布卡回落空态占位、等云端快照按当前账号回填——归属不明的内容不得挂在当前账号名下。

// self 只有一个隐式环境、固定键；adspower 按分身 id 分键（与核心 edgeId=ads-<id> 派生同源）。
function envKeyFromSettings(settings) {
  const s = settings || {};
  if (s.provider === 'self') return 'self';
  const id = typeof s.adsProfileId === 'string' ? s.adsProfileId.trim() : '';
  return `ads:${id}`;
}

// 读盘采纳判定：仅当持久化归属键与当前环境键一致、且形状合法时返回历史态，否则 null。
function adoptStoredLastPublish(parsed, currentEnvKey) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.envKey !== currentEnvKey) return null;
  const lp = parsed.lastPublish;
  if (!lp || typeof lp.title !== 'string' || !lp.title) return null;
  return { title: lp.title, at: lp.at || null };
}

function serializeUiState(envKey, lastPublish) {
  return { envKey, lastPublish };
}

module.exports = { envKeyFromSettings, adoptStoredLastPublish, serializeUiState };
