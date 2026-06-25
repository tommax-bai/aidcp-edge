/**
 * 看护重起策略（纯函数，便于单测）—— edge-own-chrome-supervised-recycle。
 *
 * 关键：崩溃循环预算按**连续失败计数**判定，而非墙钟滑动窗口。
 * 因单轮失败可能耗时数分钟（重连上限 + 登录等待），滑动窗口永远凑不满次数 → 永不放弃、无限重起（MAJOR⑥）。
 * 用「连续失败 + 健康存活达阈值才清零」（k8s 风格），慢失败击不穿。
 */

export interface RespawnPolicyOptions {
  /** 连续失败上限；超过即诚实放弃。 */
  maxConsecutiveFailures: number;
  /** 退避基数 ms。 */
  backoffBaseMs: number;
  /** 退避上限 ms。 */
  backoffMaxMs: number;
  /** 本次存活达此时长即视为「健康跑过一轮」，连续失败计数清零。 */
  healthyUptimeMs: number;
}

export interface RespawnInput {
  /** 子进程退出码（null = 被信号杀，按非零处理）。 */
  exitCode: number | null;
  /** 本次从启动到退出的存活时长 ms。 */
  uptimeMs: number;
  /** 此前累计的连续失败数。 */
  prevStreak: number;
  /** 看护进程是否正在关机（关机优先：一律不重起）。 */
  shuttingDown: boolean;
}

export interface RespawnDecision {
  action: 'respawn' | 'stop' | 'give-up';
  /** respawn 时的退避延迟。 */
  delayMs?: number;
  /** 更新后的连续失败数（供下次输入）。 */
  streak: number;
}

/**
 * 给定一次退出，算下一步与新的连续失败数。纯函数、无副作用。
 * - 关机中 → stop（关机优先，绝不在关机期间重起）。
 * - 本次健康存活达阈值 → 先把连续失败清零（一轮成功运行重置预算）。
 * - 干净退出 code=0 → stop（节点诚实终止，不重起）。
 * - 非零退出 → 连续失败 +1；超上限 → give-up（诚实放弃）；否则 respawn + 指数退避。
 */
export function decideRespawn(input: RespawnInput, opts: RespawnPolicyOptions): RespawnDecision {
  if (input.shuttingDown) return { action: 'stop', streak: input.prevStreak };
  // 健康跑过一轮 → 历史连续失败清零（慢失败下唯一可靠的「成功」信号）。
  const baseStreak = input.uptimeMs >= opts.healthyUptimeMs ? 0 : input.prevStreak;
  if (input.exitCode === 0) return { action: 'stop', streak: baseStreak };
  const streak = baseStreak + 1;
  if (streak > opts.maxConsecutiveFailures) return { action: 'give-up', streak };
  const delayMs = Math.min(opts.backoffMaxMs, opts.backoffBaseMs * 2 ** (streak - 1));
  return { action: 'respawn', delayMs, streak };
}
