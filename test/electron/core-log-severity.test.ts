import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// change honest-core-log-severity
//
// 红线：**「这行日志走了哪根管子」是传输事实，不是语义事实。**
// Node 的 console.warn / console.error 一律写 stderr，核心里 30+ 条良性诊断走这条路。外壳曾把 stderr
// 整条通道硬认成「出错了」，于是每来一条良性 warn 就把环境徽标染红、讲出「引擎已停止」——而核心根本没停。
//
// 本文件两层：
//   ① 纯函数层（fleet.cjs）：语料**逐字取自核心真实日志**，断言良性行不被判死、真终态行被判死。
//   ② 源码契约层（main.cjs）：Electron 起不来，按本仓既有做法（lifecycle-contract.test.ts）对源码设契约。
//      这一层的断言在**修复前的代码上必然失败**（旧源码里明写着 `edge: isError ? 'warning' : 'running'`）。

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const fleet = require('../../src/electron/fleet.cjs');
const main = readFileSync(join(here, '../../src/electron/main.cjs'), 'utf8');

// 注释里会**引用**旧写法来解释这次修的是什么（`edge: isError ? …`）——契约断言必须只看真代码，
// 否则一句解释性注释就能把断言弄假。剥掉行注释再断言。
function stripLineComments(src: string): string {
  return src
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

function functionSource(name: string): string {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const end = main.indexOf('\nfunction ', start + 1);
  return stripLineComments(main.slice(start, end > start ? end : undefined));
}

// ── ① 良性日志：核心还在跑，绝不判终态 ───────────────────────────────────────────
// 这些行全部走 stderr（console.warn / console.error），回归前**每一条**都会把徽标染红。

const BENIGN_STDERR_LINES = [
  // 槽位排队 —— 「资源暂时被占绝不判失败，排队是机器行为」（src/main.ts onWakeDenied）
  '[aidcp-edge] 外壳暂时给不出浏览器槽位（no free slot）：本次诚实作答，环境仍在等槽位队列里',
  // 发布提交诊断 —— 源码注释自称「只观测、不改行为」
  '[publish-submit-diag] before-click: (no value)',
  '[publish-submit-diag] after-click: capture failed: Target closed',
  // 租约抑制 —— 发布持独占租约时正确拒绝浏览指令，这是**正确行为**，不是故障
  '[aidcp-edge] 任务租约抑制命令 type=page.scroll taskId=t-1 current=t-2',
  '[aidcp-edge] Facebook 命令被任务租约抑制 type=page.scroll taskId=t-1 current=t-2',
  // 冷待机期间的后台重连重试 —— 会继续重试，核心照跑
  '[aidcp-edge] 冷待机期间云端后台重连失败：ECONNREFUSED；继续待机并稍后重试',
  // 遥测发送失败 —— 发不出去一条事件而已，引擎照跑
  '[aidcp-edge] risk.captcha_detected 上报失败: Error: socket hang up',
  '[aidcp-edge] edge.task.acquired 回传失败: Error: socket hang up',
  // 单次浏览会话异常 —— 浏览循环自己会重来，核心不退出
  '[aidcp-edge] 浏览会话异常: Error: CdpDisconnectedError',
];

for (const line of BENIGN_STDERR_LINES) {
  test(`declaresCoreHalt：良性 stderr 行不判终态 — ${line.slice(0, 40)}…`, () => {
    assert.equal(fleet.declaresCoreHalt(line), false);
  });
}

test('isFailureShapedLine：良性行不得污染失败归因（真出事时归因必须是真失败行）', () => {
  // 回归前这些行全部走 stderr → rememberEdgeFailureCandidate 被 isError 短路 → 全部被采信为
  // lastEdgeFailureLine → 核心真崩时，界面给运营看的「失败原因」是最后那条**无关**的良性 warn。
  assert.equal(fleet.isFailureShapedLine('[publish-submit-diag] after-click: capture failed: Target closed'), false);
  assert.equal(fleet.isFailureShapedLine('[aidcp-edge] risk.captcha_detected 上报失败: Error: socket hang up'), false);
  assert.equal(fleet.isFailureShapedLine('[aidcp-edge] edge.task.acquired 回传失败: Error: socket hang up'), false);
  assert.equal(
    fleet.isFailureShapedLine('[aidcp-edge] 外壳暂时给不出浏览器槽位（no free slot）：本次诚实作答，环境仍在等槽位队列里'),
    false,
  );
  assert.equal(fleet.isFailureShapedLine('[aidcp-edge] 任务租约抑制命令 type=page.scroll taskId=t-1 current=t-2'), false);
});

// ── ② 核心自己声明的终态：仍须判死（红线：不吞真失败） ─────────────────────────────

const HALT_LINES = [
  // 唯一**不退出**的终态：核心活着、但浏览器驱不动，必须人工介入（src/main.ts cdp.control_unavailable）
  '[aidcp-edge] CDP 输入控制不可用：复用的外部浏览器不会被自动关闭；请人工重启浏览器客户端后恢复',
  '[aidcp-edge] CDP 输入控制不可用：浏览器由本节点拥有，诚实下线并回收重启以建立新的控制边界',
  // 以下随即退出；外壳退出处仍是权威判据，这里只是让红早到
  '[aidcp-edge] CDP 重连不可恢复（终态）→ 诚实下线 + 回收退出（请重起）',
  '[aidcp-edge] 云端重连耗尽 → 诚实下线 + 回收退出（请重起）',
  '[aidcp-edge] ✗ 身份确立失败：登录态读不出稳定账号 id（no_stable_id）。',
  '[aidcp-edge] 启动失败: Error: 连接云端失败 ECONNREFUSED',
];

for (const line of HALT_LINES) {
  test(`declaresCoreHalt：核心自述终态仍判死 — ${line.slice(0, 40)}…`, () => {
    assert.equal(fleet.declaresCoreHalt(line), true);
  });
}

test('isFailureShapedLine：真失败行仍可作为归因', () => {
  assert.equal(fleet.isFailureShapedLine('[aidcp-edge] 启动失败: Error: 连接云端失败 ECONNREFUSED'), true);
  assert.equal(
    fleet.isFailureShapedLine('AdsPower browser-profile/start 失败：is being used by [tom] and is not allowed to open'),
    true,
  );
  assert.equal(fleet.isFailureShapedLine('[aidcp-edge] 核心退出 code=-1'), true);
});

test('declaresCoreHalt / isFailureShapedLine：空值与普通日志一律不判死（防误判）', () => {
  for (const v of ['', '   ', undefined, null]) {
    assert.equal(fleet.declaresCoreHalt(v as unknown as string), false);
    assert.equal(fleet.isFailureShapedLine(v as unknown as string), false);
  }
  assert.equal(fleet.declaresCoreHalt('[aidcp-edge] 已连接云端'), false);
  assert.equal(fleet.declaresCoreHalt('[browse] 浏览循环结束'), false);
  assert.equal(fleet.isFailureShapedLine('[aidcp-edge] 已连接云端'), false);
});

// ── ③ 源码契约：状态投影不得再按输出通道判定 ────────────────────────────────────
// 以下断言在**修复前的 main.cjs 上必然失败**。

test('契约：handleEdgeLogLine 的 edge 徽标 MUST NOT 由 isError（输出通道）派生', () => {
  const src = functionSource('handleEdgeLogLine');
  assert.ok(
    !/edge:\s*isError\s*\?/.test(src),
    '回归：edge 徽标又按输出通道判定了。stderr 只说明这行走了 fd 2，不说明核心出了错——'
      + 'Node 的 console.warn 本就写 stderr，这样写会让每条良性诊断都把环境染红成「引擎已停止」。',
  );
  assert.ok(
    /fleet\.declaresCoreHalt\(/.test(src),
    'edge 徽标必须按内容判定（fleet.declaresCoreHalt：核心自述终态白名单）。',
  );
});

test('契约：失败归因候选 MUST NOT 被 isError 短路', () => {
  const src = functionSource('rememberEdgeFailureCandidate');
  assert.ok(
    !/isError/.test(src),
    '回归：失败归因又按输出通道采信了。任何一条良性 stderr 都会覆盖 lastEdgeFailureLine，'
      + '于是核心真崩时呈现给运营的「失败原因」是最后那条无关的良性 warn。',
  );
  assert.ok(/fleet\.isFailureShapedLine\(/.test(src), '失败归因必须按内容判定。');
});

test('契约：日志文件仍按真实输出通道留痕（传输事实要如实记录，只是不再被误读成语义）', () => {
  assert.ok(
    /appendEdgeLog\(handle\.envId, message, isError\)/.test(main),
    '日志文件必须继续按真实通道记 ERR 前缀——排障回溯要靠它。',
  );
  assert.ok(
    /child\.stderr\.on\('data', \(chunk\) => handleEdgeOutput\(handle, chunk\.toString\(\), true\)\)/.test(main),
    'stderr 通道仍如实标记 isError=true（供日志留痕），只是状态投影不再据它判定语义。',
  );
});

test('契约：权威判据（异常退出）未被本 change 触动', () => {
  // 核心里每条致命路径都必然退出进程；child.on('close') 的异常退出分支才是权威判据。
  // 日志行只做预测——预测调准了，权威一分不动。
  assert.ok(/function abnormalExitFailurePatch\(/.test(main), '退出处权威失败判据必须仍在。');
  assert.ok(
    /abnormalExitFailurePatch\(handle, code, signal\)/.test(main),
    '异常退出仍须用退出码 / 信号给出权威失败呈现。',
  );
});
