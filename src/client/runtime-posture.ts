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
 *
 * ── 四、「恢复自动化」的准入**不在本模块** ──
 * 这里曾有一个 `postureBlocksAutomationResume`，注释自称是「核心与外壳共用的同一条判据」。它是假的：
 * 零调用方，且两侧真正的闸判的根本不是同一件事——**核心闸按运行期身份健康度判**
 * （`identity-guard.ts` 的 `automationResumeCallback` → `resumeAutomationUnderIdentityGate`），
 * **外壳闸按 posture 判**（`electron/runtime-posture.cjs` 的 `judgeResumeUnderPosture`，先判是为了不产生
 * 那条乐观投影）。一段没人调、还声称自己是共用判据的代码比没有更坏——它会让下一个人以为改它就够了。
 * 已删除。要改恢复准入，去改上面那两处真正在跑的。
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

/** 非健康态 ⇒ 闩住：此后任何日志行推断 / 乐观投影都 MUST NOT 覆盖四轴（文件头「三」）。 */
export function postureLatches(posture: RuntimePosture | null | undefined): boolean {
  return Boolean(posture) && posture!.kind !== 'healthy';
}

/**
 * 终局 / 残局在**日志侧**的白名单措辞（IPC 之外的第二道网）。
 *
 * 与 `src/electron/fleet.cjs` 的 `declaresCoreHalt` 白名单共用，跨侧对账用例会实跑这两句去撞它。
 * 这两句不是给人看的文案，是**协议**：改字面必须同步外壳白名单。
 */
export const POSTURE_HALT_PHRASES: Readonly<Record<'identity_halted' | 'automation_stalled', string>> = {
  identity_halted: '身份确立失败',
  automation_stalled: '自动化已停摆',
};

/**
 * 「这一条真的交给外壳了吗」——IPC 送达判据的**唯一实现**。
 *
 * `process.send` 在父子通道断开时是**静默 no-op**（`process.connected` 为假就直接不发、不报错、
 * 不抛异常），所以「送没送到」必须自己判，绝不能拿「调用没抛异常」当送达。
 *
 * 它为什么在这里而不在宿主里：上一轮这条判据写在 `src/main.ts` 那个 1400 行、无导出的单 `main()` 闭包
 * 里，用例拿不到句柄、只能自己传一个假的送达函数进来 ⇒ **真判据零覆盖**。复验实测：把它改成恒 `true`，
 * 整条第二道网当场蒸发（通道断了也判成送到了、兜底日志再也不打），而全套用例零红。现在用例驱动的
 * 就是它本身。
 */
export interface IpcCapableProcess {
  send?: (payload: Record<string, unknown>) => unknown;
  connected?: boolean;
}

export function deliverLifecycleIpc(proc: IpcCapableProcess, payload: Record<string, unknown>): boolean {
  if (typeof proc.send !== 'function' || !proc.connected) return false;
  proc.send(payload);
  return true;
}

/**
 * posture 的对外发布：IPC 是主路，**发不出去时必须在日志里补一句**。
 *
 * 终局与残局各只有 posture IPC 一条边通到外壳。这条边一丢（`deliverLifecycleIpc` 判成没送到），
 * 界面立刻退回「全绿、无角标」而浏览与观测永久停着——正是本系列在根除的形状。这里补的是**日志侧**
 * 的第二道网：措辞与外壳终态白名单（`electron/fleet.cjs` 的 `declaresCoreHalt`）共用，改字面必须两边一起改。
 *
 * ── 这道网到底顶多久：**只顶当下这一行** ──
 * 实测口径必须写准，否则下一个人会以为它够用而不再去补真正持久的那条边：
 * 没有 posture IPC 就**没有闩**，没有闩 `runtimePostureOverride` 就不施加覆盖层。于是这一行被白名单
 * 认出来 ⇒ 当下这次落盘写成 `edge:'warning'` 且不清失败卡片；但**下一行普通日志**（心跳、「已连接
 * 云端」…）的 `declaresCoreHalt` 为假、闩又是空的，界面当场被写回「运行中」并把失败卡片清掉。
 *
 * 也就是说：它严格优于此前的「残局态零条边」，但按本文件头「三」的规矩衡量，它仍是把终局 / 残局的
 * 事实放在了**会被日志行覆写**的地方。这一条是**继承**的——终局态历来如此，本次只是把残局态补到同一
 * 水平，没有让任何东西变差，也没有把它修好。真正的修法是让外壳在识别到这句白名单措辞时也闩住
 * （等价于「从日志行合成一个 posture 闩」），那是外壳侧的改动，已具名登记，本轮不做。
 *
 * `healthy` / `reestablishing` 不补：前者本就无事发生，后者是几秒的过渡态，丢了不会留下持久假象。
 */
export function publishPostureWithFallback(
  posture: RuntimePosture,
  deps: { sendIpc: (payload: Record<string, unknown>) => boolean; logger: (line: string) => void },
): void {
  const delivered = deps.sendIpc(runtimePostureIpc(posture));
  if (delivered) return;
  const phrase = posture.kind === 'healthy' || posture.kind === 'reestablishing'
    ? undefined
    : POSTURE_HALT_PHRASES[posture.kind];
  if (!phrase) return;
  deps.logger(
    `[aidcp-edge] ⚠ ${phrase}：${(posture as { reason: string }).reason}`
      + '（运行态 IPC 未能送达外壳，改由日志如实声明；外壳白名单只让**这一行**翻红，'
      + '下一行普通日志就会把界面写回运行中——IPC 通道恢复前，这里给不出持久的红）',
  );
}
