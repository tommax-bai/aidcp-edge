import type {
  Envelope,
  InteractionAuthReopenPayload,
  InteractionBrowserControlPayload,
  InteractionOffboardAckPayload,
  InteractionOffboardCommandPayload,
  InteractionOffboardResultPayload,
  InteractionReplyReconcilePayload,
  InteractionReplyReconcileResultPayload,
  InteractionReplyResultPayload,
  InteractionReplyResultAckPayload,
  InteractionReplySendPayload,
  InteractionRuntimeControlsPayload,
  InteractionSyncAckPayload,
  InteractionSyncRequestPayload,
} from '../comm/protocol.js';
import {
  INTERACTION_OFFBOARDING_CAPABILITY,
  INTERACTION_REPLY_RECOVERY_CAPABILITY,
} from '../comm/protocol.js';
import { EdgeClient } from '../client/edge-client.js';
import { deriveEdgeId } from '../client/edge-id.js';
import type { InteractionPlatformDriver } from '../platform/driver.js';
import type { InteractionTransport } from '../platform/interaction-connector.js';
import { WechatChannelsApiClient } from './api-client.js';
import { WechatAuthCoordinator } from './auth-session.js';
import { CdpWechatChannelsBrowserSidecar } from './browser-sidecar.js';
import { wireWechatIdentityUiEvents } from './companion-ui.js';
import { WechatChannelsConnector } from './connector.js';
import {
  WechatCapabilityState,
  WechatEndpointCircuitBreaker,
  wechatChannelsFeatureFlagsFromEnv,
} from './feature-flags.js';
import { resolveWechatStateRoot } from './local-paths.js';
import {
  validateInteractionAuthStatus,
  validateInteractionOffboardAck,
  validateInteractionOffboardResult,
  validateInteractionReplyReconcileResult,
  validateInteractionReplyResult,
  validateInteractionReplyResultAck,
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
  const logicalAccountId = accountId || envKey;

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
    expectedAccountId: logicalAccountId,
    api,
    sidecar,
    probeEnabledReads: (session) => probeRunner.probeEnabledReads(session),
    loginTimeoutMs: envMs(env.AIDCP_WECHAT_LOGIN_TIMEOUT_MS, 5 * 60_000),
    pollIntervalMs: envMs(env.AIDCP_WECHAT_LOGIN_POLL_MS, 2_000),
    logImpl: safeLog,
  });
  wireWechatIdentityUiEvents(auth, safeLog);

  safeLog(
    `[wechat-channels] local gates interaction=${flags.interactionEnabled} writes=${flags.writeEnabled}; account grants await Cloud snapshot`,
  );
  const state = new WechatRuntimeStateStore(
    { envKey, accountId: logicalAccountId, browserProfileId: sidecar.browserProfileId },
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
    accountId: logicalAccountId,
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
    accountId: logicalAccountId,
    accountNickname: auth.getSnapshot().identity?.displayName,
    machineLabel: env.AIDCP_MACHINE_LABEL,
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

  let replyFlush: Promise<void> | undefined;
  const flushReplyResultOutbox = (): Promise<void> => {
    if (replyFlush) return replyFlush;
    replyFlush = (async () => {
      if (!client.isInteractionInboxNegotiated()) return;
      if (!client.supportsCapability(INTERACTION_REPLY_RECOVERY_CAPABILITY)) {
        for (const result of await state.pendingReplyResults()) {
          try {
            validateInteractionReplyResult(result);
            client.send('interaction.reply.result', result);
          } catch (error) {
            safeLog(`[wechat-channels] reply result remains durable: ${safeCode(error)}`);
            break;
          }
        }
        return;
      }
      while (true) {
        const pending = await state.pendingReplyResults();
        if (pending.length === 0) return;
        for (const result of pending) {
          try {
            validateInteractionReplyResult(result);
            const response = await client.request(
              'interaction.reply.result', result, envMs(env.AIDCP_WECHAT_RESULT_ACK_TIMEOUT_MS, 30_000),
            );
            if (response.type !== 'interaction.reply.result.ack') throw new Error(`unexpected result ack type=${response.type}`);
            const ack = validateInteractionReplyResultAck(response.payload);
            if (!(await state.acknowledgeReplyResult(ack))) return;
          } catch (error) {
            safeLog(`[wechat-channels] reply result remains durable: ${safeCode(error)}`);
            return;
          }
        }
      }
    })().finally(() => { replyFlush = undefined; });
    return replyFlush;
  };

  let offboardFlush: Promise<void> | undefined;
  const offboardFlights = new Map<string, Promise<void>>();
  const flushOffboardResultOutbox = (): Promise<void> => {
    if (offboardFlush) return offboardFlush;
    offboardFlush = (async () => {
      if (!client.supportsCapability(INTERACTION_OFFBOARDING_CAPABILITY)) return;
      while (true) {
        const pending = await state.pendingOffboardResults();
        if (pending.length === 0) return;
        for (const result of pending) {
          try {
            validateInteractionOffboardResult(result);
            const response = await client.request(
              'interaction.offboard.result', result, envMs(env.AIDCP_WECHAT_OFFBOARD_ACK_TIMEOUT_MS, 30_000),
            );
            if (response.type !== 'interaction.offboard.ack') throw new Error(`unexpected offboard ack type=${response.type}`);
            const ack = validateInteractionOffboardAck(response.payload);
            if (!(await state.acknowledgeOffboard(ack))) return;
          } catch (error) {
            safeLog(`[wechat-channels] offboard result remains durable: ${safeCode(error)}`);
            return;
          }
        }
      }
    })().finally(() => { offboardFlush = undefined; });
    return offboardFlush;
  };

  const applyRuntimeControls = async (payload: InteractionRuntimeControlsPayload | undefined): Promise<boolean> => {
    if (!payload || !capabilities.applyRemoteControls(payload, { accountId: logicalAccountId, envKey })) {
      connector!.reportStatus();
      return false;
    }
    const session = auth.getSession();
    if (session) await probeRunner.probeEnabledReads(session).catch(() => false);
    connector!.reportStatus();
    safeLog(`[wechat-channels] applied Cloud runtime controls version=${payload.version}`);
    return true;
  };

  client.onInteractionCommand((envelope) => {
    if (envelope.type === 'interaction.runtime.controls') {
      void applyRuntimeControls(envelope.payload as InteractionRuntimeControlsPayload);
      return;
    }
    void handleInteractionCommand({ client, connector: connector!, state, auth, sidecar,
      flushReplyResultOutbox, flushOffboardResultOutbox, offboardFlights }, envelope as Parameters<typeof handleInteractionCommand>[1]);
  });
  client.on('cloud.disconnected', () => {
    capabilities.resetRemoteControls();
    connector!.reportStatus();
    void connector!.stop();
  });
  client.on('cloud.reconnected', () => {
    void (async () => {
      capabilities.resetRemoteControls();
      await applyRuntimeControls(client.getInteractionRuntimeControls());
      await flushReplyResultOutbox();
      await flushOffboardResultOutbox();
      if (client.isInteractionInboxNegotiated() && !client.hasPendingInteractionOffboard() &&
          !(await state.isOffboarded())) await connector!.start();
      else await connector!.stop();
    })();
  });

  await client.connect();
  capabilities.resetRemoteControls();
  await applyRuntimeControls(client.getInteractionRuntimeControls());
  await flushReplyResultOutbox();
  await flushOffboardResultOutbox();
  if (client.isInteractionInboxNegotiated() && !client.hasPendingInteractionOffboard() &&
      !(await state.isOffboarded())) {
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

export async function handleInteractionCommand(
  deps: {
    client: EdgeClient;
    connector: WechatChannelsConnector;
    state: WechatRuntimeStateStore;
    auth: WechatAuthCoordinator;
    sidecar: CdpWechatChannelsBrowserSidecar;
    flushReplyResultOutbox: () => Promise<void>;
    flushOffboardResultOutbox: () => Promise<void>;
    offboardFlights: Map<string, Promise<void>>;
  },
  envelope: Envelope<
    InteractionSyncAckPayload | InteractionSyncRequestPayload | InteractionReplySendPayload | InteractionAuthReopenPayload |
    InteractionBrowserControlPayload |
    InteractionReplyResultAckPayload | InteractionReplyReconcilePayload | InteractionOffboardCommandPayload |
    InteractionOffboardAckPayload
  >,
): Promise<void> {
  const { client, connector, state, auth, sidecar } = deps;
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
    try {
      result = await state.completeReplyExecution(command.idempotencyKey, command.attemptId, result, Date.now());
    } catch {
      // Normal sender paths have already completed atomically; this only catches an unexpected runtime error path.
    }
    await deps.flushReplyResultOutbox();
    return;
  }
  if (envelope.type === 'interaction.reply.result.ack') {
    await state.acknowledgeReplyResult(envelope.payload as InteractionReplyResultAckPayload);
    return;
  }
  if (envelope.type === 'interaction.reply.reconcile') {
    const request = envelope.payload as InteractionReplyReconcilePayload;
    const attempts: InteractionReplyReconcileResultPayload['attempts'] = [];
    for (const entry of request.attempts) {
      const command = entry.command;
      const outerScopeMatches = request.envKey === command.envKey && request.accountId === command.accountId &&
        request.platform === command.platform;
      const stateResult = outerScopeMatches ? await connector.reconcileReply(command) : 'binding_conflict';
      attempts.push({ jobId: command.jobId, attemptId: command.attemptId,
        idempotencyKey: command.idempotencyKey, state: stateResult, observedAt: Date.now() });
    }
    await deps.flushReplyResultOutbox();
    const result: InteractionReplyReconcileResultPayload = {
      reconcileId: request.reconcileId, envKey: request.envKey, accountId: request.accountId,
      platform: 'wechat_channels', attempts, finishedAt: Date.now(),
    };
    validateInteractionReplyReconcileResult(result);
    client.send('interaction.reply.reconcile.result', result, envelope.id);
    return;
  }
  if (envelope.type === 'interaction.auth.reopen') {
    try {
      await connector.reopenAuth(envelope.payload as InteractionAuthReopenPayload);
    } catch (error) {
      safeLog(`[wechat-channels] auth reopen did not complete: ${safeCode(error)}`);
      connector.reportStatus();
    }
    return;
  }
  if (envelope.type === 'interaction.browser.control') {
    try {
      await connector.controlBrowser(envelope.payload as InteractionBrowserControlPayload);
    } catch (error) {
      safeLog(`[wechat-channels] browser control did not complete: ${safeCode(error)}`);
      connector.reportStatus();
    }
    return;
  }
  if (envelope.type === 'interaction.offboard.command') {
    const command = envelope.payload as InteractionOffboardCommandPayload;
    const active = deps.offboardFlights.get(command.offboardId);
    if (active) {
      await active;
      await deps.flushOffboardResultOutbox();
      return;
    }
    const execution = (async () => {
      const scope = connector.getAuthStatus();
      if (command.envKey !== scope.envKey || command.accountId !== scope.accountId || command.platform !== scope.platform) return;
      const claim = await state.claimOffboard(command, Date.now());
      if (claim.status === 'conflict' || claim.status === 'completed') return;
      let result: InteractionOffboardResultPayload;
      try {
        await connector.stop();
        await auth.clear();
        await sidecar.close();
        result = { offboardId: command.offboardId, envKey: command.envKey, accountId: command.accountId,
          platform: 'wechat_channels', status: 'cleared', errorCode: null, finishedAt: Date.now() };
      } catch {
        result = { offboardId: command.offboardId, envKey: command.envKey, accountId: command.accountId,
          platform: 'wechat_channels', status: 'failed', errorCode: 'INTERACTION_INTERNAL_ERROR', finishedAt: Date.now() };
      }
      await state.completeOffboard(command, result, Date.now());
    })();
    deps.offboardFlights.set(command.offboardId, execution);
    try {
      await execution;
    } finally {
      deps.offboardFlights.delete(command.offboardId);
    }
    await deps.flushOffboardResultOutbox();
    return;
  }
  if (envelope.type === 'interaction.offboard.ack') {
    await state.acknowledgeOffboard(envelope.payload as InteractionOffboardAckPayload);
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
