//! 定位三道闸的行为契约（脱离浏览器，全部跑在桩上）。
//!
//! 这些用例锁的是「自愈不变自残」的那几条：校验不过绝不判成功、上限没耗尽绝不说升级、
//! 不可重放的写一经派发绝不重来、暂存锚点没连续确认过绝不进主缓存。

use aidcp_page_engine::error::EngineError;
use aidcp_page_engine::locating::{
    Actuation, AnchorCache, AnchorCacheMode, AnchorSource, DEFAULT_MAX_ATTEMPTS, EscalationKind,
    LocatingOutcome, LocatingSteps, Resolution, ResolvedTarget, Verdict, run_locating_gates,
};

/// 可编排的桩：每一轮的解析 / 派发 / 校验结果都由脚本给定，并记录实际调用序列。
struct ScriptedSteps {
    resolutions: Vec<Resolution>,
    actuations: Vec<Actuation>,
    verdicts: Vec<Verdict>,
    calls: Vec<&'static str>,
}

impl ScriptedSteps {
    fn new(
        resolutions: Vec<Resolution>,
        actuations: Vec<Actuation>,
        verdicts: Vec<Verdict>,
    ) -> Self {
        Self {
            resolutions,
            actuations,
            verdicts,
            calls: Vec::new(),
        }
    }
}

impl LocatingSteps for ScriptedSteps {
    async fn resolve(&mut self, attempt: u32) -> Result<Resolution, EngineError> {
        self.calls.push("resolve");
        Ok(self
            .resolutions
            .get(attempt as usize - 1)
            .cloned()
            .unwrap_or(Resolution::Missing))
    }

    async fn actuate(&mut self, _target: &ResolvedTarget) -> Result<Actuation, EngineError> {
        self.calls.push("actuate");
        let index = self.calls.iter().filter(|call| **call == "actuate").count() - 1;
        Ok(self.actuations.get(index).copied().unwrap_or(Actuation {
            dispatched: true,
            replayable: true,
        }))
    }

    async fn validate(&mut self, _target: &ResolvedTarget) -> Result<Verdict, EngineError> {
        self.calls.push("validate");
        let index = self
            .calls
            .iter()
            .filter(|call| **call == "validate")
            .count()
            - 1;
        Ok(self
            .verdicts
            .get(index)
            .copied()
            .unwrap_or(Verdict::Indeterminate))
    }
}

fn target(anchor: &str, source: AnchorSource) -> ResolvedTarget {
    ResolvedTarget {
        key: "facebook.feed.like".to_owned(),
        anchor: anchor.to_owned(),
        source,
    }
}

fn found(anchor: &str) -> Resolution {
    Resolution::Found(target(anchor, AnchorSource::NonDeterministic))
}

fn replayable() -> Actuation {
    Actuation {
        dispatched: true,
        replayable: true,
    }
}

/// 闸①：写完必须重新读回业务结果，读到确实发生才算成功，且只跑一轮。
#[tokio::test]
async fn a_confirmed_verdict_ends_the_loop_after_one_attempt() {
    let mut steps = ScriptedSteps::new(
        vec![found("like-wrapper")],
        vec![replayable()],
        vec![Verdict::Confirmed],
    );
    let mut cache = AnchorCache::new(AnchorCacheMode::ReadWrite, 2);
    let outcome = run_locating_gates(&mut steps, &mut cache, DEFAULT_MAX_ATTEMPTS)
        .await
        .expect("gates");
    assert_eq!(outcome, LocatingOutcome::Confirmed { attempts: 1 });
    assert_eq!(steps.calls, vec!["resolve", "actuate", "validate"]);
}

