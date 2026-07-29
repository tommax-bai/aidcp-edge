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
 * 四条硬约束（验收锚，写死在顺序里）：
 *   **A —— 在途发布诚实判失败 MUST 早于断开云端连接。** 失败回执经边-云 WS 发出；连接断了以后
 *      `send` 只能 best-effort 失败，云端就**无限期挂起等结果**。
 *   **B —— 先导航回消费端首页、再就地重读；归位后仍读不出 ⇒ 停在无身份态。** 触发失效时页面可能
 *      停在创作发布页 / 弹层态、根本没有「我」锚点，原地读必然读不出 ⇒ 无谓停摆。归位后仍读不出，
 *      halt 分支 MUST 是**纯返回**：不换身份、不重连云端、不重启浏览、**绝不回落默认账号**（红线）。
 *      归位是一次整页重载，**读预算必须给足**（见 `REESTABLISH_IDENTITY_READ_HYDRATE_MS`）：拿周期
 *      校验那种小预算来读刚开始导航的页面，读到的只是「还没渲染完」，把它判成终局＝红线「慢不是失败」。
 *   **C —— 运行期身份只认实测值，`AIDCP_ACCOUNT_ID` 覆盖在这里没有任何权威**（见 `judgeRuntimeIdentity`）。
 *   **D —— 宿主叫停（暂停 / 冷待机 / 停用）后，在途链条 MUST 当场作废**（见「四、代际判据」）。
 *
 * ── 四、代际判据（宿主叫停的取消点）──
 * `IdentityRevalidator.stop()` 只清定时器是不够的：它既拦不住**已经在途**的一次 `check()`，也拦不住
 * 已经在跑的重立链。冷待机的契约是「保留云端连接」，而重立链第 5 步就会主动关掉云端连接（那是
 * `intentionalClose`，**不会自动重连、也不会 emit 断连事件**）——一次没拦住的在途链条就能把待机中的
 * 节点变成外壳再也叫不醒的砖。故：`stop()` **递增代际**；在途 `check()` 与在途链条在**每个 await 点**
 * 复查代际，变了即当场作废。作废时链条会**回滚它自己做过的两件外部改动**（暂停观测 / 断开云端），
 * 因为宿主并没有要求这两件事——不回滚就是把「取消」做成了另一种静默损坏。
 *
 * ── 五、判失效之后由**链条回执**收口（三态，绝不压成一态）──
 * 「已判失效」不是终局，只是**把球交给了重立链**。故健康态是三态而非两态：
 *
 *   `healthy`        校验在跑，逐拍判定
 *   `reestablishing` 阈值已满、`onInvalid` 已发**恰一次**，链条持球；本态**抑制**后续 check
 *                    （不重复拉链条、不对着正在被替换的基线计数）
 *   `invalid`        **终局**：链条跑完且结论是停手（halt / 自身异常）。只有一次**真正的**
 *                    身份重立（`rebaseline`）能解除它。
 *
 * 三种链条回执各有归宿，`noteReestablishmentOutcome()` 一处收口：
 *   - `reestablished` 链条内部已 `rebaseline` ⇒ 已回 healthy，这里不再动
 *   - `halted` / `crashed` ⇒ 终局 `invalid`（做完了，结论是停手）
 *   - `aborted` ⇒ **退回 `healthy`，基线保持旧值**（这次没做完，不是结论）
 *
 * 最后一条是本文件唯一容易做错的一格，写清楚理由：作废之后基线还是**旧的**，所以退回 healthy
 * **吞不掉**任何真实翻转——恰恰相反，只有退回 healthy 才能让下一拍拿旧基线重新把翻转判出来。
 * 反过来，把作废留在 `invalid` 上就是永久哑火：`check()` 首行早退、`rebaseline` 又永远等不到
 * （链条正是在到达它之前被作废的），于是暂停→恢复之后节点可能正跑在错误身份下，且**再也测不出换号**。
 * 「装了但永久不工作」就是静默假成功的产品层形态，本模块的存在理由不能在自己身上复发。
 *
 * 同样要点名的是**不该**加的那种修法：MUST NOT 在 `start()` / 恢复路径上「兜底把 state 改回 healthy」。
 * `resumeAutomation` 与 CDP 重连都会调 `start()`，那样写会把一个**真正 halt** 的节点在下一次恢复时
 * 洗成健康——把「读不出身份、已停在无身份态」悄悄变回「一切正常」。复位只挂在**链条回执**这条边上。
 */
import type { IdentityDecision, ReadSelfIdentityOptions, SelfIdentityResult } from '../cdp/self-identity.js';

/**
 * 校验体健康态三态（文件头「五」）。`reestablishing` 是**中间态**（链条持球），`invalid` 是**终局**。
 * 两者曾经是同一个 `invalid`，代价是链条一被作废就永久哑火——它们 MUST NOT 再被压回一态。
 */
export type IdentityHealth = 'healthy' | 'reestablishing' | 'invalid';
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

/**
 * 周期校验的就地读预算（ms）。**故意很小**：这一拍读不出就跳过，30s 后还有下一拍，
 * 没有任何理由为它把 CDP 占住几秒。
 */
export const PERIODIC_IDENTITY_READ_HYDRATE_MS = 1_000;

