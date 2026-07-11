import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// change edge-multi-instance-userdata-isolation 的契约守卫：
// main.cjs 是带顶层副作用的 Electron 主进程脚本、无法直接 require，故沿用 lifecycle-contract 的
// 源码契约断言方式，锁住「实例级 userData 隔离」的三条不变量：存在、受守卫、且在单实例锁之前生效。
const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, '../../src/electron/main.cjs'), 'utf8');
// 顺序不变量按**代码**位置比较：剥掉整行注释，避免注释里合法引用这些符号名（如本段说明）污染位置。
const code = main.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('userData 覆盖读 AIDCP_USER_DATA_DIR 并调用 app.setPath(userData)', () => {
  assert.match(main, /process\.env\.AIDCP_USER_DATA_DIR/, '必须读环境变量 AIDCP_USER_DATA_DIR');
  assert.match(
    main,
    /app\.setPath\(\s*['"]userData['"]\s*,/,
    '必须用 app.setPath("userData", …) 覆盖用户数据目录',
  );
});

test('覆盖受守卫：未设 AIDCP_USER_DATA_DIR 时不调用 setPath（零回归）', () => {
  const envIdx = main.indexOf('AIDCP_USER_DATA_DIR');
  const setPathIdx = main.search(/app\.setPath\(\s*['"]userData['"]/);
  const region = main.slice(envIdx, setPathIdx + 40);
  // setPath 必须处在一个以 AIDCP_USER_DATA_DIR 取值为条件的 if 守卫内，
  // 保证缺省（未设 / 空）时走默认目录、行为逐字不变。
  assert.match(region, /if\s*\(\s*instanceUserDataDir\s*\)/, 'setPath 必须被非空守卫包裹');
});

test('顺序不变量：userData 覆盖在 requestSingleInstanceLock 之前', () => {
  const setPathIdx = code.search(/app\.setPath\(\s*['"]userData['"]/);
  const lockIdx = code.indexOf('requestSingleInstanceLock(');
  assert.ok(setPathIdx >= 0, '未找到 userData 覆盖');
  assert.ok(lockIdx >= 0, '未找到 requestSingleInstanceLock');
  assert.ok(
    setPathIdx < lockIdx,
    'userData 覆盖必须在 requestSingleInstanceLock 之前（锁文件落在 userData，顺序错则隔离失效）',
  );
});

test('顺序不变量：userData 覆盖在任何 getPath(userData) 读取之前', () => {
  const setPathIdx = code.search(/app\.setPath\(\s*['"]userData['"]/);
  const firstGetPathIdx = code.search(/app\.getPath\(\s*['"]userData['"]/);
  assert.ok(firstGetPathIdx >= 0, '未找到 getPath(userData) 读取');
  assert.ok(
    setPathIdx < firstGetPathIdx,
    'userData 覆盖必须早于任何 getPath(userData) 派生路径读取',
  );
});
