import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
type BootstrapResult = { status: 'verified' | 'rebuilt'; platform: string; arch: string };
type BootstrapOptions = {
  platform: string;
  arch: string;
  write: (message: string) => unknown;
  run: (command: string, args: string[]) => { status: number; stdout?: string; stderr?: string };
};
const bootstrap = await import(
  pathToFileURL(resolve(root, 'scripts/ensure-native-page-engine-dev.mjs')).href
) as {
  ensureNativePageEngineDev: (projectRoot: string, options: BootstrapOptions) => BootstrapResult;
};
const { ensureNativePageEngineDev } = bootstrap;

test('development bootstrap accepts a current architecture-matched artifact without rebuilding', () => {
  const calls: string[][] = [];
  const output: string[] = [];
  const result = ensureNativePageEngineDev(root, {
    platform: 'darwin',
    arch: 'arm64',
    write: (message: string) => output.push(message),
    run: (_command: string, args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: 'OK: verified\n' };
    },
  });
  assert.deepEqual(result, { status: 'verified', platform: 'darwin', arch: 'arm64' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.slice(-3), ['--verify', '--target-arch', 'arm64']);
  assert.deepEqual(output, ['OK: verified\n']);
});

test('development bootstrap rebuilds the current architecture when verification fails', () => {
  const calls: string[][] = [];
  const output: string[] = [];
  const result = ensureNativePageEngineDev(root, {
    platform: 'darwin',
    arch: 'arm64',
    write: (message: string) => output.push(message),
    run: (_command: string, args: string[]) => {
      calls.push(args);
      return calls.length === 1
        ? { status: 1, stderr: 'ENOENT' }
        : { status: 0 };
    },
  });
  assert.deepEqual(result, { status: 'rebuilt', platform: 'darwin', arch: 'arm64' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.slice(-3), ['--verify', '--target-arch', 'arm64']);
  assert.deepEqual(calls[1]?.slice(-2), ['--target-arch', 'arm64']);
  assert.match(output.join(''), /missing or stale; rebuilding/);
});

test('development bootstrap fails closed when the required rebuild fails', () => {
  let calls = 0;
  assert.throws(
    () => ensureNativePageEngineDev(root, {
      platform: 'win32',
      arch: 'x64',
      write: () => undefined,
      run: () => ({ status: ++calls === 1 ? 1 : 101 }),
    }),
    /development build failed with status 101/,
  );
});
