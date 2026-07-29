/**
 * identity-guard.ts — 运行期身份持续校验 + 身份重立链（change restore-native-xiaohongshu-session-guards §5）
 * ===========================================================================================
 * 身份是「持续校验的状态」，不是握手时定死一次。只在启动与冷待机唤醒各读一次**不算**满足：
 * 长跑会话中途换号 / 掉登录会一秒都发现不了，之后的全部记账都挂在错账号上。
 *
 * 本模块两件东西，都是**纯注入**的（时钟 / 身份读取 / 页面上下文 / 探针读数 / 各副作用句柄全部由
 * 调用方给）。宿主 `src/main.ts` 只做薄接线。这样做的唯一原因是可测性：`main.ts` 是一个无导出的
 * 单 `main()`，判定表内联进去之后，所有断言都只能退化成源码文本扫描——而否定式的文本断言在被测
 * 代码被删光之后**恒真**（假绿）。判定表放这里，T1–T7 才是真行为测试。
 *
 * ── 一、周期校验体 `IdentityRevalidator` ──
 * 判定顺序是**严格短路**的，顺序本身就是不变量（逐格对照退役实现 `src/browse/identity-watcher.ts`）：
 *
 *   ① 已判失效 / 正在检查        → 直接返回（「只 emit 一次」的基座 + 重入保护）
 *   ② 读页面上下文抛异常          → 当 `unknown`
 *   ③ `creator-app`（创作子域真实页，自带登录门禁）→ **健康 + 计数清零**
 *        不清零就会跨页凑够阈值：发布把标签页带到创作子域时会被误杀。
 *   ④ `unknown`（about:blank / 非小红书 / 导航中途）→ **跳过**：不计失效、不判健康，留一行日志
 *        MUST NOT 清零（清零＝假愈），MUST NOT 计数（计数＝误杀）。
 *   ⑤ `creator-login`（创作子域被重定向到 /login）→ `lost`，进计数（确凿登出）
 *   ⑥ `consumer` + 就地读出 id == 基线 → 健康 + 清零
 *   ⑦ `consumer` + 就地读出 id != 基线 → `changed{newId}`，进计数（重立链要用这个新 id 换云端会话）
 *   ⑧ `consumer` + 读不出锚点 → 交给**正向登出探针**（见下），只有判定为「确实登出」才进计数
 *   ⑨ 就地读身份抛异常 → `lost`，进计数（防抖阈值兜住瞬时）
 *   ⑩ 计数达阈值 → 置 `lastReason`、`state='invalid'`、回调**恰一次**
 *
 * 身份读取 MUST 是「只读 + 不导航」的就地读——绝不每轮把页面拽走。这一条由调用方注入的
 * `readIdentity` 保证（宿主传的是 `readPlatformIdentity({ allowNavigate: false })`）。
 *
 * ── 二、正向登出探针的新鲜度守卫（相对退役实现的**具名偏离**）──
 * 退役实现的 `confirmLoggedOut` 缺省是 `async () => true`：读不到就按登出计（保守）。
 * Native 形态下这条探针的读数来自周期阻断观测的 `observationStatus()`，而那份读数是 **sticky 缓存**
 * ——探测失败时保持上一状态不翻转。于是「探针说 login」可能只是**几分钟前**的陈旧结论。
 *
 * 把陈旧读数压成「真登出」＝把「读不到」和「没有」压成一态（红线），会造出一台误报机：
 * 探针一坏，健康账号被连续判 lost、重立链把它拖回无身份态。
 * 故本实现把探针读数分成三态：
 *   - `logged_out`      读数**新鲜**且 `blockingKind==='login'` → 确实看见登录墙，判 lost
 *   - `not_logged_out`  读数**新鲜**且非 login → 疑似无侧栏页 / 弹层态（AI 搜索、看图态），本轮跳过
 *   - `unconfirmable`   观测体缺席 / 已暂停 / 从未成功探测过 / 读数超过陈旧预算 → **无法确认**，本轮跳过
 * 三者里只有第一态进计数。第三态是**显式登记的、有界的诚实缺口**：真登出且探针同时坏掉时会漏判，
 * 补偿是 ⑤（创作子域 /login）仍直判 lost，且陈旧连续超过 `livenessAlertStreak` 拍时打一条**存活告警**
 * （只告警，绝不升级为失效）。
 *
 * ── 三、身份重立链 `createIdentityReestablishment` ──
 * 两条硬约束（验收锚，写死在顺序里）：
 *   **A —— 在途发布诚实判失败 MUST 早于断开云端连接。** 失败回执经边-云 WS 发出；连接断了以后
 *      `send` 只能 best-effort 失败，云端就**无限期挂起等结果**。
 *   **B —— 先导航回消费端首页、再就地重读；归位后仍读不出 ⇒ 停在无身份态。** 触发失效时页面可能
 *      停在创作发布页 / 弹层态、根本没有「我」锚点，原地读必然读不出 ⇒ 无谓停摆。归位后仍读不出，
 *      halt 分支 MUST 是**纯返回**：不换身份、不重连云端、不重启浏览、**绝不回落默认账号**（红线）。
 */
