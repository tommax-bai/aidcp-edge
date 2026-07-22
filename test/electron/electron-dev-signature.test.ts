import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const scriptUrl = pathToFileURL(join(process.cwd(), 'scripts/ensure-electron-dev-signature.mjs')).href;
const signer = await import(scriptUrl) as {
  ensureElectronDevSignature: (
    root: string,
    options: {
      platform: string;
      approvedHashes?: Record<string, readonly string[]>;
      run?: (command: string, args: string[], options?: { quiet?: boolean }) => string;
    },
  ) => { status: string };
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeFixture(executable = 'official-electron-binary'): {
  root: string;
  appPath: string;
  executablePath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'aidcp-electron-sign-'));
  const electronRoot = join(root, 'node_modules', 'electron');
  const appPath = join(electronRoot, 'dist', 'Electron.app');
  const executablePath = join(appPath, 'Contents', 'MacOS', 'Electron');
  mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(electronRoot, 'package.json'), JSON.stringify({ version: '31.7.7' }));
  writeFileSync(executablePath, executable);
  return { root, appPath, executablePath };
}

test('non-macOS installs are a no-op', () => {
  const result = signer.ensureElectronDevSignature('/missing', { platform: 'linux' });
  assert.equal(result.status, 'skipped-platform');
});

test('known official Electron is locally signed and then skipped idempotently', () => {
  const fixture = makeFixture();
  let signed = false;
  const calls: string[] = [];
  const run = (command: string, args: string[]): string => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command.endsWith('codesign') && args[0] === '--verify' && !signed) {
      throw new Error('unsigned');
    }
    if (command.endsWith('codesign') && args[0] === '--force') {
      signed = true;
      writeFileSync(fixture.executablePath, 'locally-signed-electron-binary');
    }
    return '';
  };

  try {
    const approvedHashes = { '31.7.7': [sha256('official-electron-binary')] };
    const first = signer.ensureElectronDevSignature(fixture.root, {
      platform: 'darwin', approvedHashes, run,
    });
    assert.equal(first.status, 'signed-local');
    assert.ok(calls.some((call) => call.includes('--force --deep --sign -')));

    const marker = JSON.parse(readFileSync(
      join(fixture.root, 'node_modules', 'electron', '.aidcp-electron-dev-signature.json'),
      'utf8',
    ));
    assert.equal(marker.originalExecutableSha256, sha256('official-electron-binary'));
    assert.equal(marker.signedExecutableSha256, sha256('locally-signed-electron-binary'));

    calls.length = 0;
    const second = signer.ensureElectronDevSignature(fixture.root, {
      platform: 'darwin', approvedHashes, run,
    });
    assert.equal(second.status, 'already-signed-local');
    assert.ok(!calls.some((call) => call.includes('--force --deep --sign -')));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('unexpected Electron bytes are never signed', () => {
  const fixture = makeFixture('modified-electron-binary');
  const calls: string[] = [];
  const run = (command: string, args: string[]): string => {
    calls.push(`${command} ${args.join(' ')}`);
    throw new Error('unsigned');
  };

  try {
    assert.throws(
      () => signer.ensureElectronDevSignature(fixture.root, {
        platform: 'darwin',
        approvedHashes: { '31.7.7': [sha256('official-electron-binary')] },
        run,
      }),
      /not in the repository allowlist/,
    );
    assert.ok(!calls.some((call) => call.includes('--force --deep --sign -')));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a valid unrecognized signature is preserved and rejected', () => {
  const fixture = makeFixture();
  const calls: string[] = [];
  const run = (command: string, args: string[]): string => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command.endsWith('spctl')) throw new Error('not trusted');
    return '';
  };

  try {
    assert.throws(
      () => signer.ensureElectronDevSignature(fixture.root, { platform: 'darwin', run }),
      /unrecognized valid Electron signature/,
    );
    assert.ok(!calls.some((call) => call.includes('--force --deep --sign -')));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
