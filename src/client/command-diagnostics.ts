/**
 * Cloud → Edge 主动命令的本地诊断事件。
 *
 * 该模块绝不序列化原始 payload；每个摘要只能读取明确列出的安全枚举、布尔值和计数。
 * 事件只经核心 stdout 进入 Electron 本机内存，不回传 Cloud。
 */

export const COMMAND_DIAGNOSTIC_PREFIX = '[command-diagnostic]';

export type CommandDiagnosticStage = 'received' | 'rejected' | 'dispatched' | 'completed' | 'failed';
export type CommandDiagnosticReason =
  | 'operation_unclassified'
  | 'platform_mismatch'
  | 'capability_not_negotiated'
  | 'extension_not_negotiated'
  | 'payload_invalid'
  | 'handler_unavailable'
  | 'step_failed';

export interface CommandDiagnosticEvent {
  key: string;
  type: string;
  stage: CommandDiagnosticStage;
  summary: string;
  reason?: CommandDiagnosticReason;
}

type EnvelopeLike = { id?: unknown; type?: unknown; payload?: unknown };
type UnknownRecord = Record<string, unknown>;

const ACTIVE_COMMAND_TYPES = new Set([
  'plan.response',
  'session.end',
  'xiaohongshu.note.open',
  'facebook.note.open',
  'xiaohongshu.note.close',
  'facebook.note.close',
  'xiaohongshu.search.execute',
  'facebook.search.execute',
  'xiaohongshu.feed.scroll',
  'xiaohongshu.search.scroll',
  'facebook.feed.scroll',
  'facebook.search.scroll',
  'facebook.reels.scroll',
  'xiaohongshu.feed.refresh',
  'facebook.feed.refresh',
  'pacing.update',
  'xiaohongshu.note.like',
  'facebook.note.like',
  'facebook.video.like',
  'xiaohongshu.note.collect',
  'xiaohongshu.user.follow',
  'facebook.user.follow',
  'xiaohongshu.note.comment',
  'facebook.note.comment',
  'xiaohongshu.comment.like',
  'facebook.group.join',
  'navigation.back',
  'xiaohongshu.note.browse_images',
  'xiaohongshu.note.scroll_comments',
  'xiaohongshu.profile.open',
  'xiaohongshu.notification.open',
  'xiaohongshu.notification.browse_comments',
  'xiaohongshu.notification.browse_likes',
  'xiaohongshu.notification.browse_follows',
  'xiaohongshu.notification.back_home',
  'publish.command',
  'edge.task.acquire',
  'edge.task.release',
  'captcha.assist.capture',
  'captcha.assist.click',
  'wechat_channels.inbox.sync.ack',
  'wechat_channels.inbox.sync.request',
  'wechat_channels.inbox.reply.send',
  'wechat_channels.inbox.auth.reopen',
  'wechat_channels.inbox.browser.control',
  'wechat_channels.inbox.runtime.controls',
  'wechat_channels.inbox.reply.result.ack',
  'wechat_channels.inbox.reply.reconcile',
  'wechat_channels.inbox.offboard.command',
  'wechat_channels.inbox.offboard.ack',
]);

const FIXED_SUMMARIES: Readonly<Record<string, string>> = {
  'session.end': '结束当前浏览会话',
  'xiaohongshu.note.close': '关闭当前内容',
  'facebook.note.close': '关闭当前内容',
  'xiaohongshu.feed.scroll': '滚动当前信息流',
  'xiaohongshu.search.scroll': '滚动搜索结果页',
  'facebook.feed.scroll': '滚动当前信息流',
  'facebook.search.scroll': '滚动搜索结果页',
  'facebook.reels.scroll': '滚动 Reels',
  'xiaohongshu.feed.refresh': '刷新当前信息流',
  'facebook.feed.refresh': '刷新当前信息流',
  'pacing.update': '更新自动化节奏',
  'xiaohongshu.note.like': '点赞当前内容',
  'facebook.note.like': '点赞当前内容',
  'facebook.video.like': '点赞当前视频',
  'xiaohongshu.note.collect': '收藏当前内容',
  'xiaohongshu.user.follow': '关注当前作者',
  'facebook.user.follow': '关注当前作者',
  'xiaohongshu.comment.like': '点赞目标评论',
  'navigation.back': '返回上一页面',
  'xiaohongshu.note.browse_images': '浏览当前内容配图',
  'xiaohongshu.note.scroll_comments': '滚动当前评论区',
  'xiaohongshu.profile.open': '打开作者主页',
  'xiaohongshu.notification.open': '打开通知中心',
  'xiaohongshu.notification.browse_comments': '读取评论通知',
  'xiaohongshu.notification.browse_likes': '读取点赞通知',
  'xiaohongshu.notification.browse_follows': '读取关注通知',
  'xiaohongshu.notification.back_home': '从通知中心返回',
  'wechat_channels.inbox.sync.ack': '确认互动同步批次',
  'wechat_channels.inbox.sync.request': '请求同步互动数据',
  'wechat_channels.inbox.auth.reopen': '重新建立互动授权',
  'wechat_channels.inbox.browser.control': '控制互动浏览器状态',
  'wechat_channels.inbox.runtime.controls': '更新互动运行开关',
  'wechat_channels.inbox.reply.result.ack': '确认回复结果',
  'wechat_channels.inbox.reply.reconcile': '核对待确认回复',
  'wechat_channels.inbox.offboard.command': '清理已解绑互动环境',
  'wechat_channels.inbox.offboard.ack': '确认互动环境清理',
};

