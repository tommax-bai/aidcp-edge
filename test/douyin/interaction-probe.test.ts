import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';

import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import {
  DOUYIN_PAGE_SNAPSHOT_JS,
  DouyinInteractionProbe,
  hasExactAdsPowerProfileMarker,
  isDouyinTargetUrl,
  isRealActionAuthorized,
  type DmSnapshot,
  type DouyinPageSnapshot,
  type LiveSnapshot,
} from '../../src/douyin/index.js';

function installGeometry(dom: JSDOM): void {
  Object.defineProperty(dom.window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      const raw = (this as HTMLElement).getAttribute('data-rect') ?? '0,0,0,0';
      const [left, top, width, height] = raw.split(',').map(Number);
      return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
    },
  });
}

function evaluatePage(html: string, url = 'https://www.douyin.com/jingxuan'): DouyinPageSnapshot {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  installGeometry(dom);
  return JSON.parse(dom.window.eval(DOUYIN_PAGE_SNAPSHOT_JS) as string) as DouyinPageSnapshot;
}

function pageSnapshot(overrides: Partial<DouyinPageSnapshot> = {}): DouyinPageSnapshot {
  return {
    host: 'www.douyin.com',
    path: '/jingxuan',
    modalId: '7657570185380990235',
    modalReady: true,
    blockReason: 'none',
    loginState: 'logged_in',
    follow: { found: true, ambiguous: false, centerX: 1040, centerY: 250, state: 'inactive', evidence: 'label_follow' },
    collect: { found: true, ambiguous: false, centerX: 1040, centerY: 450, state: 'inactive', evidence: 'label_collect' },
    interactionPrompt: { found: false, ambiguous: false },
    ...overrides,
  };
}

function dmSnapshot(overrides: Partial<DmSnapshot> = {}): DmSnapshot {
  return {
    host: 'www.douyin.com',
    blockReason: 'none',
    entry: { found: true, ambiguous: false, centerX: 1080, centerY: 40 },
    dialogOpen: true,
    inboundConversation: { centerX: 900, centerY: 160, proof: 'sender_prefix' },
    inboundAmbiguous: false,
    editor: { found: true, ambiguous: false, centerX: 990, centerY: 700, empty: true },
    send: { found: true, ambiguous: false, centerX: 1160, centerY: 700 },
    ...overrides,
  };
}

function liveSnapshot(overrides: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    host: 'live.douyin.com',
    blockReason: 'none',
    roomAmbiguous: false,
    chatEditor: { found: true, ambiguous: false, centerX: 1020, centerY: 730, empty: true },
    send: { found: false, ambiguous: false },
    replyAmbiguous: false,
    replyEditor: { found: false, ambiguous: false },
    exact1111Count: 0,
    ...overrides,
  };
}

interface FakeCall { method: string; params: Record<string, unknown> }

function fakeCdp(options: { pages?: DouyinPageSnapshot[]; dms?: DmSnapshot[]; lives?: LiveSnapshot[] }): { cdp: BrowseCdp; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let pageIndex = 0;
  let dmIndex = 0;
  let liveIndex = 0;
  const next = <T>(values: T[] | undefined, index: number): T => {
    assert.ok(values?.length, 'fixture sequence missing');
    return values[Math.min(index, values.length - 1)];
  };
  const cdp: BrowseCdp = {
    send: async (method, params = {}) => {
      calls.push({ method, params });
      if (method !== 'Runtime.evaluate') return {} as never;
      const expression = String(params.expression ?? '');
      let value: unknown;
      if (expression.includes('/*aidcp:douyin-page-snapshot*/')) value = next(options.pages, pageIndex++);
      else if (expression.includes('/*aidcp:douyin-dm-snapshot*/')) value = next(options.dms, dmIndex++);
      else if (expression.includes('/*aidcp:douyin-live-snapshot*/')) value = next(options.lives, liveIndex++);
      else if (expression.includes('/*aidcp:douyin-dm-focus*/') || expression.includes('/*aidcp:douyin-live-chat-focus*/') || expression.includes('/*aidcp:douyin-live-reply-focus*/')) value = { ok: true };
      else throw new Error(`unexpected evaluate expression: ${expression.slice(0, 80)}`);
      return { result: { type: 'string', value: JSON.stringify(value) } } as never;
    },
  };
  return { cdp, calls };
}