/**
 * 重立链「归位后重读」的预算（ms）。**故意很大**，与上面那个是两个完全不同的需求：
 * 归位是一次 `Page.navigate` 整页重载，而 CDP 的 `Page.navigate` 在导航**开始**时就返回、不等 load。
 * 拿 1s 去读一个刚开始加载的首页，读到的必然是「锚点还没渲染出来」——把它当成「读不出身份」就是把
 * 「慢」判成终局失败（红线），后果是一个只不过换了个号的健康节点被永久停在无身份态。
 * 退役实现在同一步用的是 reader 默认的 6000ms，且注释明写靠它「等锚点渲染出来」；这里给到 10s，
 * 覆盖冷网络下的整页重载 + 水合。这一步慢几秒毫无代价：此刻浏览已停、云端已断，没人在等它。
 */
export const REESTABLISH_IDENTITY_READ_HYDRATE_MS = 10_000;

/**
 * 归位后重读的读取选项。**只读、不导航**（红线：绝不把页面拽走）+ 足量水合预算。
 * 做成函数而不是让宿主自己拼，是因为「用哪个预算」正是本文件的判据，不该散落在无法单测的宿主装配里。
 */
export function reestablishIdentityReadOptions(): ReadSelfIdentityOptions {
  return { allowNavigate: false, hydrateTimeoutMs: REESTABLISH_IDENTITY_READ_HYDRATE_MS };
}

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
  /** 代际：每次 `stop()` 递增。在途 `check()` 与在途重立链据此当场作废（文件头「四」）。 */
  private currentGeneration = 0;

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

  /**
   * 重设基线 id（身份**真正**重新确立后调用）+ 复位为健康态。缺了它，重立完仍停在「重立中」、
   * 校验体永久哑火。这是 `invalid` 终局唯一的解除方式。
   *
   * **它只有两个合法调用点，两个都必须是「刚刚在页面上实测到一个稳定 id」**：
   *   ① 重立链步 11（`verdict.accountId`，归位后重读出来的）；
   *   ② 冷待机唤醒（新一代浏览器里刚重新确认过身份，等价于一次真重立）——收口在
   *      `applyWakeIdentityResettlement()`，**MUST NOT 被关进「顺便恢复自动化」那个分支里**。
   *      唤醒与恢复自动化是两根独立的轴：外壳可以把一个**暂停中**的节点唤醒（`wake` 带
   *      `resumeAutomation=false`），此时身份照样重新确认过了，基线照样必须跟上。把 ② 挂在
   *      「恢复自动化」上，一个真 halt 过的节点走 暂停 → 冷待机 → 唤醒（保持暂停）→ 恢复自动化
   *      这条路回来时，浏览与定时器全部重新武装，唯独判定首行永久早退——与本文件反复钉的
   *      那个回归同形，只是换了一条入口。
   */
  rebaseline(id: string): void {
    this.baselineId = id;
    this.state = 'healthy';
    this.consecutive = 0;
    this.lastReason = null;
    this.stalenessStreak = 0;
    this.livenessAlerted = false;
  }

  /**
   * 消费一次身份重立链的回执，把「判失效」这一局收口（文件头「五」）。
   *
   * 这是 `reestablishing` **唯一**的出口。宿主 MUST 在链条的每一种收场（含抛异常）之后调它一次：
   * 少调一次，校验体就永久停在「重立中」、`check()` 首行早退，与本次要根除的那个回归同形。
   */
  noteReestablishmentOutcome(outcome: IdentityReestablishmentOutcome): void {
    if (outcome.kind === 'reestablished') return; // 链条内部已 rebaseline，状态早已回 healthy
    if (outcome.kind === 'skipped') return; // 另一条在跑的链条持球，由它收口
    if (outcome.kind === 'crashed' && outcome.identityReestablished) {
      // 身份已经在步 11 真正重立完（基线已换、状态已回 healthy），崩的是之后的收尾步骤。
      // 那不是身份终局，把它记成 invalid 就是拿一件与身份无关的故障去钉死一台身份完好的机器。
      return;
    }
    if (this.state !== 'reestablishing') return; // 迟到的回执：这一局已被别的边（rebaseline / 更晚的回执）收口
    if (outcome.kind === 'aborted') {
      // 「这次没做完」≠「做完了，结论是停手」。基线仍是**旧的**，所以退回待判吞不掉任何真实翻转：
      // 恢复之后下一拍会拿同一个旧基线把它重新判出来。留在 invalid 上才是永久哑火。
      this.state = 'healthy';
      // 计数清零：作废意味着宿主停过手（暂停 / 冷待机会把浏览器整个关掉再开），此前那几拍的证据
      // 已经陈旧，重新从页面上现读才诚实。`lastReason` 故意保留——它是「最近一次判过什么」的诊断值，
      // 不是「现在的状态」，下一局会原样覆盖它。
      this.consecutive = 0;
      this.stalenessStreak = 0;
      this.livenessAlerted = false;
      this.log(
        `[identity-guard] 身份重立链在「${outcome.step}」处被叫停：校验体退回**待判**（基线仍是 ${this.baselineId}），` +
          '恢复自动化后下一拍重新判定——绝不停在「已判失效」上永久哑火。',
      );
      return;
    }
    // halt / crashed：链条跑完了，结论是停手。这是**终局**，只有一次真正的身份重立（rebaseline）能解除。
    this.state = 'invalid';
    this.log(
      `[identity-guard] 身份重立链终局（${outcome.kind}：${outcome.reason}）：校验体停在已失效态，` +
        '在浏览器里重新登录目标账号并重启本节点之前，不再判定。',
    );
  }

  /**
   * 启动周期校验。幂等：已在跑则只更新回调、不重复武装定时器。
   *
   * **MUST NOT 在这里复位健康态。** 恢复自动化与 CDP 重连都走这里，顺手复位就会把一个真正 halt
   * 的节点在下一次恢复时洗成健康（把「已停在无身份态」悄悄变回「一切正常」）。复位只挂在链条回执上。
   */
  start(onInvalid?: (reason: IdentityInvalidReason) => void): void {
    this.onInvalid = onInvalid;
    if (this.timer) return;
    this.timer = this.setTimer(() => void this.check(), this.intervalMs);
    this.timer.unref?.();
  }

  /**
   * 停止周期校验。幂等。
   *
   * **递增代际必须无条件发生、且早于清定时器**：定时器只是「下一拍还发不发」，而此刻真正危险的是
   * 已经在途的那一次 `check()` 和它可能已经拉起来的重立链——只清定时器，它们照样跑完，照样在
   * 冷待机中途把云端连接关掉、把浏览重新拉起来。递增代际是它们唯一的取消点。
   */
  stop(): void {
    this.currentGeneration += 1;
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  /** 当前代际。重立链在每个 await 点比对它；变了＝宿主已叫停，链条当场作废。 */
  get generation(): number {
    return this.currentGeneration;
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

  /** 单次校验（可直接调用以单测）。判失效后交给链条持球（`reestablishing`）并回调恰一次。 */
  async check(): Promise<void> {
    // 只在 healthy 下判定：`reestablishing` 期间链条正在换基线（再判只会对着半截状态计数、
    // 并重复拉链条），`invalid` 是终局。两者都抑制，但**出口完全不同**（文件头「五」）。
    if (this.checking || this.state !== 'healthy') return;
    this.checking = true;
    // 代际快照：本轮 check 的每个 await 点之后都要复查。宿主一旦 `stop()`（暂停 / 冷待机 / 停用），
    // 这一轮就地作废——既不计数、也绝不回调 onInvalid 把重立链拉起来。
    const generation = this.currentGeneration;
    try {
      // 先按页面上下文分域，绝不不看页面就一律用消费端锚点判定
      // （否则发布把标签页带到创作子域时会误判登出）。
      const ctx = await this.opts.readPageContext().catch((): IdentityPageContext => 'unknown');
      if (generation !== this.currentGeneration) return;
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
          if (generation !== this.currentGeneration) return;
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
          if (generation !== this.currentGeneration) return;
          reason = { kind: 'lost' }; // 读取异常按登出计一次（防抖阈值兜住瞬时）
        }
      }
      if (generation !== this.currentGeneration) return;
      this.resetStalenessStreak();
      this.consecutive += 1;
      this.log(
        `[identity-guard] 身份疑似失效（${reason.kind}${reason.kind === 'changed' ? `→${reason.newId}` : ''}），连续 ${this.consecutive}/${this.threshold}`,
      );
      if (this.consecutive >= this.threshold) {
        this.lastReason = reason;
        // 有人接管 ⇒ 进「重立中」，终局由链条回执定；**无人接管 ⇒ 直接停在终局 invalid**：
        // 那种情况下没有任何东西会来收口，停在一个永远等不到回执的中间态就是另一种永久哑火。
        this.state = this.onInvalid ? 'reestablishing' : 'invalid';
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
// 运行期身份裁定（硬约束 C）
// ===========================================================================================

export type RuntimeIdentityVerdict =
  | { kind: 'accept'; accountId: string; overrideIgnored?: { override: string; real: string } }
  | { kind: 'halt'; reason: string };

/**
 * 把握手决策翻译成**运行期**裁定。这里与启动期是两套口径，差别只有一条：
 * **`AIDCP_ACCOUNT_ID` 覆盖在运行期没有任何权威。**
 *
 * 启动期的覆盖是操作者的显式逃生阀：进程刚起、页面可能还没登录，操作者说「这台就是账号 X」，
 * 那是一句关于**未来**的声明，接受它是合理的。运行期重立不是——它的触发前提就是「这台机器上
 * 刚刚发生了身份变化」，此刻手上有的是**实测**：
 *   - 读不出（`use-override-after-read-fail`）＝浏览器掉了登录态。这时拿覆盖值继续跑，就是把
 *     「不知道」说成「知道」：一台没有登录态的浏览器会被当成账号 X 重新握手、重启浏览，云端看到的
 *     是一个「健康在线」的节点。故 **MUST 判 halt**（红线：按实测回报，绝不回报请求值）。
 *   - 读出来了但与覆盖值不一致（`use.mismatch`）＝浏览器现在真的登着另一个账号。继续用覆盖值，
 *     就是把这个账号的全部动作记到别人头上；而且基线与比较口径会永久错开，校验体每两拍就把会话
 *     拆一遍重建一遍（无限重建循环）。故 **以实测值为准**，并响亮告警说明覆盖值被忽略。
 *
 * 纯函数、可单测。
 */
export function judgeRuntimeIdentity(decision: IdentityDecision): RuntimeIdentityVerdict {
  if (decision.kind === 'halt') return { kind: 'halt', reason: decision.reason };
  if (decision.kind === 'use-override-after-read-fail') {
    return {
      kind: 'halt',
      reason: `${decision.reason}（AIDCP_ACCOUNT_ID 覆盖只是启动期逃生阀，运行期重立不接受它顶替实测身份）`,
    };
  }
  return decision.mismatch
    ? { kind: 'accept', accountId: decision.mismatch.real, overrideIgnored: decision.mismatch }
    : { kind: 'accept', accountId: decision.accountId };
}

/**
 * 从握手决策里取出**实测**到的账号 id（没读出实测值则为 undefined）。
 *
 * 存在的理由是「基线必须与比较口径一致」：周期校验体比的是**页面上读出来的** id
 * （`res.identity.accountId`），所以它的基线也只能是页面上读出来的 id。拿握手身份当基线，在
 * 「覆盖值 ≠ 真实登录账号」这个被显式支持的组合下两者永不相等 ⇒ 每 2×节拍就把会话整个拆一遍
 * 重建一遍，而日志里只有一句「✓ 身份已重新确立」。纯函数、可单测。
 */
export function observedAccountIdFromDecision(decision: IdentityDecision): string | undefined {
  if (decision.kind !== 'use') return undefined;
  // source==='env-override' 且无 mismatch ⇒ 覆盖值与实测值相等，accountId 就是实测值。
  return decision.mismatch ? decision.mismatch.real : decision.accountId;
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
  /**
   * 步 7：就地重读身份。**读取选项由链条给**（`reestablishIdentityReadOptions()`），宿主只负责把它
   * 原样转给平台 reader —— 「归位后要给足水合预算」是本文件的判据，不是宿主装配的自由发挥。
   */
  readIdentity: (options: ReadSelfIdentityOptions) => Promise<SelfIdentityResult>;
  /** 步 8：身份决策。 */
  decideIdentity: (res: SelfIdentityResult) => IdentityDecision;
  nicknameFor: (res: SelfIdentityResult, decision: IdentityDecision) => string | undefined;
  /** 步 9：换身份（写宿主 accountId / 昵称并告知云端客户端）。 */
  applyIdentity: (accountId: string, nickname: string | undefined) => void;
  /** 步 10：按新 id 重连云端（云端据此拆旧会话 + 重过就绪闸）。 */
  connectCloud: () => Promise<void>;
  /** 步 11：重设周期校验体基线。 */
  rebaseline: (accountId: string) => void;
  /**
   * 步 11.5：身份**真正**重新确立的对外通告（宿主转成 lifecycle IPC 给桌面外壳）。
   *
   * 与 `reportHalt` 是同一枚硬币的两面：外壳收到 halt 之后会把红角标**闩住**（此后核心再打任何
   * 一行普通日志都不许把徽标翻回运行中，否则 halt 一秒就被下一行日志洗掉）。闩住的代价是它
   * 只能被显式解除——少了这条通告，一次**真正**的身份重立之后核心已经健康、浏览也跑起来了，
   * 外壳却仍挂着不可撤销的红「运行期身份确立失败」。方向是假失败（看得见）不是假成功，但核心与
   * 外壳的口径分岔本身就是缺陷：同一台机器同一时刻，一处说健康、一处说终局。
   */
  reportIdentityRestored: (accountId: string) => void;
  /** 步 13：重启周期观测。 */
  resumeObservation: () => void;
  /** 步 14：重启浏览。 */
  startBrowse: () => void;
  /**
   * 宿主代际（`IdentityRevalidator.generation`）。链条开始时取一次，之后**每个 await 点复查**；
   * 变了＝宿主已叫停（暂停 / 冷待机 / 停用），链条当场作废并回滚自己做过的外部改动。
   */
  generation: () => number;
  /**
   * halt 终局的对外通告（宿主转成 lifecycle IPC 给桌面外壳）。
   *
   * halt 之后节点已彻底停摆：浏览停了、观测停了、云端连接被 `intentionalClose` 关掉（既不自动重连、
   * 也不 emit 断连事件）。**只打一行日志是不够的**——外壳没有任何信号，左栏仍显示「运行中 / 已连接
   * 云端」，运营看不到角标。那正是静默假成功的产品层形态。
   */
  reportHalt: (reason: string) => void;
}

export type IdentityReestablishmentOutcome =
  | { kind: 'reestablished'; accountId: string }
  | { kind: 'halted'; reason: string }
  /**
   * 链条自己的某一步抛了（关连接 / 导航 / 重连云端 …）。此刻节点是**半拆状态**：浏览已停、观测已停，
   * 云端可能已断。它与 `halted` 一样是终局（做完了，结论是停手），但原因不同，故不压成一态。
   *
   * 做成回执而不是让异常裸抛出去，是因为异常一旦逸出，**状态机就没人收口了**：校验体停在
   * 「重立中」永久哑火，外壳还一直显示「运行中」。crashed 让两处都如实落地。
   *
   * `identityReestablished` 区分**崩在哪一侧**，它决定这次崩要不要报成身份终局：
   *   - `false`（步 11 之前）：身份没换成，节点停在半拆状态 ⇒ 报 halt、校验体落终局。
   *   - `true`（步 11 之后）：身份**已经**换成了，基线也换了、云端也按新身份连上了，崩的是
   *     「恢复观测 / 重启浏览」这些收尾步骤。此时再报一次 halt 是**说假话**——外壳会把刚刚
   *     解除的红角标重新闩上、文案还写着「身份确立失败」，而身份恰恰是唯一没出问题的东西。
   */
  | { kind: 'crashed'; reason: string; identityReestablished?: boolean }
  /**
   * 宿主在链条执行中叫停：`step` 是被叫停的位置；`cloudRestored` 如实回报「本链条断掉的云端连接
   * 补回来了没有」；`observationSuspendedByChain` 如实带出「周期观测还停着、恢复责任在宿主」。
   */
  | { kind: 'aborted'; step: string; cloudRestored?: boolean; observationSuspendedByChain: boolean }
  | { kind: 'skipped'; reason: 'already_running' };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
    // 代际快照（硬约束 D）。链条自己做过的两件外部改动记在这里：作废时要回滚，因为宿主从来没要求
    // 过它们——留着不管就是把「取消」做成另一种静默损坏（观测被永久暂停 / 云端连接永久失联）。
    const startedGeneration = deps.generation();
    let observationSuspendedByChain = false;
    let cloudDisconnectedByChain = false;
    /** 步 11 是否已经跑过（身份真的换成了）。决定收尾步骤崩掉时要不要报成身份终局。 */
    let identityReestablished = false;
    /** 每个 await 点复查代际；已被叫停则回滚并返回 aborted，否则返回 null 继续。 */
    const abortIfStopped = async (step: string): Promise<IdentityReestablishmentOutcome | null> => {
      if (deps.generation() === startedGeneration) return null;
      deps.logger(
        `[identity-guard] 身份重立链在「${step}」处被宿主叫停（暂停 / 冷待机 / 停用）：当场作废，绝不继续往前推进。`,
      );
      const out: { kind: 'aborted'; step: string; cloudRestored?: boolean; observationSuspendedByChain: boolean } = {
        kind: 'aborted',
        step,
        observationSuspendedByChain,
      };
      // 周期观测**故意不在这里恢复**。三条叫停路径里有两条（冷待机 / 停用）马上就要把浏览器关掉，
      // 此刻恢复观测＝探针对着已 detach 的 CDP 每 2s 空轮询一路轮到唤醒（会话侧 scheduleProbe 会在
      // `.finally` 里自我重新武装）。剩下那条（暂停）的恢复责任在宿主的 `resumeAutomation`：那里才
      // 知道「现在要重新开工」。链条只如实把「是我暂停的」这个事实带出去。
      if (cloudDisconnectedByChain) {
        // 这条连接是本链条关的，而且关法是 intentionalClose（不自动重连、不发断连事件）。宿主的暂停 /
        // 冷待机都明确要求**保留云端连接**，不补回来＝节点静默失联、外壳的唤醒指令再也送不到。
        try {
          await deps.connectCloud();
          out.cloudRestored = true;
        } catch (error) {
          out.cloudRestored = false;
          deps.logger(
            `[identity-guard] ⚠ 作废回滚：重连云端失败（${errorText(error)}）——本节点当前与云端失联，需人工介入。`,
          );
        }
      }
      return out;
    };
    try {
      const reasonText = describeReason(reason);
      const flipReason = `identity_flip:${reason?.kind ?? 'unknown'}`;
      // 第一个取消点在**任何副作用之前**：判失效与链条启动之间隔着一次事件循环，宿主很可能正好在
      // 这个窗口里进了冷待机。在这里让路，什么都不用回滚。
      const abortedAtEntry = await abortIfStopped('entry');
      if (abortedAtEntry) return abortedAtEntry;
      deps.logger(`[identity-guard] ⚠ 运行期身份失效（${reasonText}）：停自动化、退回无身份态并尝试重新确立身份`);

      // 步 2 / 3：先把两套周期活动停住，避免重立期间还有人对页面动手。
      deps.suspendObservation(flipReason);
      observationSuspendedByChain = true;
      await deps.stopBrowse();
      const abortedAfterStop = await abortIfStopped('stop_browse');
      if (abortedAfterStop) return abortedAfterStop;

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
      cloudDisconnectedByChain = true;
      const abortedAfterDisconnect = await abortIfStopped('disconnect_cloud');
      if (abortedAfterDisconnect) return abortedAfterDisconnect;

      // 步 6（硬约束 B 前半）：先导航回消费端首页再读。触发失效时页面可能停在创作发布页 / 弹层态，
      // 原地读必然读不出 ⇒ 无谓停摆。导航失败只记日志、照样往下读（与退役实现同，不更坏）。
      try {
        await deps.navigateToConsumerHome();
      } catch (error) {
        deps.logger(`[identity-guard] 归位消费端首页失败（${errorText(error)}）：退回原地重读`);
      }
      const abortedAfterNavigate = await abortIfStopped('navigate_home');
      if (abortedAfterNavigate) return abortedAfterNavigate;

      // 步 7 / 8：就地重读 + 决策。读预算由链条给足（硬约束 B 后半的前提）：归位是一次整页重载，
      // 拿周期校验那种小预算读它，读到的只是「还没渲染完」——把它判成终局就是把「慢」当失败。
      const idRes = await deps.readIdentity(reestablishIdentityReadOptions());
      const abortedAfterRead = await abortIfStopped('read_identity');
      if (abortedAfterRead) return abortedAfterRead;
      const decision = deps.decideIdentity(idRes);
      const verdict = judgeRuntimeIdentity(decision);
      if (verdict.kind === 'halt') {
        // 硬约束 B 后半：halt MUST 是**纯返回**——不换身份、不重连云端、不重启浏览与观测，
        // **绝不回落默认账号、也绝不用 AIDCP_ACCOUNT_ID 覆盖值顶上**（硬约束 C）。
        // 文案里的「身份确立失败」是与外壳终态白名单共用的措辞（IPC 之外的第二道保险）。
        deps.logger(
          `[identity-guard] ✗ 运行期身份确立失败：归位后仍读不出稳定账号 id（${verdict.reason}）。` +
            '已停在无身份态——不换身份、不重连云端、不重启浏览，绝不回落默认账号。' +
            '请在浏览器里重新登录目标账号后重启本节点。',
        );
        deps.reportHalt(verdict.reason);
        return { kind: 'halted', reason: verdict.reason };
      }
      if (verdict.overrideIgnored) {
        // 响亮告警：这一步之后云端会话会按**实测**账号重建，与操作者设的覆盖值不同。
        // 只打一句「✓ 身份已重新确立」就把它盖过去，等于让人永远看不到自己的配置已被实测事实推翻。
        deps.logger(
          `[identity-guard] ⚠ AIDCP_ACCOUNT_ID 覆盖值(${verdict.overrideIgnored.override}) ≠ 归位后实测的登录账号` +
            `(${verdict.overrideIgnored.real})：运行期一律以**实测值**为准（启动期覆盖是逃生阀，运行期重立不是）。` +
            '云端会话将按实测账号重建；若这不是预期，请修正 AIDCP_ACCOUNT_ID 或换回目标账号登录。',
        );
      }

      // 步 9 / 10：换身份并按新 id 重连（云端据此拆旧会话）。
      const accountId = verdict.accountId;
      deps.applyIdentity(accountId, deps.nicknameFor(idRes, decision));
      await deps.connectCloud();
      cloudDisconnectedByChain = false; // 连接已由本链条自己补回，作废时无需再重连

      // 步 11：重设基线。用的是**实测**账号 id（`verdict.accountId`），与周期校验体的比较口径
      // （页面上读出来的 id）逐字一致——两者错开就会每两拍拆一次会话重建一次，无限循环。
      deps.rebaseline(accountId);
      identityReestablished = true;
      // 步 11.5：通告外壳「身份已重新确立」。外壳的红角标是**闩住**的，只有这条通告能解除它；
      // 通告本身失败绝不许把一次成功的重立拖成异常（那会让下面的 catch 把它误报成终局）。
      try {
        deps.reportIdentityRestored(accountId);
      } catch (reportError) {
        deps.logger(`[identity-guard] ⚠ 通告身份已重新确立失败（${errorText(reportError)}）：外壳的终局角标可能仍挂着。`);
      }

      // 步 12 —— 【5.6 待人裁定：此处是退役实现步 12「重注入连接级节奏快照」的位置】
      // 该步在 Native 形态下的归属未定（见 change tasks.md 5.6 / design.md「待裁定」§1）。
      // 未裁定前**不实现、也不写静默兜底**：写一个「顺手 applyPacingSnapshot」在这里，等于替裁定人
      // 做了决定；写一个空 catch 则是静默假成功。故此处只留具名占位。

      // 最后一个取消点：下面就要把浏览重新拉起来了。宿主若已叫停（用户点了「暂停」/ 进了冷待机），
      // 在这里放行 = 用户点完暂停几秒后浏览自己又开始跑。作废分支会把观测还回去，但绝不 startBrowse。
      const abortedBeforeRestart = await abortIfStopped('restart_automation');
      if (abortedBeforeRestart) return abortedBeforeRestart;

      // 步 13 / 14：重启周期观测与浏览。
      deps.resumeObservation();
      deps.startBrowse();
      deps.logger(`[identity-guard] ✓ 身份已重新确立：${accountId}（云端会话已按新身份重建，自动化已恢复）`);
      return { kind: 'reestablished', accountId };
    } catch (error) {
      // 链条自己的某一步抛了。异常**绝不许裸逸出**：逸出之后没有任何东西会把校验体的「重立中」收口，
      // 它会永久哑火（`check()` 首行早退），而外壳还一直显示「运行中」。此刻节点是半拆状态
      // （浏览已停、观测已停、云端可能已断），如实报成终局并通告外壳。
      const reason = errorText(error);
      if (identityReestablished) {
        // 崩在步 11 **之后**：身份已经换成了、基线已经跟上、云端已按新身份连上，出问题的是
        // 「恢复观测 / 重启浏览」这些收尾步骤。这里 MUST NOT 报 halt——那句话的字面意思是
        // 「身份确立失败」，而身份恰恰是唯一没出问题的东西；报出去只会把刚解除的红角标重新闩上，
        // 把一台身份完好的机器钉成「请重新登录后重启」。如实说清真正没做完的是什么。
        deps.logger(
          `[identity-guard] ⚠ 身份已重新确立，但恢复自动化的收尾步骤异常（${reason}）：` +
            '周期观测与浏览可能仍停着，且不会有人再来重启它们。身份本身没有问题，' +
            '请按「自动化没跑起来」排查，不要按「身份失效」处理。',
        );
        return { kind: 'crashed', reason, identityReestablished: true };
      }
      deps.logger(
        `[identity-guard] ✗ 身份重立链自身异常（${reason}）：节点停在半拆状态——浏览与周期观测已停，` +
          '云端连接可能已断开。不猜、不重试、不回落默认账号，等待人工介入。',
      );
      try {
        deps.reportHalt(reason);
      } catch (reportError) {
        deps.logger(`[identity-guard] ⚠ 通告终局失败（${errorText(reportError)}）：外壳看不到这个终局。`);
      }
      return { kind: 'crashed', reason };
    } finally {
      running = false;
    }
  };
}

// ===========================================================================================
// 冷待机唤醒后的身份收口
// ===========================================================================================
//
// 冷待机唤醒是**第二条**「身份真的重新确立了」的路径（第一条是上面的重立链）。唤醒流程会在新一代
// 浏览器里重新读一次身份、读不出就直接判唤醒失败留在待机态——所以走到这里就意味着「刚刚实测确认过」，
// 与链条步 11 等价。既然等价，它就必须承担链条步 11 承担的**全部**收口，而不是只做其中好写的那一半：
//
//   ① 重设校验体基线（唯一能解除 `invalid` 终局的边）
//   ② 把上一局 halt 断掉的云端连接补回来
//   ③ 通告外壳「身份已重新确立」（解除那枚闩住的红角标）
//
// 这三件事**必须由同一个条件管**。曾经的形态是：①③ 没有，② 只在「账号变了」时顺手做，而 ① 被关在
// 「顺便恢复自动化」的分支里。于是一个真 halt 过的节点走 暂停 → 冷待机 → 唤醒（保持暂停）→ 恢复自动化
// 回来时：浏览重开了、定时器重新武装了、外壳显示运行中，而校验体判定首行永久早退、云端再也没连上、
// 角标一直红着。装了但永久不工作 + 三处口径各说各话。
//
// 反向的红线同样要守住：**没实测到就一件都不做**。唤醒时读不出身份但设了 `AIDCP_ACCOUNT_ID` 时，
// 决策会退成覆盖值兜底（`use-override-after-read-fail`）——那是一句关于未来的声明，不是实测。拿它去
// 解除终局、去重连云端，就是把「不知道」说成「知道」，正是 `judgeRuntimeIdentity` 拒绝的那件事。

/**
 * 恢复自动化的身份准入。
 *
 * 与唤醒是同一条判据的另一半：**「让节点重新跑起来」的每一条入口，都必须要么带来一次新的身份实测、
 * 要么在无身份终局面前停手。** 唤醒带来实测（新一代浏览器里重新读过），所以它能解除终局；而
 * 「暂停 → 恢复自动化」不带来任何新事实——它只是把定时器和浏览循环重新武装起来。
 *
 * 缺了这道闸的后果与冷待机那条路完全一样，只是不经过待机：一次真 halt 之后（浏览停了、观测停了、
 * 云端连接被 intentionalClose 关掉），运营点一次「暂停」再点一次「恢复」，浏览循环就重新跑起来了，
 * 而运行期身份校验判定首行永久早退、云端始终没连上——**一台在错误 / 未知身份下持续动作、且上报全丢
 * 的机器**。halt 的处理办法写在它自己那行日志里（在浏览器里重新登录目标账号后重启本节点），
 * 「点一下恢复」不构成已处理。
 */
export type AutomationResumeVerdict = { kind: 'allow' } | { kind: 'refuse'; reason: string };

export function judgeAutomationResume(health: IdentityHealth): AutomationResumeVerdict {
  // 只拦终局。`reestablishing` 是链条持球的中间态，它自己会收口；拦它等于把一次正常的重立卡死。
  if (health !== 'invalid') return { kind: 'allow' };
  return {
    kind: 'refuse',
    reason:
      '运行期身份停在无身份终局：恢复自动化不会带来任何新的身份事实，放行只会让节点在未知身份下继续动作。'
      + '请在浏览器里重新登录目标账号后重启本节点（或让外壳走一次冷待机唤醒，那条路会重新实测身份）。',
  };
}

export type WakeIdentityResettlement =
  /** 唤醒实测到了稳定账号 id ⇒ 等价一次真重立，三件收口全做。 */
  | { kind: 'reestablished'; accountId: string }
  /**
   * 没实测到，而上一局**正停在无身份终局**上 ⇒ 这次唤醒没能把它解除，节点不该回来。
   *
   * 判成唤醒失败（留在待机态、可再次唤醒）而不是「回来但什么都不解除」，理由是后者会造出本批要
   * 根除的那个形态：浏览跑着、外壳显示运行中，而运行期身份校验是死的、云端是断的。halt 的语义本
   * 就是「停在无身份态等人处理」，处理办法写在它自己的日志里——在浏览器里重新登录目标账号。一次
   * 读不出身份的唤醒不构成「已处理」。
   */
  | { kind: 'wake_rejected'; reason: string }
  /**
   * 没实测到，但上一局并不是终局 ⇒ 什么都不解除（基线保持上一次实测值），自动化照旧恢复。
   * 这一格没有任何东西被打破：基线仍是最后一次实测到的值，下一拍照常判定。
   */
  | { kind: 'unmeasured'; reason: string };

/**
 * 纯函数：唤醒后该怎么收口。判据只有两件事——**这一代浏览器里实测到 id 了吗**，以及**上一局是不是终局**。
 */
export function judgeWakeIdentityResettlement(
  decision: IdentityDecision,
  health: IdentityHealth,
): WakeIdentityResettlement {
  const measured = observedAccountIdFromDecision(decision);
  // 只认实测值。这里若退化成 `measured ?? accountId`，覆盖值就会被当成基线钉进校验体——而它在页面上
  // 永远读不出来，于是每两拍判一次换号、把会话拆一遍重建一遍（T10 钉的那个无限重建循环）。
  if (measured) return { kind: 'reestablished', accountId: measured };
  const reason =
    decision.kind === 'use-override-after-read-fail'
      ? `唤醒后仍读不出稳定账号 id（${decision.reason}），只有 AIDCP_ACCOUNT_ID 覆盖值顶着`
      : decision.kind === 'halt'
        ? `唤醒后身份确认失败（${decision.reason}）`
        : '唤醒流程没有交出实测到的账号 id';
  return health === 'invalid' ? { kind: 'wake_rejected', reason } : { kind: 'unmeasured', reason };
}

export interface WakeIdentityResettlementDeps {
  logger: (msg: string) => void;
  /** 重设校验体基线（`invalid` 终局唯一的解除边）。 */
  rebaseline: (accountId: string) => void;
  /** 云端连接当前还在不在（在就绝不再连一次：重复 connect 会把一条好连接换掉、白丢一次握手）。 */
  cloudLinkAttached: () => boolean;
  /** 补回云端连接。上一局 halt 关它用的是 intentionalClose——不自动重连、也不发断连事件。 */
  restoreCloudLink: () => Promise<void>;
  /** 通告外壳「身份已重新确立」（解除闩住的红角标）。 */
  reportIdentityRestored: (accountId: string) => void;
  /** 重启浏览（仅当宿主要求恢复自动化）。 */
  startBrowse: () => void;
  /** 重新武装周期校验（仅当宿主要求恢复自动化：暂停中的节点不该有定时器在跑）。 */
  startIdentityGuard: () => void;
}

/**
 * 施加唤醒后的身份收口。
 *
 * **`resumeAutomation` 只管最后那两行**（重启浏览 / 重新武装定时器）。身份侧的三件收口一律与它无关：
 * 唤醒与恢复自动化是两根独立的轴，外壳完全可以把一个暂停中的节点唤醒（`wake` 带 `false`），那时
 * 身份照样重新确认过了。把身份收口挂到自动化那根轴上，就是给「暂停中被唤醒」这条真实路径留一个
 * 永久失效态。
 */
export async function applyWakeIdentityResettlement(
  resettlement: WakeIdentityResettlement,
  resumeAutomation: boolean,
  deps: WakeIdentityResettlementDeps,
): Promise<void> {
  if (resettlement.kind === 'wake_rejected') {
    // 宿主据此判唤醒失败并把浏览器还回槽位；这里一件副作用都不做（尤其不恢复自动化）。
    deps.logger(
      `[identity-guard] 唤醒未能解除无身份终局（${resettlement.reason}）：不重设基线、不重连云端、不恢复自动化。` +
        '请在浏览器里重新登录目标账号后重启本节点。',
    );
    return;
  }
  if (resettlement.kind === 'reestablished') {
    // ① 基线：先做，且**无条件**做。它是终局唯一的解除边，后面两件事失败都不该拖累它。
    deps.rebaseline(resettlement.accountId);
    // ② 云端：只在真断了时补。上一局 halt 断它时是对的（那时身份未知，以旧身份对云端表现为在线才是
    //    说假话）；而唤醒已经把「身份未知」这个前提消掉了，此刻还不连，节点就是一台活着、身份已确认、
    //    浏览器已开、却对云端彻底消失的机器——自动化一恢复就会照跑照烧动作，上报全丢。
    if (!deps.cloudLinkAttached()) {
      try {
        await deps.restoreCloudLink();
        deps.logger(`[identity-guard] 云端连接已按重新确认的身份（${resettlement.accountId}）补回。`);
      } catch (error) {
        deps.logger(
          `[identity-guard] ⚠ 唤醒后补回云端连接失败（${errorText(error)}）：本节点当前与云端失联，需人工介入。`,
        );
      }
    }
    // ③ 外壳：无论云端补没补上都要通告——身份确实重新确立了，红角标该解除。
    deps.reportIdentityRestored(resettlement.accountId);
  } else {
    deps.logger(
      `[identity-guard] ${resettlement.reason}：基线保持上一次实测值不变、云端连接不因此重建——` +
        '绝不拿一个没实测过的值去解除任何状态。',
    );
  }
  if (resumeAutomation) {
    deps.startBrowse();
    deps.startIdentityGuard();
  }
}
