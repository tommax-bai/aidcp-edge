import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function ensureNativePageEngineDev(projectRoot, options = {}) {
  const root = resolve(projectRoot);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const run = options.run ?? spawnSync;
  const write = options.write ?? ((message) => process.stdout.write(message));
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new Error(`Native Page Engine development is unsupported for ${platform}-${arch}`);
  }

  const builder = resolve(root, 'scripts', 'build-native-page-engine.mjs');
  const verifyArgs = [builder, '--verify', '--target-arch', arch];
  const verify = run(process.execPath, verifyArgs, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
  });
  if (!verify.error && verify.status === 0) {
    const output = String(verify.stdout || '').trim();
    if (output) write(`${output}\n`);
    return { status: 'verified', platform, arch };
  }

  write(`Native Page Engine ${platform}-${arch} artifact is missing or stale; rebuilding.\n`);
  const build = run(process.execPath, [builder, '--target-arch', arch], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (build.error) throw build.error;
  if (build.status !== 0) {
    throw new Error(`Native Page Engine ${platform}-${arch} development build failed with status ${build.status}`);
  }
  return { status: 'rebuilt', platform, arch };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectRoot = process.env.AIDCP_ELECTRON_PROJECT_ROOT || resolve(here, '..');
  ensureNativePageEngineDev(projectRoot);
}
