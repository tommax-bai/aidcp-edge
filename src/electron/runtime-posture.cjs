'use strict';
/**
 * runtime-posture.cjs — 外壳侧的**唯一**一张「核心运行态 → 界面呈现」映射表。
 * ===========================================================================================
 * 契约与四态的定义在核心侧 `src/client/runtime-posture.ts`（那份文件头写了「谁是权威」「残局为什么
 * 必须单占一格」「哪些事实不能只放 lastMessage」三个问题的答案）。这里只做翻译，不做判断。
 *
 * 硬规矩（本文件存在的理由）：
 *   ① **外壳 MUST NOT 自己拼身份 / 停摆相关的状态。** 恢复、唤醒、崩溃、重连、日志行覆写——每一个
 *      入口都只能经这里取投影。此前每条入口各写各的（`resumeEdge` 在下发指令**之前**就把界面写成
 *      `{edge:'running', session:'running'}`，核心随后拒绝、而那条乐观投影没有任何东西来纠正），
 *      于是「外面看到的」与「里面发生的」按入口数量成比例地分岔。
 *   ② **闩住期间 posture 投影最后生效、且赢。** 日志行推断只允许写它自己那几项，四轴由这里压回去。
 *      只把诚实信号放在 `lastMessage` 里等于没放——下一行日志就把它冲掉了（复验实测：喂一行心跳即消失）。
 *   ③ 纯函数、零 Electron 依赖 ⇒ 可被用例直接驱动**真实现**（不是用例自己复制一份的闭包）。
 */

/** 与核心 `RUNTIME_POSTURE_KINDS` 逐字对齐；跨侧对账用例会比对两张表。 */
const RUNTIME_POSTURE_KINDS = ['healthy', 'reestablishing', 'identity_halted', 'automation_stalled'];
const RUNTIME_POSTURE_IPC_TYPE = 'lifecycle.runtime_posture';

/**
 * 解析核心发来的 posture IPC。形状不对一律返回 null（绝不半信半疑地拿一半字段去画界面）。
 * 返回 null 时调用方 MUST 忽略这条消息、保持原有闩不变。
 */
function parseRuntimePosture(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.type !== RUNTIME_POSTURE_IPC_TYPE) return null;
  const raw = message.posture;
  if (!raw || typeof raw !== 'object') return null;
  if (!RUNTIME_POSTURE_KINDS.includes(raw.kind)) return null;
  if (raw.kind === 'healthy') {
    const accountId = typeof raw.accountId === 'string' && raw.accountId ? raw.accountId : '';
    return accountId ? { kind: 'healthy', accountId } : { kind: 'healthy' };
  }
  const reason = typeof raw.reason === 'string' && raw.reason ? raw.reason : raw.kind;
  return { kind: raw.kind, reason };
}

/**
 * 唯一映射表：posture → 外界应当看到什么。
 *
 * 返回值分四格，各自的语义**不同**，调用方不许自行合并：
 *   `axes`     四轴补丁（只列本表拥有的键）。闩住期间它是权威，任何别的推断都得让位。
 *   `message`  当下这一行叙述（`lastMessage`，会被下一行日志覆写——所以绝不许承载终局事实）。
 *   `presence` 在场感文案（闩住期间同样由本表钉住）。
 *   `failure`  `undefined`=不动、`null`=清除、字符串=设为该摘要（持久卡片，日志行不许清）。
 */
