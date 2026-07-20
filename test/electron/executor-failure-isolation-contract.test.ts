import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const edgeMain = readFileSync(join(here, '../../src/main.ts'), 'utf8');
const electronMain = readFileSync(join(here, '../../src/electron/main.cjs'), 'utf8');

test('CDP terminal failure tears down only the executor and retains core/cloud transport', () => {
  const helperStart = edgeMain.indexOf('const isolateExecutorFailure');
  const helperEnd = edgeMain.indexOf('// Input 超时', helperStart);
  const helper = edgeMain.slice(helperStart, helperEnd);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.match(helper, /taskCoordinator\.reset\(reason\)/, 'must release the page task lease');
  assert.match(helper, /lifecycle\.request\('standby'\)/, 'must release CDP/provider resources in place');
  assert.match(helper, /lifecycle\.executor_failed/, 'must project the executor failure independently');
  assert.doesNotMatch(helper, /requestShutdown|process\.exit|client\.close/, 'must keep the core and Cloud transport alive');

  const terminalStart = edgeMain.lastIndexOf("session.cdp.on('cdp.unrecoverable'", edgeMain.indexOf("process.on('SIGINT'"));
  const terminalEnd = edgeMain.indexOf("process.on('SIGINT'", terminalStart);
  const terminalHandler = edgeMain.slice(terminalStart, terminalEnd);
  assert.match(terminalHandler, /isolateExecutorFailure\('cdp_unrecoverable'\)/);
  assert.doesNotMatch(terminalHandler, /requestShutdown|process\.exit/);
});

test('Electron keeps core/cloud online while exposing browser executor error', () => {
  const start = electronMain.indexOf("if (message.type === 'lifecycle.executor_failed')");
  const end = electronMain.indexOf("if (message.type === 'lifecycle.wake_requested')", start);
  const handler = electronMain.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(handler, /edge:\s*'running'/);
  assert.match(handler, /handle\.coldStandbyPending = true/);
  assert.match(electronMain, /handle\.executorFailure\s*\?\s*'error'/);
});
