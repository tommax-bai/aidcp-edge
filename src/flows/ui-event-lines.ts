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

function line(obj: Record<string, unknown>): string {
  return `${UI_EVENT_PREFIX} ${JSON.stringify(obj)}`;
}

/** 界面「编号」展示形态（与云端飞书审批卡「编号」字段同源：发布记录 id）。 */
export function publishCode(recordId: number): string {
  return `#${recordId}`;
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
  return lines;
}
