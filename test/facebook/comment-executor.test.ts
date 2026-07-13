import test from 'node:test';
import assert from 'node:assert/strict';

import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import type { OverlayKind, OverlayMonitor } from '../../src/browse/overlay-monitor.js';
import { FacebookCommentExecutor, isFacebookCommentEditorLabel, isServerFacebookCommentId } from '../../src/facebook/comment-executor.js';

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
  contactAccepted?: boolean;
  submitCtl?: { found: boolean; disabled: boolean; label: string | null; x: number; y: number };
  verify?: { confirmed: boolean; matchedText: boolean; matchedOwnIdentity: boolean; articleCount: number };
  /** 就地 ack 门控确认结果（默认不确认 → 流程落到刷新兜底，保留旧路径覆盖）。 */
  ack?: { ackConfirmed: boolean; serverId?: boolean; reactions?: number };
  /** 刷新兜底三重确认只在第 N 次及以后命中（模拟慢渲染，验证有界轮询治 P2② 假阴性）。 */
  verifyConfirmAfter?: number;
  containerName?: string | null;
  postContent?: { postText: string | null; comments: string[] };
}

class FakeCdp implements BrowseCdp {
  navigations: string[] = [];
  reloads = 0;
  scrolls = 0;
  clicks: Array<{ x: number; y: number }> = [];
  typed = '';
  insertTexts: string[] = [];
  backspaces = 0;
  enters = 0;
  verifyCalls = 0;
  scrollY = 0;
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
      if (params.type === 'mouseWheel') {
        this.scrolls++;
        this.scrollY += Number(params.deltaY);
      }
      if (params.type === 'mousePressed') this.clicks.push({ x: Number(params.x), y: Number(params.y) });
      return {} as T;
    }
    if (method === 'Input.insertText') {
      const text = String(params.text ?? '');
      this.insertTexts.push(text);
      this.typed += text;
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
      if (expr.includes('window.innerWidth')) return val(JSON.stringify({ w: 1280, h: 800 }));
      if (expr.includes('window.scrollY')) return val(JSON.stringify({ y: this.scrollY }));
      if (expr.includes('window.scrollBy')) return val(undefined);
      if (expr.includes('focused:focused')) {
        return val(JSON.stringify(this.cfg.focus ?? { found: true, focused: true, permissionGated: false }));
      }
      if (expr.includes('accepted: t.indexOf')) {
        return val(JSON.stringify({ accepted: this.cfg.accepted ?? true }));
      }
      if (expr.includes('{accepted:accepted}')) {
        return val(JSON.stringify({ accepted: this.cfg.contactAccepted ?? true }));
      }
      if (expr.includes('r.left+r.width/2')) {
        return val(JSON.stringify(this.cfg.submitCtl ?? { found: true, disabled: false, label: 'Post', x: 50, y: 60 }));
      }
      if (expr.includes('selectNodeContents')) return val('selected');
      if (expr.includes('ackConfirmed')) {
        return val(JSON.stringify(this.cfg.ack ?? { ackConfirmed: false, serverId: false, reactions: 0 }));
      }
      if (expr.includes('matchedOwnIdentity')) {
        this.verifyCalls++;
        if (this.cfg.verifyConfirmAfter !== undefined) {
          const confirmed = this.verifyCalls >= this.cfg.verifyConfirmAfter;
          return val(JSON.stringify({ confirmed, matchedText: true, matchedOwnIdentity: confirmed, articleCount: 1 }));
        }
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

// 默认注入「无同意条」no-op：隔离 comment 逻辑测试，不让真 detector 多消费一次序列型 eval。
// cookie 同意浮层真实行为由 consent.test.ts 覆盖，wiring 由本文件专门的 consent 用例覆盖。
const NO_CONSENT = async () => ({ handled: false, cleared: false, attempts: 0 });

function makeExecutor(
  cdp: FakeCdp,
  over: {
    accountId?: string;
    overlayMonitor?: OverlayMonitor;
    acceptConsent?: (cdp: BrowseCdp) => Promise<{ handled: boolean; cleared: boolean; attempts: number }>;
  } = {},
) {
  return new FacebookCommentExecutor(
    {
      cdp,
      getAccountId: () => (over.accountId === undefined ? '100000123456789' : over.accountId),
      ...(over.overlayMonitor ? { overlayMonitor: over.overlayMonitor } : {}),
      acceptConsent: over.acceptConsent ?? NO_CONSENT,
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

test('fb-executor: cookie 同意浮层清不掉 → blocked_by_consent（先于阻断判定）', async () => {
  const cdp = new FakeCdp({ structureFor: () => struct({ postCandidates: [post('https://www.facebook.com/groups/1/posts/2/')] }) });
  const ex = makeExecutor(cdp, {
    overlayMonitor: overlay('none'),
    acceptConsent: async () => ({ handled: true, cleared: false, attempts: 3 }),
  });
  const r = await ex.searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked_by_consent');
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
  assert.ok(cdp.scrolls >= 8 && cdp.scrolls <= 15, `应走一次多帧惯性滚动，实际 ${cdp.scrolls} 帧`);
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
    { cdp, getAccountId: () => undefined, acceptConsent: NO_CONSENT, sleep: async () => {}, logger: () => {} },
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

test('fb-executor: 联系方式逐字符追加并验收，避免换行+联系方式整段 bulk 被 FB 吞掉', async () => {
  const cdp = new FakeCdp({
    verify: { confirmed: true, matchedText: true, matchedOwnIdentity: true, articleCount: 1 },
  });
  const ex = makeExecutor(cdp);
  const r = await ex.submitComment('https://www.facebook.com/groups/1/posts/2/', '正文评论', 'LINE ID: abc123');
  assert.equal(r.ok, true);
  assert.match(cdp.typed, /正文评论/);
  assert.match(cdp.typed, /\nLINE ID: abc123/);
  assert.equal(cdp.insertTexts.some((text) => text === '\nLINE ID: abc123'), false, '不得再用失败的换行+联系方式整段 bulk 追加');
  assert.equal(cdp.insertTexts.some((text) => text === '\n'), true, '换行应作为独立输入事件进入编辑器');
  assert.ok(cdp.enters >= 1, '联系方式插入后仍用回车提交');
});

test('fb-executor: 联系方式追加后未被编辑器验收 → 不提交，避免裸发正文', async () => {
  const cdp = new FakeCdp({ contactAccepted: false });
  const ex = makeExecutor(cdp);
  const r = await ex.submitComment('https://www.facebook.com/groups/1/posts/2/', '正文评论', 'LINE ID: abc123');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'marker_not_accepted');
  assert.equal(r.submitted, false);
  assert.equal(cdp.enters, 0, '联系方式没被验收时不能按 Enter 发布');
  assert.ok(cdp.backspaces >= 1, '失败时应清空草稿');
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

test('fb-executor: 就地 ack 命中（服务器 id / 点赞回复出现）→ ok:true 且不刷新（快确认）', async () => {
  const cdp = new FakeCdp({ ack: { ackConfirmed: true, serverId: true, reactions: 4 } });
  const ex = makeExecutor(cdp);
  const r = await ex.submitComment('https://www.facebook.com/groups/1/posts/2/', '很喜欢这条分享');
  assert.equal(r.ok, true);
  assert.equal(r.serverConfirmed, true);
  assert.equal(cdp.reloads, 0, '就地已确认则绝不刷新（比现状又快又准）');
  assert.ok(cdp.enters >= 1, '仍经回车提交');
});

test('fb-executor: 就地未确认但刷新后有界轮询稍后一轮命中 → ok:true（治慢渲染假阴性 P2②）', async () => {
  // 就地 ack 默认不确认 → 刷新兜底；前两次三重确认落空，第 3 次才命中（模拟慢渲染）。
  const cdp = new FakeCdp({ verifyConfirmAfter: 3 });
  const ex = makeExecutor(cdp);
  const r = await ex.submitComment('https://www.facebook.com/groups/1/posts/2/', '很喜欢这条分享');
  assert.equal(r.ok, true);
  assert.equal(r.serverConfirmed, true);
  assert.equal(cdp.reloads, 1, '只刷新一次');
  assert.ok(cdp.verifyCalls >= 3, '刷新后应有界轮询多次直到命中，而非只查一次');
});

test('isServerFacebookCommentId: 服务器正式 id 认、客户端乐观占位/空不认', () => {
  // 真机探针取到的正式 id（base64 "comment:" 前缀）。
  assert.equal(isServerFacebookCommentId('Y29tbWVudDoxNTY0OTc1MzcxOTU0ODUxXzIzMjc1NTgxOTQzMTgxMjc='), true);
  // 乐观占位（回车后 ~68ms 就有、服务器点头前，绝不据此判成功）。
  assert.equal(isServerFacebookCommentId('client:1234567890'), false);
  assert.equal(isServerFacebookCommentId('clientabc'), false);
  // 空/空白/未知前缀 → 保守不认（安全降级到点赞回复信号或刷新兜底）。
  assert.equal(isServerFacebookCommentId(''), false);
  assert.equal(isServerFacebookCommentId('   '), false);
  assert.equal(isServerFacebookCommentId('99887766'), false);
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

// ─────────────────────────── comment-editor label detection ───────────────────────────
// 页内 fbEditors() 用 FakeCdp 只回罐装 focus、测不到真正的标签正则；这条回归直接打标签断言（与页内同源）。
test('fb-executor: 评论框标签识别覆盖真机变体与多语言（回归 发表公开评论 漏配 → 评论从未发出）', () => {
  // 真机实证漏配（zh-Hans 群帖详情页评论框 aria-label）——此前使 fbEditors() 恒空、误报 editor_not_found。
  assert.equal(isFacebookCommentEditorLabel('发表公开评论…'), true);
  // 其余中文变体
  for (const l of ['写评论', '发表评论', '以 Tianxing Bai 的身份发表评论', '评论', '留言']) {
    assert.equal(isFacebookCommentEditorLabel(l), true, l);
  }
  // en / vi / es 变体（该账号亦定向越南语/西语群，界面语言可能被切换）
  for (const l of ['Write a comment', 'Write a public comment…', 'Comment as Tom', 'Bình luận', 'Viết bình luận công khai', 'Comentar', 'Escribe un comentario']) {
    assert.equal(isFacebookCommentEditorLabel(l), true, l);
  }
  // 群问答帖回答框（合法回帖框，保留原支持）
  assert.equal(isFacebookCommentEditorLabel('输入回答…'), true);
  assert.equal(isFacebookCommentEditorLabel('Answer'), true);
  // 无关编辑框标签不误配（贴图/动图「评论」是 role=button、由 fbEditors 的选择器排除，不在标签层否定之列）。
  for (const l of ['你在想什么？', "What's on your mind?", '输入消息…', 'Message', 'Search Facebook', '', null, undefined]) {
    assert.equal(isFacebookCommentEditorLabel(l), false, String(l));
  }
});
