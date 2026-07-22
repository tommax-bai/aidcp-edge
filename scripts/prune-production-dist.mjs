import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const distRoot = join(repoRoot, 'dist');
const entry = join(distRoot, 'main.js');

if (!existsSync(entry)) throw new Error('production dist entry is missing');

const allFiles = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else allFiles.push(path);
  }
};
walk(distRoot);

const importPattern = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?|\bimport\s*\()\s*['"](\.[^'"]+)['"]/g;
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

let removed = 0;
for (const file of allFiles) {
  if (extname(file) !== '.js' || reachable.has(file)) continue;
  rmSync(file);
  removed += 1;
}

const forbiddenPaths = [
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
];
for (const path of forbiddenPaths) {
  if (existsSync(join(distRoot, path))) {
    throw new Error(`migrated Xiaohongshu JavaScript module remains in production dist: ${path}`);
  }
}

const forbiddenMarkers = [
  'FOLLOW_BUTTON_SELECTORS',
  'note.publish_set_cover',
  'creator-preview-image-0',
  "input.upload-input[type=file]",
];
for (const file of reachable) {
  const source = readFileSync(file, 'utf8');
  for (const marker of forbiddenMarkers) {
    if (source.includes(marker)) {
      throw new Error(`migrated Xiaohongshu page-rule marker remains in ${relative(distRoot, file)}: ${marker}`);
    }
  }
}

for (const file of allFiles) {
  if (/\.map$/i.test(file) && existsSync(file)) {
    throw new Error(`source map is forbidden in production dist: ${relative(distRoot, file)}`);
  }
}

console.log(`[production-dist] reachable=${reachable.size} removed=${removed} legacy_xhs=absent source_maps=absent`);
