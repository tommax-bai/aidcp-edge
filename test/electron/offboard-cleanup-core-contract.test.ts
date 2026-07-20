import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, '../../src/electron/main.cjs'), 'utf8');
const runtime = readFileSync(join(here, '../../src/wechat-channels/runtime.ts'), 'utf8');

test('offboard recovery consumes a bound grant and never falls back to browser startup', () => {
  const start = main.indexOf('async function startRestrictedOffboardCleanupCore');
  const end = main.indexOf('function startEdge(', start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  assert.match(block, /cleanup-bootstrap/);
  assert.match(block, /cleanupGrant: pending\.cleanupGrant, edgeId: expectedEdgeId/);
  assert.match(block, /cleanupManual = true/);
  assert.match(block, /cleanupBootstrap: \{ offboardId: data\.offboardId \}/);
  assert.doesNotMatch(block, /queueStartEnv|startEdge|ensureAdsServiceOnce|ensureKernelOnce|admitBrowserSlot|launchQueue|openProfile/);
});

test('restricted runtime advertises only inbox/offboard/browser-absent capabilities and rejects every other command', () => {
  assert.match(runtime, /cleanupOnly\s*\? \['interaction_inbox_v1', 'interaction_offboarding_v1', 'browser_absent_v1'\]/);
  assert.match(runtime, /cleanupOnly && envelope\.type !== 'interaction\.offboard\.command' && envelope\.type !== 'interaction\.offboard\.ack'/);
  assert.match(runtime, /restricted cleanup rejected mismatched offboard command/);
  assert.match(runtime, /if \(!cleanupOnly\) await flushReplyResultOutbox\(\)/);
});

test('settings projection strips cleanup bearer and authoritative account id from renderer', () => {
  const start = main.indexOf("ipcMain.handle('settings:get'");
  const end = main.indexOf('// 对外客户鉴权', start);
  const block = main.slice(start, end);
  assert.match(block, /pendingInteractionOffboards: \(settings\.pendingInteractionOffboards \|\| \[\]\)\.map/);
  const projection = block.slice(block.indexOf('pendingInteractionOffboards:'), block.indexOf('adsDownloadUrl:'));
  assert.doesNotMatch(projection, /cleanupGrant|accountId|cleanupEdgeId/);
});
