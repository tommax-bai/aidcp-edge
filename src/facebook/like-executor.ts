/**
 * Facebook 帖级「点赞」原子执行器 + 强制后置校验（浏览闭环 interaction.like 的落地）。
 *
 * 红线（贯穿本文件，MUST NOT 静默假成功）：
 *  - **按命令携带的帖子身份定位，绝不 DOM 序回落**（change facebook-note-scoped-targeting）：命令里的 noteId
 *    派生出规范帖身份 `fb:<postId>`，在页内三段式解析出**恰好一个**目标 article（作用域 → 顶层
 *    非嵌套候选 → 身份匹配）。解析出 0 个回 `no_target`、同层 >1 个回 `ambiguous_target`——**绝不**退化成
 *    「扫整页取 DOM 序第一个反应按钮」（那会在信息流态点错卡）。
 *  - **只点帖级 react 按钮**：`[role=button]` 命中中性反应词（留下心情/Like…），且其**同一动作栏含「发表评论/Comment」
 *    按钮**（帖级独有；评论级 react 同栏只有「回复/Reply」），且动作栏不在嵌套 `[role=article]`（评论）内。
 *  - **in-page element.click()**：FB 的 div[role=button] 是 React 合成事件，坐标 dispatchClick 静默失效
 *    （master 6848632 实证）——本执行器用页面内 `el.click()`，绝不用坐标点击。
 *  - **点击与校验绑定同一张卡**：解析出的 article 打上临时标记 `data-aidcp-target=<runId>`，点击与后置校验
 *    **只看标记节点**；标记节点在校验前消失（FB 重渲染/虚拟化回收）→ `verify_indeterminate`，**不可重试**，
 *    绝不重新解析后再点一次（那会重复点赞或点到别的卡）。
 *  - **后置校验按钮状态真翻转才 ok**：命中「已反应」正向信号（撤销串 / 空文案变反应词）才回 ok；否则诚实
 *    state_unchanged。已赞 → already_liked（不重复点）；找不到 → no_target。
 *  - **先拟人滚到目标可见再动手**：有界轮次、按目标位置增量滚（替代旧的无条件 `scrollIntoView` 瞬移）；
 *    滚不出来 → `target_not_visible`，绝不对「当前恰好居中的那张卡」下手。
 *  - **提交前 fresh 复检验证码**（fail-closed）：命中验证码/未知阻断 → blocked_by_captcha，绝不硬点。
 *  - **点赞计数只走云端 RiskController.record**：本执行器不维护任何边缘并行计数器（design 决策）。
 *  - Shadow：只定位+校验目标、**不点击**，回诚实 `shadow`（executed=false）——云端据此不记账、不扣风控。
 */

import { dispatchClick, evalJson, type BrowseCdp } from '../browse/cdp-util.js';
import type { OverlayKind, OverlayMonitor } from '../browse/overlay-monitor.js';
import { defaultRandom, type RandomFn } from '../humanize/index.js';
import {
  NEUTRAL_LIKE_LABEL_SOURCE,
  COMMENT_LABEL_SOURCE,
  REACTED_WORD_SOURCE,
  UNREACT_LABEL_SOURCE,
} from './cta-labels.js';
import { canonicalPostId, FB_TARGET_HELPERS_JS } from './post-identity.js';
import { scrollFacebookViewport } from './viewport-scroll.js';

export type FacebookLikeReason =
  | 'no_target' // 目标帖解析不出 / 目标卡内无帖级 react 按钮
  | 'ambiguous_target' // 同一作用域内 >1 张卡命中同一身份——诚实拒，绝不猜
  | 'target_not_visible' // 有界拟人滚动后目标仍不可见——绝不对当前居中的卡下手
  | 'already_liked' // 已是已赞态
  | 'state_unchanged' // 点后状态未翻转（未生效）
  | 'verify_indeterminate' // 被点卡在校验前从 DOM 消失——点过了但无法确认，不可重试
  | 'blocked_by_captcha'
  | 'login_required'
  | 'shadow' // shadow 模式：只校验不执行
  | 'nav_error';

export interface FacebookLikeResult {
  ok: boolean;
  reason?: FacebookLikeReason;
  /** 是否真的派发了点击（shadow / 跳过 / 已赞 = false）。 */
  executed: boolean;
  /**
   * 被作用卡的独立见证（change platform-browse-protocol N4）：从**实际被点的 article DOM** 现读，
   * 供云端归账仲裁逐字段比对选中卡。ok（真点）与 shadow（只定位）都会带；解析失败/异常则缺省。
   * `surface` 由作用域根类型现判（dialog/permalink 全页=detail、feed 容器=feed）——会话据此决定是否
   * 把 noteId/observation 挂到回执上：feed 才挂（激活云端仲裁），detail 不挂（逐位等于今天、零回归）。
   */
  observation?: FacebookLikeObservation;
}

