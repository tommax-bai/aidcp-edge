import type { Envelope, PublishCommandPayload } from '../comm/protocol.js';
import type { NativePageCommand } from './client.js';

/**
 * 云端信封类型 → Native 命令 kind。导出是为了让门禁**从这张表本身派生**，
 * 而不是去源码里做文本匹配——文本匹配会被注释与错误文案喂绿（handoff §8.2 已三次踩到）。
 */
export const nativeCommandKindByEnvelopeType = {
  'plan.response': 'plan_execute', 'session.end': 'session_stop',
  // 词汇批 4：面进命令名；五条 scroll 信封同映 page_scroll，面由 mapper 从信封名解析后以参数下传引擎。
  'xiaohongshu.feed.scroll': 'page_scroll', 'xiaohongshu.search.scroll': 'page_scroll',
  'facebook.feed.scroll': 'page_scroll', 'facebook.search.scroll': 'page_scroll',
  'facebook.reels.scroll': 'page_scroll',
  'xiaohongshu.feed.refresh': 'feed_refresh', 'facebook.feed.refresh': 'feed_refresh',
  'xiaohongshu.search.execute': 'search_execute', 'facebook.search.execute': 'search_execute',
  'xiaohongshu.note.open': 'note_open', 'facebook.note.open': 'note_open',
  'xiaohongshu.note.close': 'note_close', 'facebook.note.close': 'note_close',
  'navigation.back': 'navigation_back', 'xiaohongshu.note.browse_images': 'note_browse_images',
  'xiaohongshu.note.scroll_comments': 'note_scroll_comments', 'xiaohongshu.profile.open': 'profile_open',
  'identity.read_current_page': 'identity_read_current',
  'identity.read_self_profile': 'identity_read_self_profile',
  'xiaohongshu.notification.open': 'notification_open',
  'xiaohongshu.notification.browse_comments': 'notification_browse_comments',
  'xiaohongshu.notification.browse_likes': 'notification_browse_likes',
  'xiaohongshu.notification.browse_follows': 'notification_browse_follows',
  'xiaohongshu.notification.back_home': 'notification_back_home',
  // 词汇批 5：互动信封平台段+对象化；kind 仍 5 个不拆。like 的对象（note/video）由 mapper 从信封名解析下传。
  'xiaohongshu.note.like': 'interaction_like', 'facebook.note.like': 'interaction_like',
  'facebook.video.like': 'interaction_like',
  'xiaohongshu.note.collect': 'interaction_collect',
  'xiaohongshu.user.follow': 'interaction_follow', 'facebook.user.follow': 'interaction_follow',
  'xiaohongshu.note.comment': 'interaction_comment', 'facebook.note.comment': 'interaction_comment',
  'xiaohongshu.comment.like': 'interaction_like_comment',
  'facebook.group.join': 'group_join',
} as const;

/** 五条 scroll 信封名 → 面（引擎参数 `surface` 的唯一来源；协议层不再有 targetSurface 字段）。 */
const scrollSurfaceByEnvelopeType: Readonly<Record<string, 'feed' | 'search' | 'reels'>> = {
  'xiaohongshu.feed.scroll': 'feed',
  'xiaohongshu.search.scroll': 'search',
  'facebook.feed.scroll': 'feed',
  'facebook.search.scroll': 'search',
  'facebook.reels.scroll': 'reels',
};

/** 三条 like 信封名 → 对象（引擎参数 `object` 的唯一来源；词汇批 5「按对象拆、不按位置拆」）。 */
const likeObjectByEnvelopeType: Readonly<Record<string, 'note' | 'video'>> = {
  'xiaohongshu.note.like': 'note',
  'facebook.note.like': 'note',
  'facebook.video.like': 'video',
};

