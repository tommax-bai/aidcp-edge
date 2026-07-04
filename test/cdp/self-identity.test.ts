import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractIdFromHref,
  isValidStableId,
  deriveInPlaceSelfId,
  deriveCreatorStorageIdentity,
  classifyPageContext,
  readSelfIdentity,
  decideHandshakeIdentity,
  type SelfIdentitySignals,
  type CreatorStorageIdentitySignals,
  type SelfIdentityResult,
  type SelfIdentitySource,
} from '../../src/cdp/index.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

const REAL_ID = '63e2ff0500000000260049ce'; // 0.1 真机实测形态：24 位 hex

// ---- 纯函数 ----

test('extractIdFromHref: 抽出 /user/profile/<id>', () => {
  assert.equal(extractIdFromHref(`/user/profile/${REAL_ID}`), REAL_ID);
  assert.equal(extractIdFromHref(`https://www.xiaohongshu.com/user/profile/${REAL_ID}?tab=note`), REAL_ID);
  assert.equal(extractIdFromHref('/explore'), '');
  assert.equal(extractIdFromHref(null), '');
  assert.equal(extractIdFromHref(undefined), '');
});

test('isValidStableId: 硬形态闸放行真实 id、挡畸形/空', () => {
  assert.equal(isValidStableId(REAL_ID), true);
  assert.equal(isValidStableId(''), false);
  assert.equal(isValidStableId('abc'), false); // 非空但太短 → 挡住（防污染主表）
  assert.equal(isValidStableId('not-an-id!!'), false); // 含非法字符
});

test('deriveInPlaceSelfId: 首选头像祖先锚点，兜底导航区锚点', () => {
  const base: SelfIdentitySignals = { href: '/explore', avatarAnchorHref: null, navProfileHrefs: [], nickname: null, redId: null };
  // 头像锚点优先
  assert.equal(deriveInPlaceSelfId({ ...base, avatarAnchorHref: `/user/profile/${REAL_ID}` }), REAL_ID);
  // 头像缺失 → 退到导航区锚点
  assert.equal(deriveInPlaceSelfId({ ...base, navProfileHrefs: [`/user/profile/${REAL_ID}`] }), REAL_ID);
  // 头像锚点畸形 → 不取，继续找导航区合规的
  assert.equal(deriveInPlaceSelfId({ ...base, avatarAnchorHref: '/user/profile/abc', navProfileHrefs: [`/user/profile/${REAL_ID}`] }), REAL_ID);
  // 都没有 → ''（交调用方走兜底/诚实失败）
  assert.equal(deriveInPlaceSelfId(base), '');
});

test('deriveCreatorStorageIdentity: 创作平台存储稳定 id 一致 → 读出 id，昵称只作显示名', () => {
  const signals: CreatorStorageIdentitySignals = {
    href: 'https://creator.xiaohongshu.com/statistics/account/v2',
    userId: REAL_ID,
    userName: ' 工程师大白 ',
    redId: '5039527968',
    snsWebPublishCurrentUser: REAL_ID,
    userInfoUserId: REAL_ID,
    npsUserId: REAL_ID,
  };
  const res = deriveCreatorStorageIdentity(signals);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.accountId, REAL_ID);
    assert.equal(res.displayName, '工程师大白');
    assert.equal(res.redId, '5039527968');
  }
});

test('deriveCreatorStorageIdentity: 创作平台存储无合规 id / 合规 id 冲突 → 拒绝采信', () => {
  const base: CreatorStorageIdentitySignals = {
    href: 'https://creator.xiaohongshu.com/statistics/account/v2',
    userId: null,
    userName: '工程师大白',
    redId: null,
    snsWebPublishCurrentUser: null,
    userInfoUserId: null,
    npsUserId: null,
  };
  assert.deepEqual(deriveCreatorStorageIdentity({ ...base, userId: 'abc' }), {
    ok: false,
    reason: '创作平台存储无形态合规的稳定 id',
  });
  const conflict = deriveCreatorStorageIdentity({
    ...base,
    userId: REAL_ID,
    snsWebPublishCurrentUser: 'a1b2c3d4e5f60718293a4b5c',
  });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.match(conflict.reason, /冲突/);
});

