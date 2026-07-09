import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const uiState = require('../../src/electron/ui-state.cjs') as {
  envKeyFromSettings: (settings: unknown) => string;
  adoptStoredLastPublish: (parsed: unknown, currentEnvKey: string) => { title: string; at: string | null } | null;
  serializeUiState: (envKey: string | null, lastPublish: unknown) => { envKey: string | null; lastPublish: unknown };
};

const { envKeyFromSettings, adoptStoredLastPublish, serializeUiState } = uiState;

test('环境键推导：self 固定键，adspower 按分身 id 分键', () => {
  assert.equal(envKeyFromSettings({ provider: 'self', adsProfileId: 'ignored' }), 'self');
  assert.equal(envKeyFromSettings({ provider: 'adspower', adsProfileId: ' u123 ' }), 'ads:u123');
});

test('同键采纳：归属键一致的历史态原样返回，at 缺失回落 null', () => {
  const parsed = { envKey: 'ads:u1', lastPublish: { title: '秋日漫步', at: '2026-07-08T10:00:00.000Z' } };
  assert.deepEqual(adoptStoredLastPublish(parsed, 'ads:u1'), { title: '秋日漫步', at: '2026-07-08T10:00:00.000Z' });
  assert.deepEqual(adoptStoredLastPublish({ envKey: 'self', lastPublish: { title: 't' } }, 'self'), { title: 't', at: null });
});

test('异键与缺键（旧版文件）一律不采纳，宁缺毋假', () => {
  const lastPublish = { title: '旧账号的笔记', at: '2026-07-01T00:00:00.000Z' };
  assert.equal(adoptStoredLastPublish({ envKey: 'ads:old', lastPublish }, 'ads:new'), null);
  assert.equal(adoptStoredLastPublish({ lastPublish }, 'ads:new'), null); // 升级路径：无归属键
  assert.equal(adoptStoredLastPublish(null, 'ads:new'), null);
  assert.equal(adoptStoredLastPublish({ envKey: 'ads:new', lastPublish: { title: '' } }, 'ads:new'), null);
});

test('序列化带键往返：落盘再加载按键判定采纳/丢弃', () => {
  const saved = serializeUiState('ads:u1', { title: 't', at: null });
  assert.deepEqual(adoptStoredLastPublish(saved, 'ads:u1'), { title: 't', at: null });
  assert.equal(adoptStoredLastPublish(saved, 'ads:u2'), null);
});
