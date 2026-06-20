/**
 * comment-probe.ts — XHS 评论框「执行端探针」（先决调研，非生产代码）
 * ===========================================================================
 *
 * 目的：在一台已登录小红书、开着 CDP 调试端口的 Chrome 上，对准一篇**已打开的
 * 笔记详情页**，把后续实装「发评论」动作所缺的三件事摸清楚：
 *   1. 评论输入框怎么定位（选择器 / contenteditable / placeholder）；
 *   2. 提交控件怎么定位（「发送」按钮 or 回车）；
 *   3. 「评论真的发出去了」用什么信号校验（评论数 +1 / 自己的评论行出现 /
 *      输入框清空 / 成功 toast）——这是最关键、且没有点赞那种图标翻转可抄的一项。
 *
 * 安全分级（默认只读，绝不静默发评论）：
 *   - 默认（不带任何 flag）：**纯只读**。只 dump DOM 候选 + 截图，零交互、零输入、零提交。
 *   - --activate     ：点一下评论入口让编辑器聚焦/展开，再 dump（仍不输入、不提交）。
 *   - --type-test    ：在聚焦的框里**拟人输入一段无害探针文本，读回确认后立即清空**
 *                      （证明输入链路 + 锁定真正承接文本的元素；不提交）。
 *   - AIDCP_COMMENT_SUBMIT=true 且 --yes-post-real-comment 且 --text="..."：
 *                      **真发一条评论**（一次性，用来抓发布后到底哪个信号翻转）。
 *                      会真的在该笔记下留言——**请在自己的测试笔记上跑**。
 *
 * 运行（不需要 build，用 tsx 直接跑；本文件不在 tsconfig include 内，是独立脚本）：
 *   # 1) 起一个带调试端口的 Chrome（或复用已在跑的），登录小红书，手动点开一篇笔记详情
 *   #    chrome --remote-debugging-port=9222 --user-data-dir=/tmp/aidcp-chrome
 *   # 2) 只读探测
 *   cd ../aidcp-edge && tsx scripts/comment-probe.ts
 *   # 3) 看编辑器聚焦/展开行为
 *   tsx scripts/comment-probe.ts --activate
 *   # 4) 验证拟人输入链路（输入后自动清空，不提交）
 *   tsx scripts/comment-probe.ts --type-test --text="探针测试，勿提交"
 *   # 5) 真发一条（仅在自己的测试笔记上，确认 1-4 都 OK 后再跑）
 *   AIDCP_COMMENT_SUBMIT=true tsx scripts/comment-probe.ts \
 *       --yes-post-real-comment --text="今天的分享很有启发，学到了"
 *
 * 环境变量：
 *   AIDCP_CDP_HOST（默认 127.0.0.1）/ AIDCP_CDP_PORT（默认 9222）/
 *   AIDCP_PAGE_URL（attach 时按 url 子串匹配标签页，默认 'xiaohongshu'）
 *
 * 产物：每次跑都把完整快照写到 /tmp/aidcp-comment-probe-<ts>.json，并截图到
 *       /tmp/aidcp-comment-probe-<ts>.png。把这两个发回来即可继续设计 PostValidator。
 *
 * 关联设计：见中控仓「评论互动」评估对话（评估→撰写→去AI味→审批，循环内人审）。
 * 本探针只解决其中最大的执行端未知项；摸通后再落 openspec change。
 */

import process from 'node:process';
import { writeFileSync } from 'node:fs';

import { attachToPage } from '../src/cdp/index.js';
import {
  evalJson,
  dispatchKeystrokes,
  dispatchClick,
} from '../src/browse/cdp-util.js';

// ---------------------------------------------------------------------------
// 小工具：参数 / flag / 环境读取
// ---------------------------------------------------------------------------

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function log(step: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ step, ...payload }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 评论相关的中文/英文关键词，用来在全页扫候选输入框 / 入口 / 提交控件
const COMMENT_KEYWORDS = [
  '说点什么',
  '说两句',
  '写评论',
  '写下你的评论',
  '友善评论',
  '留下你的',
  '善意',
  '评论',
  'comment',
  'say something',
];

const SUBMIT_KEYWORDS = ['发送', '发布', '评论', 'send', 'post'];

// 常见验证码/安全验证浮层文案，Stage D 提交前自检
const CAPTCHA_KEYWORDS = ['验证', '滑块', '拖动', '安全验证', '请完成', 'captcha', 'verify', 'slider'];

