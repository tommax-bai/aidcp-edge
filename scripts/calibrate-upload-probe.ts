/**
 * calibrate-upload-probe.ts — 用真实 CDP 文件输入桥上传一张测试图，再只读探测图文编辑器/成功态/封面节点。
 * publish-media-upload task-0：验证 0.1（setFileInputFiles 真填充+缩略图渲染）+ 0.2（编辑器是否被传图门控）+ 0.3（成功态/封面选择器）。
 *
 * 红线：只上传一张测试图到草稿编辑器；**绝不点击 发布/提交**，结束后导航离开丢弃，不产生任何公开发布。
 */

import { attachToPage } from '../src/cdp/index.js';

const PORT = Number(process.env.AIDCP_CDP_PORT ?? 9222);
const HOST = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
const IMG = process.env.AIDCP_CALIB_IMG ?? '/tmp/aidcp-calib.png';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 确保处于图文模式（图片 input 的 accept 含 jpg）；否则点「上传图文」。
const ENSURE_IMG_MODE = String.raw`(() => {
  const fi = document.querySelector('input[type=file]');
  const accept = fi && fi.getAttribute('accept') || '';
  if (/jpg|png|webp/i.test(accept)) return { already: true, accept };
  const tab = Array.from(document.querySelectorAll('div,span'))
    .find((e) => (e.innerText||'').trim() === '上传图文' && (e.className||'').includes('creator-tab'));
  if (tab) { tab.scrollIntoView({block:'center'}); tab.click(); return { clicked: true }; }
  return { clicked: false };
})()`;

// 上传后只读采集：编辑器 / 缩略图 / 封面 / 发布按钮（只记录、绝不点）。
const POST_UPLOAD = String.raw`(() => {
  const visible = (el) => { try { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return !(s.display==='none'||s.visibility==='hidden'||(r.width===0&&r.height===0)); } catch { return false; } };
  const path = (el) => { const p=[]; let c=el; for(let d=0;c&&c.nodeType===1&&d<6;d++){ let s=c.tagName.toLowerCase(); if(c.id){s+='#'+c.id;p.unshift(s);break;} const cl=(typeof c.className==='string'&&c.className.trim())?'.'+c.className.trim().split(/\s+/).slice(0,3).join('.'):''; p.unshift(s+cl); c=c.parentElement;} return p.join(' > '); };
  const samp = (el) => ({ tag: el.tagName.toLowerCase(), cls: (typeof el.className==='string'?el.className:null), placeholder: el.getAttribute&&el.getAttribute('placeholder'), contenteditable: el.getAttribute&&el.getAttribute('contenteditable'), hidden: !visible(el), text: (el.innerText||'').trim().slice(0,40), path: path(el) });
  const all = (s) => { try { return Array.from(document.querySelectorAll(s)); } catch { return []; } };
  const editables = all('[contenteditable=true], textarea, input[type=text]').map(samp);
  const imgs = all('.upload-content img, .img-container img, [class*=preview] img, [class*=img] img').slice(0,8).map((e)=>({src:(e.getAttribute('src')||'').slice(0,30), path: path(e), hidden:!visible(e)}));
  const thumbs = all('[class*=thumb i], [class*=preview i], [class*=img-wrapper i], [class*=image-item i], [class*=success i]').slice(0,12).map(samp);
  const coverish = all('[class*=cover i], [class*=封面]').slice(0,12).map(samp);
  const publishBtns = all('button, [role=button], div').filter((e)=>{const t=(e.innerText||'').trim(); return (t==='发布'||t==='发布笔记'||t==='提交')&&t.length<=6;}).slice(0,5).map(samp);
  const fi = document.querySelector('input[type=file]');
  return {
    href: location.href,
    fileInputAccept: fi && fi.getAttribute('accept'),
    fileInputFilesLen: fi ? fi.files.length : null,
    editableCount: editables.length, editables,
    imgs, thumbs, coverish, publishBtns,
    bodyTextHead: (document.body.innerText||'').replace(/\n+/g,' / ').slice(0,300),
  };
})()`;

async function main(): Promise<void> {
  console.log(`[probe] 连接 CDP ${HOST}:${PORT}；上传测试图 ${IMG}（绝不发布）...`);
  const session = await attachToPage({ host: HOST, port: PORT, urlIncludes: 'xiaohongshu', stealth: false });
  try {
    const mode = await session.cdp.send<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression: ENSURE_IMG_MODE, returnByValue: true });
    console.log('[probe] 模式:', JSON.stringify(mode.result?.value));
    await sleep(1500);

    // 复用 CdpFileInputSetter 同款机制：DOM.enable → objectId → setFileInputFiles。
    await session.cdp.send('DOM.enable');
    const got = await session.cdp.send<{ result?: { objectId?: string } }>('Runtime.evaluate', {
      expression: "document.querySelector('input[type=file]')",
      returnByValue: false,
    });
    const objectId = got.result?.objectId;
    if (!objectId) { console.error('[probe] 未拿到文件输入 objectId'); return; }
    await session.cdp.send('DOM.setFileInputFiles', { files: [IMG], objectId });
    console.log('[probe] setFileInputFiles 已下发，等编辑器/缩略图渲染...');
    await sleep(4000);

    const res = await session.cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression: POST_UPLOAD, returnByValue: true });
    if (res.exceptionDetails) { console.error('[probe] evaluate 异常:', JSON.stringify(res.exceptionDetails)); return; }
    console.log('\n===== POST-UPLOAD PROBE (read-only; NOT published) =====\n');
    console.log(JSON.stringify(res.result?.value, null, 2));
    console.log('\n===== END =====');
  } finally {
    session.close();
  }
}

main().catch((err) => { console.error('[probe] 失败:', err instanceof Error ? err.message : String(err)); process.exitCode = 1; });
