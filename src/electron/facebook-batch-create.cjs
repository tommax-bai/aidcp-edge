const crypto = require('node:crypto');
const { normalizeProxyInput, PROXY_TYPES } = require('./ads-proxy-config.cjs');

const NO_PROXY_INPUT = Object.freeze({ proxyType: 'no_proxy' });

function nonBlankLines(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function proxyFieldsForLine(line, index) {
  const lineNo = index + 1;
  const delimiter = line.includes('----') ? '----' : ':';
  const parts = line.split(delimiter);
  if (parts.length !== 2 && parts.length < 4) {
    return {
      ok: false,
      error: `第 ${lineNo} 条代理格式错误，请使用 host:port 或 host:port:username:password`,
    };
  }
  const host = parts[0].trim();
  const port = parts[1].trim();
  const user = parts.length >= 4 ? parts[2].trim() : '';
  const password = parts.length >= 4 ? parts.slice(3).join(delimiter) : '';
  return { ok: true, lineNo, host, port, user, password };
}

function canonicalProxyInput(proxyConfig) {
  return {
    proxyType: proxyConfig.proxy_type,
    proxyHost: proxyConfig.proxy_host,
    proxyPort: proxyConfig.proxy_port,
    proxyUser: proxyConfig.proxy_user || '',
    proxyPassword: proxyConfig.proxy_password || '',
  };
}

function parseFacebookBatchProxies({ proxyType, proxyText } = {}) {
  const type = String(proxyType || 'no_proxy').trim().toLowerCase();
  const lines = nonBlankLines(proxyText);
  if (type === 'no_proxy') {
    if (lines.length > 0) {
      return { ok: false, error: '选择「无代理」时请清空批量代理资料' };
    }
    return { ok: true, noProxy: true, proxies: [] };
  }
  if (!PROXY_TYPES.includes(type)) {
    return { ok: false, error: `代理类型须为 ${PROXY_TYPES.join('/')} 或选择「无代理」` };
  }
  if (lines.length === 0) {
    return { ok: false, error: '已选择代理类型，请至少粘贴一条代理资料' };
  }

  const proxies = [];
  for (let i = 0; i < lines.length; i += 1) {
    const fields = proxyFieldsForLine(lines[i], i);
    if (!fields.ok) return fields;
    const normalized = normalizeProxyInput({
      proxyType: type,
      proxyHost: fields.host,
      proxyPort: fields.port,
      proxyUser: fields.user,
      proxyPassword: fields.password,
    });
    if (!normalized.ok) {
      return { ok: false, error: `第 ${fields.lineNo} 条代理${normalized.error}` };
    }
    proxies.push(canonicalProxyInput(normalized.proxyConfig));
  }
  return { ok: true, noProxy: false, proxies };
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