/// 闸①+②：校验一直不过 → 换路径重试到上限 → 升级为「疑似系统性改版」，
/// **绝不**在任何一轮静默判成功。
#[tokio::test]
async fn repeated_validation_failures_escalate_only_after_the_attempt_cap() {
    let mut steps = ScriptedSteps::new(
        vec![found("anchor-a"), found("anchor-b"), found("anchor-c")],
        vec![replayable(), replayable(), replayable()],
        vec![Verdict::Unchanged, Verdict::Unchanged, Verdict::Unchanged],
    );
    let mut cache = AnchorCache::new(AnchorCacheMode::ReadWrite, 2);
    let outcome = run_locating_gates(&mut steps, &mut cache, DEFAULT_MAX_ATTEMPTS)
        .await
        .expect("gates");
    assert_eq!(
        outcome,
        LocatingOutcome::Escalated {
            attempts: DEFAULT_MAX_ATTEMPTS,
            kind: EscalationKind::SystemicRevision,
        }
    );
    assert_eq!(
        steps
            .calls
            .iter()
            .filter(|call| **call == "validate")
            .count(),
        DEFAULT_MAX_ATTEMPTS as usize,
        "升级的前提是上限耗尽，单次尝试就报升级是把这个词掏空"
    );
}

/// 闸②：一次都没解析到目标 → 无目标终局，而不是升级、更不是成功。
#[tokio::test]
async fn never_resolving_a_target_reports_no_target_rather_than_escalation() {
    let mut steps = ScriptedSteps::new(Vec::new(), Vec::new(), Vec::new());
    let mut cache = AnchorCache::new(AnchorCacheMode::ReadWrite, 2);
    let outcome = run_locating_gates(&mut steps, &mut cache, DEFAULT_MAX_ATTEMPTS)
        .await
        .expect("gates");
    assert_eq!(
        outcome,
        LocatingOutcome::NoTarget {
            attempts: DEFAULT_MAX_ATTEMPTS
        }
    );
    assert!(
        !steps.calls.contains(&"actuate"),
        "没定位到就不许对页面下手"
    );
}

/// 闸②：解析来源本身不可用 → 立刻升级、不再重试，且与「改版」区分开。
#[tokio::test]
async fn an_unavailable_resolver_escalates_immediately_without_retrying() {
    let mut steps = ScriptedSteps::new(vec![Resolution::SourceUnavailable], Vec::new(), Vec::new());
    let mut cache = AnchorCache::new(AnchorCacheMode::ReadWrite, 2);
    let outcome = run_locating_gates(&mut steps, &mut cache, DEFAULT_MAX_ATTEMPTS)
        .await
        .expect("gates");
    assert_eq!(
        outcome,
        LocatingOutcome::Escalated {
            attempts: 1,
            kind: EscalationKind::ResolverUnavailable,
        }
    );
    assert_eq!(steps.calls, vec!["resolve"]);
}

/// 闸②：不可重放的写一经派发即停手报不确定，绝不重来（重来 = 双发）。
#[tokio::test]
async fn a_dispatched_non_replayable_write_is_never_retried() {
    let mut steps = ScriptedSteps::new(
        vec![found("submit"), found("submit")],
        vec![Actuation {
            dispatched: true,
            replayable: false,
        }],
        vec![Verdict::Indeterminate],
    );
    let mut cache = AnchorCache::new(AnchorCacheMode::ReadWrite, 2);
    let outcome = run_locating_gates(&mut steps, &mut cache, DEFAULT_MAX_ATTEMPTS)
        .await
        .expect("gates");
    assert_eq!(
        outcome,
        LocatingOutcome::Ambiguous {
            attempts: 1,
            reason: "dispatched_not_replayable_indeterminate",
        }
    );
    assert_eq!(
        steps
            .calls
            .iter()
            .filter(|call| **call == "actuate")
            .count(),
        1
    );
}

/// 闸③：新锚点先暂存，连续确认达阈值才晋升主缓存——第一次成功不进主缓存。
#[tokio::test]
async fn a_new_anchor_is_promoted_only_after_consecutive_confirmations() {
    let mut cache = AnchorCache::new(AnchorCacheMode::ReadWrite, 2);
    let fresh = target("like-wrapper", AnchorSource::NonDeterministic);

    cache.stage_non_deterministic(&fresh);
    cache.record_success(&fresh);
    assert!(cache.get(&fresh.key).is_none(), "第一次成功只算暂存确认");
    assert_eq!(cache.staged_confirmations(&fresh.key), 1);

    cache.stage_non_deterministic(&fresh);
    cache.record_success(&fresh);
    let promoted = cache.get(&fresh.key).expect("晋升后主缓存应有该锚点");
    assert_eq!(promoted.anchor, "like-wrapper");
    assert_eq!(cache.staged_len(), 0);
}