test('classifyPageContext: 按子域/路径分身份判定上下文', () => {
  // 消费端 web（有「我」锚点、可读稳定 id）
  assert.equal(classifyPageContext('https://www.xiaohongshu.com/explore'), 'consumer');
  assert.equal(classifyPageContext(`https://www.xiaohongshu.com/user/profile/${REAL_ID}`), 'consumer');
  // AI 搜索结果页仍属消费端子域（无侧栏的判定交 watcher 的登录浮层探针，不在 URL 分类里区分）
  assert.equal(classifyPageContext('https://www.xiaohongshu.com/search_result_ai?keyword=x'), 'consumer');
  assert.equal(classifyPageContext('https://xiaohongshu.com/explore'), 'consumer');
  // 创作平台真实页（登录门禁）→ creator-app；被弹登录页 → creator-login
  assert.equal(classifyPageContext('https://creator.xiaohongshu.com/publish/publish?source=official'), 'creator-app');
  assert.equal(classifyPageContext('https://creator.xiaohongshu.com/statistics/account/v2'), 'creator-app');
  assert.equal(classifyPageContext('https://creator.xiaohongshu.com/login'), 'creator-login');
  // 无法判定：空/畸形/非小红书/about:blank
  assert.equal(classifyPageContext(''), 'unknown');
  assert.equal(classifyPageContext(null), 'unknown');
  assert.equal(classifyPageContext('not a url'), 'unknown');
  assert.equal(classifyPageContext('about:blank'), 'unknown');
  assert.equal(classifyPageContext('https://www.google.com/'), 'unknown');
});

// ---- readSelfIdentity（注入假 CDP，按表达式分流应答）----

interface FakeResponses {
  scan: string; // IN_PLACE_SCAN_JS 的 JSON 串
  creatorStorage?: string;
  display?: string;
  onProfile?: boolean;
  url?: string;
}

function fakeCdp(r: FakeResponses): BrowseCdp {
  const send = async (_method: string, params?: Record<string, unknown>) => {
    const e = String((params as { expression?: string } | undefined)?.expression ?? '');
    let value: unknown = '';
    if (e.includes('avatarAnchorHref')) value = r.scan;
    else if (e.includes('USER_INFO_FOR_BIZ')) value = r.creatorStorage ?? JSON.stringify({
      href: 'https://creator.xiaohongshu.com/statistics/account/v2',
      userId: null,
      userName: null,
      redId: null,
      snsWebPublishCurrentUser: null,
      userInfoUserId: null,
      npsUserId: null,
    });
    else if (e.includes('小红书号')) value = r.display ?? JSON.stringify({ nickname: null, redId: null });
    else if (e.includes('test(location.href)')) value = r.onProfile ?? false;
    else if (e.includes('.click()')) value = true;
    else if (e.includes('return location.href')) value = r.url ?? '';
    return { result: { value } };
  };
  return { send } as unknown as BrowseCdp;
}

const fastOpts = { sleep: async () => undefined, now: () => 0 };

test('readSelfIdentity: 就地读成功（source=in-place，只确立 id、昵称留空、不跳转、不回退全局 readDisplay）', async () => {
  const cdp = fakeCdp({
    scan: JSON.stringify({ href: '/explore', avatarAnchorHref: `/user/profile/${REAL_ID}`, navProfileHrefs: [], nickname: null, redId: null }),
    // 全局 readDisplay 即便返回别的名字，就地路径也绝不采用它（红线：绝不把 feed 上被浏览作者错当成自己）
    display: JSON.stringify({ nickname: '别人', redId: 'other' }),
  });
  const res = await readSelfIdentity(cdp, fastOpts);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.identity.accountId, REAL_ID);
    assert.equal(res.identity.source, 'in-place');
    assert.equal(res.identity.displayName, null); // 就地路径不读昵称（登录账号真实昵称改由云端角色采集）
    assert.equal(res.identity.redId, null);
  }
});