import type { IdentityDecision, SelfIdentityResult } from '../cdp/self-identity.js';

export type IdentityHealth = 'healthy' | 'invalid';
export type IdentityInvalidReason = { kind: 'lost' } | { kind: 'changed'; newId: string };
/** 身份校验上下文分域。与 `src/cdp/self-identity.ts` 的 `PageContext` 同形（此处独立声明以免反向依赖）。 */
export type IdentityPageContext = 'consumer' | 'creator-app' | 'creator-login' | 'unknown';

/**
 * 周期阻断观测的存活读数（`NativeBrowseSession.observationStatus()` 的结构形状）。
 * `msSinceLastOkProbe === undefined` 明确表示**一次都没成功探测过**，与「探测成功但没看到情况」是两态。
 */
export interface ObservationLiveness {
  running: boolean;
  suspended: boolean;
  blockingKind: 'none' | 'login' | 'captcha' | 'unknown';
  consecutiveProbeFailures: number;
  msSinceLastOkProbe?: number;
}

export type LogoutProbeVerdict = 'logged_out' | 'not_logged_out' | 'unconfirmable';
export interface LogoutProbeReading {
  verdict: LogoutProbeVerdict;
  detail: string;
}

export const DEFAULT_IDENTITY_CHECK_MS = 30_000;
export const DEFAULT_IDENTITY_FAIL_THRESHOLD = 2;
/** 与 `NativeBrowseSession` 的 `DEFAULT_OBSERVATION_INTERVAL_MS` 同值；宿主按 env 实配值注入。 */
export const DEFAULT_OBSERVATION_INTERVAL_MS = 2_000;
/** 探针读数的陈旧预算 = 本系数 × 观测节拍。超出即判「无法确认」。 */
export const DEFAULT_OBSERVATION_STALENESS_FACTOR = 3;
/** 连续多少拍判「无法确认（陈旧）」后打一条存活告警。只告警，不升级为失效。 */
export const DEFAULT_LIVENESS_ALERT_STREAK = 3;

export interface IdentityRevalidatorOptions {
  /** 校验节拍（ms，默认 30 000）。宿主经 `AIDCP_IDENTITY_CHECK_MS` 配置。 */
  intervalMs?: number;
  /** 连续判失效阈值（默认 2，防抖）。宿主经 `AIDCP_IDENTITY_FAIL_THRESHOLD` 配置。 */
  threshold?: number;
  /** 周期阻断观测的节拍（ms），用于推导探针读数的陈旧预算。 */
  observationIntervalMs?: number;
  stalenessFactor?: number;
  livenessAlertStreak?: number;
  logger?: (msg: string) => void;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (handle: ReturnType<typeof setInterval>) => void;
  /** 读当前页的身份判定上下文（宿主传 `readPageContext(session.cdp)`）。 */
  readPageContext: () => Promise<IdentityPageContext>;
  /** 就地读自身稳定 id。**MUST 是 allowNavigate:false 的只读实现**——绝不每轮把页面拽走。 */
  readIdentity: () => Promise<SelfIdentityResult>;
  /** 周期阻断观测读数；观测体尚未装配时返回 undefined（按「无法确认」处置，绝不按登出计）。 */
  observationStatus: () => ObservationLiveness | undefined;
}

export class IdentityRevalidator {
  private state: IdentityHealth = 'healthy';
  private consecutive = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private stalenessStreak = 0;
  private livenessAlerted = false;
  private onInvalid?: (reason: IdentityInvalidReason) => void;

  /** 最近一次判失效的原因（重立链据此拼人话与换 id）。 */
  lastReason: IdentityInvalidReason | null = null;

