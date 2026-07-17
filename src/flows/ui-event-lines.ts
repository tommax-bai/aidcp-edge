/**
 * 核心 → 桌面壳的结构化 UI 事件行（`[ui-event] {json}`，change edge-companion-ui 6.4/8.1）。
 *
 * 壳侧解析器：src/electron/ui-events.cjs（结构化行优先于中文日志映射）。本模块只把核心
 * **已确知的事实**构造成单行 JSON，红线：
 *  - 一事一行、绝不含换行（壳按行切分解析）；
 *  - 宁缺毋假：标题未知就不带 title、昵称为空就不发 identity；
 *  - `submit_publish` 成功只表示当前页面已接受提交 → submitted；同页 `capture_postId` 成功才是 published。
 *    已 submitted 的在途被回收不改口为 failed，避免把用户已看到的提交成功倒写成失败。
 *    其余审批态（pending/approved/rejected）与云端终判 failed 由云端经 `ui.snapshot` 推送、
 *    经 uiSnapshotToLines 转发——单条指令 ok:false 不在边缘判 failed（云端序列可能对
 *    best-effort 步骤容错继续，边缘抢判会虚报失败）。
 */
import { UI_DAILY_USAGE_ACTIONS } from '../comm/protocol.js';
import type {
  PublishCommandPayload,
  PublishCommandResultPayload,
  UiPublishPreviewPayload,
  UiSnapshotPayload,
} from '../comm/protocol.js';

export const UI_EVENT_PREFIX = '[ui-event]';
/**
 * 键清单**从协议单一来源派生**（change platform-honest-usage-metrics）。
 *
 * 这里曾是一张手写的六键表，而 sanitizeCounts 拿它**过滤** totals ⇒ 云端新发的键在到达界面之前就被
 * 这道白名单静默吃掉。**这不是假设，是本 change 首跑真机的实际故障**：云端已按平台正确投影（收藏 /
 * 关注真的摘掉了、加群真的发了），屏幕上却只有 4 格、加群怎么也不出现，而全链路零报错、typecheck 全绿、
 * 两侧 protocol.ts 逐字一致、main.cjs 与 renderer 的清单都已加好 —— 唯独这张表没人想起来。
 *
 * 症状就是 CLAUDE.md §2 反复警告的那句「云端发了、界面不显示、没有任何报错」。
 * 改成 import 之后这张表不复存在，也就不会再漂。**别再把它写回本地常量。**
 */
const DAILY_USAGE_ACTIONS = UI_DAILY_USAGE_ACTIONS;
const DAILY_USAGE_WINDOWS = ['session', 'minute', 'hour', 'day'] as const;

function line(obj: Record<string, unknown>): string {
  return `${UI_EVENT_PREFIX} ${JSON.stringify(obj)}`;
}

function sanitizePublishPreview(input: UiSnapshotPayload['publishPreview']): UiPublishPreviewPayload | null {
  if (!input || typeof input !== 'object') return null;
  if (!Number.isInteger(input.recordId) || input.recordId <= 0) return null;
  if (input.kind !== 'rewrite' && input.kind !== 'generated') return null;
  if (typeof input.content !== 'string' || input.content.length > 20_000) return null;
  const images = Array.isArray(input.images)
    ? input.images.filter((url): url is string => typeof url === 'string' && /^(https?:|data:image\/)/i.test(url)).slice(0, 9)
    : [];
  const topics = Array.isArray(input.topics)
    ? input.topics.filter((topic): topic is string => typeof topic === 'string' && topic.trim().length > 0).slice(0, 20)
    : [];
  const audit = input.imageReferenceAudit;
  const imageReferenceAudit = audit && typeof audit === 'object' && ['none', 'used', 'unsupported', 'unavailable', 'skipped'].includes(audit.status)
    ? {
        requestedCount: Number.isFinite(audit.requestedCount) ? Math.max(0, Math.floor(audit.requestedCount)) : 0,
        usableCount: Number.isFinite(audit.usableCount) ? Math.max(0, Math.floor(audit.usableCount)) : 0,
        status: audit.status,
        generatedCount: Number.isFinite(audit.generatedCount) ? Math.max(0, Math.floor(audit.generatedCount)) : 0,
      }
    : undefined;
  return {
    recordId: input.recordId,
    code: typeof input.code === 'string' && input.code ? input.code : `#${input.recordId}`,
    kind: input.kind,
    title: typeof input.title === 'string' ? input.title.slice(0, 200) : '',
    content: input.content,
    topics,
    images,
    contentVersion: Number.isInteger(input.contentVersion) && input.contentVersion >= 0 ? input.contentVersion : 0,
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : Date.now(),
    ...(imageReferenceAudit ? { imageReferenceAudit } : {}),
  };
}

