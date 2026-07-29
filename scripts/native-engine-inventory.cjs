'use strict';

// Facebook 路由分片的顺序事实源是 native/page-engine/src/facebook-router/manifest.txt
// —— build.rs 只读这一份来决定哪些分片被拼接、异或后编进二进制。
//
// 但**泄漏闸的覆盖面比它大**：明文页面规则不止 Facebook 那一摞有序分片，
// native/page-engine/src/ 下还平铺着小红书的四份分片与两份明文选择器
// （build.rs 逐个 fs::read 后异或编进二进制）。曾经整条闸只由 FB 清单派生，
// 于是新增 xhs-input-targets.js（236 行，含全部选择器与 DOM 语义）之后
// 「已守护分片数」纹丝不动 —— 那不是「已覆盖」的证据，恰恰是「未覆盖」的证据。
//
// 因此泄漏闸的枚举一律从**目录结构**派生：src/ 下所有非 Rust 文件都是明文页面规则语料。
// 新增任何一份分片都自动进闸，无需登记，也无处手抄。
// MUST NOT 各自手抄一份字面量清单：手抄清单与事实源之间没有任何机械对账，
// 新增分片会自动逃出全部闸门（08-reaction-semantics.js 就是这么漏掉的）。
//
// 本模块写成 CommonJS，因为消费方同时有 ESM 脚本（prune-production-dist.mjs、
// build-native-page-engine.mjs）与 CommonJS 的 electron-builder 钩子（after-pack.cjs），
// 而 after-pack 的泄漏扫描必须保持同步调用形态。

const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');

/** Facebook 有序分片目录（相对仓库根）。 */
const FRAGMENT_DIRECTORY = 'native/page-engine/src/facebook-router';
/** 有序清单文件名（build.rs 唯一读取并断言的那一份）。 */
const FRAGMENT_MANIFEST_NAME = 'manifest.txt';
/** Facebook 分片在 asar 归档里的条目前缀（asar.listPackage 给的是以 / 开头的绝对条目名）。 */
const PACKAGED_FRAGMENT_PREFIX = '/native/page-engine/src/facebook-router/';
/** electron-builder 的 files 允许清单一旦能覆盖到这个根，明文分片就可能进归档。 */
const PACKAGED_FRAGMENT_ROOT = 'native/page-engine/src/';
/** 明文页面规则语料的根：这棵树下的非 Rust 文件全部是被禁出现在产物里的明文规则。 */
const CLEARTEXT_SOURCE_ROOT = 'native/page-engine/src';
/** 引擎自身的实现语言 —— 它不是明文页面规则，扫描时排除。 */
const ENGINE_SOURCE_EXTENSION = '.rs';

/**
 * 已迁移到 Native 引擎、MUST NOT 再出现在生产 dist / 安装包里的 TypeScript 模块产物。
 * 这批是 dist 里真实存在过的相对路径，与分片不同，无法由 manifest 派生，只能显式枚举。
 */
const RETIRED_DIST_MODULES = Object.freeze([
  'browse/browse-session.js',
  'browse/feed-scroller.js',
  'browse/modal-controller.js',
  'browse/note-extractor.js',
  'browse/search-handler.js',
  'browse/notification-monitor.js',
  'flows/publish-command-handlers.js',
  'client/cloud-selector.js',
  'client/like-runner.js',
  'locating/engine.js',
  'locating/cache.js',
  'facebook/identity.js',
  'facebook/overlay.js',
  'facebook/consent.js',
  'facebook/cta-labels.js',
  'facebook/post-identity.js',
  'facebook/feed-reader.js',
  'facebook/inline-reader.js',
  'facebook/post-reader.js',
  'facebook/reels-reader.js',
  'facebook/viewport-scroll.js',
  'facebook/like-executor.js',
  'facebook/facebook-session.js',
  'facebook/comment-executor.js',
  'facebook/comment-handler.js',
  'facebook/join-executor.js',
  'facebook/join-handler.js',
  'facebook/publish-executor.js',
  'facebook/probes/editor-probe.js',
  'facebook/probes/fingerprint.js',
  'facebook/probes/gated-submit.js',
  'facebook/probes/page-structure.js',
  'facebook/probes/post-composer-probe.js',
  'facebook/probes/post-media-probe.js',
  'facebook/probes/storage-summary.js',
]);

