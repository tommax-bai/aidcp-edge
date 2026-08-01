import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  NativePageNotificationUnread,
  NativePageProbeResult,
} from '../../src/native-page-engine/client.js';

// 跨语言契约夹具的 **TypeScript 侧**（change enforce-native-engine-artifact-gates 2.5）。
//
// 同一份夹具 native/page-engine/tests/fixtures/page-probe-contracts.json 已经被 Rust 侧
// （native/page-engine/tests/contract_fixtures.rs）回放，并断言它的 `sourceContract` 字段
// 等于 "src/native-page-engine/client.ts#NativePageProbeResult"。
//
// 但那条断言是**纯字符串比对**：它证明夹具自称对着哪份契约，证明不了那份契约还在、
// 更证明不了 TypeScript 侧真按它消费。实测全仓对这份夹具的 TS 引用为零 ——
// 于是把 client.ts 里的类型改名 / 改字段，Rust 侧照样全绿，「跨语言契约」名存实亡。
//
// 本文件补上缺的那一半，两条互补的耦合：
// ① **编译期**：`import type` + 逐字段消费。类型改名 → import 失败；字段改名 → 消费处失败。
//    这一条只在 `npm run typecheck` 里生效（tsx 只剥类型、不做类型检查）。
// ② **运行期**：按夹具自己写的 `sourceContract` 去被指名的文件里找那个标识符的声明。
//    这一条在 `npm test` 里生效，改名当场红。
//
// 验收口径见本 change 2.5：把 client.ts 里该类型改名后，本用例必须失败，
// 而 Rust 侧的字符串比对此时仍绿。

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturePath = join(repoRoot, 'native/page-engine/tests/fixtures/page-probe-contracts.json');

interface FixtureCase {
  name: string;
  command: { kind: string; params: unknown };
  targetId: string;
  signals: Record<string, unknown>;
  expected: Record<string, unknown>;
}

interface FixtureFile {
  schemaVersion: number;
  sourceContract: string;
  cases: FixtureCase[];
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as FixtureFile;

/**
 * 未读读数的三态解析，与生产解析同口径：缺失 / 结构不对 / 取值不认识一律「读不到」。
 * MUST NOT 回落成 `clear` —— 那等于把一次读取失败静默说成「已清零」。
 * Rust 侧对 unreadable 用了 `skip_serializing_if`，所以夹具里这个字段就是缺席的；
 * 本函数把「缺席」解释成什么，正是这条跨语言契约里最容易被悄悄改错的一处。
 */
function parseNotificationUnread(value: unknown): NativePageNotificationUnread {
  if (typeof value !== 'object' || value === null) return { state: 'unreadable', count: 0 };
  const record = value as Record<string, unknown>;
  const count = typeof record.count === 'number' && Number.isInteger(record.count)
    ? record.count
    : 0;
  if (record.state === 'unread') return { state: 'unread', count };
  if (record.state === 'clear') return { state: 'clear', count: 0 };
  return { state: 'unreadable', count: 0 };
}

/** 把一条 `expected` 按探针结果契约消费成强类型值；不合契约即抛。 */
function asProbeResult(name: string, value: Record<string, unknown>): NativePageProbeResult {
  const signals = value.signals;
  assert.ok(
    typeof signals === 'object' && signals !== null,
    `${name}: expected.signals must be an object`,
  );
  for (const key of ['targetId', 'origin', 'path', 'readyState', 'pageKind'] as const) {
    assert.equal(typeof value[key], 'string', `${name}: expected.${key} must be a string`);
  }
  return {
    ...value,
    notificationUnread: parseNotificationUnread(value.notificationUnread),
  } as unknown as NativePageProbeResult;
}

/**
 * 逐字段消费探针结果 —— 编译期耦合就落在这里。
 * 契约里任何一个字段被改名 / 删除，这个函数体立刻编译失败；
 * 若只写 `result as unknown as T` 之类的强转，改名什么都不会发生。
 */
function projectProbeResult(result: NativePageProbeResult): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    targetId: result.targetId,
    origin: result.origin,
    path: result.path,
    readyState: result.readyState,
    pageKind: result.pageKind,
    signals: {
      feedCardCount: result.signals.feedCardCount,
      noteDetailCount: result.signals.noteDetailCount,
      loginWallCount: result.signals.loginWallCount,
      captchaSignalCount: result.signals.captchaSignalCount,
      dialogCount: result.signals.dialogCount,
      profileSignalCount: result.signals.profileSignalCount,
      notificationSignalCount: result.signals.notificationSignalCount,
      publishSignalCount: result.signals.publishSignalCount,
      errorSignalCount: result.signals.errorSignalCount,
      mainCount: result.signals.mainCount,
    },
  };
  if (result.blockingKind !== undefined) projected.blockingKind = result.blockingKind;
  if (result.blockingText !== undefined) projected.blockingText = result.blockingText;
  return projected;
}

test('the page-probe contract fixture still names a type that exists in the TypeScript client', () => {
  assert.equal(fixture.schemaVersion, 1);
  const [relativePath, identifier] = fixture.sourceContract.split('#');
  assert.ok(relativePath, 'sourceContract must name a file before "#"');
  assert.ok(identifier, 'sourceContract must name a type after "#"');

  // 运行期耦合：夹具自称对着哪个标识符，那个标识符就必须在被指名的文件里真被声明。
  // 只比对字符串（Rust 侧现状）证明不了这一点 —— 改名后两边都还“自洽”。
  const contractSource = readFileSync(join(repoRoot, relativePath), 'utf8');
  const declaration = new RegExp(
    `^export\\s+(?:interface|type)\\s+${identifier}\\b`,
    'm',
  );
  assert.match(
    contractSource,
    declaration,
    `${relativePath} no longer declares "${identifier}", which the cross-language fixture claims as its source contract`,
  );
});

test('every page-probe contract fixture case is consumable as the TypeScript probe result', () => {
  assert.ok(fixture.cases.length > 0, 'the contract fixture declares no cases');
  for (const fixtureCase of fixture.cases) {
    assert.equal(fixtureCase.command.kind, 'page_probe', fixtureCase.name);
    assert.deepEqual(fixtureCase.command.params, {}, fixtureCase.name);

    const result = asProbeResult(fixtureCase.name, fixtureCase.expected);
    // 逐字段投影后必须逐字还原成夹具里的 expected：Rust 侧写下什么，TS 侧就必须
    // 按同一组字段名读出什么。字段名两侧任一边漂移，这条即红。
    assert.deepEqual(projectProbeResult(result), fixtureCase.expected, fixtureCase.name);

    // 三态红线：Rust 对 unreadable 用 skip_serializing_if，所以夹具里这个字段缺席。
    // 缺席 MUST 解析成「读不到」，MUST NOT 解析成「没有未读」。
    if (fixtureCase.expected.notificationUnread === undefined) {
      assert.deepEqual(
        result.notificationUnread,
        { state: 'unreadable', count: 0 },
        `${fixtureCase.name}: an omitted notificationUnread must decode as unreadable, never as clear`,
      );
    }
  }
});
