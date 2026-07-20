#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';

const execFileAsync = promisify(execFile);
const requested = Number(process.argv[2] || 12);
const coreCount = Number.isInteger(requested) && requested > 0 && requested <= 64 ? requested : 12;
const children = [];
const connectedEdges = new Set();
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
const terminateChildren = () => {
  for (const child of children) {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
  }
};
process.once('exit', terminateChildren);
process.once('SIGINT', () => {
  terminateChildren();
  process.exit(130);
});

await once(wss, 'listening');
const address = wss.address();
if (!address || typeof address === 'string') throw new Error('mock Cloud did not bind a TCP port');

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let envelope;
    try { envelope = JSON.parse(String(raw)); } catch { return; }
    if (envelope.type === 'hello') {
      connectedEdges.add(String(envelope.payload?.edgeId || ''));
      socket.send(JSON.stringify({
        v: 2,
        type: 'welcome',
        id: envelope.id,
        ts: Date.now(),
        payload: {
          sessionId: `memory-${envelope.payload?.edgeId}`,
          serverVersion: 'memory-probe',
          capabilities: ['client_core_browser_executor_v1'],
        },
      }));
      return;
    }
    if (envelope.type === 'ping') {
      socket.send(JSON.stringify({ v: 2, type: 'pong', id: envelope.id, ts: Date.now(), payload: {} }));
    }
  });
});

const cloudUrl = `ws://127.0.0.1:${address.port}`;
for (let index = 0; index < coreCount; index += 1) {
  const envKey = `memory-env-${index + 1}`;
  children.push(spawn(process.execPath, ['dist/src/main.js'], {
    cwd: process.cwd(),
    stdio: process.env.AIDCP_MEMORY_PROBE_DEBUG === '1' ? 'inherit' : 'ignore',
    env: {
      ...process.env,
      AIDCP_CLOUD_URL: cloudUrl,
      AIDCP_EDGE_ID: `ads-${envKey}`,
      AIDCP_ENV_KEY: envKey,
      AIDCP_ADS_USER_ID: envKey,
      AIDCP_PLATFORM: 'xiaohongshu',
      AIDCP_BROWSER_PROVIDER: 'adspower',
      AIDCP_START_BROWSER_ABSENT: '1',
      AIDCP_CONTROL_ACCOUNT_ID: `memory-account-${index + 1}`,
      AIDCP_AUTO_BROWSE: 'false',
    },
  }));
}

const startedAt = Date.now();
while (connectedEdges.size < coreCount && Date.now() - startedAt < 20_000) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (connectedEdges.size !== coreCount) {
  throw new Error(`only ${connectedEdges.size}/${coreCount} browserless cores completed hello`);
}
await new Promise((resolve) => setTimeout(resolve, 1_500));

const pids = children.map((child) => child.pid).filter(Boolean);
const { stdout } = await execFileAsync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')]);
const rows = stdout.trim().split('\n').map((line) => {
  const [pid, rssKiB] = line.trim().split(/\s+/).map(Number);
  return { pid, rssMiB: rssKiB / 1024 };
}).filter((row) => Number.isFinite(row.rssMiB));
const totalRssMiB = rows.reduce((sum, row) => sum + row.rssMiB, 0);
const averageRssMiB = rows.length ? totalRssMiB / rows.length : 0;
const maxRssMiB = rows.length ? Math.max(...rows.map((row) => row.rssMiB)) : 0;
// Acceptance ceiling is intentionally independent of browser slots. 160 MiB/core keeps a 12-core
// control fleet below 1.9 GiB on the supported desktop while a single headful browser is budgeted
// separately at roughly 700 MiB. Exceeding this fails the measurement; it never reduces core count.
const thresholds = { averageRssMiB: 160, maxRssMiB: 180, totalRssMiB: coreCount * 160 };
const passed = rows.length === coreCount
  && averageRssMiB <= thresholds.averageRssMiB
  && maxRssMiB <= thresholds.maxRssMiB
  && totalRssMiB <= thresholds.totalRssMiB;

console.log(JSON.stringify({
  cores: coreCount,
  connected: connectedEdges.size,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  browserProcessesStarted: 0,
  totalRssMiB: Number(totalRssMiB.toFixed(1)),
  averageRssMiB: Number(averageRssMiB.toFixed(1)),
  maxRssMiB: Number(maxRssMiB.toFixed(1)),
  thresholds,
  passed,
}));

terminateChildren();
await Promise.all(children.map((child) => once(child, 'exit').catch(() => undefined)));
await new Promise((resolve) => wss.close(resolve));
if (!passed) process.exitCode = 1;
