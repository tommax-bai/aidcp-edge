import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { readFacebookRouterSource } from './facebook-router-source.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFacebookRouterSource(repoRoot);
const run = Function(`return (${source})`)() as (
  input: { kind: string; params: Record<string, unknown> },
) => Promise<{
  effectPhase: string;
  output: { kind: string; value: Record<string, unknown> };
}>;

function install(
  html: string,
  url: string,
  serverEpochMs = 1_800_000_015_000,
  serverTimeRttMs = 0,
  documentAgeMs = 2_000,
): JSDOM {
  const dom = new JSDOM(html, { url });
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1_440 });
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 900 });
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
    innerHeight: 900,
    innerWidth: 1_440,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 40,
      width: 100,
      height: 40,
    }),
  });
  Object.defineProperty(dom.window.document, 'elementFromPoint', {
    configurable: true,
    value: (x: number, y: number) => Array.from(dom.window.document.querySelectorAll('*'))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      })
      .at(-1) ?? null,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(dom.window, 'fetch', {
    configurable: true,
    value: async () => {
      monotonicNow += serverTimeRttMs;
      return {
        headers: {
          get: (name: string) => name.toLowerCase() === 'date'
            ? new Date(serverEpochMs).toUTCString()
            : null,
        },
      };
    },
  });
  let monotonicNow = documentAgeMs;
  Object.defineProperty(dom.window.performance, 'now', {
    configurable: true,
    value: () => monotonicNow,
  });
  return dom;
}

function setRect(
  element: Element,
  { left, top, right, bottom }: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  },
): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: left,
      y: top,
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    }),
  });
}

async function probe(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await run({
    kind: 'auth_probe',
    params: { targetId: 'facebook-target-1', authenticated: false, ...params },
  });
  assert.equal(result.effectPhase, 'confirmed');
  assert.equal(result.output.kind, 'facebook_auth_observation');
  return result.output.value;
}

test('auth probe emits one target/document-bound login signal only after AdsPower filled both fields', async () => {
  install(`
    <form>
      <input name="email" type="email" value="filled@example.test">
      <input name="pass" type="password" value="filled-password">
      <button name="login">Log in</button>
    </form>
  `, 'https://www.facebook.com/login/');
  const button = document.querySelector('button')!;
  setRect(button, { left: 200, top: 200, right: 320, bottom: 245 });

  const first = await probe();
  const second = await probe();

  assert.equal(first.signal, 'login_submit_ready');
  assert.match(String(first.signalId), /^aidcp:facebook-auth:v1:[0-9a-f]{64}$/);
  assert.equal(second.signalId, first.signalId);
  assert.equal('username' in first, false);
  assert.equal('password' in first, false);
});

test('login hydration waits before empty credentials fail closed, while ambiguity blocks immediately', async () => {
  install(`
    <form>
      <input name="email" type="email" value="">
      <input name="pass" type="password" value="">
      <button name="login">Log in</button>
    </form>
  `, 'https://www.facebook.com/login/', 1_800_000_015_000, 0, 500);
  const pending = await probe();
  assert.equal(pending.signal, 'none');
  assert.equal(pending.reason, 'credential_fill_pending');
  assert.equal(pending.signalId, undefined);

  install(`
    <form>
      <input name="email" type="email" value="">
      <input name="pass" type="password" value="">
      <button name="login">Log in</button>
    </form>
  `, 'https://www.facebook.com/login/', 1_800_000_015_000, 0, 2_000);
  const empty = await probe();
  assert.equal(empty.signal, 'manual_login_required');
  assert.equal(empty.reason, 'credential_fill_unavailable');
  assert.equal(empty.signalId, undefined);

  install(`
    <form><input name="email" value="a"><input name="pass" type="password" value="b"><button name="login">Log in</button></form>
    <form><input name="email" value="c"><input name="pass" type="password" value="d"><button name="login">Log in</button></form>
  `, 'https://www.facebook.com/login/');
  const ambiguous = await probe();
  assert.equal(ambiguous.signal, 'blocked_unknown');
  assert.equal(ambiguous.reason, 'login_form_ambiguous');
  assert.equal(ambiguous.signalId, undefined);
});

