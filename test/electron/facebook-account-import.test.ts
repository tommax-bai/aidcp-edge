import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../../src/electron/facebook-account-import.cjs') as {
  normalizeFacebookCookie: (raw: string) => { ok: boolean; cookie?: string; error?: string };
  parseFacebookAccountImport: (raw: string) => { ok: boolean; entries: Array<Record<string, unknown>>; error?: string };
  profileNameForFacebookImport: (entry: Record<string, unknown>, idx: number) => string;
};

const rawCookie = 'NID=google; datr=DAT; c_user=100000000000001; sb=SB; oo=v1|3:1; wd=1440x900; xs=40:token';

test('normalizeFacebookCookie: header cookie becomes AdsPower JSON with Facebook cookies only', () => {
  const res = mod.normalizeFacebookCookie(rawCookie);
  assert.equal(res.ok, true);
  const cookies = JSON.parse(res.cookie || '[]') as Array<{ name: string; domain: string; value: string }>;
  assert.ok(cookies.some((c) => c.name === 'c_user' && c.value === '100000000000001'));
  assert.ok(cookies.some((c) => c.name === 'xs'));
  assert.ok(cookies.every((c) => c.domain === '.facebook.com'));
  assert.ok(!cookies.some((c) => c.name === 'NID'), 'non-Facebook cookie names are not imported onto facebook.com');
});

// ── C1（facebook-locale-pin-en-us）：缺 locale → 注入 en_US；已有 locale → 保留用户值 ──
test('normalizeFacebookCookie: 缺 locale → 注入 en_US（belt 统一首屏界面语言）', () => {
  const res = mod.normalizeFacebookCookie(rawCookie); // rawCookie 不含 locale
  assert.equal(res.ok, true);
  const cookies = JSON.parse(res.cookie || '[]') as Array<{ name: string; value: string; domain: string }>;
  const locale = cookies.find((c) => c.name === 'locale');
  assert.ok(locale, '缺 locale 应被注入');
  assert.equal(locale!.value, 'en_US');
  assert.equal(locale!.domain, '.facebook.com');
});

test('normalizeFacebookCookie: 已有 locale → 保留用户值、不覆盖、不重复', () => {
  const res = mod.normalizeFacebookCookie(`${rawCookie}; locale=vi_VN`);
  assert.equal(res.ok, true);
  const cookies = JSON.parse(res.cookie || '[]') as Array<{ name: string; value: string }>;
  const locales = cookies.filter((c) => c.name === 'locale');
  assert.equal(locales.length, 1, 'locale 不应重复注入');
  assert.equal(locales[0].value, 'vi_VN', '用户已有 locale 值不被覆盖');
});

test('parseFacebookAccountImport: parses one or more lines without leaking values in errors', () => {
  const parsed = mod.parseFacebookAccountImport([
    `a@example.com----pw1----KEY1----${rawCookie}`,
    `b@example.com----pw2----KEY2----${rawCookie.replace('100000000000001', '100000000000002')}`,
  ].join('\n'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].username, 'a@example.com');
  assert.equal(parsed.entries[0].password, 'pw1');
  assert.equal(parsed.entries[0].fakey, 'KEY1');
  assert.deepEqual(parsed.entries[0].repeatConfig, [4]);
  assert.equal(parsed.entries[0].domainName, 'facebook.com');

  const bad = mod.parseFacebookAccountImport('secret@example.com----pw----KEY----datr=only');
  assert.equal(bad.ok, false);
  assert.match(bad.error || '', /第 1 行/);
  assert.doesNotMatch(bad.error || '', /secret@example.com|pw|KEY|datr/);
});

test('parseFacebookAccountImport: six-field pipe record maps email/password/cookie and drops token metadata', () => {
  const pipeCookie = rawCookie.replace('100000000000001', '100000000000003');
  const accessToken = 'EAA_TEST_ACCESS_TOKEN_SECRET';
  const timestamp = '7\\/16\\/2026 10:14:57 AM';
  const parsed = mod.parseFacebookAccountImport(
    `100000000000003|pipe-password|${pipeCookie}|${accessToken}|pipe@example.com|${timestamp}`,
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].username, 'pipe@example.com');
  assert.equal(parsed.entries[0].password, 'pipe-password');
  assert.equal(Object.hasOwn(parsed.entries[0], 'fakey'), false, 'access token must not be treated as 2FA');
  assert.equal(Object.hasOwn(parsed.entries[0], 'uid'), false);
  assert.equal(Object.hasOwn(parsed.entries[0], 'accessToken'), false);
  assert.equal(Object.hasOwn(parsed.entries[0], 'timestamp'), false);
  assert.doesNotMatch(JSON.stringify(parsed.entries[0]), /EAA_TEST_ACCESS_TOKEN_SECRET|7\\\\\/16/);
});

test('parseFacebookAccountImport: recognizes uid/password/2FA/email/cookie/token with embedded cookie pipes', () => {
  const uid = '100000000000005';
  const twoFactorKey = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const accessToken = 'EAA_NEW_LAYOUT_TOKEN_SECRET';
  const pipeCookie = rawCookie.replace('100000000000001', uid);
  const parsed = mod.parseFacebookAccountImport(
    `${uid}|new-layout-password|${twoFactorKey}|new-layout@example.com|${pipeCookie}|${accessToken}`,
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].username, 'new-layout@example.com');
  assert.equal(parsed.entries[0].password, 'new-layout-password');
  assert.equal(parsed.entries[0].fakey, twoFactorKey);
  assert.equal(Object.hasOwn(parsed.entries[0], 'uid'), false);
  assert.equal(Object.hasOwn(parsed.entries[0], 'accessToken'), false);
  const cookies = JSON.parse(String(parsed.entries[0].cookie)) as Array<{ name: string; value: string }>;
  assert.equal(cookies.find((cookie) => cookie.name === 'c_user')?.value, uid);
  assert.equal(cookies.find((cookie) => cookie.name === 'oo')?.value, 'v1|3:1');
  assert.doesNotMatch(JSON.stringify(parsed.entries[0]), new RegExp(accessToken));
});

