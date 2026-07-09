import test from 'node:test';
import assert from 'node:assert/strict';

import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import type { OverlayKind, OverlayMonitor } from '../../src/browse/overlay-monitor.js';
import { FacebookCommentExecutor } from '../../src/facebook/comment-executor.js';

// ── raw page-structure builder (matches RawPageStructure the scan JS returns) ──
interface RawStruct {
  href: string;
  articleCount: number;
  commentEditorCount: number;
  permalinkHrefs?: string[];
  postCandidates?: Array<{
    index: number;
    role: string | null;
    textLength: number;
    authorLinkCount: number;
    commentEditorCount: number;
    commentControlCount: number;
    expandControlCount: number;
    hasCommentRegion: boolean;
    top: number;
    bottom: number;
    permalinkHrefs?: string[];
  }>;
  membership: { joinVisible: boolean; joinedVisible: boolean; pendingVisible: boolean; questionVisible: boolean };
  virtualization: { viewportHeight: number; scrollHeight: number; articleCount: number; likelyVirtualized: boolean };
}

function struct(over: Partial<RawStruct> = {}): RawStruct {
  return {
    href: 'https://www.facebook.com/groups/123456/search/?q=x',
    articleCount: 1,
    commentEditorCount: 0,
    permalinkHrefs: [],
    postCandidates: [],
    membership: { joinVisible: false, joinedVisible: true, pendingVisible: false, questionVisible: false },
    virtualization: { viewportHeight: 800, scrollHeight: 1600, articleCount: 1, likelyVirtualized: false },
    ...over,
  };
}

function post(permalink: string, hasCommentRegion = true) {
  return {
    index: 0,
    role: 'article',
    textLength: 120,
    authorLinkCount: 1,
    commentEditorCount: 0,
    commentControlCount: 1,
    expandControlCount: 0,
    hasCommentRegion,
    top: 100,
    bottom: 400,
    permalinkHrefs: [permalink],
  };
}

interface FakeConfig {
  // page structure returned per probe, as a function of scroll count (simulate lazy load).
  structureFor?: (scrolls: number) => RawStruct;
  focus?: { found: boolean; focused: boolean; permissionGated: boolean };
  accepted?: boolean;
  submitCtl?: { found: boolean; disabled: boolean; label: string | null; x: number; y: number };
  verify?: { confirmed: boolean; matchedText: boolean; matchedOwnIdentity: boolean; articleCount: number };
  containerName?: string | null;
  postContent?: { postText: string | null; comments: string[] };
}

class FakeCdp implements BrowseCdp {
  navigations: string[] = [];
  reloads = 0;
  scrolls = 0;
  clicks: Array<{ x: number; y: number }> = [];
  typed = '';
  backspaces = 0;
  enters = 0;
  constructor(private readonly cfg: FakeConfig = {}) {}

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'Page.navigate') {
      this.navigations.push(String(params.url));
      return {} as T;
    }
    if (method === 'Page.reload') {
      this.reloads++;
      return {} as T;
    }
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mouseWheel') this.scrolls++;
      if (params.type === 'mousePressed') this.clicks.push({ x: Number(params.x), y: Number(params.y) });
      return {} as T;
    }
    if (method === 'Input.insertText') {
      this.typed += String(params.text ?? '');
      return {} as T;
    }
    if (method === 'Input.dispatchKeyEvent') {
      if (params.key === 'Backspace' && params.type === 'keyDown') this.backspaces++;
      if (params.key === 'Enter' && params.type === 'keyDown') this.enters++;
      return {} as T;
    }
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression ?? '');
      const val = (v: unknown) => ({ result: { value: v } }) as unknown as T;
      if (expr.includes('collectPermalinks')) {
        const s = (this.cfg.structureFor ?? (() => struct()))(this.scrolls);
        return val(JSON.stringify(s));
      }
      if (expr.includes('og:title')) {
        const n = this.cfg.containerName === undefined ? 'Puerto Rico Y Sus Encantos e Historia' : this.cfg.containerName;
        return val(JSON.stringify({ name: n }));
      }
      if (expr.includes('blockTexts')) {
        return val(JSON.stringify(this.cfg.postContent ?? { postText: null, comments: [] }));
      }
      if (expr.includes('window.scrollBy')) return val(undefined);
      if (expr.includes('focused:focused')) {
        return val(JSON.stringify(this.cfg.focus ?? { found: true, focused: true, permissionGated: false }));
      }
      if (expr.includes('accepted: t.indexOf')) {
        return val(JSON.stringify({ accepted: this.cfg.accepted ?? true }));
      }
      if (expr.includes('r.left+r.width/2')) {
        return val(JSON.stringify(this.cfg.submitCtl ?? { found: true, disabled: false, label: 'Post', x: 50, y: 60 }));
      }
      if (expr.includes('selectNodeContents')) return val('selected');
      if (expr.includes('matchedOwnIdentity')) {
        return val(
          JSON.stringify(this.cfg.verify ?? { confirmed: true, matchedText: true, matchedOwnIdentity: true, articleCount: 1 }),
        );
      }
      return val('{}');
    }
    return {} as T;
  }
}