test('login and TOTP routes without hydrated fields remain transitional', async () => {
  install('<main></main>', 'https://www.facebook.com/login/');
  const login = await probe();
  assert.equal(login.signal, 'none');
  assert.equal(login.reason, 'login_form_hydrating');
  assert.equal(login.signalId, undefined);

  install(
    '<main><h1>Two-factor authentication</h1></main>',
    'https://www.facebook.com/two_step_verification/two_factor/',
  );
  const totp = await probe();
  assert.equal(totp.signal, 'none');
  assert.equal(totp.reason, 'totp_input_hydrating');
  assert.equal(totp.signalId, undefined);
});

test('TOTP probe uses exact associated labels and keeps long URL generations bounded', async () => {
  const longQuery = `flow=${'a'.repeat(734)}`;
  install(`
    <main>
      <label for="_r_3_">Code</label>
      <input id="_r_3_" type="text" autocomplete="off" value="">
      <div role="button">Continue</div>
    </main>
  `, `https://www.facebook.com/two_step_verification/two_factor/?${longQuery}`);
  const input = document.getElementById('_r_3_') as HTMLInputElement;
  setRect(input, { left: 100, top: 100, right: 300, bottom: 145 });

  const first = await probe();
  const unchanged = await probe();
  assert.equal(first.signal, 'totp_entry_ready');
  assert.match(String(first.documentGeneration), /^v1:[0-9a-f]{64}$/);
  assert.equal(String(first.documentGeneration).length, 67);
  assert.equal(String(first.documentGeneration).includes(longQuery), false);
  assert.equal(unchanged.documentGeneration, first.documentGeneration);
  assert.equal(unchanged.signalId, first.signalId);

  history.pushState({}, '', `${location.pathname}?flow=${'b'.repeat(734)}`);
  const changedRoute = await probe();
  assert.equal(changedRoute.signal, 'totp_entry_ready');
  assert.notEqual(changedRoute.documentGeneration, first.documentGeneration);
  assert.notEqual(changedRoute.signalId, first.signalId);
});

test('TOTP associated-label fallback supports wrapping labels and rejects nearby or ambiguous text', async () => {
  install(`
    <main>
      <label>Security code<input id="wrapped" type="text" autocomplete="off" value=""></label>
    </main>
  `, 'https://www.facebook.com/two_step_verification/two_factor/');
  const wrappedInput = document.getElementById('wrapped') as HTMLInputElement;
  setRect(wrappedInput, { left: 100, top: 100, right: 300, bottom: 145 });
  assert.equal((await probe()).signal, 'totp_entry_ready');

  install(`
    <main>
      <p>Enter the login code</p>
      <input id="unlabelled" type="text" autocomplete="off" value="">
    </main>
  `, 'https://www.facebook.com/two_step_verification/two_factor/');
  const unlabelled = await probe();
  assert.equal(unlabelled.signal, 'none');
  assert.equal(unlabelled.reason, 'totp_input_hydrating');

  install(`
    <main>
      <label for="first">Code</label><input id="first" type="text" autocomplete="off" value="">
      <label for="second">Code</label><input id="second" type="text" autocomplete="off" value="">
    </main>
  `, 'https://www.facebook.com/two_step_verification/two_factor/');
  const ambiguous = await probe();
  assert.equal(ambiguous.signal, 'blocked_unknown');
  assert.equal(ambiguous.reason, 'totp_input_ambiguous');
  assert.equal(ambiguous.signalId, undefined);
});

test('obscured login target and CAPTCHA dispatch no actionable signal', async () => {
  install(`
    <form>
      <input name="email" value="filled">
      <input name="pass" type="password" value="filled">
      <button name="login">Log in</button>
    </form>
    <div id="cover"></div>
  `, 'https://www.facebook.com/login/');
  const button = document.querySelector('button')!;
  const cover = document.getElementById('cover')!;
  setRect(button, { left: 200, top: 200, right: 320, bottom: 245 });
  setRect(cover, { left: 200, top: 200, right: 320, bottom: 245 });
  const obscured = await probe();
  assert.equal(obscured.signal, 'blocked_unknown');
  assert.equal(obscured.reason, 'auth_target_not_topmost');
  assert.equal(obscured.signalId, undefined);

  install(`
    <iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>
    <form>
      <input name="email" value="filled">
      <input name="pass" type="password" value="filled">
      <button name="login">Log in</button>
    </form>
  `, 'https://www.facebook.com/login/');
  const captcha = await probe();
  assert.equal(captcha.signal, 'blocked_human_verification');
  assert.equal(captcha.signalId, undefined);
});