test('parseFacebookAccountImport: batches may mix all supported layouts', () => {
  const existingPipeCookie = rawCookie.replace('100000000000001', '100000000000006');
  const newPipeCookie = rawCookie.replace('100000000000001', '100000000000007');
  const parsed = mod.parseFacebookAccountImport([
    `legacy@example.com----legacy-password----LEGACY-2FA----${rawCookie}`,
    `100000000000006|existing-password|${existingPipeCookie}|EAA_EXISTING|existing@example.com|2026-07-19`,
    `100000000000007|new-password|JBSWY3DPEHPK3PXP|new@example.com|${newPipeCookie}|EAA_NEW`,
  ].join('\n'));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 3);
  assert.deepEqual(parsed.entries.map((entry) => entry.username), [
    'legacy@example.com',
    'existing@example.com',
    'new@example.com',
  ]);
  assert.equal(parsed.entries[2].fakey, 'JBSWY3DPEHPK3PXP');
});

test('parseFacebookAccountImport: new pipe layout rejects UID mismatch without credential values', () => {
  const password = 'new-mismatch-password';
  const twoFactorKey = 'JBSWY3DPEHPK3PXP';
  const email = 'new-mismatch@example.com';
  const accessToken = 'EAA_NEW_MISMATCH_SECRET';
  const bad = mod.parseFacebookAccountImport(
    `100000000000099|${password}|${twoFactorKey}|${email}|${rawCookie}|${accessToken}`,
  );

  assert.equal(bad.ok, false);
  assert.match(bad.error || '', /第 1 行.*c_user.*uid.*不一致/i);
  assert.doesNotMatch(
    bad.error || '',
    new RegExp(`100000000000099|100000000000001|${password}|${twoFactorKey}|${accessToken}|new-mismatch`),
  );
});

test('parseFacebookAccountImport: unknown and ambiguous layouts fail closed without credential values', () => {
  const unknownSecret = 'unknown-password-secret';
  const unknown = mod.parseFacebookAccountImport(
    `unknown@example.com|${unknownSecret}|not-a-cookie|unclassified-field`,
  );
  assert.equal(unknown.ok, false);
  assert.match(unknown.error || '', /第 1 行.*(?:无法识别|格式)/);
  assert.doesNotMatch(unknown.error || '', /unknown@example\.com|unknown-password-secret|not-a-cookie/);

  const uid = '100000000000008';
  const ambiguousSecret = 'ambiguous-password-secret';
  const ambiguousCookie = `datr=A----B----C----D; c_user=${uid}; xs=ambiguous-xs;`;
  const ambiguous = mod.parseFacebookAccountImport(
    `${uid}|${ambiguousSecret}|JBSWY3DPEHPK3PXP|ambiguous@example.com|${ambiguousCookie}|EAA_AMBIGUOUS_SECRET`,
  );
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error || '', /第 1 行.*歧义/);
  assert.doesNotMatch(
    ambiguous.error || '',
    new RegExp(`${uid}|${ambiguousSecret}|JBSWY3DPEHPK3PXP|ambiguous@example|EAA_AMBIGUOUS_SECRET`),
  );
});

test('parseFacebookAccountImport: pipe cookie may contain pipes and batches may mix formats', () => {
  const pipeCookie = rawCookie.replace('100000000000001', '100000000000004');
  const parsed = mod.parseFacebookAccountImport([
    `legacy@example.com----legacy-pw----LEGACY-2FA----${rawCookie}`,
    `100000000000004|pipe-pw|${pipeCookie}|EAA_TEST|pipe@example.com|2026-07-16 10:14:57`,
  ].join('\n'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].fakey, 'LEGACY-2FA');
  assert.equal(parsed.entries[1].username, 'pipe@example.com');
  const cookies = JSON.parse(String(parsed.entries[1].cookie)) as Array<{ name: string; value: string }>;
  assert.equal(cookies.find((cookie) => cookie.name === 'oo')?.value, 'v1|3:1');
});

test('parseFacebookAccountImport: pipe UID mismatch rejects safely without credential values', () => {
  const bad = mod.parseFacebookAccountImport(
    `100000000000099|mismatch-password|${rawCookie}|EAA_MISMATCH_SECRET|mismatch@example.com|2026-07-16`,
  );
  assert.equal(bad.ok, false);
  assert.match(bad.error || '', /第 1 行.*c_user.*uid.*不一致/i);
  assert.doesNotMatch(
    bad.error || '',
    /100000000000099|100000000000001|mismatch-password|EAA_MISMATCH_SECRET|mismatch@example\.com/,
  );
});

test('profileNameForFacebookImport: does not persist imported username in profile name', () => {
  assert.equal(mod.profileNameForFacebookImport({ username: 'a@example.com' }, 0), 'Facebook import 1');
  assert.equal(mod.profileNameForFacebookImport({}, 2), 'Facebook import 3');
});
