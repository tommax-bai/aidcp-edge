import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import {
  TIKTOK_PAGE_SNAPSHOT_JS,
  TikTokInteractionProbe,
  hasExactAdsPowerProfileMarker,
  isRealLikeAuthorized,
  isTikTokTargetUrl,
  toTikTokSafeSnapshot,
  type TikTokPageSnapshot,
} from '../../src/tiktok/index.js';

function installGeometry(dom: JSDOM): void {
  Object.defineProperty(dom.window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      const raw = (this as HTMLElement).getAttribute('data-rect') ?? '0,0,0,0';
      const [left, top, width, height] = raw.split(',').map(Number);
      return {
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => ({}),
      };
    },
  });
}

function evaluateSnapshot(
  html: string,
  url = 'https://www.tiktok.com/foryou',
  setup?: (dom: JSDOM) => void,
): TikTokPageSnapshot {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  installGeometry(dom);
  setup?.(dom);
  return JSON.parse(dom.window.eval(TIKTOK_PAGE_SNAPSHOT_JS) as string) as TikTokPageSnapshot;
}

function baseSnapshot(overrides: Partial<TikTokPageSnapshot> = {}): TikTokPageSnapshot {
  return {
    host: 'www.tiktok.com',
    path: '/foryou',
    blockReason: 'none',
    loginState: 'logged_in',
    current: {
      videoId: '1001',
      authorHandle: 'alice',
      path: '/@alice/video/1001',
      centerX: 540,
      centerY: 400,
      top: 0,
      bottom: 800,
      visibleRatio: 1,
    },
    currentAmbiguous: false,
    visibleVideoIds: ['1001'],
    scrollTop: 0,
    like: {
      found: true,
      ambiguous: false,
      centerX: 1050,
      centerY: 420,
      state: 'unliked',
      evidence: 'aria_pressed_false',
    },
    commentOpener: {
      found: true,
      ambiguous: false,
      centerX: 1050,
      centerY: 500,
    },
    editor: { found: true, ambiguous: false, textLength: 0 },
    ...overrides,
  };
}

interface FakeCall {
  method: string;
  params: Record<string, unknown>;
}

function fakeCdp(snapshots: TikTokPageSnapshot[], options: { editorMatches?: boolean } = {}): {
  cdp: BrowseCdp;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let snapshotIndex = 0;
  const cdp: BrowseCdp = {
    send: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression ?? '');
        if (expression.includes('/*aidcp:tiktok-page-snapshot*/')) {
          const value = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
          snapshotIndex += 1;
          return { result: { type: 'string', value: JSON.stringify(value) } } as never;
        }
        if (expression.includes('/*aidcp:tiktok-editor-focus*/')) {
          return { result: { type: 'string', value: JSON.stringify({ ok: true, textLength: 0 }) } } as never;
        }
        if (expression.includes('/*aidcp:tiktok-editor-verify*/')) {
          const textCall = calls.find((call) => call.method === 'Input.insertText');
          const textLength = String(textCall?.params.text ?? '').length;
          return {
            result: {
              type: 'string',
              value: JSON.stringify({ matches: options.editorMatches ?? true, textLength }),
            },
          } as never;
        }
      }
      return {} as never;
    },
  };
  return { cdp, calls };
}

test('page snapshot reads one current TikTok video and scoped controls', () => {
  const snapshot = evaluateSnapshot(`<!doctype html><html><body>
    <a data-e2e="nav-profile" data-rect="10,10,40,40" href="/@me"></a>
    <article data-rect="100,0,1000,800">
      <video data-rect="100,0,900,800"></video>
      <a href="/@alice/video/1001" data-rect="100,0,900,800"></a>
      <button data-e2e="like-icon" aria-label="Like video" aria-pressed="false" data-rect="1030,360,60,60"></button>
      <button data-e2e="comment-icon" aria-label="Comments" data-rect="1030,450,60,60"></button>
      <div data-e2e="comment-input" data-rect="720,700,300,60">
        <div contenteditable="true" aria-label="Add comment" data-rect="730,710,280,40"></div>
      </div>
    </article>
  </body></html>`);

  assert.equal(snapshot.blockReason, 'none');
  assert.equal(snapshot.loginState, 'logged_in');
  assert.equal(snapshot.current?.videoId, '1001');
  assert.equal(snapshot.current?.authorHandle, 'alice');
  assert.equal(snapshot.currentAmbiguous, false);
  assert.equal(snapshot.like.found, true);
  assert.equal(snapshot.like.state, 'unliked');
  assert.equal(snapshot.commentOpener.found, true);
  assert.equal(snapshot.editor.found, true);
});

