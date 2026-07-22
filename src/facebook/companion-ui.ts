// Facebook 陪伴客户端 UI 事件（change facebook-write-action-visibility）。
//
// 本模块是叶子：浏览会话与委托处理器**都**要发活动条目，但会话 → 处理器已是既有依赖方向
// （facebook-session.ts 持有 FacebookCommentHandler），处理器反向 import 会话会成环。故把
// 「叙述 + 发射」下沉到两者共同的下游，只依赖协议类型与执行器的观察类型。
//
// 红线（贯穿本模块）：MUST NOT 静默假成功。
//   - 这里**不做任何成功判定**：只叙述执行器已经作出、且已回报云端的判断。
//   - 「资源暂时被占 / 被抢占」= 未开始，不是失败——不产条目、也不叙述成失败。
//   - 「待第三方批准」是一手观察到的真实事实，自成一档，绝不说成已发布 / 已加入，绝不计数。
//   - 主语只用一手数据（现读到的作者 / 正文 / 群名、打进去的评论文本），绝不展示 permalink / 原始 id。

import type { FacebookLikeObservation } from './like-executor.js';

/**
 * 伴随桌面端的结构化事件。云端 `dailyUsage` 才是账号今日总量的权威；这里仅把已确认的
 * Facebook 动作即时投影到当前子进程的活动流、在场状态和本地兜底计数，不能据此猜测成功。
 */
export interface FacebookCompanionUiEvent {
  kind: 'activity' | 'presence';
  type:
    | 'session_start'
    | 'feed'
    | 'reel_view'
    | 'note_open'
    | 'like'
    | 'follow'
    // —— 写动作（change facebook-write-action-visibility）——
    | 'comment'
    | 'comment_pending'
    | 'comment_failed'
    | 'join_group'
    | 'join_pending'
    | 'join_failed'
    | 'search'
    | 'search_failed'
    // —— 阻断可见性（既有 edge-fleet-console 规格要求「需处理」态平台中立）——
    | 'popup'
    | 'popup_cleared';
  sentence?: string;
  presence?: string;
  loopStage?: 'feed' | 'read' | 'interact';
  statsDelta?: { views?: number; likes?: number; comments?: number; follows?: number };
}

/** 核心 → 桌面壳的唯一发射口：壳侧 `ui-events.cjs` 按 `[ui-event]` 前缀解析结构化行。 */
export function emitCompanionUiEvent(log: (msg: string) => void, event: FacebookCompanionUiEvent): void {
  log(`[ui-event] ${JSON.stringify(event)}`);
}

/**
 * 把帖子详情压成活动流可读的一行：仅使用已成功读取的作者和正文，清掉换行并按字符截断。
 * 元数据缺失时宁可退回通用文案，绝不把 permalink / noteId 当作可读标题展示。
 */
export function clipFacebookUiText(value: string | undefined, max: number): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : normalized;
}

/** 「读」的叙述来源：只认已上报的作者与正文/标题。浏览路径与评论路径 MUST 共用本构造器（两路措辞必须一致）。 */
export function facebookReadUiText(payload: {
  content?: string;
  title?: string;
  author?: string;
}): Pick<FacebookCompanionUiEvent, 'sentence' | 'presence'> {
  const excerpt = clipFacebookUiText(payload.content || payload.title, 24);
  const author = clipFacebookUiText(payload.author, 18);
  if (excerpt && author) {
    return {
      sentence: `打开「${excerpt}」 · ${author}`,
      presence: `正在读 ${author} 的「${excerpt}」…`,
    };
  }
  if (excerpt) return { sentence: `打开「${excerpt}」`, presence: `正在认真阅读「${excerpt}」…` };
  if (author) return { sentence: `打开了 ${author} 的一条内容`, presence: `正在认真阅读 ${author} 的一条内容…` };
  return { sentence: '打开了一条内容', presence: '正在认真阅读一条内容…' };
}

/**
 * Reel 切卡已被 reader 证明后才会调用这里；措辞只表达“看到了/浏览了”，不暗示已经看完或深读。
 * 与普通详情阅读一样，只展示一手摘要和作者，缺失时回退人话，绝不泄露 URL / noteId。
 */
