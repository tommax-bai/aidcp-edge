'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { binaryArch } = require('./binary-artifact.cjs');

const AIDCP_APP_IDENTIFIER = 'com.aidcp.edge';
const AIDCP_TEAM_IDENTIFIER = 'DK3BYZ9K32';
const CODESIGN_PATH = '/usr/bin/codesign';

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

function commandOutput(result) {
  return `${result?.stdout || ''}\n${result?.stderr || ''}`.trim();
}

function requireSuccessfulCommand(result, label) {
  if (result?.error || result?.status !== 0) {
    throw new Error(`${label} failed`);
  }
  return commandOutput(result);
}

function signatureMetadata(targetPath, run = runCommand) {
  const output = requireSuccessfulCommand(
    run(CODESIGN_PATH, ['-d', '--verbose=4', '-r-', targetPath]),
    `code signature inspection for ${path.basename(targetPath)}`,
  );
  const identifier = output.match(/^Identifier=(.+)$/m)?.[1]?.trim() || '';
  const teamIdentifier = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || '';
  const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim());
  return {
    authorities,
    designatedRequirement: output.match(/^designated => (.+)$/m)?.[1]?.trim() || '',
    identifier,
    teamIdentifier,
  };
}

function verifyCodeSignature(targetPath, {
  deep = false,
  expectedIdentifier,
  expectedTeamIdentifier = AIDCP_TEAM_IDENTIFIER,
  run = runCommand,
} = {}) {
  const verifyArgs = ['--verify'];
  if (deep) verifyArgs.push('--deep');
  verifyArgs.push('--strict', '--verbose=2', targetPath);
  requireSuccessfulCommand(
    run(CODESIGN_PATH, verifyArgs),
    `code signature verification for ${path.basename(targetPath)}`,
  );

  const metadata = signatureMetadata(targetPath, run);
  if (metadata.identifier !== expectedIdentifier) {
    throw new Error(
      `code signature identifier mismatch for ${path.basename(targetPath)}: `
      + `expected ${expectedIdentifier}, got ${metadata.identifier || 'missing'}`,
    );
  }
  if (metadata.teamIdentifier !== expectedTeamIdentifier) {
    throw new Error(
      `code signature Team ID mismatch for ${path.basename(targetPath)}: `
      + `expected ${expectedTeamIdentifier}, got ${metadata.teamIdentifier || 'missing'}`,
    );
  }
  if (!metadata.authorities.some((authority) => authority.startsWith('Developer ID Application:'))
    || !metadata.authorities.includes('Developer ID Certification Authority')
    || !metadata.authorities.includes('Apple Root CA')
    || !metadata.designatedRequirement.includes('anchor apple generic')
    || !metadata.designatedRequirement.includes(`certificate leaf[subject.OU] = ${expectedTeamIdentifier}`)) {
    throw new Error(`Developer ID signature chain is invalid for ${path.basename(targetPath)}`);
  }
  return metadata;
}

function verifySignedMacArtifact(binaryPath, {
  appBundlePath,
  arch,
  identifier,
  run = runCommand,
} = {}) {
  if (!appBundlePath) throw new Error('signed macOS artifact requires an app bundle path');
  const resourcesPath = path.join(appBundlePath, 'Contents', 'Resources');
  const realResourcesPath = fs.realpathSync(resourcesPath);
  const realBinaryPath = fs.realpathSync(binaryPath);
  if (fs.lstatSync(binaryPath).isSymbolicLink()
    || !realBinaryPath.startsWith(`${realResourcesPath}${path.sep}`)) {
    throw new Error(`${path.basename(binaryPath)} escapes the signed app resources directory`);
  }
  fs.accessSync(binaryPath, fs.constants.R_OK | fs.constants.X_OK);

  const appSignature = verifyCodeSignature(appBundlePath, {
    deep: true,
    expectedIdentifier: AIDCP_APP_IDENTIFIER,
    run,
  });
  const artifactSignature = verifyCodeSignature(binaryPath, {
    expectedIdentifier: identifier,
    expectedTeamIdentifier: appSignature.teamIdentifier,
    run,
  });
  const actualArch = binaryArch(fs.readFileSync(binaryPath), 'darwin');
  if (actualArch !== arch) {
    throw new Error(
      `${path.basename(binaryPath)} architecture mismatch: expected ${arch}, got ${actualArch}`,
    );
  }
  return { binaryPath, signature: artifactSignature };
}

module.exports = {
  AIDCP_APP_IDENTIFIER,
  AIDCP_TEAM_IDENTIFIER,
  CODESIGN_PATH,
  commandOutput,
  requireSuccessfulCommand,
  runCommand,
  signatureMetadata,
  verifyCodeSignature,
  verifySignedMacArtifact,
};
