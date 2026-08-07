/**
 * identity-command-gate.ts — 身份未落定时，节点不许代表这个账号动作，也不许以陈旧身份重新上线
 * ===========================================================================================
 * 背景（本轮复验实测坐实的漏网入口）：`halt` 是**纯返回**——它停浏览、停观测、断云端，但**从不关
 * 浏览器**。浏览器仍开着、登着一个我们已经明说「不知道是谁」的账号。此时：
 *   - 运营在客户端切一次云端环境 → 重绑是 `client.rebind(url)` 一步到位、全程不问身份 ⇒ 节点以**陈旧
 *     身份**对新云端宣称在线。云端看到一个健康在线的节点，照常给它派发布 / 任务认领。
 *   - 那些指令会经协调器与执行器**真的执行** ⇒ 在未知身份下真发帖、记账挂到错账号。
 * 这比「浏览循环空转」重一个量级：前者只是白烧动作，后者在平台上留下**真实痕迹**且账目是错的。
 *
 * ── 判据（change recategorize-nonpage-commands 后的形态）──
 * **一句话：身份未落定时，拒绝一切 `identity: 'page_account'` 的命令。零例外清单。**
 *
 * 这里曾有一张 6 条的手抄救援清单（IDENTITY_RESCUE_OPERATIONS）。它是分类错误的补丁：
 * 读身份 / 验证码协助 / 释放租约 / 会话收尾七条命令当年全被登记成 page_automation/page_account
 * （唯一共同点是「都需要浏览器」），身份闸按类别一拦全拦，只好手工挖洞放行。
 * 类别按「在编址什么」重归之后（观察 / 环境处置 / 编排收尾的 identity 都是 local_environment），
 * 被拦集合自然收敛为「真页面动作 + task.acquire」，清单失去存在理由。
 *
 * ── acquire 为什么仍被拦 ──
 * `task.acquire` 平台留痕维是 none（它自己不产生对象），但 identity 保持 page_account：
 * 认领租约＝即将以该账号名义动作的**准入**。身份都不知道是谁，谈不上以谁的名义认领。
 * 这正是「留痕维 MUST NOT 单独决定放行」的机械落点。
 */
import type { MessageType } from '../comm/protocol.js';
import type { IdentityHealth } from '../native-page-engine/identity-guard.js';
import { operationDescriptorFor } from './operation-registry.js';

export type IdentityCommandVerdict =
  | { kind: 'allow' }
  | { kind: 'refuse'; reason: 'identity_unresolved'; detail: string };

/** 身份是否已落定。`reestablishing` 也不算——那一刻我们已经判定「页面上的人变了」，只是还没换完。 */
export function identityResolved(health: IdentityHealth | undefined): boolean {
  return (health ?? 'healthy') === 'healthy';
}

function unresolvedDetail(health: IdentityHealth): string {
  return health === 'invalid'
    ? '运行期身份停在无身份终局（不知道浏览器里登着谁）'
    : '运行期身份正在重立中（已判定页面上的账号变了，新身份尚未确立）';
}

/**
 * 云端命令的身份闸。
 *
 * 身份未落定时，凡是**以页面账号名义**动作的命令一律拒绝并如实回执（绝不静默丢弃：云端分不清
 * 「命令没触达」与「执行了但没结果」）。救援 / 读 / 收尾类照常放行。
 */
export function judgeCommandUnderIdentity(
  health: IdentityHealth | undefined,
  type: MessageType,
): IdentityCommandVerdict {
  const current = health ?? 'healthy';
  if (identityResolved(current)) return { kind: 'allow' };
  const descriptor = operationDescriptorFor(type);
  // 未登记的命令另有一道 fail-closed 闸（EdgeClient 入口）会拒；这里不重复表态。
  // 判据只剩一条：以页面账号名义动作的才拦。观察 / 环境处置 / 编排收尾的 identity 已按编址重归，
  // 天然放行——不再需要按名点人的救援清单。
  if (!descriptor || descriptor.identity !== 'page_account') return { kind: 'allow' };
  return {
    kind: 'refuse',
    reason: 'identity_unresolved',
    detail: `${unresolvedDetail(current)}：拒绝代表该账号执行 ${type}`,
  };
}

