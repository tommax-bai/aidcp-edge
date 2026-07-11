import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// change edge-cloud-env-selector 的契约守卫：
// main.cjs 是带顶层副作用的 Electron 主进程脚本、无法直接 require，故沿用源码契约断言方式，
// 锁住云端环境选择的关键不变量：地址映射、按选择解析、**在 env 合并之后**覆盖、留空零注入、custom 非法降级。
const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, '../../src/electron/main.cjs'), 'utf8');
// 顺序不变量按**代码**位置比较：剥掉整行注释，避免注释里合法引用这些符号名污染位置。
const code = main.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('两个正式云端地址收敛在一处映射（dev + ol）', () => {
  assert.match(
    main,
    /CLOUD_ENV_URLS\s*=\s*\{[\s\S]*ws:\/\/121\.89\.85\.150:8787[\s\S]*ws:\/\/123\.56\.253\.183:8787[\s\S]*\}/,
    'CLOUD_ENV_URLS 必须同时含 dev 与 ol 两个地址',
  );
  assert.match(main, /function resolveCloudUrl\(/, '必须有云端地址解析器 resolveCloudUrl');
});

test('DEFAULT_SETTINGS 含 cloudEnvKey / cloudUrlCustom，默认空（零回归）', () => {
  assert.match(main, /cloudEnvKey:\s*''/, 'cloudEnvKey 默认必须为空串（未选择=跟随环境变量/缺省）');
  assert.match(main, /cloudUrlCustom:\s*''/, 'cloudUrlCustom 默认必须为空串');
});

test('派生核心时按选择覆盖 AIDCP_CLOUD_URL，且受 fromSelection 守卫（留空零注入）', () => {
  assert.match(
    code,
    /if\s*\(\s*cloudSel\.fromSelection\s*\)\s*spawnEnv\.AIDCP_CLOUD_URL\s*=\s*cloudSel\.url/,
    '必须仅在 fromSelection（界面已选）时才注入 AIDCP_CLOUD_URL；未选则不注入',
  );
});

test('顺序不变量：覆盖发生在 spawnEnv 合并之后（否则被继承的 processEnv 压过）', () => {
  // 最后一个 `spawnEnv = {` 是 self 分支的合并（含 ...process.env）；覆盖必须在其之后。
  const lastMergeIdx = code.lastIndexOf('spawnEnv = {');
  const injectIdx = code.search(/spawnEnv\.AIDCP_CLOUD_URL\s*=/);
  const spawnCallIdx = code.indexOf('spawn(process.execPath');
  assert.ok(lastMergeIdx >= 0, '未找到 spawnEnv 合并构造');
  assert.ok(injectIdx >= 0, '未找到 AIDCP_CLOUD_URL 覆盖注入');
  assert.ok(spawnCallIdx >= 0, '未找到核心 spawn 调用');
  assert.ok(
    injectIdx > lastMergeIdx,
    '覆盖必须在两路 spawnEnv 合并之后（红线：否则界面选择被继承的 AIDCP_CLOUD_URL 吃掉）',
  );
  assert.ok(injectIdx < spawnCallIdx, '覆盖必须在 spawn 调用之前生效');
});

test('custom 非法地址被降级为未选择、绝不注入垃圾（诚实回落）', () => {
  assert.match(
    code,
    /cloudEnvKey === 'custom'\s*&&\s*!isWsUrl\(settings\.cloudUrlCustom\)\)\s*settings\.cloudEnvKey = ''/,
    'normalizeCloudSettings 必须把非法 custom 降级为空、不注入坏地址',
  );
  assert.match(main, /function isWsUrl\(/, '必须有 ws(s):// 地址校验器 isWsUrl');
});

test('settings:get 与 fleetSnapshot 带出目标云端视图，供界面常驻显示', () => {
  assert.match(main, /cloudEnv:\s*cloudSelectionView\(\)/, 'settings:get / fleetSnapshot 必须带 cloudEnv 目标云端视图');
  assert.match(main, /function cloudSelectionView\(/, '必须有 cloudSelectionView 生成目标云端视图');
});

test('提供「全部重启换云」IPC（避免部分环境连旧云的裂脑）', () => {
  assert.match(main, /ipcMain\.handle\(\s*['"]cloud:restartAll['"]/, '必须暴露 cloud:restartAll 全部重启换云');
});
