import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, '../../src/electron/main.cjs'), 'utf8');
const buildScript = readFileSync(join(here, '../../scripts/build-desktop-macos.sh'), 'utf8');
const buildWorkflow = readFileSync(join(here, '../../.github/workflows/build-desktop.yml'), 'utf8');
const code = main.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');

test('dev and ol have default client-auth URLs', () => {
  assert.match(
    main,
    /CLIENT_AUTH_ENV_URLS\s*=\s*\{[\s\S]*dev:\s*'http:\/\/121\.89\.85\.150:8088\/capi'[\s\S]*ol:\s*'https:\/\/aidcp\.tommax\.cc\/capi'[\s\S]*\}/,
  );
});

test('client-auth URL priority is explicit, baked, then environment default', () => {
  assert.match(
    code,
    /const explicit = normalizeClientAuthUrl[\s\S]*?if \(explicit\) return explicit;[\s\S]*?if \(BAKED_CLIENT_AUTH_URL\) return BAKED_CLIENT_AUTH_URL;[\s\S]*?const envDefault = CLIENT_AUTH_ENV_URLS\[cloud\.key\];[\s\S]*?if \(envDefault\) return envDefault;/,
  );
});

test('desktop build paths fill dev and ol client-auth URLs by default', () => {
  assert.match(buildScript, /dev\)\s*client_auth_url="http:\/\/121\.89\.85\.150:8088\/capi"/);
  assert.match(buildScript, /ol\)\s*client_auth_url="https:\/\/aidcp\.tommax\.cc\/capi"/);
  assert.match(buildWorkflow, /dev\) auth_url="http:\/\/121\.89\.85\.150:8088\/capi"/);
  assert.match(buildWorkflow, /ol\) auth_url="https:\/\/aidcp\.tommax\.cc\/capi"/);
  assert.match(buildWorkflow, /\$authUrl = 'http:\/\/121\.89\.85\.150:8088\/capi'/);
  assert.match(buildWorkflow, /\$authUrl = 'https:\/\/aidcp\.tommax\.cc\/capi'/);
});
