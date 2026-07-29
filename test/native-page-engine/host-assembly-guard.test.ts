/**
 * 宿主装配的源码级闸（change restore-native-xiaohongshu-session-guards §6.2 / §6.3 / §6.5）。
 *
 * 为什么需要这道闸：2026-07-23 有人把一整段仍在跑的宿主装配（浮层监测、上报闸、看护托管与 CDP
 * 生命周期挂钩、评论/加群执行器、会话装配与命令路由）包进一个静态恒假的条件里，并为随之被剪枝的
 * 模块补上 `declare const … typeof import('…')` 影子声明让编译通过。结果是三道现有闸全绿：
 *   - typecheck 只穷举类型，不穷举「这段代码还会不会执行」；
 *   - 生产剪枝脚本按 dist 的导入图判，恒假块与影子声明从不进 dist，它看不见；
 *   - 单测不覆盖装配路径。
 * 于是一整批能力静默消失，直到 `54ae5b2`（07-26）才有人发现其中一条（FB 软限流上报）。
 *
 * 判定纪律（沿用 artifact-gates.test.ts）：一道否定式闸门只有在**被植入违规内容并被观察到拒绝**
 * 之后才计入覆盖。因此下面既扫真实 src/（必须为零），也对临时目录里植入的违规样本断言它会被点名
 * 到具体文件与行号。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { facebookPlatformDriver } from '../../src/facebook/driver.js';
import { xhsPlatformDriver } from '../../src/xhs/driver.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = resolve(repoRoot, 'src');

export type HostAssemblyViolationKind = 'constant_false_gate' | 'pruned_module_shadow_declaration';

export interface HostAssemblyViolation {
  readonly kind: HostAssemblyViolationKind;
  /** 相对被扫描根目录的路径，报错文案里必须出现。 */
  readonly file: string;
  /** 1-indexed 行号，报错文案里必须出现。 */
  readonly line: number;
  readonly snippet: string;
}

/**
 * 静态恒假的装配入口：条件的第一个操作数是假值字面量，或条件里与假值字面量做合取。
 * 只认字面量——把旗标算成常量需要常量传播，那是编译器的活，规则化会立刻变成误报机。
 */
const CONSTANT_FALSE_LEADING =
  /^\s*(?:\}\s*)?(?:else\s+)?(?:if|while)\s*\(\s*(?:false|0|!\s*(?:true|1))\s*(?:&&|\|\||\))/;
const CONSTANT_FALSE_CONJUNCTION =
  /^\s*(?:\}\s*)?(?:else\s+)?(?:if|while)\s*\(.*&&\s*(?:false|0|!\s*(?:true|1))\s*(?:&&|\))/;

/** 影子声明：`declare` 一个值，其类型取自**仓内相对路径**模块的 `import()` 类型位置。 */
const DECLARE_START = /^\s*declare\s+(?:const|let|var|function|class|enum)\b/;
const RELATIVE_TYPE_IMPORT = /\bimport\s*\(\s*['"]\.\.?\//;

/** 影子声明可以跨行（历史实例 `captureBlockingOverlaySnapshot` 就横跨两行），向后并行有界几行。 */
const DECLARATION_LOOKAHEAD_LINES = 6;

function listTypeScriptSources(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (path.endsWith('.ts') && !path.endsWith('.d.ts')) files.push(path);
    }
  };
  walk(root);
  return files.sort();
}

/**
 * 逐行扫描（保留行号，便于点名）。注释按行粒度剔除：整行 `//` 与块注释区间跳过。
 * 行尾注释不剔除——本闸的两条判据都锚在语句开头，行尾注释不会命中。
 */