export type CloudRebindVerdict = { kind: 'allow' } | { kind: 'refuse'; reason: string };

/**
 * 切换云端环境（重绑控制传输）的身份闸。
 *
 * **裁定：拒绝，而不是「允许但不带身份」。** 两条理由：
 *   ① 协议上就没有「不带身份的在线」这一态——`hello` 必须带 accountId，不带会被云端以
 *      `missing_account_id` 拒绝握手。那样运营看到的是「云端拒绝了这个节点」，把人推去查云端配置，
 *      而真正的原因（浏览器里登着谁不知道）被盖住了：换来的是一个**更难排查**的假象。
 *   ② 「不宣称在线」正是此刻的**事实**。节点确实什么也做不了，云端把它当不在场是对的；而带着陈旧
 *      accountId 上线会让云端把它当成那个账号的健康节点、照常派活——那才是真发帖记错账的入口。
 * 拒绝是可恢复的：处理办法与 halt 本身相同（重新登录目标账号后重启本环境），重启时自然会连上新选的云端。
 */
export function judgeCloudRebindUnderIdentity(health: IdentityHealth | undefined): CloudRebindVerdict {
  const current = health ?? 'healthy';
  if (identityResolved(current)) return { kind: 'allow' };
  return {
    kind: 'refuse',
    reason: `identity_unresolved: ${unresolvedDetail(current)}——拒绝以陈旧身份对新的云端环境宣称在线。`
      + '请在浏览器里重新登录目标账号后重启本环境，重启时会直接连到新选的云端。',
  };
}

// ===========================================================================================
// 闸的**真实现**（判据 + 动作整段）—— 宿主只剩一行接线
// ===========================================================================================
//
// 为什么判据与动作必须待在同一个可注入函数里，而不是「模块给判据、宿主写动作」：
// 上一轮它们是分开的（模块导出 `judge*`，`src/main.ts` 的 1400 行单 `main()` 里写 `if (…) throw` /
// `if (…) { 回执; return; }`）。那些动作落在一个**没有导出、拿不到句柄**的大闭包里，用例只能扫源码
// 文本。而复验实测坐实：把宿主里那半句动作删掉（留下 `const verdict = judge…`、删掉紧随的 `throw`；
// 或把条件写成 `|| true` / `false &&`），**整套用例零红**——判据算了、日志打了，闸就是不拦。
//
// 「判了但不据此动作」正是本系列在追的那一族病。所以本节的每个函数都**自己完成拒绝**（抛出 / 发回执 /
// 不调用下游处理器），宿主只做一次调用或一次包裹。中性化它们中的任何一处，驱动真实现的用例当场红。

/**
 * 一条云端命令通道的**负向应答形状**。
 *
 * `action_completed`       —— 云端会消费 `action.completed`（浏览 / 页面动作通道）。
 * `publish_command_result` —— 云端按信封 id 关联 `{p}.publish.command.result`（发布原子通道）。
 * `unwired`                —— 形状**存在**，但本次拒绝的原因还没有可用的取值，因此这一条现在发不出去。
 *                             此时唯一诚实的做法是：不发、响亮记一笔、并把缺口连同**可执行的配方**
 *                             登记下来。伪造一条云端根本不认识的回执比不发更坏——它让人以为
 *                             「已经兑现了」，而云端照样等满自己的超时。
 *
 * 这一档 MUST NOT 被写成「协议上没有这条路」。上一轮它就是这么写的，而事实相反（见 EDGE_TASK_LANE）：
 * 把「差一个枚举值」说成「没有路」，正是让下一个人以为无路可走、从而永远不去补的那种病。
 */
export type IdentityRefusalAck = 'action_completed' | 'publish_command_result' | 'unwired';