function projectRuntimePosture(posture) {
  if (!posture) return { axes: {}, message: null, presence: null, failure: undefined };
  if (posture.kind === 'identity_halted') {
    // 终局：核心还活着但已彻底停摆——浏览停了、观测停了、云端连接被主动关掉（不自动重连、也不发断连事件）。
    // 核心**不退出**，所以退出码那条权威判据永远不触发；这条投影是运营唯一能看到的信号。
    return {
      axes: { edge: 'warning', session: 'idle', cloud: 'disconnected', auth: 'login required' },
      message: `运行期身份确立失败：${posture.reason}。自动化已停止、自动化引擎已断开，请在浏览器里重新登录该账号后重启本环境。`,
      presence: '身份已失效，请重新登录后重启',
      failure: `运行期身份确立失败：${posture.reason}`,
    };
  }
  if (posture.kind === 'automation_stalled') {
    // 残局：身份没问题，是自动化没跑起来。**MUST NOT** 讲成身份失败——那会把运营推去重新登录 + 重启，
    // 而真正有效的动作是点一次「恢复」。也 MUST NOT 讲成运行中——浏览与观测确实停着且无人会重启它们。
    return {
      axes: { edge: 'warning', session: 'idle' },
      message: `自动化已停摆：${posture.reason}。账号身份没有问题，但浏览与阻断观测都停着且不会自行恢复，请点「恢复」重新拉起。`,
      presence: '自动化已停摆，可点「恢复」重新拉起',
      failure: `自动化已停摆（身份正常）：${posture.reason}`,
    };
  }
  if (posture.kind === 'reestablishing') {
    // 过渡态：不是失败（别给红角标），也不是运行中（浏览停了、云端确实断了）。运营此刻什么都不用做。
    return {
      axes: { edge: 'running', session: 'idle', cloud: 'disconnected' },
      message: `正在重新确认账号身份（${posture.reason}）：浏览与阻断观测已暂停、自动化引擎连接已主动断开，稍候会自动恢复。`,
      presence: '正在重新确认账号身份…',
      failure: undefined,
    };
  }
  // healthy：带 accountId ⇒ 刚真正重新确立过一次身份，要把上一局闩住的红角标显式解除并告知运营。
  //          不带 ⇒ 只是「回到可判定态」（如一次被叫停作废的重立），不写任何文案、不动四轴。
  if (posture.accountId) {
    return {
      axes: { edge: 'running' },
      message: `运行期身份已重新确立：${posture.accountId}，自动化引擎恢复正常。`,
      presence: '身份已重新确立',
      failure: null,
    };
  }
  // 不带 accountId 的 healthy（重立被叫停作废 / 恢复自动化放行）：四轴与文案都交还给别的入口去写，
  // **但在场感必须显式落回中性**——它是闩住期间被钉住的那一句（「正在重新确认账号身份…」），
  // 解闩不会自动把它擦掉，留着就会永远挂在界面上讲一件已经结束的事。
  return { axes: {}, message: null, presence: '账号身份正常', failure: null };
}

/**
 * 闩住判据：非健康 posture ⇒ 此后每一次状态更新都要把四轴压回投影值。
 * `healthy` 不闩（正常推断照旧）。
 */
function postureLatches(posture) {
  return Boolean(posture) && posture.kind !== 'healthy';
}

/**
 * 给日志行推断用的**覆盖层**：闩住时返回 `{ axes, presence }`，否则返回 null。
 *
 * 用法是「算完 next 之后最后 Object.assign 上去」——顺序即语义：posture 必须**赢**。
 * 少了它，`edge:'warning'` 能靠 halting 判据活下来，但 `session` / `cloud` / `auth` 会被下一行
 * 普通日志（「浏览循环结束」「已连接云端」…）改回去，界面重新变成半绿半红的自相矛盾态。
 */
function runtimePostureOverride(posture) {
  if (!postureLatches(posture)) return null;
  const projection = projectRuntimePosture(posture);
  return { axes: projection.axes, presence: projection.presence };
}

/**
 * 恢复自动化的准入（外壳侧，判 posture）。
 *
 * 这**不是**核心那道闸的镜像——两侧判的根本不是同一件事：核心侧是 `identity-guard.ts` 的
 * `resumeAutomationUnderIdentityGate`（按身份健康度判），外壳侧是这里（按 posture 判）。
 * 曾有一个自称「两侧共用」的判据，实际零调用方，已删；别再造第二个。
 *
 * 外壳先判一次，是为了**不产生那条乐观投影**：核心侧的拒绝走的是抛异常，`lifecycle.resumed` 因此
 * 永不发出，而外壳早在下发指令前就把界面写成了运行中——没有任何东西会来纠正它。先判再发，界面就
 * 不会先说一句假话再等一条永远不来的更正。核心侧那道闸照旧保留（防外壳闩陈旧的竞态）。
 */
