import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * Native 写命令的后置校验盘点门禁（change restore-native-actuation-humanization-and-locating，
 * 任务 5.6 / 5.11）。
 *
 * 为什么要有它：规格里「每一条写命令都必须校验其效果」这条保证，在这份盘点存在之前
 * **没有任何人说得清每条命令落在线的哪一侧**。而「没列出的命令会被读成已覆盖」——
 * 一份靠人维护的散文清单必然漏，漏掉的那条正好是最该被看见的那条。
 *
 * 所以判据是**机械派生的**：写命令集合从引擎自己的命令类型（`may_write` 的补集）推出来，
 * 与登记表做**恰好相等**的断言。新增一条写命令而不给它分类，这里当场失败。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type Entry = { nativeKind: string; status: string; evidence: string };
type Registry = { unreadBudget: number; commands: Entry[]; invariants: string[] };

const STATUSES = new Set(['confirmed', 'below_bar', 'not_applicable', 'unread']);

const registry = JSON.parse(
  await readFile(resolve(repoRoot, 'native/page-engine/command-postconditions.json'), 'utf8'),
) as Registry;

const commandSource = await readFile(resolve(repoRoot, 'native/page-engine/src/command.rs'), 'utf8');

/** 从引擎自己的命令类型派生「写命令」集合：全部命令 − `may_write` 里点名的只读命令。 */
function writeCommandsFromEngine(): string[] {
  const variantToKind = new Map(
    Array.from(commandSource.matchAll(/(\w+)\(\w+\) => "(\w+)"/g), (hit) => [hit[1], hit[2]] as const),
  );
  assert.ok(
    variantToKind.size > 30,
    `命令种类只解析出 ${variantToKind.size} 条，正则大概率已经失配 —— 此处 MUST 响亮失败，`
      + '绝不能退化成「空集 == 空集」恒真',
  );

  const readOnlyBlock = commandSource.match(/command => !matches!\(\s*command,([\s\S]*?)\),\s*\}/);
  assert.ok(readOnlyBlock, '`may_write` 的只读命令名单没解析出来');
  const readOnly = new Set(Array.from(readOnlyBlock[1].matchAll(/Self::(\w+)\(_\)/g), (hit) => hit[1]));
  assert.ok(readOnly.size > 0, '只读名单解析成了空集：那会把每条命令都当成写命令，判据反而变松');

  return [...variantToKind].filter(([variant]) => !readOnly.has(variant)).map(([, kind]) => kind);
}

test('5.6 盘点恰好覆盖引擎的全部写命令 —— 不多一条，不少一条', () => {
  const engine = writeCommandsFromEngine();
  const listed = registry.commands.map((entry) => entry.nativeKind);

  assert.deepEqual(
    [...listed].sort(),
    [...engine].sort(),
    '登记表与引擎的写命令集合对不上。**少一条比多一条危险**：没列出的命令会被读成已覆盖',
  );
  assert.equal(new Set(listed).size, listed.length, '同一条命令登记了两次，两条会互相盖过对方');
});

test('5.6 每一条都有分类与理由，四种状态之外不许新造', () => {
  for (const entry of registry.commands) {
    assert.ok(
      STATUSES.has(entry.status),
      `${entry.nativeKind} 的状态 "${entry.status}" 不在四种之内 —— 新造一档等于绕开这张表`,
    );
    assert.ok(
      entry.evidence.trim().length > 0,
      `${entry.nativeKind} 没写判据 / 理由。空理由的登记只是把问题换了个地方放`,
    );
  }
});

test('5.11 未读是单调棘轮：只许下降', () => {
  const unread = registry.commands.filter((entry) => entry.status === 'unread');
  assert.ok(
    unread.length <= registry.unreadBudget,
    `未读 ${unread.length} 条，超过预算 ${registry.unreadBudget} —— 这个数字只许下降。`
      + '新增写命令的默认归宿**不是** unread：不当场分类，这张表就退化成一个永远填不完的许愿单',
  );
  // 预算跟着实际值一起降，否则削减之后会留出空位给新的未读回填（棘轮的经典失效方式）。
  assert.equal(
    registry.unreadBudget,
    unread.length,
    '预算与实际未读数必须相等：留出空位就等于允许新的未读悄悄补进来',
  );
});

test('5.11 「不达标」与「未读」都必须写清差在哪 —— 它们不构成「有校验」', () => {
  for (const entry of registry.commands.filter((e) => e.status === 'below_bar')) {
    assert.ok(
      /自证|不能|无法|不够|差|须|MUST/.test(entry.evidence),
      `${entry.nativeKind} 标成 below_bar 却没说清差在哪 —— 那和标成 confirmed 没有区别`,
    );
  }
  for (const entry of registry.commands.filter((e) => e.status === 'not_applicable')) {
    assert.ok(
      /不得|MUST NOT/.test(entry.evidence),
      `${entry.nativeKind} 标成 not_applicable 却没写明「不得因此默认成功」`,
    );
  }
});

test('5.6 本 change 亲手落的那几条确实在表里、且标成达标', () => {
  // 反向对照：上面三条查的都是「结构完整」，全部满足的空表同样能过。
  // 这一条钉住几个**已知达标**的具体命令，防这张表被整体降级成一片 unread 之后还全绿。
  const byKind = new Map(registry.commands.map((entry) => [entry.nativeKind, entry]));
  for (const kind of ['interaction_comment', 'publish_fill_field', 'note_scroll_comments']) {
    assert.equal(byKind.get(kind)?.status, 'confirmed', `${kind} 的后置判据本轮已达标，不该被降级`);
  }
});
