import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// change edge-client-env-scope-and-logout 的契约守卫。main.cjs 带顶层副作用不可直接 require，
// 沿用源码契约断言（读文本、regex 锁不变量，见 cloud-env-selector.test.ts）。锁：
//  (1) 「加入现有环境」列表出口 ads:listProfiles gated 时**只收窄显示**、且 fail-closed（绝不回落全量泄漏他人）；
//  (2) 孤儿剔除按本机物理存在判定（另带 physicalUserIds），降范围≠物理删除；
//  (3) 设置抽屉的客户端登出入口据 clientSession() 门控、复用既有 clientLogout。
const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string) => readFileSync(join(here, '../../src/electron', rel), 'utf8');
const main = readSrc('main.cjs');
const html = readSrc('renderer/index.html');
const renderer = readSrc('renderer/renderer.js');
const preload = readSrc('preload.cjs');

// 抽出某 IPC handler 的代码块（从其 `ipcMain.handle('name'` 到下一个 `ipcMain.handle(`），
// 令断言锁在该 handler 内、不被别处同名符号污染。
function handlerBlock(src: string, name: string): string {
  const start = src.indexOf(`ipcMain.handle('${name}'`);
  if (start < 0) return '';
  const next = src.indexOf('ipcMain.handle(', start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

test('ads:listProfiles gated 时收窄显示列表（按 userId），未 gated / 错误结果原样透传（零回归）', () => {
  const block = handlerBlock(main, 'ads:listProfiles');
  assert.ok(block, 'ads:listProfiles handler 必须存在');
  // 收窄块以 result.ok && clientAuthEnabled() 为门；clientAuthEnabled 为假（未启用鉴权）→ 跳过 → 全量=零回归。
  assert.match(block, /if\s*\(result\s*&&\s*result\.ok\s*&&\s*clientAuthEnabled\(\)\)/, '仅成功列表 + gated 才收窄');
  assert.match(
    block,
    /result\.profiles\s*=\s*\(result\.profiles\s*\|\|\s*\[\]\)\.filter\(\(p\) => p && allowedProfileIds\.has\(p\.userId\)\)/,
    '按 p.userId（分身 ID = 归属键）收窄显示；误用 profileId 会全落空（R1）',
  );
  assert.match(block, /return result;\s*\}\);/, 'handler 末尾原样返回 result（未 gated / 错误结果透传）');
});

