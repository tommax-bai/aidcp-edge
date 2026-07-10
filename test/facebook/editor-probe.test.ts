import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  facebookGatedSubmitPreflight,
  probeFacebookCommentEditorReadOnly,
  runFacebookGatedSubmitProbe,
} from '../../src/facebook/index.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

interface Call {
  method: string;
  params?: Record<string, unknown>;
}

class EditorProbeFakeCdp implements BrowseCdp {
  calls: Call[] = [];
  text = '';
  reloads = 0;

  constructor(private readonly mode: 'ok' | 'gated' | 'no-editor' | 'submit-disabled' | 'not-confirmed' = 'ok') {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Input.insertText') {
      this.text += String(params?.text ?? '');
      return {} as T;
    }
    if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown' && params.key === 'Backspace') {
      this.text = '';
      return {} as T;
    }
    if (method === 'Input.dispatchMouseEvent') {
      return {} as T;
    }
    if (method === 'Page.reload') {
      this.reloads += 1;
      return {} as T;
    }
    const expression = String(params?.expression ?? '');
    if (expression.includes('permissionGated')) {
      if (this.mode === 'no-editor') {
        return { result: { value: JSON.stringify({ found: false, focused: false, permissionGated: false }) } } as T;
      }
      if (this.mode === 'gated') {
        return { result: { value: JSON.stringify({ found: true, focused: false, permissionGated: true }) } } as T;
      }
      return { result: { value: JSON.stringify({ found: true, focused: true, permissionGated: false }) } } as T;
    }
    if (expression.includes('markerAccepted')) {
      return {
        result: {
          value: JSON.stringify({
            found: true,
            markerAccepted: this.text.length > 0,
            submitControlObserved: true,
            submitControlLabel: '发布评论',
            submitControlDisabled: this.mode === 'submit-disabled',
            x: 100,
            y: 120,
          }),
        },
      } as T;
    }
    if (expression.includes('visible: fbText')) {
      return {
        result: {
          value: JSON.stringify({
            visible: this.text.length > 0 && (this.reloads === 0 || this.mode !== 'not-confirmed'),
          }),
        },
      } as T;
    }
    if (expression.includes('selected:fbSelectEditorContents') || expression.includes('selected:true')) {
      return { result: { value: JSON.stringify({ found: true, selected: true }) } } as T;
    }
    if (expression.includes('textLength:fbText')) {
      return { result: { value: JSON.stringify({ found: true, textLength: this.text.length }) } } as T;
    }
    return { result: { value: '{}' } } as T;
  }
}

test('probeFacebookCommentEditorReadOnly: focus/type/observe/clear without submitting', async () => {
  const cdp = new EditorProbeFakeCdp();
  const marker = 'aidcp-test-marker';
  const result = await probeFacebookCommentEditorReadOnly(cdp, { marker });

  assert.equal(result.ok, true);
  assert.equal(result.submitted, false);
  assert.equal(result.markerAccepted, true);
  assert.equal(result.submitControlObserved, true);
  assert.equal(result.cleared, true);
  assert.equal(result.finalTextLength, 0);
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(cdp.calls.some((c) => c.method === 'Input.dispatchMouseEvent'), false);
  assert.equal(cdp.calls.some((c) => c.method === 'Input.insertText'), true);
});

