'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function execFileText(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: 'utf8',
      timeout: 1_000,
      windowsHide: true,
    }, (error, stdout) => resolve(error ? '' : String(stdout || '').trim()));
  });
}

function readRecords(registryPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.processes)) return [];
    return parsed.processes
      .map((record) => ({
        pid: Number(record && record.pid),
        binaryPath: String(record && record.binaryPath || ''),
      }))
      .filter((record) => Number.isInteger(record.pid) && record.pid > 1 && path.isAbsolute(record.binaryPath));
  } catch {
    return [];
  }
}

function writeRecords(registryPath, records) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true, mode: 0o700 });
  const tempPath = `${registryPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify({
    schemaVersion: 1,
    processes: records,
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, registryPath);
}

function commandMatchesBinary(command, binaryPath) {
  const value = String(command || '').trim();
  return value === binaryPath || value.startsWith(`${binaryPath} `);
}

function createProxyChainOrphanRegistry({
  registryPath,
  inspectProcess = (pid) => execFileText('/bin/ps', ['-p', String(pid), '-o', 'command=']),
  killProcess = (pid, signal) => process.kill(pid, signal),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  read = readRecords,
  write = writeRecords,
} = {}) {
  if (!registryPath || !path.isAbsolute(registryPath)) throw new TypeError('absolute registryPath is required');
  const active = new Map();
  let cleanupPromise = null;

  async function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const records = read(registryPath);
      for (const record of records) {
        const command = await inspectProcess(record.pid);
        if (!commandMatchesBinary(command, record.binaryPath)) continue;
        try { killProcess(record.pid, 'SIGTERM'); } catch { /* already gone */ }
        await sleep(100);
        const remaining = await inspectProcess(record.pid);
        if (commandMatchesBinary(remaining, record.binaryPath)) {
          try { killProcess(record.pid, 'SIGKILL'); } catch { /* already gone */ }
          await sleep(25);
          if (commandMatchesBinary(await inspectProcess(record.pid), record.binaryPath)) {
            return { ok: false, reason: 'proxy_chain_orphan_cleanup_failed' };
          }
        }
      }
      write(registryPath, []);
      return { ok: true };
    })().catch(() => ({ ok: false, reason: 'proxy_chain_orphan_cleanup_failed' }));
    return cleanupPromise;
  }

  async function add(pid, binaryPath) {
    if (!Number.isInteger(pid) || pid <= 1 || !path.isAbsolute(binaryPath)) {
      return { ok: false, reason: 'proxy_chain_process_untracked' };
    }
    active.set(pid, { pid, binaryPath });
    try {
      write(registryPath, [...active.values()]);
      return { ok: true };
    } catch {
      active.delete(pid);
      return { ok: false, reason: 'proxy_chain_process_untracked' };
    }
  }

  async function remove(pid) {
    active.delete(Number(pid));
    try {
      write(registryPath, [...active.values()]);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'proxy_chain_registry_write_failed' };
    }
  }

  return { add, cleanup, remove };
}

module.exports = {
  commandMatchesBinary,
  createProxyChainOrphanRegistry,
  readRecords,
  writeRecords,
};
