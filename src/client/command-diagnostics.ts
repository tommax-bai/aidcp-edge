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
  'browse.next',
  'browse.scroll',
  'note.open',
  'note.close',
  'search.execute',
  'page.scroll',
  'feed.refresh',
  'pacing.update',
  'interaction.like',
  'interaction.collect',
  'interaction.follow',
  'interaction.comment',
  'interaction.like_comment',
  'group.join',
  'navigation.back',
  'note.browse_images',
  'note.scroll_comments',
  'profile.open',
  'notification.open',
  'notification.browse_comments',
  'notification.browse_likes',
  'notification.browse_follows',
  'notification.back_home',
  'publish.request',
  'publish.command',
  'edge.task.acquire',
  'edge.task.release',
  'captcha.assist.capture',
  'captcha.assist.click',
  'interaction.sync.ack',
  'interaction.sync.request',
  'interaction.reply.send',
  'interaction.auth.reopen',
  'interaction.browser.control',
  'interaction.runtime.controls',
  'interaction.reply.result.ack',
  'interaction.reply.reconcile',
  'interaction.offboard.command',
  'interaction.offboard.ack',
]);

const FIXED_SUMMARIES: Readonly<Record<string, string>> = {
  'session.end': '结束当前浏览会话',
  'browse.next': '浏览下一条内容',
  'browse.scroll': '滚动当前页面',
  'note.close': '关闭当前内容',
  'page.scroll': '滚动当前页面',
  'feed.refresh': '刷新当前信息流',
  'pacing.update': '更新自动化节奏',
  'interaction.like': '点赞当前内容',
  'interaction.collect': '收藏当前内容',
  'interaction.follow': '关注当前作者',
  'interaction.like_comment': '点赞目标评论',
  'navigation.back': '返回上一页面',
  'note.browse_images': '浏览当前内容配图',
  'note.scroll_comments': '滚动当前评论区',
  'profile.open': '打开作者主页',
  'notification.open': '打开通知中心',
  'notification.browse_comments': '读取评论通知',
  'notification.browse_likes': '读取点赞通知',
  'notification.browse_follows': '读取关注通知',
  'notification.back_home': '从通知中心返回',
  'interaction.sync.ack': '确认互动同步批次',
  'interaction.sync.request': '请求同步互动数据',
  'interaction.auth.reopen': '重新建立互动授权',
  'interaction.browser.control': '控制互动浏览器状态',
  'interaction.runtime.controls': '更新互动运行开关',
  'interaction.reply.result.ack': '确认回复结果',
  'interaction.reply.reconcile': '核对待确认回复',
  'interaction.offboard.command': '清理已解绑互动环境',
  'interaction.offboard.ack': '确认互动环境清理',
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
  if (FIXED_SUMMARIES[commandType]) return FIXED_SUMMARIES[commandType];

  if (commandType === 'plan.response') {
    const count = listLength(data.steps);
    return count === undefined ? '顺序执行命令' : `${count} 个顺序步骤`;
  }
  if (commandType === 'note.open') {
    const surface = safeEnum(data.surface, NOTE_SURFACES);
    const purpose = safeEnum(data.purpose, NOTE_PURPOSES);
    return joinParts([
      '打开目标内容',
      surface ? `界面 ${surface}` : undefined,
      purpose ? `目的 ${purpose}` : undefined,
      typeof data.url === 'string' && data.url.length > 0 ? '已提供目标地址' : undefined,
    ]);
  }
  if (commandType === 'search.execute') {
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
  if (commandType === 'interaction.comment') {
    const length = textLength(data.text);
    return joinParts([
      length === undefined ? '提交评论' : `评论正文 ${length} 字`,
      typeof data.groupChatCode === 'string' && data.groupChatCode.length > 0 ? '包含群聊码' : undefined,
    ]);
  }
  if (commandType === 'group.join') {
    return joinParts([
      data.click === true ? '申请加入目标群组' : '观察目标群组',
      typeof data.groupUrl === 'string' && data.groupUrl.length > 0 ? '已提供目标地址' : undefined,
    ]);
  }
  if (commandType === 'publish.request') {
    const title = textLength(data.title);
    const content = textLength(data.content);
    const tags = listLength(data.tags);
    const images = listLength(data.images);
    return joinParts([
      '发布内容请求',
      title === undefined ? undefined : `标题 ${title} 字`,
      content === undefined ? undefined : `正文 ${content} 字`,
      tags === undefined ? undefined : `${tags} 个话题`,
      images === undefined ? undefined : `${images} 张图片`,
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
  if (commandType === 'interaction.reply.send') {
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
