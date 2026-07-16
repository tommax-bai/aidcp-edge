import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const main = readFileSync(join(electronDir, 'main.cjs'), 'utf8');
const preload = readFileSync(join(electronDir, 'preload.cjs'), 'utf8');
const renderer = readFileSync(join(electronDir, 'renderer/content-workspace.js'), 'utf8');
const html = readFileSync(join(electronDir, 'renderer/index.html'), 'utf8');
const styles = readFileSync(join(electronDir, 'renderer/styles.css'), 'utf8');

test('灵感库 preload 只暴露四个具名 IPC，不暴露 URL、令牌或账号选择器', () => {
  for (const channel of ['curated:summary', 'curated:list', 'curated:get', 'curated:create-post']) {
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }
  const block = preload.slice(preload.indexOf('// 当前账号灵感库'), preload.indexOf('// 对外客户鉴权'));
  const executable = block.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(executable, /authorization|cookie|jwt|token|headers|\burl\b|accountId/i);
  assert.doesNotMatch(renderer, /\bfetch\s*\(|authorization|cookie|jwt|token/i, '内容 renderer 不直接联网或接触认证材料');
});

test('main 固定 customer-auth 路径、方法和参数白名单，并从所选环境注入 envKey', () => {
  for (const channel of ['curated:summary', 'curated:list', 'curated:get', 'curated:create-post']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }
  assert.match(main, /raw\.mode === 'all'[\s\S]*raw\.mode === 'creatable'/);
  assert.match(main, /Number\.isInteger\(limit\)[\s\S]*limit > 50/);
  assert.match(main, /Number\.isInteger\(id\)[\s\S]*id <= 0/);
  assert.match(main, /typeof useReferenceImages !== 'boolean'/);
  assert.match(main, /`\/curated-contents\?mode=\$\{mode\}&limit=\$\{limit\}&offset=\$\{offset\}`/);
  assert.match(main, /'\/curated-contents\?mode=all&limit=1&offset=0'/);
  assert.match(main, /`\/curated-contents\/\$\{id\}\/create-post`[\s\S]*method: 'POST'[\s\S]*body: \{ useReferenceImages \}/);
  assert.match(main, /body: \{ \.\.\.options\.body, envKey: handle\.profileId \}/, 'envKey 只能由 main 从所选环境注入');
  assert.match(main, /token: clientSession\.token/, '客户 token 只在 main 注入');
});

test('标题栏只保留紧凑灵感入口，并锁定低干扰蓝色与高储备蓝绿色', () => {
  const entryIndex = html.indexOf('id="content-library-entry"');
  assert.ok(entryIndex > html.indexOf('id="acct-plat"'));
  assert.ok(entryIndex < html.indexOf('id="health-pill"'));
  assert.equal((html.match(/id="content-library-entry"/g) ?? []).length, 1, '运行首页不得再保留大卡入口');
  for (const color of ['#eef5ff', '#d7e5ff', '#526a87', '#2f6fe4', '#dce8f7', '#4f83e8', '#3f7ce0', '#2aa57a']) {
    assert.match(styles.toLowerCase(), new RegExp(color));
  }
  assert.match(styles, /height:\s*28px/);
  assert.match(styles, /\.cle-track\s*\{[^}]*height:\s*3px/s);
});

test('页面控制器用环境和请求代次丢弃迟到响应，创建在途禁止重复提交', () => {
  assert.match(renderer, /capturedEpoch !== requestEpoch \|\| environment\?\.envId !== capturedEnvId/);
  assert.match(renderer, /if \(createBusy \|\| !environment/);
  assert.match(renderer, /task\.status !== 'queued'/);
  assert.match(renderer, /不代表已经生成或发布/);
});
