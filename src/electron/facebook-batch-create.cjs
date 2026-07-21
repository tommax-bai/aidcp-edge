const crypto = require('node:crypto');
const { parseProxyLines } = require('./ads-proxy-config.cjs');

const NO_PROXY_INPUT = Object.freeze({ proxyType: 'no_proxy' });

function nonBlankLines(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseFacebookBatchProxies({ proxyType, proxyText } = {}) {
  return parseProxyLines({ proxyType, proxyText });
}

function defaultRandomIndex(size) {
  return crypto.randomInt(size);
}

function createFacebookBatchPlan({
  accountEntries,
  proxyType,
  proxyText,
  osFamilyKeys,
  randomIndex = defaultRandomIndex,
} = {}) {
  const accounts = Array.isArray(accountEntries) ? accountEntries : [];
  if (accounts.length === 0) {
    return { ok: false, error: '批量新建请至少粘贴一条 Facebook 账号资料' };
  }
  const osFamilies = Array.isArray(osFamilyKeys)
    ? osFamilyKeys.map((key) => String(key || '').trim()).filter(Boolean)
    : [];
  if (osFamilies.length === 0) {
    return { ok: false, error: '当前没有可用的操作系统选项' };
  }
  const parsedProxies = parseFacebookBatchProxies({ proxyType, proxyText });
  if (!parsedProxies.ok) return parsedProxies;

  const plan = [];
  for (let i = 0; i < accounts.length; i += 1) {
    const osFamilyIndex = Number(randomIndex(osFamilies.length));
    if (!Number.isInteger(osFamilyIndex) || osFamilyIndex < 0 || osFamilyIndex >= osFamilies.length) {
      return { ok: false, error: '随机操作系统选择器返回了无效索引' };
    }
    const proxy = parsedProxies.noProxy
      ? { ...NO_PROXY_INPUT }
      : { ...parsedProxies.proxies[i % parsedProxies.proxies.length] };
    plan.push({
      accountImport: accounts[i],
      accountLine: i + 1,
      osFamilyKey: osFamilies[osFamilyIndex],
      proxy,
    });
  }
  return { ok: true, plan, proxyCount: parsedProxies.proxies.length };
}

function failedFacebookBatchReceipt(createdItems, failedIndex, reason) {
  const created = Array.isArray(createdItems) ? createdItems : [];
  const count = created.length;
  const index = Math.max(1, Number(failedIndex) || 1);
  const createdHint = count > 0 ? `已创建 ${count} 个环境，后续账号尚未创建` : '尚未创建任何环境';
  return {
    ok: false,
    error: `第 ${index} 个账号创建失败：${reason || '未知错误'}；${createdHint}`,
    created,
    createdCount: count,
    failedIndex: index,
    partial: count > 0,
  };
}

module.exports = {
  NO_PROXY_INPUT,
  nonBlankLines,
  parseFacebookBatchProxies,
  createFacebookBatchPlan,
  failedFacebookBatchReceipt,
};
