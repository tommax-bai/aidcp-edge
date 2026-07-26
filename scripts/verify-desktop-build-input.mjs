import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function verifyDesktopBuildInput(projectRoot) {
  const root = resolve(projectRoot);
  const nodeModules = join(root, 'node_modules');
  const nestedNodeModules = join(nodeModules, 'node_modules');

  if (existsSync(nestedNodeModules)) {
    const kind = lstatSync(nestedNodeModules).isSymbolicLink() ? 'symbolic link' : 'path';
    let target = nestedNodeModules;
    try {
      target = realpathSync(nestedNodeModules);
    } catch {
      // The path itself is enough evidence to reject a contaminated build input.
    }
    throw new Error(
      `Refusing desktop build: unexpected ${kind} ${nestedNodeModules} resolves to ${target}. ` +
      'Recreate this worktree dependency directory with npm ci before packaging.',
    );
  }

  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const packagedInputs = JSON.stringify(packageJson.build?.files ?? []);
  if (/native[\\/]page-engine|facebook-router/i.test(packagedInputs)) {
    throw new Error('Refusing desktop build: Facebook router source is included in ASAR inputs.');
  }

  const requireFromProject = createRequire(join(root, 'package.json'));
  const { CookieJar, JSDOM } = requireFromProject('jsdom');
  requireFromProject('tough-cookie');
  const WebSocket = requireFromProject('ws');
  const dom = new JSDOM('<main id="desktop-build-smoke">ok</main>', {
    cookieJar: new CookieJar(),
    url: 'https://desktop-build-smoke.invalid/',
  });

  if (dom.window.document.querySelector('#desktop-build-smoke')?.textContent !== 'ok') {
    throw new Error('Refusing desktop build: jsdom runtime smoke check failed.');
  }
  dom.window.close();
  if (typeof WebSocket !== 'function') {
    throw new Error('Refusing desktop build: ws runtime export is unavailable.');
  }

  return { nodeModules };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectRoot = process.env.AIDCP_DESKTOP_PROJECT_ROOT || resolve(here, '..');
  verifyDesktopBuildInput(projectRoot);
  console.log('Desktop build input verified: production dependency tree is loadable.');
}
