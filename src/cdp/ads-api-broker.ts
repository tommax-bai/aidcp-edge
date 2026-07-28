export type AdsPowerApiVersion = 'v1' | 'v2';
export type AdsPowerApiMethod = 'GET' | 'POST';

export interface AdsPowerApiOperation {
  version: AdsPowerApiVersion;
  method: AdsPowerApiMethod;
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface AdsPowerApiResponse {
  status: number;
  body: unknown;
}

export interface AdsPowerApiBroker {
  request(operations: AdsPowerApiOperation[]): Promise<AdsPowerApiResponse[]>;
}

export interface AdsPowerBrokerChannel {
  connected?: boolean;
  send?: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  on(event: 'message' | 'disconnect', listener: (...args: unknown[]) => void): unknown;
  off(event: 'message' | 'disconnect', listener: (...args: unknown[]) => void): unknown;
}

const DEFAULT_BROKER_TIMEOUT_MS = 70_000;
const SAFE_REASON_RE = /^[a-z0-9_]{1,64}$/;
let brokerRequestSequence = 0;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Managed Electron children have no AdsPower API key. They submit a bounded typed batch over the
 * existing private IPC channel; Electron validates/profile-binds it and executes it on the same
 * FIFO as main-process Local API work.
 */
export function createProcessAdsPowerApiBroker(
  channel: AdsPowerBrokerChannel = process as unknown as AdsPowerBrokerChannel,
  timeoutMs = DEFAULT_BROKER_TIMEOUT_MS,
): AdsPowerApiBroker {
  return {
    request(operations) {
      if (!Array.isArray(operations) || operations.length < 1 || operations.length > 2) {
        return Promise.reject(new Error('[aidcp-edge] AdsPower API broker batch size invalid'));
      }
      if (channel.connected === false || typeof channel.send !== 'function') {
        return Promise.reject(new Error('[aidcp-edge] AdsPower API broker unavailable'));
      }

      const requestId = `ads-api-${process.pid}-${++brokerRequestSequence}`;
      return new Promise<AdsPowerApiResponse[]>((resolve, reject) => {
        let settled = false;
        const finish = (error: Error | null, responses?: AdsPowerApiResponse[]) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          channel.off('message', onMessage);
          channel.off('disconnect', onDisconnect);
          if (error) reject(error);
          else resolve(responses ?? []);
        };
        const onDisconnect = () => {
          finish(new Error('[aidcp-edge] AdsPower API broker disconnected'));
        };
        const onMessage = (raw: unknown) => {
          const message = asRecord(raw);
          if (!message || message.type !== 'ads-api.response' || message.requestId !== requestId) return;
          if (message.ok !== true) {
            const reason = typeof message.reason === 'string' && SAFE_REASON_RE.test(message.reason)
              ? message.reason
              : 'broker_rejected';
            finish(new Error(`[aidcp-edge] AdsPower API broker failed: ${reason}`));
            return;
          }
          if (!Array.isArray(message.responses) || message.responses.length !== operations.length) {
            finish(new Error('[aidcp-edge] AdsPower API broker response invalid'));
            return;
          }
          const responses: AdsPowerApiResponse[] = [];
          for (const rawResponse of message.responses) {
            const response = asRecord(rawResponse);
            const status = Number(response?.status);
            if (!response || !Number.isInteger(status) || status < 100 || status > 599) {
              finish(new Error('[aidcp-edge] AdsPower API broker response invalid'));
              return;
            }
            responses.push({ status, body: response.body });
          }
          finish(null, responses);
        };
        const timer = setTimeout(
          () => finish(new Error('[aidcp-edge] AdsPower API broker timed out')),
          Math.max(1, Math.floor(timeoutMs)),
        );
        if (typeof timer.unref === 'function') timer.unref();
        channel.on('message', onMessage);
        channel.on('disconnect', onDisconnect);
        try {
          channel.send?.(
            { type: 'ads-api.request', requestId, operations },
            (error) => {
              if (error) finish(new Error('[aidcp-edge] AdsPower API broker send failed'));
            },
          );
        } catch {
          finish(new Error('[aidcp-edge] AdsPower API broker send failed'));
        }
      });
    },
  };
}
