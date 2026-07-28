import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import { readFacebookRouterSource } from './facebook-router-source.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFacebookRouterSource(repoRoot);
const run = Function(`return (${source})`)() as (
  input: { kind: string; params: Record<string, unknown> },
) => Promise<{ effectPhase: string; output: { kind: string; value: Record<string, unknown> } }>;

function install(html: string, url = 'https://www.facebook.com/'): JSDOM {
  const dom = new JSDOM(html, { url });
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1_440 });
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 800 });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    getSelection: dom.window.getSelection.bind(dom.window),
    innerHeight: 800,
    innerWidth: 1_440,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40 }),
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { value: () => undefined });
  Object.defineProperty(dom.window, 'scrollBy', { value: () => undefined });
  return dom;
}

/** 良性对话框（聊天弹窗/加载浮层）——首页常年挂着，且与 cookie 同意毫无关系。 */
const BENIGN_DIALOG = `
  <div role="dialog" aria-label="Chat with Alice">
    <div>Alice: hello there</div>
    <div role="button" aria-label="Close chat">Close</div>
  </div>
`;

/** 真实同意条常见形态：**非对话框**的底部横幅。 */
const CONSENT_BANNER = `
  <div id="consent-banner">
    <div>我们使用 cookie 政策来提供更好的服务。</div>
    <div role="button" aria-label="允许所有 Cookie">允许所有 Cookie</div>
    <div role="button" aria-label="仅允许必要 Cookie">仅允许必要 Cookie</div>
  </div>
`;

test('consent scope stays document-wide when the only visible dialog carries no cookie copy', async () => {
  install(`<main>${BENIGN_DIALOG}${CONSENT_BANNER}</main>`);

  const result = await run({ kind: 'consent_probe', params: {} });
  const value = result.output.value;

  assert.equal(result.output.kind, 'consent_probe');
  assert.equal(value.present, true, '同意条在场时 present 必须为真');
  assert.notEqual(value.acceptAll, null, '良性对话框绝不能把接受全部按钮挡在采集框外');
  assert.notEqual(value.necessaryOnly, null, '良性对话框绝不能把仅必要按钮挡在采集框外');
});

test('consent scope narrows to the dialog that itself carries the cookie copy', async () => {
  install(`
    <main>
      ${BENIGN_DIALOG}
      <div role="dialog" aria-label="Cookies">
        <div>Allow the use of cookies on this site?</div>
        <div role="button" aria-label="Allow all cookies">Allow all cookies</div>
      </div>
    </main>
  `);

  const value = (await run({ kind: 'consent_probe', params: {} })).output.value;

  assert.equal(value.present, true);
  assert.notEqual(value.acceptAll, null);
});

test('cookie copy without any acceptable button is not a consent overlay', async () => {
  install(`
    <main>
      <div>本页说明了我们的 cookie 政策，但没有任何接受按钮。</div>
      <div role="button" aria-label="Learn more">Learn more</div>
    </main>
  `);

  const value = (await run({ kind: 'consent_probe', params: {} })).output.value;

  assert.equal(
    value.present,
    false,
    '按钮词表全 miss 时判「无同意条」放行，绝不把全部受闸动作判成 blocked_by_consent',
  );
});

test('a login wall that mentions cookies is still classified as login, not consent', async () => {
  install(
    `<main>
       <div>登录 Facebook 继续。我们的 cookie 政策适用于本页。</div>
       <div role="button" aria-label="Log In">Log In</div>
     </main>`,
    'https://www.facebook.com/',
  );

  const probe = (await run({ kind: 'page_probe', params: {} })).output.value;

  assert.equal(probe.blockingKind, 'login', '带 cookie 文案的登录墙必须仍拿到 login_required');
});

test('a real consent banner keeps priority over the login wording inside it', async () => {
  install(`
    <main>
      <div id="consent-banner">
        <div>登录 Facebook 前请先阅读我们的 cookie 政策。</div>
        <div role="button" aria-label="允许所有 Cookie">允许所有 Cookie</div>
      </div>
    </main>
  `);

  const consent = (await run({ kind: 'consent_probe', params: {} })).output.value;
  const probe = (await run({ kind: 'page_probe', params: {} })).output.value;

  assert.equal(consent.present, true);
  assert.notEqual(probe.blockingKind, 'login', '同意条正文含「登录 Facebook」字样仍判同意条');
});

test('captcha and login paths still outrank the consent probe', async () => {
  install(
    `<main>
       <div>请进行人机身份验证。我们的 cookie 政策适用。</div>
       <div role="button" aria-label="允许所有 Cookie">允许所有 Cookie</div>
     </main>`,
  );
  assert.equal((await run({ kind: 'consent_probe', params: {} })).output.value.present, false);

  install(
    `<main>
       <div>cookie 政策</div>
       <div role="button" aria-label="允许所有 Cookie">允许所有 Cookie</div>
     </main>`,
    'https://www.facebook.com/login/',
  );
  assert.equal((await run({ kind: 'consent_probe', params: {} })).output.value.present, false);
});

test('duplicate accept buttons stay ambiguous until the pending ruling lands', async () => {
  install(`
    <main>
      <div>cookie 政策</div>
      <div role="button" aria-label="允许所有 Cookie">允许所有 Cookie</div>
      <div role="button" aria-label="允许所有 Cookie">允许所有 Cookie</div>
    </main>
  `);

  const value = (await run({ kind: 'consent_probe', params: {} })).output.value;

  assert.equal(value.acceptAllAmbiguous, true);
  assert.equal(value.acceptAll, null, '同文案按钮不唯一时保持停手（§待裁定 1 未裁定前不得放宽）');
});

test('the consent probe fragment never reintroduces the first-visible-dialog scope', async () => {
  const fragment = await readFile(
    resolve(repoRoot, 'native/page-engine/src/facebook-router/05-session.js'),
    'utf8',
  );
  assert.ok(
    !fragment.includes(`first(['[role="dialog"]','[aria-modal="true"]'])||document`),
    '采集框绝不能回落成「首个可见对话框」——那会把受闸动作全判成 blocked_by_consent',
  );
});
