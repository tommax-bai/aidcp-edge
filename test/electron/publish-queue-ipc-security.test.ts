import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const electronDir = join(import.meta.dirname, '../../src/electron');
const main = readFileSync(join(electronDir, 'main.cjs'), 'utf8');
const preload = readFileSync(join(electronDir, 'preload.cjs'), 'utf8');
const workspace = readFileSync(join(electronDir, 'renderer/content-workspace.js'), 'utf8');
const renderer = readFileSync(join(electronDir, 'renderer/renderer.js'), 'utf8');
const html = readFileSync(join(electronDir, 'renderer/index.html'), 'utf8');
const styles = readFileSync(join(electronDir, 'renderer/styles.css'), 'utf8');

test('发布队列 preload 只暴露本地 envId、任务 id 与版本，不接触 URL/token/accountId', () => {
  assert.match(preload, /publishQueueGet:\s*\(envId\)\s*=>\s*ipcRenderer\.invoke\('publish-queue:get', envId\)/);
  assert.match(
    preload,
    /publishQueueCancel:\s*\(envId, taskId, version\)\s*=>\s*\n?\s*ipcRenderer\.invoke\('publish-queue:cancel', envId, taskId, version\)/,
  );
  const block = preload.slice(preload.indexOf('// 小红书发布队列'), preload.indexOf('// 稿件预览内删除某张配图'));
  assert.ok(block.length > 0);
  const executable = block.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(executable, /authorization|headers|cookie|jwt|token|accountId|\burl\b|envKey/i);
});

test('发布队列 main 固定精确环境路径，取消仅提交 version 且无 core/browser 前置闸', () => {
  const start = main.indexOf("ipcMain.handle('publish-queue:get'");
  const end = main.indexOf('// 当前账号灵感库', start);
  assert.ok(start >= 0 && end > start, 'publish queue handlers must exist');
  const block = main.slice(start, end);
  assert.match(block, /resolveHandle\(envId\)/);
  assert.match(block, /`\/environments\/\$\{encodeURIComponent\(handle\.profileId\)\}\/publish-queue`/);
  assert.match(
    block,
    /`\/environments\/\$\{encodeURIComponent\(handle\.profileId\)\}\/publish-queue\/tasks\/\$\{encodeURIComponent\(normalizedTaskId\)\}\/cancel`/,
  );
  assert.match(block, /!Number\.isInteger\(version\) \|\| version < 0/);
  assert.match(block, /method: 'POST', body: \{ version \}, includeEnvBody: false/);
  assert.doesNotMatch(block, /accountId|token|authorization|spawn|\.child\b|browser|WebSocket|pushToEdges/);
});

test('发布队列 renderer 只经具名 IPC，按 XHS 门禁并丢弃旧环境响应', () => {
  assert.match(workspace, /api\.publishQueueGet\(capturedEnvId\)/);
  assert.match(workspace, /api\.publishQueueCancel\(context\.envId, context\.taskId, context\.version\)/);
  assert.match(workspace, /environment\?\.platform === 'xiaohongshu'/);
  assert.match(workspace, /capturedEpoch !== queueEpoch \|\| environment\?\.envId !== capturedEnvId/);
  assert.doesNotMatch(workspace, /\/environments\/|clientAuthFetch|authorization|Bearer/);
  assert.match(renderer, /contentWorkspace\.publishQueueSnapshot\(\)/);
  assert.match(renderer, /fields\.pubBarLabel\.textContent = '发布进度'/);
});

test('发布队列页面包含可访问取消确认、四阶段与窄屏无横向布局', () => {
  assert.match(html, /id="publish-queue-view"/);
  assert.match(html, /id="publish-queue-cancel-confirm"[\s\S]*aria-labelledby="publish-queue-cancel-title"/);
  for (const label of ['开始创作', '正文与配图', '你来确认', '发布结果']) {
    assert.match(renderer, new RegExp(label));
  }
  assert.match(styles, /\.publish-queue-content\s*\{[^}]*width:\s*min\(880px, 100%\)/s);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*\.publish-queue-stages\s*\{\s*grid-template-columns:\s*1fr/s);
  assert.match(styles, /\.publish-queue-card\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden/s);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.publish-queue-cancel-confirm\[open\]/s);
});
