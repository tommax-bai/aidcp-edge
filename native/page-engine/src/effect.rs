use crate::error::ErrorCode;
use crate::protocol::EffectPhase;

/// 写命令带这些错误码时，命令层把它判成 **未开始** —— 也就是告诉上游「一个字都没写出去、
/// 可以安全重投」。
///
/// 这张表是**单一事实源**：命令层的相位映射与「已派发失败」的错误码构造都必须引用它。
/// 两处各写一份的后果没有任何机械手段会提醒 —— 一个已经派发出去的点击若戴上这里的任一顶帽子，
/// 上游会当成压根没点而重投，于是同一个赞点两次、同一条评论发两遍。
pub fn error_code_means_not_started(code: ErrorCode) -> bool {
    matches!(
        code,
        ErrorCode::Cancelled | ErrorCode::CommitWindowUnavailable
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EffectTracker {
    phase: EffectPhase,
}

impl Default for EffectTracker {
    fn default() -> Self {
        Self {
            phase: EffectPhase::NotStarted,
        }
    }
}

impl EffectTracker {
    pub fn phase(self) -> EffectPhase {
        self.phase
    }

    pub fn mark_dispatched(&mut self) {
        if self.phase == EffectPhase::NotStarted {
            self.phase = EffectPhase::Dispatched;
        }
    }

    pub fn mark_confirmed(&mut self) {
        self.phase = EffectPhase::Confirmed;
    }

    pub fn finish_uncertain(&mut self) {
        self.phase = match self.phase {
            EffectPhase::NotStarted => EffectPhase::NotStarted,
            EffectPhase::Dispatched | EffectPhase::Ambiguous => EffectPhase::Ambiguous,
            EffectPhase::Confirmed => EffectPhase::Confirmed,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_dispatch_failure_remains_not_started() {
        let mut tracker = EffectTracker::default();
        tracker.finish_uncertain();
        assert_eq!(tracker.phase(), EffectPhase::NotStarted);
    }

    #[test]
    fn post_dispatch_failure_becomes_ambiguous_and_never_clean() {
        let mut tracker = EffectTracker::default();
        tracker.mark_dispatched();
        tracker.finish_uncertain();
        assert_eq!(tracker.phase(), EffectPhase::Ambiguous);
        tracker.finish_uncertain();
        assert_eq!(tracker.phase(), EffectPhase::Ambiguous);
    }

    #[test]
    fn independent_post_condition_confirms_effect() {
        let mut tracker = EffectTracker::default();
        tracker.mark_dispatched();
        tracker.mark_confirmed();
        tracker.finish_uncertain();
        assert_eq!(tracker.phase(), EffectPhase::Confirmed);
    }
}