function judgeResumeUnderPosture(posture) {
  if (posture && posture.kind === 'identity_halted') {
    return {
      kind: 'refuse',
      message: `无法恢复自动化：运行期身份确立失败（${posture.reason}）。恢复不会带来任何新的身份事实——`
        + '请在浏览器里重新登录该账号后重启本环境。',
      presence: '身份已失效，恢复无效，请重新登录后重启',
    };
  }
  return { kind: 'allow' };
}

// ===========================================================================================
// 闩的作用域、覆盖层的施加、恢复按钮的准入 —— 三处都做成**可注入实现**，宿主只剩一行接线
// ===========================================================================================
//
// 上一轮这三处的动作留在 `src/electron/main.cjs`（一个 Electron 耦合、无法 require 的巨型文件）里，
// 用例只能扫源码文本。复验实测坐实文本扫描抓不住这一族：
//   - 覆盖层**整块位置挪动**（从 updateStatus 之前挪到日志推断之前）⇒ 全绿，而覆写症状完整复活；
//   - 恢复被拒分支里删掉 `return;`（继续往下写 running 并下发恢复）⇒ 全绿；
//   - close 分支的清闩删掉（同一字面串在三处出现，扫描只要求存在其一）⇒ 全绿。
// 现在这三处的判据与动作都在本文件里，宿主只做一次调用或一次包裹。

/**
 * 闩的作用域＝**说这句话的那个核心**。
 *
 * 上一轮靠三处 `handle.runtimePosture = null`（拉起前 / spawn 失败 / close）手工清闩来保证这件事，
 * 于是「删掉其中一处」既扫不出也测不到。现在改成读的时候判：posture 只在**声明它的那个子进程仍是
 * 当前子进程**时有效。核心没了或换了一代 ⇒ 这个闩不再描述任何东西，一律作废。
 * 这样「闩只属于本次 core run」就是结构性的，不再依赖三处记得清。
 */
function postureOfLiveCore(posture, declaredBy, currentChild) {
  if (!posture) return null;
  if (!currentChild || !declaredBy || declaredBy !== currentChild) return null;
  return posture;
}

/**
 * 收到一条 posture 之后：闩怎么变、界面该写什么。
 *
 * 两条规则，各自都对应一个实测出来的回归：
 *
 * ① **健康态只在真闩着时才动界面。** 常态下每次冷待机唤醒都会来一条 `healthy{accountId}`
 *    （唤醒确实实测过身份），而健康态投影会写 `edge:'running'`、写「身份已重新确立」、**并清掉失败
 *    卡片**。于是一个已暂停、挂着一张与身份无关的失败卡片（例如代理运行证据缺失）的环境，被唤醒后
 *    就变成「运行中 + 无卡片 + 身份已重新确立」——一次从未出过问题的普通唤醒，凭空把别人的失败态擦了。
 *    健康态投影的**用途**本来就是「解除上一局闩住的红角标」；没有闩可解时它无事可做。
 *
 * ② **关闭意图优先。** 外壳别处早已写明「迟到的唤醒不得把状态翻回已打开」，而 posture 这一笔比它
 *    先到、且没有同款守卫。于是在「唤醒撞上关闭」这个代码自己承认的真实竞态里，界面被写成运行中
 *    且没有任何东西来纠正。这里补上同一条守卫：正在关闭 / 已移除 / 正在退出时只更新闩、不画界面
 *    （关闭路径随后会写它自己的终态）。
 */