export function scanHostAssemblySource(source: string, file: string): HostAssemblyViolation[] {
  const violations: HostAssemblyViolation[] = [];
  const lines = source.split('\n');
  const isComment: boolean[] = new Array(lines.length).fill(false);
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (inBlockComment) {
      isComment[i] = true;
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('//')) {
      isComment[i] = true;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      isComment[i] = true;
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    if (isComment[i]) continue;
    const line = lines[i] ?? '';
    if (CONSTANT_FALSE_LEADING.test(line) || CONSTANT_FALSE_CONJUNCTION.test(line)) {
      violations.push({ kind: 'constant_false_gate', file, line: i + 1, snippet: line.trim() });
      continue;
    }
    if (!DECLARE_START.test(line)) continue;
    let joined = line;
    for (let j = i + 1; j < lines.length && j <= i + DECLARATION_LOOKAHEAD_LINES; j += 1) {
      if (joined.includes(';')) break;
      if (isComment[j]) continue;
      joined += ` ${lines[j] ?? ''}`;
    }
    if (RELATIVE_TYPE_IMPORT.test(joined)) {
      violations.push({
        kind: 'pruned_module_shadow_declaration',
        file,
        line: i + 1,
        snippet: line.trim(),
      });
    }
  }
  return violations;
}

export function scanHostAssemblyTree(root: string): HostAssemblyViolation[] {
  const violations: HostAssemblyViolation[] = [];
  for (const path of listTypeScriptSources(root)) {
    const relativePath = relative(root, path).split(sep).join('/');
    violations.push(...scanHostAssemblySource(readFileSync(path, 'utf8'), relativePath));
  }
  return violations;
}

function describe(violations: readonly HostAssemblyViolation[]): string {
  return violations.map((v) => `${v.file}:${v.line} [${v.kind}] ${v.snippet}`).join('\n');
}

// ── 闸本身：真实 src/ 必须为零 ────────────────────────────────────────────────

test('host-assembly guard: src/ 里没有静态恒假的装配入口，也没有为已剪枝模块造的影子声明', () => {
  const violations = scanHostAssemblyTree(srcRoot);
  assert.deepEqual(
    violations,
    [],
    `发现「恒假装配入口 / 影子声明」违规（这类保留形态 typecheck 与剪枝都看不见，能力会静默消失）：\n${describe(violations)}`,
  );
});

// ── 可证伪性：植入违规必须被点名到文件与行 ──────────────────────────────────

