import { createHash } from 'node:crypto';
import type {
  InteractionChannel,
  InteractionSyncAckPayload,
  InteractionSyncBatchPayload,
} from '../comm/protocol.js';
import { WechatChannelsError } from './error-classifier.js';

export function stableBatchId(payload: Omit<InteractionSyncBatchPayload, 'batchId' | 'observedAt'>): string {
  // requestId correlates a Cloud trigger but is not part of the replay identity. An ack-lost page
  // must reproduce the same batchId even when the next trigger has a new requestId.
  const digest = createHash('sha256')
    .update(stableJson({ ...payload, requestId: null }), 'utf8')
    .digest('hex');
  return `wc-${payload.channel}-${digest}`;
}

export function assertMatchingAck(batch: InteractionSyncBatchPayload, ack: InteractionSyncAckPayload): void {
  const same =
    ack.batchId === batch.batchId &&
    ack.envKey === batch.envKey &&
    ack.accountId === batch.accountId &&
    ack.platform === batch.platform &&
    ack.channel === batch.channel &&
    ack.scopeExternalId === batch.scopeExternalId;
  if (!same) throw new WechatChannelsError('invalid_scope', 'interaction.sync.ack', 'Sync ack scope did not match the emitted batch', false);
  if (ack.status !== 'accepted' && ack.status !== 'duplicate') {
    throw new WechatChannelsError('platform_rejected', 'interaction.sync.ack', 'Cloud rejected the interaction sync batch', false);
  }
  if (ack.cursorAfter !== batch.cursorAfter) {
    throw new WechatChannelsError('invalid_scope', 'interaction.sync.ack', 'Sync ack cursor did not match the emitted batch', false);
  }
}

export function assertCursorProgress(params: {
  endpoint: string;
  cursorBefore: string | null;
  cursorAfter: string | null;
  hasMore: boolean;
  seen: Set<string>;
}): void {
  if (!params.hasMore) return;
  if (!params.cursorAfter || params.cursorAfter === params.cursorBefore || params.seen.has(params.cursorAfter)) {
    throw new WechatChannelsError('schema_changed', params.endpoint, 'Pagination cursor did not advance', false);
  }
  params.seen.add(params.cursorAfter);
}

export function syncScopeKey(channel: InteractionChannel, scopeExternalId: string | null): string {
  return `${channel}:${scopeExternalId ?? '__global__'}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}
