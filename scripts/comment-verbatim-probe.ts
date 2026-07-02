/**
 * comment-verbatim-probe.ts — 群聊引流码「原样送达」执行端探针（change account-group-chat-injection，先决调研）
 * ===========================================================================
 *
 * 背景：/comment group:on 会把账号「关联群聊引流码」verbatim 追加到评论，云端已保证「人审卡=返回文本」。
 * 但边缘发评论是**逐字符**敲进 p#content-textarea（contenteditable + data-tribute @提及编辑器），且发送前会 trim。
 * 已知风险：`@`（确证触发提及补全，云端 sanitize 专剥它）、可能的 `#`（主题）、换行 —— 逐字敲入可能被补全劫持、
 * 或换行被吞，导致「发出去的 ≠ 人审通过的」。emoji 已确证安全（按码点切分）。
 *
 * 本探针**只读回、绝不提交**（无 submit 路径），在一台已登录小红书、开着 CDP 的 Chrome、停在**已打开的笔记详情页**上：
 *   1. 激活评论框；
 *   2. 用**逐字符**方式（dispatchKeystrokes，= 生产 executeComment 的输入方式）敲入候选码 → 读回 textContent → 比对；
 *   3. 清空后，用**单次整段**方式（insertText，= 备选方案 B）敲入同一码 → 读回 → 比对；
 *   4. 每步 dump 任何新出现的浮层（探测 @/# 提及/主题补全下拉是否弹出、是否劫持后续输入）；
 *   5. 清空、结束。绝不点「发送」。
 *
 * 产出决定设计 D5 二选一：
 *   - 若逐字 readback == 输入（无劫持、换行OK）→ 走「云端规整」轻量方案，边缘不改；
 *   - 若逐字被劫持/变形、但整段 insertText readback == 输入 → 走「边缘整段插入」方案（改 executeComment 的码段送达）。
 *
 * 运行（tsx 直跑，无需 build；本文件不在 tsconfig include 内）：
 *   # 1) 起带调试端口的 Chrome，登录小红书，手动点开一篇笔记详情
 *   #    chrome --remote-debugging-port=9222 --user-data-dir=/tmp/aidcp-chrome
 *   # 2) 默认码（含 #、:/#、emoji，单行）
 *   cd ../aidcp-edge && tsx scripts/comment-verbatim-probe.ts
 *   # 3) 指定码 / 测多行
 *   tsx scripts/comment-verbatim-probe.ts --code="2【长按复制】加群 :/#f🐶🍅"
 *   tsx scripts/comment-verbatim-probe.ts --multiline
 *   # 4) 顺带测含 @ 的码（确证提及劫持）
 *   tsx scripts/comment-verbatim-probe.ts --code="加群找@小助手🐶"
 *
 * 环境变量：AIDCP_CDP_HOST（默认 127.0.0.1）/ AIDCP_CDP_PORT（默认 9222）/ AIDCP_PAGE_URL（默认 'xiaohongshu'）
 * 产物：/tmp/aidcp-comment-verbatim-probe-<ts>.json（把它发回来即可定 D5）。
 */

import process from 'node:process';
import { writeFileSync } from 'node:fs';

import { attachToPage } from '../src/cdp/index.js';
import { evalJson, dispatchKeystrokes, dispatchClick, insertText } from '../src/browse/cdp-util.js';

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

/** 折叠态评论入口（与生产 executeComment 同源选择器）。 */
const ENTRY_JS = `(function(){
  var bar = document.querySelector('.interactions.engage-bar') || document.querySelector('.engage-bar');
  if (!bar) return { error: 'no-bar' };
  var entry = bar.querySelector('.content-edit .not-active') || bar.querySelector('.content-edit') || bar.querySelector('.input-box');
  if (!entry) return { error: 'no-entry' };
  var r = entry.getBoundingClientRect();
  return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
})()`;

const EDITOR_SELECTOR = '#content-textarea, .engage-bar.active [contenteditable="true"], .engage-bar [contenteditable="true"]';

/** 读编辑器坐标（激活后落 caret 用）。 */
const EDITOR_LOCATE_JS = `(function(){
  var el = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
  if (!el) return { found: false };
  var r = el.getBoundingClientRect();
  return { found: true, cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) };
})()`;

/** 读编辑器**原始** textContent（不做空白规整，保留换行/首尾空白，供逐字节比对）。 */
const EDITOR_READ_RAW_JS = `(function(){
  var el = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
  if (!el) return { found: false };
  return { found: true, textContent: (el.textContent || ''), innerText: (el.innerText || ''), html: (el.innerHTML || '').slice(0, 500) };
})()`;

/** 清空编辑器。 */
const EDITOR_CLEAR_JS = `(function(){
  var el = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
  if (!el) return { ok: false };
  el.textContent = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return { ok: true };
})()`;

/** 扫描可能是「@提及/#主题」补全下拉的浮层（探测是否弹出、是否会劫持输入）。 */
const DROPDOWN_SCAN_JS = `(function(){
  var norm = function(t){ return (t||'').replace(/\\s+/g,' ').trim(); };
  var out = [];
  var all = Array.prototype.slice.call(document.querySelectorAll('*'));
  for (var i=0;i<all.length;i++){
    var el = all[i];
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    var s = getComputedStyle(el);
    if (s.display==='none' || s.visibility==='hidden') continue;
    var cls = (typeof el.className==='string' ? el.className : '') || '';
    var looksMenu = /tribute|mention|at-user|topic|suggest|dropdown|popover|panel-list|user-list|list-container/i.test(cls)
                 || el.getAttribute('data-tribute') != null;
    if (!looksMenu) continue;
    if (r.height > 400 || r.width > 500) continue; // 排除大容器
    out.push({ cls: cls.slice(0,120), text: norm(el.textContent).slice(0,120), rect: { x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height) } });
    if (out.length >= 8) break;
  }
  return { menus: out };
})()`;

