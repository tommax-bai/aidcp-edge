/**
 * 任务接管的取消语义（change lease-strict-preemption 第 4 节）。
 *
 * 本文件**零 import**（叶子）：flows / client / locating / facebook 都要引它做 instanceof 分类，而
 * TaskTakeoverError 原本住在 browse/browse-session.ts（一个静态 import cdp-util 的重模块）——反向引用
 * 就是真环 + class 的模块初始化 TDZ（`x instanceof undefined` 直接 TypeError，且只在某些 import 顺序下
 * 炸、typecheck 抓不到）。browse-session.ts 原地 re-export ⇒ ESM 同一份绑定、同一个类对象 ⇒ 既有
 * instanceof 全部恒成立。
 *
 * 放 src/execution/ 是因为世代号的权威来源 edge-task-coordinator.ts 就在同目录。
 */

/**
 * 命令在**安全取消点**被更高优先级的独占任务接管。
 *
 * 安全取消点 = 命令入口到它**第一次真正改写页面**之前的整段，以及每一次「上一个页面写已被后置校验、
 * 下一个页面写尚未发出」的缝。抛出本错误 = 该命令零页面副作用地作废，由主循环回一条诚实失败回执，
 * **绝不重放**。
 */
export class TaskTakeoverError extends Error {
  constructor() {
    super('命令在安全取消点被独占任务接管');
    this.name = 'TaskTakeoverError';
  }
}

/**
 * 取消令牌：**只在安全取消点调用**（= 下一个页面写动作尚未发出的位置）。
 * 未被接管即 return，已被接管即抛 TaskTakeoverError。
 *
 * MUST throw、MUST NOT 返回 boolean —— 返回布尔会让调用方「判一下然后继续往下写页面」，
 * 那正是对着验证码墙点击的那条路。
 * 判据 MUST 是接管世代号（当前世代 !== 本命令入口拍下的那一代），MUST NOT 是「浏览已冻结」这类
 * 布尔标志——交接一开始就置冻结、只在恢复时才清，而独占任务自己的命令就跑在冻结期内。
 */
export type Checkpoint = () => void;

/**
 * 一条命令的取消上下文。
 *
 * MUST 按调用传参。CloudElementSelector / ImageUploader / PublishCommandDispatcher /
 * FacebookPublishExecutor 全是进程级单例、被多条命令复用；存进构造函数字段 = 跨命令污染
 * （布尔冻结标志那个坑的换皮版）。
 */
export interface TakeoverCtx {
  checkpoint: Checkpoint;
  /**
   * 就地作废「已经发出的远端等待」：云端选元素（≤200s）与图片下载（≤15s）。
   * 轮询式谓词作废不了一个正在 await 的 promise —— 只有事件能。
   *
   * abort 的 reason MUST 是 TaskTakeoverError 实例（只走 abortForTakeover）；裸 controller.abort()
   * 的 DOMException 会绕过所有 instanceof 重抛闸、被降级成 `engine_error: This operation was aborted`。
   */
  signal?: AbortSignal;
}

/** 抢占方唯一允许的 abort 姿势。别在别处裸调 controller.abort()。 */
export function abortForTakeover(controller: AbortController): void {
  controller.abort(new TaskTakeoverError());
}

/** 任何 catch-all 的第一行：被接管 ≠ 业务失败，绝不降级成 engine_error / llm_error / handler_error。 */
export function rethrowIfTakeover(err: unknown): void {
  if (err instanceof TaskTakeoverError) throw err;
}
