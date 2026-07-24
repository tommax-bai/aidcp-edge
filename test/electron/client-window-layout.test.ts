import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const main = readFileSync(join(electronDir, 'main.cjs'), 'utf8');
const html = readFileSync(join(electronDir, 'renderer/index.html'), 'utf8');
const interaction = readFileSync(join(electronDir, 'renderer/interaction-workspace.js'), 'utf8');
const styles = readFileSync(join(electronDir, 'renderer/styles.css'), 'utf8');

test('login stays compact while the authenticated client starts at 1080px wide', () => {
  assert.match(
    main,
    /function createLoginWindow\(\)[\s\S]*?new BrowserWindow\(\{\s*width: 900,\s*height: 720,\s*minWidth: 640,/,
  );
  assert.match(
    main,
    /function createWindow\(\)[\s\S]*?new BrowserWindow\(\{\s*width: 1080,\s*height: 720,\s*minWidth: 640,/,
  );
});

test('manual browser inspection uses the shortened default help copy', () => {
  const expected = '仅用于人工查看，引擎以上方鉴权状态为准。';
  assert.ok(html.includes(`<small id="iw-browser-help" aria-live="polite">${expected}</small>`));
  assert.ok(interaction.includes(`|| '${expected}'`));
  assert.doesNotMatch(html, /仅用于人工查看登录页和后台数据/);
  assert.doesNotMatch(interaction, /仅用于人工查看登录页和后台数据/);
});

test('manual browser action gets a larger desktop share and remains responsive', () => {
  assert.match(
    styles,
    /\.iw-browser-tools > \.iw-button\s*\{\s*flex: 0 0 18%;\s*min-width: 112px;\s*\}/,
  );
  assert.match(
    styles,
    /@media \(max-width: 520px\)[\s\S]*?\.iw-browser-tools > \.iw-button\s*\{\s*flex: 0 0 auto;\s*width: 100%;\s*min-width: 0;\s*\}/,
  );
});
