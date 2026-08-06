import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CLOUD_OPERATION_REGISTRY } from '../../src/client/operation-registry.js';

interface ManifestCommand {
  edgeTypes: string[];
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

// 词汇批 4：平台段进命令名后，「哪条命令在哪个平台存在」由 edgeTypes 直接声明，
// 原「FB 独有命令排除清单」（group.join 手抄）随之退役——登记表里每条 page_automation
// 路由都必须能在 manifest 的 edgeTypes 并集里找到归宿，不再有平台例外。
test('freezes every registered page-automation route across platforms', async () => {
  const manifest = await loadManifest();
  const manifestTypes = new Set([
    ...manifest.commands.flatMap((command) => command.edgeTypes),
    ...manifest.sessionControls.map((control) => control.edgeType),
  ]);
  const registeredRoutes = Object.entries(CLOUD_OPERATION_REGISTRY)
    .filter(([, descriptor]) => descriptor.category === 'page_automation')
    .map(([type]) => type)
    .sort();

  assert.deepEqual(
    registeredRoutes.filter((type) => !manifestTypes.has(type)),
    [],
    'every registered page route must have a Native command or lifecycle mapping',
  );
});

test('freezes every publish.command kind exactly once', async () => {
  const manifest = await loadManifest();
  const kinds = manifest.commands
    .filter((command) => command.edgeTypes.includes('publish.command'))
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

  // publish.command 一个信封类型承载多个原子 kind（publishKind 区分）是唯一合法复用；
  // 其余 edgeTypes 不得在两个条目间重复——同一信封映射两个 kind 就是路由歧义。
  const nonPublishEdgeTypes = manifest.commands
    .filter((command) => !command.edgeTypes.includes('publish.command'))
    .flatMap((command) => command.edgeTypes);
  const nativeKinds = [
    ...manifest.commands.map((command) => command.nativeKind),
    ...manifest.sessionControls.map((control) => control.nativeKind),
  ];
  assert.equal(new Set(nonPublishEdgeTypes).size, nonPublishEdgeTypes.length);
  assert.equal(new Set(nativeKinds).size, nativeKinds.length);
  for (const command of manifest.commands) {
    assert.ok(command.requestContract.length > 0);
    assert.ok(command.cancellation.length > 0);
    assert.ok(command.effect.length > 0);
    assert.ok(command.nativeKind.length <= 64);
  }
});
