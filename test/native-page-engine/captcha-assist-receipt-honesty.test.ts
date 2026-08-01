import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildCaptchaClickResultFacts } from '../../src/captcha/click-result.js';

/**
 * 验证码协助回执的诚实性（change restore-native-actuation-humanization-and-locating，任务 2.10）。
 *
 * 两条不变量：
 * ① **运营画的那份轨迹被丢弃时必须留痕。** 引擎的验证码点击参数结构体带「拒绝未知字段」，
 *    所以宿主今天转发不了它 —— 这本身没问题，问题是**丢得无声无息**：运营在后台画完轨迹、
 *    回执报「合成路径」，中间没有任何一处说得清那份轨迹去哪了。
 * ② **回放模式不得写成常量。** 它是运营判断「我画的轨迹到底用上没有」的唯一依据。
 *    写死之后它永远说同一句话 —— 而那句话恰好会在轨迹通道接通的那一天开始变成谎话，
 *    且没有任何东西会响。
 *
 * **轨迹回放通道本身不在本 change 范围内**（已由任务 7.10 具名交接给需新立的 change）。
 * 本文件只守「丢弃可观测 + 回放模式不谎报」这一半。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('2.10 回放模式由实际走的那条路派生，不是常量', () => {
  const receipt = { ok: true, reason: 'cleared' };

  assert.equal(
    buildCaptchaClickResultFacts({}, receipt, 'synthetic').replayMode,
    'synthetic',
  );
  assert.equal(
    buildCaptchaClickResultFacts({}, receipt, 'trajectory').replayMode,
    'trajectory',
    '这一格必须真的能变 —— 只回一个值的回执，等于什么都没报',
  );

  // 引擎连回执都没给回来的那条路同样要如实报路径：这一格说的是「怎么驱动的」，
  // 与「结果如何」无关，塌成常量会把一次失败的轨迹回放记成合成路径。
  assert.equal(
    buildCaptchaClickResultFacts({}, undefined, 'trajectory').replayMode,
    'trajectory',
  );
  assert.equal(
    buildCaptchaClickResultFacts({}, undefined, 'synthetic').replayMode,
    'synthetic',
  );
});

test('2.10 宿主投影不得静默丢弃云端带来的轨迹字段', async () => {
  // 这条是**源码合约**而不是行为断言：投影点在宿主装配文件里，那个文件零导出、
  // 起不来一个可断言的实例。判据因此落在「丢弃处必须有可观测记录」这件结构事实上，
  // 并且**两条一起断言**（读到字段 + 留痕），少任何一条都能被一句无关代码喂绿。
  const source = await readFile(resolve(repoRoot, 'src/main.ts'), 'utf8');

  const projection = source.match(
    /const execution = await nativePageRuntime\.execute\(ownerId, \{\s*kind: 'captcha_click'[\s\S]*?\}\);/,
  );
  assert.ok(projection, '验证码点击的投影点没解析出来：此处 MUST 响亮失败，绝不能静默恒真');

  // 前置：投影确实是**手工枚举**字段的（不是整包透传）。这正是轨迹会被丢掉的机制；
  // 哪天它改成透传，本条的立论就变了，应当同批重写而不是留着假绿。
  assert.ok(
    projection[0].includes('incidentId') && projection[0].includes('points'),
    '投影形态已变（不再是逐字段枚举），本条的立论需要重写',
  );
  assert.equal(
    projection[0].includes('trajectory'),
    false,
    '轨迹一旦真的转发进引擎，本条与回放模式的派生都要同批改 —— 别让它悄悄进去',
  );

  // 真正守的那件事：读了这个字段，并且在丢弃时留下可观测记录。
  const window = source.slice(Math.max(0, projection.index! - 1600), projection.index!);
  assert.ok(
    /payload as \{ trajectory\?: unknown \}|payload\.trajectory/.test(window),
    '投影前没有任何一处读云端带来的轨迹字段 —— 那就是静默丢弃',
  );
  assert.ok(
    /console\.(warn|error)[\s\S]{0,400}轨迹/.test(window),
    '轨迹被丢弃时没有留下任何可观测记录',
  );
});
