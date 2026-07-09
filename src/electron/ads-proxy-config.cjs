// 代理输入归一/校验的**单点真源**（change edge-client-proxy-platform-persona-ux task 1.1）。
// 创建环境（随 user/create 下发）与编辑已有环境（受限 user/update）两条链共用本层，
// 保证「非法输入诚实拒绝、绝不静默降级成 no_proxy / 砍字段后照发」只需在一处成立。
// AdsPower user_proxy_config 契约（官方本地 API 文档）：
//   proxy_soft: 自填代理用 'other'，无代理 'no_proxy'（代理池厂商枚举不做，YAGNI）
//   proxy_type: http | https | socks5；proxy_host / proxy_port；proxy_user / proxy_password 可选

const PROXY_TYPES = Object.freeze(['http', 'https', 'socks5']);
const NO_PROXY_CONFIG = Object.freeze({ proxy_soft: 'no_proxy' });

/**
 * 把 UI 原始输入归一为合法 user_proxy_config，或诚实报错。
 * @param {{ proxyType?: string, proxyHost?: string, proxyPort?: string|number, proxyUser?: string, proxyPassword?: string }} input
 * @returns {{ ok: true, proxyConfig: object, noProxy: boolean } | { ok: false, error: string }}
 */
function normalizeProxyInput(input = {}) {
  const type = String(input.proxyType == null ? '' : input.proxyType).trim().toLowerCase();
  const host = String(input.proxyHost == null ? '' : input.proxyHost).trim();
  const portRaw = String(input.proxyPort == null ? '' : input.proxyPort).trim();
  const user = String(input.proxyUser == null ? '' : input.proxyUser).trim();
  const password = String(input.proxyPassword == null ? '' : input.proxyPassword);

  // 无代理：显式选 no_proxy，或全部字段为空（未填 = 不配代理）。
  if (type === 'no_proxy' || (!type && !host && !portRaw && !user && !password)) {
    return { ok: true, proxyConfig: { ...NO_PROXY_CONFIG }, noProxy: true };
  }
  if (!PROXY_TYPES.includes(type)) {
    return { ok: false, error: `代理类型须为 ${PROXY_TYPES.join('/')} 或选择「无代理」` };
  }
  if (!host) return { ok: false, error: '代理地址（host）不能为空' };
  if (!/^\d+$/.test(portRaw)) return { ok: false, error: '代理端口须为 1-65535 的整数' };
  const port = Number(portRaw);
  if (port < 1 || port > 65535) return { ok: false, error: '代理端口须为 1-65535 的整数' };
  if (password && !user) return { ok: false, error: '填了代理密码就必须填代理用户名' };

  const proxyConfig = {
    proxy_soft: 'other',
    proxy_type: type,
    proxy_host: host,
    proxy_port: String(port),
  };
  if (user) proxyConfig.proxy_user = user;
  if (password) proxyConfig.proxy_password = password;
  return { ok: true, proxyConfig, noProxy: false };
}

module.exports = { normalizeProxyInput, PROXY_TYPES, NO_PROXY_CONFIG };
