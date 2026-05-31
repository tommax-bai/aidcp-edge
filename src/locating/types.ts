/**
 * 定位层核心类型定义。
 *
 * 设计要点：
 * - Anchor（语义锚点）= 稳定业务语义 actionId + 当前页面下的语义指纹（role/text/scope/attrs），
 *   不依赖混淆 class。
 * - 抽取/匹配均作用于通用 DOM（既可在浏览器 page.evaluate 中运行，也可在 jsdom 中单测）。
 */

/** 文本匹配方式 */
export type TextMatch = 'exact' | 'contains';

/**
 * 结构作用域：把定位限制在某个上下文容器内（例如"当前笔记卡片"/"当前会话"），
 * 用于消歧——这正是 DOM 优于像素 VL 的关键（包含关系天然区分重复元素）。
 */
export interface ScopeSpec {
  /** 作用域容器的角色（如 article、listitem） */
  role?: string;
  /** 作用域容器需包含的可见文本（如笔记标题），用于锁定具体那一条 */
  containsText?: string;
  /** 作用域容器的稳定属性（data-* 等） */
  attributes?: Record<string, string>;
}

/** 语义锚点：可被缓存、可被自动更新 */
export interface Anchor {
  /** 稳定业务标识，永不变，如 "note.like_button" */
  actionId: string;
  /** 期望的 ARIA role 或由标签推导的角色 */
  role?: string;
  /** 可见文本 / 可访问名 */
  text?: string;
  /** 文本匹配方式，默认 contains */
  textMatch?: TextMatch;
  /** 结构作用域 */
  scope?: ScopeSpec;
  /** 稳定属性（如 data-testid），命中加分 */
  attributes?: Record<string, string>;
  /** 上次成功校验时间戳 */
  lastVerified?: number;
  /** 命中计数 */
  hitCount?: number;
  /** 失败计数 */
  failCount?: number;
}

/** 从 DOM 抽取出的可交互元素描述（喂给匹配器或文本 LLM） */
export interface ElementDescriptor {
  /** 在抽取清单中的序号（喂给 LLM 做"选择题"用） */
  index: number;
  /** 推导出的角色 */
  role: string;
  /** 标签名（小写） */
  tag: string;
  /** 可见文本 / 可访问名（已裁剪长度） */
  text: string;
  /** 选出的稳定属性子集 */
  attributes: Record<string, string>;
  /** 是否可点击/可交互 */
  clickable: boolean;
  /**
   * 结构定位路径（类 XPath），执行层据此重新定位元素并操作。
   * 不含混淆 class，基于标签 + nth-of-type。
   */
  path: string;
  /** 所属作用域容器路径（若在某作用域内） */
  scopePath?: string;
}

/** 匹配状态 */
export type MatchStatus = 'hit' | 'ambiguous' | 'miss';

/** 锚点匹配结果 */
export interface MatchResult {
  status: MatchStatus;
  /** 命中的唯一元素（status==='hit' 时存在） */
  element?: ElementDescriptor;
  /** 候选集合（ambiguous 时含多个；miss 时为空或全部清单） */
  candidates: ElementDescriptor[];
  /** 最佳候选置信度 0..1 */
  confidence: number;
  /** 最佳与次佳的分差（margin），用于判唯一性 */
  margin: number;
  /** 调试说明 */
  reason: string;
}

/** 锚点来源：缓存命中 还是 LLM 新生成 */
export type ResolutionSource = 'cache' | 'llm';

/** 单次操作请求 */
export interface ActionRequest {
  /** 业务锚点标识 */
  actionId: string;
  /** 操作类型 */
  op: 'click' | 'input' | 'scroll';
  /** input 操作的文本值 */
  value?: string;
  /**
   * 给 LLM 的目标自然语言描述（缓存失效时用），
   * 如 "点赞当前这条笔记的点赞按钮"。
   */
  goal: string;
  /** 兜底用的锚点模板（首次无缓存时提供 role/text/scope 线索） */
  anchorHint?: Omit<Anchor, 'actionId'>;
}

/** 操作最终结果 */
export interface ActionResult {
  ok: boolean;
  actionId: string;
  /** 解析来源 */
  source?: ResolutionSource;
  /** 实际操作的元素 */
  element?: ElementDescriptor;
  /** 重试次数 */
  attempts: number;
  /** 结束态 */
  outcome: 'success' | 'escalated' | 'no_target' | 'guard_blocked';
  /** 升级原因（escalated 时） */
  escalation?: EscalationKind;
  reason: string;
}

/** 升级类型 */
export type EscalationKind =
  | 'systemic_revision' // 连续校验失败，疑似系统性改版
  | 'llm_unavailable' // LLM 选择不可用
  | 'guard_unhandled'; // 守卫层无法清除的阻断

/** 守卫层命中（检测到的偶现干扰） */
export interface GuardHit {
  ruleId: string;
  element: ElementDescriptor;
  /** 用于关闭该干扰的 actionId（可选） */
  dismissActionId?: string;
}
