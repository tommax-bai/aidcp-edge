// 否定式闸门的可证伪自测。
//
// 判定纪律：一道「这些内容不许出现在这里」的闸门，只有在**被植入违规内容并被观察到拒绝**
// 之后才计入覆盖。断言脚本文本里出现了某个标识符（build-contract.test.ts 里那类）
// 只证明「代码里写了这段话」，不证明「这段话会判定」——本仓两道恒不触发的闸门
// 在那类断言下已经绿了很久。

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

const inventory = require(resolve(repoRoot, 'scripts/native-engine-inventory.cjs')) as {
  CLEARTEXT_SOURCE_ROOT: string;
  FRAGMENT_DIRECTORY: string;
  PACKAGED_FRAGMENT_PREFIX: string;
  PRODUCTION_FORBIDDEN_MARKERS: readonly string[];
  RETIRED_DIST_MODULES: readonly string[];
  assertFragmentInventoryReconciled: (root: string) => string[];
  assertFragmentsEndWithNewline: (root: string) => void;
  assertPackagingAllowListExcludesFragments: (patterns: unknown[]) => void;
  forbiddenFragmentBasenames: (root: string) => string[];
  listCleartextPageRuleSources: (root: string) => string[];
  packagedFragmentEntries: (root: string) => string[];
  readFragmentManifest: (root: string) => string[];
};

const afterPack = require(resolve(repoRoot, 'scripts/after-pack.cjs')) as {
  packagedForbiddenEntries: (root: string) => string[];
  verifyPackagedXiaohongshuLeakage: (asarPath: string, options?: Record<string, unknown>) => number;
};

const pruner = await import(
  pathToFileURL(resolve(repoRoot, 'scripts/prune-production-dist.mjs')).href
) as {
  assertNoFragmentLeak: (distRoot: string, files: string[], names: string[]) => void;
  assertNoForbiddenMarkers: (distRoot: string, files: string[]) => void;
  assertNoRetiredDistModules: (distRoot: string) => void;
  assertNoSourceMaps: (distRoot: string, files: string[]) => void;
  pruneProductionDist: (root: string) => { reachable: number; removed: number; fragments: number };
};

const builder = await import(
  pathToFileURL(resolve(repoRoot, 'scripts/build-native-page-engine.mjs')).href
) as {
  assertSentinelsAreLive: (
    sentinels: { marker: string; presence: 'live' | 'structural'; reason?: string }[],
    sources: { release: { path: string; contents: Buffer }[]; testOnly: { path: string; contents: Buffer }[] },
  ) => void;
  cleartextSentinels: { marker: string; presence: 'live' | 'structural'; reason?: string }[];
  collectEngineSources: () => Promise<{
    release: { path: string; contents: Buffer }[];
    testOnly: { path: string; contents: Buffer }[];
  }>;
  computeEngineSourceDigest: (files: { path: string; contents: Buffer }[]) => string;
};

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'aidcp-gate-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. 事实源派生（task 1.1 / 1.4）
// ---------------------------------------------------------------------------

test('fragment inventory reconciles the manifest with the directory in both directions', () => {
  const entries = inventory.assertFragmentInventoryReconciled(repoRoot);
  assert.ok(entries.length >= 11, `expected the full fragment set, got ${entries.length}`);
  assert.ok(entries.includes('08-reaction-semantics.js'));
});

test('every registered fragment is covered by both leakage gates', () => {
  const entries = inventory.readFragmentManifest(repoRoot);
  const packaged = afterPack.packagedForbiddenEntries(repoRoot);
  for (const entry of entries) {
    // 打包扫描侧
    assert.ok(
      packaged.includes(`${inventory.PACKAGED_FRAGMENT_PREFIX}${entry}`),
      `packaging scanner does not cover fragment ${entry}`,
    );
    // 生产剪枝侧：闸按文件名判，植入一个同名文件必须被拒。
    assert.throws(
      () => pruner.assertNoFragmentLeak('/dist', [`/dist/nested/${entry}`], entries),
      new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `production pruner does not cover fragment ${entry}`,
    );
  }
});

/**
 * 泄漏闸的覆盖面由**目录结构**派生，不由 Facebook 有序清单派生。
 *
 * 反例就在本仓：`FRAGMENT_DIRECTORY` 只指向 facebook-router/，而小红书的四份分片与
 * 两份明文选择器平铺在上一级 `native/page-engine/src/` 下。以清单派生时，
 * 新增 xhs-input-targets.js（含全部选择器与 DOM 语义）之后「已守护分片数」纹丝不动 ——
 * 那不是「已覆盖」的证据，恰恰是「未覆盖」的证据：任一构建路径把它明文带进产物，
 * 两道闸都不会命中，计数照报。
 */
