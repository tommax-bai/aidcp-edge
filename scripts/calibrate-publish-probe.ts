/**
 * calibrate-publish-probe.ts — publish-media-upload task-0 实机校准探针（**严格只读**）。
 *
 * 连到已登录小红书创作平台发布页的 Chrome（CDP），只跑 Runtime.evaluate 读 DOM，
 * 采集：登录态 / 文件输入形状（静态 vs 懒加载、是否隐藏、selector）/ 标题·正文编辑器是否在
 * （判编辑器是否被"先传图"门控）/ 封面·缩略图候选节点。
 *
 * 红线：本脚本 **绝不点击、绝不输入、绝不上传、绝不发布**——只 evaluate 读取。
 *
 * 用法：
 *   1) 先用 scripts 旁的命令起一个带调试端口的 Chrome 并人工登录小红书、停在发布页。
 *   2) AIDCP_CDP_PORT=9222 npx tsx scripts/calibrate-publish-probe.ts
 */

import { attachToPage } from '../src/cdp/index.js';

const PORT = Number(process.env.AIDCP_CDP_PORT ?? 9222);
const HOST = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';

// 只读采集表达式（IIFE，returnByValue 取回 JSON）。绝不触发任何交互。
export const PROBE_EXPRESSION = String.raw`(() => {
  const visible = (el) => {
    try {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return !(s.display === 'none' || s.visibility === 'hidden' || (r.width === 0 && r.height === 0));
    } catch { return false; }
  };
  const cssPath = (el) => {
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 5; depth++) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { part += '#' + cur.id; parts.unshift(part); break; }
      const cls = (cur.className && typeof cur.className === 'string')
        ? '.' + cur.className.trim().split(/\s+/).slice(0, 3).join('.')
        : '';
      part += cls;
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const sample = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    cls: (typeof el.className === 'string' ? el.className : null),
    name: el.getAttribute && el.getAttribute('name'),
    type: el.getAttribute && el.getAttribute('type'),
    accept: el.getAttribute && el.getAttribute('accept'),
    multiple: el.hasAttribute && el.hasAttribute('multiple'),
    placeholder: el.getAttribute && el.getAttribute('placeholder'),
    contenteditable: el.getAttribute && el.getAttribute('contenteditable'),
    dataActionId: el.getAttribute && el.getAttribute('data-action-id'),
    hidden: !visible(el),
    text: (el.innerText || '').trim().slice(0, 50),
    path: cssPath(el),
  });
  const all = (sel) => { try { return Array.from(document.querySelectorAll(sel)); } catch { return []; } };
  const byText = (kws) => all('button, [role=button], div, span, a')
    .filter((e) => { const t = (e.innerText || '').trim(); return t.length <= 20 && kws.some((k) => t.includes(k)); })
    .slice(0, 8).map(sample);

  const fileInputs = all('input[type=file]').map(sample);
  const editables = all('[contenteditable=true], textarea, input[type=text]').map(sample);
  const bodyText = (document.body && document.body.innerText || '');

  return {
    href: location.href,
    title: document.title,
    looksLoggedIn: !/登录|扫码登录|手机号登录|passport/i.test(bodyText.slice(0, 200)) && !/login|passport/i.test(location.href),
    bodyTextHead: bodyText.slice(0, 240),
    // 0.1 文件输入：静态存在=非懒加载；hidden=true 是正常的（隐藏 input 仍可 setFileInputFiles）。
    fileInput: { count: fileInputs.length, items: fileInputs },
    // 0.2 编辑器是否在（无需先传图）：有标题/正文可编辑控件 → 未被图门控。
    editable: { count: editables.length, items: editables.slice(0, 12) },
    // 上传入口候选（懒加载时点它才出 input；本探针只列、不点）。
    uploadEntries: byText(['上传', '上传图片', '上传图文', '点击上传', '拖拽', '添加图片', '选择图片']),
    // 0.3 封面/缩略图/预览候选（供成功态选择器校准）。
    coverPreviewCandidates: all('[class*=cover i],[class*=preview i],[class*=thumb i],[class*=封面],[class*=upload-success]')
      .slice(0, 12).map(sample),
  };
})()`;

async function main(): Promise<void> {
  console.log(`[probe] 连接 CDP ${HOST}:${PORT}（只读，绝不交互）...`);
  const session = await attachToPage({ host: HOST, port: PORT, urlIncludes: 'xiaohongshu', stealth: false });
  try {
    const res = await session.cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      { expression: PROBE_EXPRESSION, returnByValue: true },
    );
    if (res.exceptionDetails) {
      console.error('[probe] evaluate 抛异常:', JSON.stringify(res.exceptionDetails, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log('\n===== PUBLISH PAGE PROBE (read-only) =====\n');
    console.log(JSON.stringify(res.result?.value, null, 2));
    console.log('\n===== END =====');
  } finally {
    session.close();
  }
}

main().catch((err) => {
  console.error('[probe] 失败:', err instanceof Error ? err.message : String(err));
  console.error('  提示：确认已起带 --remote-debugging-port 的 Chrome、已登录小红书、并停在发布页。');
  process.exitCode = 1;
});
