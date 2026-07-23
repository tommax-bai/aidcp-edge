import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import {
  TIKTOK_CAPABILITY_PAGE_JS,
  TIKTOK_OFFICIAL_API_READINESS,
  TikTokCapabilityResearchProbe,
  type TikTokCapabilityPageSnapshot,
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
        y: top + height,
        toJSON: () => ({}),
      };
    },
  });
}

function evaluateCapability(
  html: string,
  url = 'https://www.tiktok.com/foryou',
  language = 'vi-VN',
): TikTokCapabilityPageSnapshot {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  installGeometry(dom);
  Object.defineProperty(dom.window.navigator, 'language', { value: language, configurable: true });
  return JSON.parse(dom.window.eval(TIKTOK_CAPABILITY_PAGE_JS) as string) as TikTokCapabilityPageSnapshot;
}

function interactionSnapshot(): TikTokPageSnapshot {
  return {
    host: 'www.tiktok.com',
    path: '/foryou',
    blockReason: 'none',
    loginState: 'logged_in',
    current: {
      videoId: '1001',
      authorHandle: 'redacted-by-capability-probe',
      path: '/@redacted/video/1001',
      centerX: 500,
      centerY: 400,
      top: 0,
      bottom: 800,
      visibleRatio: 1,
    },
    currentAmbiguous: false,
    visibleVideoIds: ['1001'],
    scrollTop: 0,
    like: { found: false, ambiguous: false, state: 'unknown' },
    commentOpener: { found: false, ambiguous: false },
    editor: { found: false, ambiguous: false },
  };
}

test('capability snapshot inventories separate TikTok surfaces and entries without opening them', () => {
  const snapshot = evaluateCapability(`<!doctype html><html lang="vi-VN"><body>
    <a data-e2e="nav-for-you" href="/foryou" data-rect="10,10,30,30"></a>
    <a data-e2e="nav-following" href="/following" data-rect="50,10,30,30"></a>
    <a data-e2e="nav-profile" href="/@private_identity" data-rect="90,10,30,30"></a>
    <input role="searchbox" placeholder="Tìm kiếm" data-rect="140,10,200,30">
    <a href="/tag/private_topic" data-rect="10,70,60,30"></a>
    <a href="/music/private_track" data-rect="80,70,60,30"></a>
    <button data-e2e="nav-message" data-rect="150,70,60,30"></button>
    <button data-e2e="inbox-icon" data-rect="220,70,60,30"></button>
    <a href="/live" data-e2e="nav-live" data-rect="290,70,60,30"></a>
    <video data-rect="200,120,700,650"></video>
  </body></html>`);

  assert.equal(snapshot.surface, 'for_you');
  assert.equal(snapshot.hydrated, true);
  for (const kind of ['for_you', 'following', 'profile', 'search', 'tag', 'music', 'messages', 'notifications', 'live'] as const) {
    assert.notEqual(snapshot.entries[kind].status, 'missing', kind);
  }
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('private_identity'), false);
  assert.equal(serialized.includes('private_topic'), false);
  assert.equal(serialized.includes('private_track'), false);
});

test('social controls use exact TikTok selectors and remain shadow-only with honest state', () => {
  const snapshot = evaluateCapability(`<!doctype html><html><body>
    <video data-rect="100,0,800,800"></video>
    <button data-e2e="feed-follow" data-rect="1000,200,40,40"></button>
    <button data-e2e="favorite-icon" aria-pressed="true" data-rect="1000,260,40,40"></button>
    <button data-e2e="share-icon" aria-pressed="false" data-rect="1000,320,40,40"></button>
    <button data-e2e="card-followbutton" data-rect="1000,380,40,40"></button>
  </body></html>`);
  assert.deepEqual(snapshot.social.follow, { candidateCount: 1, status: 'shadow_ready', state: 'unknown' });
  assert.deepEqual(snapshot.social.collect, { candidateCount: 1, status: 'shadow_ready', state: 'active' });
  assert.deepEqual(snapshot.social.share, { candidateCount: 1, status: 'shadow_ready', state: 'inactive' });
});

test('duplicate exact social controls are ambiguous', () => {
  const snapshot = evaluateCapability(`<!doctype html><html><body>
    <video data-rect="100,0,800,800"></video>
    <button data-e2e="feed-follow" data-rect="1000,200,40,40"></button>
    <button data-e2e="feed-follow" data-rect="1000,260,40,40"></button>
  </body></html>`);
  assert.deepEqual(snapshot.social.follow, { candidateCount: 2, status: 'ambiguous', state: 'unknown' });
});