test('page snapshot binds a stable modal and one-way follow/collect controls', () => {
  const snapshot = evaluatePage(`<!doctype html><html><body>
    <a href="/user/self" data-rect="10,10,40,40"></a>
    <div data-e2e="feed-active-video" data-rect="100,80,900,650"></div>
    <button data-e2e="feed-follow-icon" data-rect="1030,220,60,40">关注</button>
    <button data-e2e="video-player-collect" aria-pressed="false" data-rect="1030,420,60,60">收藏</button>
  </body></html>`, 'https://www.douyin.com/jingxuan?modal_id=7657570185380990235');
  assert.equal(snapshot.blockReason, 'none');
  assert.equal(snapshot.loginState, 'logged_in');
  assert.equal(snapshot.modalId, '7657570185380990235');
  assert.equal(snapshot.modalReady, true);
  assert.equal(snapshot.follow.state, 'inactive');
  assert.equal(snapshot.collect.state, 'inactive');
});

test('page snapshot blocks a visible challenge', () => {
  const snapshot = evaluatePage('<!doctype html><html><body><iframe src="https://verify.example/captcha" data-rect="300,200,600,400"></iframe></body></html>');
  assert.equal(snapshot.blockReason, 'challenge');
});

test('known interaction prompt is exact-match, single-click, and postcondition checked', async () => {
  const prompt = pageSnapshot({ interactionPrompt: { found: true, ambiguous: false, centerX: 600, centerY: 538 } });
  const cleared = pageSnapshot({ interactionPrompt: { found: false, ambiguous: false } });
  const { cdp, calls } = fakeCdp({ pages: [prompt, cleared] });
  const probe = new DouyinInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5, settleRounds: 1 });
  const result = await probe.dismissKnownInteractionPrompt();
  assert.equal(result.status, 'ui_confirmed');
  assert.equal(calls.filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed').length, 1);
});

test('Douyin URL, profile marker, and real-action gates fail closed', () => {
  assert.equal(isDouyinTargetUrl('https://live.douyin.com/12345'), true);
  assert.equal(isDouyinTargetUrl('https://douyin.com.evil.example/'), false);
  assert.equal(isRealActionAuthorized('k1evgky5', true, 'k1evgky5'), true);
  assert.equal(isRealActionAuthorized('k1evgky5', true, 'other'), false);
  assert.equal(hasExactAdsPowerProfileMarker([{ type: 'page', url: 'https://start.adspower.net/?id=k1evgky5' }], 'k1evgky5'), true);
  assert.equal(hasExactAdsPowerProfileMarker([{ type: 'page', url: 'https://start.adspower.net.evil.example/?id=k1evgky5' }], 'k1evgky5'), false);
});

test('follow defaults to shadow and never toggles state', async () => {
  const { cdp, calls } = fakeCdp({ pages: [pageSnapshot()] });
  const probe = new DouyinInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5 });
  const result = await probe.followCurrent({ profileId: 'k1evgky5', execute: false });
  assert.equal(result.status, 'shadow');
  assert.equal(calls.some((call) => call.method === 'Input.dispatchMouseEvent'), false);
});

test('follow and collect each dispatch at most one click and require active post-state', async () => {
  const activeFollow = pageSnapshot({ follow: { ...pageSnapshot().follow, state: 'active', evidence: 'label_following' } });
  const activeBoth = pageSnapshot({ follow: activeFollow.follow, collect: { ...pageSnapshot().collect, state: 'active', evidence: 'aria_pressed' } });
  const { cdp, calls } = fakeCdp({ pages: [pageSnapshot(), activeFollow, activeFollow, activeBoth] });
  const probe = new DouyinInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5, settleRounds: 1 });
  const follow = await probe.followCurrent({ profileId: 'k1evgky5', execute: true, confirmedProfile: 'k1evgky5' });
  const collect = await probe.collectCurrent({ profileId: 'k1evgky5', execute: true, confirmedProfile: 'k1evgky5' });
  assert.equal(follow.status, 'ui_confirmed');
  assert.equal(collect.status, 'ui_confirmed');
  assert.equal(calls.filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed').length, 2);
});

test('already-active or unknown toggle states are never clicked', async () => {
  const active = pageSnapshot({ follow: { ...pageSnapshot().follow, state: 'active' } });
  const unknown = pageSnapshot({ collect: { ...pageSnapshot().collect, state: 'unknown' } });
  const { cdp, calls } = fakeCdp({ pages: [active, unknown] });
  const probe = new DouyinInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5 });
  assert.equal((await probe.followCurrent({ profileId: 'k1evgky5', execute: true, confirmedProfile: 'k1evgky5' })).status, 'already_active');
  assert.equal((await probe.collectCurrent({ profileId: 'k1evgky5', execute: true, confirmedProfile: 'k1evgky5' })).status, 'state_unknown');
  assert.equal(calls.some((call) => call.method === 'Input.dispatchMouseEvent'), false);
});

test('visible tutorial overlay blocks social actions before any click', async () => {
  const blocked = pageSnapshot({ interactionPrompt: { found: true, ambiguous: false, centerX: 600, centerY: 538 } });
  const { cdp, calls } = fakeCdp({ pages: [blocked] });
  const probe = new DouyinInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5 });
  const result = await probe.followCurrent({ profileId: 'k1evgky5', execute: true, confirmedProfile: 'k1evgky5' });
  assert.equal(result.status, 'blocked');
  assert.equal(calls.some((call) => call.method === 'Input.dispatchMouseEvent'), false);
});