test('ads:listProfiles 绝不 fail-open：gated 且无有效会话 / 刷新失效 → 登出而非回落全量', () => {
  const block = handlerBlock(main, 'ads:listProfiles');
  // 令牌到期但未清理时 hasValidSession() 为假而 allowedProfileIds 可能仍是旧 Set：这里对「无有效会话」一律登出，
  // 不复用旧集、更不回落全量（Finding 1/3：不 gate 在 hasValidSession 上跳过整块）。
  assert.match(
    block,
    /if\s*\(\s*!hasValidSession\(\)\s*\)\s*\{\s*onSessionInvalid\(\)\s*;\s*return\s*\{\s*ok:\s*false/,
    'gated 且无有效会话 → 立即登出，绝不返回全量',
  );
  assert.match(block, /refreshAllowedEnvironments\(\)/, '会话有效时先刷新可见集（点「刷新」应拉最新）');
  // 刷新 401（ok=false），或刷新中会话翻失效（allowedProfileIds 被置 null，非 Set）→ 登出，绝不回全量。
  assert.match(
    block,
    /if\s*\(\s*!ok\s*\|\|\s*!\(allowedProfileIds instanceof Set\)\s*\)\s*\{\s*onSessionInvalid\(\)/,
    '刷新失败或会话翻失效 → 登出（fail-closed，绝不回全量）',
  );
});

test('ads:listProfiles 只收窄显示、physicalUserIds 收窄到 roster∪allowed（绝不泄漏他人 id）；孤儿剔除按物理存在', () => {
  const block = handlerBlock(main, 'ads:listProfiles');
  assert.match(block, /const knownIds = new Set\(allowedProfileIds\)/, 'physicalUserIds 收窄基准含归属集(allowed)');
  assert.match(
    block,
    /for \(const e of settings\.environments \|\| \[\]\) \{ if \(e && e\.profileId\) knownIds\.add\(e\.profileId\); \}/,
    '并含花名册成员 id(roster)——降范围但在册的环境不被误剔(保 MAJOR-2)',
  );
  assert.match(
    block,
    /result\.physicalUserIds\s*=\s*\(result\.profiles\s*\|\|\s*\[\]\)\.map\(\(p\) => p && p\.userId\)\.filter\(\(id\) => id && knownIds\.has\(id\)\)/,
    'physicalUserIds 只含 roster∪allowed 内物理存在的 id，绝不把他人环境 id 透过 IPC 回渲染层',
  );
  assert.match(
    renderer,
    /Array\.isArray\(r\.physicalUserIds\)\s*\?\s*r\.physicalUserIds\s*:/,
    '渲染层优先用 physicalUserIds；缺省回落 profiles ids（未 gated 零回归）',
  );
  assert.match(renderer, /pruneOrphanRoster\(physicalIds\)/, '孤儿剔除按物理 id，不按云端可见集收窄的显示列表');
  assert.match(renderer, /function pruneOrphanRoster\(liveIds\)/, 'pruneOrphanRoster 收物理 id 数组（非 profiles）');
});

test('clientAuthFetch 有界超时（refresh 随每次刷新调用，绝不无限吊住按钮）', () => {
  const block = handlerBlock(main, 'ads:listProfiles'); // 触发方
  assert.ok(block, 'handler 存在');
  assert.match(main, /signal:\s*AbortSignal\.timeout\(\d+\)/, 'clientAuthFetch 必须带超时 signal');
});

test('登录态程序化建号：ads:createEnv 成功后等待归属当前客户，再让刷新可见', () => {
  const block = handlerBlock(main, 'ads:createEnv');
  assert.ok(block, 'ads:createEnv handler 必须存在');
  assert.match(main, /async function attachClientEnvironmentToCurrentUser/, '主进程必须有可等待的客户归属写入函数');
  assert.match(
    main,
    /clientAuthFetch\('\/environments',\s*\{\s*method:\s*'POST',\s*token:\s*clientSession\.token/,
    '客户归属写入必须走受客户令牌保护的 /environments',
  );
  assert.match(
    block,
    /const attach = await attachClientEnvironmentToCurrentUser\(\{\s*userId: result\.userId,\s*name: result\.name,\s*platform: result\.platform \|\| platform,\s*\}\);/,
    '单环境创建成功后必须 await 归属，避免随后刷新按旧 scope 过滤掉新环境',
  );
  assert.match(
    block,
    /visibilityWarning/,
    '归属失败时必须回传可见性告警，不能把“创建成功但不可见”伪装成完全成功',
  );
});

test('保存花名册新增环境：客户归属不再 fire-and-forget', () => {
  const block = handlerBlock(main, 'settings:save');
  assert.match(block, /ipcMain\.handle\('settings:save',\s*async/, 'settings:save 需要 async 等待归属写入');
  assert.match(block, /const attach = await attachClientEnvironmentToCurrentUser/, '新增环境入册时必须等待客户归属写入');
  assert.doesNotMatch(block, /void clientAuthFetch\('\/environments'/, '不得再后台 best-effort 写归属后立即返回');
});

test('创建成功后刷新 UI：先等左栏入册，再等添加窗口列表刷新', () => {
  assert.match(
    renderer,
    /if \(r\.userId && !coreRunning\(\)\) await selectProfile\(r\.userId, null, r\.name \|\| '', r\.platform \|\| platform\);/,
    '创建成功后自动选中必须等待 persistRoster 完成，左栏才稳定出现',
  );
  assert.match(renderer, /await refreshEnvs\(\);/, '创建成功后必须等待添加窗口环境列表刷新完成');
});

test('设置抽屉移除 per-环境「重新登录」按钮；auth:relogin IPC 保留（通知巡视引导流「重检」仍用）', () => {
  assert.doesNotMatch(html, /id="relogin"/, '设置抽屉不再有 per-环境「重新登录」按钮（换成客户端「退出登录」）');
  assert.match(main, /ipcMain\.handle\(\s*['"]auth:relogin['"]/, 'auth:relogin IPC 保留——引导流「重检」仍走这条路径、非本按钮');
  assert.match(renderer, /window\.aidcpEdge\.relogin\(/, '引导流「重检」的 relogin 调用保留');
});

test('设置抽屉「退出登录」入口：默认隐藏、据 clientSession() 门控、复用 clientLogout', () => {
  assert.match(html, /id="client-logout"[^>]*>退出登录</, '设置抽屉页脚按钮为「退出登录」（取代原「重新登录」）');
  assert.match(html, /id="client-session-foot"[^>]*class="[^"]*hidden/, '登出入口默认隐藏（据 clientSession 门控显隐）');
  assert.match(renderer, /clientSession\(\)/, 'renderer 初始化查 clientSession() 决定是否显示');
  assert.match(renderer, /sess\.enabled/, '仅 enabled（客户鉴权启用）才 unhide 登出入口=零回归');
  assert.match(renderer, /window\.aidcpEdge\.clientLogout\(\)/, '点击复用既有 clientLogout（清会话→拆环境→回登录门）');
  assert.match(renderer, /确认退出\?/, '登出走二次确认（停掉全部在跑环境前防误触）');
});

test('preload 暴露 clientLogout → client-auth:logout（登出链路契约）', () => {
  assert.match(
    preload,
    /clientLogout:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]client-auth:logout['"]/,
    'preload.clientLogout 映射到 client-auth:logout',
  );
});