test('every cleartext page-rule source is covered, Xiaohongshu fragments included', () => {
  const sources = inventory.listCleartextPageRuleSources(repoRoot);
  const manifest = inventory.readFragmentManifest(repoRoot);
  const basenames = inventory.forbiddenFragmentBasenames(repoRoot);
  const packaged = afterPack.packagedForbiddenEntries(repoRoot);

  assert.ok(
    sources.length > manifest.length,
    `泄漏闸覆盖面（${sources.length}）没有宽于 Facebook 有序清单（${manifest.length}）：小红书分片逃出闸门了`,
  );
  const xiaohongshu = sources.filter((path) => /\/xhs-[^/]+$/.test(path));
  assert.ok(xiaohongshu.length >= 4, `小红书明文语料只认出 ${xiaohongshu.length} 份`);
  assert.ok(
    xiaohongshu.includes(`${inventory.CLEARTEXT_SOURCE_ROOT}/xhs-input-targets.js`),
    '写动作判据分片必须在闸门枚举里',
  );

  for (const path of xiaohongshu) {
    assert.ok(packaged.includes(`/${path}`), `packaging scanner does not cover ${path}`);
    const name = path.slice(path.lastIndexOf('/') + 1);
    assert.throws(
      () => pruner.assertNoFragmentLeak('/dist', [`/dist/nested/${name}`], basenames),
      /embedded page-rule fragment leaked into production dist/,
      `production pruner does not cover ${path}`,
    );
  }
});

test('the pruning pipeline rejects a planted Xiaohongshu fragment as well', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'dist', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'main.js'), 'export const main = 1;\n');
    symlinkSync(resolve(repoRoot, 'native'), join(dir, 'native'));
    const plantedPath = join(dir, 'dist', 'nested', 'xhs-input-targets.js');
    writeFileSync(plantedPath, '// planted Xiaohongshu page rule\n');
    assert.throws(
      () => pruner.pruneProductionDist(dir),
      /embedded page-rule fragment leaked into production dist/,
    );
    assert.ok(existsSync(plantedPath), 'the leaked fragment must still be there when the gate fires');

    rmSync(plantedPath);
    const summary = pruner.pruneProductionDist(dir);
    // 对账数：闸门报出来的「已守护分片数」必须等于目录派生的全部明文语料，
    // 不是 Facebook 有序清单那 11 条。
    assert.equal(summary.fragments, inventory.listCleartextPageRuleSources(repoRoot).length);
    assert.ok(summary.fragments > inventory.readFragmentManifest(repoRoot).length);
  });
});