test('UI locale never configures reply language or enables an editor', () => {
  const snapshot = evaluateCapability(
    '<!doctype html><html lang="vi-VN"><body><video data-rect="100,0,800,800"></video></body></html>',
  );
  assert.equal(snapshot.uiLocale, 'vi-VN');
  assert.equal(snapshot.replyLanguage, 'unconfigured');
  assert.equal(snapshot.replyBlocked, true);
});

test('an interactive-ready TikTok shell is not treated as hydrated capability evidence', () => {
  const snapshot = evaluateCapability('<!doctype html><html><body><main></main></body></html>');
  assert.equal(snapshot.hydrated, false);
  assert.equal(snapshot.entries.messages.status, 'missing');
});

test('combined probe retains only stable video identity and interaction safety state', async () => {
  const calls: string[] = [];
  const cdp: BrowseCdp = {
    send: async (_method, params = {}) => {
      const expression = String(params.expression ?? '');
      calls.push(expression);
      if (expression.includes('/*aidcp:tiktok-capability-research*/')) {
        return {
          result: {
            type: 'string',
            value: JSON.stringify(
              evaluateCapability('<!doctype html><body><video data-rect="100,0,800,800"></video></body>'),
            ),
          },
        } as never;
      }
      if (expression.includes('/*aidcp:tiktok-page-snapshot*/')) {
        return { result: { type: 'string', value: JSON.stringify(interactionSnapshot()) } } as never;
      }
      throw new Error('unexpected expression');
    },
  };
  const result = await new TikTokCapabilityResearchProbe(cdp).inspect();
  assert.equal(result.currentVideoId, '1001');
  assert.equal(result.currentVideoAmbiguous, false);
  assert.equal(JSON.stringify(result).includes('redacted-by-capability-probe'), false);
  assert.equal(calls.length, 2);
});

test('combined probe does not promote a For You video shell without a stable target', async () => {
  const cdp: BrowseCdp = {
    send: async (_method, params = {}) => {
      const expression = String(params.expression ?? '');
      if (expression.includes('/*aidcp:tiktok-capability-research*/')) {
        return {
          result: {
            type: 'string',
            value: JSON.stringify(
              evaluateCapability('<!doctype html><body><video data-rect="100,0,800,800"></video></body>'),
            ),
          },
        } as never;
      }
      if (expression.includes('/*aidcp:tiktok-page-snapshot*/')) {
        return {
          result: {
            type: 'string',
            value: JSON.stringify({ ...interactionSnapshot(), current: undefined, visibleVideoIds: [] }),
          },
        } as never;
      }
      throw new Error('unexpected expression');
    },
  };
  const result = await new TikTokCapabilityResearchProbe(cdp).inspect();
  assert.equal(result.surface, 'for_you');
  assert.equal(result.hydrated, false);
  assert.equal(result.currentVideoId, undefined);
});

test('official API readiness is static documentation evidence, not a credential or network probe', () => {
  assert.equal(TIKTOK_OFFICIAL_API_READINESS.capabilities.directPost, 'documented');
  assert.equal(TIKTOK_OFFICIAL_API_READINESS.capabilities.uploadDraft, 'documented');
  assert.equal(TIKTOK_OFFICIAL_API_READINESS.localConfiguration, 'not_checked');
  assert.equal(TIKTOK_OFFICIAL_API_READINESS.credentialsAccessed, false);
  assert.equal(TIKTOK_OFFICIAL_API_READINESS.networkCallsExecuted, false);
});

test('capability module and runner contain no write-input path or Douyin selector reuse', async () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const moduleSource = await readFile(new URL('../../src/tiktok/probes/capability-research-probe.ts', import.meta.url), 'utf8');
  const runnerSource = await readFile(new URL('../../scripts/tiktok-capability-research-probe.ts', import.meta.url), 'utf8');
  const source = `${here}\n${moduleSource}\n${runnerSource}`;
  for (const forbidden of [
    'Input.insertText',
    'Input.dispatchKeyEvent',
    'Input.dispatchMouseEvent',
    'dispatchClick',
    'data-aweme-id',
    'video-player-digg',
    'douyin.com',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(runnerSource.includes("'Target.createTarget'"), true);
  assert.equal(runnerSource.includes("'Target.activateTarget'"), true);
  assert.equal(runnerSource.includes("'Target.closeTarget'"), true);
  assert.equal(runnerSource.includes("'Page.navigate'"), false);
});
