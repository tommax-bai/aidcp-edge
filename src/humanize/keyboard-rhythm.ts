/**
 * 键盘输入节奏（逐字符按键间隔）。
 *
 * 背景（见 docs/risk-control.md §3 / docs/anti-detection.md §5.2）：搜索/评论时绝不
 * 一次性 Input.insertText 整段灌入。真人逐字符输入，按键间隔服从对数正态（中位
 * ~120ms），常用字快、生僻字/标点慢，偶有较长停顿（想词/切换输入法），间隔绝不均匀。
 *
 * 本模块为一段文本生成 KeyStroke[]，每个字符带"距上一个按键的延迟"，供调用方逐字符
 * 派发输入事件（或逐字符 insertText）。
 */

import { gaussian, type RandomFn, defaultRandom } from './timing.js';

/** 单个按键事件 */
export interface KeyStroke {
  /** 字符 */
  char: string;
  /** 距上一个按键的延迟(ms)（首字符可视为距聚焦的延迟） */
  delay: number;
}

/** 键盘节奏生成选项 */
export interface KeyboardRhythmOptions {
  /** 随机源（注入便于测试确定性） */
  random?: RandomFn;
  /** 正常按键间隔的对数正态中位(ms)，默认 110 */
  medianMs?: number;
  /** 对数正态分散度，默认 0.35 */
  sigma?: number;
  /** 出现长停顿（想词）的概率，默认 0.08 */
  pauseProbability?: number;
  /** 长停顿额外时长范围(ms)，默认 [300,600] */
  pauseMs?: [number, number];
  /** 间隔下限/上限裁剪(ms)，默认 [40, 400]（不含长停顿叠加） */
  clampMs?: [number, number];
}

/** 标点/空白：稍慢（停顿感） */
function isSlowChar(ch: string): boolean {
  return /[\s.,!?;:，。！？；：、…—]/.test(ch);
}

/**
 * 生成输入序列。
 *
 * 特征（docs/anti-detection.md §5.2）：
 *  - 平均间隔 ~80–150ms（对数正态，中位 medianMs）
 *  - 偶有长停顿 300–600ms（想词/切换输入法）
 *  - 标点/空白处间隔更长（停顿感）
 *  - 间隔不均匀（每字符独立采样）
 *
 * @param text 待输入文本
 */
export function generateKeyStrokes(text: string, options: KeyboardRhythmOptions = {}): KeyStroke[] {
  const random = options.random ?? defaultRandom;
  const median = options.medianMs ?? 110;
  const sigma = options.sigma ?? 0.35;
  const pauseProb = options.pauseProbability ?? 0.08;
  const [pauseLo, pauseHi] = options.pauseMs ?? [300, 600];
  const [clampLo, clampHi] = options.clampMs ?? [40, 400];

  const mu = Math.log(median);
  const chars = Array.from(text); // 正确处理多字节字符（中文/emoji）
  const out: KeyStroke[] = [];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    // 基础间隔：对数正态
    let delay = Math.exp(mu + sigma * gaussian(random));
    // 标点/空白稍慢
    if (isSlowChar(ch)) delay *= 1.4;
    // 裁剪基础间隔
    delay = Math.min(clampHi, Math.max(clampLo, delay));
    // 偶发长停顿（想词），叠加在基础间隔之上
    if (random() < pauseProb) {
      delay += pauseLo + random() * (pauseHi - pauseLo);
    }
    out.push({ char: ch, delay: Math.round(delay) });
  }
  return out;
}
