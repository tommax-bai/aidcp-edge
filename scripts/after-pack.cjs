'use strict';

const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

function resolvePackagedSmokePaths(context) {
  const platform = context.electronPlatformName;
  const productFilename = context.packager.appInfo.productFilename;
  const appOutDir = context.appOutDir;

  if (platform === 'darwin') {
    const appRoot = join(appOutDir, `${productFilename}.app`, 'Contents');
    return {
      executable: join(appRoot, 'MacOS', productFilename),
      smokeEntry: join(appRoot, 'Resources', 'app.asar', 'src', 'electron', 'packaged-runtime-smoke.cjs'),
    };
  }
  if (platform === 'win32') {
    return {
      executable: join(appOutDir, `${productFilename}.exe`),
      smokeEntry: join(appOutDir, 'resources', 'app.asar', 'src', 'electron', 'packaged-runtime-smoke.cjs'),
    };
  }
  return {
    executable: join(appOutDir, productFilename),
    smokeEntry: join(appOutDir, 'resources', 'app.asar', 'src', 'electron', 'packaged-runtime-smoke.cjs'),
  };
}

async function afterPack(context) {
  const { executable, smokeEntry } = resolvePackagedSmokePaths(context);
  const output = execFileSync(executable, [smokeEntry], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 30_000,
  });
  process.stdout.write(output);
}

module.exports = afterPack;
module.exports.resolvePackagedSmokePaths = resolvePackagedSmokePaths;
