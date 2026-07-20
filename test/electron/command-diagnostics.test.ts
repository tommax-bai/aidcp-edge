import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const diagnostics = require('../../src/electron/command-diagnostics.cjs') as {
  PREFIX: string;
  MAX_ITEMS: number;
  RETENTION_MS: number;
  parseCommandDiagnosticLine: (line: string, now?: number) => Record<string, unknown> | null;
  pruneCommandDiagnostics: (entries: unknown, now?: number) => Array<Record<string, unknown>>;
  mergeCommandDiagnostic: (entries: unknown, event: unknown, now?: number) => Array<Record<string, unknown>>;
  commandDiagnosticTraceLine: (event: unknown) => string;
};

function line(value: Record<string, unknown>): string {
  return `${diagnostics.PREFIX} ${JSON.stringify(value)}`;
}

test('electron command diagnostics: parser accepts only bounded structured events', () => {
  const valid = diagnostics.parseCommandDiagnosticLine(line({
    key: '1234abcd',
    type: 'search.execute',
    stage: 'received',
    summary: '搜索词 4 字',
  }), 1_000);
  assert.deepEqual(valid, {
    key: '1234abcd',
    type: 'search.execute',
    stage: 'received',
    summary: '搜索词 4 字',
    receivedAt: 1_000,
    updatedAt: 1_000,
  });

  for (const invalid of [
    '[command-diagnostic] not-json',
    line({ key: 'raw-id', type: 'search.execute', stage: 'received', summary: 'x' }),
    line({ key: '1234abcd', type: 'search.execute', stage: 'success', summary: 'x' }),
    line({ key: '1234abcd', type: 'search.execute', stage: 'received', summary: 'secret\nnext' }),
    line({ key: '1234abcd', type: 'search.execute', stage: 'received', summary: 'x', reason: 'secret_reason' }),
  ]) assert.equal(diagnostics.parseCommandDiagnosticLine(invalid, 1_000), null, invalid);
});

test('electron command diagnostics: stages upsert one row and preserve first receive time', () => {
  const received = diagnostics.parseCommandDiagnosticLine(line({
    key: '1234abcd', type: 'publish.command', stage: 'received', summary: '发布步骤 fill_field',
  }), 1_000);
  const dispatched = diagnostics.parseCommandDiagnosticLine(line({
    key: '1234abcd', type: 'publish.command', stage: 'dispatched', summary: '发布步骤 fill_field',
  }), 2_000);
  let entries = diagnostics.mergeCommandDiagnostic([], received, 1_000);
  entries = diagnostics.mergeCommandDiagnostic(entries, dispatched, 2_000);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].stage, 'dispatched');
  assert.equal(entries[0].receivedAt, 1_000);
  assert.equal(entries[0].updatedAt, 2_000);
});

test('electron command diagnostics: retention is bounded by count and time', () => {
  const now = 10_000_000;
  let entries: Array<Record<string, unknown>> = [];
  for (let i = 0; i < diagnostics.MAX_ITEMS + 7; i += 1) {
    entries = diagnostics.mergeCommandDiagnostic(entries, {
      key: i.toString(16).padStart(8, '0'),
      type: 'browse.next',
      stage: 'dispatched',
      summary: '浏览下一条内容',
    }, now + i);
  }
  assert.equal(entries.length, diagnostics.MAX_ITEMS);

  entries.push({
    key: 'ffffffff', type: 'browse.next', stage: 'received', summary: '过期',
    receivedAt: now - diagnostics.RETENTION_MS - 1,
    updatedAt: now - diagnostics.RETENTION_MS - 1,
  });
  const pruned = diagnostics.pruneCommandDiagnostics(entries, now + diagnostics.MAX_ITEMS);
  assert.equal(pruned.some((entry) => entry.key === 'ffffffff'), false);
});

test('electron command diagnostics: raw structured JSON is reduced to a fixed safe trace', () => {
  const event = diagnostics.parseCommandDiagnosticLine(line({
    key: '1234abcd', type: 'interaction.reply.send', stage: 'rejected', summary: 'secret-summary', reason: 'payload_invalid',
  }), 1_000);
  const trace = diagnostics.commandDiagnosticTraceLine(event);
  assert.equal(trace, '[command-diagnostic] interaction.reply.send rejected');
  assert.equal(trace.includes('secret-summary'), false);

  const main = readFileSync(new URL('../../src/electron/main.cjs', import.meta.url), 'utf8');
  const branchStart = main.indexOf('if (message.startsWith(commandDiagnostics.PREFIX))');
  const proxyBranch = main.indexOf('// 代理运行事件带当前公网 IP', branchStart);
  const branch = main.slice(branchStart, proxyBranch);
  assert.ok(branchStart > 0 && proxyBranch > branchStart);
  assert.match(branch, /parseCommandDiagnosticLine\(message, receivedAt\)/);
  assert.match(branch, /appendEdgeLog\(handle\.envId, trace, isError\)/);
  assert.doesNotMatch(branch, /appendEdgeLog\(handle\.envId, message/);
  assert.match(branch, /return;/);
});