export interface CommandLane {
  /** 日志里的通道名。 */
  readonly label: string;
  readonly ack: IdentityRefusalAck;
  /**
   * `ack: 'unwired'` 时必须写清三件事：缺口到底是什么（**不是**「没有形状」就说成没有）、云端因此会
   * 看到什么、以及补齐它的**具体落点**。写不出落点，说明还没查清楚，别急着下结论。
   */
  readonly ackGap?: string;
}

/** 浏览 / 页面动作通道：云端消费 `action.completed`，拒绝有真回执。 */
export const NATIVE_COMMAND_LANE: CommandLane = { label: 'Native', ack: 'action_completed' };

/**
 * 任务租约通道：负向应答形状**已经存在**，缺的只是一个可用的拒绝原因。
 *
 * 上一轮这里写的是「协议 v2 上任务租约没有负向应答形状，真兑现要跨仓加一条消息」。**那是错的**，
 * 复验读云端坐实：
 *   - 形状就是 `task.released` + `reason`。云端 `comm/handler.ts` 把它路由到
 *     `comm/edge-task-lease-client.ts` 的 `onReleased()`，其中四段针对**仍在认领中**的任务直接
 *     `clearTimeout` + reject（`cdp_unhealthy`→`edge_unhealthy` / `browser_wake_failed` /
 *     `window_busy` / `yield_timeout`），**不等超时**。
 *   - 边缘自己也正是用这条形状拒绝一个接不下的认领（`execution/edge-task-coordinator.ts` 里
 *     `onReleased({ taskId, reason: 'cdp_unhealthy' })`）。
 *   闸反而在它上游把这条本来通的路截断了。
 *
 * 所以缺口只有一个：**「身份未落定」这个 reason 还不在枚举里**。补齐它的完整配方（三处，跨仓）：
 *   ① 两份 `src/comm/protocol.ts`（edge / cloud，逐字一致）的 `EdgeTaskReleasedPayload.reason` 联合
 *      各加一个值（如 `identity_unresolved`）+ 一段说明「身份未落定 ⇒ 不可自愈，处理办法是重新登录后重启」；
 *   ② 云端 `comm/edge-task-lease-client.ts` 的 `onReleased()` 加一个 `if`，照 `yield_timeout` 那一段
 *      的形状 reject 掉在认领中的任务（同属**不可自动重试**的一类）；
 *   ③ 本文件把 `ack` 改成新增的那一档、真的发出去。
 * **不**新增消息类型、**不**动动作映射、**不**改协议文档计数、**不**进主动命令白名单。
 *
 * 本轮为什么仍不做：两份 `protocol.ts` 是本仓明令的**串行热点单写区**，而此刻有并行流在跑。
 * 这是范围裁定，不是难度问题。
 *
 * 不做的代价可量化：云端的 `acquire_timeout` 默认 200 秒，它要**空等满 200 秒**才拿到一个泛化的超时，
 * 而不是即刻拿到一个有类型、且明确「别自动重试」的拒绝。
 */
export const EDGE_TASK_LANE: CommandLane = {
  label: '任务',
  ack: 'unwired',
  ackGap: '任务租约的负向应答形状已经存在（task.released + reason；云端 onReleased 对 cdp_unhealthy /'
    + ' browser_wake_failed / window_busy / yield_timeout 四种原因当场 reject 掉在认领中的任务、不等超时），'
    + '缺的只是「身份未落定」这一个 reason 枚举值：补齐＝两份 protocol.ts 的 EdgeTaskReleasedPayload.reason'
    + ' 各加一个值 + 云端 onReleased 加一个 if，不新增消息类型、不动动作映射、不进主动命令白名单。'
    + '补齐之前本次拒绝发不出去，云端会空等满自己的 acquire_timeout（默认 200s）才拿到一个泛化的超时。',
};

export interface IdentityCommandGateDeps {
  /** 现在的运行期身份健康度（每条命令都重新读，绝不缓存——身份是持续校验的状态）。 */
  health: () => IdentityHealth | undefined;
  actionNameFor: (type: MessageType) => string;
  reportActionCompleted: (receipt: { action: string; ok: false; reason: string }) => void;
  logger: (line: string) => void;
}