/**
 * 已迁移页面规则的明文特征串：出现在生产 dist / 安装包内的任何 JavaScript 里即判泄漏。
 * 生产剪枝与打包后置扫描共用这一份，避免两侧清单各自漂移。
 */
const PRODUCTION_FORBIDDEN_MARKERS = Object.freeze([
  'FOLLOW_BUTTON_SELECTORS',
  'note.publish_set_cover',
  'creator-preview-image-0',
  'input.upload-input[type=file]',
  'facebook stable numeric id candidate was not found',
  'facebook identity candidates conflict',
  'facebook-comment-lifecycle-verify',
  'target_not_facebook',
  'data-aidcp-native-feed-like',
  'data-aidcp-native-reel-like-target',
  'targetGroupScope',
  'composer_editor_not_found',
]);

function fragmentDirectory(repoRoot) {
  return resolve(repoRoot, FRAGMENT_DIRECTORY);
}

function fragmentManifestPath(repoRoot) {
  return join(fragmentDirectory(repoRoot), FRAGMENT_MANIFEST_NAME);
}

/**
 * 读取有序清单，并逐条复刻 build.rs `read_ordered_sources` 的正向断言
 * （条目非空、无路径分隔符、唯一、按词典序递增）。
 * 两侧规则一旦漂移，本函数与构建会给出不同判定 —— 由 gate 套件的对账用例接住。
 */
function readFragmentManifest(repoRoot) {
  const raw = readFileSync(fragmentManifestPath(repoRoot), 'utf8');
  const entries = raw
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new Error(`ordered source manifest cannot be empty: ${FRAGMENT_DIRECTORY}/${FRAGMENT_MANIFEST_NAME}`);
  }
  const seen = new Set();
  let previous = null;
  for (const entry of entries) {
    if (entry.includes('/') || entry.includes('\\') || seen.has(entry)) {
      throw new Error(`ordered source manifest entries must be unique local file names: ${entry}`);
    }
    seen.add(entry);
    if (previous !== null && !(previous < entry)) {
      throw new Error(`ordered source manifest entries must remain in lexical assembly order: ${previous} then ${entry}`);
    }
    previous = entry;
  }
  return entries;
}

/** 列出分片目录里除清单本身以外的全部文件名。 */
function listFragmentFiles(repoRoot) {
  const directory = fragmentDirectory(repoRoot);
  return readdirSync(directory)
    .filter((name) => name !== FRAGMENT_MANIFEST_NAME)
    .filter((name) => statSync(join(directory, name)).isFile())
    .sort();
}

/**
 * 双向对账：目录里的每个文件都必须登记在清单里，清单里的每条也都必须有对应文件。
 * 只做正向断言（现状）时，新增分片却忘记登记会构建照过、二进制里没有它、
 * 运行时静默走缺失逻辑 —— 这正是「静默假成功」在构建闸上的形态。
 */
function assertFragmentInventoryReconciled(repoRoot) {
  const entries = readFragmentManifest(repoRoot);
  const files = listFragmentFiles(repoRoot);
  const unregistered = files.filter((name) => !entries.includes(name));
  if (unregistered.length > 0) {
    throw new Error(
      `page-rule fragment is not registered in ${FRAGMENT_DIRECTORY}/${FRAGMENT_MANIFEST_NAME}: ${unregistered.join(', ')}`,
    );
  }
  const missing = entries.filter((name) => !files.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `ordered source manifest names a fragment that does not exist: ${missing.join(', ')}`,
    );
  }
  return entries;
}

/**
 * 拼接不变量的 TypeScript/Node 侧镜像：每片必须以换行结尾。
 * 选「断言尾随换行」而非「插入分隔字节」的理由见 build.rs 同名注释
 * （插分隔符会改变已编入二进制的字节，属行为变更）。
 */
function assertFragmentsEndWithNewline(repoRoot) {
  const directory = fragmentDirectory(repoRoot);
  for (const entry of readFragmentManifest(repoRoot)) {
    const contents = readFileSync(join(directory, entry));
    if (contents.length === 0 || contents[contents.length - 1] !== 0x0a) {
      throw new Error(
        `page-rule fragment must end with a newline before concatenation: ${FRAGMENT_DIRECTORY}/${entry}`,
      );
    }
  }
}

