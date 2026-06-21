import { attachToPage } from '../src/cdp/index.js';
async function main() {
  const s = await attachToPage({ host: '127.0.0.1', port: 9222, urlIncludes: 'xiaohongshu', stealth: false });
  try {
    await s.cdp.send('Page.navigate', { url: 'about:blank' });
    await new Promise((r) => setTimeout(r, 1000));
    console.log('[cleanup] navigated to about:blank — 测试草稿丢弃，从未发布');
  } finally {
    s.close();
  }
}
main().catch((e) => { console.error('[cleanup] err:', e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
