import type {
  InteractionSyncBatchPayload,
  InteractionSyncMessage,
  InteractionSyncRequestPayload,
  InteractionSyncThread,
} from '../comm/protocol.js';
import type { WechatChannelsApiClient } from './api-client.js';
import type { WechatRuntimeStateStore } from './state-store.js';
import { assertCursorProgress, assertMatchingAck, stableBatchId } from './sync-common.js';
import type { WechatComment, WechatPost, WechatSessionMaterial } from './types.js';

export interface CommentSynchronizerOptions {
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

export class WechatCommentSynchronizer {
  private readonly now: () => number;
  private readonly maxPages: number;

  constructor(private readonly options: CommentSynchronizerOptions) {
    this.now = options.nowImpl ?? Date.now;
    this.maxPages = options.maxPages ?? 100;
  }

  async sync(request: InteractionSyncRequestPayload): Promise<void> {
    if (request.scopeExternalId) {
      await this.syncPost(
        { externalId: request.scopeExternalId, title: null, coverUrl: null, updatedAt: request.requestedAt },
        request.requestId,
      );
      return;
    }
    const postCheckpoint = await this.options.state.getCheckpoint('comment', null);
    let cursor = postCheckpoint.cursor;
    const seen = new Set<string>(cursor ? [cursor] : []);
    for (let pageNo = 0; pageNo < this.maxPages; pageNo++) {
      const page = await this.options.api.listPosts(this.options.getSession(), cursor);
      assertCursorProgress({ endpoint: 'postList', cursorBefore: cursor, cursorAfter: page.nextCursor, hasMore: page.hasMore, seen });
      const uniquePosts = dedupeBy(page.items, (post) => post.externalId);
      for (const post of uniquePosts) await this.syncPost(post, request.requestId);
      await this.options.state.commitCheckpoint('comment', null, {
        cursor: page.nextCursor,
        batchId: postCheckpoint.batchId,
        updatedAt: this.now(),
      });
      cursor = page.nextCursor;
      if (!page.hasMore) return;
    }
    throw new Error('comment post pagination exceeded the bounded page limit');
  }

  private async syncPost(post: WechatPost, requestId: string | null): Promise<void> {
    const checkpoint = await this.options.state.getCheckpoint('comment', post.externalId);
    let cursor = checkpoint.cursor;
    const seen = new Set<string>(cursor ? [cursor] : []);
    for (let pageNo = 0; pageNo < this.maxPages; pageNo++) {
      const page = await this.options.api.listComments(this.options.getSession(), post.externalId, cursor);
      assertCursorProgress({ endpoint: 'commentList', cursorBefore: cursor, cursorAfter: page.nextCursor, hasMore: page.hasMore, seen });
      const flattened = flattenComments(page.items);
      const comments = dedupeBy(flattened, (comment) => comment.externalId);
      const threads = buildThreads(post, comments);
      const ownIdentityExternalId = this.options.getOwnIdentityExternalId();
      const messages = comments.map((comment) => commentToMessage(comment, ownIdentityExternalId));
      const partial = {
        requestId,
        envKey: this.options.envKey,
        accountId: this.options.accountId,
        platform: 'wechat_channels' as const,
        channel: 'comment' as const,
        scopeExternalId: post.externalId,
        cursorBefore: cursor,
        cursorAfter: page.nextCursor,
        hasMore: page.hasMore,
        threads,
        messages,
      };
      const batch: InteractionSyncBatchPayload = {
        batchId: stableBatchId(partial),
        ...partial,
        observedAt: this.now(),
      };
      const ack = await this.options.publishBatch(batch);
      assertMatchingAck(batch, ack);
      await this.options.state.commitCheckpoint('comment', post.externalId, {
        cursor: page.nextCursor,
        batchId: batch.batchId,
        updatedAt: this.now(),
      });
      for (const thread of threads) {
        await this.options.state.putThreadSource('comment', thread.externalThreadId, post.externalId);
      }
      cursor = page.nextCursor;
      if (!page.hasMore) return;
    }
    throw new Error('comment pagination exceeded the bounded page limit');
  }
}

function flattenComments(comments: readonly WechatComment[]): WechatComment[] {
  const out: WechatComment[] = [];
  const visit = (comment: WechatComment, inheritedRoot: string | null, inheritedParent: string | null): void => {
    const normalized: WechatComment = {
      ...comment,
      rootExternalId: comment.rootExternalId ?? inheritedRoot ?? comment.externalId,
      parentExternalId: comment.parentExternalId ?? inheritedParent,
      replies: [],
    };
    out.push(normalized);
    for (const reply of comment.replies) visit(reply, normalized.rootExternalId, normalized.externalId);
  };
  for (const comment of comments) visit(comment, comment.externalId, null);
  return out;
}

function buildThreads(post: WechatPost, comments: readonly WechatComment[]): InteractionSyncThread[] {
  const roots = new Map<string, WechatComment>();
  for (const comment of comments) {
    const rootId = comment.rootExternalId ?? comment.externalId;
    const current = roots.get(rootId);
    if (!current || comment.externalId === rootId) roots.set(rootId, comment);
  }
  return [...roots.entries()].map(([externalThreadId, root]) => ({
    externalThreadId,
    sourceExternalId: post.externalId,
    sourceTitle: post.title,
    sourceCoverUrl: post.coverUrl,
    participant: root.participant,
    updatedAt: Math.max(post.updatedAt, root.createdAt),
  }));
}

function commentToMessage(comment: WechatComment, ownIdentityExternalId: string | null): InteractionSyncMessage {
  return {
    externalThreadId: comment.rootExternalId ?? comment.externalId,
    externalMessageId: comment.externalId,
    direction:
      ownIdentityExternalId && comment.participant?.externalId === ownIdentityExternalId
        ? 'outbound'
        : 'inbound',
    externalParentId: comment.parentExternalId,
    externalRootId: comment.rootExternalId ?? comment.externalId,
    messageType: 'text',
    contentText: comment.contentText,
    attachmentMeta: null,
    lifecycle: comment.lifecycle,
    platformCreatedAt: comment.createdAt,
    rawMetaSanitized: comment.likeCount === null ? {} : { likeCount: comment.likeCount },
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
