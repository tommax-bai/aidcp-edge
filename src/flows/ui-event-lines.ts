/**
 * 核心 → 桌面壳的结构化 UI 事件行（`[ui-event] {json}`，change edge-companion-ui 6.4/8.1）。
 *
 * 壳侧解析器：src/electron/ui-events.cjs（结构化行优先于中文日志映射）。本模块只把核心
 * **已确知的事实**构造成单行 JSON，红线：
 *  - 一事一行、绝不含换行（壳按行切分解析）；
 *  - 宁缺毋假：标题未知就不带 title、昵称为空就不发 identity；
 *  - 边缘只发本地无歧义的发布终态：`submit_publish` 成功 → published、在途发布被回收 → failed。
 *    其余审批态（pending/approved/rejected）与云端终判 failed 由云端经 `ui.snapshot` 推送、
 *    经 uiSnapshotToLines 转发——单条指令 ok:false 不在边缘判 failed（云端序列可能对
 *    best-effort 步骤容错继续，边缘抢判会虚报失败）。
 */
import type {
  PublishCommandPayload,
  PublishCommandResultPayload,
  UiSnapshotPayload,
} from '../comm/protocol.js';

export const UI_EVENT_PREFIX = '[ui-event]';
const DAILY_USAGE_ACTIONS = ['view', 'like', 'collect', 'comment', 'follow', 'publish'] as const;
const DAILY_USAGE_WINDOWS = ['session', 'minute', 'hour', 'day'] as const;

function line(obj: Record<string, unknown>): string {
  return `${UI_EVENT_PREFIX} ${JSON.stringify(obj)}`;
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

function sanitizeDailyUsage(input: UiSnapshotPayload['dailyUsage']): Record<string, unknown> | null {
  if (!input || !Number.isFinite(input.asOf)) return null;
  const totals = sanitizeCounts(input.totals as Record<string, unknown> | undefined);
  if (Object.keys(totals).length === 0) return null;
  const quotas = sanitizeCounts(input.quotas as Record<string, unknown> | undefined);
  const dailyUsage: Record<string, unknown> = { asOf: input.asOf, totals };
  if (input.quotaLevel) dailyUsage.quotaLevel = input.quotaLevel;
  if (Object.keys(quotas).length > 0) dailyUsage.quotas = quotas;
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
 *  - submit_publish 成功 → published 行；在途回收 → failed 行；
 *  - 每个 recordId 终态只发一次（published 之后 capture_postId 失败等不再改口）。
 */
export class PublishUiEventTracker {
  private readonly titles = new Map<number, string>();
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
    if (payload.kind === 'submit_publish' && result.ok === true) {
      return this.emitTerminal(payload.recordId, 'published');
    }
    return null;
  }

  /** 在途发布被回收（关停/会话回收）时调用：这是边缘视角确定的终态失败。 */
  onRecycled(payload: PublishCommandPayload): string | null {
    if (this.terminal.has(payload.recordId)) return null;
    return this.emitTerminal(payload.recordId, 'failed');
  }

  private emitTerminal(recordId: number, state: 'published' | 'failed'): string {
    this.terminal.add(recordId);
    const title = this.titles.get(recordId);
    this.titles.delete(recordId);
    const publish: Record<string, unknown> = { state, code: publishCode(recordId) };
    if (title) publish.title = title;
    return line({ kind: 'publish', publish });
  }
}

/**
 * 云端 ui.snapshot → [ui-event] 行（0..3 行）。
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
  const dailyUsage = sanitizeDailyUsage(p.dailyUsage);
  if (dailyUsage) lines.push(line({ kind: 'dailyUsage', dailyUsage }));
  const browserStandby = sanitizeBrowserStandby(p.browserStandby);
  if (browserStandby) lines.push(line({ kind: 'browserStandby', browserStandby }));
  // 已绑人设信号（change persona-wizard-onboarding-fixes）：云端仅在 true 时下发，转成 ui-event 行给壳，
  // 边缘据此把已绑账号徽标翻「已设置」并跳过向导（修「已绑仍显示未设置」bug）。
  if (p.personaBound === true) lines.push(line({ kind: 'personaBound', personaBound: true }));
  return lines;
}
