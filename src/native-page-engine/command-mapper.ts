import type { Envelope, PublishCommandPayload } from '../comm/protocol.js';
import type { NativePageCommand } from './client.js';

const nativeKinds = {
  'plan.response': 'plan_execute', 'session.end': 'session_stop', 'browse.next': 'browse_next',
  'browse.scroll': 'browse_scroll', 'page.scroll': 'page_scroll', 'feed.refresh': 'feed_refresh',
  'search.execute': 'search_execute', 'note.open': 'note_open', 'note.close': 'note_close',
  'navigation.back': 'navigation_back', 'note.browse_images': 'note_browse_images',
  'note.scroll_comments': 'note_scroll_comments', 'profile.open': 'profile_open',
  'identity.read_current': 'identity_read_current',
  'identity.read_self_profile': 'identity_read_self_profile',
  'notification.open': 'notification_open', 'notification.browse_comments': 'notification_browse_comments',
  'notification.browse_likes': 'notification_browse_likes', 'notification.browse_follows': 'notification_browse_follows',
  'notification.back_home': 'notification_back_home', 'interaction.like': 'interaction_like',
  'interaction.collect': 'interaction_collect', 'interaction.follow': 'interaction_follow',
  'interaction.comment': 'interaction_comment', 'interaction.like_comment': 'interaction_like_comment',
  'group.join': 'group_join',
} as const;

const actionNames: Readonly<Record<string, string>> = {
  'page.scroll': 'scroll',
  'feed.refresh': 'refresh',
  'interaction.like': 'like',
  'interaction.collect': 'collect',
  'interaction.follow': 'follow',
  'interaction.comment': 'comment',
  'interaction.like_comment': 'comment_like',
  'search.execute': 'search',
  'note.open': 'open_note',
  'note.close': 'close',
  'note.browse_images': 'browse_images',
  'note.scroll_comments': 'scroll_comments',
  'navigation.back': 'back',
  'profile.open': 'profile_open',
  'identity.read_current': 'identity_read_current',
  'identity.read_self_profile': 'identity_read_self_profile',
  'group.join': 'join_group',
  'notification.open': 'open_notifications',
  'notification.browse_comments': 'browse_notification_comments',
  'notification.browse_likes': 'browse_notification_likes',
  'notification.browse_follows': 'browse_notification_follows',
  'notification.back_home': 'notification_back_home',
  'pacing.update': 'pacing_update',
  'session.end': 'session.end',
};

export function nativeActionNameForCommand(type: string): string {
  return actionNames[type] ?? type;
}

const allowedByKind: Record<string, readonly string[]> = {
  plan_execute: ['steps'], session_stop: ['reason'], browse_next: ['reason'], browse_scroll: ['reason'],
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
  const kind = nativeKinds[env.type as keyof typeof nativeKinds];
  if (!kind) return undefined;
  const params = project(env.payload, allowedByKind[kind]);
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