// 动作关联键命名空间（值侧）与协议名刻意脱钩（词汇批 5 定案）：值＝云端角色关联键 = 风控动作名
// （RISK_ACTIONS，kernel 枚举 + DB CHECK 钉死），MUST NOT 随协议改名——多个对象化新名映回同一个值是设计
// （facebook.video.like 与 {p}.note.like 都回 'like'）。互动族 9 键必须有显式表项（测试断言杀 ?? type 回落）。
const actionNames: Readonly<Record<string, string>> = {
  'xiaohongshu.feed.scroll': 'scroll',
  'xiaohongshu.search.scroll': 'scroll',
  'facebook.feed.scroll': 'scroll',
  'facebook.search.scroll': 'scroll',
  'facebook.reels.scroll': 'scroll',
  'xiaohongshu.feed.refresh': 'refresh',
  'facebook.feed.refresh': 'refresh',
  'xiaohongshu.note.like': 'like',
  'facebook.note.like': 'like',
  'facebook.video.like': 'like',
  'xiaohongshu.note.collect': 'collect',
  'xiaohongshu.user.follow': 'follow',
  'facebook.user.follow': 'follow',
  'xiaohongshu.note.comment': 'comment',
  'facebook.note.comment': 'comment',
  'xiaohongshu.comment.like': 'comment_like',
  'xiaohongshu.search.execute': 'search',
  'facebook.search.execute': 'search',
  'xiaohongshu.note.open': 'open_note',
  'facebook.note.open': 'open_note',
  'xiaohongshu.note.close': 'close',
  'facebook.note.close': 'close',
  'xiaohongshu.note.browse_images': 'browse_images',
  'xiaohongshu.note.scroll_comments': 'scroll_comments',
  'navigation.back': 'back',
  'xiaohongshu.profile.open': 'profile_open',
  'identity.read_current_page': 'identity_read_current',
  'identity.read_self_profile': 'identity_read_self_profile',
  'facebook.group.join': 'join_group',
  'xiaohongshu.notification.open': 'open_notifications',
  'xiaohongshu.notification.browse_comments': 'browse_notification_comments',
  'xiaohongshu.notification.browse_likes': 'browse_notification_likes',
  'xiaohongshu.notification.browse_follows': 'browse_notification_follows',
  'xiaohongshu.notification.back_home': 'notification_back_home',
  'pacing.update': 'pacing_update',
  'session.end': 'session.end',
};

export function nativeActionNameForCommand(type: string): string {
  return actionNames[type] ?? type;
}

/**
 * 每个 Native 命令允许透传的参数白名单。**时间指令门禁的转发面事实源**：
 * 出现 `thinkMs` / `dwellMs` 的那些 kind 必须在 `native/page-engine/command-timing.json` 里登记，
 * 并各自有一个可观测的消费点（见 test/native-page-engine/pacing-consumption.test.ts）。
 */
export const nativeAllowedParamsByKind: Record<string, readonly string[]> = {
  plan_execute: ['steps'], session_stop: ['reason'],
  page_scroll: ['reason', 'dwellMs'], feed_refresh: ['reason', 'thinkMs'],
  search_execute: ['keyword', 'container', 'source', 'maxResults', 'sort', 'timeWindow'],
  note_open: ['noteId', 'index', 'reason', 'url', 'surface', 'purpose', 'thinkMs', 'selection', 'container'],
  note_close: ['reason', 'dwellMs'], navigation_back: ['reason', 'targetPage', 'dwellMs'],
  note_browse_images: ['noteId', 'count', 'thinkMs', 'dwellMs'],
  note_scroll_comments: ['noteId', 'count', 'thinkMs', 'dwellMs'],
  profile_open: ['authorId', 'reason', 'thinkMs'],
  identity_read_current: ['captureId'],
  identity_read_self_profile: ['captureId'],
  notification_open: ['thinkMs', 'scrollMax'], notification_browse_comments: ['thinkMs', 'scrollMax'],
  notification_browse_likes: ['thinkMs', 'scrollMax'], notification_browse_follows: ['thinkMs', 'scrollMax'],
  notification_back_home: ['thinkMs', 'scrollMax'],
  interaction_like: ['noteId', 'reason', 'thinkMs'], interaction_collect: ['noteId', 'reason', 'thinkMs'],
  interaction_follow: ['authorId', 'noteId', 'reason', 'thinkMs'],
  interaction_comment: ['noteId', 'text', 'groupChatCode', 'fastReturnToFeed', 'reason', 'thinkMs'],
  interaction_like_comment: ['commentAnchorId', 'noteId', 'reason', 'thinkMs'],
  group_join: ['groupUrl', 'click', 'reason', 'thinkMs'],
};