/**
 * 把一个云端命令处理器包进身份闸：身份未落定时**不调用**下游处理器，并按本通道的应答形状如实收口。
 *
 * 宿主接线只有一行：`client.onX(guardCommandsUnderIdentity(LANE, deps, handler))`。
 */
export function guardCommandsUnderIdentity<E extends { type: MessageType }>(
  lane: CommandLane,
  deps: IdentityCommandGateDeps,
  handler: (env: E) => void,
): (env: E) => void {
  return (env: E): void => {
    const verdict = judgeCommandUnderIdentity(deps.health(), env.type);
    if (verdict.kind === 'allow') {
      handler(env);
      return;
    }
    const action = deps.actionNameFor(env.type);
    if (lane.ack === 'action_completed') {
      deps.logger(
        `[aidcp-edge] ${lane.label} 命令被身份闸拒绝 type=${env.type}：${verdict.detail} 回执 ${action}:${verdict.reason}`,
      );
      deps.reportActionCompleted({ action, ok: false, reason: verdict.reason });
      return;
    }
    // 负向应答尚未接线的通道：不伪造回执，但**必须响亮**——静默丢弃与「发一条没人收的回执」是同一种病。
    // 日志里连带把补齐配方（ackGap）一起喊出来，这样看到它的人手上就有下一步，而不是只有一个坏消息。
    deps.logger(
      `[aidcp-edge] ${lane.label} 命令被身份闸拒绝 type=${env.type}：${verdict.detail}。${lane.ackGap ?? ''}`,
    );
  };
}

export interface PublishCommandIdentityGateDeps {
  health: () => IdentityHealth | undefined;
  /**
   * 发布原子的应答按信封 id 关联；宿主只提供发送出口，载荷由本模块拼。
   * `commandType` 是被拒命令的消息名（批 6b：平台在名字里）——宿主据此选对应平台形结果名。
   */
  sendResult: (payload: Record<string, unknown>, correlationId: string, commandType: MessageType) => void;
  logger: (line: string) => void;
}

export interface PublishAtomEnvelopeLike {
  id: string;
  type: MessageType;
  payload: { recordId: string | number; seq: number; kind: string };
}

/**
 * 发布原子命令的身份闸。发布是**在平台上留真实痕迹**的动作，身份未落定时必须拒绝并按发布回执形状
 * 如实回（静默丢弃会让云端挂起等一个永远不来的结果）。
 */
export function guardPublishCommandsUnderIdentity<E extends PublishAtomEnvelopeLike>(
  deps: PublishCommandIdentityGateDeps,
  handler: (env: E) => void,
): (env: E) => void {
  return (env: E): void => {
    const verdict = judgeCommandUnderIdentity(deps.health(), env.type);
    if (verdict.kind === 'allow') {
      handler(env);
      return;
    }
    deps.sendResult(
      {
        recordId: env.payload.recordId,
        seq: env.payload.seq,
        kind: env.payload.kind,
        ok: false,
        error: verdict.reason,
      },
      env.id,
      env.type,
    );
    deps.logger(`[aidcp-edge] 发布命令被身份闸拒绝：${verdict.detail}`);
  };
}

/**
 * 切换云端环境的身份闸：**判完再放行才算闸**。
 *
 * 重绑动作本体由调用方以回调传入，闸拒绝时它一次都不会被调用（上一轮这里是宿主里的 `if (…) throw`，
 * 删掉那半句 `throw`，重绑照跑、节点以陈旧身份对新云端宣称在线，而全套用例零红）。
 */
export async function rebindCloudUnderIdentityGate<T>(
  health: IdentityHealth | undefined,
  rebind: () => Promise<T>,
): Promise<T> {
  const verdict = judgeCloudRebindUnderIdentity(health);
  if (verdict.kind === 'refuse') throw new Error(verdict.reason);
  return rebind();
}
