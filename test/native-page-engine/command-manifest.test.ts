import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CLOUD_OPERATION_REGISTRY } from '../../src/client/operation-registry.js';

interface ManifestCommand {
  routeKey: string;
  edgeType: string;
  publishKind?: string;
  nativeKind: string;
  family: string;
  requestContract: string;
  receipts: string[];
  effect: string;
  cancellation: string;
}

interface SessionControl {
  edgeType: string;
  nativeKind: string;
  requestContract: string;
  receipt: string | null;
}

interface CommandManifest {
  schemaVersion: number;
  protocolVersion: number;
  platforms: Array<{ platform: string; adapterVersion: string; identityCommands: string[] }>;
  duplicatePolicy: string;
  commands: ManifestCommand[];
  sessionControls: SessionControl[];
}

const manifestPath = fileURLToPath(
  new URL('../../native/page-engine/command-manifest.json', import.meta.url),
);

async function loadManifest(): Promise<CommandManifest> {
  return JSON.parse(await readFile(manifestPath, 'utf8')) as CommandManifest;
}

const platformSpecificExclusions = new Set([
  // Facebook-only page command; it must remain isolated from the XHS engine.
  'group.join',
  // Protocol tombstone only: no Edge handler or packaged whole-publish implementation remains.
  'publish.request',
]);

test('freezes every registered XHS page-automation route', async () => {
  const manifest = await loadManifest();
  const manifestTypes = new Set([
    ...manifest.commands.map((command) => command.edgeType),
    ...manifest.sessionControls.map((control) => control.edgeType),
  ]);
  const registeredXhsRoutes = Object.entries(CLOUD_OPERATION_REGISTRY)
    .filter(([type, descriptor]) => (
      descriptor.category === 'page_automation' && !platformSpecificExclusions.has(type)
    ))
    .map(([type]) => type)
    .sort();

  assert.deepEqual(
    registeredXhsRoutes.filter((type) => !manifestTypes.has(type)),
    [],
    'every registered XHS page route must have a Native command or lifecycle mapping',
  );
});

test('freezes every publish.command kind exactly once', async () => {
  const manifest = await loadManifest();
  const kinds = manifest.commands
    .filter((command) => command.edgeType === 'publish.command')
    .map((command) => command.publishKind)
    .sort();

  assert.deepEqual(kinds, [
    'add_with_candidate',
    'capture_postId',
    'capture_scheduled',
    'fill_field',
    'navigate_entry',
    'reconcile_scheduled',
    'select_mode',
    'set_cover',
    'set_option',
    'set_schedule',
    'submit_publish',
    'upload_image',
  ]);
});

test('manifest route and Native command identities are unique and bounded', async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.protocolVersion, 2);
  assert.deepEqual(manifest.platforms, [
    {
      platform: 'xiaohongshu',
      adapterVersion: 'xiaohongshu-v1',
      identityCommands: ['identity_read_self_profile'],
    },
    {
      platform: 'facebook',
      adapterVersion: 'facebook-v1',
      identityCommands: ['identity_bootstrap', 'identity_read_current'],
    },
    {
      platform: 'wechat_channels',
      adapterVersion: 'wechat-channels-v1',
      identityCommands: [],
    },
  ]);

  const routeKeys = manifest.commands.map((command) => command.routeKey);
  const nativeKinds = [
    ...manifest.commands.map((command) => command.nativeKind),
    ...manifest.sessionControls.map((control) => control.nativeKind),
  ];
  assert.equal(new Set(routeKeys).size, routeKeys.length);
  assert.equal(new Set(nativeKinds).size, nativeKinds.length);
  for (const command of manifest.commands) {
    assert.ok(command.requestContract.length > 0);
    assert.ok(command.cancellation.length > 0);
    assert.ok(command.effect.length > 0);
    assert.ok(command.nativeKind.length <= 64);
  }
});
