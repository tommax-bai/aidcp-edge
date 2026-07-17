import type {
  InteractionSyncBatchPayload,
  InteractionSyncMessage,
  InteractionSyncRequestPayload,
} from '../comm/protocol.js';
import type { WechatChannelsApiClient } from './api-client.js';
import type { WechatRuntimeStateStore } from './state-store.js';
import { assertCursorProgress, assertMatchingAck, stableBatchId } from './sync-common.js';
import type { WechatDmMessage, WechatDmSession, WechatSessionMaterial } from './types.js';

export interface DmSynchronizerOptions {
  envKey: string;
  accountId: string;
  api: WechatChannelsApiClient;
  state: WechatRuntimeStateStore;
  getSession: () => WechatSessionMaterial;
  publishBatch: (batch: InteractionSyncBatchPayload) => Promise<import('../comm/protocol.js').InteractionSyncAckPayload>;
  nowImpl?: () => number;
  maxPages?: number;
}

export class WechatDmSynchronizer {
  private readonly now: () => number;
  private readonly maxPages: number;

  constructor(private readonly options: DmSynchronizerOptions) {
    this.now = options.nowImpl ?? Date.now;
    this.maxPages = options.maxPages ?? 100;
  }

  async sync(request: InteractionSyncRequestPayload): Promise<void> {
    if (request.scopeExternalId) {
      await this.syncThread(
        { externalId: request.scopeExternalId, participant: null, updatedAt: request.requestedAt },
        request.requestId,
      );
      return;
    }
    const sessionCheckpoint = await this.options.state.getCheckpoint('dm', null);
    let cursor = sessionCheckpoint.cursor;
    const seen = new Set<string>(cursor ? [cursor] : []);
    for (let pageNo = 0; pageNo < this.maxPages; pageNo++) {
      const page = await this.options.api.listDmSessions(this.options.getSession(), cursor);
      assertCursorProgress({ endpoint: 'dmNewMessages', cursorBefore: cursor, cursorAfter: page.nextCursor, hasMore: page.hasMore, seen });
      const sessions = dedupeBy(page.items, (session) => session.externalId);
      for (const session of sessions) await this.syncThread(session, request.requestId);
      const checkpointPartial = {
        requestId: request.requestId,
        envKey: this.options.envKey,
        accountId: this.options.accountId,
        platform: 'wechat_channels' as const,
        channel: 'dm' as const,
        scopeExternalId: null,
        cursorBefore: cursor,
        cursorAfter: page.nextCursor,
        hasMore: page.hasMore,
        threads: [],
        messages: [],
      };
      const checkpointBatch: InteractionSyncBatchPayload = {
        batchId: stableBatchId(checkpointPartial),
        ...checkpointPartial,
        observedAt: this.now(),
      };
      const checkpointAck = await this.options.publishBatch(checkpointBatch);
      assertMatchingAck(checkpointBatch, checkpointAck);
      await this.options.state.commitCheckpoint('dm', null, {
        cursor: page.nextCursor,
        batchId: checkpointBatch.batchId,
        updatedAt: this.now(),
      });
      cursor = page.nextCursor;
      if (!page.hasMore) return;
    }
    throw new Error('dm session pagination exceeded the bounded page limit');
  }

  private async syncThread(session: WechatDmSession, requestId: string | null): Promise<void> {
    const checkpoint = await this.options.state.getCheckpoint('dm', session.externalId);
    let cursor = checkpoint.cursor;
    const seen = new Set<string>(cursor ? [cursor] : []);
    for (let pageNo = 0; pageNo < this.maxPages; pageNo++) {
      const page = await this.options.api.listDmHistory(this.options.getSession(), session.externalId, cursor);
      assertCursorProgress({ endpoint: 'dmHistory', cursorBefore: cursor, cursorAfter: page.nextCursor, hasMore: page.hasMore, seen });
      const messages = dedupeBy(page.items, (message) => message.externalId).map(dmToMessage);
      const partial = {
        requestId,
        envKey: this.options.envKey,
        accountId: this.options.accountId,
        platform: 'wechat_channels' as const,
        channel: 'dm' as const,
        scopeExternalId: session.externalId,
        cursorBefore: cursor,
        cursorAfter: page.nextCursor,
        hasMore: page.hasMore,
        threads: [
          {
            externalThreadId: session.externalId,
            sourceExternalId: null,
            sourceTitle: null,
            sourceCoverUrl: null,
            participant: session.participant,
            updatedAt: session.updatedAt,
          },
        ],
        messages,
      };
      const batch: InteractionSyncBatchPayload = {
        batchId: stableBatchId(partial),
        ...partial,
        observedAt: this.now(),
      };
      const ack = await this.options.publishBatch(batch);
      assertMatchingAck(batch, ack);
      await this.options.state.commitCheckpoint('dm', session.externalId, {
        cursor: page.nextCursor,
        batchId: batch.batchId,
        updatedAt: this.now(),
      });
      cursor = page.nextCursor;
      if (!page.hasMore) return;
    }
    throw new Error('dm history pagination exceeded the bounded page limit');
  }
}

function dmToMessage(message: WechatDmMessage): InteractionSyncMessage {
  return {
    externalThreadId: message.threadExternalId,
    externalMessageId: message.externalId,
    direction: message.direction,
    externalParentId: null,
    externalRootId: null,
    messageType: message.messageType,
    contentText: message.contentText,
    attachmentMeta: message.attachmentMeta,
    lifecycle: message.lifecycle,
    platformCreatedAt: message.createdAt,
    rawMetaSanitized: { platformType: message.platformType.slice(0, 128) },
  };
}

function dedupeBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