test('neither leakage gate carries a hand-copied fragment list', () => {
  for (const script of ['scripts/prune-production-dist.mjs', 'scripts/after-pack.cjs']) {
    const source = readFileSync(resolve(repoRoot, script), 'utf8');
    assert.doesNotMatch(
      source,
      /['"][^'"]*facebook-router\/[0-9]{2}-[a-z-]+\.js['"]/,
      `${script} still enumerates page-rule fragments from a private copy`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. 否定式闸门的植入式自测（task 2.1 / 2.2 / 2.3）
// ---------------------------------------------------------------------------

test('production pruner rejects a planted page-rule fragment anywhere under dist', () => {
  withTempDir((dir) => {
    const names = inventory.readFragmentManifest(repoRoot);
    const planted = join(dir, 'facebook', names[0]!);
    mkdirSync(dirname(planted), { recursive: true });
    writeFileSync(planted, '// planted\n');
    assert.throws(
      () => pruner.assertNoFragmentLeak(dir, [planted], names),
      /embedded page-rule fragment leaked into production dist/,
    );
    // 对照：没有植入时同一道闸必须放行，否则这条自测什么也没证明。
    assert.doesNotThrow(() => pruner.assertNoFragmentLeak(dir, [join(dir, 'main.js')], names));
  });
});

test('the pruning pipeline rejects a leaked fragment instead of silently deleting it', () => {
  // 回归防线：分片闸必须在剪枝**之前**判。放在之后时，不可达的分片会先被当作
  // 孤儿文件删掉、闸门随后报通过 —— 泄漏路径原样留着，痕迹被这次构建擦掉了。
  withTempDir((dir) => {
    mkdirSync(join(dir, 'dist', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'main.js'), 'export const main = 1;\n');
    symlinkSync(resolve(repoRoot, 'native'), join(dir, 'native'));
    const leaked = inventory.readFragmentManifest(repoRoot)[0]!;
    const plantedPath = join(dir, 'dist', 'nested', leaked);
    writeFileSync(plantedPath, '// planted page rule\n');
    assert.throws(
      () => pruner.pruneProductionDist(dir),
      /embedded page-rule fragment leaked into production dist/,
    );
    assert.ok(existsSync(plantedPath), 'the leaked fragment must still be there when the gate fires');
    // 对照：拿掉植入内容后同一条管线必须跑通。
    rmSync(plantedPath);
    assert.deepEqual(pruner.pruneProductionDist(dir).removed, 0);
  });
});

test('production pruner rejects a planted cleartext page-rule marker', () => {
  withTempDir((dir) => {
    const planted = join(dir, 'planted.js');
    writeFileSync(planted, `const x = ${JSON.stringify(inventory.PRODUCTION_FORBIDDEN_MARKERS[0])};\n`);
    assert.throws(
      () => pruner.assertNoForbiddenMarkers(dir, [planted]),
      /migrated page-rule marker remains in/,
    );
    writeFileSync(planted, 'const x = 1;\n');
    assert.doesNotThrow(() => pruner.assertNoForbiddenMarkers(dir, [planted]));
  });
});

test('production pruner rejects a planted retired module and a planted source map', () => {
  withTempDir((dir) => {
    const retired = join(dir, inventory.RETIRED_DIST_MODULES[0]!);
    mkdirSync(dirname(retired), { recursive: true });
    writeFileSync(retired, '// planted\n');
    assert.throws(
      () => pruner.assertNoRetiredDistModules(dir),
      /migrated page-engine JavaScript module remains in production dist/,
    );
    assert.throws(
      () => pruner.assertNoSourceMaps(dir, [join(dir, 'main.js.map')]),
      /source map is forbidden in production dist/,
    );
  });
});

test('packaging scanner rejects a planted fragment entry in the archive listing', () => {
  const entries = afterPack.packagedForbiddenEntries(repoRoot);
  const planted = entries.find((entry) => entry.includes('08-reaction-semantics.js'));
  assert.ok(planted, 'the derived forbidden-entry list must include 08-reaction-semantics.js');
  const archive = {
    listPackage: () => ['/dist/native-page-engine/runtime.js', planted!],
    extractFile: () => Buffer.from(''),
  };
  assert.throws(
    () => afterPack.verifyPackagedXiaohongshuLeakage('unused.asar', { projectRoot: repoRoot, asar: archive }),
    /Packaged cleartext page-rule fragment is forbidden/,
  );
});

test('packaging scanner rejects a planted cleartext marker inside a packaged module', () => {
  const archive = {
    listPackage: () => ['/dist/native-page-engine/runtime.js', '/dist/planted.js'],
    extractFile: (_path: string, entry: string) => (entry === 'dist/planted.js'
      ? Buffer.from(`const x = ${JSON.stringify(inventory.PRODUCTION_FORBIDDEN_MARKERS[0])};`)
      : Buffer.from('')),
  };
  assert.throws(
    () => afterPack.verifyPackagedXiaohongshuLeakage('unused.asar', { projectRoot: repoRoot, asar: archive }),
    /Packaged migrated page-rule marker is forbidden/,
  );
});

test('packaging fails when the allow-list is widened to reach cleartext page-rule sources', () => {
  // 现状允许清单必须通过。
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    build: { files: string[] };
  };
  assert.doesNotThrow(() => inventory.assertPackagingAllowListExcludesFragments(packageJson.build.files));
  for (const widened of ['native/**/*', '**/*', 'native/page-engine/src/**/*', '**']) {
    assert.throws(
      () => inventory.assertPackagingAllowListExcludesFragments([...packageJson.build.files, widened]),
      /packaging allow-list pattern can reach cleartext page-rule sources/,
      `widening the allow-list with ${widened} must fail packaging`,
    );
  }
  // 这道断言必须由允许清单自己抛出，而不是靠禁止清单碰巧命中某个条目。
  const archive = {
    listPackage: () => ['/dist/native-page-engine/runtime.js'],
    extractFile: () => Buffer.from(''),
  };
  assert.throws(
    () => afterPack.verifyPackagedXiaohongshuLeakage('unused.asar', {
      projectRoot: repoRoot,
      asar: archive,
      readPackageJson: () => ({ build: { files: [...packageJson.build.files, 'native/**/*'] } }),
    }),
    /packaging allow-list pattern can reach cleartext page-rule sources/,
  );
});

// ---------------------------------------------------------------------------
// 3. 明文哨兵双向校验（task 3.1 / 3.2 / 3.3）
// ---------------------------------------------------------------------------

test('every cleartext sentinel is currently live or explicitly recorded as structural', async () => {
  const sources = await builder.collectEngineSources();
  assert.doesNotThrow(() => builder.assertSentinelsAreLive(builder.cleartextSentinels, sources));
  for (const sentinel of builder.cleartextSentinels) {
    if (sentinel.presence === 'structural') {
      assert.ok(sentinel.reason, `structural sentinel ${sentinel.marker} must record why it has no live subject`);
    }
  }
});

test('a sentinel that lost its subject fails the liveness check', async () => {
  const sources = await builder.collectEngineSources();
  assert.throws(
    () => builder.assertSentinelsAreLive(
      [{ marker: 'aidcp-sentinel-that-does-not-exist', presence: 'live' }],
      sources,
    ),
    /has lost its subject.*occurs in no engine source at all/s,
  );
});

test('a sentinel surviving only in a test-only unit is reported as expired, not as a clean scan', () => {
  const sources = {
    release: [{ path: 'src/facebook/publish.rs', contents: Buffer.from('fn click() {}\n') }],
    testOnly: [{ path: 'src/facebook/publish_tests.rs', contents: Buffer.from('"Input.dispatchMouseEvent"\n') }],
  };
  assert.throws(
    () => builder.assertSentinelsAreLive([{ marker: 'Input.dispatch', presence: 'live' }], sources),
    /occurs only in test-only compilation units/,
  );
});

test('a structural sentinel fails once the joined literal appears in release sources', () => {
  const sources = {
    release: [{ path: 'src/cdp.rs', contents: Buffer.from('let m = "Page.navigate";\n') }],
    testOnly: [],
  };
  assert.throws(
    () => builder.assertSentinelsAreLive(
      [{ marker: 'Page.navigate', presence: 'structural', reason: 'split in cdp.rs' }],
      sources,
    ),
    /structural sentinel now has a literal in release sources/,
  );
});

// ---------------------------------------------------------------------------
// 4. 拼接不变量（task 4.2 / 4.4 的 Node 侧镜像）
// ---------------------------------------------------------------------------

test('every registered fragment ends with a newline', () => {
  assert.doesNotThrow(() => inventory.assertFragmentsEndWithNewline(repoRoot));
});

test('the build script asserts both fragment-inventory invariants', () => {
  // 存在性断言（不构成判定证据）：真正的判定证据是 build.rs 在植入未登记分片 /
  // 去掉尾随换行时实测 panic，见本 change tasks.md 4.4 的实测记录。
  const buildScript = readFileSync(resolve(repoRoot, 'native/page-engine/build.rs'), 'utf8');
  assert.match(buildScript, /page-rule fragment is not registered in the ordered source manifest/);
  assert.match(buildScript, /must end with a newline before concatenation/);
});

// ---------------------------------------------------------------------------
// 5. 产物校验绑定源码（task 5.1 / 5.2）
// ---------------------------------------------------------------------------

test('the engine source digest changes when a page-rule fragment changes', async () => {
  const sources = await builder.collectEngineSources();
  const baseline = builder.computeEngineSourceDigest(sources.release);
  assert.match(baseline, /^[a-f0-9]{64}$/);
  const index = sources.release.findIndex((file) => file.path.startsWith('src/facebook-router/'));
  assert.ok(index >= 0, 'the digest input set must include the page-rule fragments');
  const mutated = sources.release.map((file, position) => (position === index
    ? { path: file.path, contents: Buffer.concat([file.contents, Buffer.from('// edit\n')]) }
    : file));
  assert.notEqual(builder.computeEngineSourceDigest(mutated), baseline);
  // 同一份输入必须给出同一个摘要，否则开发态会无条件重建。
  assert.equal(builder.computeEngineSourceDigest(sources.release), baseline);
});

test('the source digest input set covers the engine sources that decide the binary', async () => {
  const sources = await builder.collectEngineSources();
  const paths = sources.release.map((file) => file.path);
  for (const required of [
    'build.rs',
    'Cargo.toml',
    'Cargo.lock',
    'command-manifest.json',
    'src/facebook-router/manifest.txt',
    'src/xhs-page-probe.js',
  ]) {
    assert.ok(paths.includes(required), `engine source digest must cover ${required}`);
  }
  // 测试专用编译单元不进摘要：改测试不应触发开发态重建。
  assert.ok(sources.testOnly.some((file) => file.path.endsWith('_tests.rs')));
  assert.ok(!paths.some((path) => path.endsWith('_tests.rs')));
});

test('the staged manifest records a source digest so verification cannot be self-consistent only', () => {
  const script = readFileSync(resolve(repoRoot, 'scripts/build-native-page-engine.mjs'), 'utf8');
  assert.match(script, /sourceDigest/);
  assert.match(script, /stale relative to engine sources/);
});
