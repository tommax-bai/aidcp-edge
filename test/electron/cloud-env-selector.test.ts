import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, '../..', path), 'utf8');
const main = read('src/electron/main.cjs');
const preload = read('src/electron/preload.cjs');
const renderer = read('src/electron/renderer/renderer.js');
const login = read('src/electron/renderer/login.html');
const index = read('src/electron/renderer/index.html');

function blockBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, `missing block ${startNeedle} -> ${endNeedle}`);
  return source.slice(start, end);
}

function handlerBlock(source: string, name: string): string {
  const start = source.indexOf(`ipcMain.handle('${name}'`);
  const end = source.indexOf('ipcMain.handle(', start + 1);
  assert.ok(start >= 0 && end > start, `missing IPC handler ${name}`);
  return source.slice(start, end);
}

test('settings persist one deploymentTarget and migrate only official legacy selectors/default metadata', () => {
  assert.match(main, /deploymentTarget:\s*''/);
  assert.match(main, /migrateDeploymentTarget\(\{[\s\S]*deploymentTarget:\s*parsed\.deploymentTarget,[\s\S]*legacyCloudEnvKey:\s*parsed\.cloudEnvKey,[\s\S]*bakedDefault:\s*BAKED_DEFAULT_CLOUD_ENV/);
  assert.match(main, /aidcpCloudDefaultEnv/);
  assert.match(main, /delete settings\.cloudEnvKey;[\s\S]*delete settings\.cloudUrlCustom;[\s\S]*delete settings\.clientAuthUrl/);
});

test('core spawn overwrites inherited AIDCP_CLOUD_URL after env merging with the catalog target', () => {
  const spawn = blockBetween(main, 'function spawnEdgeChild(', 'function stopLoginPoller(');
  const mergeIndex = spawn.lastIndexOf('spawnEnv = {');
  const injectIndex = spawn.indexOf('spawnEnv.AIDCP_CLOUD_URL = cloudSel.url');
  const spawnCallIndex = spawn.indexOf('spawn(process.execPath');
  assert.ok(mergeIndex >= 0 && injectIndex > mergeIndex && spawnCallIndex > injectIndex);
  assert.match(spawn, /handle\.spawnCloudKey = cloudSel\.key/);
  assert.match(spawn, /targetCloudKey:\s*handle\.spawnCloudKey/);
  assert.doesNotMatch(spawn, /\bresolvedCloudKey\b/);
  assert.match(spawn, /handle\.spawnAuthenticatedTarget = hasValidSession\(\) \? clientSession\.deploymentTarget : ''/);
  assert.doesNotMatch(spawn, /if \(cloudSel\.fromSelection\)/);
  assert.doesNotMatch(spawn, /process\.env\.AIDCP_CLOUD_URL/);
});

test('authenticated UI cannot hot-rebind or submit independent HTTP/WS endpoints', () => {
  assert.doesNotMatch(main, /ipcMain\.handle\('cloud:restartAll'/);
  assert.doesNotMatch(preload, /cloudRestartAll|cloud:restartAll/);
  assert.doesNotMatch(index, /cloud-env-dev|cloud-env-ol|cloud-env-custom|cloud-custom-url|cloud-rebind/);
  assert.doesNotMatch(login, /type="url"|clientAuthUrl|cloudUrlCustom|AIDCP_CLOUD_URL/);
  assert.match(index, /id="cloud-switch-target"/);
  assert.match(renderer, /clientSwitchTarget/);
});

test('login selector submits a narrow target enum with target-aware copy and OL confirmation', () => {
  assert.match(login, /name="deploymentTarget" value="dev"/);
  assert.match(login, /name="deploymentTarget" value="ol"/);
  assert.match(login, /DEV<\/strong><small>测试环境/);
  assert.match(login, /OL<\/strong><small>正式环境/);
  assert.match(login, /登录 ' \+ \(selectedTarget === 'dev' \? 'DEV' : 'OL'\)/);
  assert.match(login, /clientLogin\(\{ deploymentTarget: selectedTarget, name: n, key: k \}\)/);
  assert.match(login, /将登录 OL 正式环境/);
  assert.doesNotMatch(login, /token|automationWebSocketUrl|customerAuthBaseUrl/);
});

test('main validates the exact login payload and persists target before sending credentials', () => {
  const parser = blockBetween(main, 'function parseClientLoginPayload(', 'const CONTROL_BOOTSTRAP_REASON_ZH');
  assert.match(parser, /new Set\(\['deploymentTarget', 'name', 'key'\]\)/);
  assert.match(parser, /Object\.keys\(value\)\.some/);
  const handler = handlerBlock(main, 'client-auth:login');
  const persistIndex = handler.indexOf('persistDeploymentTargetForLogin');
  const loginIndex = handler.indexOf('establishClientSession');
  assert.ok(persistIndex >= 0 && loginIndex > persistIndex);
  assert.match(handler, /invalid_login_payload/);
});

test('generic settings IPC cannot mutate deployment target or legacy transport fields', () => {
  const handler = handlerBlock(main, 'settings:save');
  assert.match(handler, /delete safePatch\.deploymentTarget/);
  assert.match(handler, /delete safePatch\.cloudEnvKey/);
  assert.match(handler, /delete safePatch\.cloudUrlCustom/);
  assert.match(handler, /delete safePatch\.clientAuthUrl/);
});

test('target switch signs out and clears customer authority while retaining physical roster settings', () => {
  const transition = blockBetween(main, 'function switchAuthenticatedTargetToLogin()', 'let legacyManualAliasSyncPromise');
  assert.match(transition, /clientAuthFetch\('\/logout'/);
  assert.match(transition, /onSessionInvalid\(\{ forgetCredentials: true \}\)/);
  assert.match(transition, /clientRosterExclusionOwner:\s*''/);
  assert.match(transition, /clientRosterExcludedEnvIds:\s*\[\]/);
  assert.doesNotMatch(transition, /environments:\s*\[\]|adsProfileId:\s*''|deletePhysical/);
});

test('connection receipt uses the authenticated target frozen at spawn, not mutable token expiry', () => {
  const logProjection = blockBetween(main, 'function handleEdgeLogLine(', 'function pauseEdge(');
  assert.match(logProjection, /handle\.spawnCloudKey !== settings\.deploymentTarget/);
  assert.match(logProjection, /handle\.spawnAuthenticatedTarget !== settings\.deploymentTarget/);
  assert.match(logProjection, /clientSession\.deploymentTarget !== handle\.spawnAuthenticatedTarget/);
  assert.doesNotMatch(logProjection, /const authenticatedTarget = hasValidSession\(\)/,
    '延迟连接回执不得因令牌刷新窗口短暂变成无效而误杀同目标核心');
  assert.match(logProjection, /部署环境与自动化连接目标不一致，已安全停止自动化/);
  assert.match(logProjection, /next\.connectedCloudKey = handle\.spawnCloudKey/);
});

test('settings and session views distinguish selected/authenticated and actual automation targets', () => {
  assert.match(main, /cloudTarget:\s*cloudTargetView\(\)/);
  assert.match(handlerBlock(main, 'client-auth:session'), /authenticatedTarget:\s*hasValidSession\(\) \? clientSession\.deploymentTarget : null/);
  assert.match(renderer, /自动化实际连接/);
  assert.match(renderer, /自动化未启动/);
});

test('pending Cloud mutations are target-scoped and never replayed or replaced across targets', () => {
  assert.match(main, /deploymentTarget = isDeploymentTarget\(raw && raw\.deploymentTarget\)[\s\S]*:\s*'unknown'/);
  const legacy = blockBetween(main, 'function legacyPendingTarget(', 'function resolveCloudUrl(');
  assert.match(legacy, /targetForKnownCustomerAuthUrl\(parsed && parsed\.clientAuthUrl\)/);
  assert.match(legacy, /targetForKnownCustomerAuthUrl\(pkg && pkg\.aidcpClientAuthUrl\)/);
  assert.match(legacy, /isDeploymentTarget\(parsed && parsed\.cloudEnvKey\) \? parsed\.cloudEnvKey : null/);
  assert.match(main, /item\.envKey === envKey && item\.deploymentTarget === settings\.deploymentTarget/);
  assert.match(main, /解绑恢复游标不属于当前部署环境，已拒绝跨环境重放/);
  assert.match(main, /\.filter\(\(item\) => item\.deploymentTarget === settings\.deploymentTarget\)/);
  const store = blockBetween(main, 'function storePendingInteractionOffboard(', 'function updatePendingInteractionOffboard(');
  assert.match(store, /item\.deploymentTarget !== normalized\.deploymentTarget/);
  assert.match(renderer, /旧版清理记录无法确认属于 DEV 还是 OL，已停止自动重放/);
});
