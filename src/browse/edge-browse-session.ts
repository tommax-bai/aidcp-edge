/**
 * 边缘「云端命令会话」契约（platform-neutral）。
 *
 * main.ts 用一个 `browse` 变量托管当前平台的浏览会话，并只调用下列 9 个方法（生命周期 + 命令入口）。
 * 小红书用 {@link BrowseSession}、Facebook 用 {@link FacebookBrowseSession}——两者都必须满足本契约，
 * 装配闸（main.ts）据平台选择其一。抽出接口是为了：① `browse` 变量能同时容纳两种实现（结构化赋值）；
 * ② 协变落地测试（co-landing）能断言「声明 browse 的 Facebook edge 解析到 FacebookBrowseSession、
 * 绝不挂到小红书 BrowseSession 上」，锁死 design 的原子同落不变量。
 *
 * 这里刻意只列 main.ts 真正调用的方法，不把某一平台的内部方法（loop/executeCommand/isWakeCommand 等）
 * 抬进契约——那些是实现细节，平台各自决定。
 */

import type { Envelope, PacingOp, PacingFloorPayload } from '../comm/protocol.js';

export interface EdgeBrowseSession {
  /** 启动会话（一次）：进入 feed / 首屏上报，长跑不 await。 */
  start(): Promise<void>;
  /** 云端主动命令入口：WS 层把每条命令推到这里。 */
  onCloudCommand(env: Envelope): Promise<void>;
  /** 请求停止（可被后续唤醒命令复活；非终态）。 */
  stop(): void;
  /** 终态关闭（进程下线 / CDP 死局）：永不复活。 */
  close(): void;
  /** 独占任务接管前静默到原子边界，返回等待毫秒数。 */
  quiesceForTask(): Promise<number>;
  /** 独占任务释放后恢复。 */
  resumeAfterTask(): Promise<void>;
  /** 丢弃队列里的云端命令（断连时避免重放旧命令）。 */
  discardQueuedCloudCommands(reason?: string): void;
  /** 重连后重注入节奏快照（floors + tempo）。 */
  applyPacingSnapshot(opFloorsMs?: Partial<Record<PacingOp, PacingFloorPayload>>, tempo?: number): void;
  /** 云端重连后恢复浏览（重报首屏等）。 */
  recoverAfterCloudReconnect(): Promise<void>;
}