  private readonly intervalMs: number;
  private readonly threshold: number;
  private readonly stalenessBudgetMs: number;
  private readonly livenessAlertStreak: number;
  private readonly log: (msg: string) => void;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearTimer: (handle: ReturnType<typeof setInterval>) => void;

  constructor(private baselineId: string, private readonly opts: IdentityRevalidatorOptions) {
    this.intervalMs = Math.max(1, opts.intervalMs ?? DEFAULT_IDENTITY_CHECK_MS);
    this.threshold = Math.max(1, opts.threshold ?? DEFAULT_IDENTITY_FAIL_THRESHOLD);
    const observationIntervalMs = Math.max(1, opts.observationIntervalMs ?? DEFAULT_OBSERVATION_INTERVAL_MS);
    const factor = Math.max(1, opts.stalenessFactor ?? DEFAULT_OBSERVATION_STALENESS_FACTOR);
    this.stalenessBudgetMs = observationIntervalMs * factor;
    this.livenessAlertStreak = Math.max(1, opts.livenessAlertStreak ?? DEFAULT_LIVENESS_ALERT_STREAK);
    this.log = opts.logger ?? (() => undefined);
    this.setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearInterval(h));
  }

  get health(): IdentityHealth {
    return this.state;
  }

  /** 当前连续疑似失效次数（测试与诊断用；阈值满即判失效并清空不是它的职责）。 */
  get consecutiveFailures(): number {
    return this.consecutive;
  }

  get baseline(): string {
    return this.baselineId;
  }

  /** 重设基线 id（身份重新确立后调用）+ 复位为健康态。缺了它，重立完仍是 invalid、校验体永久哑火。 */
  rebaseline(id: string): void {
    this.baselineId = id;
    this.state = 'healthy';
    this.consecutive = 0;
    this.lastReason = null;
    this.stalenessStreak = 0;
    this.livenessAlerted = false;
  }

  /** 启动周期校验。幂等：已在跑则只更新回调、不重复武装定时器。 */
  start(onInvalid?: (reason: IdentityInvalidReason) => void): void {
    this.onInvalid = onInvalid;
    if (this.timer) return;
    this.timer = this.setTimer(() => void this.check(), this.intervalMs);
    this.timer.unref?.();
  }

  /** 停止周期校验。幂等。 */
  stop(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /**
   * 正向登出探针：把 sticky 的观测读数翻译成三态。
   * 三态而非两态是本实现相对退役实现的具名偏离，理由见文件头「二」。
   */
  probeLogout(): LogoutProbeReading {
    const status = this.opts.observationStatus();
    if (!status) return { verdict: 'unconfirmable', detail: '周期阻断观测尚未装配' };
    if (status.suspended) return { verdict: 'unconfirmable', detail: '周期阻断观测已暂停' };
    if (status.msSinceLastOkProbe === undefined) {
      return { verdict: 'unconfirmable', detail: '周期阻断观测一次都没成功探测过' };
    }
    if (status.msSinceLastOkProbe > this.stalenessBudgetMs) {
      return {
        verdict: 'unconfirmable',
        detail: `周期阻断观测读数陈旧（${status.msSinceLastOkProbe}ms > 预算 ${this.stalenessBudgetMs}ms，连续失败 ${status.consecutiveProbeFailures} 次）`,
      };
    }
    return status.blockingKind === 'login'
      ? { verdict: 'logged_out', detail: '登录墙可见' }
      : { verdict: 'not_logged_out', detail: `无登录墙（blockingKind=${status.blockingKind}）` };
  }

  /** 单次校验（可直接调用以单测）。判失效后置 invalid 并回调一次，不再重复回调。 */
  async check(): Promise<void> {
    if (this.checking || this.state === 'invalid') return;
    this.checking = true;
    try {
      // 先按页面上下文分域，绝不不看页面就一律用消费端锚点判定
      // （否则发布把标签页带到创作子域时会误判登出）。
      const ctx = await this.opts.readPageContext().catch((): IdentityPageContext => 'unknown');
      if (ctx === 'creator-app') {
        // 创作平台真实页自带登录门禁：能停在这＝已登录 → 健康、清零。
        this.consecutive = 0;
        return;
      }
      if (ctx === 'unknown') {
        // 本轮跳过——既不计失效也不判健康（不误杀、不假愈）。
        this.log('[identity-guard] 当前页无法判定身份（非消费 / 创作已知页）→ 无法确认，本轮跳过');
        return;
      }
      let reason: IdentityInvalidReason | null = null;
      if (ctx === 'creator-login') {
        // 创作子域被重定向到 /login = 确凿登出。这一格不受探针新鲜度影响，是上面那条诚实缺口的补偿。
        reason = { kind: 'lost' };
      } else {
        try {
          const res = await this.opts.readIdentity();
          if (res.ok) {
            if (res.identity.accountId === this.baselineId) {
              this.consecutive = 0;
              this.resetStalenessStreak();
              return;
            }
            reason = { kind: 'changed', newId: res.identity.accountId };
          } else {
            const probe = this.probeLogout();
            if (probe.verdict === 'logged_out') {
              reason = { kind: 'lost' };
            } else {
              if (probe.verdict === 'unconfirmable') this.noteStaleness(probe.detail);
              else this.resetStalenessStreak();
              this.log(
                `[identity-guard] 消费页无本人锚点，正向登出探针判「${probe.verdict}」（${probe.detail}）→ 本轮跳过，不计失效`,
              );
              return;
            }
          }
        } catch {
          reason = { kind: 'lost' }; // 读取异常按登出计一次（防抖阈值兜住瞬时）
        }
      }
      this.resetStalenessStreak();
      this.consecutive += 1;
      this.log(
        `[identity-guard] 身份疑似失效（${reason.kind}${reason.kind === 'changed' ? `→${reason.newId}` : ''}），连续 ${this.consecutive}/${this.threshold}`,
      );
      if (this.consecutive >= this.threshold) {
        this.lastReason = reason;
        this.state = 'invalid';
        this.onInvalid?.(reason);
      }
    } finally {
      this.checking = false;
    }
  }

  private noteStaleness(detail: string): void {
    this.stalenessStreak += 1;
    if (this.stalenessStreak >= this.livenessAlertStreak && !this.livenessAlerted) {
      this.livenessAlerted = true;
      // 只告警、绝不升级为失效：这是一条**登记在案的诚实缺口**——探针坏掉期间真登出会被漏判，
      // 但把「看不见」说成「确实登出」会造出误报机，后者更坏。
      this.log(
        `[identity-guard] ⚠ 正向登出探针已连续 ${this.stalenessStreak} 拍无法确认（${detail}）：` +
          '这期间的真登出会被漏判。只告警、不判失效。',
      );
    }
  }

  private resetStalenessStreak(): void {
    this.stalenessStreak = 0;
    this.livenessAlerted = false;
  }
}