test('probeFacebookCommentEditorReadOnly: permission-gated group-like editor refuses before typing', async () => {
  const cdp = new EditorProbeFakeCdp('gated');
  const result = await probeFacebookCommentEditorReadOnly(cdp, { marker: 'blocked-marker' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'permission_gated');
  assert.equal(result.permissionGated, true);
  assert.equal(cdp.calls.some((c) => c.method === 'Input.insertText'), false);
});

test('probeFacebookCommentEditorReadOnly: no editor fails honestly', async () => {
  const cdp = new EditorProbeFakeCdp('no-editor');
  const result = await probeFacebookCommentEditorReadOnly(cdp, { marker: 'missing-marker' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_editor');
});

test('facebookGatedSubmitPreflight: default and configuration gates refuse submit', async () => {
  const cdp = new EditorProbeFakeCdp();
  assert.deepEqual(await facebookGatedSubmitPreflight(cdp), { ok: false, reason: 'disabled' });
  assert.deepEqual(await facebookGatedSubmitPreflight(cdp, { enabled: true }), { ok: false, reason: 'not_disposable' });
  assert.deepEqual(
    await facebookGatedSubmitPreflight(cdp, { enabled: true, disposableAccountConfirmed: true }),
    { ok: false, reason: 'missing_target_url' },
  );
});

test('facebookGatedSubmitPreflight: blocking overlay stops before submit readiness', async () => {
  const cdp = new EditorProbeFakeCdp();
  const result = await facebookGatedSubmitPreflight(cdp, {
    enabled: true,
    disposableAccountConfirmed: true,
    targetUrl: 'https://www.facebook.com/Meta/posts/1',
    currentUrl: 'https://www.facebook.com/Meta/posts/1',
    classifyOverlay: async () => 'captcha',
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'blocked_by_captcha',
    overlay: 'captcha',
    targetUrl: 'https://www.facebook.com/Meta/posts/1',
    currentUrl: 'https://www.facebook.com/Meta/posts/1',
  });
});

test('facebookGatedSubmitPreflight: target mismatch and clean ready states are explicit', async () => {
  const cdp = new EditorProbeFakeCdp();
  const targetUrl = 'https://www.facebook.com/Meta/posts/1/';
  const mismatch = await facebookGatedSubmitPreflight(cdp, {
    enabled: true,
    disposableAccountConfirmed: true,
    targetUrl,
    currentUrl: 'https://www.facebook.com/Meta/posts/2/',
    classifyOverlay: async () => 'none',
  });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.reason, 'target_mismatch');

  const ready = await facebookGatedSubmitPreflight(cdp, {
    enabled: true,
    disposableAccountConfirmed: true,
    targetUrl,
    currentUrl: 'https://www.facebook.com/Meta/posts/1',
    classifyOverlay: async () => 'none',
  });
  assert.deepEqual(ready, {
    ok: true,
    targetUrl,
    currentUrl: 'https://www.facebook.com/Meta/posts/1',
    overlay: 'none',
  });
});

test('facebookGatedSubmitPreflight: cookie 同意浮层清不掉 → blocked_by_consent（不进 classify）', async () => {
  const cdp = new EditorProbeFakeCdp();
  let classifyCalled = false;
  const result = await facebookGatedSubmitPreflight(cdp, {
    enabled: true,
    disposableAccountConfirmed: true,
    targetUrl: 'https://www.facebook.com/Meta/posts/1',
    currentUrl: 'https://www.facebook.com/Meta/posts/1',
    acceptConsent: async () => ({ handled: true, cleared: false, attempts: 3, reason: 'blocked_by_consent' as const }),
    classifyOverlay: async () => {
      classifyCalled = true;
      return 'none';
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'blocked_by_consent');
  assert.equal(classifyCalled, false); // 清不掉即止，不再往后判分类
});

test('facebookGatedSubmitPreflight: cookie 同意浮层清掉后照常放行', async () => {
  const cdp = new EditorProbeFakeCdp();
  const targetUrl = 'https://www.facebook.com/Meta/posts/1';
  const ready = await facebookGatedSubmitPreflight(cdp, {
    enabled: true,
    disposableAccountConfirmed: true,
    targetUrl,
    currentUrl: targetUrl,
    acceptConsent: async () => ({ handled: true, cleared: true, attempts: 1 }),
    classifyOverlay: async () => 'none',
  });
  assert.deepEqual(ready, { ok: true, targetUrl, currentUrl: targetUrl, overlay: 'none' });
});

test('runFacebookGatedSubmitProbe: refuses actual submit without comment text', async () => {
  const cdp = new EditorProbeFakeCdp();
  const result = await runFacebookGatedSubmitProbe(cdp, {
    enabled: true,
    disposableAccountConfirmed: true,
    targetUrl: 'https://www.facebook.com/Meta/posts/1',
    currentUrl: 'https://www.facebook.com/Meta/posts/1',
    classifyOverlay: async () => 'none',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_comment_text');
  assert.equal(result.submitted, false);
  assert.equal(cdp.calls.some((c) => c.method === 'Input.insertText'), false);
});

test('runFacebookGatedSubmitProbe: submits only after gates and confirms by reload visibility', async () => {
  const cdp = new EditorProbeFakeCdp();
  const commentText = 'aidcp-disposable-f1-comment';
  const result = await runFacebookGatedSubmitProbe(cdp, {
    enabled: true,
    disposableAccountConfirmed: true,
    targetUrl: 'https://www.facebook.com/Meta/posts/1',
    currentUrl: 'https://www.facebook.com/Meta/posts/1',
    commentText,
    classifyOverlay: async () => 'none',
    sleep: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.submitted, true);
  assert.equal(result.serverConfirmed, true);
  assert.equal(result.markerAccepted, true);
  assert.equal(result.submitControlObserved, true);
  assert.equal(result.optimisticVisible, true);
  assert.equal(result.reloadedVisible, true);
  assert.equal(cdp.reloads, 1);
  assert.equal(cdp.calls.some((c) => c.method === 'Input.insertText'), true);
  assert.equal(cdp.calls.some((c) => c.method === 'Input.dispatchMouseEvent'), true);
  assert.equal(JSON.stringify(result).includes(commentText), false);
});

test('runFacebookGatedSubmitProbe: submitted but not reload-confirmed is not ok', async () => {
  const cdp = new EditorProbeFakeCdp('not-confirmed');
  const result = await runFacebookGatedSubmitProbe(cdp, {
    enabled: true,
    disposableAccountConfirmed: true,
    targetUrl: 'https://www.facebook.com/Meta/posts/1',
    currentUrl: 'https://www.facebook.com/Meta/posts/1',
    commentText: 'aidcp-disposable-f1-comment',
    classifyOverlay: async () => 'none',
    sleep: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_confirmed_after_reload');
  assert.equal(result.submitted, true);
  assert.equal(result.serverConfirmed, false);
  assert.equal(result.optimisticVisible, true);
  assert.equal(result.reloadedVisible, false);
});

test('runFacebookGatedSubmitProbe: disabled submit control clears draft and does not click', async () => {
  const cdp = new EditorProbeFakeCdp('submit-disabled');
  const result = await runFacebookGatedSubmitProbe(cdp, {
    enabled: true,
    disposableAccountConfirmed: true,
    targetUrl: 'https://www.facebook.com/Meta/posts/1',
    currentUrl: 'https://www.facebook.com/Meta/posts/1',
    commentText: 'aidcp-disposable-f1-comment',
    classifyOverlay: async () => 'none',
    sleep: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'submit_control_disabled');
  assert.equal(result.submitted, false);
  assert.equal(cdp.text, '');
  assert.equal(cdp.reloads, 0);
  assert.equal(cdp.calls.some((c) => c.method === 'Input.dispatchMouseEvent'), false);
});