/** 点赞独立见证包（N4）：全部页面派生，绝不复制命令 payload。 */
export interface FacebookLikeObservation {
  /** 重新派生的规范帖身份 `fb:<postId>`（作 action.completed.noteId）。 */
  noteId?: string;
  /** 观测到的作用面：'feed'=信息流就地、'detail'=详情/permalink。会话用它 gate 是否上挂见证。 */
  surface: 'feed' | 'detail';
  author?: string;
  textPreviewHead?: string;
  reactionText?: string;
  /** 目标卡在顶层可见卡序中的 index（feed 才有意义）。 */
  articleIndex?: number;
}

export interface FacebookLikeOptions {
  /** 云端命令携带的目标帖 id（FB = 规范化 permalink）。缺省时回落 location.href 派生（老云端兼容）。 */
  noteId?: string;
  /** shadow：只定位+校验目标、不点击。 */
  shadow?: boolean;
}

export interface FacebookLikeExecutorDeps {
  cdp: BrowseCdp;
  /** 旁路弹窗监测体；点击前 fresh 复检登录/验证码（fail-closed）。 */
  overlayMonitor?: OverlayMonitor;
  sleep?: (ms: number) => Promise<void>;
  random?: RandomFn;
  logger?: (msg: string) => void;
}

export interface FacebookLikeExecutorOptions {
  /** 校验轮询上限（毫秒）。 */
  verifyTimeoutMs?: number;
  verifyPollMs?: number;
  /** 点击后首次校验前的沉淀。 */
  settleMs?: number;
  /** 拟人滚动催目标进视口的轮数上限（每轮按目标位置增量滚一次、复读一次位置）。 */
  scrollRounds?: number;
  /** 单轮滚动位移上限（像素，含方向：目标在上方则向上滚）。 */
  maxScrollStepPx?: number;
}

