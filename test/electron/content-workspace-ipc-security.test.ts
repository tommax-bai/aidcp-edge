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
const appRenderer = readFileSync(join(electronDir, 'renderer/renderer.js'), 'utf8');
const html = readFileSync(join(electronDir, 'renderer/index.html'), 'utf8');
const styles = readFileSync(join(electronDir, 'renderer/styles.css'), 'utf8');

test('灵感库 preload 只暴露四个具名 IPC，不暴露 URL、令牌或账号选择器', () => {
  for (const channel of ['curated:summary', 'curated:list', 'curated:get', 'curated:create-post']) {
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }
  const block = preload.slice(preload.indexOf('// 当前账号灵感库'), preload.indexOf('// 对外客户鉴权'));
  const executable = block.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  // 切片一旦因锚注释改名而落空，下面的 doesNotMatch 会对空串永真、断言全部空过。
  // 先钉住切片真的取到了那四个方法，再断言它们不碰认证材料。
  assert.ok(executable.length > 0, 'preload 切片落空 → 下面的断言会空过');
  for (const method of ['curatedSummary', 'curatedList', 'curatedGet', 'curatedCreatePost']) {
    assert.match(executable, new RegExp(`${method}:`), `切片必须真的覆盖 ${method}`);
  }
  assert.doesNotMatch(executable, /authorization|cookie|jwt|token|headers|\burl\b|accountId/i);
  assert.doesNotMatch(renderer, /\bfetch\s*\(|authorization|cookie|jwt|token/i, '内容 renderer 不直接联网或接触认证材料');
});

test('main 固定 customer-auth 路径、方法和参数白名单，并从所选环境注入 envKey', () => {
  for (const channel of ['curated:summary', 'curated:list', 'curated:get', 'curated:create-post']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }
  assert.match(main, /raw\.mode === 'all'[\s\S]*raw\.mode === 'created'[\s\S]*raw\.mode === 'uncreated'/);
  assert.doesNotMatch(main.slice(main.indexOf("ipcMain.handle('curated:list'"), main.indexOf("ipcMain.handle('curated:get'")), /raw\.mode === 'creatable'/);
  const listBlock = main.slice(main.indexOf("ipcMain.handle('curated:list'"), main.indexOf("ipcMain.handle('curated:get'"));
  for (const sort of ['weighted', 'collects', 'likes', 'recent']) {
    assert.match(listBlock, new RegExp(`raw\\.sort === '${sort}'`), `main 必须显式白名单排序 ${sort}`);
  }
  assert.match(listBlock, /error: 'invalid_curated_sort'/);
  assert.doesNotMatch(listBlock, /sortField|sortBy|direction|accountId|envKey|authorization|token/i,
    '排序 IPC 不得接受字段、方向、账号、envKey 或认证材料');
  // 边界值必须右锚（\b）：不加的话 `limit > 50` 也匹配放宽后的 `limit > 5000`，护栏形同虚设。
  assert.match(main, /limit < 1 \|\| limit > 50\b/, 'limit 上界必须仍是 50');
  assert.match(main, /Number\.isInteger\(offset\)/, 'offset 必须整数校验（原先根本没断言）');
  assert.match(main, /offset < 0 \|\| offset > 1_000_000\b/, 'offset 边界必须仍收口');
  assert.match(main, /Number\.isInteger\(id\)[\s\S]*id <= 0/);
  assert.match(main, /typeof useReferenceImages !== 'boolean'/);
  assert.match(main, /`\/curated-contents\?mode=\$\{mode\}&sort=\$\{sort\}&limit=\$\{limit\}&offset=\$\{offset\}`/);
  assert.match(main, /'\/curated-contents\?mode=all&limit=1&offset=0'/);
  assert.match(main, /`\/curated-contents\/\$\{id\}\/create-post`[\s\S]*method: 'POST'[\s\S]*body: \{ useReferenceImages \}/);
  assert.match(main, /body: \{ \.\.\.options\.body, envKey: handle\.profileId \}/, 'envKey 只能由 main 从所选环境注入');
  assert.match(main, /token: clientSession\.token/, '客户 token 只在 main 注入');
});

test('灵感库列表隐藏视觉滚动条但保留原生纵向滚动', () => {
  assert.match(styles, /\.curated-list\s*\{[\s\S]*overflow-y:\s*auto;[\s\S]*scrollbar-width:\s*none;/);
  assert.match(styles, /\.curated-list::\-webkit-scrollbar\s*\{\s*display:\s*none;/);
});

test('客户排序控件位于列表工具栏右侧并在窄窗口有序换行', () => {
  const tabsIndex = html.indexOf('id="curated-mode-tabs"');
  const totalIndex = html.indexOf('id="curated-list-total"');
  const sortIndex = html.indexOf('id="curated-sort-control"');
  assert.ok(tabsIndex >= 0 && tabsIndex < totalIndex && totalIndex < sortIndex, '筛选在左，总数与排序在右');
  for (const [value, label] of [['weighted', '综合热度'], ['collects', '收藏最多'], ['likes', '点赞最多'], ['recent', '最近更新']]) {
    assert.match(html, new RegExp(`data-curated-sort="${value}"[\\s\\S]*${label}`));
  }
  assert.match(html, /点赞 \+ 收藏 × 1\.43/);
  assert.match(html, /最近一次采集的赞藏数据排序，不代表平台实时热度/);
  assert.match(styles, /\.cw-sort-trigger\s*\{[\s\S]*height:\s*32px;[\s\S]*background:\s*#fff;/);
  assert.match(styles, /@media \(max-width:\s*680px\)[\s\S]*\.cw-toolbar\s*\{[^}]*flex-wrap:\s*wrap;[\s\S]*\.cw-toolbar-side\s*\{[^}]*width:\s*100%;/);
  assert.match(styles, /\.cw-heading\s*\{[^}]*grid-column:\s*2;/, '返回按钮隐藏时标题仍须留在中间弹性列');
  assert.match(styles, /\.cw-header > \.cw-icon-button:last-child\s*\{[^}]*grid-column:\s*3;/, '关闭按钮须固定在右列');
});

test('待审批稿只经具名 IPC 读取，路径和环境范围由 main 固定', () => {
  for (const channel of ['publish-draft:list', 'publish-draft:get', 'publish-schedule:occupied-hours']) {
    const escaped = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${escaped}'`));
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${escaped}'`));
  }
  assert.match(main, /`\/publish-drafts\?limit=\$\{limit\}&offset=\$\{offset\}`[\s\S]*includeEnvQuery: true/);
  assert.match(main, /`\/publish-drafts\/\$\{id\}`[\s\S]*includeEnvQuery: true/);
  assert.match(main, /'\/publish-schedule\/occupied-hours'[\s\S]*includeEnvQuery: true/);
  assert.match(main, /limit < 1 \|\| limit > 50\b/);
  assert.match(main, /Number\.isInteger\(id\)[\s\S]*id <= 0/);
  assert.doesNotMatch(appRenderer, /\/publish-(?:drafts|schedule)/, 'renderer 不得自行拼客户接口路径');

  const block = preload.slice(preload.indexOf('// 待审批稿列表/详情'), preload.indexOf('// 稿件预览内删除某张配图'));
  assert.match(block, /publishDraftList:/);
  assert.match(block, /publishDraftGet:/);
  assert.match(block, /publishScheduleOccupiedHours:/);
  const executable = block.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(executable, /authorization|cookie|jwt|token|headers|accountId|\burl\b/i);
});

test('稿件编辑与五类 AI 调整只经具名白名单 IPC，renderer 不接触环境键或客户令牌', () => {
  for (const channel of ['publish-draft:edit', 'publish-draft:refine', 'publish-draft:refinement-get']) {
    const escaped = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${escaped}'`));
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${escaped}'`));
  }
  const start = main.indexOf("ipcMain.handle('publish-draft:edit'");
  const end = main.indexOf("ipcMain.handle('publish-schedule:occupied-hours'", start);
  const block = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /new Set\(\['expectedVersion', 'title', 'content', 'topics'\]\)/);
  assert.match(block, /new Set\(\['whole', 'body', 'images', 'selected_image', 'selected_text'\]\)/);
  assert.match(block, /instruction\.length > 1000/);
  assert.match(block, /selection\.start >= 0 && selection\.end > selection\.start/);
  assert.match(block, /Object\.keys\(selection\)\.length === 1[\s\S]*selection\.imageUrl/);
  assert.match(block, /`\/environments\/\$\{encodeURIComponent\(handle\.profileId\)\}\/publish-drafts\/\$\{id\}`/);
  assert.match(block, /\/refinements\/\$\{encodeURIComponent\(key\)\}/);
  assert.doesNotMatch(renderer, /\/environments\/[^'"`]*\/publish-drafts|authorization|cookie|jwt|clientSession\.token/i);
  const preloadBlock = preload.slice(preload.indexOf('// 待审批稿列表/详情'), preload.indexOf('// 稿件预览内删除某张配图'));
  for (const method of ['publishDraftEdit', 'publishDraftRefine', 'publishDraftRefinementGet']) assert.match(preloadBlock, new RegExp(`${method}:`));
  const executable = preloadBlock.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(executable, /authorization|cookie|jwt|token|headers|accountId|envKey|\burl\b/i);
});

test('内容首页工作面板桌面总高 240px，窄屏无横向溢出且减弱动画', () => {
  assert.match(styles, /\.content-work-card\s*\{[\s\S]*height:\s*240px;[\s\S]*box-sizing:\s*border-box;/);
  assert.match(styles, /\.content-home-view\s*\{[^}]*overflow-x:\s*hidden;/);
  assert.match(styles, /@media \(max-width:\s*680px\)[\s\S]*\.content-work-card\s*\{[^}]*height:\s*auto;/);
  assert.match(styles, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.content-work-card\.is-active \.content-work-status::after/);
  assert.match(html, /id="content-runtime-guide"[\s\S]*首次使用请先启动当前环境/);
});

test('审批 IPC 允许旧客户端省略计划，新计划须成对且取消不得夹带', () => {
  const start = main.indexOf("ipcMain.handle('publish:approval'");
  const end = main.indexOf("ipcMain.handle('publish:image-remove'", start);
  const block = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /hasPublishMode !== hasPublishTime/);
  assert.match(block, /!approved && \(hasPublishMode \|\| hasPublishTime\)/);
  assert.match(block, /publishMode !== 'immediate' && publishMode !== 'scheduled'/);
  assert.match(block, /publishMode === 'immediate' && publishTime !== null/);
  assert.match(block, /publishMode === 'scheduled'[\s\S]*Number\.isFinite\(publishTime\)/);
  assert.match(block, /\.\.\.\(hasPublishMode \? \{ publishMode: payload\.publishMode, publishTime: payload\.publishTime \} : \{\}\)/);
});

test('审批与删图 IPC 直连 customer-auth，停止状态不经过环境 core 或浏览器调度', () => {
  const start = main.indexOf("ipcMain.handle('publish:approval'");
  const end = main.indexOf('async function delegatedTaskRequest', start);
  const block = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /personaIpcEnv\(envId\)/, 'main 必须把 renderer envId 权威换成 envKey');
  assert.match(block, /\/publish\/approval`[\s\S]*method: 'POST'/);
  assert.match(block, /\/publish\/draft-image-remove`[\s\S]*method: 'POST'/);
  assert.match(block, /receipt !== 'accepted_pending_execution'[\s\S]*receipt !== 'rejected'/,
    '审批受理与发布成功必须保持分离');
  assert.doesNotMatch(block, /sendPublishClientCommand|sendPublishApprovalCommand|\.child\b|queueStartEnv|startEdge|resumeEdge|admitBrowserSlot/,
    'Cloud 决策写不得依赖 core、浏览器或槽位');
});

test('标题栏只保留紧凑灵感入口，并锁定低干扰蓝色与高储备蓝绿色', () => {
  const accountIndex = html.indexOf('id="acct-plat"');
  const spacerIndex = html.indexOf('class="tb-spacer"');
  const entryIndex = html.indexOf('id="content-library-entry"');
  const environmentIndex = html.indexOf('id="cloud-env-chip"');
  const healthIndex = html.indexOf('id="health-pill"');
  assert.ok(accountIndex < spacerIndex, '账号身份应留在标题栏左侧');
  assert.ok(spacerIndex < entryIndex, '弹性留白应把灵感入口推到标题栏右侧');
  assert.ok(entryIndex < environmentIndex, '灵感入口应紧邻环境名左侧');
  assert.ok(environmentIndex < healthIndex, '环境名后仍保持健康状态顺序');
  assert.match(styles, /\.tb-spacer\s*\{[^}]*flex:\s*1/s);
  assert.equal((html.match(/id="content-library-entry"/g) ?? []).length, 1, '运行首页不得再保留大卡入口');
  for (const color of ['#eef5ff', '#d7e5ff', '#526a87', '#2f6fe4', '#dce8f7', '#4f83e8', '#3f7ce0', '#2aa57a']) {
    assert.match(styles.toLowerCase(), new RegExp(color));
  }
  assert.match(styles, /height:\s*28px/);
  assert.match(styles, /\.cle-track\s*\{[^}]*height:\s*3px/s);
});

test('应用壳把当前平台交给内容工作区，由内容控制器执行 XHS 门禁', () => {
  assert.match(
    appRenderer,
    /const environment = envId \? \{[\s\S]*?platform: selectedEnvPlatform\(\),[\s\S]*?\} : null/,
  );
  assert.match(appRenderer, /contentWorkspace\?\.setEnvironment\(environment\)/);
});

test('完整价值面板属于小红书环境首页，内容工作区不再保留第二个首页', () => {
  const dashboardStart = html.indexOf('id="xhs-environment-dashboard"');
  const homeStart = html.indexOf('id="content-home-view"');
  const scheduleStart = html.indexOf('id="environment-schedule-entry"');
  const workspaceStart = html.indexOf('id="content-workspace"');
  assert.ok(dashboardStart >= 0 && dashboardStart < homeStart && homeStart < scheduleStart && scheduleStart < workspaceStart);
  assert.equal((html.match(/id="content-home-view"/g) ?? []).length, 1);
  assert.equal((html.match(/id="environment-schedule-entry"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /data-content-page="home"/);
  for (const id of [
    'content-value-intro', 'content-work-card', 'content-featured', 'content-reference-list',
    'content-mine-list', 'content-runtime-detail',
  ]) {
    assert.match(html, new RegExp(`(?:id|class)="${id}`));
  }
  assert.match(renderer, /dashboardRoot[\s\S]*legacyRuntimeRoot[\s\S]*syncEnvironmentLanding/);
  assert.match(styles, /\.xhs-environment-dashboard[\s\S]*min-width:\s*0/);
  assert.match(styles, /\.legacy-runtime-body\.hidden\s*\{\s*display:\s*none\s*!important;/);
  assert.match(styles, /\.fleet-row\.with-rail > \.shell\.xhs-dashboard-mode\s*\{[^}]*max-width:\s*1040px;/);
});

// 注：陈旧响应丢弃、账号切换失效、排队回执诚实性等**行为**一律由 content-workspace.test.ts
// 在 jsdom 里真的执行控制器来验证。这里只留「源码文本」层面挡不住也测不出的静态约束
// （IPC 通道白名单、路径/方法固定、envKey/token 只由 main 注入）。
// 绝不再用源码正则去替代行为断言：那种断言只证明某段字符串还在，改个等价写法就红、真坏了却可能绿。
test('页面控制器不自行拼接 customer-auth 路径，只经具名 IPC 取数', () => {
  for (const method of ['curatedSummary', 'curatedList', 'curatedGet', 'curatedCreatePost']) {
    assert.match(renderer, new RegExp(`api\\.${method}`), `renderer 只能经 ${method} 取数`);
  }
  assert.doesNotMatch(renderer, /\/curated-contents/, 'renderer 不得自行拼接 customer-auth 路径');
  assert.doesNotMatch(renderer, /envKey/, 'renderer 不得触碰 envKey');
});