// ---------------------------------------------------------------------------
// 页面内 JS：把候选元素 dump 成可序列化的结构（returnByValue 直接拿对象）
// ---------------------------------------------------------------------------

/**
 * 构造一段 IIFE 表达式：在页面里扫描评论框/入口/提交控件/评论列表，返回纯 JSON 对象。
 * 关键词数组通过 JSON 注入，避免转义问题。
 */
function buildSnapshotExpr(): string {
  const kw = JSON.stringify(COMMENT_KEYWORDS.map((s) => s.toLowerCase()));
  const sub = JSON.stringify(SUBMIT_KEYWORDS.map((s) => s.toLowerCase()));
  return `(() => {
    const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
    const KW = ${kw};
    const SUB = ${sub};
    const rectOf = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
               cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
    };
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const cssPath = (el) => {
      if (!(el instanceof Element)) return null;
      const parts = [];
      let cur = el;
      while (cur && parts.length < 7) {
        let part = cur.tagName.toLowerCase();
        if (cur.id) { part += '#' + cur.id; parts.unshift(part); break; }
        const cls = typeof cur.className === 'string'
          ? cur.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3) : [];
        if (cls.length) part += '.' + cls.join('.');
        parts.unshift(part);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    };
    const desc = (el) => ({
      tag: el.tagName,
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className : null,
      role: el.getAttribute('role'),
      type: el.getAttribute('type'),
      placeholder: el.getAttribute('placeholder'),
      ariaLabel: el.getAttribute('aria-label'),
      contenteditable: el.getAttribute('contenteditable'),
      text: norm(el.textContent).slice(0, 80),
      cssPath: cssPath(el),
      rect: rectOf(el),
      visible: visible(el),
      outerHTML: (el.outerHTML || '').slice(0, 300),
    });

    const all = Array.from(document.querySelectorAll('*'));

    // 详情页容器（modal 或整页）
    const detailSel = '.note-detail-mask, [class*="note-detail"], [class*="noteDetail"], ' +
      '[class*="note-container"], [class*="noteContainer"], .note-detail, #noteContainer, [class*="note-modal"]';
    const detailEl = document.querySelector(detailSel);

    // engage-bar 与三个 wrapper（like/collect/comment）
    const bar = document.querySelector('.interactions.engage-bar') || document.querySelector('.engage-bar');
    const wrappers = {};
    for (const cls of ['like-wrapper', 'collect-wrapper', 'comment-wrapper', 'chat-wrapper', 'share-wrapper']) {
      const el = (bar || document).querySelector('.' + cls);
      wrappers[cls] = el ? desc(el) : null;
    }

    // 候选输入框：contenteditable / textarea / input / role=textbox
    const inputCandidates = all
      .filter((el) => el.matches('[contenteditable="true"], textarea, input, [role="textbox"]'))
      .filter(visible)
      .map(desc)
      .slice(0, 25);

    // 关键词候选（入口栏「说点什么」、提示文案等）——可能是折叠态的伪输入
    const keywordCandidates = all
      .filter((el) => {
        const hay = [el.textContent, el.getAttribute('placeholder'), el.getAttribute('aria-label'),
                     el.getAttribute('title')].filter(Boolean).join(' ').toLowerCase();
        return KW.some((k) => hay.includes(k));
      })
      .filter(visible)
      // 取较小的叶子，避免命中整页大容器
      .sort((a, b) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height)
                    - (b.getBoundingClientRect().width * b.getBoundingClientRect().height))
      .slice(0, 20)
      .map(desc);

    // 提交控件候选
    const submitCandidates = all
      .filter((el) => el.matches('button, [role="button"], span, div'))
      .filter((el) => {
        const t = norm(el.textContent).toLowerCase();
        return t.length <= 6 && SUB.some((s) => t === s || t.includes(s));
      })
      .filter(visible)
      .slice(0, 20)
      .map(desc);

    // 评论列表 + 计数（设计 PostValidator 的「之前态」）
    const listSel = '[class*="comment-list"], .comments-container, [class*="list-container"], [class*="comments"]';
    const listEl = document.querySelector(listSel);
    const items = Array.from(document.querySelectorAll('[class*="comment-item"], [class*="comment"] [class*="item"]'))
      .filter(visible).slice(0, 5)
      .map((el) => ({
        cssPath: cssPath(el),
        author: norm((el.querySelector('[class*="name"], [class*="author"], [class*="nickname"]') || {}).textContent),
        content: norm((el.querySelector('[class*="content"], [class*="text"], p') || {}).textContent).slice(0, 120),
      }));
    const commentCountText = wrappers['comment-wrapper'] ? wrappers['comment-wrapper'].text : null;

    return {
      url: location.href,
      title: document.title,
      detailContainer: detailEl ? desc(detailEl) : null,
      engageBar: bar ? desc(bar) : null,
      wrappers,
      commentCountText,
      inputCandidates,
      keywordCandidates,
      submitCandidates,
      commentList: listEl ? desc(listEl) : null,
      topComments: items,
      activeElement: document.activeElement ? desc(document.activeElement) : null,
    };
  })()`;
}

