#!/usr/bin/env node
// Fail-closed static gate for signed OL macOS release output. This intentionally has no
// network calls: promotion later performs anonymous HTTPS checks after objects are uploaded.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

function die(message) {
  console.error(`OL auto-update artifact verification failed: ${message}`);
  process.exit(1);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

function scalar(yaml, key) {
  const match = yaml.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  return match ? match[1].replace(/^['"]|['"]$/g, '') : '';
}

const outputDir = resolve(argument('--dir') || 'dist-electron');
const updateUrl = argument('--update-url').replace(/\/+$/, '');
if (!/^https:\/\/.+/.test(updateUrl)) die('--update-url must be https://...');

const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
const version = String(rootPackage.version || '');
if (!version) die('package.json has no version');

const latestPath = join(outputDir, 'latest-mac.yml');
if (!existsSync(latestPath)) die(`missing ${latestPath}`);
const latest = readFileSync(latestPath, 'utf8');
if (scalar(latest, 'version') !== version) die(`latest-mac.yml version is not ${version}`);

const names = [
  `AIDCP-${version}-arm64-mac.zip`,
  `AIDCP-${version}-mac.zip`,
  `AIDCP-${version}-arm64.dmg`,
  `AIDCP-${version}.dmg`,
];
for (const name of names) {
  const file = join(outputDir, name);
  if (!existsSync(file) || statSync(file).size <= 0) die(`missing or empty ${name}`);
  if (!latest.includes(`url: ${name}`)) die(`latest-mac.yml does not reference ${name}`);
}
for (const name of names.filter((name) => name.endsWith('.zip'))) {
  const blockmap = join(outputDir, `${name}.blockmap`);
  if (!existsSync(blockmap) || statSync(blockmap).size <= 0) die(`missing or empty ${name}.blockmap`);
}

for (const appDir of ['mac', 'mac-arm64']) {
  const resources = join(outputDir, appDir, 'AIDCP.app', 'Contents', 'Resources');
  const appUpdatePath = join(resources, 'app-update.yml');
  const appAsarPath = join(resources, 'app.asar');
  if (!existsSync(appUpdatePath)) die(`missing ${appUpdatePath}`);
  if (!existsSync(appAsarPath)) die(`missing ${appAsarPath}`);
  const appUpdate = readFileSync(appUpdatePath, 'utf8');
  if (scalar(appUpdate, 'provider') !== 'generic') die(`${appDir} app-update.yml is not generic`);
  if (scalar(appUpdate, 'url').replace(/\/+$/, '') !== updateUrl) die(`${appDir} app-update.yml URL differs from OL URL`);
  const packaged = JSON.parse(asar.extractFile(appAsarPath, 'package.json').toString());
  if (packaged.version !== version) die(`${appDir} packaged version differs from root package.json`);
  if (packaged.aidcpUpdateChannel !== 'ol') die(`${appDir} lacks aidcpUpdateChannel=ol`);
  if (String(packaged.aidcpUpdateUrl || '').replace(/\/+$/, '') !== updateUrl) die(`${appDir} baked update URL differs from OL URL`);
}

console.log(`OL auto-update artifacts verified: ${version} (${updateUrl})`);
