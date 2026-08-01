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

type Disposition = { kind?: string; action?: string; reason?: string; blockedBy?: string; owner?: string };
type Entry = { nativeKind: string; status: string; evidence: string; disposition?: Disposition };
type Registry = {
  unreadBudget: number;
  belowBarBudget: number;
  commands: Entry[];
  invariants: string[];
};

const STATUSES = new Set(['confirmed', 'below_bar', 'not_applicable', 'unread']);

/**
 * 未读预算的**上限字面量**（change extend-native-postcondition-coverage，任务 1.5）。
 *
 * 「只许下降」这句话，靠单文件断言是查不出来的——测试看不见历史，一个被调高的预算和一个
 * 一直就是这么高的预算长得一模一样。所以把上限钉在**测试这一侧**：调高预算必须同时调高这个
 * 字面量，那是一次显式的、会出现在 diff 里的动作。
 *
 * **这个数字只许改小。** 等它降到 0，`<=` 与「预算恰等于实际条数」两条合起来就自动升级成
 * D4 要的硬断言：任何命令都不得再落进 unread，新增写命令必须当场分类。
 */
const UNREAD_BUDGET_CEILING = 16;

/** below_bar 的处置形态与各自的必填字段（任务 1.3）。 */
const DISPOSITION_FIELDS: Record<string, string[]> = {
  fix: ['action', 'owner'],
  exception: ['reason', 'blockedBy', 'owner'],
};

/**
 * 预算类判据。**提成纯函数是为了让门禁能先抓一次自己**（任务 1.6）：
 * 直接写成 assert 的话，只能靠临时改真表来验证断言承重，改完还得还原——那种验证不会留下来。
 */
function budgetProblems(registry: Registry): string[] {
  const problems: string[] = [];
  const count = (status: string) => registry.commands.filter((entry) => entry.status === status).length;

  const unread = count('unread');
  if (unread > registry.unreadBudget) {
    problems.push(`unreadBudget 被突破：实际 ${unread} 条 > 预算 ${registry.unreadBudget}`);
  }
  if (registry.unreadBudget !== unread) {
    problems.push(
      `unreadBudget 留了空位：预算 ${registry.unreadBudget} ≠ 实际 ${unread} 条`
        + '——空位就是允许新的未读悄悄补进来',
    );
  }
  if (registry.unreadBudget > UNREAD_BUDGET_CEILING) {
    problems.push(
      `unreadBudget 被抬起：${registry.unreadBudget} > 上限 ${UNREAD_BUDGET_CEILING}`
        + '——这个数字只许下降',
    );
  }

  const belowBar = count('below_bar');
  if (belowBar > registry.belowBarBudget) {
    problems.push(`belowBarBudget 被突破：实际 ${belowBar} 条 > 预算 ${registry.belowBarBudget}`);
  }
  if (registry.belowBarBudget !== belowBar) {
    problems.push(
      `belowBarBudget 留了空位：预算 ${registry.belowBarBudget} ≠ 实际 ${belowBar} 条`,
    );
  }
  return problems;
}

/**
 * 处置类判据（任务 1.3）。没有处置的 below_bar 与 confirmed 的区别只存在于读者的记忆里，
 * 而这张表存在的全部理由就是不再依赖任何人的记忆。
 */
function dispositionProblems(registry: Registry): string[] {
  const problems: string[] = [];
  for (const entry of registry.commands) {
    if (entry.status !== 'below_bar') {
      if (entry.disposition) {
        problems.push(
          `${entry.nativeKind} 不是 below_bar 却还挂着 disposition`
            + '——判据修达标后处置必须一并摘掉，否则表里会留下一条永远等不到的待办',
        );
      }
      continue;
    }
    const disposition = entry.disposition;
    if (!disposition) {
      problems.push(`${entry.nativeKind} 标成 below_bar 却没有 disposition：没写谁来解、什么时候解`);
      continue;
    }
    const required = DISPOSITION_FIELDS[disposition.kind ?? ''];
    if (!required) {
      problems.push(
        `${entry.nativeKind} 的 disposition.kind "${disposition.kind}" 不在 `
          + `${Object.keys(DISPOSITION_FIELDS).join(' / ')} 之内`,
      );
      continue;
    }
    for (const field of required) {
      if (!(disposition as Record<string, unknown>)[field]?.toString().trim()) {
        problems.push(`${entry.nativeKind} 的 ${disposition.kind} 处置缺 ${field}`);
      }
    }
  }
  return problems;
}

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