const PUBLISH_KINDS = new Set([
  'navigate_entry', 'select_mode', 'upload_image', 'set_cover', 'fill_field', 'add_with_candidate',
  'set_option', 'set_schedule', 'submit_publish', 'capture_postId', 'capture_scheduled', 'reconcile_scheduled',
]);
const EDGE_TASK_KINDS = new Set([
  'browse', 'publish', 'comment_prepare', 'comment_commit', 'notification', 'group_join', 'system_recovery',
]);
const EDGE_TASK_PRIORITIES = new Set(['system_recovery', 'human', 'automatic']);
const RELEASE_OUTCOMES = new Set(['completed', 'failed', 'cancelled']);
const NOTE_SURFACES = new Set(['feed', 'detail']);
const NOTE_PURPOSES = new Set(['read', 'navigate']);
const SEARCH_SOURCES = new Set(['extract_from_liked', 'random_from_interests', 'new_concept', 'manager']);
const CAPTCHA_REASONS = new Set(['initial', 'refresh', 'retry']);
const INTERACTION_CHANNELS = new Set(['comment', 'dm']);
const REELS_ENTRY_SUMMARIES: Readonly<Record<string, string>> = {
  facebook_reels_primary: '进入 Reels 主浏览',
  empty_feed_reels_fallback: '信息流结束，进入 Reels',
};

export function isActiveCommandType(type: unknown): boolean {
  return typeof type === 'string' && ACTIVE_COMMAND_TYPES.has(type);
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function safeType(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const trimmed = value.trim();
  return /^[a-z][a-z0-9._-]{0,63}$/.test(trimmed) ? trimmed : 'unknown';
}

function safeEnum(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  return typeof value === 'string' && allowed.has(value) ? value : undefined;
}

function safeCount(value: unknown, max = 9_999): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(0, Math.floor(value as number)));
}

function textLength(value: unknown): number | undefined {
  return typeof value === 'string' ? Math.min(9_999, value.length) : undefined;
}

function listLength(value: unknown, max = 99): number | undefined {
  return Array.isArray(value) ? Math.min(max, value.length) : undefined;
}