test('single-action budget prevents a second follow dispatch in one runner', async () => {
  const active = pageSnapshot({ follow: { ...pageSnapshot().follow, state: 'active', evidence: 'follow_animation' } });
  const { cdp, calls } = fakeCdp({ pages: [pageSnapshot(), active, pageSnapshot()] });
  const probe = new DouyinInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5, settleRounds: 1 });
  assert.equal((await probe.followCurrent({ profileId: 'k1evgky5', execute: true, confirmedProfile: 'k1evgky5' })).status, 'ui_confirmed');
  assert.equal((await probe.followCurrent({ profileId: 'k1evgky5', execute: true, confirmedProfile: 'k1evgky5' })).status, 'budget_exhausted');
  assert.equal(calls.filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed').length, 1);
});

test('DM reply requires one uniquely proven unread inbound conversation and an allowlisted body', async () => {
  const { cdp, calls } = fakeCdp({ dms: [dmSnapshot(), dmSnapshot(), dmSnapshot()] });
  const probe = new DouyinInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5, settleRounds: 1 });
  const result = await probe.replyLatestInboundDm({ profileId: 'k1evgky5', execute: true, confirmedProfile: 'k1evgky5', text: '好的' });
  assert.equal(result.status, 'ui_confirmed');
  assert.equal(result.submitted, true);
  assert.equal(calls.filter((call) => call.method === 'Input.insertText').length, 2);
  assert.equal(calls.filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed').length, 2);
});

test('ambiguous DM candidates stop before typing or sending', async () => {
  const { cdp, calls } = fakeCdp({ dms: [dmSnapshot({ inboundConversation: undefined, inboundAmbiguous: true })] });
  const probe = new DouyinInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5 });
  const result = await probe.replyLatestInboundDm({ profileId: 'k1evgky5', execute: true, confirmedProfile: 'k1evgky5', text: 'ok' });
  assert.equal(result.status, 'ambiguous');
  assert.equal(calls.some((call) => call.method === 'Input.insertText' || call.method === 'Input.dispatchKeyEvent'), false);
});

test('DM and live text/profile gates reject before page input', async () => {
  const { cdp, calls } = fakeCdp({});
  const probe = new DouyinInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5 });
  const dm = await probe.replyLatestInboundDm({ profileId: 'k1evgky5', execute: true, confirmedProfile: 'wrong', text: '好的' });
  const live = await probe.sendLiveChat({ profileId: 'k1evgky5', execute: true, confirmedProfile: 'k1evgky5', text: 'not-authorized' as '1111' });
  assert.equal(dm.status, 'gate_rejected');
  assert.equal(live.status, 'gate_rejected');
  assert.equal(calls.length, 0);
});

test('ordinary live chat sends exactly 1111 and targeted reply never falls back to chat', async () => {
  const { cdp, calls } = fakeCdp({ lives: [liveSnapshot(), liveSnapshot({ chatEditor: { found: true, ambiguous: false, empty: false, matches1111: true }, send: { found: true, ambiguous: false, centerX: 1188, centerY: 760 } }), liveSnapshot({ exact1111Count: 1 }), liveSnapshot({ replyTarget: undefined })] });
  const probe = new DouyinInteractionProbe(cdp, { sleep: async () => {}, random: () => 0.5, settleRounds: 1 });
  const chat = await probe.sendLiveChat({ profileId: 'k1evgky5', execute: true, confirmedProfile: 'k1evgky5', text: '1111' });
  const reply = await probe.replyLiveComment({ profileId: 'k1evgky5', execute: true, confirmedProfile: 'k1evgky5', text: '666' });
  assert.equal(chat.status, 'ui_confirmed');
  assert.equal(reply.status, 'target_missing');
  assert.equal(calls.filter((call) => call.method === 'Input.insertText').map((call) => call.params.text).join(''), '1111');
  assert.equal(calls.filter((call) => call.method === 'Input.dispatchKeyEvent' && call.params.key === 'Enter').length, 0);
});

test('source has no ordinary post-comment or publishing submit path', async () => {
  const sourcePath = fileURLToPath(new URL('../../src/douyin/probes/interaction-probe.ts', import.meta.url));
  const source = await readFile(sourcePath, 'utf8');
  assert.doesNotMatch(source, /data-e2e[^\n]*(?:comment-submit|comment-post|publish-submit|upload-submit)/i);
  assert.doesNotMatch(source, /video-player-digg[^\n]*(?:dispatchClick|mousePressed)/i);
});