test('TOTP entry, submit, and refresh are separate server-time signals', async () => {
  const windowStart = 1_800_000_000_000;
  install(`
    <main>
      <h1>Two-factor authentication</h1>
      <form>
        <input id="code" autocomplete="one-time-code" inputmode="numeric" value="">
        <button id="continue">Continue</button>
      </form>
    </main>
  `, 'https://www.facebook.com/two_step_verification/two_factor/', windowStart + 15_000);
  const input = document.getElementById('code') as HTMLInputElement;
  const submit = document.getElementById('continue')!;
  setRect(input, { left: 100, top: 100, right: 300, bottom: 145 });
  setRect(submit, { left: 100, top: 200, right: 240, bottom: 245 });

  const entry = await probe();
  assert.equal(entry.signal, 'totp_entry_ready');
  assert.equal(entry.serverEpochMs, windowStart + 15_999);

  input.value = '123456';
  const submitReady = await probe({
    enteredTotpWindowStartUnixMs: windowStart,
    enteredTotpWindowEndUnixMs: windowStart + 30_000,
  });
  assert.equal(submitReady.signal, 'totp_submit_ready');
  assert.notEqual(submitReady.signalId, entry.signalId);

  Object.defineProperty(window, 'fetch', {
    configurable: true,
    value: async () => ({
      headers: { get: () => new Date(windowStart + 21_000).toUTCString() },
    }),
  });
  const refresh = await probe({
    enteredTotpWindowStartUnixMs: windowStart,
    enteredTotpWindowEndUnixMs: windowStart + 30_000,
  });
  assert.equal(refresh.signal, 'totp_refresh_required');
  assert.notEqual(refresh.signalId, submitReady.signalId);
});

test('server Date lower and RTT-adjusted upper bounds must stay in one TOTP window', async () => {
  const windowStart = 1_800_000_000_000;
  install(`
    <main>
      <h1>Two-factor authentication</h1>
      <input id="code" autocomplete="one-time-code" value="">
    </main>
  `, 'https://www.facebook.com/two_step_verification/two_factor/', windowStart + 29_000, 2);
  const ambiguous = await probe();
  assert.equal(ambiguous.signal, 'none');
  assert.equal(ambiguous.reason, 'facebook_server_time_window_ambiguous');
  assert.equal(ambiguous.serverEpochMs, undefined);
  assert.equal(ambiguous.signalId, undefined);

  install(`
    <main>
      <h1>Two-factor authentication</h1>
      <input id="code" autocomplete="one-time-code" value="">
    </main>
  `, 'https://www.facebook.com/two_step_verification/two_factor/', windowStart + 10_000, 7);
  const bounded = await probe();
  assert.equal(bounded.signal, 'totp_entry_ready');
  assert.equal(bounded.serverEpochMs, windowStart + 11_006);
});

test('TOTP server-time failure and unknown entered window fail closed', async () => {
  install(`
    <main>
      <h1>Two-factor authentication</h1>
      <input id="code" autocomplete="one-time-code" value="">
    </main>
  `, 'https://www.facebook.com/two_step_verification/two_factor/');
  Object.defineProperty(window, 'fetch', { configurable: true, value: undefined });
  const noTime = await probe();
  assert.equal(noTime.signal, 'blocked_unknown');
  assert.equal(noTime.reason, 'facebook_server_time_unavailable');
  assert.equal(noTime.signalId, undefined);

  install(`
    <main>
      <h1>Two-factor authentication</h1>
      <input id="code" autocomplete="one-time-code" value="123456">
      <button>Continue</button>
    </main>
  `, 'https://www.facebook.com/two_step_verification/two_factor/');
  const noWindow = await probe();
  assert.equal(noWindow.signal, 'blocked_unknown');
  assert.equal(noWindow.reason, 'entered_totp_window_unavailable');
  assert.equal(noWindow.signalId, undefined);
});

