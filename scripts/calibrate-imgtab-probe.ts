/**
 * calibrate-imgtab-probe.ts — 切到「上传图文」标签后再只读探测（publish-media-upload task-0）。
 *
 * 发布页默认在「上传视频」标签，图文文件输入在「上传图文」标签下。本脚本：
 *   1) 只读取「上传图文」标签的坐标；
 *   2) 用 Input.dispatchMouseEvent 点一下该标签（仅切换上传模式——production 的 select_mode 同款，绝不发布）；
 *   3) 等渲染后重跑只读采集，输出图文模式下的文件输入/编辑器/封面候选。
 *
 * 红线：只点「上传图文」标签这一下，**绝不**点击/输入/上传/提交任何会产生发布的元素。
 */

import { attachToPage } from '../src/cdp/index.js';
import { PROBE_EXPRESSION } from './calibrate-publish-probe.js';

const PORT = Number(process.env.AIDCP_CDP_PORT ?? 9222);
const HOST = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';

// 切到「上传图文」：复用 production CdpActionExecutor 同款 in-page el.click()（synthetic click，XHS 实测可用）。
const CLICK_IMG_TAB = String.raw`(() => {
  const tabs = Array.from(document.querySelectorAll('div, span, [role=tab], [role=button]'));
  const tab = tabs.find((e) => (e.innerText || '').trim() === '上传图文' && (e.className || '').includes('creator-tab'))
    || tabs.find((e) => (e.innerText || '').trim() === '上传图文' && (e.className || '').includes('tab'))
    || tabs.find((e) => (e.innerText || '').trim() === '上传图文');
  if (!tab) return { clicked: false, reason: 'not_found' };
  try { tab.scrollIntoView({ block: 'center' }); } catch {}
  tab.click();
  return { clicked: true, tag: tab.tagName, cls: tab.className };
})()`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log(`[probe] 连接 CDP ${HOST}:${PORT} ...`);
  const session = await attachToPage({ host: HOST, port: PORT, urlIncludes: 'xiaohongshu', stealth: false });
  try {
    const clicked = await session.cdp.send<{ result?: { value?: { clicked: boolean; cls?: string; reason?: string } } }>(
      'Runtime.evaluate',
      { expression: CLICK_IMG_TAB, returnByValue: true },
    );
    console.log('[probe] 切换「上传图文」:', JSON.stringify(clicked.result?.value));
    await sleep(2000);

    const res = await session.cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      { expression: PROBE_EXPRESSION, returnByValue: true },
    );
    if (res.exceptionDetails) {
      console.error('[probe] evaluate 抛异常:', JSON.stringify(res.exceptionDetails, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log('\n===== IMG-TAB PUBLISH PAGE PROBE (read-only) =====\n');
    console.log(JSON.stringify(res.result?.value, null, 2));
    console.log('\n===== END =====');
  } finally {
    session.close();
  }
}

main().catch((err) => {
  console.error('[probe] 失败:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
