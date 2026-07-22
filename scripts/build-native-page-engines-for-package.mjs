import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = resolve(fileURLToPath(new URL('./build-native-page-engine.mjs', import.meta.url)));
const requested = process.argv.slice(2);
const arches = requested.length > 0
  ? requested
  : process.platform === 'darwin'
    ? ['x64', 'arm64']
    : process.platform === 'win32'
      ? ['x64']
      : [];

if (arches.length === 0) {
  throw new Error(`Native Page Engine packaging is unsupported on ${process.platform}`);
}
for (const arch of arches) {
  const outcome = spawnSync(process.execPath, [script, '--target-arch', arch], {
    cwd: resolve(fileURLToPath(new URL('..', import.meta.url))),
    stdio: 'inherit',
    env: process.env,
  });
  if (outcome.error) throw outcome.error;
  if (outcome.status !== 0) {
    throw new Error(`Native Page Engine ${process.platform}-${arch} build failed with status ${outcome.status}`);
  }
}