test('host-assembly guard: 植入的恒假装配入口被拒绝并点名文件与行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidcp-host-assembly-'));
  try {
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(
      join(dir, 'nested/assembly.ts'),
      [
        'export function assemble(driver: { runtimeKind: string }): void {',
        "  if (false && driver.runtimeKind === 'browser') {",
        '    console.log(1);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const violations = scanHostAssemblyTree(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.kind, 'constant_false_gate');
    assert.equal(violations[0]?.file, 'nested/assembly.ts');
    assert.equal(violations[0]?.line, 2);
    assert.match(describe(violations), /nested\/assembly\.ts:2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host-assembly guard: 恒假的其它写法（合取在后、while、!true、单独 0）同样被拒绝', () => {
  const cases: [string, number][] = [
    ['if (0) {', 1],
    ['if (!true) {', 1],
    ['while (false) {', 1],
    ['if (ready && false) {', 1],
    ['} else if (false) {', 1],
  ];
  for (const [line, expected] of cases) {
    const violations = scanHostAssemblySource(`${line}\n}\n`, 'x.ts');
    assert.equal(violations.length, expected, `未拒绝恒假写法：${line}`);
    assert.equal(violations[0]?.kind, 'constant_false_gate');
  }
});

test('host-assembly guard: 植入的影子声明（含跨行写法）被拒绝并点名文件与行', () => {
  const single = scanHostAssemblySource(
    "declare const FacebookOverlayMonitor: typeof import('./facebook/overlay.js').FacebookOverlayMonitor;\n",
    'main.ts',
  );
  assert.equal(single.length, 1);
  assert.equal(single[0]?.kind, 'pruned_module_shadow_declaration');
  assert.equal(single[0]?.line, 1);

  const multiline = scanHostAssemblySource(
    ['declare const captureBlockingOverlaySnapshot:', "  typeof import('./browse/overlay-monitor.js').captureBlockingOverlaySnapshot;", ''].join('\n'),
    'main.ts',
  );
  assert.equal(multiline.length, 1);
  assert.equal(multiline[0]?.kind, 'pruned_module_shadow_declaration');
  assert.equal(multiline[0]?.line, 1, '跨行影子声明必须点名 declare 那一行，而不是续行');
  assert.match(describe(multiline), /main\.ts:1/);
});

test('host-assembly guard: 正常代码与注释不误报（否则闸会变成并行流的路障）', () => {
  const benign = [
    '// if (false && driver.runtimeKind === "browser") {  ← 注释里的历史形状不算违规',
    '/*',
    " * declare const X: typeof import('./y.js').X;  ← 文档里的示例不算违规",
    ' */',
    'declare global {',
    '  interface Window { aidcp?: unknown }',
    '}',
    'export function f(a: number, arr: number[]): number {',
    '  if (a === 0) return 0;',
    '  if (a && arr[0]) return 1;',
    '  if (a > 0 && arr.length === 0) return 2;',
    '  while (a > 0) return 3;',
    '  return 4;',
    '}',
    '',
  ].join('\n');
  assert.deepEqual(scanHostAssemblySource(benign, 'benign.ts'), []);
});

// ── §6.2：恒假块删除后，宿主不得再引用那批退役装配 ────────────────────────────

test('host assembly: main.ts 不再引用恒假块里的任何退役装配符号', () => {
  const mainSource = readFileSync(resolve(srcRoot, 'main.ts'), 'utf8');
  const retired = [
    'FacebookOverlayMonitor',
    'FacebookBrowseSession',
    'usesFacebookBrowseSession',
    'FacebookCommentExecutor',
    'FacebookCommentHandler',
    'FacebookJoinExecutor',
    'backfillOverlayEvidenceText',
    'emitCompanionUiEvent',
    'WatcherSupervisor',
    'createOverlayReportGate',
    'captureBlockingOverlaySnapshot',
    'BlockingOverlaySnapshot',
  ];
  const found = retired.filter((symbol) => new RegExp(`\\b${symbol}\\b`).test(mainSource));
  assert.deepEqual(
    found,
    [],
    `main.ts 仍引用退役装配符号（恒假块被删后不应留下任何残留引用）：${found.join(', ')}`,
  );
});

test('host assembly: main.ts 不再引用退役的宿主侧监测体模块', () => {
  const mainSource = readFileSync(resolve(srcRoot, 'main.ts'), 'utf8');
  for (const moduleSpecifier of [
    'browse/overlay-monitor',
    'browse/overlay-report-gate',
    'browse/watcher-supervisor',
    'browse/identity-watcher',
    'browse/login-modal-watcher',
    'browse/background-watcher',
  ]) {
    assert.doesNotMatch(
      mainSource,
      new RegExp(moduleSpecifier),
      `main.ts 重新接回了退役监测体 ${moduleSpecifier}；阻断/身份观测的落点是 Native 页面探针`,
    );
  }
});

test('host assembly: 阻断上报的活代码只在 Native 会话里，宿主不再自行上报', () => {
  const mainSource = readFileSync(resolve(srcRoot, 'main.ts'), 'utf8');
  assert.doesNotMatch(mainSource, /risk\.captcha_detected/);
  assert.doesNotMatch(mainSource, /risk\.captcha_cleared/);
  const nativeSession = readFileSync(resolve(srcRoot, 'native-page-engine/browse-session.ts'), 'utf8');
  assert.match(nativeSession, /risk\.captcha_detected/);
  assert.match(nativeSession, /risk\.captcha_cleared/);
});

// ── §6.5：无调用点的浮层监测体工厂成员，最终形态 ──────────────────────────────
//
// 裁定：从 driver 契约上删除（而不是接进小红书阻断观测通路）。坐实过程：
//   ① 全仓零调用点——`platformDriver.createOverlayMonitor(...)` 一处也没有，唯一构造点在已删除的
//      恒假块里，且用的还是 `new FacebookOverlayMonitor(...)` 而非工厂；
//   ② 小红书阻断观测正由 Native 页面探针重建（周期观测在 native-page-engine/browse-session.ts，
//      动作提交前的即席复检在 Rust 动作闸内），页面判据必须留在编码后的 Native 产物里，
//      「接进去」会把可读的页面判据搬回宿主 TypeScript，与迁移动机冲突；
//   ③ 原样保留则是「接口上有、没人调」的第二种无信号保留——正是本节要消灭的形态。

test('platform driver: 浮层监测体工厂成员已从契约与两处实现上删除', () => {
  const driverContract = readFileSync(resolve(srcRoot, 'platform/driver.ts'), 'utf8');
  assert.doesNotMatch(driverContract, /createOverlayMonitor/);
  assert.doesNotMatch(driverContract, /browse\/overlay-monitor/);

  for (const [label, path] of [
    ['xhs', 'xhs/driver.ts'],
    ['facebook', 'facebook/driver.ts'],
  ] as const) {
    const source = readFileSync(resolve(srcRoot, path), 'utf8');
    assert.doesNotMatch(source, /createOverlayMonitor/, `${label} driver 仍声明浮层监测体工厂`);
  }

  assert.equal('createOverlayMonitor' in xhsPlatformDriver, false);
  assert.equal('createOverlayMonitor' in facebookPlatformDriver, false);
});

test('platform driver: 删除工厂成员不影响两个 driver 的其余运行时契约', () => {
  assert.equal(xhsPlatformDriver.runtimeKind, 'browser');
  assert.equal(facebookPlatformDriver.runtimeKind, 'browser');
  assert.equal(typeof (xhsPlatformDriver as { readIdentity?: unknown }).readIdentity, 'function');
  assert.equal(typeof (facebookPlatformDriver as { readIdentity?: unknown }).readIdentity, 'function');
  assert.equal(xhsPlatformDriver.capabilities.includes('browse'), true);
  assert.equal(facebookPlatformDriver.capabilities.includes('browse'), true);
});

test('platform driver: 全仓没有任何 createOverlayMonitor 调用点复活', () => {
  const offenders = listTypeScriptSources(srcRoot)
    .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
    .filter(({ source }) => /createOverlayMonitor/.test(source))
    .map(({ path }) => relative(repoRoot, path));
  assert.deepEqual(offenders, [], `createOverlayMonitor 已被裁定删除，却在这些文件里复活：${offenders.join(', ')}`);
});

// ── §6.4：退役模块的三分类结论（本轮只登记，不删除；删除另起波次）─────────────
//
// 分类（HEAD 实测）：
//   零引用            —— identity-watcher.ts / login-modal-watcher.ts 的类在 src/ 里除自身外无引用
//                        （login-modal-watcher 的**接口**仍被退役的 browse-session.ts 以类型引用）
//   仅被恒假块引用    —— watcher-supervisor.ts / overlay-report-gate.ts（本节删块后在 src/ 里只剩桶文件转出）
//   仍被活代码引用    —— overlay-monitor.ts（类型被十余个 facebook/*.ts 依赖）、notification-monitor.ts
//                        （browse-session.ts 取三段未读读取 JS）、background-watcher.ts（被 overlay-monitor
//                        与 notification-monitor 继承）、captcha-assist.ts（协助链路参照书，§3 正在据其复原）
// 本轮一律不删：并行流与后续波次正拿它们当参照书逐条复原行为；notification-monitor 已被并行 change
// 具名标为「若按孤儿删除则通知类修复永久不通电——要的是恢复而不是清理」。

test('retired watchers: 本轮不删除退役监测体，它们仍是并行流的参照书', () => {
  for (const path of [
    'browse/overlay-report-gate.ts',
    'browse/background-watcher.ts',
    'browse/watcher-supervisor.ts',
    'browse/identity-watcher.ts',
    'browse/notification-monitor.ts',
    'browse/captcha-assist.ts',
    'browse/overlay-monitor.ts',
  ]) {
    assert.equal(
      statSync(resolve(srcRoot, path)).isFile(),
      true,
      `${path} 被删除了；本轮的范围只是清除恒假块与影子声明，退役模块要留给并行流当参照书`,
    );
  }
});

test('retired watchers: overlay-monitor 仍被活代码引用，MUST NOT 当孤儿顺手删', () => {
  const consumers = listTypeScriptSources(srcRoot)
    .filter((path) => !path.endsWith(`${sep}overlay-monitor.ts`))
    .filter((path) => /browse\/overlay-monitor/.test(readFileSync(path, 'utf8')))
    .map((path) => relative(srcRoot, path).split(sep).join('/'));
  assert.ok(
    consumers.some((file) => file.startsWith('facebook/')),
    `overlay-monitor 的活引用消失了（实测消费方：${consumers.join(', ') || '无'}）；` +
      '若确已无人引用，删除结论要单独裁定，而不是让这条断言默默变绿',
  );
});
