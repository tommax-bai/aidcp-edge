/**
 * identity-watcher.ts — 运行期身份持续校验（change account-identity-from-login，task 1.4）
 * ===========================================================================
 * 身份是「持续校验的状态」，不是握手时定死一次（design D4）。本监测体周期性【就地、不跳转】
 * 重读自己的稳定 id，与已确立基线比对：
 *   - 读出 == 基线 → 健康，清零计数；
 *   - 读出 != 基线 → 换号（changed，带 newId）；
 *   - 读不出      → 登出/过期（lost）。
 * 防抖：连续达到阈值次数（默认 2）才判失效（healthy→invalid），避免瞬时读失败误退（design 开放问题 3）。
 * 判失效后【只 emit 一次】转移，由调用方退回无身份态、断连重连重建身份（不重跑节点初始化）。
 *
 * 与其它监测体一致挂在 WatcherSupervisor 下（start/stop 受统一调度）。
 * 只读 + 不导航（readSelfIdentity allowNavigate:false）——绝不每轮把页面拽走。
 */
import type { SupervisableWatcher } from './watcher-supervisor.js';
import type { BrowseCdp } from './cdp-util.js';
import { readSelfIdentity } from '../cdp/index.js';

export type IdentityHealth = 'healthy' | 'invalid';
export type IdentityInvalidReason = { kind: 'lost' } | { kind: 'changed'; newId: string };

export interface IdentityWatcherOptions {
  /** 轮询间隔（ms，默认 30000）。env AIDCP_IDENTITY_CHECK_MS。 */
  intervalMs?: number;
  /** 连续判失效阈值（默认 2，防抖）。env AIDCP_IDENTITY_FAIL_THRESHOLD。 */
  threshold?: number;
  logger?: (msg: string) => void;
  /** 定时器注入（测试用）。 */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (handle: ReturnType<typeof setInterval>) => void;
}

export class IdentityWatcher implements SupervisableWatcher<IdentityHealth> {
  private state: IdentityHealth = 'healthy';
  private consecutive = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private onTransition?: (from: IdentityHealth, to: IdentityHealth) => void;
  /** 最近一次判失效的原因（供调用方在 onTransition 里读取细节）。 */
  lastReason: IdentityInvalidReason | null = null;

  private readonly intervalMs: number;
  private readonly threshold: number;
  private readonly log: (msg: string) => void;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearTimer: (handle: ReturnType<typeof setInterval>) => void;

  constructor(
    private readonly cdp: BrowseCdp,
    private establishedId: string,
    opts: IdentityWatcherOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.threshold = Math.max(1, opts.threshold ?? 2);
    this.log = opts.logger ?? (() => undefined);
    this.setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearInterval(h));
  }

  /** 重设基线 id（身份重新确立后调用）+ 复位为健康态，重新接线监测。 */
  rebaseline(id: string): void {
    this.establishedId = id;
    this.state = 'healthy';
    this.consecutive = 0;
    this.lastReason = null;
  }

  start(onTransition?: (from: IdentityHealth, to: IdentityHealth) => void): void {
    this.onTransition = onTransition;
    if (this.timer) return; // 幂等
    this.timer = this.setTimer(() => void this.check(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** 单次校验（可直接调用以单测）。判失效后置 state=invalid 并 emit 一次，不再重复 emit。 */
  async check(): Promise<void> {
    if (this.checking || this.state === 'invalid') return;
    this.checking = true;
    try {
      let reason: IdentityInvalidReason | null = null;
      try {
        const res = await readSelfIdentity(this.cdp, { allowNavigate: false });
        if (res.ok) {
          if (res.identity.accountId === this.establishedId) {
            this.consecutive = 0;
            return; // 健康
          }
          reason = { kind: 'changed', newId: res.identity.accountId };
        } else {
          reason = { kind: 'lost' };
        }
      } catch {
        reason = { kind: 'lost' }; // 读取异常按登出计一次（防抖阈值兜住瞬时）
      }
      this.consecutive += 1;
      this.log(
        `[identity-watcher] 身份疑似失效（${reason.kind}${reason.kind === 'changed' ? `→${reason.newId}` : ''}），连续 ${this.consecutive}/${this.threshold}`,
      );
      if (this.consecutive >= this.threshold) {
        this.lastReason = reason;
        const from = this.state;
        this.state = 'invalid';
        this.onTransition?.(from, 'invalid');
      }
    } finally {
      this.checking = false;
    }
  }
}