/** 评论编辑器选择器（Stage B 实测：激活后是 p#content-textarea contenteditable） */
const EDITOR_SELECTOR =
  '#content-textarea, .engage-bar.active [contenteditable="true"], .content-input[contenteditable="true"], .engage-bar [contenteditable="true"]';

/** 按选择器读评论编辑器的文本 + 坐标（不依赖 activeElement） */
function buildEditorReadExpr(): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return { found: true, tag: el.tagName, id: el.id || null,
      textContent: (el.textContent || '').replace(/\\s+/g,' ').trim().slice(0,200),
      cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) };
  })()`;
}

/** 按选择器清空评论编辑器（contenteditable），派发 input 事件 */
function buildEditorClearExpr(): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    if (!el) return { ok: false, reason: 'no_editor' };
    el.textContent = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  })()`;
}

/** 提交前的验证码/安全浮层自检 */
function buildCaptchaCheckExpr(): string {
  const kw = JSON.stringify(CAPTCHA_KEYWORDS.map((s) => s.toLowerCase()));
  return `(() => {
    const KW = ${kw};
    const hit = Array.from(document.querySelectorAll('*')).find((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const t = (el.textContent || '').toLowerCase();
      return t.length < 60 && KW.some((k) => t.includes(k));
    });
    return hit ? { present: true, text: (hit.textContent || '').replace(/\\s+/g,' ').trim().slice(0,80) }
               : { present: false };
  })()`;
}

// ---------------------------------------------------------------------------
// 类型（仅本脚本用，松散即可）
// ---------------------------------------------------------------------------

interface ElDesc {
  tag: string;
  className: string | null;
  role: string | null;
  placeholder: string | null;
  contenteditable: string | null;
  text: string;
  cssPath: string | null;
  rect: { cx: number; cy: number; w: number; h: number };
  visible: boolean;
}

interface Snapshot {
  url: string;
  title: string;
  detailContainer: ElDesc | null;
  engageBar: ElDesc | null;
  wrappers: Record<string, ElDesc | null>;
  commentCountText: string | null;
  inputCandidates: ElDesc[];
  keywordCandidates: ElDesc[];
  submitCandidates: ElDesc[];
  commentList: ElDesc | null;
  topComments: Array<{ author: string; content: string }>;
  activeElement: ElDesc | null;
}

type Session = Awaited<ReturnType<typeof attachToPage>>;

// 选「评论输入入口」：实测是折叠态输入栏「说点什么」(.content-edit/.input-box)；排除「共 N 条评论」计数头
function pickCommentEntry(snap: Snapshot): ElDesc | null {
  const byBar = snap.keywordCandidates.find(
    (c) => c.visible && (c.text.includes('说点什么') || /content-edit|input-box|inner-when-not-active/.test(c.cssPath ?? '')),
  );
  if (byBar) return byBar;
  const fromKeyword = snap.keywordCandidates.find(
    (c) => c.visible && c.rect.w >= 40 && c.rect.h >= 16 && !/条评论/.test(c.text),
  );
  if (fromKeyword) return fromKeyword;
  if (snap.wrappers['comment-wrapper']?.visible) return snap.wrappers['comment-wrapper'];
  return null;
}

// 选评论提交控件：实测是 .engage-bar.active 内 button.btn.submit「发送」（避开左侧导航的「发布」）
function pickSubmit(snap: Snapshot): ElDesc | null {
  const inBar = snap.submitCandidates.filter(
    (c) => c.visible && /engage-bar/.test(c.cssPath ?? ''),
  );
  const sendBtn =
    inBar.find((c) => c.text === '发送' && /button/.test(c.cssPath ?? '')) ??
    inBar.find((c) => c.text === '发送') ??
    inBar[0];
  if (sendBtn) return sendBtn;
  // 兜底：全页精确「发送」里面积最小的叶子
  const anySend = snap.submitCandidates
    .filter((c) => c.visible && c.text === '发送')
    .sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h);
  return anySend[0] ?? null;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function snapshot(session: Session): Promise<Snapshot> {
  return evalJson<Snapshot>(session.cdp, buildSnapshotExpr());
}

