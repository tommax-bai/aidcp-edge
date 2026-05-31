/**
 * 手动验证脚本：在真实浏览器中检查反检测注入是否生效。
 *
 * 用途：人工在已启动的本机 Chrome（--remote-debugging-port=9222）里，附着一个 page、
 * 注入 StealthInjector，然后导航到 bot 检测站点（默认 bot.sannysoft.com），最后在页面
 * 内读取若干关键指标（webdriver / plugins / languages / window.chrome / permissions），
 * 打印到控制台，便于人工对照检测页结果。
 *
 * 这不是单元测试（不进 `npm test`），而是一次性手动诊断工具。
 *
 * 前置：先启动 Chrome（headful，建议）：
 *   chrome --remote-debugging-port=9222 --user-data-dir=<某 profile>
 * 或直接 `npm start` 让 chrome-launcher 拉起，再在另一个终端跑本脚本。
 *
 * 运行：
 *   npx tsx test/manual/check-stealth.ts
 *   # 可选：自定义检测站点
 *   AIDCP_STEALTH_CHECK_URL=https://bot.sannysoft.com npx tsx test/manual/check-stealth.ts
 *
 * 环境变量：
 *   AIDCP_CDP_HOST          CDP host（默认 127.0.0.1）
 *   AIDCP_CDP_PORT          CDP 端口（默认 9222）
 *   AIDCP_STEALTH_CHECK_URL 要打开的检测页（默认 https://bot.sannysoft.com）
 */

import { attachToPage } from '../../src/cdp/index.js';

interface EvaluateResult {
  result?: { type: string; value?: unknown };
  exceptionDetails?: { text: string };
}

async function evalJson<T>(
  cdp: { send<R = unknown>(m: string, p?: Record<string, unknown>): Promise<R> },
  expression: string,
): Promise<T> {
  const res = await cdp.send<EvaluateResult>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`evaluate 失败: ${res.exceptionDetails.text}`);
  }
  const value = res.result?.value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }
  return value as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const host = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
  const port = Number(process.env.AIDCP_CDP_PORT ?? 9222);
  const checkUrl = process.env.AIDCP_STEALTH_CHECK_URL ?? 'https://bot.sannysoft.com';

  console.log(`[check-stealth] 附着到 Chrome CDP ${host}:${port}（将自动注入反检测脚本）...`);
  const session = await attachToPage({ host, port });

  console.log(`[check-stealth] 导航到检测页：${checkUrl}`);
  await session.cdp.send('Page.navigate', { url: checkUrl });

  // 等页面与检测脚本跑一会儿
  await sleep(4000);

  // 在页面内采集关键指标（这些值反映注入是否生效）。
  const report = await evalJson<Record<string, unknown>>(
    session.cdp,
    `JSON.stringify((function () {
      var out = {};
      try { out.webdriver = navigator.webdriver; } catch (e) { out.webdriver = 'ERR'; }
      try { out.languages = navigator.languages; } catch (e) { out.languages = 'ERR'; }
      try { out.pluginsLength = navigator.plugins ? navigator.plugins.length : 0; } catch (e) { out.pluginsLength = 'ERR'; }
      try { out.hasWindowChrome = !!window.chrome; } catch (e) { out.hasWindowChrome = 'ERR'; }
      try { out.hasChromeRuntime = !!(window.chrome && window.chrome.runtime); } catch (e) { out.hasChromeRuntime = 'ERR'; }
      try {
        out.functionToStringNative =
          Function.prototype.toString.call(Function.prototype.toString).indexOf('[native code]') !== -1;
      } catch (e) { out.functionToStringNative = 'ERR'; }
      return out;
    })())`,
  );

  // permissions.query 是异步的，单独取
  const notifPerm = await evalJson<string>(
    session.cdp,
    `navigator.permissions.query({name:'notifications'}).then(function(s){return s.state;}).catch(function(){return 'ERR';})`,
  );

  console.log('[check-stealth] —— 页面内指标 ——');
  console.log('  navigator.webdriver        =', report.webdriver, '(期望 undefined)');
  console.log('  navigator.languages        =', JSON.stringify(report.languages), '(期望非空)');
  console.log('  navigator.plugins.length   =', report.pluginsLength, '(期望 > 0)');
  console.log('  window.chrome 存在         =', report.hasWindowChrome, '(期望 true)');
  console.log('  window.chrome.runtime 存在 =', report.hasChromeRuntime, '(期望 true)');
  console.log('  Function.toString 原生外观 =', report.functionToStringNative, '(期望 true)');
  console.log("  notifications permission   =", notifPerm, "(期望非 'denied')");
  console.log(
    `\n[check-stealth] 请同时在浏览器窗口中肉眼核对 ${checkUrl} 的检测表（应无明显红色自动化标记）。`,
  );
  console.log('[check-stealth] 脚本结束（保留浏览器供人工查看，未关闭 CDP 连接）。');

  // 不关闭 session/浏览器：方便人工继续在页面上核对检测表。
}

main().catch((err) => {
  console.error('[check-stealth] 失败:', err);
  process.exitCode = 1;
});
