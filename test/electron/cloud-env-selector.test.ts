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
const buildScript = readFileSync(join(here, '../../scripts/build-desktop-macos.sh'), 'utf8');
const buildWorkflow = readFileSync(join(here, '../../.github/workflows/build-desktop.yml'), 'utf8');
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

test('Facebook 浏览模式由最终云端 key 统一注入，且只发生在启动子进程前', () => {
  const cloudResolveIdx = code.indexOf('const cloudSel = resolveCloudUrl();');
  const browseInjectIdx = code.indexOf('spawnEnv.AIDCP_FB_BROWSE_AUTO = fleet.facebookBrowseModeFor');
  const spawnCallIdx = code.indexOf('spawn(process.execPath');
  assert.ok(cloudResolveIdx >= 0, '必须先解析实际云端');
  assert.ok(browseInjectIdx > cloudResolveIdx, '浏览模式必须使用解析后的云端 key');
  assert.ok(browseInjectIdx < spawnCallIdx, '浏览模式必须在子进程启动前注入');
  assert.match(
    code,
    /const resolvedCloudKey = cloudSel\.fromSelection[\s\S]*?spawnEnv\.AIDCP_FB_BROWSE_AUTO = fleet\.facebookBrowseModeFor\([\s\S]*?cloudEnvKey: resolvedCloudKey/,
    'Facebook 模式必须取同一条实际连接的 resolvedCloudKey',
  );
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

// 构建期烘焙缺省云端环境（mac 签名分发包默认 ol）：分发包用 electron-builder
// extraMetadata.aidcpCloudDefaultEnv 注入 dev|ol；普通包不带字段 → 沿用历史缺省 dev（零回归）。
test('烘焙缺省云端环境：读打包 package.json 的 aidcpCloudDefaultEnv，缺省址回落 dev', () => {
  assert.match(main, /aidcpCloudDefaultEnv/, '必须读取打包 package.json 的 aidcpCloudDefaultEnv 字段');
  assert.match(main, /BAKED_DEFAULT_CLOUD_ENV/, '必须有烘焙缺省环境常量');
  assert.match(
    code,
    /DEFAULT_CLOUD_URL\s*=\s*CLOUD_ENV_URLS\[BAKED_DEFAULT_CLOUD_ENV\]\s*\|\|\s*CLOUD_ENV_URLS\.dev/,
    'DEFAULT_CLOUD_URL 必须按烘焙缺省取址、否则回落 dev',
  );
});

test('烘焙缺省 dev/ol 必须像界面选择一样 fromSelection:true 显式下发核心（防显示≠实连）', () => {
  // 否则核心（main.ts）自身回落 dev，界面显示 ol 但实连 dev——违反「显示须等于实际连接」红线。
  assert.match(
    code,
    /BAKED_DEFAULT_CLOUD_ENV === 'dev' \|\| BAKED_DEFAULT_CLOUD_ENV === 'ol'[\s\S]*?fromSelection:\s*true/,
    '烘焙缺省 dev/ol 必须以 fromSelection:true 返回，保证显式注入 AIDCP_CLOUD_URL',
  );
});

test('签名 mac 分发构建必须能烘焙客户登录门 URL，且 ol 默认指向 OL /capi', () => {
  assert.match(buildScript, /AIDCP_CLIENT_AUTH_URL/, 'mac 签名脚本必须读取 AIDCP_CLIENT_AUTH_URL');
  assert.match(
    buildScript,
    /extraMetadata\.aidcpClientAuthUrl/,
    'mac 签名脚本必须把客户登录门地址写入 packaged package.json',
  );
  assert.match(buildWorkflow, /client_auth_url:/, 'CI workflow 必须暴露 client_auth_url 输入');
  assert.match(
    buildWorkflow,
    /https:\/\/aidcp\.tommax\.cc\/capi/,
    'ol 构建未显式传 client_auth_url 时，必须默认烘焙 OL 客户鉴权地址',
  );
});