function sanitizeCounts(input: Record<string, unknown> | undefined): Record<string, number> {
  const output: Record<string, number> = {};
  if (!input) return output;
  for (const action of DAILY_USAGE_ACTIONS) {
    const value = input[action];
    if (typeof value === 'number' && Number.isFinite(value)) output[action] = Math.max(0, Math.floor(value));
  }
  return output;
}

function sanitizeOptionalCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

function sanitizeInspirationSummary(input: NonNullable<UiSnapshotPayload['dailyUsage']>['inspirationSummary']): Record<string, number> | null {
  if (!input || typeof input !== 'object') return null;
  const count = sanitizeOptionalCount(input.count);
  if (!count || count <= 0) return null;
  const output: Record<string, number> = { count };
  const sourceLikeCount = sanitizeOptionalCount(input.sourceLikeCount);
  if (sourceLikeCount !== null && sourceLikeCount > 0) output.sourceLikeCount = sourceLikeCount;
  return output;
}

function sanitizeFirstPost(input: NonNullable<UiSnapshotPayload['dailyUsage']>['firstPost']): Record<string, unknown> | null {
  if (!input || (input.state !== 'searching' && input.state !== 'generating')) return null;
  if (!Number.isFinite(input.viewed) || !Number.isFinite(input.startedAt)) return null;
  const output: Record<string, unknown> = {
    state: input.state,
    viewed: Math.max(0, Math.floor(input.viewed)),
    target: 20,
    startedAt: input.startedAt,
  };
  if (typeof input.sourceId === 'string' && input.sourceId) output.sourceId = input.sourceId.slice(0, 256);
  return output;
}

const SLOW_START_STATES = ['off', 'active', 'graduated'] as const;
const SLOW_START_INELIGIBLE_REASONS = ['platform_unsupported', 'platform_unknown', 'globally_disabled'] as const;

/**
 * 慢启动字段白名单（change account-level-slow-start）：**不进名单即静默丢弃、typecheck 完全抓不到**
 * ——症状是「云端发了、界面不显示、没有任何报错」。
 *
 * 逐字段校验：state 必须命中三枚举、day 必须是 1..totalDays 的整数。
 * **任一项不合法 → 整个 slowStart 丢弃**（不渲染 > 渲染半真）：半真的徽章会让运营以为号在被养、
 * 实际没有，而那正是这个功能唯一要回答的问题。
 */
function sanitizeSlowStart(input: NonNullable<UiSnapshotPayload['dailyUsage']>['slowStart']): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null;
  if (!(SLOW_START_STATES as readonly string[]).includes(input.state)) return null;
  if (typeof input.eligible !== 'boolean') return null;
  const totalDays = input.totalDays;
  if (!Number.isInteger(totalDays) || totalDays <= 0) return null;
  const output: Record<string, unknown> = { state: input.state, totalDays, eligible: input.eligible };
  if (input.state === 'active') {
    // active 必须带一个合法天数——缺了它徽章就没法说「第几天」，宁可整块不渲染。
    if (!Number.isInteger(input.day) || (input.day as number) < 1 || (input.day as number) > totalDays) return null;
    output.day = input.day;
    // binding 是「勾了但没压」的唯一信号，缺省即无从判断 → 整块丢弃，绝不默认成 true（那会宣称在压低配额）。
    if (typeof input.binding !== 'boolean') return null;
    output.binding = input.binding;
  }
  if (Number.isFinite(input.since)) output.since = input.since;
  if (input.ineligibleReason !== undefined) {
    if (!(SLOW_START_INELIGIBLE_REASONS as readonly string[]).includes(input.ineligibleReason)) return null;
    output.ineligibleReason = input.ineligibleReason;
  }
  return output;
}

