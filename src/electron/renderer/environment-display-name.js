'use strict';

// 客户端环境身份显示名的进程无关解析器：renderer 通过 <script> 使用，main/test 通过 require 使用。
// 这里只解析「当前环境是谁」；帖子作者、互动对象等第三方身份必须继续使用各自业务 DTO。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.environmentDisplayName = api;
})(typeof window !== 'undefined' ? window : null, function () {
  function resolveEnvironmentDisplayName(row) {
    const acct = row && row.status && row.status.account;
    const manualName = row && row.nameSource === 'manual' && row.name ? String(row.name) : '';
    const realNick = acct && acct.source !== 'env' && acct.name ? String(acct.name) : '';
    const environmentName = (row && (row.name || (row.status && row.status.envName)))
      || (acct && acct.source === 'env' && acct.name ? String(acct.name) : '');
    const envId = row && row.envId != null ? String(row.envId) : '';
    if (manualName) return { name: manualName, source: 'manual' };
    if (realNick) return { name: realNick, source: 'platform' };
    if (environmentName) return { name: String(environmentName), source: 'environment' };
    return { name: envId ? `环境 …${envId.slice(-4)}` : '', source: 'fallback' };
  }

  return { resolveEnvironmentDisplayName };
});