export function facebookReelViewUiText(payload: {
  title?: string;
  author?: string;
}): Pick<FacebookCompanionUiEvent, 'sentence'> {
  const excerpt = clipFacebookUiText(payload.title, 24);
  const author = clipFacebookUiText(payload.author, 18);
  if (excerpt && author) return { sentence: `看了「${excerpt}」 · ${author}` };
  if (excerpt) return { sentence: `看了「${excerpt}」` };
  if (author) return { sentence: `看了 ${author} 的一个 Reel` };
  return { sentence: '看了一个 Reel' };
}

/**
 * 点赞摘要只认执行器从实际被作用帖子现读的见证，绝不拿上一条阅读记录或命令 noteId 猜目标。
 * Facebook 帖子通常没有独立标题，因此与“读”保持同一口径：正文开头即活动流里的稿件摘要。
 */
export function facebookLikeUiText(
  observation: FacebookLikeObservation | undefined,
): Pick<FacebookCompanionUiEvent, 'sentence' | 'presence'> {
  const excerpt = clipFacebookUiText(observation?.textPreviewHead, 24);
  const author = clipFacebookUiText(observation?.author, 18);
  if (excerpt && author) {
    return {
      sentence: `赞了「${excerpt}」 · ${author}`,
      presence: `刚赞了 ${author} 的「${excerpt}」`,
    };
  }
  if (excerpt) return { sentence: `赞了「${excerpt}」`, presence: `刚赞了「${excerpt}」` };
  if (author) return { sentence: `赞了 ${author} 的一条内容`, presence: `刚赞了 ${author} 的一条内容` };
  return { sentence: '点了个赞', presence: '刚点了个赞' };
}

/**
 * 「未开始 / 已作废」的原因集——**拒绝集，绝不改成白名单**。
 *
 * 这些不是一次失败：资源暂时被占、被独占任务抢占、会话正在关闭、kill switch 关着、本平台不支持、
 * 只观察不点。它们 MUST NOT 产条目，也 MUST NOT 被叙述成失败（见 CLAUDE.md：排队是机器行为，
 * 失败判据只能是结构上做不到）。
 *
 * 用拒绝集而非白名单是**有意的**：白名单会让未来新增的失败原因**静默消失**——那正是本 change
 * 要修的病（评论/加群/搜索一直在静默）。未知原因必须默认可见。
 */
const NOT_ATTEMPTED_REASONS = new Set<string>([
  'busy',
  'preempted_by_task',
  'session_closing',
  'browse_disabled',
  'capability_unsupported',
  'observation_only',
]);

/** true = 这次真尝试过（值得叙述其结果）；false = 未开始 / 已作废，不产条目。 */
export function isAttempted(reason?: string): boolean {
  return !reason || !NOT_ATTEMPTED_REASONS.has(reason);
}

/** 失败原因 → 人话（活动流不吐机器码）。未知原因回落通用文案，绝不猜。 */
const REASON_TEXT: Record<string, string> = {
  // 评论 / 搜索（FacebookCommentStepReason）
  permission_gated: '没有权限',
  login_required: '登录已失效',
  blocked_by_consent: '被同意浮层挡住',
  blocked_by_captcha: '遇到人机验证',
  no_candidates: '没有结果',
  not_facebook: '链接不是 Facebook',
  open_failed: '帖子没能打开',
  identity_unknown: '账号身份未确认',
  editor_not_found: '评论框没找到',
  submit_control_not_found: '没找到发布按钮',
  submit_control_disabled: '发布按钮不可用',
  marker_not_accepted: '输入没被编辑器接受',
  verification_ambiguous: '没能确认结果',
  nav_error: '页面导航异常',
  // 加群（FacebookJoinReason）额外项
  no_button: '没找到加入按钮',
  not_ready: '页面没加载出来',
  post_not_confirmed_slow: '点了加入但没能及时确认',
  join_failed: '加入没成功',
};

export function reasonText(reason?: string): string {
  return (reason && REASON_TEXT[reason]) || '没能完成';
}

/**
 * 群名：只用现读到的页面标题，剥掉 Facebook 后缀与通知计数前缀；读不到就回落通用文案。
 * 绝不把 URL / group id 当群名展示（沿用 facebookLikeUiText 已立的规矩：宁可泛化，不可露原始标识）。
 */
export function facebookGroupName(observation?: { title?: string }): string {
  const raw = String(observation?.title ?? '')
    .replace(/^\(\d+\)\s*/, '') // 通知计数前缀，如 "(3) 群名 | Facebook"
    .replace(/\s*[|\-–—]\s*Facebook\s*$/i, '');
  return clipFacebookUiText(raw, 18) || '一个小组';
}