function shortCorrelation(value: unknown): string {
  const input = typeof value === 'string' ? value : String(value ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function joinParts(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join('，').slice(0, 160);
}

/** 只读取逐命令白名单字段；调用方不得在外层追加 payload 内容。 */
export function summarizeCommand(type: unknown, payload: unknown): string {
  const commandType = safeType(type);
  const data = asRecord(payload);
  // 词汇批 4：面进命令名，Reels/恢复语义按类型直判（不再靠 targetSurface 载荷字段）。
  if (commandType === 'facebook.reels.scroll') {
    if (data.reason === 'resume_redrive') return '恢复 Reels 浏览';
    if (typeof data.reason === 'string' && REELS_ENTRY_SUMMARIES[data.reason]) {
      return REELS_ENTRY_SUMMARIES[data.reason];
    }
  }
  if (
    (commandType === 'xiaohongshu.feed.scroll' || commandType === 'facebook.feed.scroll') &&
    data.reason === 'resume_redrive'
  ) {
    return '恢复信息流浏览';
  }
  if (FIXED_SUMMARIES[commandType]) return FIXED_SUMMARIES[commandType];

  if (commandType === 'plan.response') {
    const count = listLength(data.steps);
    return count === undefined ? '顺序执行命令' : `${count} 个顺序步骤`;
  }
  if (commandType === 'xiaohongshu.note.open' || commandType === 'facebook.note.open') {
    const surface = safeEnum(data.surface, NOTE_SURFACES);
    const purpose = safeEnum(data.purpose, NOTE_PURPOSES);
    return joinParts([
      '打开目标内容',
      surface ? `界面 ${surface}` : undefined,
      purpose ? `目的 ${purpose}` : undefined,
      typeof data.url === 'string' && data.url.length > 0 ? '已提供目标地址' : undefined,
    ]);
  }
  if (commandType === 'xiaohongshu.search.execute' || commandType === 'facebook.search.execute') {
    const length = textLength(data.keyword);
    const source = safeEnum(data.source, SEARCH_SOURCES);
    const maxResults = safeCount(data.maxResults, 1_000);
    return joinParts([
      length === undefined ? '执行关键词搜索' : `搜索词 ${length} 字`,
      source ? `来源 ${source}` : undefined,
      maxResults === undefined ? undefined : `最多 ${maxResults} 条`,
      typeof data.container === 'string' && data.container.length > 0 ? '已限定搜索容器' : undefined,
    ]);
  }
  if (commandType === 'xiaohongshu.note.comment' || commandType === 'facebook.note.comment') {
    const length = textLength(data.text);
    return joinParts([
      length === undefined ? '提交评论' : `评论正文 ${length} 字`,
      typeof data.groupChatCode === 'string' && data.groupChatCode.length > 0 ? '包含群聊码' : undefined,
    ]);
  }
  if (commandType === 'facebook.group.join') {
    return joinParts([
      data.click === true ? '申请加入目标群组' : '观察目标群组',
      typeof data.groupUrl === 'string' && data.groupUrl.length > 0 ? '已提供目标地址' : undefined,
    ]);
  }
  if (commandType === 'publish.command') {
    const kind = safeEnum(data.kind, PUBLISH_KINDS);
    const seq = safeCount(data.seq, 9_999);
    return joinParts([
      kind ? `发布步骤 ${kind}` : '发布原子步骤',
      seq === undefined ? undefined : `序号 ${seq}`,
    ]);
  }
  if (commandType === 'edge.task.acquire') {
    const kind = safeEnum(data.kind, EDGE_TASK_KINDS);
    const priority = safeEnum(data.priority, EDGE_TASK_PRIORITIES);
    return joinParts([
      '申请页面写租约',
      kind ? `任务 ${kind}` : undefined,
      priority ? `优先级 ${priority}` : undefined,
    ]);
  }
  if (commandType === 'edge.task.release') {
    const outcome = safeEnum(data.outcome, RELEASE_OUTCOMES);
    return joinParts(['释放页面写租约', outcome ? `结果 ${outcome}` : undefined]);
  }
  if (commandType === 'captcha.assist.capture') {
    const reason = safeEnum(data.reason, CAPTCHA_REASONS);
    return joinParts(['采集验证码协助画面', reason ? `原因 ${reason}` : undefined]);
  }
  if (commandType === 'captcha.assist.click') {
    const points = listLength(data.points);
    const answerLength = textLength(data.text);
    return joinParts([
      '执行验证码人工协助',
      points === undefined ? undefined : `${points} 个点击点`,
      answerLength === undefined ? undefined : `输入 ${answerLength} 字`,
      data.submit === 'enter' ? '包含回车提交' : undefined,
    ]);
  }
  if (commandType === 'wechat_channels.inbox.reply.send') {
    const channel = safeEnum(data.channel, INTERACTION_CHANNELS);
    const content = asRecord(data.content);
    const length = textLength(content.text);
    return joinParts([
      '发送互动回复',
      channel ? `渠道 ${channel}` : undefined,
      length === undefined ? undefined : `回复正文 ${length} 字`,
    ]);
  }
  return '载荷内容未展示';
}

export function commandDiagnosticLine(
  env: EnvelopeLike,
  stage: CommandDiagnosticStage,
  reason?: CommandDiagnosticReason,
): string {
  const type = safeType(env.type);
  const event: CommandDiagnosticEvent = {
    key: shortCorrelation(`${String(env.id ?? '')}:${type}`),
    type,
    stage,
    summary: summarizeCommand(type, env.payload),
    ...(reason ? { reason } : {}),
  };
  return `${COMMAND_DIAGNOSTIC_PREFIX} ${JSON.stringify(event)}`;
}