interface ReadBack {
  found: boolean;
  textContent?: string;
  innerText?: string;
  html?: string;
}

type Session = Awaited<ReturnType<typeof attachToPage>>;

async function activateEditor(session: Session): Promise<{ cx: number; cy: number } | null> {
  const entry = await evalJson<{ error?: string; x?: number; y?: number }>(session.cdp, ENTRY_JS);
  if (entry.error || entry.x == null || entry.y == null) {
    log('activate_fail', { entry });
    return null;
  }
  await dispatchClick(session.cdp, entry.x, entry.y);
  await sleep(600);
  const loc = await evalJson<{ found: boolean; cx?: number; cy?: number }>(session.cdp, EDITOR_LOCATE_JS);
  if (!loc.found || loc.cx == null || loc.cy == null) {
    log('editor_not_found', { loc });
    return null;
  }
  await dispatchClick(session.cdp, loc.cx, loc.cy);
  await sleep(250);
  return { cx: loc.cx, cy: loc.cy };
}

/** 用给定方式敲入 code → 读回 → 扫下拉 → 清空，返回一条对照记录。 */
async function trial(session: Session, method: 'keystrokes' | 'insertText', code: string) {
  await evalJson(session.cdp, EDITOR_CLEAR_JS);
  await sleep(150);
  if (method === 'keystrokes') await dispatchKeystrokes(session.cdp, code);
  else await insertText(session.cdp, code);
  await sleep(500);
  const menusMid = await evalJson<{ menus: unknown[] }>(session.cdp, DROPDOWN_SCAN_JS);
  const back = await evalJson<ReadBack>(session.cdp, EDITOR_READ_RAW_JS);
  const readback = back.textContent ?? '';
  // 比对：编辑器 contenteditable 可能把 \n 转 <br>/<div>，故同时给 textContent 与 innerText、以及「去换行后」的宽松比对。
  const exactMatch = readback === code;
  const looseMatch = readback.replace(/\s+/g, '') === code.replace(/\s+/g, '');
  const record = {
    method,
    input: code,
    readbackTextContent: readback,
    readbackInnerText: back.innerText ?? '',
    readbackHtml: back.html ?? '',
    exactMatch,
    looseMatch,
    menusDuringType: menusMid.menus,
  };
  log('trial_result', { method, exactMatch, looseMatch, menuCount: menusMid.menus.length });
  await evalJson(session.cdp, EDITOR_CLEAR_JS);
  await sleep(150);
  return record;
}

async function main(): Promise<void> {
  if (hasFlag('help')) {
    console.log('see header of scripts/comment-verbatim-probe.ts; READ-ONLY, never submits.');
    return;
  }
  const ts = Date.now();
  const host = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
  const port = Number(process.env.AIDCP_CDP_PORT ?? 9222);
  const urlIncludes = process.env.AIDCP_PAGE_URL ?? 'xiaohongshu';

  const defaultCode = '2【长按复制】加群 :/#f🐶🍅🐤';
  const code = hasFlag('multiline')
    ? `${readArg('code') ?? defaultCode}\n第二行：戳我进群🍟`
    : readArg('code') ?? defaultCode;

  log('probe_start', { ts, host, port, urlIncludes, code, containsAt: code.includes('@'), containsHash: code.includes('#'), multiline: code.includes('\n') });

  const session = await attachToPage({ host, port, urlIncludes });
  await session.cdp.send('Input.enable').catch(() => undefined);

  const records: unknown[] = [];
  try {
    const editor = await activateEditor(session);
    if (!editor) {
      log('abort', { reason: 'could_not_activate_editor', hint: '先手动点开一篇笔记详情、确保评论栏可见' });
      return;
    }
    // 方式一：逐字符（= 生产 executeComment 的方式）——最可能暴露 @/# 补全劫持。
    records.push(await trial(session, 'keystrokes', code));
    // 重新落 caret（清空后 caret 可能丢）。
    await dispatchClick(session.cdp, editor.cx, editor.cy);
    await sleep(200);
    // 方式二：单次整段插入（= 备选方案 B）。
    records.push(await trial(session, 'insertText', code));

    const jsonPath = `/tmp/aidcp-comment-verbatim-probe-${ts}.json`;
    writeFileSync(jsonPath, JSON.stringify({ ts, code, records }, null, 2));
    log('done', {
      artifact: jsonPath,
      hint: '把该 json 发回来 → 定 D5：逐字 exactMatch 且无 menu → 云端规整；逐字失配但整段 exactMatch → 边缘整段插入。',
    });
  } catch (err) {
    log('probe_error', { message: (err as Error).message });
    process.exitCode = 1;
  } finally {
    // 兜底清空，绝不留半截输入、绝不提交。
    await evalJson(session.cdp, EDITOR_CLEAR_JS).catch(() => undefined);
    session.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
