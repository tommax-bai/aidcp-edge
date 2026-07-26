'use strict';

const { execFile } = require('node:child_process');

const SCUTIL_PATH = '/usr/sbin/scutil';
const SYSTEM_PROXY_PRIORITY = [
  { enableKey: 'SOCKSEnable', hostKey: 'SOCKSProxy', portKey: 'SOCKSPort', proxyType: 'socks5', source: 'socks5' },
  { enableKey: 'HTTPSEnable', hostKey: 'HTTPSProxy', portKey: 'HTTPSPort', proxyType: 'http', source: 'https_web' },
  { enableKey: 'HTTPEnable', hostKey: 'HTTPProxy', portKey: 'HTTPPort', proxyType: 'http', source: 'http_web' },
];

function scalarEntries(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2];
  }
  return values;
}

function validProxyHost(value) {
  const host = String(value || '').trim();
  if (!host || host.length > 253 || /[\s/:?#\[\]@]/.test(host)) return '';
  return host;
}

function validProxyPort(value) {
  const raw = String(value || '').trim();
  if (!/^\d+$/.test(raw)) return 0;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 0;
}

function parseScutilProxy(text) {
  const values = scalarEntries(text);
  if (values.ProxyAutoConfigEnable === '1') {
    return { ok: false, reason: 'system_proxy_pac_unsupported' };
  }
  if (values.ProxyAutoDiscoveryEnable === '1') {
    return { ok: false, reason: 'system_proxy_wpad_unsupported' };
  }
  for (const candidate of SYSTEM_PROXY_PRIORITY) {
    if (values[candidate.enableKey] !== '1') continue;
    const host = validProxyHost(values[candidate.hostKey]);
    const port = validProxyPort(values[candidate.portKey]);
    if (!host || !port) return { ok: false, reason: 'system_proxy_config_invalid' };
    return {
      ok: true,
      proxy: {
        proxyType: candidate.proxyType,
        proxyHost: host,
        proxyPort: String(port),
      },
      source: candidate.source,
    };
  }
  return { ok: false, reason: 'system_proxy_not_configured' };
}

function execFileText(execFileImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || ''));
    });
  });
}

async function resolveMacSystemProxy(options = {}) {
  if ((options.platform || process.platform) !== 'darwin') {
    return { ok: false, reason: 'system_proxy_platform_unsupported' };
  }
  try {
    const output = await execFileText(
      options.execFileImpl || execFile,
      options.scutilPath || SCUTIL_PATH,
      ['--proxy'],
      { encoding: 'utf8', timeout: Math.max(100, Number(options.timeoutMs) || 2_000), windowsHide: true },
    );
    return parseScutilProxy(output);
  } catch {
    return { ok: false, reason: 'system_proxy_read_failed' };
  }
}

module.exports = {
  SCUTIL_PATH,
  SYSTEM_PROXY_PRIORITY,
  parseScutilProxy,
  resolveMacSystemProxy,
  validProxyHost,
  validProxyPort,
};