function overlay(kind: OverlayKind): OverlayMonitor {
  return {
    state: kind,
    probeNow: async () => kind,
    start: () => {},
    stop: () => {},
  };
}

function makeExecutor(cdp: FakeCdp, over: { accountId?: string; overlayMonitor?: OverlayMonitor } = {}) {
  return new FacebookCommentExecutor(
    {
      cdp,
      getAccountId: () => (over.accountId === undefined ? '100000123456789' : over.accountId),
      ...(over.overlayMonitor ? { overlayMonitor: over.overlayMonitor } : {}),
      sleep: async () => {},
      logger: () => {},
    },
    { settleMs: 0, editorScrollRounds: 3, surfaceProbeRounds: 2, waitAfterSubmitMs: 0, waitAfterReloadMs: 0 },
  );
}

// ─────────────────────────── searchInContainer ───────────────────────────

test('fb-executor: 非白名单容器 → permission_gated，绝不导航（不全站搜）', async () => {
  const cdp = new FakeCdp();
  const ex = makeExecutor(cdp);
  const r = await ex.searchInContainer('咖啡', 'https://evil.example.com/groups/1');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'permission_gated');
  assert.equal(cdp.navigations.length, 0);
});

test('fb-executor: 群容器 → 站内搜 URL + 候选帖 permalink', async () => {
  const permalink = 'https://www.facebook.com/groups/123456/posts/999/';
  const cdp = new FakeCdp({
    structureFor: () => struct({ postCandidates: [post(permalink)] }),
  });
  const ex = makeExecutor(cdp);
  const r = await ex.searchInContainer('咖啡', 'https://www.facebook.com/groups/123456');
  assert.equal(r.ok, true);
  assert.equal(r.candidates.length, 1);
  // permalink 经 sanitize 归一（去尾斜杠/追踪参数）——候选帖链接为规范化后的形态。
  assert.equal(r.candidates[0].permalink, 'https://www.facebook.com/groups/123456/posts/999');
  assert.match(cdp.navigations[0], /\/groups\/123456\/search\/\?q=/);
  // 容器真实群名自动读出回传（人只看群名、不看 id）。
  assert.equal(r.containerName, 'Puerto Rico Y Sus Encantos e Historia');
});

test('fb-executor: 登录失效浮层 → login_required（不返回候选）', async () => {
  const cdp = new FakeCdp({ structureFor: () => struct({ postCandidates: [post('https://www.facebook.com/groups/1/posts/2/')] }) });
  const ex = makeExecutor(cdp, { overlayMonitor: overlay('login') });
  const r = await ex.searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'login_required');
});

test('fb-executor: 非成员（可见 Join）→ permission_gated', async () => {
  const cdp = new FakeCdp({
    structureFor: () =>
      struct({
        postCandidates: [post('https://www.facebook.com/groups/1/posts/2/')],
        membership: { joinVisible: true, joinedVisible: false, pendingVisible: false, questionVisible: false },
      }),
  });
  const ex = makeExecutor(cdp);
  const r = await ex.searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'permission_gated');
});

