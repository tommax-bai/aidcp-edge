import type {
  Envelope,
  InteractionAuthReopenPayload,
  InteractionReplyResultPayload,
  InteractionReplySendPayload,
  InteractionSyncAckPayload,
  InteractionSyncRequestPayload,
} from '../comm/protocol.js';
import { EdgeClient } from '../client/edge-client.js';
import { deriveEdgeId } from '../client/edge-id.js';
import type { InteractionPlatformDriver } from '../platform/driver.js';
import type { InteractionTransport } from '../platform/interaction-connector.js';
import { WechatChannelsApiClient } from './api-client.js';
import { WechatAuthCoordinator } from './auth-session.js';
import { CdpWechatChannelsBrowserSidecar } from './browser-sidecar.js';
import { WechatChannelsConnector } from './connector.js';
import {
  WechatCapabilityState,
  WechatEndpointCircuitBreaker,
  wechatChannelsFeatureFlagsFromEnv,
} from './feature-flags.js';
import { resolveWechatStateRoot } from './local-paths.js';
import {
  validateInteractionAuthStatus,
  validateInteractionReplyResult,
  validateInteractionSyncAck,
  validateInteractionSyncBatch,
} from './protocol-validation.js';
import { WechatChannelsProbeRunner } from './probes/black-box-probe.js';
import { WechatRuntimeStateStore } from './state-store.js';

export async function runWechatChannelsRuntime(driver: InteractionPlatformDriver): Promise<void> {
  if (driver.platform !== 'wechat_channels') throw new Error('interaction runtime only supports wechat_channels');
  const env = process.env;
  const envKey = env.AIDCP_ENV_KEY?.trim() || env.AIDCP_ADS_USER_ID?.trim();
  if (!envKey) throw new Error('[aidcp-edge] wechat_channels requires AIDCP_ENV_KEY or AIDCP_ADS_USER_ID');
  const accountId = env.AIDCP_WECHAT_ACCOUNT_ID?.trim() || env.AIDCP_ACCOUNT_ID?.trim();
  if (!accountId) throw new Error('[aidcp-edge] wechat_channels requires AIDCP_WECHAT_ACCOUNT_ID or AIDCP_ACCOUNT_ID');

  const flags = wechatChannelsFeatureFlagsFromEnv(env);
  const breaker = new WechatEndpointCircuitBreaker();
  const capabilities = new WechatCapabilityState(flags, breaker);
  let connector: WechatChannelsConnector | undefined;
  const api = new WechatChannelsApiClient({
    timeoutMs: envMs(env.AIDCP_WECHAT_API_TIMEOUT_MS, 15_000),
    maxRetries: envInt(env.AIDCP_WECHAT_API_MAX_RETRIES, 2),
    maxResponseBytes: envInt(env.AIDCP_WECHAT_API_MAX_RESPONSE_BYTES, 2 * 1024 * 1024),
    onSchemaChanged: (endpoint) => {
      breaker.open(endpoint);
      connector?.reportStatus();
    },
  });
  const sidecar = new CdpWechatChannelsBrowserSidecar({ env, logImpl: safeLog });
  const probeRunner = new WechatChannelsProbeRunner({
    api,
    flags,
    capabilityState: capabilities,
    commentProbePostId: env.AIDCP_WECHAT_COMMENT_PROBE_POST_ID?.trim(),
    dmProbeThreadId: env.AIDCP_WECHAT_DM_PROBE_THREAD_ID?.trim(),
  });
  const auth = new WechatAuthCoordinator({
    envKey,
    expectedAccountId: accountId,
    api,
    sidecar,
    probeEnabledReads: (session) => probeRunner.probeEnabledReads(session),
    loginTimeoutMs: envMs(env.AIDCP_WECHAT_LOGIN_TIMEOUT_MS, 5 * 60_000),
    pollIntervalMs: envMs(env.AIDCP_WECHAT_LOGIN_POLL_MS, 2_000),
    logImpl: safeLog,
  });

  safeLog(
    `[wechat-channels] feature defaults interaction=${flags.interactionEnabled} commentsRead=${flags.commentsReadEnabled} dmRead=${flags.dmReadEnabled} writes=${flags.writeEnabled && flags.accountWriteEnabled}`,
  );
  const state = new WechatRuntimeStateStore(
    { envKey, accountId, browserProfileId: sidecar.browserProfileId },
    resolveWechatStateRoot(env),
  );

  const edgeId = deriveEdgeId().edgeId;
  let client: EdgeClient;
  const transport: InteractionTransport = {
    publishAuthStatus: (payload) => {
      validateInteractionAuthStatus(payload);
      if (!client.isInteractionInboxNegotiated()) return;
      client.send('interaction.auth.status', payload);
    },
    publishSyncBatch: async (payload) => {
      if (!client.isInteractionInboxNegotiated()) throw new Error('interaction_inbox_v1 is not negotiated');
      validateInteractionSyncBatch(payload);
      const response = await client.request('interaction.sync.batch', payload, envMs(env.AIDCP_WECHAT_SYNC_ACK_TIMEOUT_MS, 30_000));
      if (response.type !== 'interaction.sync.ack') throw new Error(`unexpected sync response type=${response.type}`);
      return validateInteractionSyncAck(response.payload);
    },
  };

  connector = new WechatChannelsConnector({
    envKey,
    accountId,
    api,
    auth,
    state,
    capabilities,
    transport,
    commentSyncIntervalMs: envMs(env.AIDCP_WECHAT_COMMENT_SYNC_INTERVAL_MS, 60_000),
    dmSyncIntervalMs: envMs(env.AIDCP_WECHAT_DM_SYNC_INTERVAL_MS, 30_000),
    logImpl: safeLog,
  });

  client = new EdgeClient({
    url: env.AIDCP_CLOUD_URL ?? 'ws://121.89.85.150:8787',
    edgeId,
    platform: driver.platform,
    app: driver.app,
    capabilities: [...driver.edgeCapabilities],
    accountId,
    accountNickname: auth.getSnapshot().identity?.displayName,
    machineLabel: env.AIDCP_MACHINE_LABEL,
    remoteAddr: env.AIDCP_REMOTE_ADDR,
    runner: {
      run: async (step) => ({
        actionId: step.actionId,
        ok: false,
        outcome: 'escalated',
        attempts: 0,
        reason: 'wechat_channels_api_only_runtime',
      }),
    },
    logger: safeLog,
  });

  client.onInteractionCommand((envelope) => {
    void handleInteractionCommand(client, connector!, envelope);
  });
  client.on('cloud.reconnected', () => {
    void (async () => {
      if (client.isInteractionInboxNegotiated()) await connector!.start();
      else await connector!.stop();
    })();
  });

  await client.connect();
  if (client.isInteractionInboxNegotiated()) {
    await connector.start();
    safeLog('[wechat-channels] interaction_inbox_v1 negotiated; API-only connector is online');
  } else {
    safeLog('[wechat-channels] Cloud did not negotiate interaction_inbox_v1; sync/send remain disabled without retries');
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await connector!.stop();
    await client.closeAndWait();
    await sidecar.close().catch(() => undefined);
  };
  const terminate = (signal: string): void => {
    void shutdown().finally(() => {
      safeLog(`[wechat-channels] runtime stopped by ${signal}`);
      process.exit(0);
    });
  };
  process.once('SIGINT', () => terminate('SIGINT'));
  process.once('SIGTERM', () => terminate('SIGTERM'));
  process.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const type = (message as { type?: unknown }).type;
    if (type === 'lifecycle.close' || type === 'lifecycle.pause') terminate(String(type));
  });

  // Keep WS/status routing online while QR login is pending. Authentication failures are fail-closed states,
  // not process-fatal events; Cloud may later request an explicit reopen on the same environment/profile.
  if (!flags.interactionEnabled || flags.accountKillSwitch) {
    auth.disable();
    connector.reportStatus();
  } else {
    try {
      await auth.initialize();
    } catch (error) {
      safeLog(`[wechat-channels] authentication remains fail-closed: ${safeCode(error)}`);
      connector.reportStatus();
    }
  }
}