test('page snapshot derives a stable id from the bounded React fiber fallback used by the live feed', () => {
  const snapshot = evaluateSnapshot(
    `<!doctype html><html><body>
      <a data-e2e="nav-profile" data-rect="10,10,40,40" href="/@me"></a>
      <article data-e2e="recommend-list-item-container" data-rect="100,0,1000,800">
        <video data-rect="100,0,900,800"></video>
        <a data-e2e="video-author-avatar" href="/@fiber_author" data-rect="1010,200,60,60"></a>
        <div role="button" data-e2e="like-icon" aria-label="Thích video 12 lượt thích" data-rect="1030,360,60,60"></div>
      </article>
    </body></html>`,
    'https://www.tiktok.com/foryou',
    (dom) => {
      const article = dom.window.document.querySelector('article') as HTMLElement & Record<string, unknown>;
      article.__reactFiber$fixture = {
        return: { sibling: { pendingProps: { item: { id: '7654590402938293511' } } } },
      };
    },
  );
  assert.equal(snapshot.current?.videoId, '7654590402938293511');
  assert.equal(snapshot.current?.authorHandle, 'fiber_author');
  assert.equal(snapshot.like.state, 'unliked');
});

test('page snapshot blocks captcha and does not promote a target', () => {
  const snapshot = evaluateSnapshot(`<!doctype html><html><body>
    <iframe src="https://verify.example/captcha" data-rect="300,200,600,400"></iframe>
  </body></html>`, 'https://www.tiktok.com/challenge');
  assert.equal(snapshot.blockReason, 'challenge');
  assert.equal(snapshot.current, undefined);
});

test('page snapshot classifies a visible login gate before interaction', () => {
  const snapshot = evaluateSnapshot(`<!doctype html><html><body>
    <form action="/login"><input type="password" data-rect="420,260,360,48"></form>
  </body></html>`, 'https://www.tiktok.com/login');
  assert.equal(snapshot.blockReason, 'login_required');
  assert.equal(snapshot.loginState, 'logged_out');
});

test('page snapshot reports two equally visible videos as ambiguous', () => {
  const snapshot = evaluateSnapshot(`<!doctype html><html><body>
    <a data-e2e="nav-profile" data-rect="10,10,40,40" href="/@me"></a>
    <article><video data-rect="100,0,900,400"></video><a href="/@alice/video/1001"></a></article>
    <article><video data-rect="100,400,900,400"></video><a href="/@bob/video/1002"></a></article>
  </body></html>`);
  assert.equal(snapshot.currentAmbiguous, true);
  assert.deepEqual(snapshot.visibleVideoIds.sort(), ['1001', '1002']);
});

test('TikTok URL and real-like gates fail closed', () => {
  assert.equal(isTikTokTargetUrl('https://www.tiktok.com/foryou'), true);
  assert.equal(isTikTokTargetUrl('https://tiktok.com.evil.example/foryou'), false);
  assert.equal(isRealLikeAuthorized('k1eu5amn', true, 'k1eu5amn'), true);
  assert.equal(isRealLikeAuthorized('k1eu5amn', true, 'different'), false);
  assert.equal(isRealLikeAuthorized('k1eu5amn', false, 'k1eu5amn'), false);
});

test('direct CDP fallback accepts only an exact AdsPower profile marker', () => {
  const targets = [
    { type: 'page', url: 'https://start.adspower.net/?id=k1eu5amn&host=127.0.0.1%3A20725' },
    { type: 'page', url: 'https://www.tiktok.com/foryou' },
  ];
  assert.equal(hasExactAdsPowerProfileMarker(targets, 'k1eu5amn'), true);
  assert.equal(hasExactAdsPowerProfileMarker(targets, 'k1eu5am'), false);
  assert.equal(
    hasExactAdsPowerProfileMarker([{ type: 'page', url: 'https://start.adspower.net.evil.example/?id=k1eu5amn' }], 'k1eu5amn'),
    false,
  );
});