const DEFAULTS: Required<FacebookLikeExecutorOptions> = {
  verifyTimeoutMs: 2_000,
  verifyPollMs: 300,
  settleMs: 300,
  scrollRounds: 6,
  maxScrollStepPx: 900,
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 目标在视口内的可接受带：卡顶落在 [5%, 70%) 视口高度内即视为「已在眼前」。 */
const VIEW_TOP_MIN_RATIO = 0.05;
const VIEW_TOP_MAX_RATIO = 0.7;
/** 期望停位：把卡顶带到视口 20% 处（像人一样把要看的东西放在上三分之一）。 */
const VIEW_TARGET_RATIO = 0.2;
/** 小于此位移不值得滚（避免为几十像素来回蹭）。 */
const SCROLL_DEADZONE_PX = 60;

interface ResolveResult {
  status: 'ok' | 'no_target' | 'ambiguous_target';
  targetId?: string;
}

interface RectResult {
  found: boolean;
  top: number;
  bottom: number;
  viewportH: number;
}

interface LocateResult {
  found: boolean;
  already: boolean;
  label?: string;
  text?: string;
}

interface ClickResult {
  clicked: boolean;
  reason?: 'no_target' | 'already' | 'target_lost';
}

interface VerifyResult {
  tagged: boolean;
  identityMatch: boolean;
  found: boolean;
  reacted: boolean;
  label?: string;
  text?: string;
}

interface PickerLocateResult {
  /** 打开的反应选择器浮层里找到「赞」反应项。 */
  found: boolean;
  /** 「赞」项中心视口坐标（供 CDP 坐标点击；in-page element.click 对浮层项无效——见 commitFeedPicker）。 */
  cx: number;
  cy: number;
  /** 目标卡中性 react 控件中心坐标，作指针移动起点（让路径落在「控件→浮层」走廊，避免 mouseleave 收起）。 */
  fromX: number | null;
  fromY: number | null;
}

interface RawObservation {
  found: boolean;
  surface?: 'feed' | 'detail';
  noteId?: string | null;
  author?: string | null;
  textPreviewHead?: string | null;
  reactionText?: string | null;
  articleIndex?: number;
}

export class FacebookLikeExecutor {
  private readonly cdp: BrowseCdp;
  private readonly overlayMonitor?: OverlayMonitor;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: RandomFn;
  private readonly log: (msg: string) => void;
  private readonly opts: Required<FacebookLikeExecutorOptions>;
  private runSeq = 0;

  constructor(deps: FacebookLikeExecutorDeps, options: FacebookLikeExecutorOptions = {}) {
    this.cdp = deps.cdp;
    this.overlayMonitor = deps.overlayMonitor;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? defaultRandom;
    this.log = deps.logger ?? (() => {});
    this.opts = { ...DEFAULTS, ...options };
  }

  /**
   * 对**命令指定的那张卡**点赞。shadow=true 时只定位+不点、回诚实 shadow。
   * 顺序：身份派生 → 三段式解析并打标 → 拟人滚到可见 → 定位帖级 react 控件（含已赞判定）
   *      → fresh 复检验证码 → [shadow: 不点] / 只对标记节点 element.click() → 只对标记节点后置校验。
   */
  async like(options: FacebookLikeOptions = {}): Promise<FacebookLikeResult> {
    const hasNoteId = typeof options.noteId === 'string' && options.noteId.trim().length > 0;
    const targetId = hasNoteId ? canonicalPostId(options.noteId) : null;
    if (hasNoteId && !targetId) {
      // 命令带了 noteId 但派生不出身份（坏链接）→ 诚实 no_target。绝不「派生不出就点第一张」。
      this.log(`[fb-like] noteId 派生不出规范帖身份（${options.noteId}），no_target`);
      return { ok: false, reason: 'no_target', executed: false };
    }
    const runId = `like-${++this.runSeq}-${Math.floor(this.random() * 1e6)}`;

    let resolved: ResolveResult;
    try {
      resolved = await evalJson<ResolveResult>(this.cdp, buildResolveJs(targetId, runId));
    } catch (err) {
      // CDP/eval 异常 ≠「页面上没有这张卡」——诚实报 nav_error，别让运维把基础设施抖动误读成选卡逻辑问题。
      this.log(`[fb-like] 目标解析失败（CDP/eval 异常）：${(err as Error).message}`);
      return { ok: false, reason: 'nav_error', executed: false };
    }
    if (resolved.status === 'ambiguous_target') {
      this.log('[fb-like] 同一作用域内 >1 张卡命中同一身份 → ambiguous_target（诚实拒，绝不猜）');
      return { ok: false, reason: 'ambiguous_target', executed: false };
    }
    if (resolved.status !== 'ok') {
      this.log(`[fb-like] 页面上解析不到目标卡（targetId=${resolved.targetId ?? ''}），no_target`);
      return { ok: false, reason: 'no_target', executed: false };
    }

    try {
      return await this.likeTagged(targetId, runId, options.shadow === true);
    } finally {
      await this.clearTag(runId);
    }
  }

  /** 目标已解析并打标：滚到可见 → 定位 → 复检 → 点击 → 校验。全程只看标记节点。 */
  private async likeTagged(targetId: string | null, runId: string, shadow: boolean): Promise<FacebookLikeResult> {
    const visible = await this.scrollTargetIntoView(runId);
    if (!visible) {
      this.log('[fb-like] 有界拟人滚动后目标卡仍不可见 → target_not_visible（绝不对当前居中的卡下手）');
      return { ok: false, reason: 'target_not_visible', executed: false };
    }

    let locate: LocateResult;
    try {
      locate = await evalJson<LocateResult>(this.cdp, buildLocateJs(runId));
    } catch (err) {
      this.log(`[fb-like] 定位失败（CDP/eval 异常）：${(err as Error).message}`);
      return { ok: false, reason: 'nav_error', executed: false };
    }
    if (!locate.found) {
      this.log('[fb-like] 目标卡内未找到帖级 react 按钮（含「发表评论」同栏），no_target');
      return { ok: false, reason: 'no_target', executed: false };
    }
    if (locate.already) {
      this.log('[fb-like] 目标帖已是已赞态，already_liked（不重复点）');
      return { ok: false, reason: 'already_liked', executed: false };
    }

    // 点击前 fresh 复检验证码（fail-closed）：命中即放弃，绝不硬点进风控墙。
    const blocked = await this.blockingReason();
    if (blocked) {
      this.log(`[fb-like] 点击前复检到阻断（${blocked}），放弃点击`);
      return { ok: false, reason: blocked, executed: false };
    }

    if (shadow) {
      // Shadow：目标已确认存在但**不执行**——回诚实 shadow，云端据此不记账（无 ⚠ 前缀，不触发风控）。
      // 但仍现读独立见证：shadow 阶段云端就是靠它比对「定位到的卡 == 选中卡」（N4 唯一非同义反复通道）。
      const obs = await this.readObservation(runId);
      this.log(`[fb-like][shadow] 目标存在（label="${locate.label ?? ''}" surface=${obs?.surface ?? '-'}），影子模式不点击，回 shadow`);
      return { ok: false, reason: 'shadow', executed: false, ...(obs ? { observation: obs } : {}) };
    }

    let click: ClickResult;
    try {
      click = await evalJson<ClickResult>(this.cdp, buildClickJs(runId));
    } catch (err) {
      this.log(`[fb-like] 点击失败：${(err as Error).message}`);
      return { ok: false, reason: 'state_unchanged', executed: false };
    }
    if (!click.clicked) {
      if (click.reason === 'already') return { ok: false, reason: 'already_liked', executed: false };
      if (click.reason === 'target_lost') {
        this.log('[fb-like] 点击前标记节点已从 DOM 消失（重渲染）→ no_target（未点击）');
        return { ok: false, reason: 'no_target', executed: false };
      }
      return { ok: false, reason: 'no_target', executed: false };
    }

    // 后置校验：**只读标记节点**，有界复读；命中「已反应」正向信号才 ok；否则诚实 state_unchanged。
    // 【两段兜底（探针 P4）】feed 态单击「留下心情」只**弹反应选择器浮层**、按钮不翻转——此时补第二段
    // （点浮层「赞」项）才真正提交。detail 态单击即翻转、picker 不弹，故 directToggle 路径不触发第二段。
    // 两段只补一次（pickerCommitted 守卫），避免把已提交的赞又点成撤销。
    await this.sleep(this.opts.settleMs);
    const start = Date.now();
    let last: VerifyResult | undefined;
    let pickerCommitted = false;
    while (Date.now() - start < this.opts.verifyTimeoutMs) {
      try {
        last = await evalJson<VerifyResult>(this.cdp, buildVerifyJs(targetId, runId));
        if (last?.tagged === false) {
          this.log('[fb-like] 被点卡在校验前从 DOM 消失 → verify_indeterminate（点过了，不可重试）');
          return { ok: false, reason: 'verify_indeterminate', executed: true };
        }
        if (last?.identityMatch === false) {
          this.log('[fb-like] 标记节点身份已变（被回收复用）→ verify_indeterminate（不可重试）');
          return { ok: false, reason: 'verify_indeterminate', executed: true };
        }
        if (last?.reacted === true) {
          const obs = await this.readObservation(runId);
          this.log(`[fb-like] ✓ 点赞成功（目标卡按钮状态已翻转${pickerCommitted ? '，feed 两段提交' : ''}）`);
          return { ok: true, executed: true, ...(obs ? { observation: obs } : {}) };
        }
        // 未翻转 + 弹了反应选择器浮层 ⇒ 补第二段（feed 两段点赞）。只补一次。
        if (!pickerCommitted) {
          const committed = await this.commitFeedPicker(runId);
          if (committed) {
            pickerCommitted = true;
            await this.sleep(this.opts.settleMs);
            continue;
          }
        }
      } catch {
        /* 下一轮重试 */
      }
      await this.sleep(this.opts.verifyPollMs);
    }
    this.log(`[fb-like] 点击后状态未翻转（label="${last?.label ?? ''}" text="${last?.text ?? ''}"），state_unchanged`);
    return { ok: false, reason: 'state_unchanged', executed: true };
  }

  /**
   * 有界拟人滚动把目标卡带进视口：读标记节点位置 → 按差值增量滚（含向上）→ 复读，直到落进可接受带。
   * 替代旧的无条件 `scrollIntoView({block:'center'})` 瞬移。目标中途消失 / 滚不出 → false（诚实非成功）。
   */
  private async scrollTargetIntoView(runId: string): Promise<boolean> {
    for (let round = 0; round <= this.opts.scrollRounds; round++) {
      let rect: RectResult;
      try {
        rect = await evalJson<RectResult>(this.cdp, buildRectJs(runId));
      } catch (err) {
        this.log(`[fb-like] 读目标位置失败（CDP/eval 异常）：${(err as Error).message}`);
        return false;
      }
      if (!rect.found) return false; // 标记节点消失 → 诚实失败，绝不改点别的卡
      const h = rect.viewportH > 0 ? rect.viewportH : 800;
      if (rect.top >= h * VIEW_TOP_MIN_RATIO && rect.top < h * VIEW_TOP_MAX_RATIO) return true;
      // 卡顶在视口上方但卡身仍覆盖视口上半部（长帖）→ 动作栏可能在下方，仍按目标位置继续滚。
      if (round === this.opts.scrollRounds) break;
      const desired = rect.top - h * VIEW_TARGET_RATIO;
      if (Math.abs(desired) < SCROLL_DEADZONE_PX) return true;
      const step = Math.max(-this.opts.maxScrollStepPx, Math.min(this.opts.maxScrollStepPx, Math.round(desired)));
      await scrollFacebookViewport(this.cdp, {
        distancePx: step,
        random: this.random,
        sleep: this.sleep,
        logger: this.log,
      });
    }
    return false;
  }

  /**
   * feed 两段兜底：探到反应选择器浮层就点其中「赞」项提交（探针 P4）。
   *
   * 【红线：浮层反应项必须走 CDP 坐标点击，绝不 in-page element.click】真机 A/B 实证（本轮，簇82）：
   * 对浮层「赞」项 in-page `el.click()` 返回 `clicked=true` 但**反应不生效**（FB 把纯 'click' 事件当 hover
   * 态忽略、监听的是真实 mousedown/mouseup）；改用 CDP `Input.dispatchMouseEvent` press/release（dispatchClick）
   * 才真提交。这是 FB **逐控件事件机制不一致**的又一例（cta / composer 亦有先例）——浮层态选项一律坐标点击。
   * 且**只在打开的反应浮层 dialog 内**定位「赞」项坐标（scoped，见 buildPickerLocateJs），绝不全文档搜索
   * （feed 每卡 Like 按钮 aria-label 亦「赞」，全文档搜会点错帖）。无浮层 / 找不到 → false（不点，诚实）。
   */
  private async commitFeedPicker(runId: string): Promise<boolean> {
    let loc: PickerLocateResult;
    try {
      loc = await evalJson<PickerLocateResult>(this.cdp, buildPickerLocateJs(runId));
    } catch {
      return false;
    }
    if (loc?.found !== true) return false;
    try {
      const from = typeof loc.fromX === 'number' && typeof loc.fromY === 'number' ? { x: loc.fromX, y: loc.fromY } : undefined;
      // overshoot=false：路径紧贴「控件→浮层」走廊，避免 overshoot 甩出浮层 hover 区致其收起。
      await dispatchClick(this.cdp, loc.cx, loc.cy, { from, overshoot: false, random: this.random, sleep: this.sleep });
    } catch {
      return false;
    }
    this.log(`[fb-like] feed 两段提交：坐标点击反应浮层「赞」项 @(${loc.cx},${loc.cy})`);
    return true;
  }

  /** 现读被作用卡的独立见证（N4）：page-derived postId + surface + author/textHead/reactionText/articleIndex。 */
  private async readObservation(runId: string): Promise<FacebookLikeObservation | undefined> {
    let raw: RawObservation;
    try {
      raw = await evalJson<RawObservation>(this.cdp, buildObservationJs(runId));
    } catch {
      return undefined;
    }
    if (raw?.found !== true) return undefined;
    const obs: FacebookLikeObservation = { surface: raw.surface === 'feed' ? 'feed' : 'detail' };
    if (raw.noteId) obs.noteId = raw.noteId;
    const author = (raw.author ?? '').trim();
    if (author) obs.author = author;
    const head = (raw.textPreviewHead ?? '').trim();
    if (head) obs.textPreviewHead = head;
    if (raw.reactionText) obs.reactionText = raw.reactionText;
    if (typeof raw.articleIndex === 'number' && raw.articleIndex >= 0) obs.articleIndex = raw.articleIndex;
    return obs;
  }

  /** 清理临时标记（best-effort：留下来会污染下一轮解析）。 */
  private async clearTag(runId: string): Promise<void> {
    try {
      await evalJson<{ cleared: boolean }>(this.cdp, buildClearTagJs(runId));
    } catch {
      /* best-effort */
    }
  }

  private async blockingReason(): Promise<'login_required' | 'blocked_by_captcha' | undefined> {
    const monitor = this.overlayMonitor;
    if (!monitor) return undefined;
    let kind: OverlayKind;
    try {
      kind = await monitor.probeNow();
    } catch {
      return 'blocked_by_captcha';
    }
    if (kind === 'login') return 'login_required';
    if (kind === 'captcha' || kind === 'unknown') return 'blocked_by_captcha';
    return undefined;
  }
}

// ─────────────────────────── in-page 解析/定位/点击/校验 IIFE（自包含，返回 JSON.stringify）───────────────────────────

/** 帖级 react 控件识别助手（作用域**始终**是已解析并打标的目标 article）。 */
const REACT_HELPERS = `${FB_TARGET_HELPERS_JS}
  function fbLabel(el){ return String((el&&el.getAttribute&&el.getAttribute('aria-label'))||'').replace(/\\s+/g,' ').trim(); }
  function fbText(el){ return String((el&&el.innerText)||(el&&el.textContent)||'').replace(/\\s+/g,' ').trim(); }
  var NEUTRAL=new RegExp(${JSON.stringify(NEUTRAL_LIKE_LABEL_SOURCE)},'i');
  var COMMENT=new RegExp(${JSON.stringify(COMMENT_LABEL_SOURCE)},'i');
  var REACTED=new RegExp(${JSON.stringify(REACTED_WORD_SOURCE)},'i');
  var UNREACT=new RegExp(${JSON.stringify(UNREACT_LABEL_SOURCE)},'i');
  // 该控件当前反应态：'reacted'（已赞）/ 'neutral'（可点）/ ''（非 react 控件）。
  // 【关键】反应【计数汇总】按钮 aria-label 亦是「赞/Like」但带**数字文案**（如「3,829」）——它不是 toggle
  // （探针 §Action bar item①，DOM 序在 留下心情 toggle 之前）。必须用数字守卫排除（同 feed-reader 的 /\\d/ 守卫），
  // 否则会把它误当「已赞」→ 选它 → 每条已有反应的帖子都误报 already_liked、真 toggle 永不被点（红线：绝不假成功）。
  function reactState(el){ var lab=fbLabel(el), txt=fbText(el); var numeric=/\\d/.test(txt);
    if(UNREACT.test(lab)||UNREACT.test(txt)) return 'reacted';          // 撤销串（最可靠跨语言已赞信号）
    if(numeric && REACTED.test(lab)) return '';                          // 反应计数汇总按钮（数字文案）→ 非 toggle，跳过
    if(NEUTRAL.test(lab)) return (!numeric && REACTED.test(txt)) ? 'reacted' : 'neutral'; // 中性 toggle：空→反应词=已赞
    if(!numeric && REACTED.test(lab)) return 'reacted';                  // aria-label 由中性翻成反应词、文案非数字 → 已赞 toggle
    return ''; }
  /**
   * 帖级判定（结构化）：react 控件必须与「发表评论/Comment」按钮**同一动作栏**（有界上溯 5 层内的共同容器），
   * 且该动作栏**不在嵌套 [role=article]（评论条目）里**——评论级 react 同栏只有「回复」，据此排除。
   */
  function fbSharesActionBarWithComment(btn, article){
    var p=btn;
    for(var d=0; d<5 && p; d++){
      p=p.parentElement;
      if(!p || !article.contains(p)) return false;                      // 上溯已越出目标卡
      if(fbTgtClosestArticle(p)!==article) return false;                // 动作栏落在嵌套评论 article 内
      var cbtns=p.querySelectorAll('[role="button"][aria-label]');
      for(var i=0;i<cbtns.length;i++){
        var c=cbtns[i];
        if(fbTgtClosestArticle(c)!==article) continue;                  // 评论条目里的「回复/评论」按钮不算
        if(COMMENT.test(String(c.getAttribute('aria-label')||''))) return true;
      }
    }
    return false; }
  /** 目标卡内的帖级 react 控件（只在该 article 子树内找，绝不出界）。返回 {el, state}。 */
  function fbPostReactControl(article){
    if(!article||!article.querySelectorAll) return null;
    var btns=article.querySelectorAll('[role="button"][aria-label]');
    for(var i=0;i<btns.length;i++){ var el=btns[i];
      if(!fbTgtVisible(el)) continue;
      if(fbTgtClosestArticle(el)!==article) continue;                   // 嵌套评论 article 里的 react
      var st=reactState(el); if(!st) continue;
      if(!fbSharesActionBarWithComment(el, article)) continue;
      return {el:el, state:st};
    }
    return null; }
  function fbTaggedTarget(run){ return document.querySelector('[data-aidcp-target="'+run+'"]'); }
`;

/** 目标身份注入：命令带 noteId → 用它；不带（老云端）→ 回落 location.href 派生。 */
function targetIdExpr(targetId: string | null): string {
  return targetId ? JSON.stringify(targetId) : 'fbCanonicalPostId(location.href)';
}

/** 三段式解析 + 打标（/*aidcp:resolve*\/ 为测试桩识别锚）。 */
function buildResolveJs(targetId: string | null, runId: string): string {
  return `(function(){/*aidcp:resolve*/${REACT_HELPERS}
  var TARGET=${targetIdExpr(targetId)};
  var stale=document.querySelectorAll('[data-aidcp-target]');
  for(var i=0;i<stale.length;i++){ stale[i].removeAttribute('data-aidcp-target'); }
  var r=fbTgtResolve(TARGET);
  if(!r.el) return JSON.stringify({status:r.status, targetId:TARGET||''});
  r.el.setAttribute('data-aidcp-target', ${JSON.stringify(runId)});
  return JSON.stringify({status:'ok', targetId:TARGET});
})()`;
}

/**
 * 读滚动定位锚的位置（/*aidcp:rect*\/）。**优先用帖级 react 控件的 rect**（而非文章顶）：feed 两段点赞要对
 * 浮层「赞」项走 CDP 坐标点击，浮层贴着 Like 按钮渲染——按钮必须落在可视视口内、浮层才在屏、坐标点击才命中。
 * 长招工帖若只把文章顶滚进视口，按钮/浮层会落在折叠线以下（真机实证 cy≈1372 > innerHeight≈1002 → 坐标点空、
 * state_unchanged）。控件找不到（如尚未渲染出 react 按钮）回落文章 rect。
 */
function buildRectJs(runId: string): string {
  return `(function(){/*aidcp:rect*/${REACT_HELPERS}
  var el=fbTaggedTarget(${JSON.stringify(runId)});
  if(!el) return JSON.stringify({found:false, top:0, bottom:0, viewportH:0});
  var c=fbPostReactControl(el);
  var b=(c&&c.el)?c.el.getBoundingClientRect():el.getBoundingClientRect();
  return JSON.stringify({found:true, top:Math.round(b.top), bottom:Math.round(b.bottom), viewportH:Math.round(window.innerHeight||0)});
})()`;
}

/** 在标记节点内定位帖级 react 控件（/*aidcp:locate*\/）。 */
function buildLocateJs(runId: string): string {
  return `(function(){/*aidcp:locate*/${REACT_HELPERS}
  var el=fbTaggedTarget(${JSON.stringify(runId)});
  if(!el) return JSON.stringify({found:false, already:false});
  var c=fbPostReactControl(el);
  if(!c) return JSON.stringify({found:false, already:false});
  return JSON.stringify({found:true, already:(c.state==='reacted'), label:fbLabel(c.el), text:fbText(c.el)});
})()`;
}

/** 只对标记节点内的控件 element.click()（/*aidcp:click*\/）。 */
function buildClickJs(runId: string): string {
  return `(function(){/*aidcp:click*/${REACT_HELPERS}
  var el=fbTaggedTarget(${JSON.stringify(runId)});
  if(!el) return JSON.stringify({clicked:false, reason:'target_lost'});
  var c=fbPostReactControl(el);
  if(!c) return JSON.stringify({clicked:false, reason:'no_target'});
  if(c.state==='reacted') return JSON.stringify({clicked:false, reason:'already'});
  try{ c.el.click(); }catch(e){ return JSON.stringify({clicked:false, reason:'no_target'}); }
  return JSON.stringify({clicked:true});
})()`;
}

/**
 * 后置校验（/*aidcp:verify*\/）：**只读标记节点**，并重新派生其身份与命令身份比对。
 * 标记节点不在 → tagged:false（verify_indeterminate，不可重试）；身份变了 → identityMatch:false（同样不可重试）。
 * 说明：URL 佐证的单帖态下卡本身派生不出身份（id=null）——此时标记本身即绑定，不判身份不符。
 */
function buildVerifyJs(targetId: string | null, runId: string): string {
  return `(function(){/*aidcp:verify*/${REACT_HELPERS}
  var TARGET=${targetIdExpr(targetId)};
  var el=fbTaggedTarget(${JSON.stringify(runId)});
  if(!el) return JSON.stringify({tagged:false, identityMatch:false, found:false, reacted:false});
  var id=fbTgtArticlePostId(el);
  if(id && TARGET && id!==TARGET) return JSON.stringify({tagged:true, identityMatch:false, found:false, reacted:false});
  var c=fbPostReactControl(el);
  if(!c) return JSON.stringify({tagged:true, identityMatch:true, found:false, reacted:false});
  return JSON.stringify({tagged:true, identityMatch:true, found:true, reacted:(c.state==='reacted'), label:fbLabel(c.el), text:fbText(c.el)});
})()`;
}

/** 清理临时标记（/*aidcp:cleartag*\/）。 */
function buildClearTagJs(runId: string): string {
  return `(function(){/*aidcp:cleartag*/
  var els=document.querySelectorAll('[data-aidcp-target="'+${JSON.stringify(runId)}+'"]');
  for(var i=0;i<els.length;i++){ els[i].removeAttribute('data-aidcp-target'); }
  return JSON.stringify({cleared:true});
})()`;
}

/**
 * 反应选择器浮层里定位「赞」项**坐标**（/*aidcp:picker-commit*\/）。探针 P4：单击「留下心情」后弹此浮层、
 * 按钮不翻转，需二段点其中「赞」项才提交。
 *
 * 【红线一：只在打开的反应浮层 dialog 内找，绝不全文档搜索】feed 里**每张卡的中性 Like 按钮 aria-label 也恰是
 * 「赞」**（真机实证：帖级动作栏首个 `[role=button][aria-label="赞"]`），反应【计数汇总】按钮 aria-label 亦是
 * 「赞」。浮层常渲染在 portal，document 序里排在**所有 feed 卡之后**——若全文档搜 `/^赞$/` 会命中**上方另一
 * 张卡**的 Like 按钮：① 目标浮层永不提交 → verify 恒 `state_unchanged`（「读了从不点赞」的真根因，簇82）；
 * ② 直接点了**别的帖**的赞（点错卡红线）。目标恰为首卡时才碰巧撞对（document 序首个「赞」= 目标自己）。
 * 故只在**可见的反应选择器浮层**（`[role=dialog]` 等、且含 ≥2 个反应项）内部找「赞」项。
 *
 * 【红线二：只返坐标、由调用方走 CDP 坐标点击】浮层反应项监听真实指针事件，in-page element.click 无效（当 hover
 * 态忽略）——见 commitFeedPicker。故这里**不点**，只回「赞」项中心坐标 + 目标控件坐标（作指针移动起点）。
 */
function buildPickerLocateJs(runId: string): string {
  return `(function(){/*aidcp:picker-commit*/${REACT_HELPERS}
  var LIKEITEM=/(?:^|[:：]\\s*)(赞|讚|Like|Me gusta)$/i;
  var REACTIONISH=/(赞|讚|Like|大爱|Love|哈哈|Haha|哇|Wow|加油|Care|怒|Angry|悲伤|Sad|Me gusta)/i;
  var dls=document.querySelectorAll('[role="dialog"],[aria-label*="反应"],[aria-label*="Reaction"],[aria-label*="心情"]');
  var cx=0, cy=0, found=false;
  for(var j=0;j<dls.length && !found;j++){ var d=dls[j]; if(!fbTgtVisible(d)) continue;
    var items=d.querySelectorAll('[role="button"][aria-label]');
    var reactionCount=0;
    for(var k=0;k<items.length;k++){ if(REACTIONISH.test(String(items[k].getAttribute('aria-label')||''))) reactionCount++; }
    if(reactionCount<2) continue;                                    // 不是反应选择器浮层（含 <2 反应项）→ 跳过（如反应人数查看 toolbar）
    for(var i=0;i<items.length;i++){ var el=items[i]; if(!fbTgtVisible(el)) continue;
      var l=String(el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim();
      if(LIKEITEM.test(l)){ var r=el.getBoundingClientRect(); cx=Math.round(r.left+r.width/2); cy=Math.round(r.top+r.height/2); found=true; break; }
    }
  }
  if(!found) return JSON.stringify({found:false, cx:0, cy:0, fromX:null, fromY:null});
  // 视口内守卫：坐标点击只对**可视区内**的项有效，屏外坐标点空（无声失败）。屏外即回 found:false，
  // 由调用方诚实走 state_unchanged（配合 buildRectJs 把 Like 按钮滚进视口，正常情况下浮层项必在屏）。
  var vw=window.innerWidth||0, vh=window.innerHeight||0;
  if(cx<0||cy<0||cx>vw||cy>vh) return JSON.stringify({found:false, cx:cx, cy:cy, fromX:null, fromY:null, offscreen:true});
  var fromX=null, fromY=null;
  var tgt=fbTaggedTarget(${JSON.stringify(runId)});
  if(tgt){ var c=fbPostReactControl(tgt); if(c&&c.el){ var rr=c.el.getBoundingClientRect(); fromX=Math.round(rr.left+rr.width/2); fromY=Math.round(rr.top+rr.height/2); } }
  return JSON.stringify({found:true, cx:cx, cy:cy, fromX:fromX, fromY:fromY});
})()`;
}

/**
 * 被作用卡独立见证现读（/*aidcp:observation*\/）：只读标记节点，重新派生 postId + 判 surface + 取
 * author/textPreviewHead/reactionText/articleIndex。surface 由标记卡的祖先判：dialog→detail、feed 容器→feed。
 */
function buildObservationJs(runId: string): string {
  return `(function(){/*aidcp:observation*/${FB_TARGET_HELPERS_JS}
  function obsText(el){ return String((el&&el.innerText)||(el&&el.textContent)||'').replace(/\\s+/g,' ').trim(); }
  var el=document.querySelector('[data-aidcp-target="'+${JSON.stringify(runId)}+'"]');
  if(!el) return JSON.stringify({found:false});
  var surface=(el.closest && el.closest('[role="dialog"]')) ? 'detail' : ((el.closest && el.closest('div[role="feed"]')) ? 'feed' : 'detail');
  var al=el.querySelector('h2 a, h3 a, h4 a');
  var msg=el.querySelector('[data-ad-comet-preview="message"],[data-ad-preview="message"],[data-ad-rendering-role="story_message"]');
  var head=msg?obsText(msg):'';
  var reactionText='';
  var btns=el.querySelectorAll('[role="button"][aria-label]');
  for(var b=0;b<btns.length;b++){ var lab=(btns[b].getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim(); var bt=obsText(btns[b]); if(/^(赞|讚|Like|Me gusta)/i.test(lab)&&/\\d/.test(bt)){ reactionText=bt; break; } }
  var tops=fbTgtTopArticles(fbTgtScopeRoot()); var idx=-1;
  for(var i=0;i<tops.length;i++){ if(tops[i]===el){ idx=i; break; } }
  return JSON.stringify({found:true, surface:surface, noteId:fbTgtArticlePostId(el), author:al?obsText(al):null, textPreviewHead:head.slice(0,40)||null, reactionText:reactionText||null, articleIndex:idx});
})()`;
}
