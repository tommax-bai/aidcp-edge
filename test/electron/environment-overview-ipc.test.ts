import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const electronDir = join(import.meta.dirname, '../../src/electron');
const main = readFileSync(join(electronDir, 'main.cjs'), 'utf8');
const preload = readFileSync(join(electronDir, 'preload.cjs'), 'utf8');
const renderer = readFileSync(join(electronDir, 'renderer/renderer.js'), 'utf8');

test('环境概览 preload 只暴露 envId 具名读，不暴露 URL/token/accountId', () => {
  assert.match(
    preload,
    /getEnvironmentOverview:\s*\(envId\)\s*=>\s*ipcRenderer\.invoke\('environment-overview:get', envId\)/,
  );
  const line = preload.split('\n').find((item) => item.includes('getEnvironmentOverview:')) || '';
  assert.doesNotMatch(line, /url|token|accountId|headers|method/i);
});

test('环境概览 main 固定 customer-auth 路径，且没有 core/browser/WS 前置闸', () => {
  const start = main.indexOf("ipcMain.handle('environment-overview:get'");
  const end = main.indexOf('// 当前账号灵感库', start);
  assert.ok(start >= 0 && end > start, 'environment-overview handler slice must exist');
  const block = main.slice(start, end);
  assert.match(block, /resolveHandle\(envId\)/);
  assert.match(block, /\/environments\/\$\{encodeURIComponent\(handle\.profileId\)\}\/overview/);
  assert.match(block, /delegatedTaskRequest/);
  assert.doesNotMatch(block, /spawn|child|coreState|browserState|cloudState|engineLink|WebSocket|pushToEdges/);
});

test('renderer 只经具名 IPC 拉概览，不自行拼 customer-auth 路径', () => {
  assert.match(renderer, /window\.aidcpEdge\.getEnvironmentOverview\(envId\)/);
  assert.doesNotMatch(renderer, /\/environments\/[^'"`]*\/overview/);
  assert.doesNotMatch(renderer, /clientAuthFetch|authorization|Bearer/);
});

test('环境排期 preload 只暴露 envId 具名读，不暴露 URL/token/accountId', () => {
  assert.match(
    preload,
    /getEnvironmentSchedule:\s*\(envId\)\s*=>\s*ipcRenderer\.invoke\('environment-schedule:get', envId\)/,
  );
  const line = preload.split('\n').find((item) => item.includes('getEnvironmentSchedule:')) || '';
  assert.doesNotMatch(line, /url|token|accountId|headers|method/i);
});

test('环境排期 main 固定 env-scoped customer-auth 路径且无运行组件前置闸', () => {
  const start = main.indexOf("ipcMain.handle('environment-schedule:get'");
  const end = main.indexOf('// 小红书发布队列', start);
  assert.ok(start >= 0 && end > start, 'environment-schedule handler slice must exist');
  const block = main.slice(start, end);
  assert.match(block, /resolveHandle\(envId\)/);
  assert.match(block, /\/environments\/\$\{encodeURIComponent\(handle\.profileId\)\}\/schedule/);
  assert.match(block, /delegatedTaskRequest/);
  assert.doesNotMatch(block, /spawn|child|coreState|browserState|cloudState|engineLink|WebSocket|pushToEdges/);
  assert.doesNotMatch(block, /accountId|token|authorization|headers/);
});
