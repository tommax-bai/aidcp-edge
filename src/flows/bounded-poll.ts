/**
 * 有界轮询原语（change lease-strict-preemption 4.2）。零 import 叶子。
 *
 * **签名里没有任何取消入参**，这是刻意的。被它替换的 6 个手写循环里，5 个都落在「页面已经被写、
 * 尚未后置校验」的窗口（导航已提交 / 正文已打进去 / **发布按钮已经点下去** / 话题词已进正文 /
 * 建议项已点）——在那里取消 = 把一次**可能已经生效**的写当成没发生，上游据此重投 ⇒ 发两遍。
 * 参数不存在 = 编译器焊死禁区，胜过任何注释。唯一存在安全取消窗口的调用方（选「上传图文」tab）
 * 把取消点内联在自己的 onMiss 首行：那里上一次点击刚被 probe 判为尚未生效、下一次点击尚未发出。
 *
 * **双闸：墙钟 + 迭代次数**。注入的 sleep 桩可能立即 resolve、注入的 now 可能恒定，墙钟因此不是
 * 边界（memory: edge-poll-helpers-iteration-bounded）。默认迭代帽 = ceil(timeout/interval)+2 ⇒
 * 真 sleep 下每轮至少消耗 intervalMs ⇒ 迭代帽永远先于墙钟到不了，只在桩环境生效。
 *
 * **sleep MUST 不可唤醒**（传 this.sleep / deps.sleep，绝不传 sleepInterruptible）：后置校验轮询若
 * 被接管唤醒，会在几毫秒内烧完迭代帽 ⇒ 把「已提交、结果未知」谎报成「校验失败」。
 *
 * **probe-first**：每轮先探一次再判死线。预算耗尽时也 MUST 至少校验过一次；改成「进循环先判死线」
 * 会静默退化成「预算耗尽时一次都不校验」——typecheck 与现有断言都抓不到。
 */

export interface BoundedPollOptions<T> {
  /** 只读探针。命中返回值（非 undefined），未命中返回 undefined。**原语从不 catch**——try 留在调用方。 */
  probe: () => Promise<T | undefined>;
  /** 未命中且预算未尽时的带副作用动作（只有「点 tab」那一处用）。 */
  onMiss?: () => Promise<void>;
  timeoutMs: number;
  intervalMs: number;
  clock: () => number;
  /** 不可唤醒的 sleep。 */
  sleep: (ms: number) => Promise<void>;
  /** 死循环护栏（非有效边界）。缺省 ceil(timeoutMs / intervalMs) + 2。 */
  maxIterations?: number;
}

/**
 * @returns 命中值；预算耗尽（或迭代帽耗尽）返回 undefined。
 *          error 串由调用方各自组装——6 个循环的超时语义互不相同（no_target / post_validate_failed / …）。
 */
export async function pollBounded<T>(options: BoundedPollOptions<T>): Promise<T | undefined> {
  const deadline = options.clock() + options.timeoutMs;
  const cap =
    options.maxIterations ?? Math.ceil(options.timeoutMs / Math.max(1, options.intervalMs)) + 2;
  for (let i = 0; i < cap; i++) {
    const hit = await options.probe();
    if (hit !== undefined) return hit;
    if (options.clock() >= deadline) return undefined;
    await options.onMiss?.();
    await options.sleep(options.intervalMs);
  }
  return undefined;
}
