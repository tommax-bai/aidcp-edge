export interface FacebookTotpCode {
  code: string;
  windowStartMs: number;
  windowEndMs: number;
}

export interface FacebookTotpBroker {
  request(serverEpochMs: number): Promise<FacebookTotpCode>;
}

export interface FacebookTotpBrokerChannel {
  connected?: boolean;
  send?: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  on(event: 'message' | 'disconnect', listener: (...args: unknown[]) => void): unknown;
  off(event: 'message' | 'disconnect', listener: (...args: unknown[]) => void): unknown;
}

const DEFAULT_TOTP_BROKER_TIMEOUT_MS = 35_000;
const SAFE_REASON_RE = /^[a-z0-9_]{1,64}$/;
const TOTP_WINDOW_MS = 30_000;
let totpRequestSequence = 0;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Request one profile-bound Facebook TOTP from Electron main.
 *
 * The child never supplies a profile id. Electron binds the request to the managed child and its
 * current environment, reads the raw AdsPower profile only in main, and projects one short-lived
 * code plus its non-secret validity window back over this correlated private IPC channel.
 */
export function createProcessFacebookTotpBroker(
  channel: FacebookTotpBrokerChannel = process as unknown as FacebookTotpBrokerChannel,
  timeoutMs = DEFAULT_TOTP_BROKER_TIMEOUT_MS,
): FacebookTotpBroker {
  return {
    request(serverEpochMs) {
      if (!Number.isSafeInteger(serverEpochMs) || serverEpochMs <= 0) {
        return Promise.reject(new Error('[aidcp-edge] Facebook TOTP broker request invalid'));
      }
      if (channel.connected === false || typeof channel.send !== 'function') {
        return Promise.reject(new Error('[aidcp-edge] Facebook TOTP broker unavailable'));
      }

      const requestId = `facebook-totp-${process.pid}-${++totpRequestSequence}`;
      return new Promise<FacebookTotpCode>((resolve, reject) => {
        let settled = false;
        const finish = (error: Error | null, result?: FacebookTotpCode) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          channel.off('message', onMessage);
          channel.off('disconnect', onDisconnect);
          if (error) reject(error);
          else if (result) resolve(result);
          else reject(new Error('[aidcp-edge] Facebook TOTP broker response invalid'));
        };
        const onDisconnect = () => {
          finish(new Error('[aidcp-edge] Facebook TOTP broker disconnected'));
        };
        const onMessage = (raw: unknown) => {
          const message = asRecord(raw);
          if (!message || message.type !== 'facebook-totp.response' || message.requestId !== requestId) return;
          if (message.ok !== true) {
            const reason = typeof message.reason === 'string' && SAFE_REASON_RE.test(message.reason)
              ? message.reason
              : 'totp_broker_rejected';
            finish(new Error(`[aidcp-edge] Facebook TOTP broker failed: ${reason}`));
            return;
          }

          const successKeys = new Set([
            'type',
            'requestId',
            'ok',
            'code',
            'windowStartMs',
            'windowEndMs',
          ]);
          if (
            Object.keys(message).length !== successKeys.size
            || Object.keys(message).some((key) => !successKeys.has(key))
          ) {
            finish(new Error('[aidcp-edge] Facebook TOTP broker response invalid'));
            return;
          }
          const code = message.code;
          const windowStartMs = message.windowStartMs;
          const windowEndMs = message.windowEndMs;
          if (
            typeof code !== 'string'
            || !/^\d{6}$/.test(code)
            || typeof windowStartMs !== 'number'
            || typeof windowEndMs !== 'number'
            || !Number.isSafeInteger(windowStartMs)
            || !Number.isSafeInteger(windowEndMs)
            || windowStartMs <= 0
            || windowStartMs % TOTP_WINDOW_MS !== 0
            || windowEndMs !== windowStartMs + TOTP_WINDOW_MS
            || serverEpochMs < windowStartMs
            || serverEpochMs >= windowEndMs
          ) {
            finish(new Error('[aidcp-edge] Facebook TOTP broker response invalid'));
            return;
          }
          finish(null, { code, windowStartMs, windowEndMs });
        };
        const timer = setTimeout(
          () => finish(new Error('[aidcp-edge] Facebook TOTP broker timed out')),
          Math.max(1, Math.floor(timeoutMs)),
        );
        if (typeof timer.unref === 'function') timer.unref();
        channel.on('message', onMessage);
        channel.on('disconnect', onDisconnect);
        try {
          channel.send?.(
            { type: 'facebook-totp.request', requestId, serverEpochMs },
            (error) => {
              if (error) finish(new Error('[aidcp-edge] Facebook TOTP broker send failed'));
            },
          );
        } catch {
          finish(new Error('[aidcp-edge] Facebook TOTP broker send failed'));
        }
      });
    },
  };
}
