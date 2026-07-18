import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const main = readFileSync(join(root, 'src/electron/main.cjs'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const require = createRequire(import.meta.url);
const { resolveTrayIconPath } = require('../../src/electron/tray-icon.cjs') as {
  resolveTrayIconPath(input: { isPackaged: boolean; appPath: string; resourcesPath: string }): string;
};

test('tray icon asset is a non-empty PNG', () => {
  const iconPath = join(root, 'build/icon.png');
  assert.ok(statSync(iconPath).size > 8, 'tray PNG must not be empty');
  const signature = readFileSync(iconPath).subarray(0, 8);
  assert.deepEqual([...signature], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('electron-builder ships the tray PNG outside app.asar', () => {
  const resources = packageJson.build.extraResources as Array<{ from?: string; to?: string }>;
  assert.ok(
    resources.some((entry) => entry.from === 'build/icon.png' && entry.to === 'tray-icon.png'),
    'build/icon.png must be copied to Resources/tray-icon.png',
  );
});

test('tray icon path is deterministic in development and packaged builds', () => {
  assert.equal(
    resolveTrayIconPath({ isPackaged: false, appPath: join('repo', 'aidcp-edge'), resourcesPath: join('app', 'Resources') }),
    join('repo', 'aidcp-edge', 'build', 'icon.png'),
  );
  assert.equal(
    resolveTrayIconPath({ isPackaged: true, appPath: join('app', 'Resources', 'app.asar'), resourcesPath: join('app', 'Resources') }),
    join('app', 'Resources', 'tray-icon.png'),
  );
});

test('tray creation rejects missing or empty images and keeps the window recoverable', () => {
  assert.doesNotMatch(main, /nativeImage\.createFromDataURL\(/, 'unsupported inline SVG tray icon must stay removed');
  assert.match(main, /nativeImage\.createFromPath\(iconPath\)/);
  assert.match(main, /fs\.existsSync\(iconPath\)/);
  assert.match(main, /icon\.isEmpty\(\)/);
  assert.match(main, /if \(!tray\)[\s\S]{0,220}?mainWindow\.show\(\)[\s\S]{0,220}?return;/);
});