/**
 * 全部明文页面规则语料（仓库根相对路径，POSIX 分隔符，字典序）。
 *
 * 由**目录结构**派生而非任何清单：清单只管「哪些分片按什么顺序拼进 Facebook 路由」，
 * 管不到平铺在 src/ 下的小红书分片与明文选择器。以清单派生泄漏闸，等于让每一份
 * 非 Facebook 的明文规则结构上逃出全部闸门 —— 而计数不变会让人误以为「已覆盖」。
 */
function listCleartextPageRuleSources(repoRoot) {
  const root = resolve(repoRoot, CLEARTEXT_SOURCE_ROOT);
  const collected = [];
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (statSync(path).isDirectory()) {
        walk(path, relative);
        continue;
      }
      if (name.endsWith(ENGINE_SOURCE_EXTENSION)) continue;
      if (name === FRAGMENT_MANIFEST_NAME) continue;
      collected.push(`${CLEARTEXT_SOURCE_ROOT}/${relative}`);
    }
  };
  walk(root, '');
  if (collected.length === 0) {
    throw new Error(`no cleartext page-rule sources found under ${CLEARTEXT_SOURCE_ROOT}`);
  }
  // 两套派生对不上就响亮失败：有序清单登记的每一片都必须出现在目录派生的语料里。
  // 对不上说明其中一套已经失真，而两套都在给闸门供枚举。
  const missing = readFragmentManifest(repoRoot)
    .map((entry) => `${FRAGMENT_DIRECTORY}/${entry}`)
    .filter((path) => !collected.includes(path));
  if (missing.length > 0) {
    throw new Error(`ordered source manifest names a file the cleartext scan cannot see: ${missing.join(', ')}`);
  }
  return collected;
}

/** 生产 dist 里被禁的分片文件名（按 basename 判，见 prune-production-dist.mjs 的锚定说明）。 */
function forbiddenFragmentBasenames(repoRoot) {
  return listCleartextPageRuleSources(repoRoot).map((path) => path.slice(path.lastIndexOf('/') + 1));
}

/** 安装包 asar 里被禁的分片条目名。 */
function packagedFragmentEntries(repoRoot) {
  return listCleartextPageRuleSources(repoRoot).map((path) => `/${path}`);
}

/**
 * electron-builder 的 files 允许清单是今天真正在挡明文分片的那一道（默认拒绝）。
 * 它一旦被放宽到能覆盖 native/page-engine/src/**，明文分片就可以进归档，
 * 而没有任何东西会提醒 —— 所以这里对允许清单本身做断言，而不是只等派生禁止清单命中。
 */
function assertPackagingAllowListExcludesFragments(patterns) {
  for (const raw of patterns) {
    const pattern = typeof raw === 'string' ? raw : String(raw && raw.from ? raw.from : '');
    if (!pattern || pattern.startsWith('!')) continue;
    const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
    // 模式只可能匹配到它第一个通配符之前的字面前缀之下。
    const literalPrefix = normalized.split(/[*?[{]/)[0];
    const reachesFragments = literalPrefix === ''
      || PACKAGED_FRAGMENT_ROOT.startsWith(literalPrefix)
      || literalPrefix.startsWith(PACKAGED_FRAGMENT_ROOT);
    if (reachesFragments) {
      throw new Error(
        `packaging allow-list pattern can reach cleartext page-rule sources under ${PACKAGED_FRAGMENT_ROOT}: ${pattern}`,
      );
    }
  }
}

/** 供闸门自测用：一个当前已登记的分片文件名。 */
function sampleFragmentName(repoRoot) {
  const entries = readFragmentManifest(repoRoot);
  return entries[0];
}

module.exports = {
  CLEARTEXT_SOURCE_ROOT,
  FRAGMENT_DIRECTORY,
  FRAGMENT_MANIFEST_NAME,
  PACKAGED_FRAGMENT_PREFIX,
  PACKAGED_FRAGMENT_ROOT,
  PRODUCTION_FORBIDDEN_MARKERS,
  RETIRED_DIST_MODULES,
  assertFragmentInventoryReconciled,
  assertFragmentsEndWithNewline,
  assertPackagingAllowListExcludesFragments,
  forbiddenFragmentBasenames,
  fragmentDirectory,
  fragmentManifestPath,
  listCleartextPageRuleSources,
  listFragmentFiles,
  packagedFragmentEntries,
  readFragmentManifest,
  sampleFragmentName,
};