test('supported post-login prompts are independent exact topmost signals', async () => {
  install(`
    <main>
      <p>We suspect automated behavior on your account</p>
      <button id="dismiss">Dismiss</button>
    </main>
  `, 'https://www.facebook.com/checkpoint/123');
  setRect(document.getElementById('dismiss')!, { left: 100, top: 100, right: 240, bottom: 145 });
  assert.equal((await probe()).signal, 'automation_warning_dismiss');

  install(`
    <div role="dialog"><button id="wrong">Dismiss</button></div>
    <main>
      <p>We suspect automated behavior on your account</p>
      <button id="right">Dismiss</button>
    </main>
  `, 'https://www.facebook.com/checkpoint/123');
  setRect(document.getElementById('wrong')!, { left: 300, top: 100, right: 440, bottom: 145 });
  setRect(document.getElementById('right')!, { left: 100, top: 100, right: 240, bottom: 145 });
  const scopedWarning = await probe();
  assert.equal(scopedWarning.signal, 'automation_warning_dismiss');
  assert.equal(
    (scopedWarning.candidate as Record<string, unknown>).cx,
    170,
  );

  install(`
    <div role="alertdialog" aria-label="Push notifications request">
      <button id="close" aria-label="Close"></button>
    </div>
  `, 'https://www.facebook.com/');
  setRect(document.getElementById('close')!, { left: 10, top: 10, right: 58, bottom: 30 });
  assert.equal((await probe()).signal, 'push_blocker_close');

  install(`
    <div role="dialog">
      <h2>Remember Password</h2>
      <button id="ok">OK</button>
    </div>
  `, 'https://www.facebook.com/');
  setRect(document.getElementById('ok')!, { left: 500, top: 500, right: 620, bottom: 545 });
  assert.equal((await probe()).signal, 'remember_password_confirm');
});

test('authenticated unproven profiles short-circuit supported prompts while fresh policy may act', async () => {
  install(`
    <main>
      <p>We suspect automated behavior on your account</p>
      <button id="dismiss">Dismiss</button>
    </main>
  `, 'https://www.facebook.com/checkpoint/123');
  setRect(document.getElementById('dismiss')!, { left: 100, top: 100, right: 240, bottom: 145 });
  assert.equal((await probe({ authenticated: true, allowAuthActions: false })).signal, 'authenticated');
  assert.equal(
    (await probe({ authenticated: true, allowAuthActions: true })).signal,
    'automation_warning_dismiss',
  );

  install(`
    <div role="alertdialog" aria-label="Push notifications request">
      <button id="close" aria-label="Close"></button>
    </div>
  `, 'https://www.facebook.com/');
  setRect(document.getElementById('close')!, { left: 10, top: 10, right: 58, bottom: 30 });
  assert.equal((await probe({ authenticated: true, allowAuthActions: false })).signal, 'authenticated');
  assert.equal(
    (await probe({ authenticated: true, allowAuthActions: true })).signal,
    'push_blocker_close',
  );

  install(`
    <div role="dialog">
      <h2>Remember Password</h2>
      <button id="ok">OK</button>
    </div>
  `, 'https://www.facebook.com/');
  setRect(document.getElementById('ok')!, { left: 500, top: 500, right: 620, bottom: 545 });
  assert.equal((await probe({ authenticated: true, allowAuthActions: false })).signal, 'authenticated');
  assert.equal(
    (await probe({ authenticated: true, allowAuthActions: true })).signal,
    'remember_password_confirm',
  );
});

test('authenticated unproven profiles still fail closed on CAPTCHA and unsupported checkpoints', async () => {
  install(
    '<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>',
    'https://www.facebook.com/',
  );
  const captcha = await probe({ authenticated: true, allowAuthActions: false });
  assert.equal(captcha.signal, 'blocked_human_verification');
  assert.equal(captcha.signalId, undefined);

  for (const url of [
    'https://www.facebook.com/checkpoint/unknown',
    'https://www.facebook.com/recover/initiate/',
    'https://www.facebook.com/disabled/',
  ]) {
    install('<main>Security check</main>', url);
    const checkpoint = await probe({ authenticated: true, allowAuthActions: false });
    assert.equal(checkpoint.signal, 'blocked_unknown');
    assert.equal(checkpoint.reason, 'unsupported_facebook_checkpoint');
    assert.equal(checkpoint.signalId, undefined);
  }

  install(`
    <main>Your account is temporarily blocked</main>
    <div role="alertdialog" aria-label="Push notifications request">
      <button id="close" aria-label="Close"></button>
    </div>
    <div role="dialog">
      <h2>Remember Password</h2>
      <button id="ok">OK</button>
    </div>
  `, 'https://www.facebook.com/');
  setRect(document.getElementById('close')!, { left: 10, top: 10, right: 58, bottom: 30 });
  setRect(document.getElementById('ok')!, { left: 500, top: 500, right: 620, bottom: 545 });
  const restricted = await probe({ authenticated: true, allowAuthActions: true });
  assert.equal(restricted.signal, 'blocked_unknown');
  assert.equal(restricted.reason, 'unsupported_facebook_auth_state');
  assert.equal(restricted.signalId, undefined);

  install(`
    <main>
      <p>We suspect automated behavior on your account</p>
      <p>Your account is temporarily blocked</p>
      <button id="dismiss">Dismiss</button>
    </main>
  `, 'https://www.facebook.com/checkpoint/123');
  setRect(document.getElementById('dismiss')!, { left: 100, top: 100, right: 240, bottom: 145 });
  const warningWithRestriction = await probe({
    authenticated: true,
    allowAuthActions: false,
  });
  assert.equal(warningWithRestriction.signal, 'blocked_unknown');
  assert.equal(warningWithRestriction.reason, 'unsupported_facebook_auth_state');
  assert.equal(warningWithRestriction.signalId, undefined);

  install(`
    <main>
      <p>We suspect automated behavior on your account</p>
      <p>The code you entered is incorrect</p>
      <button id="dismiss">Dismiss</button>
    </main>
  `, 'https://www.facebook.com/checkpoint/123');
  setRect(document.getElementById('dismiss')!, { left: 100, top: 100, right: 240, bottom: 145 });
  const warningWithRejectedCode = await probe({
    authenticated: true,
    allowAuthActions: false,
  });
  assert.equal(warningWithRejectedCode.signal, 'blocked_unknown');
  assert.equal(warningWithRejectedCode.reason, 'facebook_auth_rejected');
  assert.equal(warningWithRejectedCode.signalId, undefined);
});

