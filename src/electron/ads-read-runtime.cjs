// Ads LocalAPI read recovery shared by status/profile-list IPC handlers.
// Keep the common panel path cheap: a known service base is read directly.
// Only a cold read or a transport failure is allowed to run the CLI ensure path.

const TRANSPORT_FAILURE_RE = /fetch failed|不可达|econnrefused|enotfound|socket hang up|network error/i;

function needsRuntimeRecovery(result) {
  if (!result || result.ok) return false;
  return TRANSPORT_FAILURE_RE.test(String(result.error || ''));
}

function runtimeUnavailable(service) {
  return {
    ok: false,
    error: `指纹浏览器运行时未就绪：${(service && service.error) || '未知错误'}`,
    retryable: true,
  };
}

/**
 * @param {{
 *   hasBase: () => boolean,
 *   clearBase: () => void,
 *   ensure: () => Promise<{ok:boolean,error?:string}>,
 *   read: () => Promise<{ok:boolean,error?:string}>
 * }} deps
 */
async function readWithRuntimeRecovery({ hasBase, clearBase, ensure, read }) {
  if (!hasBase()) {
    const service = await ensure();
    if (!service || !service.ok) return runtimeUnavailable(service);
  }

  let result = await read();
  if (!needsRuntimeRecovery(result)) return result;

  // The cached base may point at a daemon that died between panel reads.
  // Clear it before ensure so the newly resolved port becomes authoritative.
  clearBase();
  const service = await ensure();
  if (!service || !service.ok) return runtimeUnavailable(service);
  result = await read();
  return result;
}

module.exports = {
  needsRuntimeRecovery,
  readWithRuntimeRecovery,
};
