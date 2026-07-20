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
  // 边界值必须右锚（\b）：不加的话 `limit > 50` 也匹配放宽后的 `limit > 5000`，护栏形同虚设。
  assert.match(main, /limit < 1 \|\| limit > 50\b/, 'limit 上界必须仍是 50');
  assert.match(main, /Number\.isInteger\(offset\)/, 'offset 必须整数校验（原先根本没断言）');
  assert.match(main, /offset < 0 \|\| offset > 1_000_000\b/, 'offset 边界必须仍收口');
  assert.match(main, /Number\.isInteger\(id\)[\s\S]*id <= 0/);
  assert.match(main, /typeof useReferenceImages !== 'boolean'/);
  assert.match(main, /`\/curated-contents\?mode=\$\{mode\}&limit=\$\{limit\}&offset=\$\{offset\}`/);
  assert.match(main, /'\/curated-contents\?mode=all&limit=1&offset=0'/);
  assert.match(main, /`\/curated-contents\/\$\{id\}\/create-post`[\s\S]*method: 'POST'[\s\S]*body: \{ useReferenceImages \}/);
  assert.match(main, /body: \{ \.\.\.options\.body, envKey: handle\.profileId \}/, 'envKey 只能由 main 从所选环境注入');
  assert.match(main, /token: clientSession\.token/, '客户 token 只在 main 注入');
});

test('灵感库列表隐藏视觉滚动条但保留原生纵向滚动', () => {
  assert.match(styles, /\.curated-list\s*\{[\s\S]*overflow-y:\s*auto;[\s\S]*scrollbar-width:\s*none;/);
  assert.match(styles, /\.curated-list::\-webkit-scrollbar\s*\{\s*display:\s*none;/);
});

test('待审批稿只经具名 IPC 读取，路径和环境范围由 main 固定', () => {
  for (const channel of ['publish-draft:list', 'publish-draft:get']) {
    const escaped = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${escaped}'`));
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${escaped}'`));
  }
  assert.match(main, /`\/publish-drafts\?limit=\$\{limit\}&offset=\$\{offset\}`[\s\S]*includeEnvQuery: true/);
  assert.match(main, /`\/publish-drafts\/\$\{id\}`[\s\S]*includeEnvQuery: true/);
  assert.match(main, /limit < 1 \|\| limit > 50\b/);
  assert.match(main, /Number\.isInteger\(id\)[\s\S]*id <= 0/);
  assert.doesNotMatch(appRenderer, /\/publish-drafts/, 'renderer 不得自行拼客户接口路径');

  const block = preload.slice(preload.indexOf('// 待审批稿列表/详情'), preload.indexOf('// 稿件预览内删除某张配图'));
  assert.match(block, /publishDraftList:/);
  assert.match(block, /publishDraftGet:/);
  const executable = block.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(executable, /authorization|cookie|jwt|token|headers|accountId|\burl\b/i);
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
    /contentWorkspace\.setEnvironment\(envId \? \{[\s\S]*?platform: selectedEnvPlatform\(\),[\s\S]*?\} : null\)/,
  );
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