/// 闸③：任一次后置校验失败即丢弃暂存项，此后不得被当作已确认复用。
#[tokio::test]
async fn a_failed_validation_drops_the_staged_anchor_for_good() {
    let mut cache = AnchorCache::new(AnchorCacheMode::ReadWrite, 2);
    let fresh = target("like-wrapper", AnchorSource::NonDeterministic);
    cache.stage_non_deterministic(&fresh);
    cache.record_success(&fresh);
    cache.record_failure(&fresh);
    assert_eq!(cache.staged_len(), 0);

    // 丢弃之后重新暂存，确认计数必须从零开始——不得沿用失败前攒下的那一次。
    cache.stage_non_deterministic(&fresh);
    cache.record_success(&fresh);
    assert!(
        cache.get(&fresh.key).is_none(),
        "被丢弃过的锚点不得靠残留计数一步晋升"
    );
}

/// 闸③：暂存锚点变了说明还不稳定，确认计数归零。
#[tokio::test]
async fn a_changed_staged_anchor_resets_its_confirmation_count() {
    let mut cache = AnchorCache::new(AnchorCacheMode::ReadWrite, 2);
    let first = target("anchor-a", AnchorSource::NonDeterministic);
    let second = target("anchor-b", AnchorSource::NonDeterministic);
    cache.stage_non_deterministic(&first);
    cache.record_success(&first);
    assert_eq!(cache.staged_confirmations(&first.key), 1);
    cache.stage_non_deterministic(&second);
    assert_eq!(cache.staged_confirmations(&second.key), 0);
}

/// 闸③：确定性来源（编译进二进制的固定选择器）不进暂存区。
/// 这条同时钉住当前引擎的实情——**没有非确定性来源，暂存区在生产上恒为空**。
#[tokio::test]
async fn a_deterministic_anchor_never_enters_the_staging_area() {
    let mut cache = AnchorCache::new(AnchorCacheMode::ReadWrite, 2);
    let fixed = target("css-selector", AnchorSource::Deterministic);
    cache.stage_non_deterministic(&fixed);
    cache.record_success(&fixed);
    cache.record_success(&fixed);
    assert_eq!(cache.staged_len(), 0);
    assert!(cache.get(&fixed.key).is_none());
}

/// 只读模式：可以读主缓存，但运行时绝不回写（生产推荐档）。
#[tokio::test]
async fn read_only_mode_serves_the_primary_cache_without_writing_back() {
    let mut cache = AnchorCache::new(AnchorCacheMode::ReadOnly, 2);
    cache.install("facebook.feed.like", "installed");
    let fresh = target("fresh", AnchorSource::NonDeterministic);
    cache.stage_non_deterministic(&fresh);
    cache.record_success(&fresh);
    cache.record_success(&fresh);
    assert_eq!(cache.staged_len(), 0);
    assert_eq!(
        cache.get("facebook.feed.like").expect("installed").anchor,
        "installed"
    );
}

/// 只写模式：读恒为空，强制每次重新解析。
#[tokio::test]
async fn write_only_mode_always_reads_empty() {
    let mut cache = AnchorCache::new(AnchorCacheMode::WriteOnly, 2);
    cache.install("facebook.feed.like", "installed");
    assert!(cache.get("facebook.feed.like").is_none());
}

/// 快照往返必须跨进程可用；畸形快照一律拒绝并保持原状，绝不半载入。
#[tokio::test]
async fn snapshots_round_trip_and_malformed_input_is_rejected_whole() {
    let mut source = AnchorCache::new(AnchorCacheMode::ReadWrite, 2);
    source.install("facebook.feed.like", "like-wrapper");
    let snapshot = source.snapshot();

    let mut restored = AnchorCache::new(AnchorCacheMode::ReadWrite, 2);
    assert_eq!(restored.load(&snapshot).expect("load"), 1);
    assert_eq!(
        restored.get("facebook.feed.like").expect("restored").anchor,
        "like-wrapper"
    );
    assert!(restored.load("{ not json").is_err());
    assert_eq!(
        restored.get("facebook.feed.like").expect("restored").anchor,
        "like-wrapper"
    );
}
