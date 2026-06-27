import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractIdFromHref,
  isValidStableId,
  deriveInPlaceSelfId,
  readSelfIdentity,
  decideHandshakeIdentity,
  type SelfIdentitySignals,
  type SelfIdentityResult,
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

// ---- readSelfIdentity（注入假 CDP，按表达式分流应答）----

interface FakeResponses {
  scan: string; // IN_PLACE_SCAN_JS 的 JSON 串
  display?: string;
  onProfile?: boolean;
  url?: string;
}

function fakeCdp(r: FakeResponses): BrowseCdp {
  const send = async (_method: string, params?: Record<string, unknown>) => {
    const e = String((params as { expression?: string } | undefined)?.expression ?? '');
    let value: unknown = '';
    if (e.includes('avatarAnchorHref')) value = r.scan;
    else if (e.includes('小红书号')) value = r.display ?? JSON.stringify({ nickname: null, redId: null });
    else if (e.includes('test(location.href)')) value = r.onProfile ?? false;
    else if (e.includes('.click()')) value = true;
    else if (e.includes('return location.href')) value = r.url ?? '';
    return { result: { value } };
  };
  return { send } as unknown as BrowseCdp;
}

const fastOpts = { sleep: async () => undefined, now: () => 0 };

test('readSelfIdentity: 就地读成功（source=in-place，昵称取自自作用域 scan，不跳转）', async () => {
  const cdp = fakeCdp({
    // 自作用域 scan 在自己导航容器内读到昵称/redId
    scan: JSON.stringify({ href: '/explore', avatarAnchorHref: `/user/profile/${REAL_ID}`, navProfileHrefs: [], nickname: '小明', redId: 'xm_123' }),
    // 全局 readDisplay 即便返回别的名字，就地路径也不采用它（见下方红线测试）
    display: JSON.stringify({ nickname: '别人', redId: 'other' }),
  });
  const res = await readSelfIdentity(cdp, fastOpts);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.identity.accountId, REAL_ID);
    assert.equal(res.identity.source, 'in-place');
    assert.equal(res.identity.displayName, '小明'); // 自作用域 scan 的昵称，非全局 readDisplay
    assert.equal(res.identity.redId, 'xm_123');
  }
});

test('readSelfIdentity: 就地昵称为空不回退全局查询（红线：绝不错配被浏览作者昵称）', async () => {
  const cdp = fakeCdp({
    // 自作用域读不到昵称（nickname:null）
    scan: JSON.stringify({ href: '/explore', avatarAnchorHref: `/user/profile/${REAL_ID}`, navProfileHrefs: [], nickname: null, redId: null }),
    // 全局 readDisplay 在 feed 上会命中【被浏览作者】的名字——就地路径 MUST NOT 采用它
    display: JSON.stringify({ nickname: '被浏览的作者', redId: 'author_x' }),
  });
  const res = await readSelfIdentity(cdp, fastOpts);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.identity.source, 'in-place');
    assert.equal(res.identity.displayName, null); // 读不到 → null，绝不用全局命中的他人昵称
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

const okRes = (id: string, source: 'in-place' | 'navigate' = 'in-place'): SelfIdentityResult => ({
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
  const d = decideHandshakeIdentity(okRes(REAL_ID), 'default');
  assert.equal(d.kind, 'use');
  if (d.kind === 'use') {
    assert.equal(d.accountId, 'default');
    assert.deepEqual(d.mismatch, { override: 'default', real: REAL_ID });
  }
});

test('decideHandshakeIdentity: 读不出 + 有覆盖 → 用覆盖（逃生阀）', () => {
  const d = decideHandshakeIdentity(failRes, 'default');
  assert.equal(d.kind, 'use-override-after-read-fail');
  if (d.kind === 'use-override-after-read-fail') assert.equal(d.accountId, 'default');
});

test('decideHandshakeIdentity: 读不出 + 无覆盖 → halt（红线：绝不回落 default）', () => {
  const d = decideHandshakeIdentity(failRes, undefined);
  assert.equal(d.kind, 'halt');
});