function sanitizeDailyUsage(input: UiSnapshotPayload['dailyUsage']): Record<string, unknown> | null {
  if (!input || !Number.isFinite(input.asOf)) return null;
  const totals = sanitizeCounts(input.totals as Record<string, unknown> | undefined);
  if (Object.keys(totals).length === 0) return null;
  const quotas = sanitizeCounts(input.quotas as Record<string, unknown> | undefined);
  const dailyUsage: Record<string, unknown> = { asOf: input.asOf, totals };
  if (input.quotaLevel) dailyUsage.quotaLevel = input.quotaLevel;
  if (Object.keys(quotas).length > 0) dailyUsage.quotas = quotas;
  const inspirationSummary = sanitizeInspirationSummary(input.inspirationSummary);
  if (inspirationSummary) dailyUsage.inspirationSummary = inspirationSummary;
  const firstPost = sanitizeFirstPost(input.firstPost);
  if (firstPost) dailyUsage.firstPost = firstPost;
  const slowStart = sanitizeSlowStart(input.slowStart);
  if (slowStart) dailyUsage.slowStart = slowStart;
  if (Array.isArray(input.saturated)) {
    dailyUsage.saturated = input.saturated.filter((action) =>
      (DAILY_USAGE_ACTIONS as readonly string[]).includes(action),
    );
  }
  const windows = sanitizeDailyUsageWindows(input.windows as Record<string, unknown> | undefined);
  if (windows) dailyUsage.windows = windows;
  return dailyUsage;
}

function sanitizeDailyUsageWindows(input: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null;
  const output: Record<string, unknown> = {};
  for (const windowName of DAILY_USAGE_WINDOWS) {
    const sanitized = sanitizeDailyUsageWindow(input[windowName]);
    if (sanitized) output[windowName] = sanitized;
  }
  return Object.keys(output).length > 0 ? output : null;
}

function sanitizeDailyUsageWindow(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null;
  const source = input as Record<string, unknown>;
  const totals = sanitizeCounts(source.totals as Record<string, unknown> | undefined);
  if (Object.keys(totals).length === 0) return null;
  const quotas = sanitizeCounts(source.quotas as Record<string, unknown> | undefined);
  const output: Record<string, unknown> = { totals };
  if (typeof source.active === 'boolean') output.active = source.active;
  if (typeof source.startedAt === 'number' && Number.isFinite(source.startedAt)) output.startedAt = source.startedAt;
  if (typeof source.windowMs === 'number' && Number.isFinite(source.windowMs) && source.windowMs > 0) output.windowMs = Math.floor(source.windowMs);
  if (typeof source.expiresAt === 'number' && Number.isFinite(source.expiresAt)) output.expiresAt = source.expiresAt;
  if (typeof source.refreshAt === 'number' && Number.isFinite(source.refreshAt)) output.refreshAt = source.refreshAt;
  if (typeof source.releaseAt === 'number' && Number.isFinite(source.releaseAt)) output.releaseAt = source.releaseAt;
  if (Object.keys(quotas).length > 0) output.quotas = quotas;
  if (Array.isArray(source.saturated)) {
    output.saturated = source.saturated.filter((action) =>
      (DAILY_USAGE_ACTIONS as readonly string[]).includes(action),
    );
  }
  return output;
}

function sanitizeBrowserStandby(input: UiSnapshotPayload['browserStandby']): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.enabled !== 'boolean' || typeof input.eligible !== 'boolean') return null;
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) return null;
  const source = input.source === 'risk' || input.source === 'session' ? input.source : null;
  if (!source) return null;
  const waitMs = finiteNonNegative(input.waitMs);
  const wakeAt = finiteNonNegative(input.wakeAt);
  const generatedAt = finiteNonNegative(input.generatedAt);
  const minWaitMs = finiteNonNegative(input.minWaitMs);
  const warmupMs = finiteNonNegative(input.warmupMs);
  if (waitMs === null || wakeAt === null || generatedAt === null || minWaitMs === null || warmupMs === null) return null;
  return {
    enabled: input.enabled,
    eligible: input.eligible,
    reason,
    waitMs,
    wakeAt,
    generatedAt,
    source,
    minWaitMs,
    warmupMs,
  };
}

