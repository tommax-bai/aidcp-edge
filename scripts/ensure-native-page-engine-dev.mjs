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

  // 5.3：verify 已由源码摘要决定成败（build-native-page-engine.mjs 的 sourceDigest），
  // 所以这条分支现在同时覆盖「产物缺失」与「源码改了但没重建」。
  // 判定理由必须原样带出来，MUST NOT 把「为什么要重建」吞掉。
  const reason = String(verify.stderr || '').trim()
    || (verify.error ? String(verify.error.message || verify.error) : '')
    || 'verification exited non-zero without a message';
  write(`Native Page Engine ${platform}-${arch} artifact is missing or stale; rebuilding. Reason: ${reason}\n`);
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
