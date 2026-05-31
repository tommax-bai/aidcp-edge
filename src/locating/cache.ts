/**
 * 锚点缓存（含反污染回写）。
 *
 * 三种模式：
 * - read-write：运行时读主缓存；LLM 新锚点先进暂存区，连续确认成功 confirmThreshold 次才晋升主缓存。
 * - read-only ：只读主缓存，运行时绝不回写（生产推荐）。新锚点只能离线/金丝雀晋升。
 * - write-only：get 始终返回空（强制每次走 AI），仅用于建库阶段批量写主缓存。
 *
 * 反污染要义：一次 LLM 解析**不**直接覆盖主缓存，避免单次错误被复制成系统性故障。
 */

import type { Anchor } from './types.js';

export type CacheMode = 'read-write' | 'read-only' | 'write-only';

export interface AnchorCacheOptions {
  mode?: CacheMode;
  /** 暂存锚点晋升主缓存所需的连续确认成功次数 */
  confirmThreshold?: number;
  clock?: () => number;
}

interface StagedEntry {
  anchor: Anchor;
  successes: number;
}

export interface PromotionResult {
  promoted: boolean;
  successes: number;
  needed: number;
}

export class AnchorCache {
  private readonly main = new Map<string, Anchor>();
  private readonly staging = new Map<string, StagedEntry>();
  private readonly mode: CacheMode;
  private readonly confirmThreshold: number;
  private readonly clock: () => number;

  constructor(options: AnchorCacheOptions = {}) {
    this.mode = options.mode ?? 'read-write';
    this.confirmThreshold = Math.max(1, options.confirmThreshold ?? 2);
    this.clock = options.clock ?? Date.now;
  }

  getMode(): CacheMode {
    return this.mode;
  }

  /** 读主缓存锚点（write-only 模式强制返回 undefined 以走 AI） */
  get(actionId: string): Anchor | undefined {
    if (this.mode === 'write-only') return undefined;
    const a = this.main.get(actionId);
    return a ? { ...a } : undefined;
  }

  /** 直接写主缓存（建库/离线晋升用；read-only 运行时不应调用） */
  put(anchor: Anchor): void {
    this.main.set(anchor.actionId, {
      ...anchor,
      lastVerified: this.clock(),
      hitCount: anchor.hitCount ?? 0,
      failCount: anchor.failCount ?? 0,
    });
  }

  /** 命中成功：更新主缓存统计 */
  recordHit(actionId: string): void {
    const a = this.main.get(actionId);
    if (a) {
      a.hitCount = (a.hitCount ?? 0) + 1;
      a.failCount = 0;
      a.lastVerified = this.clock();
    }
  }

  /** 命中后校验失败：累计失败计数 */
  recordFailure(actionId: string): void {
    const a = this.main.get(actionId);
    if (a) a.failCount = (a.failCount ?? 0) + 1;
  }

  /**
   * 暂存一个 LLM 新解析出的锚点（反污染：不直接进主缓存）。
   * read-only / write-only 模式下不暂存（不在运行时回写主缓存）。
   * 返回是否进入暂存流程。
   */
  stage(anchor: Anchor): boolean {
    if (this.mode !== 'read-write') return false;
    const prev = this.staging.get(anchor.actionId);
    // 若暂存的锚点与新解析不一致，重置确认计数（说明还不稳定）
    if (prev && !sameAnchor(prev.anchor, anchor)) {
      this.staging.set(anchor.actionId, { anchor: { ...anchor }, successes: 0 });
    } else if (!prev) {
      this.staging.set(anchor.actionId, { anchor: { ...anchor }, successes: 0 });
    }
    return true;
  }

  /**
   * 对暂存锚点确认一次成功；累计达到阈值则晋升为主缓存。
   */
  confirmStaged(actionId: string): PromotionResult {
    const entry = this.staging.get(actionId);
    if (this.mode !== 'read-write' || !entry) {
      return { promoted: false, successes: 0, needed: this.confirmThreshold };
    }
    entry.successes += 1;
    if (entry.successes >= this.confirmThreshold) {
      this.put(entry.anchor);
      this.staging.delete(actionId);
      return { promoted: true, successes: entry.successes, needed: this.confirmThreshold };
    }
    return { promoted: false, successes: entry.successes, needed: this.confirmThreshold };
  }

  /** 暂存锚点校验失败：丢弃，不让其晋升 */
  dropStaged(actionId: string): void {
    this.staging.delete(actionId);
  }

  hasStaged(actionId: string): boolean {
    return this.staging.has(actionId);
  }

  /** 导出主缓存快照（持久化） */
  snapshot(): Anchor[] {
    return Array.from(this.main.values()).map((a) => ({ ...a }));
  }

  /** 载入主缓存快照 */
  load(anchors: Anchor[]): void {
    for (const a of anchors) this.main.set(a.actionId, { ...a });
  }
}

/** 判断两个锚点的定位指纹是否等价（忽略统计字段） */
export function sameAnchor(a: Anchor, b: Anchor): boolean {
  if (a.actionId !== b.actionId) return false;
  if ((a.role ?? '') !== (b.role ?? '')) return false;
  if ((a.text ?? '') !== (b.text ?? '')) return false;
  if ((a.textMatch ?? 'contains') !== (b.textMatch ?? 'contains')) return false;
  if (JSON.stringify(a.attributes ?? {}) !== JSON.stringify(b.attributes ?? {})) return false;
  if (JSON.stringify(a.scope ?? {}) !== JSON.stringify(b.scope ?? {})) return false;
  return true;
}