function finiteNonNegative(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/** 界面「编号」展示形态（与云端飞书审批卡「编号」字段同源：发布记录 id）。 */
export function publishCode(recordId: number): string {
  return `#${recordId}`;
}

/** 发布稿件指令执行期间，Electron loop chip 切到「写笔记」状态；只更新在场感，不产生活动流。 */
export function writeNoteStageLine(): string {
  return line({
    kind: 'presence',
    type: 'write_note',
    presence: '正在写笔记并准备发布…',
    loopStage: 'write',
  });
}

/**
 * 发布链路 UI 事件跟踪器（边缘本地部分）：
 *  - 从 fill_field(title) 指令里记住每个 recordId 的标题（终态行带上）；
 *  - submit_publish 成功 → submitted 行；同页 capture_postId 成功 → published 行；在途回收 → failed 行；
 *  - submitted 后的 capture 失败或在途回收不改口为 failed；published/failed 终态只发一次。
 */
export class PublishUiEventTracker {
  private readonly titles = new Map<number, string>();
  private readonly submitted = new Set<number>();
  private readonly terminal = new Set<number>();

  /** 每条 publish.command 下发执行前调用：截获标题。 */
  observe(payload: PublishCommandPayload): void {
    if (payload.kind !== 'fill_field') return;
    const params = payload.params as { fieldType?: string; value?: string } | undefined;
    if (params?.fieldType === 'title' && typeof params.value === 'string' && params.value.trim()) {
      this.titles.set(payload.recordId, params.value.trim());
    }
  }

  /** 指令执行结果已知后调用：返回应打印的 [ui-event] 行，无事发生返回 null。 */
  onResult(payload: PublishCommandPayload, result: PublishCommandResultPayload): string | null {
    if (this.terminal.has(payload.recordId)) return null;
    if (payload.kind === 'submit_publish' && result.ok === true && !this.submitted.has(payload.recordId)) {
      this.submitted.add(payload.recordId);
      return this.emitState(payload.recordId, 'submitted');
    }
    if (payload.kind === 'capture_postId' && result.ok === true) {
      return this.emitTerminal(payload.recordId, 'published');
    }
    return null;
  }

  /** 在途发布被回收（关停/会话回收）时调用：这是边缘视角确定的终态失败。 */
  onRecycled(payload: PublishCommandPayload): string | null {
    if (this.terminal.has(payload.recordId)) return null;
    if (this.submitted.has(payload.recordId)) {
      this.terminal.add(payload.recordId);
      this.submitted.delete(payload.recordId);
      this.titles.delete(payload.recordId);
      return null;
    }
    return this.emitTerminal(payload.recordId, 'failed');
  }

  private emitState(recordId: number, state: 'submitted'): string {
    const title = this.titles.get(recordId);
    const publish: Record<string, unknown> = { state, code: publishCode(recordId) };
    if (title) publish.title = title;
    return line({ kind: 'publish', publish });
  }

  private emitTerminal(recordId: number, state: 'published' | 'failed'): string {
    this.terminal.add(recordId);
    this.submitted.delete(recordId);
    const title = this.titles.get(recordId);
    this.titles.delete(recordId);
    const publish: Record<string, unknown> = { state, code: publishCode(recordId) };
    if (title) publish.title = title;
    return line({ kind: 'publish', publish });
  }
}

/**
 * 云端 ui.snapshot → [ui-event] 行（按实际存在字段逐行转发）。
 * 缺失字段即不发对应行；昵称为空绝不发 identity（壳有环境名/尾4位兜底链，空名会顶掉兜底）。
 */
export function uiSnapshotToLines(p: UiSnapshotPayload): string[] {
  const lines: string[] = [];
  const nickname = p.account?.nickname?.trim();
  if (p.account?.id && nickname) {
    lines.push(line({ kind: 'identity', account: { id: p.account.id, name: nickname } }));
  }
  if (p.lastPublish && typeof p.lastPublish.title === 'string' && p.lastPublish.title.trim() && Number.isFinite(p.lastPublish.at)) {
    lines.push(line({ kind: 'lastPublish', lastPublish: { title: p.lastPublish.title.trim(), at: p.lastPublish.at } }));
  }
  if (p.publish?.state) {
    const publish: Record<string, unknown> = { state: p.publish.state };
    if (typeof p.publish.title === 'string' && p.publish.title.trim()) publish.title = p.publish.title.trim();
    if (typeof p.publish.code === 'string' && p.publish.code) publish.code = p.publish.code;
    lines.push(line({ kind: 'publish', publish }));
  }
  const publishPreview = sanitizePublishPreview(p.publishPreview);
  if (publishPreview) lines.push(line({ kind: 'publishPreview', publishPreview }));
  const dailyUsage = sanitizeDailyUsage(p.dailyUsage);
  if (dailyUsage) lines.push(line({ kind: 'dailyUsage', dailyUsage }));
  const browserStandby = sanitizeBrowserStandby(p.browserStandby);
  if (browserStandby) lines.push(line({ kind: 'browserStandby', browserStandby }));
  // 人设绑定态（change persona-bound-tristate）：云端 true / false 都下发，两者都必须转成 ui-event 行给壳。
  // 只转 true 的话，权威的「未绑」在这里就被吞掉，外壳只能靠「等了 6 秒还没收到」去猜——猜错就误弹向导。
  // 字段缺省（未知）不发行：外壳保持「未知」，而未知永不触发弹窗。
  if (typeof p.personaBound === 'boolean') lines.push(line({ kind: 'personaBound', personaBound: p.personaBound }));
  return lines;
}
