import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// change restore-facebook-post-join-comment-continuity
//
// 红线：被任务租约抑制的命令**必须回执**，不得只打日志就 return。
// 真机实例：一条 page.scroll 与其所属任务的 release 在同一毫秒到达，命令被丢弃、云端毫无信号，
// 只能等满自己的步超时。云端因此分不清「命令没触达页面」与「命令执行了但页面没结果」——
// 这正是本项目禁止的静默丢弃形状（前置登记：facebook-first-post-comment-confirmation task 5.6）。
//
// src/main.ts 是装配入口（起 Electron / 浏览器 / 云端连接），单测里跑不起来，按本仓既有做法
// （test/electron/lifecycle-contract.test.ts、core-log-severity.test.ts）对源码设契约。
// 注释里会引用旧写法解释修的是什么，故断言前必须剥注释，否则一句解释就能把断言弄假。

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const raw = readFileSync(resolve(repoRoot, 'src/main.ts'), 'utf8');

function stripComments(src: string): string {
  return src
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const source = stripComments(raw);

test('租约抑制走统一回执 helper，且回执成功位为假、原因具名', () => {
  const helper = source.slice(source.indexOf('const reportLeaseSuppressed'));
  assert.ok(
    source.includes('const reportLeaseSuppressed'),
    '必须有一个统一的抑制回执出口，两条路由共用，避免口径漂移',
  );
  const body = helper.slice(0, helper.indexOf('\n  };') + 5);
  assert.match(body, /client\.reportActionCompleted\(/, '抑制必须向云端回执，不能只打日志');
  assert.match(body, /ok:\s*false/, '抑制回执绝不能冒充成功');
  assert.match(body, /reason:\s*'task_lease_suppressed'/, '原因必须具名，云端才能与「执行了但没结果」区分');
  assert.match(body, /nativeActionNameForCommand\(/, '动作名必须走既有映射，不得另起口径');
});

test('两条命令路由的抑制分支都不再静默 return', () => {
  // 抑制分支的形状：判定 → 回执 → return。若某处只剩 console.warn + return，即是静默丢弃复发。
  const branches = source.match(/if\s*\([^)]*canExecute\(ownedTaskId\)\)\s*\{[\s\S]*?\n\s*\}/g) ?? [];
  assert.equal(branches.length, 2, '当前有 Native 与 Facebook 两条页面命令路由');
  for (const branch of branches) {
    assert.match(branch, /reportLeaseSuppressed\(/, `抑制分支必须回执：${branch.slice(0, 80)}`);
  }
  assert.equal(
    (source.match(/命令被任务租约抑制/g) ?? []).length,
    1,
    '抑制日志只应存在于统一 helper 内；分散的 console.warn 意味着有分支绕开了回执',
  );
});
