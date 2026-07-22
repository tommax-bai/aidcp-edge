use crate::protocol::EffectPhase;

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
