import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 登录门契约守卫：main.cjs 带 Electron 顶层副作用，沿用源码断言锁住凭据记忆边界。
const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string) => readFileSync(join(here, '../../src/electron', rel), 'utf8');
const main = readSrc('main.cjs');
const preload = readSrc('preload.cjs');
const login = readSrc('renderer/login.html');

test('登录记忆使用 safeStorage 加密文件，不写明文回退', () => {
  assert.match(main, /safeStorage\.encryptString\(/, '成功登录后的记忆必须经 safeStorage 加密');
  assert.match(main, /safeStorage\.decryptString\(/, '登录页回填必须由主进程解密');
  assert.match(main, /client-login-prefill\.json/, '记忆文件必须位于独立文件，不混入 session 文件');
  assert.match(main, /clientLoginPrefillEncryptionAvailable/, '加密能力不可用时必须显式降级');
  assert.doesNotMatch(main, /writeFileSync\([^\n]*client-login-prefill[^\n]*JSON\.stringify\(\{\s*name:/, '不得把凭据对象明文写入记忆文件');
});

test('成功登录保存完整输入，session 文件仍只承载会话', () => {
  assert.match(main, /saveClientLoginPrefill\(\{\s*name,\s*key\s*\}\)/, '登录成功后必须保存账户名和访问密钥');
  assert.match(main, /saveClientSession\(\{\s*token:\s*r\.data\.token/, '客户会话仍独立保存 token');
});

test('退出或会话失效统一清除凭据记忆', () => {
  assert.match(main, /function clearClientSession\(\)[\s\S]*?clearClientLoginPrefill\(\)/, '清 session 的统一路径必须清记忆');
  assert.match(main, /ipcMain\.handle\(['"]client-auth:logout['"][\s\S]*?onSessionInvalid\(\)/, '显式退出必须复用会话失效路径');
});

test('preload 只暴露读取和清除记忆的窄 IPC', () => {
  assert.match(preload, /clientLoginPrefill:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]client-auth:prefill['"]\)/);
  assert.match(preload, /clearClientLoginPrefill:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]client-auth:prefill:clear['"]\)/);
});

test('登录页加载回填，手动清空任一字段即清除', () => {
  assert.match(login, /api\.clientLoginPrefill\(\)/, '登录页打开时读取回填');
  assert.match(login, /if \(!nameEl\.value\.trim\(\) \|\| !key\.value\.trim\(\)\) clearRememberedCredentials\(\)/, '任一字段为空即清除记忆');
  assert.match(login, /api\.clearClientLoginPrefill\(\)/, '手动清空必须通过主进程清除');
  assert.match(login, /userEdited\s*=\s*true/, '用户开始编辑后不得被异步回填覆盖');
});
