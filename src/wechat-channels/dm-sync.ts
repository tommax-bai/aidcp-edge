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
  getOwnIdentityExternalId: () => string | null;
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
      const [session] = await this.enrichParticipants([
        { externalId: request.scopeExternalId, participant: null, updatedAt: null },
      ]);
      await this.syncThread(session, request.requestId);
      return;
    }
    const sessionCheckpoint = await this.options.state.getCheckpoint('dm', null);
    let cursor = sessionCheckpoint.cursor;
    const seen = new Set<string>(cursor ? [cursor] : []);
    for (let pageNo = 0; pageNo < this.maxPages; pageNo++) {
      const page = await this.options.api.listDmUpdates(
        this.options.getSession(),
        cursor,
        this.options.getOwnIdentityExternalId(),
      );
      assertCursorProgress({ endpoint: 'dmHistory', cursorBefore: cursor, cursorAfter: page.nextCursor, hasMore: page.hasMore, seen });
      const sessions = await this.enrichParticipants(dedupeBy(page.sessions, (session) => session.externalId));
      for (const session of sessions) {
        const messages = dedupeBy(
          page.messages.filter((message) => message.threadExternalId === session.externalId),
          (message) => message.externalId,
        );
        await this.publishThreadPage(session, messages, request.requestId, cursor, page.nextCursor, page.hasMore);
      }
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
    throw new Error('dm history pagination exceeded the bounded page limit');
  }

  private async enrichParticipants(sessions: WechatDmSession[]): Promise<WechatDmSession[]> {
    const missingIds = sessions
      .filter((session) => !session.participant?.displayName)
      .map((session) => session.externalId);
    if (missingIds.length === 0) return sessions;
    const infoBySession = new Map(
      (await this.options.api.getDmParticipantInfo(this.options.getSession(), missingIds))
        .map((info) => [info.sessionExternalId, info.participant] as const),
    );
    return sessions.map((session) => {
      const participant = infoBySession.get(session.externalId);
      return participant ? { ...session, participant } : session;
    });
  }

  private async syncThread(session: WechatDmSession, requestId: string | null): Promise<void> {
    const checkpoint = await this.options.state.getCheckpoint('dm', session.externalId);
    let cursor = checkpoint.cursor;
    const seen = new Set<string>(cursor ? [cursor] : []);
    for (let pageNo = 0; pageNo < this.maxPages; pageNo++) {
      const page = await this.options.api.listDmHistory(
        this.options.getSession(),
        session.externalId,
        cursor,
        100,
        this.options.getOwnIdentityExternalId(),
      );
      assertCursorProgress({ endpoint: 'dmHistory', cursorBefore: cursor, cursorAfter: page.nextCursor, hasMore: page.hasMore, seen });
      await this.publishThreadPage(
        session,
        dedupeBy(page.items, (message) => message.externalId),
        requestId,
        cursor,
        page.nextCursor,
        page.hasMore,
      );
      cursor = page.nextCursor;
      if (!page.hasMore) return;
    }
    throw new Error('dm history pagination exceeded the bounded page limit');
  }

  private async publishThreadPage(
    session: WechatDmSession,
    messages: WechatDmMessage[],
    requestId: string | null,
    cursorBefore: string | null,
    cursorAfter: string | null,
    hasMore: boolean,
  ): Promise<void> {
    const latestMessageTime = messages.reduce<number | null>(
      (latest, message) => latest === null ? message.createdAt : Math.max(latest, message.createdAt),
      null,
    );
    const threadUpdatedAt = session.updatedAt ?? latestMessageTime;
    const partial = {
      requestId,
      envKey: this.options.envKey,
      accountId: this.options.accountId,
      platform: 'wechat_channels' as const,
      channel: 'dm' as const,
      scopeExternalId: session.externalId,
      cursorBefore,
      cursorAfter,
      hasMore,
      threads: threadUpdatedAt === null ? [] : [{
          externalThreadId: session.externalId,
          sourceExternalId: null,
          sourceTitle: null,
          sourceCoverUrl: null,
          participant: session.participant,
          updatedAt: threadUpdatedAt,
        }],
      messages: messages.map(dmToMessage),
    };
    const batch: InteractionSyncBatchPayload = {
      batchId: stableBatchId(partial),
      ...partial,
      observedAt: this.now(),
    };
    const ack = await this.options.publishBatch(batch);
    assertMatchingAck(batch, ack);
    await this.options.state.commitCheckpoint('dm', session.externalId, {
      cursor: cursorAfter,
      batchId: batch.batchId,
      updatedAt: this.now(),
    });
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