test('5.11 / 1.2 两个方向都上棘轮：未读与不达标各自不留空位、只许下降', () => {
  // 只锁 unread 一个方向是不够的：把一条 unread 改成 below_bar、附一句「差在哪」，
  // unreadBudget 依法下降、门禁全绿，而那条命令的假成功风险一点没变。
  assert.deepEqual(budgetProblems(registry), [], '盘点表的预算对不上');
});

test('1.3 每条 below_bar 都写明「谁来解、卡在什么前置上」', () => {
  assert.deepEqual(dispositionProblems(registry), [], 'below_bar 的处置登记不完整');
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

/*
 * 以下是**门禁抓自己**的样本（任务 1.6）。
 *
 * 为什么要常驻而不是跑一次变异：新加的断言到底承不承重，只有让它当场红一次才知道；
 * 而那种一次性验证做完就没了，下一个人重构判据时不会再触发。所以每条新断言配一个
 * 会触发它的样本，并断言**恰好是它**报的错——「有红」不等于「是这条抓住的」。
 */

/** 一份各项都合法的最小盘点表，样本从它出发只坏一处。 */
function healthyRegistry(): Registry {
  return {
    invariants: [],
    unreadBudget: 1,
    belowBarBudget: 1,
    commands: [
      { nativeKind: 'sample_confirmed', status: 'confirmed', evidence: '实测位移' },
      { nativeKind: 'sample_unread', status: 'unread', evidence: '本轮未读' },
      {
        nativeKind: 'sample_below_bar',
        status: 'below_bar',
        evidence: '判据是自证，**不能**区分本次与残留',
        disposition: { kind: 'fix', action: '改为按本次标识回读', owner: 'change X §3.2' },
      },
    ],
  };
}

test('1.6 门禁抓自己：健康样本必须零问题（否则下面的样本红了也说明不了什么）', () => {
  assert.deepEqual(budgetProblems(healthyRegistry()), []);
  assert.deepEqual(dispositionProblems(healthyRegistry()), []);
});

test('1.6 门禁抓自己：unread 改成 below_bar 而不抬 belowBarBudget —— 正是要堵的那条洗白路', () => {
  const sample = healthyRegistry();
  const entry = sample.commands.find((e) => e.nativeKind === 'sample_unread')!;
  entry.status = 'below_bar';
  entry.evidence = '有判据但**不能**证明效果';
  entry.disposition = { kind: 'fix', action: '补判据', owner: 'change X' };
  sample.unreadBudget = 0; // 洗白动作会顺手把未读预算降下来，看起来像进展

  const problems = budgetProblems(sample);
  assert.equal(problems.length, 2, `期望恰好由两条 belowBarBudget 判据抓住，实际：${problems.join(' | ')}`);
  assert.match(problems[0], /belowBarBudget 被突破/);
  assert.match(problems[1], /belowBarBudget 留了空位/);
});

test('1.6 门禁抓自己：unreadBudget 被抬起', () => {
  const sample = healthyRegistry();
  sample.unreadBudget = UNREAD_BUDGET_CEILING + 1;
  sample.commands.push(
    ...Array.from({ length: UNREAD_BUDGET_CEILING }, (_, index) => ({
      nativeKind: `sample_unread_${index}`,
      status: 'unread',
      evidence: '本轮未读',
    })),
  );

  const problems = budgetProblems(sample);
  assert.equal(problems.length, 1, `期望恰好由上限那条抓住，实际：${problems.join(' | ')}`);
  assert.match(problems[0], /unreadBudget 被抬起/);
});

test('1.6 门禁抓自己：below_bar 没有处置 / 处置缺字段 / 达标后处置没摘掉', () => {
  const missing = healthyRegistry();
  delete missing.commands.find((e) => e.nativeKind === 'sample_below_bar')!.disposition;
  assert.deepEqual(
    dispositionProblems(missing).map((problem) => problem.replace(/：.*/, '')),
    ['sample_below_bar 标成 below_bar 却没有 disposition'],
  );

  const incomplete = healthyRegistry();
  incomplete.commands.find((e) => e.nativeKind === 'sample_below_bar')!.disposition = {
    kind: 'exception',
    reason: '真机上长什么样今天没有证据',
    owner: '标定后补',
  };
  assert.deepEqual(dispositionProblems(incomplete), ['sample_below_bar 的 exception 处置缺 blockedBy']);

  const stale = healthyRegistry();
  const fixed = stale.commands.find((e) => e.nativeKind === 'sample_below_bar')!;
  fixed.status = 'confirmed';
  stale.belowBarBudget = 0;
  assert.equal(dispositionProblems(stale).length, 1, '判据修达标后残留的处置必须被抓出来');
  assert.match(dispositionProblems(stale)[0], /不是 below_bar 却还挂着 disposition/);
});