test('fb-executor: 容器内无候选 → ok:true 空候选（云端映射 no_strong_candidate），仍带回群名', async () => {
  const cdp = new FakeCdp({ structureFor: () => struct({ postCandidates: [] }) });
  const ex = makeExecutor(cdp);
  const r = await ex.searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
  assert.equal(r.ok, true);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.containerName, 'Puerto Rico Y Sus Encantos e Historia');
});

test('fb-executor: 读不出群名 → containerName undefined（绝不用 id 冒充）', async () => {
  const cdp = new FakeCdp({ structureFor: () => struct({ postCandidates: [post('https://www.facebook.com/groups/1/posts/2/')] }), containerName: null });
  const ex = makeExecutor(cdp);
  const r = await ex.searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
  assert.equal(r.ok, true);
  assert.equal(r.containerName, undefined);
});

// ─────────────────────────── openPost ───────────────────────────

test('fb-executor: 开帖非 Facebook 链接 → not_facebook', async () => {
  const cdp = new FakeCdp();
  const ex = makeExecutor(cdp);
  const r = await ex.openPost('https://evil.example.com/x');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_facebook');
  assert.equal(cdp.navigations.length, 0);
});

test('fb-executor: 评论框在首屏下、滚动催拉后就绪（F1 补丁①）', async () => {
  // 前两次探测无评论框，滚动 >=1 次后出现。
  const cdp = new FakeCdp({
    structureFor: (scrolls) =>
      struct({ href: 'https://www.facebook.com/groups/1/posts/2/', articleCount: 1, commentEditorCount: scrolls >= 1 ? 1 : 0 }),
  });
  const ex = makeExecutor(cdp);
  const r = await ex.openPost('https://www.facebook.com/groups/1/posts/2/');
  assert.equal(r.ok, true);
  assert.equal(r.editorReady, true);
  assert.ok(cdp.scrolls >= 1, '应发生过滚动催拉');
});

test('fb-executor: 开帖读了再写——回读帖子正文 + 他人评论', async () => {
  const cdp = new FakeCdp({
    structureFor: () => struct({ href: 'https://www.facebook.com/groups/1/posts/2/', articleCount: 1, commentEditorCount: 1 }),
    postContent: { postText: 'Foto de Rio Piedras', comments: ['Y en esta época están en su máximo esplendor', 'Qué recuerdos'] },
  });
  const ex = makeExecutor(cdp);
  const r = await ex.openPost('https://www.facebook.com/groups/1/posts/2/');
  assert.equal(r.ok, true);
  assert.equal(r.postText, 'Foto de Rio Piedras');
  assert.deepEqual(r.comments, ['Y en esta época están en su máximo esplendor', 'Qué recuerdos']);
});

test('fb-executor: 图片帖无正文 → postText 省略、comments 可空（诚实不臆造）', async () => {
  const cdp = new FakeCdp({
    structureFor: () => struct({ href: 'https://www.facebook.com/groups/1/posts/2/', articleCount: 1, commentEditorCount: 1 }),
    postContent: { postText: null, comments: [] },
  });
  const ex = makeExecutor(cdp);
  const r = await ex.openPost('https://www.facebook.com/groups/1/posts/2/');
  assert.equal(r.ok, true);
  assert.equal(r.postText, undefined);
  assert.equal(r.comments, undefined);
});

test('fb-executor: 评论框始终催不出 → ok:true 但 editorReady:false', async () => {
  const cdp = new FakeCdp({
    structureFor: () => struct({ href: 'https://www.facebook.com/groups/1/posts/2/', articleCount: 1, commentEditorCount: 0 }),
  });
  const ex = makeExecutor(cdp);
  const r = await ex.openPost('https://www.facebook.com/groups/1/posts/2/');
  assert.equal(r.ok, true);
  assert.equal(r.editorReady, false);
});

// ─────────────────────────── submitComment ───────────────────────────

