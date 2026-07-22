import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MARKER_NAME = '.aidcp-electron-dev-signature.json';

export const APPROVED_UNSIGNED_ELECTRON_HASHES = Object.freeze({
  '31.7.7': Object.freeze([
    // Official electron-v31.7.7-darwin-arm64.zip executable.
    'ad7527eeeef19f3f1526ff5d9580b7a1635d16b014098021567ede866b7908e5',
    // Official electron-v31.7.7-darwin-x64.zip executable.
    '96eb53e6bd6c41ac080d2f330742020206109df3403069a2d593beba731c4fa2',
  ]),
});

export const APPROVED_LOCAL_ELECTRON_SIGNATURES = Object.freeze({
  '31.7.7': Object.freeze([
    Object.freeze({
      originalExecutableSha256: 'ad7527eeeef19f3f1526ff5d9580b7a1635d16b014098021567ede866b7908e5',
      signedExecutableSha256: 'c5b6fdf77f91aab146357c7f9e5e0bdd6d8625122286a68cde46fd8b4e75c51e',
      codeResourcesSha256: '936be4fc4466b2bea0f367044ad716bcd3092a618482a573e360b14164864a64',
    }),
    Object.freeze({
      originalExecutableSha256: '96eb53e6bd6c41ac080d2f330742020206109df3403069a2d593beba731c4fa2',
      signedExecutableSha256: '50a03bb1da0f8664def25cc747e1414020697948bd255f651c90a8686fc3e963',
      codeResourcesSha256: '0758cf7f30b0666b95a58509342ca335948f4d8b276154cf3418637ef3aa16d0',
    }),
  ]),
});

function defaultRun(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: options.quiet ? 'ignore' : ['ignore', 'pipe', 'pipe'],
  });
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function commandSucceeds(run, command, args) {
  try {
    run(command, args, { quiet: true });
    return true;
  } catch {
    return false;
  }
}

function readMarker(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeMarker(path, marker) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function ensureElectronDevSignature(projectRoot, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return { status: 'skipped-platform' };

  const root = resolve(projectRoot);
  const electronRoot = join(root, 'node_modules', 'electron');
  const appPath = join(electronRoot, 'dist', 'Electron.app');
  const executablePath = join(appPath, 'Contents', 'MacOS', 'Electron');
  const codeResourcesPath = join(appPath, 'Contents', '_CodeSignature', 'CodeResources');
  const packagePath = join(electronRoot, 'package.json');
  const markerPath = join(electronRoot, MARKER_NAME);
  if (!existsSync(executablePath) || !existsSync(packagePath)) {
    return { status: 'skipped-missing', appPath };
  }

  const run = options.run ?? defaultRun;
  const approvedHashes = options.approvedHashes ?? APPROVED_UNSIGNED_ELECTRON_HASHES;
  const approvedLocalSignatures = options.approvedLocalSignatures ?? APPROVED_LOCAL_ELECTRON_SIGNATURES;
  const version = JSON.parse(readFileSync(packagePath, 'utf8')).version;
  const executableHash = sha256File(executablePath);
  const signatureValid = commandSucceeds(
    run,
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', appPath],
  );

  if (signatureValid) {
    const marker = readMarker(markerPath);
    const codeResourcesHash = existsSync(codeResourcesPath) ? sha256File(codeResourcesPath) : null;
    const markerOriginalHashAllowed = (approvedHashes[version] ?? []).includes(
      marker?.originalExecutableSha256,
    );
    if (
      marker?.schemaVersion === 1 &&
      marker.version === version &&
      markerOriginalHashAllowed &&
      marker.signedExecutableSha256 === executableHash &&
      marker.signedCodeResourcesSha256 === codeResourcesHash
    ) {
      return { status: 'already-signed-local', appPath, version, executableHash };
    }

    const recognizedLocalSignature = (approvedLocalSignatures[version] ?? []).find(
      (candidate) =>
        candidate.signedExecutableSha256 === executableHash &&
        candidate.codeResourcesSha256 === codeResourcesHash &&
        (approvedHashes[version] ?? []).includes(candidate.originalExecutableSha256),
    );
    if (recognizedLocalSignature) {
      writeMarker(markerPath, {
        schemaVersion: 1,
        version,
        originalExecutableSha256: recognizedLocalSignature.originalExecutableSha256,
        signedExecutableSha256: executableHash,
        signedCodeResourcesSha256: codeResourcesHash,
      });
      return { status: 'adopted-local-signature', appPath, version, executableHash };
    }

    if (commandSucceeds(run, '/usr/sbin/spctl', ['--assess', '--type', 'execute', appPath])) {
      return { status: 'already-trusted', appPath, version, executableHash };
    }

    throw new Error(
      `Refusing to replace an unrecognized valid Electron signature at ${appPath}. ` +
      'Reinstall this worktree with npm ci before retrying.',
    );
  }

  const allowedForVersion = approvedHashes[version] ?? [];
  if (!allowedForVersion.includes(executableHash)) {
    throw new Error(
      `Refusing to sign Electron ${version} at ${appPath}: executable SHA-256 ${executableHash} ` +
      'is not in the repository allowlist. Reinstall with npm ci or review the new Electron release first.',
    );
  }

  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { quiet: true });

  const signedExecutableHash = sha256File(executablePath);
  const signedCodeResourcesHash = sha256File(codeResourcesPath);
  writeMarker(markerPath, {
    schemaVersion: 1,
    version,
    originalExecutableSha256: executableHash,
    signedExecutableSha256: signedExecutableHash,
    signedCodeResourcesSha256: signedCodeResourcesHash,
  });

  return {
    status: 'signed-local',
    appPath,
    version,
    originalExecutableHash: executableHash,
    executableHash: signedExecutableHash,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectRoot = process.env.AIDCP_ELECTRON_PROJECT_ROOT || resolve(here, '..');
  const result = ensureElectronDevSignature(projectRoot);
  const messages = {
    'skipped-platform': 'Electron development signing skipped: host is not macOS.',
    'skipped-missing': 'Electron development signing skipped: Electron.app is not installed.',
    'already-signed-local': `Electron ${result.version} already has a valid local development signature.`,
    'adopted-local-signature': `Electron ${result.version} existing local development signature was verified.`,
    'already-trusted': `Electron ${result.version} already passes Gatekeeper; its signature was preserved.`,
    'signed-local': `Electron ${result.version} received a verified local development signature.`,
  };
  console.log(messages[result.status] ?? `Electron development signing result: ${result.status}`);
}
