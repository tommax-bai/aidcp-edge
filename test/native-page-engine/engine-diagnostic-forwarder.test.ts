/**
 * 引擎诊断行的归因、限量与接线（change surface-native-engine-diagnostics）。
 *
 * 与 `client.test.ts` 那批的分工：那边测**成帧**（谁被切成了几行、半行算不算行），
 * 这边测**盖章与限量**（这一行算在哪条命令头上、到量之后还说不说话），以及最要命的一条 ——
 * 生产装配是不是真的把出口传下去了。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeEngineDiagnosticLine } from '../../src/native-page-engine/client.js';
import {
  MAX_FORWARDED_LINES_PER_COMMAND,
  createEngineDiagnosticForwarder,
  renderEngineDiagnosticLine,
} from '../../src/native-page-engine/diagnostic-forwarder.js';
import { NativePageRuntime } from '../../src/native-page-engine/runtime.js';

function engineLine(seq: number, overrides: Partial<NativeEngineDiagnosticLine> = {}): NativeEngineDiagnosticLine {
  return {
    seq,
    text: `native_page_engine_pointer_degraded:${seq}`,
    kind: 'known',
    truncated: false,
    incomplete: false,
    ...overrides,
  };
}

test('stamps the in-flight command onto each forwarded line', () => {
  const written: string[] = [];
  const forwarder = createEngineDiagnosticForwarder((line) => written.push(line));
  forwarder.beginCommand('interaction_comment');
  forwarder.sink(engineLine(7));
  forwarder.endCommand();
  assert.deepEqual(written, [
    '[engine-diagnostic] cmd=interaction_comment seq=7 class=known native_page_engine_pointer_degraded:7',
  ]);
});

test('states honestly that no command was in flight instead of borrowing a neighbour', () => {
  const written: string[] = [];
  const forwarder = createEngineDiagnosticForwarder((line) => written.push(line));
  // 建会话期：还没有命令在飞。
  forwarder.sink(engineLine(1, { text: 'native_page_engine_session_open_failed:CdpTimeout' }));
  forwarder.beginCommand('note_open');
  forwarder.sink(engineLine(2));
  forwarder.endCommand();
  // 命令之间：上一条已结束、下一条还没开始。
  forwarder.sink(engineLine(3, { text: 'native_page_engine_request_rejected:InvalidRequest' }));
  assert.equal(written.length, 3);
  assert.match(written[0] ?? '', /^\[engine-diagnostic\] cmd=none seq=1 /);
  assert.match(written[1] ?? '', /^\[engine-diagnostic\] cmd=note_open seq=2 /);
  // MUST NOT 挂到相邻命令上 —— 前后各有一条 note_open，中间这条仍是 none。
  assert.match(written[2] ?? '', /^\[engine-diagnostic\] cmd=none seq=3 /);
});

test('renders explicit truncation and incompleteness markers', () => {
  assert.equal(
    renderEngineDiagnosticLine('note_open', engineLine(4, { truncated: true, text: 'aaa' })),
    '[engine-diagnostic] cmd=note_open seq=4 class=known truncated=1 aaa',
  );
  assert.equal(
    renderEngineDiagnosticLine('none', engineLine(5, { incomplete: true, kind: 'other', text: 'half' })),
    '[engine-diagnostic] cmd=none seq=5 class=other incomplete=1 half',
  );
});

test('keeps the earliest lines at the bound and announces how many it suppressed', () => {
  const written: string[] = [];
  const forwarder = createEngineDiagnosticForwarder((line) => written.push(line), 3);
  forwarder.beginCommand('page_scroll');
  for (let seq = 1; seq <= 10; seq += 1) forwarder.sink(engineLine(seq));
  forwarder.endCommand();

  const forwardedSeqs = written
    .filter((line) => line.includes('class=known'))
    .map((line) => Number(/ seq=(\d+) /.exec(line)?.[1]));
  // 保留**最早**的 N 行：排障要的是第一次出问题的现场，不是最后一次。
  assert.deepEqual(forwardedSeqs, [1, 2, 3]);
  // 到量的那一刻先喊一声（命令若再也没结束，读者也不该被蒙在鼓里）……
  assert.ok(written.some((line) => line.includes('forward_bound_reached=3')));
  // ……命令结束时如实报出压掉了几行。只断言前半条（保留最早 N 行）会漏掉「静默闭嘴」，
  // 而那正是这道闸要防的形态：只发前 N 行然后安静，读起来与「引擎没再说话」完全一样。
  assert.ok(written.some((line) => (
    line === '[engine-diagnostic] cmd=page_scroll class=host suppressed=7 limit=3'
  )));
});

test('emits no suppression notice when the volume stays under the bound', () => {
  const written: string[] = [];
  const forwarder = createEngineDiagnosticForwarder((line) => written.push(line), 3);
  forwarder.beginCommand('navigation_back');
  forwarder.sink(engineLine(1));
  forwarder.sink(engineLine(2));
  forwarder.endCommand();
  assert.equal(written.length, 2);
  assert.ok(!written.some((line) => line.includes('suppressed=')));
});

test('gives each command its own budget and settles a dangling one on flush', () => {
  const written: string[] = [];
  const forwarder = createEngineDiagnosticForwarder((line) => written.push(line), 1);
  forwarder.beginCommand('note_open');
  forwarder.sink(engineLine(1));
  forwarder.sink(engineLine(2));
  forwarder.beginCommand('navigation_back');
  forwarder.sink(engineLine(3));
  forwarder.flush();
  assert.ok(written.some((line) => line.includes('cmd=note_open class=host suppressed=1')));
  assert.ok(written.some((line) => / cmd=navigation_back seq=3 /.test(line)));
});

test('production runtime supplies the diagnostic sink it built, by reference', () => {
  const runtime = new NativePageRuntime({
    binaryPath: '/tmp/native-page-engine-wiring-probe',
    getEndpoint: () => ({ host: '127.0.0.1', port: 9222 }),
    expectedManifest: {
      engineVersion: 'test',
      platformAdapterVersion: 'multi-platform-test',
      platformAdapters: [{ platform: 'xiaohongshu', adapterVersion: 'xiaohongshu-test' }],
      capabilityDigest: 'a'.repeat(64),
    },
  });
  const wired = runtime.engineDiagnosticSink();
  // 「选项加了、生产装配忘了传」是本改动最像成功的失败形态：通路不存在，而单测全绿。
  // 断言「选项可被接受」对它完全无感，只有按引用核对客户端手上那一个才抓得到。
  assert.equal(typeof wired, 'function');
  assert.equal(wired, runtime.diagnosticForwarder.sink);
});

test('the per-command bound is the documented one', () => {
  assert.equal(MAX_FORWARDED_LINES_PER_COMMAND, 50);
});
