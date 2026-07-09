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

test('profileNameForFacebookImport: does not persist imported username in profile name', () => {
  assert.equal(mod.profileNameForFacebookImport({ username: 'a@example.com' }, 0), 'Facebook import 1');
  assert.equal(mod.profileNameForFacebookImport({}, 2), 'Facebook import 3');
});