async function handleInteractionCommand(
  client: EdgeClient,
  connector: WechatChannelsConnector,
  envelope: Envelope<
    InteractionSyncAckPayload | InteractionSyncRequestPayload | InteractionReplySendPayload | InteractionAuthReopenPayload
  >,
): Promise<void> {
  if (envelope.type === 'interaction.sync.ack') {
    connector.acceptSyncAck(envelope.payload as InteractionSyncAckPayload);
    return;
  }
  if (envelope.type === 'interaction.sync.request') {
    try {
      await connector.sync(envelope.payload as InteractionSyncRequestPayload);
    } catch (error) {
      safeLog(`[wechat-channels] sync request rejected safely: ${safeCode(error)}`);
    }
    return;
  }
  if (envelope.type === 'interaction.reply.send') {
    const command = envelope.payload as InteractionReplySendPayload;
    let result: InteractionReplyResultPayload;
    try {
      result = await connector.send(command);
    } catch (error) {
      safeLog(`[wechat-channels] reply execution stopped safely: ${safeCode(error)}`);
      result = {
        jobId: command.jobId,
        attemptId: command.attemptId,
        idempotencyKey: command.idempotencyKey,
        envKey: command.envKey,
        accountId: command.accountId,
        platform: 'wechat_channels',
        channel: command.channel,
        status: 'ambiguous',
        externalMessageId: null,
        errorCategory: 'internal_error',
        errorCode: 'INTERACTION_INTERNAL_ERROR',
        verification: 'not_verified',
        retryAfterMs: null,
        finishedAt: Date.now(),
      };
    }
    validateInteractionReplyResult(result);
    client.send('interaction.reply.result', result, envelope.id);
    return;
  }
  if (envelope.type === 'interaction.auth.reopen') {
    try {
      await connector.reopenAuth(envelope.payload as InteractionAuthReopenPayload);
    } catch (error) {
      safeLog(`[wechat-channels] auth reopen did not complete: ${safeCode(error)}`);
      connector.reportStatus();
    }
  }
}

function envMs(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function envInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function safeCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return 'INTERACTION_INTERNAL_ERROR';
}

function safeLog(message: string): void {
  console.log(message);
}