function runtimePostureTransition(previousLatch, posture, context) {
  const closeIntent = Boolean(context && context.closeIntent);
  const latch = postureLatches(posture) ? posture : null;
  if (closeIntent) return { latch, patch: null };
  if (!postureLatches(posture) && !postureLatches(previousLatch)) return { latch, patch: null };
  const projection = projectRuntimePosture(posture);
  const hasContent = Object.keys(projection.axes).length > 0
    || projection.message !== null
    || projection.presence !== null
    || projection.failure !== undefined;
  return { latch, patch: hasContent ? projection : null };
}

/**
 * posture 投影 → 真正落盘的状态补丁。四格语义各不相同（见 projectRuntimePosture 的注释），
 * 这里是它们**唯一**一处被翻译成补丁字段的地方。
 *
 * 为什么它必须在本文件而不是留在 `main.cjs`：`failure` 那一格是**持久失败卡片的唯一写入口**——
 * 终局与残局的红卡全靠它落盘，删掉它，闩还在、四轴还压得住，但那张说清「发生了什么、该怎么办」的
 * 卡片永不出现。复验实测：它留在 main.cjs 里时零覆盖，整格删掉全套用例零红（用例自己抄了一份
 * 等价逻辑，抄的那份当然照常通过）。现在用例驱动的就是它本身。
 *
 * 宿主只提供两类（共三个回调）它自己才知道怎么做的事：在场感补丁怎么带时间戳、失败卡片怎么写 /
 * 怎么清（清的那一步还要顺手把宿主的「上一条失败行」记忆抹掉，那是 main.cjs 的私有状态）。
 */
function posturePatchFrom(projection, deps) {
  return {
    ...projection.axes,
    ...(projection.message ? { lastMessage: projection.message } : {}),
    ...(projection.presence ? deps.presencePatch(projection.presence) : {}),
    ...(projection.failure === undefined
      ? {}
      : projection.failure === null
        ? deps.clearFailure()
        : deps.setFailure(projection.failure)),
  };
}

/**
 * 把 posture 覆盖层施加到一份**已经算完**的状态补丁上，返回要真正落盘的那一份。
 *
 * 顺序即语义：posture 必须**赢**。上一轮这是日志行处理函数末尾的一整块 `if (postureOverride) …`，
 * 而用例只能断言「这块在源码里出现，且在 updateStatus 之前」——把整块挪到日志推断**之前**，
 * 断言照样成立（`indexOf` 从覆盖层往后找，仍找得到末尾那次 updateStatus），而覆写症状完整复活。
 * 现在它是一次纯函数合成，直接写在那唯一一次落盘调用的实参位置上：**没有可以挪动的块**。
 */
function commitPatchUnderPosture(posture, next, nowIso) {
  const override = runtimePostureOverride(posture);
  if (!override) return next;
  const merged = Object.assign({}, next, override.axes);
  if (override.presence) merged.presence = { text: override.presence, at: nowIso };
  return merged;
}

/**
 * 「恢复自动化」按钮的整段准入：拒绝时**只**写拒绝态、并且绝不往下走。
 *
 * 上一轮宿主里是 `if (verdict.kind === 'refuse') { updateStatus(...); return; }`——删掉那句 `return;`，
 * 界面照样被写成运行中、恢复指令照常下发，而全套用例零红。现在分支在这里，`proceed` 由本函数决定调不调。
 */
function runResumeUnderPosture(posture, deps) {
  const verdict = judgeResumeUnderPosture(posture);
  if (verdict.kind === 'refuse') {
    deps.refuse({
      edge: 'warning',
      session: 'paused',
      lastMessage: verdict.message,
      presence: verdict.presence,
    });
    return false;
  }
  deps.proceed();
  return true;
}

module.exports = {
  RUNTIME_POSTURE_KINDS,
  RUNTIME_POSTURE_IPC_TYPE,
  parseRuntimePosture,
  projectRuntimePosture,
  postureLatches,
  postureOfLiveCore,
  runtimePostureTransition,
  posturePatchFrom,
  commitPatchUnderPosture,
  runtimePostureOverride,
  judgeResumeUnderPosture,
  runResumeUnderPosture,
};
