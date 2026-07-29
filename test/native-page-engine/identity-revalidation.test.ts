/**
 * 周期阻断观测的生命周期托管（1.9①）+ 运行期身份持续校验（§5）的宿主侧接线。
 *
 * 本文件先落 1.9① 的一条**弱断言**；§5 的判定表与重立链行为用例随后补入。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 1.9① 宿主侧接线（**弱断言**：源码文本扫描，不计入行为覆盖）──────────────────
//
// 下面这条只证明「宿主源码里写了这几处调用」，证不了运行时真的按顺序发生。
// 之所以退化成文本扫描：这三处接线的落点是 `src/main.ts` 的一个 1400 行无导出单 `main()`，
// 拿不到可注入的句柄。真行为覆盖在会话侧（browse-session.test.ts 的 suspend/resume 幂等用例）；
// 这条只防「有人把接线整段删掉」。
test('1.9① 弱断言（源码扫描）：执行器终态停观测、冷待机停观测、重连整批重启', () => {
  const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/main.ts'), 'utf8');

  const isolateStart = main.indexOf('const isolateExecutorFailure');
  const isolateEnd = main.indexOf('// Input 超时', isolateStart);
  assert.ok(isolateStart >= 0 && isolateEnd > isolateStart);
  assert.match(
    main.slice(isolateStart, isolateEnd),
    /suspendObservation\(reason\)/,
    '执行器终态（cdp.unrecoverable / cdp.control_unavailable 的共同收口）必须停掉周期观测——'
      + '冷待机在有活跃租约 / 复用外部浏览器时会被拒绝，把停手挂在待机路径上会漏',
  );

  const standbyStart = main.indexOf('enterStandby: async () => {');
  const standbyEnd = main.indexOf('wakeFromStandby: async', standbyStart);
  assert.ok(standbyStart >= 0 && standbyEnd > standbyStart);
  assert.match(main.slice(standbyStart, standbyEnd), /suspendObservation\('cold_standby'\)/);

  const reconnStart = main.indexOf("session.cdp.on('cdp.reconnected'");
  const reconnEnd = main.indexOf("process.on('SIGINT'", reconnStart);
  assert.ok(reconnStart >= 0 && reconnEnd > reconnStart, '必须存在 cdp.reconnected 订阅');
  assert.match(main.slice(reconnStart, reconnEnd), /resumeObservation\(\)/);
});
