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
const renderer = readFileSync(join(here, '../../src/electron/renderer/renderer.js'), 'utf8');
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

test('Cloud selection does not inject hidden Facebook or WeChat product authorization', () => {
  assert.doesNotMatch(code, /spawnEnv\.AIDCP_FB_BROWSE_AUTO/);
  assert.doesNotMatch(code, /spawnEnv\.AIDCP_WECHAT_UNVERIFIED_WRITE_TEST_MODE/);
});

test('custom 必须同时提供 HTTP 数据地址与自动化 WebSocket，否则降级为未选择', () => {
  assert.match(
    code,
    /cloudEnvKey === 'custom'[\s\S]*?!isWsUrl\(settings\.cloudUrlCustom\)[\s\S]*?!settings\.clientAuthUrl[\s\S]*?settings\.cloudEnvKey = ''/,
    'normalizeCloudSettings 必须同时校验 custom HTTP 与 WS 地址',
  );
  assert.match(main, /function isWsUrl\(/, '必须有 ws(s):// 地址校验器 isWsUrl');
});

test('settings:get 与 fleetSnapshot 带出目标云端视图，供界面常驻显示', () => {
  assert.match(main, /cloudEnv:\s*cloudSelectionView\(\)/, 'settings:get / fleetSnapshot 必须带 cloudEnv 目标云端视图');
  assert.match(main, /function cloudSelectionView\(/, '必须有 cloudSelectionView 生成目标云端视图');
});

test('首次启动实际 Cloud 未知时不判待重绑，已知目标不一致与显式重绑仍保留', () => {
  const start = renderer.indexOf('const pendingRows = running.filter');
  const end = renderer.indexOf('const failedRows = running.filter', start);
  const predicate = renderer.slice(start, end);
  assert.ok(start >= 0 && end > start, '必须存在顶部 Cloud 待重绑判定');
  assert.match(
    predicate,
    /e\.status\.connectedCloudKey\s*&&\s*e\.status\.connectedCloudKey\s*!==\s*target\.key/,
    '只有实际 Cloud 已知且与目标不一致时才判待重绑，首次启动空值不得误报',
  );
  assert.match(
    predicate,
    /e\.status\.cloudRebind[\s\S]*state === 'pending'/,
    '显式 Cloud 重绑进行中仍必须保留待重绑反馈',
  );
});

test('换云 IPC 只重绑运行中的自动化引擎，停止中的环境下次启动生效', () => {
  const start = main.indexOf("ipcMain.handle('cloud:restartAll'");
  const end = main.indexOf("ipcMain.handle('edge:start'", start);
  const handler = main.slice(start, end);
  assert.ok(start >= 0 && end > start, '必须暴露 cloud:restartAll 兼容通道');
  assert.match(handler, /Promise\.all\(targets\.map/, '所有环境必须独立并行重绑');
  assert.match(handler, /requestCoreCloudRebind\(handle, target\)/, '在线核心必须原地重绑 Cloud 传输');
  assert.match(handler, /activeResults = results\.filter/, '停止中的环境必须从本轮重绑目标中剔除');
  assert.match(handler, /skipped:\s*results\.length - activeResults\.length/, '必须返回停止中跳过数量');
  assert.match(handler, /failed:\s*activeResults\.length - rebound/, '必须返回运行中引擎的部分失败数量');
  assert.match(handler, /results:\s*targets\.map/, '必须逐环境返回成功或失败原因');
  assert.doesNotMatch(handler, /stopAndRestart|queueStartEnv|provider\.|cdp|admitBrowserSlot|occupiedSlots/, '换云不得触碰浏览器执行器或槽位');
});

test('structured cloud target exposes separate customer HTTP and automation WebSocket endpoints', () => {
  assert.match(main, /CLIENT_AUTH_ENV_URLS\s*=\s*\{[\s\S]*\/capi[\s\S]*\}/);
  assert.match(main, /function cloudTargetView\(\)[\s\S]*automationUrl:[\s\S]*dataApiUrl:/);
  assert.match(main, /cloudTarget:\s*cloudTargetView\(\)/);
});

test('单核心 Cloud 重绑消息只携带控制传输目标，明确不改浏览器状态', () => {
  const start = main.indexOf('function requestCoreCloudRebind');
  const end = main.indexOf('function clearColdStandbyTimer', start);
  const rebind = main.slice(start, end);
  assert.ok(start >= 0 && end > start, '必须存在 per-core rebind helper');
  assert.match(rebind, /type:\s*'lifecycle\.cloud_rebind'/);
  assert.match(rebind, /浏览器状态未改变/);
  assert.doesNotMatch(rebind, /stopAndRestart|queueStartEnv|provider\.|cdp|admitBrowserSlot|occupiedSlots/);
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