test('readSelfIdentity: 就地无锚点 → 跳转兜底成功（source=navigate，昵称经自己主页 readDisplay 读出）', async () => {
  const cdp = fakeCdp({
    scan: JSON.stringify({ href: '/explore', avatarAnchorHref: null, navProfileHrefs: [], nickname: null, redId: null }),
    onProfile: true,
    url: `https://www.xiaohongshu.com/user/profile/${REAL_ID}`,
    // navigate 路径在【自己主页】上跑 readDisplay 是安全的（页面主体即本人）→ 仍采用其结果
    display: JSON.stringify({ nickname: '小明', redId: 'xm_123' }),
  });
  const res = await readSelfIdentity(cdp, fastOpts);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.identity.accountId, REAL_ID);
    assert.equal(res.identity.source, 'navigate');
    assert.equal(res.identity.displayName, '小明'); // 自己主页 readDisplay 仍生效
  }
});

test('readSelfIdentity: 启动停在创作平台真实页 → 从 creator 存储读稳定 id，不依赖点击入口', async () => {
  const cdp = fakeCdp({
    scan: JSON.stringify({
      href: 'https://creator.xiaohongshu.com/statistics/account/v2',
      avatarAnchorHref: null,
      navProfileHrefs: [],
      meAnchorHref: null,
      nickname: null,
      redId: null,
    }),
    creatorStorage: JSON.stringify({
      href: 'https://creator.xiaohongshu.com/statistics/account/v2',
      userId: REAL_ID,
      userName: '工程师大白',
      redId: '5039527968',
      snsWebPublishCurrentUser: REAL_ID,
      userInfoUserId: REAL_ID,
      npsUserId: REAL_ID,
    }),
    onProfile: false,
  });
  const res = await readSelfIdentity(cdp, fastOpts);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.identity.accountId, REAL_ID);
    assert.equal(res.identity.source, 'creator-storage');
    assert.equal(res.identity.displayName, '工程师大白');
    assert.equal(res.identity.redId, '5039527968');
  }
});

test('readSelfIdentity: 创作平台登录页即使存储残留 id 也诚实失败', async () => {
  const cdp = fakeCdp({
    scan: JSON.stringify({
      href: 'https://creator.xiaohongshu.com/login',
      avatarAnchorHref: null,
      navProfileHrefs: [],
      meAnchorHref: null,
      nickname: null,
      redId: null,
    }),
    creatorStorage: JSON.stringify({
      href: 'https://creator.xiaohongshu.com/login',
      userId: REAL_ID,
      userName: '工程师大白',
      redId: '5039527968',
      snsWebPublishCurrentUser: REAL_ID,
      userInfoUserId: REAL_ID,
      npsUserId: REAL_ID,
    }),
  });
  const res = await readSelfIdentity(cdp, fastOpts);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /创作平台登录页/);
});

test('readSelfIdentity: 创作平台存储 id 冲突且禁用跳转 → 诚实失败，不用昵称兜底', async () => {
  const cdp = fakeCdp({
    scan: JSON.stringify({
      href: 'https://creator.xiaohongshu.com/statistics/account/v2',
      avatarAnchorHref: null,
      navProfileHrefs: [],
      meAnchorHref: null,
      nickname: null,
      redId: null,
    }),
    creatorStorage: JSON.stringify({
      href: 'https://creator.xiaohongshu.com/statistics/account/v2',
      userId: REAL_ID,
      userName: '工程师大白',
      redId: '5039527968',
      snsWebPublishCurrentUser: 'a1b2c3d4e5f60718293a4b5c',
      userInfoUserId: null,
      npsUserId: null,
    }),
  });
  const res = await readSelfIdentity(cdp, { ...fastOpts, allowNavigate: false });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.reason, /冲突/);
    assert.doesNotMatch(res.reason, /工程师大白/);
  }
});

test('readSelfIdentity: 读不出 → 诚实失败（ok:false，不回落 default）', async () => {
  const cdp = fakeCdp({
    scan: JSON.stringify({ href: '/explore', avatarAnchorHref: null, navProfileHrefs: [], nickname: null, redId: null }),
  });
  const res = await readSelfIdentity(cdp, { ...fastOpts, allowNavigate: false });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /就地读不出/);
});

