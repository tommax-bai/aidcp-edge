import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  FRAGMENT_DIRECTORY,
  PRODUCTION_FORBIDDEN_MARKERS,
  RETIRED_DIST_MODULES,
  assertFragmentInventoryReconciled,
  forbiddenFragmentBasenames,
} = require('./native-engine-inventory.cjs');

export const repoRoot = resolve(import.meta.dirname, '..');

export function collectFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(root);
  return files;
}

const importPattern = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?|\bimport\s*\()\s*['"](\.[^'"]+)['"]/g;

export function collectReachable(distRoot, entry) {
  const reachable = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || reachable.has(file)) continue;
    reachable.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      const dependency = resolve(dirname(file), specifier);
      if (!dependency.startsWith(`${distRoot}${sep}`) || extname(dependency) !== '.js') continue;
      if (!existsSync(dependency)) {
        throw new Error(`production import graph has a missing dependency: ${relative(distRoot, dependency)}`);
      }
      pending.push(dependency);
    }
  }
  return reachable;
}

/**
 * 已迁移的 TypeScript 模块闸：这批模块在 dist 里有确定的相对路径，按路径判。
 */
export function assertNoRetiredDistModules(distRoot) {
  for (const path of RETIRED_DIST_MODULES) {
    if (existsSync(join(distRoot, path))) {
      throw new Error(`migrated page-engine JavaScript module remains in production dist: ${path}`);
    }
  }
}

/**
 * 页面规则分片闸 —— 锚定说明（本 change 的判断依据）：
 *
 * 旧实现逐条检查 `dist/facebook-router/<分片>.js` 是否存在。dist 由 tsc 从 src/ 编出，
 * 而 src/ 下从来没有 facebook-router 目录（分片只活在 native/page-engine/src/facebook-router/），
 * 任何受支持的构建都产不出 `dist/facebook-router/` —— 那 10 条断言恒不触发，是装饰。
 *
 * 因此这道闸重新锚定到「该脚本真正能检查到的语料」：整棵 dist 树，按**文件名**判。
 * 分片一旦被以任何方式（拷贝、打包脚本、生成器）落进 dist 的任意子目录，当场失败。
 * 枚举从清单派生，新增分片自动进闸。
 */
export function assertNoFragmentLeak(distRoot, files, fragmentNames) {
  const forbidden = new Set(fragmentNames);
  for (const file of files) {
    if (forbidden.has(basename(file))) {
      throw new Error(
        `embedded page-rule fragment leaked into production dist: ${relative(distRoot, file)} `
        + `(registered in ${FRAGMENT_DIRECTORY}/manifest.txt)`,
      );
    }
  }
}

export function assertNoForbiddenMarkers(distRoot, files) {
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const marker of PRODUCTION_FORBIDDEN_MARKERS) {
      if (source.includes(marker)) {
        throw new Error(`migrated page-rule marker remains in ${relative(distRoot, file)}: ${marker}`);
      }
    }
  }
}

export function assertNoWeChatSidecarRules(distRoot) {
  const wechatSidecar = join(distRoot, 'wechat-channels/browser-sidecar.js');
  if (!existsSync(wechatSidecar)) return;
  const source = readFileSync(wechatSidecar, 'utf8');
  for (const marker of ['Network.getAllCookies', 'Network.requestWillBeSent', 'Runtime.evaluate']) {
    if (source.includes(marker)) {
      throw new Error(`migrated WeChat browser-session rule remains in production dist: ${marker}`);
    }
  }
}

export function assertNoSourceMaps(distRoot, files) {
  for (const file of files) {
    if (/\.map$/i.test(file)) {
      throw new Error(`source map is forbidden in production dist: ${relative(distRoot, file)}`);
    }
  }
}

export function pruneProductionDist(root = repoRoot) {
  const distRoot = join(root, 'dist');
  const entry = join(distRoot, 'main.js');
  if (!existsSync(entry)) throw new Error('production dist entry is missing');

  // 分片清单与目录先对账：闸门的枚举来自清单，清单本身失真则整条闸失效。
  const fragmentNames = assertFragmentInventoryReconciled(root);

  const allFiles = collectFiles(distRoot);

  // 分片闸在剪枝**之前**判：分片落进 dist 说明上游有一条把明文规则拷进构建产物的路径，
  // 那必须响亮失败。若放在剪枝之后，不可达的分片会先被当作孤儿文件删掉，
  // 闸门随后报通过 —— 泄漏路径原样留着，只是被这次构建顺手擦掉了痕迹。
  assertNoFragmentLeak(distRoot, allFiles, fragmentNames);

  const reachable = collectReachable(distRoot, entry);

  let removed = 0;
  for (const file of allFiles) {
    if (extname(file) !== '.js' || reachable.has(file)) continue;
    rmSync(file);
    removed += 1;
  }
  const survivingFiles = allFiles.filter((file) => existsSync(file));

  assertNoRetiredDistModules(distRoot);
  assertNoForbiddenMarkers(distRoot, [...reachable]);
  assertNoWeChatSidecarRules(distRoot);
  assertNoSourceMaps(distRoot, survivingFiles);

  return {
    reachable: reachable.size,
    removed,
    fragments: fragmentNames.length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, 'prune-production-dist.mjs')) {
  const summary = pruneProductionDist(repoRoot);
  console.log(
    `[production-dist] reachable=${summary.reachable} removed=${summary.removed} `
    + `legacy_page_rules=absent page_rule_fragments_guarded=${summary.fragments} source_maps=absent`,
  );
}

// 供闸门自测复用（否定式闸门必须能被证明会失败，见 build-contract.test.ts / artifact-gates.test.ts）。
export { forbiddenFragmentBasenames, PRODUCTION_FORBIDDEN_MARKERS, RETIRED_DIST_MODULES };
