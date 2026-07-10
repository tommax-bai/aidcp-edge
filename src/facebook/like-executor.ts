/**
 * Facebook 帖级「点赞」原子执行器 + 强制后置校验（浏览闭环 interaction.like 的落地）。
 *
 * 红线（贯穿本文件，MUST NOT 静默假成功）：
 *  - **只点帖级 react 按钮**：`[role=button]` 命中中性反应词（留下心情/Like…），且其**同一动作栏含「发表评论/Comment」
 *    按钮**（帖级独有；评论级 react 同栏只有「回复/Reply」，据此排除，见探针 §Detail）。
 *  - **in-page element.click()**：FB 的 div[role=button] 是 React 合成事件，坐标 dispatchClick 静默失效
 *    （master 6848632 实证）——本执行器用页面内 `el.click()`，绝不用坐标点击。
 *  - **后置校验按钮状态真翻转才 ok**：点后有界复读同一按钮，命中「已反应」正向信号（撤销串 / 空文案变反应词）
 *    才回 ok；否则诚实 state_unchanged。已赞 → already_liked（不重复点）；找不到 → no_target。
 *  - **提交前 fresh 复检验证码**（fail-closed）：命中验证码/未知阻断 → blocked_by_captcha，绝不硬点。
 *  - **点赞计数只走云端 RiskController.record**：本执行器不维护任何边缘并行计数器（design 决策）。
 *  - Shadow：只定位+校验目标、**不点击**，回诚实 `shadow`（executed=false）——云端据此不记账、不扣风控。
 */

import { evalJson, type BrowseCdp } from '../browse/cdp-util.js';
import type { OverlayKind, OverlayMonitor } from '../browse/overlay-monitor.js';
import {
  NEUTRAL_LIKE_LABEL_SOURCE,
  COMMENT_LABEL_SOURCE,
  REACTED_WORD_SOURCE,
  UNREACT_LABEL_SOURCE,
} from './cta-labels.js';

export type FacebookLikeReason =
  | 'no_target' // 找不到帖级 react 按钮
  | 'already_liked' // 已是已赞态
  | 'state_unchanged' // 点后状态未翻转（未生效）
  | 'blocked_by_captcha'
  | 'login_required'
  | 'shadow' // shadow 模式：只校验不执行
  | 'nav_error';

export interface FacebookLikeResult {
  ok: boolean;
  reason?: FacebookLikeReason;
  /** 是否真的派发了点击（shadow / 跳过 / 已赞 = false）。 */
  executed: boolean;
}

export interface FacebookLikeExecutorDeps {
  cdp: BrowseCdp;
  /** 旁路弹窗监测体；点击前 fresh 复检登录/验证码（fail-closed）。 */
  overlayMonitor?: OverlayMonitor;
  sleep?: (ms: number) => Promise<void>;
  logger?: (msg: string) => void;
}

export interface FacebookLikeExecutorOptions {
  /** 校验轮询上限（毫秒）。 */
  verifyTimeoutMs?: number;
  verifyPollMs?: number;
  /** 点击后首次校验前的沉淀。 */
  settleMs?: number;
}

