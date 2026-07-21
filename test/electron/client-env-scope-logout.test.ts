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
    /allowedProfileIds\.has\(p\.userId\)\s*\|\|\s*Boolean\(pendingOffboardForEnv\(p\.userId\)\)/,
    '按 p.userId 收窄到权威归属；另只保留 Cloud 已受理的本机清理游标',
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

test('ads:getEnvProxy 只按精确 userId 读取完整代理，并受当前客户环境范围约束', () => {
  const block = handlerBlock(main, 'ads:getEnvProxy');
  assert.ok(block, 'ads:getEnvProxy handler 必须存在');
  assert.match(preload, /adsGetEnvProxy: \(opts\) => ipcRenderer\.invoke\('ads:getEnvProxy', opts\)/);
  assert.match(block, /const userId = String\(\(opts && opts\.userId\) \|\| ''\)\.trim\(\)/);
  assert.match(block, /if \(!hasValidSession\(\)\) \{ onSessionInvalid\(\)/, '失效会话不得读取代理密码');
  assert.match(block, /!\(allowedProfileIds instanceof Set\) \|\| !allowedProfileIds\.has\(userId\)/,
    '客户模式必须按权威环境范围拒绝任意 userId');
  assert.match(block, /adsApi\.getProfileProxyConfig\(\{[\s\S]*profileId: userId/,
    '只复用精确 profile 读取，不得回退全量列表或任意本地 API');
  assert.doesNotMatch(block, /listProfiles\(/);
});

test('ads:listProfiles 只收窄显示、physicalUserIds 收窄到 roster∪allowed（绝不泄漏他人 id）；孤儿剔除按物理存在', () => {
  const block = handlerBlock(main, 'ads:listProfiles');
  assert.match(block, /const knownIds = new Set\(allowedProfileIds\)/, 'physicalUserIds 收窄基准含归属集(allowed)');
  assert.match(
    block,
    /for \(const e of settings\.environments \|\| \[\]\) \{ if \(e && e\.profileId\) knownIds\.add\(e\.profileId\); \}/,
    '并含花名册成员 id(roster)——降范围但在册的环境不被误剔(保 MAJOR-2)',
  );
  assert.match(block, /for \(const pending of settings\.pendingInteractionOffboards \|\| \[\]\) knownIds\.add\(pending\.envKey\)/,
    'Cloud 已受理解绑的环境可继续出现在清理列表，但不会恢复普通 scope');
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
  assert.match(main, /timeoutMs = 12000/, 'clientAuthFetch 默认请求必须保持 12 秒有界超时');
  assert.match(main, /signal:\s*AbortSignal\.timeout\(boundedTimeoutMs\)/, 'clientAuthFetch 必须把有界超时接入 signal');
});

test('登录态程序化建号：只允许预授权的新建环境自动归属，旧自声明接口仍被禁止', () => {
  const block = handlerBlock(main, 'ads:createEnv');
  assert.ok(block, 'ads:createEnv handler 必须存在');
  assert.doesNotMatch(main, /attachClientEnvironmentToCurrentUser/, '客户端不得保留自绑定 helper');
  assert.doesNotMatch(main, /clientAuthFetch\('\/environments',\s*\{\s*method:\s*'POST'/,
    '客户端不得向旧 POST /environments 自声明 envKey');
  assert.match(main, /clientAuthFetch\('\/environment-provisioning\/intents'/,
    '先向 Cloud 申请一次性建号意图');
  assert.match(main, /clientAuthFetch\('\/environment-provisioning\/complete'/,
    '建号成功后仅通过完成端点提交实际 envKey');
  assert.ok(
    block.indexOf('createEnvironmentProvisioningIntent()') < block.indexOf('createEnvironmentWithGroupRecovery({'),
    '建号意图必须先于 AdsPower user/create，避免任意现有 envKey 进入自动归属流程',
  );
  assert.match(main, /envKey:\s*String\(result\.userId \|\| ''\)\.trim\(\)/,
    '完成归属的 envKey 只取 AdsPower 新建结果，不信 renderer 输入');
  assert.match(main, /const refreshed = await refreshAllowedEnvironments\(\)/,
    '完成归属后必须重新读取 Cloud 权威环境清单');
  assert.match(main, /allowedProfileIds\.has\(String\(result\.userId \|\| ''\)\.trim\(\)\)/,
    '仅权威清单确认新 envKey 后才允许入册');
  assert.match(main, /addProvisionedEnvironmentToRoster\(result\)/,
    '运行花名册由 Electron main 写入，不由 renderer 自声明');
  assert.match(main, /settings\.environments = existing;[\s\S]*applyLegacyMirror\(\);[\s\S]*return saved;/,
    '花名册落盘失败必须回滚内存，不能一边提示未加入一边实际生成运行 handle');
  assert.doesNotMatch(preload, /proof/, '一次性 proof 不得暴露到 preload');
  assert.doesNotMatch(renderer, /proof/, '一次性 proof 不得暴露到 renderer');
});

test('保存花名册：按权威 allowedProfileIds 过滤，且 renderer 不得伪造 offboard 恢复游标', () => {
  const block = handlerBlock(main, 'settings:save');
  assert.match(block, /safePatch\.environments\s*=\s*requested\.filter\(\(env\) => env && allowedProfileIds\.has/,
    '花名册写入只接受 Cloud 权威 scope');
  assert.match(block, /delete safePatch\.pendingInteractionOffboards/,
    'renderer 不能覆盖主进程收到的 Cloud offboard 游标');
});

test('客户归属默认入册：可信范围信号、排除集合 owner 与 envKey 都由 main 收口', () => {
  const listBlock = handlerBlock(main, 'ads:listProfiles');
  const saveBlock = handlerBlock(main, 'settings:save');
  assert.match(listBlock, /result\.assignmentScoped\s*=\s*true/,
    'assignmentScoped 只在 gated handler 完成会话复核、归属刷新和列表收窄后置 true');
  assert.ok(
    listBlock.indexOf('result.profiles = (result.profiles || [])') < listBlock.indexOf('result.assignmentScoped = true'),
    '可信范围信号必须晚于 profiles 权威收窄',
  );
  assert.match(main, /clientRosterExclusionOwner:\s*''/);
  assert.match(main, /clientRosterExcludedEnvIds:\s*\[\]/);
  assert.match(main, /normalizeClientRosterExcludedEnvIds\(settings\.clientRosterExcludedEnvIds\)/,
    '设置加载/保存必须去空、去重归一排除 envKey');
  assert.match(main, /if \(settings\.clientRosterExclusionOwner !== owner\)[\s\S]*clientRosterExcludedEnvIds:\s*\[\]/,
    '切换客户时清空上一客户排除集合');
  assert.match(saveBlock, /delete safePatch\.clientRosterExclusionOwner/,
    'renderer 不得伪造排除集合 owner');
  assert.match(saveBlock, /requested\.filter\(\(envKey\) => allowedProfileIds\.has\(envKey\)\)/,
    '排除集合只接受当前客户权威归属 envKey');
  assert.match(saveBlock, /clientRosterExclusionOwner\s*=\s*String\(\(clientSession && clientSession\.name\)/,
    '排除集合 owner 由有效主进程会话派生');
});

test('创建成功后刷新 UI：仅已权威分配的环境可自动入册', () => {
  assert.match(
    renderer,
    /if \(r\.userId && !r\.requiresAdminAssignment && !r\.assignmentHandledByMain && !coreRunning\(\)\)/,
    '客户鉴权模式由 main 完成权威入册，renderer 不得重复自选；未启用鉴权保持旧行为',
  );
  assert.match(renderer, /r\.rosterJoinedByMain/, 'UI 必须区分已权威入册和仅本地创建');
  assert.match(renderer, /已分配到当前账号并加入运行环境/, '自动分配成功给出如实提示，不声称已启动');
  assert.match(renderer, /if \(r\.rosterJoinedByMain\) await syncRosterFromMainSettings\(\);/,
    'main 自动入册后先同步 renderer 持有的旧花名册快照');
  assert.match(renderer, /async function syncRosterFromMainSettings\(\)[\s\S]*getSettings\(\)[\s\S]*roster = normalizeRosterList\(latest\.environments\)[\s\S]*refreshRosterMarks\(\)/,
    '添加环境页从主进程已落盘 settings 回读并立即重画“已加入”标记');
  assert.ok(
    renderer.indexOf('if (r.rosterJoinedByMain) await syncRosterFromMainSettings();')
      < renderer.indexOf('await refreshEnvs();', renderer.indexOf('if (r.rosterJoinedByMain) await syncRosterFromMainSettings();')),
    '必须在重新拉取并绘制添加环境列表前同步 roster',
  );
  assert.match(renderer, /await refreshEnvs\(\);/, '创建成功后必须等待添加窗口环境列表刷新完成');
});

test('视频号解绑：Cloud 202→受限无浏览器清理→轮询 tombstone→才物理删除', () => {
  const block = handlerBlock(main, 'ads:deleteEnv');
  assert.match(block, /allowedEnvironmentPlatforms\.get\(userId\)/, '平台来自 Cloud /my-environments 权威响应，不信 renderer');
  assert.match(block, /clientAuthFetch\(`\/environments\/\$\{encodeURIComponent\(userId\)\}`/, '先请求 Cloud 权威解绑');
  assert.match(block, /body:\s*\{ edgeId: fleet\.envIdForProfile\(userId\) \}/, '签发清理凭证时绑定稳定 edgeId');
  assert.match(block, /storePendingInteractionOffboard\(data, platform\)/, '202 回执先持久化 durable offboard 游标');
  assert.match(main, /clientAuthFetch\(`\/offboarding\/\$\{encodeURIComponent\(current\.offboardId\)\}`/,
    '重试通过状态 API 对账');
  assert.match(main, /current\.state === 'tombstoned' \|\| current\.state === 'purged'/,
    '仅 Cloud tombstone/purged 后允许进入物理删除，覆盖未绑定新环境的终态 offboard');
  assert.match(main, /startRestrictedOffboardCleanupCore\(handle\)/, '离线解绑只拉起受限 cleanup core');
  const cleanupStart = main.slice(
    main.indexOf('async function startRestrictedOffboardCleanupCore'),
    main.indexOf('function startEdge(', main.indexOf('async function startRestrictedOffboardCleanupCore')),
  );
  assert.doesNotMatch(cleanupStart, /queueStartEnv|ensureAdsServiceOnce|ensureKernelOnce|admitBrowserSlot|launchQueue|CDP/,
    '清理恢复不得进入浏览器/provider/slot 路径');
  assert.match(renderer, /r && r\.ok && r\.cleanupPending/, 'UI 对 pending 如实显示，不移除花名册冒充已删除');
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
