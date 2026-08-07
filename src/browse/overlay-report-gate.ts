/**
 * 旁路遮罩「云端上报」纯决策闸（change avoid-return-nav-token-loss-flash）。
 *
 * 把「何时向云端发 captcha.detected / captcha.cleared」的判定从 main.ts bootstrap 里抽出为
 * 纯状态机，便于单测；不触碰旁路监测体（BackgroundWatcher / CdpOverlayMonitor）本身、不改其定时器/接口。
 *
 * 不变量：
 *  - 低置信 `unknown` 遮罩 MUST 经一轮持续性确认（延后 confirmMs 复核仍为 unknown）才上报——滤掉离页返回
 *    途中 token 失效详情的 300031 墙这类一闪即自愈的瞬时坏页误报。
 *  - 真验证码指纹 `captcha` MUST 即时 fail-CLOSED、不经确认窗（绝不弱化真验证码）。
 *  - `detected` / `cleared` 必须配对：只有真发过 `detected` 的 episode，其自愈才发 `cleared`；被确认窗抑制、
 *    从未上报的瞬时 `unknown` 消失 MUST NOT 发孤儿 `cleared`，也 MUST NOT 遗留已发未清的 `detected`。
 *
 * login / dismissible 不入本闸（login 只本地暂停、不打扰云端；dismissible 自动关）——调用方传入的 from/to
 * 是完整 OverlayKind，本闸只对 captcha/unknown 这两类「阻断-云端」态记账。
 */

export type OverlayReportKind = 'captcha' | 'unknown';

export interface OverlayReportGateDeps {
  /** 真正下发 captcha.detected（含取 URL、client.send、日志）。 */
  sendDetected: (kind: OverlayReportKind) => void;
  /** 真正下发 captcha.cleared。 */
  sendCleared: () => void;
  /** 确认窗到点时复核：旁路监测当前仍为 unknown 吗（读 overlayMonitor.state）。 */
  isStillUnknown: () => boolean;
  /** 排程一次延后确认（生产用 setTimeout；测试可捕获手动触发）。 */
  schedule: (fn: () => void, ms: number) => void;
  /** unknown 上报的持续性确认窗（毫秒，≈2×监测轮询）。 */
  confirmMs: number;
}

export interface OverlayReportGate {
  /** 旁路监测每次类别翻转时调用（from/to 为完整 OverlayKind 字符串）。 */
  onTransition: (from: string, to: string) => void;
}

const isBlockingCloud = (k: string): boolean => k === 'captcha' || k === 'unknown';

export function createOverlayReportGate(deps: OverlayReportGateDeps): OverlayReportGate {
  // 本轮阻断 episode 已向云端上报的类型（null=未报）；用于配对、杜绝孤儿 cleared。
  let reportedKind: OverlayReportKind | null = null;
  // episode 代号：离开阻断态 / 新 episode 即自增，令在途的延后确认失效（自愈后不再补发）。
  let epoch = 0;

  return {
    onTransition(from: string, to: string): void {
      const nowBlocking = isBlockingCloud(to);
      const wasBlocking = isBlockingCloud(from);

      if (!nowBlocking) {
        // 离开阻断态（含瞬时自愈）：作废在途确认；仅当真报过 detected 才发配对 cleared，杜绝孤儿。
        epoch += 1;
        if (wasBlocking && reportedKind) deps.sendCleared();
        reportedKind = null;
        return;
      }

      // 进入 / 仍在阻断态。新 episode（从非阻断进来）重置本轮记账。
      if (!wasBlocking) {
        epoch += 1;
        reportedKind = null;
      }

      if (to === 'captcha') {
        // 真验证码指纹：即时 fail-CLOSED、不经确认窗（本 episode 未报过 captcha 才报，避免重复）。
        if (reportedKind !== 'captcha') {
          deps.sendDetected('captcha');
          reportedKind = 'captcha';
        }
      } else if (to === 'unknown' && reportedKind === null) {
        // 低置信 unknown：延后 confirmMs 复核仍为 unknown 且本 episode 仍未报，才上报。
        const scheduledEpoch = epoch;
        deps.schedule(() => {
          if (epoch === scheduledEpoch && reportedKind === null && deps.isStillUnknown()) {
            deps.sendDetected('unknown');
            reportedKind = 'unknown';
          }
        }, deps.confirmMs);
      }
    },
  };
}
