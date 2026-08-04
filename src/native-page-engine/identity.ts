import type { ReadSelfIdentityOptions, SelfIdentityResult } from '../cdp/self-identity.js';
import { NativePageRuntime } from './runtime.js';

const FACEBOOK_ID = /^\d{5,}$/;

/**
 * 身份引导的请求预算（change unify-facebook-page-readiness-probe）。
 *
 * 这条命令在「当前不在 facebook.com」时会先导航再等文档就绪，而就绪窗已统一到 30s。
 * 原来的 12s 请求值比内层那一个窗口还短：外层先到点，一次可具名的就绪失败会被改判成
 * 合成超时，而它恰好落在**启动最早**的一步上——最容易被读成「这个环境起不来」。
 * 上限同步抬到准入档，避免调用方传入的值被静默夹回到比内层还短。
 */
const FACEBOOK_IDENTITY_TIMEOUT_MS = 40_000;
const FACEBOOK_IDENTITY_MAX_TIMEOUT_MS = 45_000;

/**
 * Facebook identity is page-derived product logic, so the TypeScript runtime only
 * validates the Native receipt and adapts it to the existing handshake contract.
 */
export async function readNativeFacebookIdentity(
  runtime: NativePageRuntime,
  options: ReadSelfIdentityOptions = {},
): Promise<SelfIdentityResult> {
  const timeoutMs = Math.max(
    1_000,
    Math.min(FACEBOOK_IDENTITY_MAX_TIMEOUT_MS, options.hydrateTimeoutMs ?? FACEBOOK_IDENTITY_TIMEOUT_MS),
  );
  try {
    const execution = await runtime.execute(
      'startup-identity',
      { kind: 'identity_bootstrap', params: {} },
      timeoutMs,
    );
    if (execution.effectPhase !== 'confirmed' || execution.output?.kind !== 'facebook_identity') {
      return { ok: false, reason: execution.reasonCode || 'native facebook identity was not confirmed' };
    }
    const value = execution.output.value as Record<string, unknown>;
    if (value.ok !== true) {
      return {
        ok: false,
        reason: typeof value.reason === 'string' && value.reason
          ? value.reason
          : 'native facebook identity did not find a stable account id',
      };
    }
    const accountId = typeof value.accountId === 'string' ? value.accountId : '';
    if (!FACEBOOK_ID.test(accountId)) {
      return { ok: false, reason: 'native facebook identity returned an invalid account id' };
    }
    const displayName = typeof value.displayName === 'string' && value.displayName.trim()
      ? value.displayName.trim()
      : null;
    return {
      ok: true,
      identity: {
        accountId,
        displayName,
        redId: null,
        source: 'facebook-cookie',
      },
    };
  } catch (error) {
    options.logger?.(`[facebook-identity] Native read failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, reason: 'native facebook identity read failed' };
  }
}