test('browse follows the existing Facebook Reels pattern and proves movement after ArrowDown', async () => {
  const after = baseSnapshot({
    current: { ...baseSnapshot().current!, videoId: '1002', authorHandle: 'bob', path: '/@bob/video/1002' },
    visibleVideoIds: ['1002'],
    scrollTop: 780,
  });
  const { cdp, calls } = fakeCdp([baseSnapshot(), after]);
  const probe = new TikTokInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5, settleRounds: 1 });
  const result = await probe.browseNext();
  assert.deepEqual(result, {
    status: 'browsed',
    executed: true,
    beforeVideoId: '1001',
    afterVideoId: '1002',
  });
  const keys = calls.filter((call) => call.method === 'Input.dispatchKeyEvent');
  assert.equal(keys.length, 2);
  assert.equal(calls.some((call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseWheel'), false);
});

test('browse falls back to one bounded wheel when ArrowDown does not move the feed', async () => {
  const before = baseSnapshot();
  const after = baseSnapshot({
    current: { ...before.current!, videoId: '1002', authorHandle: 'bob', path: '/@bob/video/1002' },
    visibleVideoIds: ['1002'],
  });
  const { cdp, calls } = fakeCdp([before, before, after]);
  const probe = new TikTokInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5, settleRounds: 1 });
  const result = await probe.browseNext();
  assert.equal(result.status, 'browsed');
  const wheels = calls.filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseWheel');
  assert.equal(wheels.length, 1);
});

test('browse reports no_change instead of treating input dispatch as success', async () => {
  const same = baseSnapshot();
  const { cdp } = fakeCdp([same, same, same, same, same]);
  const probe = new TikTokInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5, settleRounds: 2 });
  const result = await probe.browseNext();
  assert.equal(result.status, 'no_change');
  assert.equal(result.executed, true);
});

test('like defaults to shadow and never dispatches a click', async () => {
  const { cdp, calls } = fakeCdp([baseSnapshot()]);
  const probe = new TikTokInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5 });
  const result = await probe.likeCurrent({ profileId: 'k1eu5amn', execute: false });
  assert.equal(result.status, 'shadow');
  assert.equal(result.executed, false);
  assert.equal(calls.some((call) => call.method === 'Input.dispatchMouseEvent'), false);
});

test('like double gate dispatches one click and requires same-video liked state', async () => {
  const after = baseSnapshot({ like: { ...baseSnapshot().like, state: 'liked', evidence: 'aria_pressed' } });
  const { cdp, calls } = fakeCdp([baseSnapshot(), after]);
  const probe = new TikTokInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5, settleRounds: 1 });
  const result = await probe.likeCurrent({
    profileId: 'k1eu5amn',
    execute: true,
    confirmedProfile: 'k1eu5amn',
  });
  assert.equal(result.status, 'ui_confirmed');
  assert.equal(result.confirmation, 'ui_only');
  const presses = calls.filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed');
  assert.equal(presses.length, 1);
});

test('already-liked target is never clicked or toggled off', async () => {
  const liked = baseSnapshot({ like: { ...baseSnapshot().like, state: 'liked', evidence: 'aria_pressed' } });
  const { cdp, calls } = fakeCdp([liked]);
  const probe = new TikTokInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5 });
  const result = await probe.likeCurrent({
    profileId: 'k1eu5amn',
    execute: true,
    confirmedProfile: 'k1eu5amn',
  });
  assert.equal(result.status, 'already_liked');
  assert.equal(calls.some((call) => call.method === 'Input.dispatchMouseEvent'), false);
});

test('comment probe fills one empty editor without any submit-capable input event', async () => {
  const marker = 'AIDCP local probe draft only';
  const { cdp, calls } = fakeCdp([baseSnapshot(), baseSnapshot()]);
  const probe = new TikTokInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5 });
  const result = await probe.fillCommentDraft(marker);
  assert.equal(result.status, 'filled_not_submitted');
  assert.equal(result.submitted, false);
  assert.equal(result.textLength, marker.length);
  assert.equal(result.matched, true);
  assert.equal(calls.filter((call) => call.method === 'Input.insertText').length, 1);
  assert.equal(calls.some((call) => call.method === 'Input.dispatchKeyEvent'), false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
});

test('comment source exposes no form submit, Enter key, or submit control lookup', async () => {
  const sourcePath = fileURLToPath(new URL('../../src/tiktok/probes/interaction-probe.ts', import.meta.url));
  const source = await readFile(sourcePath, 'utf8');
  assert.doesNotMatch(source, /\.submit\s*\(/);
  assert.doesNotMatch(source, /key\s*:\s*['"]Enter['"]/);
  assert.doesNotMatch(source, /data-e2e[^\n]*(?:comment-post|comment-submit|send-comment)/i);
});

test('safe snapshot removes action coordinates and retains only minimal evidence', () => {
  const safe = toTikTokSafeSnapshot(baseSnapshot());
  const json = JSON.stringify(safe);
  assert.doesNotMatch(json, /centerX|centerY|top|bottom|visibleRatio/);
  assert.equal(safe.current?.videoId, '1001');
  assert.equal(safe.like.evidence, 'aria_pressed_false');
});