test('unfamiliar checkpoint is blocked while authenticated and transitional pages remain read-only', async () => {
  install('<main>Security check</main>', 'https://www.facebook.com/checkpoint/unknown');
  const unknown = await probe();
  assert.equal(unknown.signal, 'blocked_unknown');
  assert.equal(unknown.signalId, undefined);

  install('<main>Home</main>', 'https://www.facebook.com/');
  const authenticated = await probe({ authenticated: true });
  assert.equal(authenticated.signal, 'authenticated');
  assert.equal(authenticated.signalId, undefined);

  const transitional = await probe();
  assert.equal(transitional.signal, 'none');
  assert.equal(transitional.signalId, undefined);
});

test('TOTP focus/readback helpers expose only bounded booleans and counts', async () => {
  install(`
    <main>
      <h1>Two-factor authentication</h1>
      <input id="code" autocomplete="one-time-code" value="">
      <button>Continue</button>
    </main>
  `, 'https://www.facebook.com/two_step_verification/two_factor/');
  const input = document.getElementById('code') as HTMLInputElement;
  setRect(input, { left: 100, top: 100, right: 300, bottom: 145 });
  const observation = await probe({
    enteredTotpWindowStartUnixMs: 1_800_000_000_000,
    enteredTotpWindowEndUnixMs: 1_800_000_030_000,
  });
  const candidate = observation.candidate as Record<string, unknown>;
  input.value = '123456';
  input.focus();

  const readback = await run({
    kind: 'auth_totp_readback',
    params: {
      documentGeneration: observation.documentGeneration,
      candidateKey: candidate.candidateKey,
      expectedCode: '123456',
    },
  });
  assert.deepEqual(readback.output.value, {
    bound: true,
    empty: false,
    length: 6,
    matches: true,
  });
  assert.equal(JSON.stringify(readback.output.value).includes('123456'), false);
});

test('postcondition accepts only document movement or disappearance of the observed signal kind', async () => {
  install(`
    <div role="dialog" id="remember">
      <h2>Remember Password</h2>
      <button id="ok">OK</button>
    </div>
  `, 'https://www.facebook.com/');
  setRect(document.getElementById('ok')!, { left: 500, top: 500, right: 620, bottom: 545 });
  const observation = await probe();
  const unchanged = await run({
    kind: 'auth_postcondition',
    params: {
      documentGeneration: observation.documentGeneration,
      expectedSignal: 'remember_password_confirm',
      candidateKey: (observation.candidate as Record<string, unknown>).candidateKey,
    },
  });
  assert.equal(unchanged.output.value.satisfied, false);

  document.getElementById('remember')!.remove();
  const gone = await run({
    kind: 'auth_postcondition',
    params: {
      documentGeneration: observation.documentGeneration,
      expectedSignal: 'remember_password_confirm',
      candidateKey: (observation.candidate as Record<string, unknown>).candidateKey,
    },
  });
  assert.equal(gone.output.value.satisfied, true);
  assert.equal(gone.output.value.signalGone, true);
});