// ===========================================================================================
// 身份重立链
// ===========================================================================================

export interface IdentityReestablishmentDeps {
  logger: (msg: string) => void;
  /** 步 2：停全部周期观测。 */
  suspendObservation: (reason: string) => void;
  /** 步 3：停浏览（等浏览循环真正退出原子区）。 */
  stopBrowse: () => Promise<void>;
  /** 步 4：在途发布诚实判失败。**MUST 早于 `disconnectCloud`**（硬约束 A）。 */
  failInFlightPublishesHonestly: (reason: string) => void;
  /** 步 4.5：租约仲裁（见下方 W5 裁定注释）。 */
  hasActiveLease: () => boolean;
  resetTaskCoordinator: (reason: string) => void;
  /** 步 5：断开云端连接。 */
  disconnectCloud: () => Promise<void>;
  /** 步 6：先导航回消费端首页（失败只记日志、不中断链条，与退役实现同）。 */
  navigateToConsumerHome: () => Promise<void>;
  /** 步 7：就地重读身份（allowNavigate:false）。 */
  readIdentity: () => Promise<SelfIdentityResult>;
  /** 步 8：身份决策。 */
  decideIdentity: (res: SelfIdentityResult) => IdentityDecision;
  nicknameFor: (res: SelfIdentityResult, decision: IdentityDecision) => string | undefined;
  /** 步 9：换身份（写宿主 accountId / 昵称并告知云端客户端）。 */
  applyIdentity: (accountId: string, nickname: string | undefined) => void;
  /** 步 10：按新 id 重连云端（云端据此拆旧会话 + 重过就绪闸）。 */
  connectCloud: () => Promise<void>;
  /** 步 11：重设周期校验体基线。 */
  rebaseline: (accountId: string) => void;
  /** 步 13：重启周期观测。 */
  resumeObservation: () => void;
  /** 步 14：重启浏览。 */
  startBrowse: () => void;
}

export type IdentityReestablishmentOutcome =
  | { kind: 'reestablished'; accountId: string }
  | { kind: 'halted'; reason: string }
  | { kind: 'skipped'; reason: 'already_running' };