async function captureArtifacts(session: Session, ts: number, tag: string, snap: Snapshot): Promise<void> {
  const jsonPath = `/tmp/aidcp-comment-probe-${ts}-${tag}.json`;
  writeFileSync(jsonPath, JSON.stringify(snap, null, 2));
  log('artifact_json', { path: jsonPath, tag });
  try {
    const shot = await session.cdp.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    });
    const pngPath = `/tmp/aidcp-comment-probe-${ts}-${tag}.png`;
    writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));
    log('artifact_png', { path: pngPath, tag });
  } catch (err) {
    log('artifact_png_failed', { reason: (err as Error).message });
  }
}

async function main(): Promise<void> {
  if (hasFlag('help')) {
    console.log('see header of scripts/comment-probe.ts for usage; default run is READ-ONLY.');
    return;
  }

  const ts = Date.now();
  const host = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
  const port = Number(process.env.AIDCP_CDP_PORT ?? 9222);
  const urlIncludes = process.env.AIDCP_PAGE_URL ?? 'xiaohongshu';

  const doActivate = hasFlag('activate') || hasFlag('type-test');
  const doTypeTest = hasFlag('type-test');
  const wantSubmit = process.env.AIDCP_COMMENT_SUBMIT === 'true' && hasFlag('yes-post-real-comment');
  const text = readArg('text') ?? '';

  log('probe_start', { ts, host, port, urlIncludes, doActivate, doTypeTest, wantSubmit, hasText: !!text });

  const session = await attachToPage({ host, port, urlIncludes });
  await session.cdp.send('Input.enable').catch(() => undefined);

  try {
    // ---- Stage 0 + A: 只读 dump ----
    const snapA = await snapshot(session);
    if (!snapA.detailContainer) {
      log('warn_no_detail', { url: snapA.url, hint: '未检测到笔记详情容器，请先手动点开一篇笔记详情' });
    }
    const entry = pickCommentEntry(snapA);
    const submit = pickSubmit(snapA);
    log('readonly_summary', {
      url: snapA.url,
      commentCountText: snapA.commentCountText,
      inputCandidates: snapA.inputCandidates.length,
      keywordCandidates: snapA.keywordCandidates.length,
      submitCandidates: snapA.submitCandidates.length,
      pickedEntry: entry ? { cssPath: entry.cssPath, text: entry.text, rect: entry.rect } : null,
      pickedSubmit: submit ? { cssPath: submit.cssPath, text: submit.text, rect: submit.rect } : null,
      topComments: snapA.topComments,
    });
    await captureArtifacts(session, ts, 'A-readonly', snapA);

    if (!doActivate) {
      log('done_readonly', { note: '纯只读完成。加 --activate / --type-test 看交互行为。' });
      return;
    }

    // ---- Stage B: 点击评论入口聚焦/展开 ----
    if (!entry) {
      log('activate_abort', { reason: 'no_comment_entry_found' });
      return;
    }
    log('activate_click', { target: entry.cssPath, at: { x: entry.rect.cx, y: entry.rect.cy } });
    await dispatchClick(session.cdp, entry.rect.cx, entry.rect.cy);
    await sleep(800);
    const snapB = await snapshot(session);
    log('after_activate', {
      activeElement: snapB.activeElement,
      // 展开后新出现的可编辑候选（B 比 A 多出来的）
      inputCandidatesNow: snapB.inputCandidates.map((c) => ({ cssPath: c.cssPath, placeholder: c.placeholder, contenteditable: c.contenteditable, rect: c.rect })),
    });
    await captureArtifacts(session, ts, 'B-activated', snapB);

    if (!doTypeTest) {
      log('done_activate', { note: '已聚焦评论框（未输入）。加 --type-test 验证输入链路。' });
      return;
    }

    // ---- Stage C: 拟人输入 → 读回 → 清空（不提交）----
    const probeText = text || '探针测试_请勿提交';
    log('type_test_begin', { probeText });
    // 直接点编辑器本体落 caret（contenteditable + data-tribute 不能靠 activeElement）
    const editorBefore = await evalJson<{ found: boolean; cx?: number; cy?: number; id?: string | null }>(
      session.cdp, buildEditorReadExpr());
    if (!editorBefore.found || editorBefore.cx == null || editorBefore.cy == null) {
      log('type_test_abort', { reason: 'editor_not_found_after_activate', hint: '把 B json 发回来' });
      return;
    }
    await dispatchClick(session.cdp, editorBefore.cx, editorBefore.cy);
    await sleep(300);
    await dispatchKeystrokes(session.cdp, probeText);
    await sleep(400);
    const afterType = await evalJson<{ found: boolean; textContent?: string }>(session.cdp, buildEditorReadExpr());
    const landed = (afterType?.textContent ?? '').includes(probeText);
    log('type_test_readback', { landed, editor: afterType });
    // While the box HAS content, the real 发送 submit control should be present — capture it now (before clearing).
    const withText = await snapshot(session);
    log('submit_candidates_with_text', {
      submitCandidates: withText.submitCandidates.map((c) => ({ cssPath: c.cssPath, text: c.text, rect: c.rect, visible: c.visible })),
      pickedSubmit: pickSubmit(withText),
    });
    const cleared = await evalJson<{ ok: boolean }>(session.cdp, buildEditorClearExpr());
    log('type_test_cleared', { cleared });

    if (!wantSubmit) {
      log('done_type_test', {
        landed,
        note: landed
          ? '输入链路通，文本已清空、未提交。真发请：AIDCP_COMMENT_SUBMIT=true ... --yes-post-real-comment --text="..."'
          : '输入未落到聚焦元素——把 B/C 两个 json 发回来，需要换聚焦/输入策略。',
      });
      return;
    }

    // ---- Stage D: 真发一条（已显式授权），抓发布后哪个信号翻转 ----
    if (!text) {
      log('submit_abort', { reason: 'missing --text for real submit' });
      return;
    }
    log('SUBMIT_WARNING', { note: '即将真发一条评论。请确认是在自己的测试笔记上。', text });

    // 提交前重新 dump 「之前态」
    const pre = await snapshot(session);
    const preCount = pre.commentCountText;
    const preTop = pre.topComments.map((c) => c.content);

    // 激活评论框 → 点编辑器本体落 caret → 拟人输入真实文本
    const entry2 = pickCommentEntry(pre) ?? entry;
    await dispatchClick(session.cdp, entry2.rect.cx, entry2.rect.cy);
    await sleep(600);
    const ed = await evalJson<{ found: boolean; cx?: number; cy?: number }>(session.cdp, buildEditorReadExpr());
    if (ed.found && ed.cx != null && ed.cy != null) {
      await dispatchClick(session.cdp, ed.cx, ed.cy);
      await sleep(250);
    }
    await dispatchKeystrokes(session.cdp, text);
    await sleep(500);

    // 验证码自检
    const captcha = await evalJson<{ present: boolean; text?: string }>(session.cdp, buildCaptchaCheckExpr());
    if (captcha.present) {
      log('submit_blocked_by_captcha', { captcha });
      await evalJson(session.cdp, buildEditorClearExpr()); // 清空，避免留下半截输入
      return;
    }

    // 输入后再 snapshot 才能拿到「发送」按钮（空框时不出现）；找不到则诚实终止，不静默假成功
    const postType = await snapshot(session);
    const preSubmit = pickSubmit(postType);
    if (!preSubmit) {
      log('submit_abort', { reason: 'no_submit_control_found', hint: '可能用回车提交——把 D 之前的 json 发回来确认' });
      await evalJson(session.cdp, buildEditorClearExpr());
      return;
    }
    log('submit_click', { target: preSubmit.cssPath, at: { x: preSubmit.rect.cx, y: preSubmit.rect.cy } });
    await dispatchClick(session.cdp, preSubmit.rect.cx, preSubmit.rect.cy);

    // 等结果并抓「之后态」
    await sleep(2200);
    const post = await snapshot(session);
    const ownRowFound = post.topComments.some((c) => c.content.includes(text.slice(0, 12)));
    const inputCleared = !(post.activeElement?.text ?? '').includes(text.slice(0, 12));
    log('submit_result', {
      countBefore: preCount,
      countAfter: post.commentCountText,
      ownRowFound,
      inputCleared,
      topCommentsBefore: preTop,
      topCommentsAfter: post.topComments.map((c) => c.content),
      verdictHint: '据此设计 PostValidator：优先「输入清空 且（计数+1 或 自己的评论行出现）」',
    });
    await captureArtifacts(session, ts, 'D-submitted', post);
  } catch (err) {
    log('probe_error', { message: (err as Error).message, stack: (err as Error).stack });
    process.exitCode = 1;
  } finally {
    session.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