function project(payload: unknown, allowed: readonly string[]): Record<string, unknown> {
  const source = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  return Object.fromEntries(allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

export function nativeCommandForEnvelope(
  env: Envelope,
  accountId?: string,
): NativePageCommand | undefined {
  const kind = nativeCommandKindByEnvelopeType[env.type as keyof typeof nativeCommandKindByEnvelopeType];
  if (!kind) return undefined;
  const params = project(env.payload, nativeAllowedParamsByKind[kind]);
  if (kind === 'page_scroll') {
    // 面由信封名唯一决定（词汇批 4）；引擎据此路由 feed/search/reels 执行器。
    params.surface = scrollSurfaceByEnvelopeType[env.type] ?? 'feed';
  }
  if (kind === 'interaction_like') {
    // 对象由信封名唯一决定（词汇批 5）；FB 引擎据此路由视频/帖级执行器，现场不符诚实失败。
    params.object = likeObjectByEnvelopeType[env.type] ?? 'note';
  }
  if (kind === 'plan_execute' && Array.isArray(params.steps)) {
    params.steps = params.steps.map((step) => project(step, ['actionId', 'op', 'value']));
  }
  if (kind === 'identity_read_current' || kind === 'identity_read_self_profile') {
    params.accountId = accountId ?? '';
  } else if (kind === 'interaction_comment') {
    params.accountId = accountId ?? '';
  }
  return { kind, params };
}

export function nativePublishCommand(
  payload: PublishCommandPayload,
  media?: { localImagePath?: string; imageIndex?: number },
): NativePageCommand {
  const common = { recordId: payload.recordId, seq: payload.seq };
  switch (payload.kind) {
    case 'navigate_entry': return { kind: 'publish_navigate_entry', params: common };
    case 'select_mode': return {
      kind: 'publish_select_mode',
      params: {
        ...common,
        ...(payload.params.optionKind !== undefined ? { optionKind: payload.params.optionKind } : {}),
        ...(payload.params.optionValue !== undefined ? { optionValue: payload.params.optionValue } : {}),
      },
    };
    case 'upload_image': return { kind: 'publish_upload_image', params: { ...common, path: media?.localImagePath ?? '', imageIndex: media?.imageIndex ?? 0 } };
    case 'set_cover': return { kind: 'publish_set_cover', params: { ...common, imageIndex: media?.imageIndex ?? -1 } };
    case 'fill_field': return { kind: 'publish_fill_field', params: { ...common, fieldType: payload.params.fieldType, value: payload.params.value } };
    case 'add_with_candidate': return { kind: 'publish_add_with_candidate', params: { ...common, candidateKind: payload.params.candidateKind, value: payload.params.value, candidates: payload.params.candidates ?? [] } };
    case 'set_option': return { kind: 'publish_set_option', params: { ...common, optionKind: payload.params.optionKind, optionValue: payload.params.optionValue } };
    case 'set_schedule': return { kind: 'publish_set_schedule', params: { ...common, publishTime: payload.params.publishTime } };
    case 'submit_publish': return { kind: 'publish_submit', params: common };
    case 'capture_postId': return { kind: 'publish_capture_post_id', params: { ...common, scheduledTitle: payload.params.scheduledTitle, scheduledPlatformId: payload.params.scheduledPlatformId } };
    case 'capture_scheduled': return { kind: 'publish_capture_scheduled', params: { ...common, scheduledTitle: payload.params.scheduledTitle, scheduledPlatformId: payload.params.scheduledPlatformId, publishTime: payload.params.publishTime } };
    case 'reconcile_scheduled': return { kind: 'publish_reconcile_scheduled', params: { ...common, scheduledTitle: payload.params.scheduledTitle, scheduledPlatformId: payload.params.scheduledPlatformId, publishTime: payload.params.publishTime } };
  }
}