test('login and TOTP postconditions stay bound to the original target without reusing probe eligibility', async () => {
  install(`
    <form>
      <input id="email" name="email" value="filled">
      <input id="password" name="pass" type="password" value="filled">
      <button id="login" name="login">Log in</button>
    </form>
  `, 'https://www.facebook.com/login/');
  setRect(document.getElementById('login')!, { left: 100, top: 100, right: 240, bottom: 145 });
  const login = await probe();
  (document.getElementById('email') as HTMLInputElement).value = '';
  (document.getElementById('password') as HTMLInputElement).value = '';
  const loginUnchanged = await run({
    kind: 'auth_postcondition',
    params: {
      documentGeneration: login.documentGeneration,
      expectedSignal: 'login_submit_ready',
      candidateKey: (login.candidate as Record<string, unknown>).candidateKey,
    },
  });
  assert.equal(loginUnchanged.output.value.satisfied, false);

  const windowStart = 1_800_000_000_000;
  install(`
    <main>
      <h1>Two-factor authentication</h1>
      <input id="code" autocomplete="one-time-code" value="123456">
      <button id="continue">Continue</button>
    </main>
  `, 'https://www.facebook.com/two_step_verification/two_factor/', windowStart + 10_000);
  setRect(document.getElementById('code')!, { left: 100, top: 100, right: 300, bottom: 145 });
  setRect(document.getElementById('continue')!, { left: 100, top: 200, right: 240, bottom: 245 });
  const totp = await probe({
    enteredTotpWindowStartUnixMs: windowStart,
    enteredTotpWindowEndUnixMs: windowStart + 30_000,
  });
  const totpUnchanged = await run({
    kind: 'auth_postcondition',
    params: {
      documentGeneration: totp.documentGeneration,
      expectedSignal: 'totp_submit_ready',
      candidateKey: (totp.candidate as Record<string, unknown>).candidateKey,
    },
  });
  assert.equal(totpUnchanged.output.value.satisfied, false);

  document.getElementById('continue')!.remove();
  const totpGone = await run({
    kind: 'auth_postcondition',
    params: {
      documentGeneration: totp.documentGeneration,
      expectedSignal: 'totp_submit_ready',
      candidateKey: (totp.candidate as Record<string, unknown>).candidateKey,
    },
  });
  assert.equal(totpGone.output.value.satisfied, true);
});

test('a higher-priority new prompt does not prove the original prompt disappeared', async () => {
  install(`
    <div role="dialog">
      <h2>Remember Password</h2>
      <button id="ok">OK</button>
    </div>
  `, 'https://www.facebook.com/');
  setRect(document.getElementById('ok')!, { left: 500, top: 500, right: 620, bottom: 545 });
  const remember = await probe({ allowAuthActions: true });
  document.body.insertAdjacentHTML('beforeend', `
    <main>
      <p>We suspect automated behavior on your account</p>
      <button id="dismiss">Dismiss</button>
    </main>
  `);
  setRect(document.getElementById('dismiss')!, { left: 100, top: 100, right: 240, bottom: 145 });
  const rememberStillPresent = await run({
    kind: 'auth_postcondition',
    params: {
      documentGeneration: remember.documentGeneration,
      expectedSignal: 'remember_password_confirm',
      candidateKey: (remember.candidate as Record<string, unknown>).candidateKey,
    },
  });
  assert.equal(rememberStillPresent.output.value.satisfied, false);

  install(`
    <div role="alertdialog" aria-label="Push notifications request">
      <button id="close" aria-label="Close"></button>
    </div>
  `, 'https://www.facebook.com/');
  setRect(document.getElementById('close')!, { left: 10, top: 10, right: 58, bottom: 30 });
  const push = await probe({ allowAuthActions: true });
  document.body.insertAdjacentHTML('beforeend', `
    <main>
      <p>We suspect automated behavior on your account</p>
      <button id="dismiss">Dismiss</button>
    </main>
  `);
  setRect(document.getElementById('dismiss')!, { left: 100, top: 100, right: 240, bottom: 145 });
  const pushStillPresent = await run({
    kind: 'auth_postcondition',
    params: {
      documentGeneration: push.documentGeneration,
      expectedSignal: 'push_blocker_close',
      candidateKey: (push.candidate as Record<string, unknown>).candidateKey,
    },
  });
  assert.equal(pushStillPresent.output.value.satisfied, false);
});
