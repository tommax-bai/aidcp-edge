import type { ReadSelfIdentityOptions, SelfIdentityResult } from '../cdp/self-identity.js';
import { NativePageRuntime } from './runtime.js';

const FACEBOOK_ID = /^\d{5,}$/;

/**
 * Facebook identity is page-derived product logic, so the TypeScript runtime only
 * validates the Native receipt and adapts it to the existing handshake contract.
 */
export async function readNativeFacebookIdentity(
  runtime: NativePageRuntime,
  options: ReadSelfIdentityOptions = {},
): Promise<SelfIdentityResult> {
  const timeoutMs = Math.max(1_000, Math.min(30_000, options.hydrateTimeoutMs ?? 12_000));
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