const DEFAULTS: Required<FacebookLikeExecutorOptions> = {
  verifyTimeoutMs: 2_000,
  verifyPollMs: 300,
  settleMs: 300,
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface LocateResult {
  found: boolean;
  already: boolean;
  label?: string;
  text?: string;
}

interface ClickResult {
  clicked: boolean;
  reason?: 'no_target' | 'already';
}

interface VerifyResult {
  found: boolean;
  reacted: boolean;
  label?: string;
  text?: string;
}

export class FacebookLikeExecutor {
  private readonly cdp: BrowseCdp;
  private readonly overlayMonitor?: OverlayMonitor;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly opts: Required<FacebookLikeExecutorOptions>;

  constructor(deps: FacebookLikeExecutorDeps, options: FacebookLikeExecutorOptions = {}) {
    this.cdp = deps.cdp;
    this.overlayMonitor = deps.overlayMonitor;
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.logger ?? (() => {});
    this.opts = { ...DEFAULTS, ...options };
  }

  /**
   * 对当前打开的帖子点赞。shadow=true 时只定位+不点、回诚实 shadow。
   * 顺序：定位（含已赞判定）→ fresh 复检验证码 → [shadow: 不点] / 点击(element.click) → 后置校验翻转。
   */
  async like(options: { shadow?: boolean } = {}): Promise<FacebookLikeResult> {
    let locate: LocateResult;
    try {
      locate = await evalJson<LocateResult>(this.cdp, LOCATE_JS);
    } catch (err) {
      this.log(`[fb-like] 定位失败：${(err as Error).message}`);
      return { ok: false, reason: 'no_target', executed: false };
    }
    if (!locate.found) {
      this.log('[fb-like] 未找到帖级 react 按钮（含「发表评论」同栏），no_target');
      return { ok: false, reason: 'no_target', executed: false };
    }
    if (locate.already) {
      this.log('[fb-like] 帖子已是已赞态，already_liked（不重复点）');
      return { ok: false, reason: 'already_liked', executed: false };
    }

    // 点击前 fresh 复检验证码（fail-closed）：命中即放弃，绝不硬点进风控墙。
    const blocked = await this.blockingReason();
    if (blocked) {
      this.log(`[fb-like] 点击前复检到阻断（${blocked}），放弃点击`);
      return { ok: false, reason: blocked, executed: false };
    }

    if (options.shadow) {
      // Shadow：目标已确认存在但**不执行**——回诚实 shadow，云端据此不记账（无 ⚠ 前缀，不触发风控）。
      this.log(`[fb-like][shadow] 目标存在（label="${locate.label ?? ''}"），影子模式不点击，回 shadow`);
      return { ok: false, reason: 'shadow', executed: false };
    }

    let click: ClickResult;
    try {
      click = await evalJson<ClickResult>(this.cdp, CLICK_JS);
    } catch (err) {
      this.log(`[fb-like] 点击失败：${(err as Error).message}`);
      return { ok: false, reason: 'state_unchanged', executed: false };
    }
    if (!click.clicked) {
      if (click.reason === 'already') return { ok: false, reason: 'already_liked', executed: false };
      return { ok: false, reason: 'no_target', executed: false };
    }

    // 后置校验：有界复读同一按钮，命中「已反应」正向信号才 ok；否则诚实 state_unchanged。
    await this.sleep(this.opts.settleMs);
    const start = Date.now();
    let last: VerifyResult | undefined;
    while (Date.now() - start < this.opts.verifyTimeoutMs) {
      try {
        last = await evalJson<VerifyResult>(this.cdp, VERIFY_JS);
        if (last?.reacted === true) {
          this.log('[fb-like] ✓ 点赞成功（按钮状态已翻转）');
          return { ok: true, executed: true };
        }
      } catch {
        /* 下一轮重试 */
      }
      await this.sleep(this.opts.verifyPollMs);
    }
    this.log(`[fb-like] 点击后状态未翻转（label="${last?.label ?? ''}" text="${last?.text ?? ''}"），state_unchanged`);
    return { ok: false, reason: 'state_unchanged', executed: true };
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

// ─────────────────────────── in-page 定位/点击/校验 IIFE（自包含，返回 JSON.stringify）───────────────────────────

/** 共享定位助手：找帖级 react 控件（同栏含「发表评论」，排除评论级 react），并判其已赞/中性。 */
const REACT_LOCATE_HELPERS = `
  function fbVis(el){ if(!el||!el.getBoundingClientRect) return false; var r=el.getBoundingClientRect(); if(r.width<=0||r.height<=0) return false; var s=window.getComputedStyle?getComputedStyle(el):null; return !s||(s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity||'1')>0.01); }
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
  // 有界上溯：该按钮 5 层内的动作栏是否含「发表评论/Comment」按钮（帖级独有，排除评论级）。
  function clusterHasComment(btn){ var p=btn;
    for(var d=0; d<5 && p; d++){ p=p.parentElement; if(!p) break;
      var cbtns=p.querySelectorAll('[role="button"][aria-label]');
      for(var i=0;i<cbtns.length;i++){ if(COMMENT.test((cbtns[i].getAttribute('aria-label')||''))) return true; }
    }
    return false; }
  // 帖级 react 控件（dialog 内优先）：命中 react 词 + 同栏含「发表评论」。返回 {el, state}。
  function findPostReactControl(){
    var dialog=document.querySelector('[role="dialog"]'); var root=dialog||document;
    var btns=root.querySelectorAll('[role="button"][aria-label]');
    for(var i=0;i<btns.length;i++){ var el=btns[i]; if(!fbVis(el)) continue; var st=reactState(el); if(!st) continue; if(!clusterHasComment(el)) continue; return {el:el, state:st}; }
    return null; }
`;

const LOCATE_JS = `(function(){${REACT_LOCATE_HELPERS}
  var c=findPostReactControl();
  if(!c) return JSON.stringify({found:false, already:false});
  return JSON.stringify({found:true, already:(c.state==='reacted'), label:fbLabel(c.el), text:fbText(c.el)});
})()`;

const CLICK_JS = `(function(){${REACT_LOCATE_HELPERS}
  var c=findPostReactControl();
  if(!c) return JSON.stringify({clicked:false, reason:'no_target'});
  if(c.state==='reacted') return JSON.stringify({clicked:false, reason:'already'});
  try{ c.el.scrollIntoView({block:'center'}); }catch(e){}
  try{ c.el.click(); }catch(e){ return JSON.stringify({clicked:false, reason:'no_target'}); }
  return JSON.stringify({clicked:true});
})()`;

const VERIFY_JS = `(function(){${REACT_LOCATE_HELPERS}
  var c=findPostReactControl();
  if(!c) return JSON.stringify({found:false, reacted:false});
  return JSON.stringify({found:true, reacted:(c.state==='reacted'), label:fbLabel(c.el), text:fbText(c.el)});
})()`;