test('fb-executor: 本人 id 未知 → identity_unknown，绝不提交（不点击）', async () => {
  const cdp = new FakeCdp();
  const ex = new FacebookCommentExecutor(
    { cdp, getAccountId: () => undefined, sleep: async () => {}, logger: () => {} },
    { settleMs: 0, waitAfterSubmitMs: 0, waitAfterReloadMs: 0 },
  );
  const r = await ex.submitComment('https://www.facebook.com/groups/1/posts/2/', '很喜欢这条分享');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'identity_unknown');
  assert.equal(r.submitted, false);
  assert.equal(cdp.clicks.length, 0);
});

test('fb-executor: 服务器确认命中 → ok:true（回车提交 + reload 都发生）', async () => {
  const cdp = new FakeCdp({
    verify: { confirmed: true, matchedText: true, matchedOwnIdentity: true, articleCount: 1 },
  });
  const ex = makeExecutor(cdp);
  const r = await ex.submitComment('https://www.facebook.com/groups/1/posts/2/', '很喜欢这条分享');
  assert.equal(r.ok, true);
  assert.equal(r.submitted, true);
  assert.equal(r.serverConfirmed, true);
  // 提交经回车（语言无关），不依赖按钮文案。
  assert.ok(cdp.enters >= 1, '应按回车提交');
  assert.equal(cdp.reloads, 1);
  assert.match(cdp.typed, /很喜欢这条分享/);
});

test('fb-executor: 联系方式用 Input.insertText 整段追加，正文仍先拟人输入', async () => {
  const cdp = new FakeCdp({
    verify: { confirmed: true, matchedText: true, matchedOwnIdentity: true, articleCount: 1 },
  });
  const ex = makeExecutor(cdp);
  const r = await ex.submitComment('https://www.facebook.com/groups/1/posts/2/', '正文评论', 'LINE ID: abc123');
  assert.equal(r.ok, true);
  assert.match(cdp.typed, /正文评论/);
  assert.match(cdp.typed, /\nLINE ID: abc123/);
  assert.ok(cdp.enters >= 1, '联系方式插入后仍用回车提交');
});

test('fb-executor: reload 后仅乐观渲染、own-identity 未命中 → verification_ambiguous（F1 补丁②：不冒充成功）', async () => {
  const cdp = new FakeCdp({
    verify: { confirmed: false, matchedText: true, matchedOwnIdentity: false, articleCount: 1 },
  });
  const ex = makeExecutor(cdp);
  const r = await ex.submitComment('https://www.facebook.com/groups/1/posts/2/', '很喜欢这条分享');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'verification_ambiguous');
  assert.equal(r.submitted, true);
  assert.equal(r.serverConfirmed, false);
});

test('fb-executor: 提交前验证码 fresh 复检命中 → blocked_by_captcha，不提交', async () => {
  const cdp = new FakeCdp();
  const ex = makeExecutor(cdp, { overlayMonitor: overlay('captcha') });
  const r = await ex.submitComment('https://www.facebook.com/groups/1/posts/2/', '很喜欢这条分享');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked_by_captcha');
  assert.equal(r.submitted, false);
  assert.equal(cdp.clicks.length, 0);
});

test('fb-executor: 评论框催不出 → editor_not_found，不提交', async () => {
  const cdp = new FakeCdp({ focus: { found: false, focused: false, permissionGated: false } });
  const ex = makeExecutor(cdp);
  const r = await ex.submitComment('https://www.facebook.com/groups/1/posts/2/', '很喜欢这条分享');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'editor_not_found');
  assert.equal(r.submitted, false);
});

test('fb-executor: 群问答门槛（permissionGated）→ 不提交', async () => {
  const cdp = new FakeCdp({ focus: { found: true, focused: false, permissionGated: true } });
  const ex = makeExecutor(cdp);
  const r = await ex.submitComment('https://www.facebook.com/groups/1/posts/2/', '很喜欢这条分享');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'permission_gated');
  assert.equal(r.submitted, false);
});

test('fb-executor: 受控输入未被接受 → marker_not_accepted，不提交', async () => {
  const cdp = new FakeCdp({ accepted: false });
  const ex = makeExecutor(cdp);
  const r = await ex.submitComment('https://www.facebook.com/groups/1/posts/2/', '很喜欢这条分享');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'marker_not_accepted');
  assert.equal(r.submitted, false);
});
