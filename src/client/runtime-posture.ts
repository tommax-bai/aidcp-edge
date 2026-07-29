/**
 * runtime-posture.ts — 「核心的真实运行态」→「外界应当看到什么」的**唯一权威边**
 * ===========================================================================================
 * 本模块存在的唯一理由：此前每加一条身份 / 恢复路径，核心与外壳就多一处各自拼状态的地方，于是
 * 两边讲的话开始分岔。逐条打补丁修不掉这个源头——补丁本身就是新的分岔点。所以这里把「对外呈现」
 * 收口成一个具名事实（posture），核心的每一个状态转移都只经它对外说一次，外壳只负责把它翻译成界面。
 *
 * ── 一、谁是权威 ──
 * **核心说了算。** posture 是核心对自身运行态的判断，外壳 MUST NOT 自己推导、修改或提前预测它
 * （尤其 MUST NOT 在下发一条生命周期指令**之前**先把界面写成指令成功后的样子——指令可能被核心拒绝，
 * 而那条乐观投影不会有任何东西来纠正）。外壳只拥有「怎么画」。
 *
 * 一个字段被两边写就一定会分岔，所以规则是硬的：**非健康 posture 闩住期间，`edge` / `session` /
 * `cloud` / `auth` 四轴只由 posture 投影写**；外壳的日志行推断与乐观投影一律让位（见
 * `src/electron/runtime-posture.cjs` 的 `runtimePostureOverride`）。
 *
 * ── 二、四态与它们各自的处理办法（态的划分依据就是「运营该做什么」不同）──
 *   `healthy`            身份已实测确认、自动化按宿主意图运行。带 `accountId` = 刚**真正**重新确立过
 *                        一次身份（用于解除上一局闩住的红角标并告知运营新账号是谁）。
 *   `reestablishing`     判失效已发出、身份重立链持球：浏览停了、周期观测停了、云端连接被链条主动断开。
 *                        它**不是**失败，也**不是**运行中——运营此刻什么都不用做，等几秒即可。
 *   `identity_halted`    终局：不知道浏览器里登着谁。处理办法＝在浏览器里重新登录目标账号后重启本环境。
 *   `automation_stalled` 残局：**身份完好**，但浏览与周期观测停着，且没有任何东西会再来重启它们
 *                        （重立链在重设基线之后的收尾步骤崩了 / 作废回滚时云端没连回来）。
 *
 * `automation_stalled` 是本次新增的一格，理由必须写清楚，否则下一个人又会把它折进旁边两态里：
 *   - 折进 `healthy`：外壳显示「运行中、无角标」，而浏览与观测永久停着——**静默假成功**，本仓最上位红线。
 *   - 折进 `identity_halted`：那句话的字面意思是「身份确立失败」，可身份恰恰是唯一没出问题的东西；
 *     它会把运营推去「重新登录再重启」，而真正有效的动作是点一次「恢复」（那条路会重新拉起浏览与观测）。
 * 一个态之所以是一个态，是因为它的**处理办法**与别的态不同。这一格两者都不满足，所以它必须自己占一格。
 *
 * ── 三、哪些事实 MUST NOT 依赖 `lastMessage` ──
 * 外壳的 `lastMessage` 是**滚动叙述**：核心每打一行日志就把它覆写一次。任何把终局 / 残局信息只放进
 * 这一个字段的设计都是假的——复验实测里，喂一行普通心跳，那句唯一诚实的话就没了。
 * 故：终局与残局的事实 MUST 落在**不会被日志行覆写**的地方——
 *   ① `posture` 闩本身（外壳持有，日志行不许改）；
 *   ② 由它派生的四轴（每次 updateStatus 都被 posture 投影重新压回去）；
 *   ③ `edgeFailure` 卡片（持久，日志行只在**没有**闩时才允许清它）。
 * `lastMessage` 只承载当下这一行的叙述，随便被覆盖也不丢事实。
 */

/** IPC 消息类型：核心 → 外壳的**唯一**运行态通道。旧的两条（identity_halted / identity_restored）已由它取代。 */
export const RUNTIME_POSTURE_IPC_TYPE = 'lifecycle.runtime_posture';

export type RuntimePostureKind = 'healthy' | 'reestablishing' | 'identity_halted' | 'automation_stalled';

/** 与外壳侧 `src/electron/runtime-posture.cjs` 的同名表逐字对齐（有跨侧对账用例钉住）。 */
export const RUNTIME_POSTURE_KINDS: readonly RuntimePostureKind[] = [
  'healthy',
  'reestablishing',
  'identity_halted',
  'automation_stalled',
];

export type RuntimePosture =
  | { kind: 'healthy'; accountId?: string }
  | { kind: 'reestablishing'; reason: string }
  | { kind: 'identity_halted'; reason: string }
  | { kind: 'automation_stalled'; reason: string };

/** 组装 IPC 载荷。核心侧只此一处拼这条消息，避免各入口各写一份形状。 */
export function runtimePostureIpc(posture: RuntimePosture): Record<string, unknown> {
  return { type: RUNTIME_POSTURE_IPC_TYPE, posture };
}

/**
 * 「这个 posture 允不允许恢复自动化」——核心与外壳共用的**同一条**判据（外壳侧有一份逐字镜像）。
 *
 * 只拦 `identity_halted`：
 *   - `automation_stalled` **必须放行**：点「恢复」正是它的处理办法（重新拉起浏览与观测），拦掉等于把
 *     一台身份完好、只是没跑起来的机器钉死。
 *   - `reestablishing` 放行：链条自己会收口，拦它等于把一次正常的重立卡死。
 */
export function postureBlocksAutomationResume(posture: RuntimePosture | null | undefined): boolean {
  return posture?.kind === 'identity_halted';
}

/** 非健康态 ⇒ 闩住：此后任何日志行推断 / 乐观投影都 MUST NOT 覆盖四轴（文件头「三」）。 */
export function postureLatches(posture: RuntimePosture | null | undefined): boolean {
  return Boolean(posture) && posture!.kind !== 'healthy';
}