function describeReason(reason: IdentityInvalidReason | null): string {
  if (!reason) return '未知';
  return reason.kind === 'changed' ? `换号→${reason.newId}` : '登出 / 过期';
}

/**
 * 身份重立链。返回一个可重入保护的执行函数。
 *
 * 顺序即不变量，逐步对照退役实现 `317cd47^:src/main.ts:1035-1102`。两条硬约束见文件头「三」。
 */
export function createIdentityReestablishment(
  deps: IdentityReestablishmentDeps,
): (reason: IdentityInvalidReason | null) => Promise<IdentityReestablishmentOutcome> {
  let running = false;
  return async (reason) => {
    if (running) return { kind: 'skipped', reason: 'already_running' };
    running = true;
    try {
      const reasonText = describeReason(reason);
      const flipReason = `identity_flip:${reason?.kind ?? 'unknown'}`;
      deps.logger(`[identity-guard] ⚠ 运行期身份失效（${reasonText}）：停自动化、退回无身份态并尝试重新确立身份`);

      // 步 2 / 3：先把两套周期活动停住，避免重立期间还有人对页面动手。
      deps.suspendObservation(flipReason);
      await deps.stopBrowse();

      // 步 4（硬约束 A）：**在断开云端之前**把在途发布诚实判失败，否则失败回执发不出去、
      // 云端无限期挂起等结果。
      deps.failInFlightPublishesHonestly(flipReason);

      // 步 4.5（本 change 裁定）：身份已经翻转时绝不「静默等租约结束」——那会让身份翻转无限期不生效。
      // 在已翻转的身份下继续跑租约任务，会把记账挂到错账号，比诚实中止任务更坏。故照走并当场中止租约。
      if (deps.hasActiveLease()) {
        deps.logger('[identity-guard] 身份翻转时仍有活跃任务租约：当场中止（绝不在已翻转的身份下继续记账）');
        deps.resetTaskCoordinator(flipReason);
      }

      // 步 5：断开云端。
      await deps.disconnectCloud();

      // 步 6（硬约束 B 前半）：先导航回消费端首页再读。触发失效时页面可能停在创作发布页 / 弹层态，
      // 原地读必然读不出 ⇒ 无谓停摆。导航失败只记日志、照样往下读（与退役实现同，不更坏）。
      try {
        await deps.navigateToConsumerHome();
      } catch (error) {
        deps.logger(
          `[identity-guard] 归位消费端首页失败（${error instanceof Error ? error.message : String(error)}）：退回原地重读`,
        );
      }

      // 步 7 / 8：就地重读 + 决策。
      const idRes = await deps.readIdentity();
      const decision = deps.decideIdentity(idRes);
      if (decision.kind === 'halt') {
        // 硬约束 B 后半：halt MUST 是**纯返回**——不换身份、不重连云端、不重启浏览与观测，
        // **绝不回落默认账号**。浏览器保住，等人重新登录后由外壳重来。
        deps.logger(
          `[identity-guard] ✗ 归位后仍读不出稳定账号 id（${decision.reason}）：停在无身份态，不重连云端、绝不回落默认账号。` +
            '请在浏览器里重新登录目标账号后重启本节点。',
        );
        return { kind: 'halted', reason: decision.reason };
      }

      // 步 9 / 10：换身份并按新 id 重连（云端据此拆旧会话）。
      const accountId = decision.accountId;
      deps.applyIdentity(accountId, deps.nicknameFor(idRes, decision));
      await deps.connectCloud();

      // 步 11：重设基线，否则校验体停在 invalid、此后永久哑火。
      deps.rebaseline(accountId);

      // 步 12 —— 【5.6 待人裁定：此处是退役实现步 12「重注入连接级节奏快照」的位置】
      // 该步在 Native 形态下的归属未定（见 change tasks.md 5.6 / design.md「待裁定」§1）。
      // 未裁定前**不实现、也不写静默兜底**：写一个「顺手 applyPacingSnapshot」在这里，等于替裁定人
      // 做了决定；写一个空 catch 则是静默假成功。故此处只留具名占位。

      // 步 13 / 14：重启周期观测与浏览。
      deps.resumeObservation();
      deps.startBrowse();
      deps.logger(`[identity-guard] ✓ 身份已重新确立：${accountId}（云端会话已按新身份重建，自动化已恢复）`);
      return { kind: 'reestablished', accountId };
    } finally {
      running = false;
    }
  };
}