test('readSelfIdentity: 非空但畸形 id → 诚实失败（形态闸拦住，不污染主表）', async () => {
  const cdp = fakeCdp({
    scan: JSON.stringify({ href: '/explore', avatarAnchorHref: '/user/profile/abc', navProfileHrefs: [], nickname: null, redId: null }),
  });
  const res = await readSelfIdentity(cdp, { ...fastOpts, allowNavigate: false });
  assert.equal(res.ok, false);
});

test('readSelfIdentity: 进了主页但 URL 无合规 id → 诚实失败', async () => {
  const cdp = fakeCdp({
    scan: JSON.stringify({ href: '/explore', avatarAnchorHref: null, navProfileHrefs: [], nickname: null, redId: null }),
    onProfile: true,
    url: 'https://www.xiaohongshu.com/user/profile/', // 无 id
  });
  const res = await readSelfIdentity(cdp, fastOpts);
  assert.equal(res.ok, false);
});

// ---- decideHandshakeIdentity（握手身份优先级 + 红线，纯函数）----

const okRes = (id: string, source: SelfIdentitySource = 'in-place'): SelfIdentityResult => ({
  ok: true,
  identity: { accountId: id, displayName: null, redId: null, source },
});
const failRes: SelfIdentityResult = { ok: false, reason: '就地读不出稳定 id 且禁用跳转兜底' };

test('decideHandshakeIdentity: 读出真实 id、无覆盖 → 用真实 id', () => {
  const d = decideHandshakeIdentity(okRes(REAL_ID, 'navigate'), undefined);
  assert.equal(d.kind, 'use');
  if (d.kind === 'use') {
    assert.equal(d.accountId, REAL_ID);
    assert.equal(d.source, 'navigate');
    assert.equal(d.mismatch, undefined);
  }
});

test('decideHandshakeIdentity: 覆盖 = 真实 id → 用覆盖、无 mismatch', () => {
  const d = decideHandshakeIdentity(okRes(REAL_ID), REAL_ID);
  assert.equal(d.kind, 'use');
  if (d.kind === 'use') {
    assert.equal(d.accountId, REAL_ID);
    assert.equal(d.mismatch, undefined);
  }
});

test('decideHandshakeIdentity: 覆盖 ≠ 真实 id → 用覆盖、标 mismatch（供告警）', () => {
  const d = decideHandshakeIdentity(okRes(REAL_ID), 'acct-manual-override');
  assert.equal(d.kind, 'use');
  if (d.kind === 'use') {
    assert.equal(d.accountId, 'acct-manual-override');
    assert.deepEqual(d.mismatch, { override: 'acct-manual-override', real: REAL_ID });
  }
});

test('decideHandshakeIdentity: 读不出 + 有覆盖 → 用覆盖（逃生阀）', () => {
  const d = decideHandshakeIdentity(failRes, 'acct-manual-override');
  assert.equal(d.kind, 'use-override-after-read-fail');
  if (d.kind === 'use-override-after-read-fail') assert.equal(d.accountId, 'acct-manual-override');
});

test('retire-default-account: 覆盖值=default 被拒（等同未设覆盖）→ 读出真实 id 则用真实 id', () => {
  const d = decideHandshakeIdentity(okRes(REAL_ID, 'navigate'), 'default');
  assert.equal(d.kind, 'use');
  if (d.kind === 'use') {
    assert.equal(d.accountId, REAL_ID, 'override=default 被忽略，用真实 id');
    assert.equal(d.mismatch, undefined);
  }
});

test('retire-default-account: 覆盖值=default + 读不出 → halt（绝不回落 default）', () => {
  const d = decideHandshakeIdentity(failRes, 'default');
  assert.equal(d.kind, 'halt');
});

test('decideHandshakeIdentity: 读不出 + 无覆盖 → halt（红线：绝不回落 default）', () => {
  const d = decideHandshakeIdentity(failRes, undefined);
  assert.equal(d.kind, 'halt');
});
