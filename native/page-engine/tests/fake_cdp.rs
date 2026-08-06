use aidcp_page_engine::command::{
    BrowseSurface, CaptchaCaptureParams, CaptchaClickParams, CaptchaPoint, CommentParams,
    FollowParams, GroupJoinParams, IdentityCaptureParams, NoteInteractionParams, NoteOpenParams,
    NoteOpenSelection, NotePurpose, NoteSurface, PageScrollParams, ReasonParams,
    SearchExecuteParams,
};
use aidcp_page_engine::commit_window::CommitWindowRequester;
use aidcp_page_engine::endpoint_resolver::EndpointResolver;
use aidcp_page_engine::engine::{CommandOutput, Engine, StoredCommandResult};
use aidcp_page_engine::error::{CdpExceptionClass, CdpExceptionReason, ErrorCode};
use aidcp_page_engine::model::{ActionReceipt, FacebookListKind};
use aidcp_page_engine::protocol::{
    CommandRecord, EffectPhase, NativeCommand, PageProbeParams, Platform, SessionCloseRecord,
    SessionOpenParams, SessionOpenRecord,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn long_lived_engine_uses_correlated_fake_cdp_and_deduplicates_commands() {
    let (port, server) = spawn_fake_cdp().await;
    let mut engine = Engine::default();
    let open = session_open(port);
    let info = engine.open(&open).await.expect("open session");
    assert_eq!(info.state, "ready");
    assert_eq!(info.target_id, "target-1");

    let command = page_probe_command(1);
    let first = engine.execute(&command).await.expect("first probe");
    let CommandOutput::PageProbe(first_probe) = first.output.expect("first output") else {
        panic!("expected page probe output")
    };
    assert_eq!(first_probe.path, "/search_result_ai");

    let duplicate = engine.execute(&command).await.expect("deduplicated probe");
    let CommandOutput::PageProbe(duplicate_probe) = duplicate.output.expect("duplicate output")
    else {
        panic!("expected duplicate page probe output")
    };
    assert_eq!(duplicate_probe, first_probe);

    let closed = engine
        .close(&SessionCloseRecord {
            protocol_version: 2,
            id: "close-1".to_owned(),
            session_id: "session-1".to_owned(),
        })
        .await
        .expect("close session");
    assert_eq!(closed.state, "closed");
    server.await.expect("fake CDP server");
}

#[tokio::test]
async fn read_only_command_reconnects_once_without_replaying_a_write() {
    let (port, server) = spawn_disconnect_then_recover_cdp().await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open session");
    let outcome = engine
        .execute(&page_probe_command(1))
        .await
        .expect("reconnected probe");
    let CommandOutput::PageProbe(probe) = outcome.output.expect("probe output") else {
        panic!("expected reconnected page probe output")
    };
    assert_eq!(probe.page_kind, aidcp_page_engine::probe::PageKind::Explore);
    engine.shutdown().await;
    server.await.expect("reconnect server");
}

#[tokio::test]
async fn high_level_command_returns_a_bounded_typed_projection() {
    let (port, server) = spawn_router_result_cdp(false).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open session");
    let outcome = engine
        .execute(&browse_command(1))
        .await
        .expect("browse command");
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::PageCards(cards) = outcome.output.expect("cards output") else {
        panic!("expected page cards output")
    };
    assert_eq!(cards.cards.len(), 1);
    assert_eq!(cards.cards[0].note_id.as_deref(), Some("n1"));
    engine.shutdown().await;
    server.await.expect("router result server");
}

#[tokio::test]
async fn dispatched_write_disconnect_is_ambiguous_and_is_not_replayed() {
    let (port, server) = spawn_router_result_cdp(true).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open session");
    let outcome = engine
        .execute(&browse_command(1))
        .await
        .expect("write result");
    assert_eq!(outcome.effect_phase, EffectPhase::Ambiguous);
    assert!(outcome.output.is_none());
    assert!(outcome.error.is_some());
    engine.shutdown().await;
    server.await.expect("write disconnect server");
}

#[tokio::test]
async fn facebook_current_identity_read_never_navigates() {
    let (port, server) = spawn_facebook_identity_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "identity-current-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 2_000,
            command: NativeCommand::IdentityReadCurrent(IdentityCaptureParams {
                capture_id: "capture-1".to_owned(),
                account_id: "61591824155856".to_owned(),
            }),
        })
        .await
        .expect("current identity");
    let CommandOutput::IdentityObservation(observation) =
        outcome.output.expect("identity observation")
    else {
        panic!("expected identity observation")
    };
    assert_eq!(observation.capture_id, "capture-1");
    assert_eq!(observation.account_id, "61591824155856");
    assert_eq!(observation.nickname.as_deref(), Some("Gi Vo"));

    engine.shutdown().await;
    let methods = server.await.expect("Facebook identity fake CDP");
    assert!(!methods.iter().any(|method| method == "Page.navigate"));
}

#[tokio::test]
async fn facebook_initial_scan_resets_a_persisted_reel_to_home_feed() {
    let (port, server) = spawn_facebook_initial_scan_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    // 这条命令真的会导航，因此必须装得下文档就绪等待的首探前置（3s）。
    // 共用桩预算 2s 比内层还短 —— 那样测到的是「外层墙钟先到」，不是这条路径本身。
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open Facebook session");

    let mut command = browse_command(1);
    command.deadline_unix_ms = unix_time_ms() + 30_000;
    let outcome = engine
        .execute(&command)
        .await
        .expect("Facebook initial scan");
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::PageCards(cards) = outcome.output.expect("Feed cards") else {
        panic!("expected Feed cards")
    };
    assert_eq!(cards.list_kind, Some(FacebookListKind::Feed));
    assert_eq!(cards.cards.len(), 1);
    assert_eq!(
        cards.cards[0].note_id.as_deref(),
        Some("https://www.facebook.com/Alice/posts/pfbidHOME")
    );

    engine.shutdown().await;
    let requests = server.await.expect("Facebook initial scan fake CDP");
    let navigate_index = requests
        .iter()
        .position(|request| request["method"] == "Page.navigate")
        .expect("home navigation");
    assert_eq!(
        requests[navigate_index]
            .pointer("/params/url")
            .and_then(Value::as_str),
        Some("https://www.facebook.com/")
    );
    let first_evaluate_index = requests
        .iter()
        .position(|request| request["method"] == "Runtime.evaluate")
        .expect("post-navigation probe");
    assert!(
        navigate_index < first_evaluate_index,
        "persisted Reel must not be evaluated before home navigation"
    );
}

#[tokio::test]
async fn facebook_initial_scan_navigation_failure_never_reads_the_persisted_page() {
    let (port, server) = spawn_facebook_initial_scan_navigation_failure_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&browse_command(1))
        .await
        .expect("stored Facebook startup failure");
    assert_eq!(outcome.effect_phase, EffectPhase::Ambiguous);
    assert!(outcome.output.is_none());
    assert!(outcome.error.is_some());

    engine.shutdown().await;
    let requests = server.await.expect("Facebook startup failure fake CDP");
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "Page.navigate")
            .count(),
        1
    );
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Runtime.evaluate"),
        "navigation failure must stop before the persisted page can be evaluated"
    );
}

#[tokio::test]
async fn facebook_reels_entry_success_stays_background_only() {
    let (outcome, requests) =
        run_facebook_reels_entry(FacebookReelsEntryScenario::FirstNavigationSucceeds).await;

    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    assert_eq!(method_count(&requests, "Page.navigate"), 1);
    assert_eq!(method_count(&requests, "Page.bringToFront"), 0);
}

#[tokio::test]
async fn facebook_reels_entry_foregrounds_once_only_after_ineffective_navigation() {
    let (outcome, requests) =
        run_facebook_reels_entry(FacebookReelsEntryScenario::RetryNavigationSucceeds).await;

    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    assert_eq!(method_count(&requests, "Page.navigate"), 2);
    assert_eq!(method_count(&requests, "Page.bringToFront"), 1);
    let first_navigation = method_index(&requests, "Page.navigate", 0);
    let foreground = method_index(&requests, "Page.bringToFront", 0);
    let second_navigation = method_index(&requests, "Page.navigate", 1);
    assert!(first_navigation < foreground && foreground < second_navigation);
    // 重试必须回到同一个 Reels 入口：两处目标漂开，等于「换个地方再试一次」。
    for index in [first_navigation, second_navigation] {
        assert_eq!(
            requests[index]["params"]["url"],
            "https://www.facebook.com/reel/?s=tab"
        );
    }
    assert!(
        requests[foreground + 1..second_navigation]
            .iter()
            .any(|request| request["method"] == "Runtime.evaluate")
    );
}

#[tokio::test]
async fn facebook_reels_entry_late_surface_transition_suppresses_navigation_retry() {
    let (outcome, requests) =
        run_facebook_reels_entry(FacebookReelsEntryScenario::ActivationRevealsReels).await;

    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    assert_eq!(method_count(&requests, "Page.navigate"), 1);
    assert_eq!(method_count(&requests, "Page.bringToFront"), 1);
}

#[tokio::test]
async fn facebook_reels_entry_probes_a_safe_surface_without_an_active_video() {
    let (outcome, requests) =
        run_facebook_reels_entry(FacebookReelsEntryScenario::MissingActiveVideoSafe).await;

    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::PageCards(cards) = outcome.output.expect("entry Reel cards") else {
        panic!("expected entry Reel cards")
    };
    assert_eq!(
        cards.cards[0].note_id.as_deref(),
        Some("https://www.facebook.com/reel/2")
    );
    assert_eq!(method_count(&requests, "Page.navigate"), 1);
    assert_eq!(method_count(&requests, "Page.bringToFront"), 0);
    assert_eq!(raw_dispatched_keys(&requests), vec!["ArrowRight"]);
    assert_eq!(router_request_count(&requests, "reel_next_target"), 0);
    assert_eq!(method_count(&requests, "Input.dispatchMouseEvent"), 0);
}

#[tokio::test]
async fn facebook_reels_entry_rejects_only_unproven_keyboard_safety() {
    for scenario in [
        FacebookReelsEntryScenario::AnonymousUnsafe,
        FacebookReelsEntryScenario::AnonymousInputSafetyMissing,
    ] {
        let (outcome, requests) = run_facebook_reels_entry(scenario).await;
        assert_eq!(outcome.effect_phase, EffectPhase::Ambiguous);
        let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("entry failure receipt")
        else {
            panic!("expected entry failure receipt")
        };
        assert_eq!(receipt.reason.as_deref(), Some("reels_target_unavailable"));
        assert_eq!(method_count(&requests, "Input.dispatchKeyEvent"), 0);
        assert_eq!(method_count(&requests, "Input.dispatchMouseEvent"), 0);
    }
}

#[tokio::test]
async fn facebook_reels_entry_collects_canonical_identity_after_one_key_without_second_input() {
    let (outcome, requests) =
        run_facebook_reels_entry(FacebookReelsEntryScenario::AnonymousHydratesAfterFirstKey).await;
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::PageCards(cards) = outcome.output.expect("same-video Reel cards") else {
        panic!("expected same-video Reel cards")
    };
    assert_eq!(
        cards.cards[0].note_id.as_deref(),
        Some("https://www.facebook.com/reel/1")
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| {
                request["method"] == "Input.dispatchKeyEvent"
                    && request["params"]["type"] == "rawKeyDown"
            })
            .count(),
        1
    );
    assert_eq!(method_count(&requests, "Input.dispatchMouseEvent"), 0);
}

#[tokio::test]
async fn facebook_reels_entry_unchanged_anonymous_video_stops_after_one_bounded_invocation() {
    let (outcome, requests) =
        run_facebook_reels_entry(FacebookReelsEntryScenario::AnonymousNeverMoves).await;
    assert_eq!(outcome.effect_phase, EffectPhase::Ambiguous);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("unchanged entry receipt")
    else {
        panic!("expected unchanged entry receipt")
    };
    assert_eq!(receipt.reason.as_deref(), Some("reels_identity_unresolved"));
    let raw_keys = requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchKeyEvent"
                && request["params"]["type"] == "rawKeyDown"
        })
        .filter_map(|request| request["params"]["key"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(raw_keys, vec!["ArrowRight"]);
    assert_eq!(method_count(&requests, "Input.dispatchMouseEvent"), 0);
    assert_eq!(method_count(&requests, "Page.navigate"), 1);
}

#[tokio::test]
async fn facebook_reels_entry_blocker_and_document_drift_suppress_foreground_recovery() {
    for scenario in [
        FacebookReelsEntryScenario::BlockedByLogin,
        FacebookReelsEntryScenario::BlockedByCaptcha,
    ] {
        let (blocked, blocked_requests) = run_facebook_reels_entry(scenario).await;
        assert_eq!(
            blocked.effect_phase,
            EffectPhase::NotStarted,
            "unexpected blocker phase for {scenario:?}"
        );
        assert_eq!(method_count(&blocked_requests, "Page.navigate"), 0);
        assert_eq!(method_count(&blocked_requests, "Page.bringToFront"), 0);
        assert!(raw_dispatched_keys(&blocked_requests).is_empty());
    }

    let (consent, consent_requests) =
        run_facebook_reels_entry(FacebookReelsEntryScenario::BlockedByConsent).await;
    assert_eq!(consent.effect_phase, EffectPhase::Ambiguous);
    let CommandOutput::ActionReceipt(receipt) = consent.output.expect("consent receipt") else {
        panic!("expected consent action receipt")
    };
    assert_eq!(receipt.reason.as_deref(), Some("reels_target_unavailable"));
    assert_eq!(method_count(&consent_requests, "Page.navigate"), 1);
    assert!(raw_dispatched_keys(&consent_requests).is_empty());

    let (unknown_copy, unknown_copy_requests) =
        run_facebook_reels_entry(FacebookReelsEntryScenario::UnknownActionRestriction).await;
    assert_eq!(unknown_copy.effect_phase, EffectPhase::Confirmed);
    assert_eq!(method_count(&unknown_copy_requests, "Page.navigate"), 1);
    assert!(raw_dispatched_keys(&unknown_copy_requests).is_empty());

    let (blocked_after_route, blocked_after_route_requests) =
        run_facebook_reels_entry(FacebookReelsEntryScenario::BlockedAfterNavigation).await;
    assert_eq!(blocked_after_route.effect_phase, EffectPhase::Ambiguous);
    assert_eq!(
        method_count(&blocked_after_route_requests, "Page.navigate"),
        1
    );
    assert_eq!(
        method_count(&blocked_after_route_requests, "Page.bringToFront"),
        0
    );
    assert!(raw_dispatched_keys(&blocked_after_route_requests).is_empty());

    let (drifted, drifted_requests) =
        run_facebook_reels_entry(FacebookReelsEntryScenario::DocumentDrifts).await;
    assert_eq!(drifted.effect_phase, EffectPhase::Ambiguous);
    assert_eq!(method_count(&drifted_requests, "Page.navigate"), 1);
    assert_eq!(method_count(&drifted_requests, "Page.bringToFront"), 0);
    assert!(raw_dispatched_keys(&drifted_requests).is_empty());
}

#[tokio::test]
async fn facebook_reels_entry_rechecks_cancellation_before_each_route() {
    let (before_route, before_route_requests) = run_facebook_reels_entry_with_cancellation(
        FacebookReelsEntryScenario::CancelBeforeFirstNavigation,
    )
    .await;
    assert_eq!(before_route.effect_phase, EffectPhase::NotStarted);
    assert_eq!(
        before_route.error.expect("pre-route cancellation").code,
        ErrorCode::Cancelled
    );
    assert_eq!(method_count(&before_route_requests, "Page.navigate"), 0);

    let (before_retry, before_retry_requests) = run_facebook_reels_entry_with_cancellation(
        FacebookReelsEntryScenario::CancelBeforeRetryNavigation,
    )
    .await;
    assert_eq!(before_retry.effect_phase, EffectPhase::Ambiguous);
    let CommandOutput::ActionReceipt(receipt) = before_retry
        .output
        .expect("post-route cancellation receipt")
    else {
        panic!("expected post-route cancellation receipt")
    };
    assert_eq!(
        receipt.reason.as_deref(),
        Some("reels_entry_cancelled_after_route")
    );
    assert_eq!(method_count(&before_retry_requests, "Page.navigate"), 1);
    assert_eq!(method_count(&before_retry_requests, "Page.bringToFront"), 1);
}

#[tokio::test]
async fn facebook_feed_scroll_dispatches_a_humanized_multi_frame_wheel_gesture() {
    let (port, server) = spawn_facebook_feed_scroll_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "feed-scroll-humanized-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 8_000,
            command: NativeCommand::PageScroll(PageScrollParams {
                reason: Some("feed_scroll".to_owned()),
                surface: None,
                dwell_ms: None,
            }),
        })
        .await
        .expect("Feed scroll");
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::PageCards(cards) = outcome.output.expect("Feed cards") else {
        panic!("expected Feed cards")
    };
    assert_eq!(
        cards.cards[0].note_id.as_deref(),
        Some("https://www.facebook.com/Alice/posts/pfbidAFTER")
    );

    engine.shutdown().await;
    let requests = server.await.expect("Facebook Feed scroll fake CDP");
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Page.bringToFront"),
        "routine Feed scroll must remain in the background"
    );
    let move_index = requests
        .iter()
        .position(|request| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseMoved"
        })
        .expect("viewport-centre pointer move");
    let wheel_requests = requests
        .iter()
        .enumerate()
        .filter(|(_, request)| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseWheel"
        })
        .collect::<Vec<_>>();
    assert!((8..=15).contains(&wheel_requests.len()));
    assert!(move_index < wheel_requests[0].0);
    let deltas = wheel_requests
        .iter()
        .map(|(_, request)| {
            assert_eq!(request["params"]["x"], 720.0);
            let y = request["params"]["y"].as_f64().expect("wheel y");
            assert!((y - 440.0).abs() < f64::EPSILON * 512.0);
            request["params"]["deltaY"].as_f64().expect("wheel delta")
        })
        .collect::<Vec<_>>();
    assert!((520.0..=780.0).contains(&deltas.iter().sum::<f64>()));
    let peak = deltas
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| left.total_cmp(right))
        .map(|(index, _)| index)
        .expect("wheel peak");
    assert!(peak > 0 && peak + 1 < deltas.len());
}

#[tokio::test]
async fn facebook_reel_discovery_route_never_receives_a_keyboard_probe() {
    let (port, server) =
        spawn_facebook_feed_scroll_cdp_for("https://www.facebook.com/reel/hashtag/cats").await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_reel_scroll_command(
            "reel-discovery-scroll-1",
            1,
            8_000,
        ))
        .await
        .expect("Reel discovery route scroll");
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);

    engine.shutdown().await;
    let requests = server.await.expect("Reel discovery route fake CDP");
    assert!(raw_dispatched_keys(&requests).is_empty());
    assert!(method_count(&requests, "Input.dispatchMouseEvent") > 0);
}

#[tokio::test]
async fn facebook_feed_scroll_foregrounds_once_after_proven_background_no_movement() {
    let (outcome, requests) =
        run_facebook_feed_scroll_recovery(FacebookFeedScrollRecovery::Moves).await;

    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::PageCards(cards) = outcome.output.expect("Feed cards") else {
        panic!("expected Feed cards")
    };
    assert_eq!(
        cards.cards[0].note_id.as_deref(),
        Some("https://www.facebook.com/Alice/posts/pfbidAFTER")
    );

    let gesture_starts = requests
        .iter()
        .enumerate()
        .filter(|(_, request)| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseMoved"
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let foreground = requests
        .iter()
        .position(|request| request["method"] == "Page.bringToFront")
        .expect("foreground activation");
    assert_eq!(gesture_starts.len(), 2);
    assert!(gesture_starts[0] < foreground && foreground < gesture_starts[1]);
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "Page.bringToFront")
            .count(),
        1
    );
}

#[tokio::test]
async fn facebook_feed_scroll_is_ambiguous_when_the_foreground_retry_still_does_not_move() {
    let (outcome, requests) =
        run_facebook_feed_scroll_recovery(FacebookFeedScrollRecovery::Still).await;

    assert_eq!(outcome.effect_phase, EffectPhase::Ambiguous);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("scroll receipt") else {
        panic!("expected scroll action receipt")
    };
    assert!(!receipt.ok);
    assert_eq!(
        receipt.reason.as_deref(),
        Some("scroll_movement_unconfirmed")
    );

    assert_eq!(pointer_event_count(&requests, "mouseMoved"), 2);
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "Page.bringToFront")
            .count(),
        1
    );
}

#[tokio::test]
async fn facebook_feed_scroll_does_not_foreground_after_document_drift() {
    let (outcome, requests) =
        run_facebook_feed_scroll_recovery(FacebookFeedScrollRecovery::Drifts).await;

    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    assert_eq!(pointer_event_count(&requests, "mouseMoved"), 1);
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Page.bringToFront")
    );
}

/// 三条 feed-recovery 用例的恢复落点。**必须互不相同**，原因是进程级共享状态：
///
/// `src/input.rs` 的「上一次点击落点」（`LAST_POINTER_LANDING`）是 `static`，
/// 而一个 `tests/*.rs` 文件 = 一个测试二进制 = 一个进程，同文件内的 `#[tokio::test]` 默认并行跑
/// ⇒ 它们共享这个全局。点击起点取 `options.from` → 上一次落点 → 默认起点（`src/input.rs:993-996`）；
/// feed-recovery 这条路径不传 `options.from`，所以**真的会读到别的用例留下的落点**。
///
/// 两条用例若共用落点：后跑的那条起点就已经在目标上 ⇒ 距离落进
/// `POINTER_DEGENERATE_DISTANCE_PX`（2.0）⇒ 轨迹塌成单帧 ⇒ `assert_humanized_single_click`
/// 的「不得瞬移到目标坐标」当场红。落点两端各带 ±3px 抖动，所以是**概率事件**、表现为抖动而非必红。
///
/// MUST NOT 让任意两条共用同一坐标，也 MUST NOT 把新用例的落点设到与这三条相近的位置 ——
/// `feed_recovery_targets_stay_pairwise_distant` 会挡住前者。
/// **生产语义无须改动**：一个引擎进程只驱动一个浏览器、命令串行，
/// 「光标已经在那儿就不再移动」是对的行为（两步点赞的第二步正依赖它留在走廊内）。
const FEED_RECOVERY_TARGET_TRUSTED_CLICK: (f64, f64) = (540.0, 330.0);
const FEED_RECOVERY_TARGET_WATCHDOG: (f64, f64) = (386.0, 214.0);
const FEED_RECOVERY_TARGET_UNCONFIRMED: (f64, f64) = (884.0, 262.0);

/// 守卫上面那条不变量：把任意两个落点改成相同（或相近）值，这条用例立刻红。
///
/// 抖动本身只能用频率数据佐证、不能靠单条断言证伪，所以这里守的是**可确定性检验的那一半**：
/// 「三条并行用例的落点两两远离」。门槛取 64px —— 远大于两端各 ±3px 抖动加取整的最坏情形，
/// 也远大于 `POINTER_DEGENERATE_DISTANCE_PX`（2.0），留足后人微调坐标的余量。
#[test]
fn feed_recovery_targets_stay_pairwise_distant() {
    const MIN_SEPARATION_PX: f64 = 64.0;
    let targets = [
        ("trusted_click", FEED_RECOVERY_TARGET_TRUSTED_CLICK),
        ("watchdog", FEED_RECOVERY_TARGET_WATCHDOG),
        ("unconfirmed", FEED_RECOVERY_TARGET_UNCONFIRMED),
    ];
    for (index, (left_name, left)) in targets.iter().enumerate() {
        for (right_name, right) in targets.iter().skip(index + 1) {
            let distance = (left.0 - right.0).hypot(left.1 - right.1);
            assert!(
                distance >= MIN_SEPARATION_PX,
                "feed-recovery 落点 {left_name}{left:?} 与 {right_name}{right:?} 相距 {distance:.1}px，\
                 小于 {MIN_SEPARATION_PX}px。并行用例共用进程级「上一次点击落点」，\
                 落点太近会让后跑的那条轨迹塌成单帧、「不得瞬移」断言偶发变红。"
            );
        }
    }
}

#[tokio::test]
async fn facebook_feed_recovery_uses_one_trusted_cdp_click_before_returning_cards() {
    let (port, server) =
        spawn_facebook_feed_recovery_cdp(true, FEED_RECOVERY_TARGET_TRUSTED_CLICK).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    // 与「等不到后置状态」那条同源：命令原子预算 = min(会话 timeout_ms, 命令种类上限)，
    // 而 `session_open` 默认只有 2s。恢复链是「导航 + 判稳 + 取点 + 点击 + 后置确认」，
    // 机器有负载时这 2s 会在点到之前就用光，回执退化成合成 CdpTimeout（trace 里只到 feed_probe，
    // 没有 dispatchMouseEvent）。取 90s，让判定与机器负载无关。
    open.params.timeout_ms = 90_000;
    engine.open(&open).await.expect("open Facebook session");
    let mut command = browse_command(1);
    command.deadline_unix_ms = unix_time_ms() + 30_000;

    let outcome = engine
        .execute(&command)
        .await
        .expect("Facebook Feed recovery");
    engine.shutdown().await;
    let requests = server.await.expect("Facebook Feed recovery fake CDP");
    let trace = requests
        .iter()
        .map(|request| {
            (
                request["method"].as_str().unwrap_or_default(),
                router_kind(request),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        outcome.effect_phase,
        EffectPhase::Confirmed,
        "unexpected recovery outcome: {outcome:?}; requests={trace:?}"
    );
    let CommandOutput::PageCards(cards) = outcome.output.expect("Feed cards") else {
        panic!("expected Feed cards")
    };
    assert_eq!(
        cards.cards[0].note_id.as_deref(),
        Some("https://www.facebook.com/Alice/posts/pfbidRECOVERED")
    );

    assert_eq!(router_call_count(&requests, "feed_recovery_target"), 1);
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Page.bringToFront"),
        "initial Feed recovery must not independently foreground AdsPower"
    );
    assert_humanized_single_click(&requests);
    // 落点判据从「所有鼠标事件都恰在目标坐标」改为「按下 / 抬起落在目标的有界抖动内且同点」：
    // 移动帧本来就沿轨迹分布，逐帧钉死目标坐标等于要求瞬移。抖动上限与原语的落点抖动同源。
    assert_pointer_commit_near(
        &requests,
        FEED_RECOVERY_TARGET_TRUSTED_CLICK.0,
        FEED_RECOVERY_TARGET_TRUSTED_CLICK.1,
    );
}

#[tokio::test]
async fn facebook_watchdog_feed_recovery_foregrounds_once_without_duplicate_activation() {
    let (port, server) =
        spawn_facebook_feed_recovery_cdp(true, FEED_RECOVERY_TARGET_WATCHDOG).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 90_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "watchdog-feed-recovery-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 30_000,
            command: NativeCommand::PageScroll(PageScrollParams {
                reason: Some("idle_recover_nudge".to_owned()),
                surface: None,
                dwell_ms: None,
            }),
        })
        .await
        .expect("watchdog Feed recovery");

    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    engine.shutdown().await;
    let requests = server
        .await
        .expect("watchdog Facebook Feed recovery fake CDP");
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "Page.bringToFront")
            .count(),
        1,
        "Feed recovery must not add a second foreground activation"
    );
    assert_eq!(router_call_count(&requests, "feed_recovery_target"), 1);
    assert_eq!(pointer_event_count(&requests, "mousePressed"), 1);
    assert_eq!(pointer_event_count(&requests, "mouseReleased"), 1);
    assert_pointer_commit_near(
        &requests,
        FEED_RECOVERY_TARGET_WATCHDOG.0,
        FEED_RECOVERY_TARGET_WATCHDOG.1,
    );
}

#[tokio::test]
async fn facebook_feed_recovery_click_without_home_postcondition_is_ambiguous() {
    let (port, server) =
        spawn_facebook_feed_recovery_cdp(false, FEED_RECOVERY_TARGET_UNCONFIRMED).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    // 命令原子预算 = min(会话 timeout_ms, 命令种类上限)，而 `session_open` 的默认 timeout_ms 只有 2s，
    // 比 8s 恢复窗还短。沿用默认值时外层必先到点，诚实回执（feed_recovery_navigation_unconfirmed）
    // 被改判成合成的 CdpTimeout；改 deadline_unix_ms 对此**无效**——绑定项从来不是它。
    // 与本文件其它长流程用例一致取 90s，让恢复窗成为唯一约束项，判定与机器负载无关。
    open.params.timeout_ms = 90_000;
    engine.open(&open).await.expect("open Facebook session");
    let mut command = browse_command(1);
    command.deadline_unix_ms = unix_time_ms() + 30_000;

    let outcome = engine
        .execute(&command)
        .await
        .expect("Facebook Feed recovery without postcondition");
    engine.shutdown().await;
    let requests = server
        .await
        .expect("Facebook Feed unconfirmed recovery fake CDP");
    assert_eq!(outcome.effect_phase, EffectPhase::Ambiguous);
    let Some(output) = outcome.output.as_ref() else {
        panic!("expected scroll receipt, got {outcome:?}");
    };
    let CommandOutput::ActionReceipt(receipt) = output else {
        panic!("expected scroll receipt")
    };
    assert!(!receipt.ok);
    assert_eq!(
        receipt.reason.as_deref(),
        Some("feed_recovery_navigation_unconfirmed")
    );

    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Page.bringToFront"),
        "unconfirmed Feed recovery must remain in the background"
    );
    assert_humanized_single_click(&requests);
    // 本条原先只断言形状、不断言落点，于是「夹具收到的落点」无人校验：
    // 传错常量（例如与另一条用例共用）不会有任何用例变红，撞车会悄悄回来。补上落点断言把这一环闭合。
    assert_pointer_commit_near(
        &requests,
        FEED_RECOVERY_TARGET_UNCONFIRMED.0,
        FEED_RECOVERY_TARGET_UNCONFIRMED.1,
    );
}

#[tokio::test]
async fn facebook_resume_redrive_on_active_reel_reports_current_without_extra_navigation() {
    let (port, server) =
        spawn_facebook_reel_active_key_probe_cdp(FacebookReelKeyScenario::RightMoves).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 10_000;
    engine.open(&open).await.expect("open Facebook session");
    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "reel-resume-redrive-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 10_000,
            command: NativeCommand::PageScroll(PageScrollParams {
                reason: Some("resume_redrive".to_owned()),
                surface: Some(BrowseSurface::Reels),
                dwell_ms: None,
            }),
        })
        .await
        .expect("active Reels resume redrive");
    engine.shutdown().await;
    let requests = server.await.expect("active Reels resume fake CDP");

    assert_eq!(
        outcome.effect_phase,
        EffectPhase::Confirmed,
        "unexpected resume outcome: {outcome:?}",
    );
    let CommandOutput::PageCards(cards) = outcome.output.expect("current Reel cards") else {
        panic!("expected current Reel cards")
    };
    assert_eq!(cards.cards.len(), 1);
    assert_eq!(method_count(&requests, "Page.navigate"), 0);
    assert_eq!(method_count(&requests, "Input.dispatchKeyEvent"), 0);
    assert_eq!(method_count(&requests, "Input.dispatchMouseEvent"), 0);
}

#[tokio::test]
async fn facebook_watchdog_reel_scroll_foregrounds_once_before_trusted_arrow() {
    let (port, server) =
        spawn_facebook_reel_active_key_probe_cdp(FacebookReelKeyScenario::RightMoves).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "reel-scroll-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 5_000,
            command: NativeCommand::PageScroll(PageScrollParams {
                reason: Some("idle_recover_nudge".to_owned()),
                surface: None,
                dwell_ms: Some(7_000),
            }),
        })
        .await
        .expect("Reel scroll");

    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::PageCards(cards) = outcome.output.expect("Reel cards") else {
        panic!("expected Reel cards")
    };
    assert_eq!(cards.cards.len(), 1);
    assert_eq!(
        cards.cards[0].note_id.as_deref(),
        Some("https://www.facebook.com/reel/2")
    );

    engine.shutdown().await;
    let requests = server.await.expect("Facebook Reel fake CDP");
    let input_requests = requests
        .iter()
        .filter(|request| request["method"] == "Input.dispatchKeyEvent")
        .collect::<Vec<_>>();
    let foreground = requests
        .iter()
        .position(|request| request["method"] == "Page.bringToFront")
        .expect("watchdog Facebook page scroll must foreground the exact target");
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "Page.bringToFront")
            .count(),
        1,
        "one watchdog scroll must foreground exactly once"
    );
    let first_input = requests
        .iter()
        .position(|request| request["method"] == "Input.dispatchKeyEvent")
        .expect("Reel scroll input");
    assert!(foreground < first_input);
    assert_eq!(input_requests.len(), 2);
    assert_eq!(input_requests[0]["params"]["type"], "rawKeyDown");
    assert_eq!(input_requests[0]["params"]["key"], "ArrowRight");
    assert_eq!(input_requests[1]["params"]["type"], "keyUp");
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Input.dispatchMouseEvent")
    );
}

#[tokio::test]
async fn facebook_axisless_live_shape_uses_the_default_horizontal_probe() {
    let (port, server) =
        spawn_facebook_reel_active_key_probe_cdp(FacebookReelKeyScenario::MissingActiveVideoSafe)
            .await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "reel-scroll-anonymous-horizontal-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 5_000,
            command: NativeCommand::PageScroll(PageScrollParams {
                reason: Some("feed_scroll".to_owned()),
                surface: None,
                dwell_ms: None,
            }),
        })
        .await
        .expect("axisless Reel scroll");

    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::PageCards(cards) = outcome.output.expect("Reel cards") else {
        panic!("expected Reel cards")
    };
    assert_eq!(cards.cards.len(), 1);
    assert_eq!(
        cards.cards[0].note_id.as_deref(),
        Some("https://www.facebook.com/reel/2")
    );

    engine.shutdown().await;
    let requests = server.await.expect("axisless Reel fake CDP");
    let input_requests = requests
        .iter()
        .filter(|request| request["method"] == "Input.dispatchKeyEvent")
        .collect::<Vec<_>>();
    assert_eq!(input_requests.len(), 2);
    assert_eq!(input_requests[0]["params"]["key"], "ArrowRight");
    assert_eq!(input_requests[0]["params"]["windowsVirtualKeyCode"], 39);
    assert_eq!(router_request_count(&requests, "reel_next_target"), 0);
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Page.bringToFront"),
        "routine Reels scroll must remain in the background"
    );
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Input.dispatchMouseEvent")
    );
}

#[tokio::test]
async fn facebook_reel_ambiguous_active_structure_still_probes_once_when_safe() {
    let (port, server) =
        spawn_facebook_reel_active_key_probe_cdp(FacebookReelKeyScenario::AmbiguousActiveVideoSafe)
            .await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 8_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "reel-scroll-disabled-forward-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 5_000,
            command: NativeCommand::PageScroll(PageScrollParams {
                reason: Some("feed_scroll".to_owned()),
                surface: None,
                dwell_ms: None,
            }),
        })
        .await
        .expect("ambiguous-structure Reel scroll");

    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    engine.shutdown().await;
    let requests = server.await.expect("ambiguous-structure Reel fake CDP");
    assert_eq!(raw_dispatched_keys(&requests), vec!["ArrowRight"]);
    assert_eq!(router_request_count(&requests, "reel_next_target"), 0);
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Input.dispatchMouseEvent")
    );
}

#[tokio::test]
async fn facebook_reel_unsafe_keyboard_focus_blocks_active_probe_before_input() {
    let (outcome, requests) =
        run_facebook_reel_active_key_probe(FacebookReelKeyScenario::UnsafeFocus).await;

    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    assert!(dispatched_keys(&requests).is_empty());
}

#[tokio::test]
async fn facebook_reel_missing_keyboard_safety_blocks_keys_before_dispatch() {
    let (outcome, requests) =
        run_facebook_reel_active_key_probe(FacebookReelKeyScenario::InputSafetyMissing).await;

    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    assert!(dispatched_keys(&requests).is_empty());
}

#[tokio::test]
async fn facebook_reel_cancellation_and_expired_deadline_dispatch_zero_keys() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_facebook_reel_active_key_probe_cdp_with_cancellation(
        FacebookReelKeyScenario::RightMoves,
        Some(cancellation.clone()),
    )
    .await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    engine.open(&open).await.expect("open Facebook session");
    let cancelled = engine
        .execute_cancellable(
            &facebook_reel_scroll_command("reel-cancel-before-key-1", 1, 5_000),
            cancellation,
        )
        .await
        .expect("cancelled Reels scroll");
    assert_eq!(cancelled.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::ActionReceipt(receipt) = cancelled.output.expect("cancel receipt") else {
        panic!("expected cancel action receipt")
    };
    assert_eq!(
        receipt.reason.as_deref(),
        Some("reels_navigation_cancelled")
    );
    engine.shutdown().await;
    let requests = server.await.expect("cancelled Reel fake CDP");
    assert_eq!(router_request_count(&requests, "reel_probe"), 1);
    assert!(raw_dispatched_keys(&requests).is_empty());

    let (port, server) =
        spawn_facebook_reel_active_key_probe_cdp(FacebookReelKeyScenario::RightMoves).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    engine.open(&open).await.expect("open Facebook session");
    let near_deadline = facebook_reel_scroll_command("reel-near-deadline-before-key-1", 1, 500);
    let near_deadline = engine
        .execute(&near_deadline)
        .await
        .expect("near-deadline Reels scroll");
    assert_eq!(near_deadline.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::ActionReceipt(receipt) = near_deadline.output.expect("deadline receipt")
    else {
        panic!("expected deadline action receipt")
    };
    assert_eq!(
        receipt.reason.as_deref(),
        Some("reels_navigation_deadline_insufficient")
    );
    engine.shutdown().await;
    let requests = server.await.expect("expired Reel fake CDP");
    assert_eq!(router_request_count(&requests, "reel_probe"), 1);
    assert!(raw_dispatched_keys(&requests).is_empty());
}

#[tokio::test]
async fn facebook_group_join_reuses_the_current_page_and_uses_in_page_actuation() {
    let (port, server) = spawn_facebook_group_join_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 90_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "facebook-join-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 10_000,
            command: NativeCommand::GroupJoin(GroupJoinParams {
                group_url: "https://www.facebook.com/groups/42".to_owned(),
                click: Some(true),
                reason: None,
                think_ms: None,
            }),
        })
        .await
        .expect("Facebook group join");

    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("join receipt") else {
        panic!("expected join action receipt")
    };
    assert!(receipt.ok);
    assert_eq!(receipt.clicked, Some(true));

    engine.shutdown().await;
    let requests = server.await.expect("Facebook join fake CDP");
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Page.navigate"),
        "click leg on the canonical group page must reuse the hydrated page"
    );
    assert!(requests.iter().any(|request| {
        request["method"] == "Runtime.evaluate"
            && request
                .pointer("/params/expression")
                .and_then(Value::as_str)
                .is_some_and(|expression| expression.contains(r#""kind":"join_click""#))
    }));
    assert!(requests.iter().all(|request| {
        request["method"] != "Input.dispatchMouseEvent"
            || !matches!(
                request.pointer("/params/type").and_then(Value::as_str),
                Some("mousePressed" | "mouseReleased")
            )
    }));
}

#[tokio::test]
async fn facebook_group_join_preserves_post_navigation_login_and_captcha_blockers() {
    for (blocking_kind, expected_reason) in [
        ("login", "login_required"),
        ("captcha", "blocked_by_captcha"),
    ] {
        let (port, server) = spawn_facebook_group_blocker_cdp(blocking_kind).await;
        let mut engine = Engine::default();
        let mut open = session_open(port);
        open.params.platform = Platform::Facebook;
        open.params.timeout_ms = 90_000;
        engine.open(&open).await.expect("open Facebook session");

        let outcome = engine
            .execute(&CommandRecord {
                protocol_version: 2,
                id: format!("facebook-join-{blocking_kind}"),
                session_id: "session-1".to_owned(),
                task_id: "browse-1".to_owned(),
                command_id: 1,
                deadline_unix_ms: unix_time_ms() + 5_000,
                command: NativeCommand::GroupJoin(GroupJoinParams {
                    group_url: "https://www.facebook.com/groups/42".to_owned(),
                    click: Some(true),
                    reason: None,
                    think_ms: None,
                }),
            })
            .await
            .expect("blocked Facebook group join");

        assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
        let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("blocked join receipt")
        else {
            panic!("expected blocked join action receipt")
        };
        assert!(!receipt.ok);
        assert_eq!(receipt.reason.as_deref(), Some(expected_reason));
        assert_eq!(receipt.clicked, None);

        engine.shutdown().await;
        let requests = server.await.expect("Facebook blocker fake CDP");
        assert!(
            requests
                .iter()
                .any(|request| request["method"] == "Page.navigate"),
            "observe/current-page mismatch must navigate before blocker classification"
        );
        assert!(requests.iter().all(|request| {
            request["method"] != "Runtime.evaluate"
                || !request
                    .pointer("/params/expression")
                    .and_then(Value::as_str)
                    .is_some_and(|expression| expression.contains(r#""kind":"join_click""#))
        }));
    }
}

#[tokio::test]
async fn facebook_group_join_observation_exception_is_not_started_and_diagnostic() {
    let (port, server) = spawn_facebook_group_join_exception_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 90_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "facebook-join-observe-exception".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 5_000,
            command: NativeCommand::GroupJoin(GroupJoinParams {
                group_url: "https://www.facebook.com/groups/42".to_owned(),
                click: Some(false),
                reason: None,
                think_ms: None,
            }),
        })
        .await
        .expect("stored observation failure");

    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    assert!(outcome.output.is_none());
    let error = outcome.error.expect("bounded failure");
    assert_eq!(error.code, ErrorCode::CdpError);
    let diagnostic = error.diagnostic.expect("decode diagnostic");
    assert_eq!(diagnostic.operation_stage, Some("readiness_probe"));
    assert_eq!(
        diagnostic.exception_class,
        Some(CdpExceptionClass::TypeError)
    );
    assert_eq!(
        diagnostic.exception_reason,
        Some(CdpExceptionReason::CannotReadProperty)
    );
    assert_eq!(
        diagnostic.exception_token.as_deref(),
        Some("querySelectorAll")
    );

    engine.shutdown().await;
    let requests = server.await.expect("Facebook exception fake CDP");
    assert!(requests.iter().all(|request| {
        request["method"] != "Runtime.evaluate"
            || !request
                .pointer("/params/expression")
                .and_then(Value::as_str)
                .is_some_and(|expression| expression.contains(r#""kind":"join_click""#))
    }));
}

#[tokio::test]
async fn facebook_reel_scroll_without_active_video_uses_one_safe_probe() {
    let (port, server) =
        spawn_facebook_reel_active_key_probe_cdp(FacebookReelKeyScenario::MissingActiveVideoSafe)
            .await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "reel-scroll-missing-active-video-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 5_000,
            command: NativeCommand::PageScroll(PageScrollParams {
                reason: Some("feed_scroll".to_owned()),
                surface: None,
                dwell_ms: None,
            }),
        })
        .await
        .expect("Reel scroll without active video");

    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::PageCards(cards) = outcome.output.expect("Reel cards") else {
        panic!("expected Reel cards")
    };
    assert_eq!(
        cards.cards[0].note_id.as_deref(),
        Some("https://www.facebook.com/reel/2")
    );

    engine.shutdown().await;
    let requests = server
        .await
        .expect("Facebook missing active video fake CDP");
    assert_eq!(raw_dispatched_keys(&requests), vec!["ArrowRight"]);
    assert_eq!(router_request_count(&requests, "reel_next_target"), 0);
    assert_eq!(method_count(&requests, "Page.bringToFront"), 0);
}

#[tokio::test]
async fn facebook_reel_scroll_returns_ambiguous_after_one_key_without_fabricated_cards() {
    let (outcome, requests) =
        run_facebook_reel_active_key_probe(FacebookReelKeyScenario::NeverMoves).await;

    assert_eq!(outcome.effect_phase, EffectPhase::Ambiguous);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("scroll receipt") else {
        panic!("expected scroll action receipt")
    };
    assert_eq!(receipt.action, "scroll");
    assert!(!receipt.ok);
    assert_eq!(
        receipt.reason.as_deref(),
        Some("reels_navigation_unconfirmed")
    );
    // 未确认回执 MUST 带回此刻站着的 Reel 身份（change converge-facebook-reel-navigation-confirmation）：
    // 消费方靠它把「没往前走」与「读不出身份」分开。该场景里 Reel 始终停在 reel/1。
    assert_eq!(
        receipt.note_id.as_deref(),
        Some("https://www.facebook.com/reel/1"),
        "unconfirmed navigation must name the Reel it is standing on"
    );

    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Page.bringToFront"),
        "routine ambiguous Reels scroll must remain in the background"
    );
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Page.navigate")
    );
    assert_eq!(raw_dispatched_keys(&requests), vec!["ArrowRight"]);
    assert_eq!(router_request_count(&requests, "reel_next_target"), 0);
    assert_eq!(method_count(&requests, "Input.dispatchMouseEvent"), 0);
}

#[tokio::test]
async fn facebook_reel_probe_key_alternates_then_retains_the_confirmed_key() {
    let (port, server) =
        spawn_facebook_reel_active_key_probe_cdp(FacebookReelKeyScenario::RightMissesThenDownMoves)
            .await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 25_000;
    engine.open(&open).await.expect("open Facebook session");

    let command = |id: &str, command_id: u64| CommandRecord {
        protocol_version: 2,
        id: id.to_owned(),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + 25_000,
        command: NativeCommand::PageScroll(PageScrollParams {
            reason: Some("feed_scroll".to_owned()),
            surface: None,
            dwell_ms: None,
        }),
    };
    let first = engine
        .execute(&command("reel-scroll-1", 1))
        .await
        .expect("first scroll");
    assert_eq!(first.effect_phase, EffectPhase::Ambiguous);
    let CommandOutput::ActionReceipt(first_receipt) = first.output.expect("first receipt") else {
        panic!("expected first failed receipt")
    };
    assert_eq!(
        first_receipt.reason.as_deref(),
        Some("reels_navigation_unconfirmed")
    );
    // 第一次 ArrowRight 没能推进 ⇒ 仍停在 reel/1，回执 MUST 具名说出这一点，
    // 否则「没往前走」和「读不出身份」在下游又并成一态。
    assert_eq!(
        first_receipt.note_id.as_deref(),
        Some("https://www.facebook.com/reel/1")
    );

    let second = engine
        .execute(&command("reel-scroll-2", 2))
        .await
        .expect("second scroll");
    assert_eq!(second.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::PageCards(cards) = second.output.expect("second cards") else {
        panic!("expected second Reel cards")
    };
    assert_eq!(
        cards.cards[0].note_id.as_deref(),
        Some("https://www.facebook.com/reel/2")
    );

    let third = engine
        .execute(&command("reel-scroll-3", 3))
        .await
        .expect("third scroll");
    assert_eq!(third.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::PageCards(cards) = third.output.expect("third cards") else {
        panic!("expected third Reel cards")
    };
    assert_eq!(
        cards.cards[0].note_id.as_deref(),
        Some("https://www.facebook.com/reel/3")
    );

    engine.shutdown().await;
    let requests = server.await.expect("independent Reel command fake CDP");
    assert_eq!(
        raw_dispatched_keys(&requests),
        vec!["ArrowRight", "ArrowDown", "ArrowDown"]
    );
    assert_eq!(router_request_count(&requests, "reel_next_target"), 0);
    assert_eq!(method_count(&requests, "Input.dispatchMouseEvent"), 0);
}

#[tokio::test]
async fn facebook_reel_like_direct_commit_uses_one_primary_write_and_no_picker_write() {
    let (port, server) =
        spawn_facebook_interaction_cdp(FacebookInteractionScenario::LikeDirect).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 8_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_like_command(1))
        .await
        .expect("direct Reel like");
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("like receipt") else {
        panic!("expected action receipt")
    };
    assert!(receipt.ok);

    engine.shutdown().await;
    let requests = server.await.expect("Facebook interaction fake CDP");
    assert_eq!(router_call_count(&requests, "like_primary_commit"), 1);
    assert_eq!(router_call_count(&requests, "like_picker_probe"), 0);
    assert_eq!(mouse_dispatch_count(&requests), 0);
}

#[tokio::test]
async fn facebook_reel_like_waits_for_a_replacement_control_without_replaying_the_write() {
    let (port, server) =
        spawn_facebook_interaction_cdp(FacebookInteractionScenario::LikeTransientVerify).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 8_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_like_command(1))
        .await
        .expect("transient Reel like verification");
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("like receipt") else {
        panic!("expected action receipt")
    };
    assert!(receipt.ok);

    engine.shutdown().await;
    let requests = server.await.expect("Facebook interaction fake CDP");
    assert_eq!(router_call_count(&requests, "like_primary_commit"), 1);
    assert_eq!(router_call_count(&requests, "like_verify"), 2);
    assert_eq!(router_call_count(&requests, "like_picker_probe"), 0);
    assert_eq!(mouse_dispatch_count(&requests), 0);
}

#[tokio::test]
async fn facebook_reel_like_stops_when_verification_observes_another_reel() {
    let (port, server) =
        spawn_facebook_interaction_cdp(FacebookInteractionScenario::LikeMovedDuringVerify).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 8_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_like_command(1))
        .await
        .expect("moved Reel like verification");
    assert_eq!(outcome.effect_phase, EffectPhase::Ambiguous);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("like receipt") else {
        panic!("expected action receipt")
    };
    assert!(!receipt.ok);
    assert_eq!(receipt.reason.as_deref(), Some("verify_indeterminate"));

    engine.shutdown().await;
    let requests = server.await.expect("Facebook interaction fake CDP");
    assert_eq!(router_call_count(&requests, "like_primary_commit"), 1);
    assert_eq!(router_call_count(&requests, "like_verify"), 1);
    assert_eq!(router_call_count(&requests, "like_picker_probe"), 0);
}

#[tokio::test]
async fn facebook_reel_like_picker_commit_is_bounded_to_one_trusted_pointer_write() {
    let (port, server) =
        spawn_facebook_interaction_cdp(FacebookInteractionScenario::LikePicker).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 8_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_like_command(1))
        .await
        .expect("picker Reel like");
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("like receipt") else {
        panic!("expected action receipt")
    };
    assert!(receipt.ok);

    engine.shutdown().await;
    let requests = server.await.expect("Facebook interaction fake CDP");
    assert_eq!(router_call_count(&requests, "like_primary_commit"), 1);
    assert_eq!(router_call_count(&requests, "like_picker_probe"), 1);
    assert_eq!(pointer_event_count(&requests, "mousePressed"), 1);
    assert_eq!(pointer_event_count(&requests, "mouseReleased"), 1);
    assert!(mouse_dispatch_count(&requests) > 3, "点击必须逐帧移动");

    // 这一次点击打的是**反应浮层**，它只在光标停在帖级 react 控件上时才展开：轨迹必须贴着
    // 「控件 → 浮层」走廊走。中途离开 hover 区，浮层在半路收起，点击落在空处 ——
    // 页面上什么都没发生，而回执照报「点了」。
    // 本路径的主控件提交走的是**注入路由**、不是 CDP 指针，所以浮层这次点击之前没有任何
    // 真实落点可继承；起点必须由调用方显式给出（夹具：控件 (1010, 525) → 浮层 (955, 485)）。
    let press = requests
        .iter()
        .position(|request| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mousePressed"
        })
        .expect("picker press");
    let corridor = pointer_moves_between(&requests, 0, press);
    assert_pointer_stays_in_corridor(&corridor, (1010.0, 525.0), (955.0, 485.0));
}

/// 点击之后 `like_probe` 怎么答。这三档正是本组用例要分开的三态。
#[derive(Clone, Copy)]
enum ReelSurfaceLikeAfterClick {
    /// 读得到、且确实已经点上。
    Liked,
    /// **探针读不到**（目标丢了 / 身份读不出）。MUST NOT 被回报成「确实没点上」。
    Unreadable,
    /// 读得到、且确实没点上。
    Unchanged,
}

/// Reels 面 + **身份退化**（`note_id` 不是 `/reel/` 地址）那条点赞分支的假 CDP。
///
/// 这条分支在接线前没有任何 Rust 用例，所以它的两态塌陷缺陷一直没有任何测试会喊。
async fn spawn_facebook_reel_surface_like_cdp(
    after_click: ReelSurfaceLikeAfterClick,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, "https://www.facebook.com/reels/tab").await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut clicked = false;
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            if request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseReleased"
            {
                clicked = true;
            }
            let result = match router_kind(&request).as_deref() {
                Some("page_probe") => facebook_ready_cdp("/reels/tab"),
                Some("consent_probe") => facebook_consent_absent_cdp(),
                // 匿名 reel 探针：是 Reels 面，但读不出帖子身份 —— 这正是本分支的触发前提。
                Some("reel_probe") => anonymous_reel_probe_cdp("video-9001@element:1"),
                Some("like_probe") => {
                    if !clicked {
                        router_cdp(
                            "like_probe",
                            json!({"ok": true, "already": false, "cx": 612.0, "cy": 408.0}),
                        )
                    } else {
                        match after_click {
                            ReelSurfaceLikeAfterClick::Liked => router_cdp(
                                "like_probe",
                                json!({"ok": true, "already": true, "cx": 612.0, "cy": 408.0}),
                            ),
                            ReelSurfaceLikeAfterClick::Unreadable => router_cdp(
                                "like_probe",
                                json!({"ok": false, "reason": "target_not_found"}),
                            ),
                            ReelSurfaceLikeAfterClick::Unchanged => router_cdp(
                                "like_probe",
                                json!({"ok": true, "already": false, "cx": 612.0, "cy": 408.0}),
                            ),
                        }
                    }
                }
                Some("like_picker_probe") => router_cdp(
                    "point_target",
                    json!({"ok": true, "cx": 744.0, "cy": 296.0}),
                ),
                _ => json!({}),
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

fn reel_surface_like_command(command_id: u64) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("facebook-reel-surface-like-{command_id}"),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        command_id,
        // 两轮后置校验最坏 2s + 3s，另加探针往返。取 30s 让判定与机器负载无关
        // （与本文件其它长流程用例同口径；短预算会把负载抖动读成行为缺陷）。
        deadline_unix_ms: unix_time_ms() + 30_000,
        command: NativeCommand::InteractionLike(NoteInteractionParams {
            // 关键：**不是** `/reel/` 地址，于是走 `feed_like.rs` 的 Reels 面身份退化分支。
            note_id: "https://www.facebook.com/watch/?v=9001".to_owned(),
            reason: None,
            think_ms: None,
        }),
    }
}

async fn run_reel_surface_like(
    after_click: ReelSurfaceLikeAfterClick,
) -> (EffectPhase, ActionReceipt, Vec<Value>) {
    let (port, server) = spawn_facebook_reel_surface_like_cdp(after_click).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open Facebook session");
    let outcome = engine
        .execute(&reel_surface_like_command(1))
        .await
        .expect("Reels surface like");
    engine.shutdown().await;
    let requests = server.await.expect("Reels surface like fake CDP");
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("like receipt") else {
        panic!("expected action receipt")
    };
    (outcome.effect_phase, *receipt, requests)
}

#[tokio::test]
async fn reel_surface_like_confirms_when_the_reread_shows_the_like_landed() {
    let (phase, receipt, requests) = run_reel_surface_like(ReelSurfaceLikeAfterClick::Liked).await;
    assert_eq!(phase, EffectPhase::Confirmed);
    assert!(receipt.ok);
    // 一次确认就收工：不得再去点反应浮层。
    assert_eq!(router_call_count(&requests, "like_picker_probe"), 0);
    assert_eq!(pointer_event_count(&requests, "mousePressed"), 1);
}

/// 🔴 本次接线要钉死的红线：**「探针读不到」不是「确实没点上」**。
///
/// 接线前这条路径的后置校验返回 `bool`（`shared.rs` 已删除的 `wait_for_facebook_like`），
/// 两态被压成同一个 `false`，于是目标丢了 / 身份读不出也一律回报 `like_unconfirmed`
/// ——即「读到了、确实没点上」。把 `validate` 里 `!probe.ok` 那一档改回 `Unchanged`，这条用例立刻红。
#[tokio::test]
async fn reel_surface_like_reports_an_unreadable_reread_as_indeterminate_never_as_unchanged() {
    let (phase, receipt, _) = run_reel_surface_like(ReelSurfaceLikeAfterClick::Unreadable).await;
    assert_eq!(phase, EffectPhase::Ambiguous);
    assert!(!receipt.ok);
    assert_eq!(
        receipt.reason.as_deref(),
        Some("verify_indeterminate"),
        "探针读不到必须回 verify_indeterminate；回 like_unconfirmed 等于把「读不到」谎报成「确实没点上」"
    );
}

/// 与上一条成对：真的读到了、真的没点上，才可以回 `like_unconfirmed`。
/// 两条一起才能证明这两态**没有**被压回一态（只测其中一条会被一个恒定返回值骗过）。
#[tokio::test]
async fn reel_surface_like_reports_a_readable_miss_as_unconfirmed() {
    let (phase, receipt, requests) =
        run_reel_surface_like(ReelSurfaceLikeAfterClick::Unchanged).await;
    assert_eq!(phase, EffectPhase::Ambiguous);
    assert!(!receipt.ok);
    assert_eq!(receipt.reason.as_deref(), Some("like_unconfirmed"));
    // 闸②的派发上限：两轮＝两次派发，与 `capability.rs` 的 `max_dispatch_count = 2` 对齐，
    // 且**两次点的是不同目标**（帖级主控件 → 反应浮层），绝不是对同一控件重试。
    assert_eq!(router_call_count(&requests, "like_picker_probe"), 1);
    assert_eq!(pointer_event_count(&requests, "mousePressed"), 2);
}

/// 第二次派发打的是**反应浮层**，而浮层只在光标停在帖级 react 控件上时才展开。
/// 所以那一段轨迹必须贴着「控件 → 浮层」走廊：中途离开 hover 区，浮层就在半路收起，
/// 这一次点击于是落在空处 —— **页面上什么都没发生，回执却照报「点了」**。
///
/// 接线前这一处走的是默认两参调用：起点回落到「目标左上方随机偏移」（本路径的主控件提交
/// 走注入路由，根本没留下过真实落点可继承），而且**过冲仍然允许**。
#[tokio::test]
async fn reel_surface_like_commits_the_flyout_inside_the_control_to_flyout_corridor() {
    // 取「读得到、确实没点上」那一档：只有它会走到第二轮的浮层提交。
    let (_, _, requests) = run_reel_surface_like(ReelSurfaceLikeAfterClick::Unchanged).await;

    // 夹具里的两个落点：帖级主控件 (612, 408) → 浮层「赞」项 (744, 296)。
    const PRIMARY: (f64, f64) = (612.0, 408.0);
    const FLYOUT: (f64, f64) = (744.0, 296.0);

    let presses: Vec<usize> = requests
        .iter()
        .enumerate()
        .filter(|(_, request)| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mousePressed"
        })
        .map(|(index, _)| index)
        .collect();
    assert_eq!(presses.len(), 2, "两轮＝两次派发");

    // 第二段轨迹 = 第一次按下之后、第二次按下之前的全部移动帧。
    let corridor = pointer_moves_between(&requests, presses[0], presses[1]);
    assert_pointer_stays_in_corridor(&corridor, PRIMARY, FLYOUT);
}

/// 一段轨迹里的移动帧坐标（`from` 之后、`to` 之前）。
fn pointer_moves_between(requests: &[Value], from: usize, to: usize) -> Vec<(f64, f64)> {
    requests
        .iter()
        .take(to)
        .skip(from)
        .filter(|request| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseMoved"
        })
        .filter_map(|request| {
            Some((
                request["params"]["x"].as_f64()?,
                request["params"]["y"].as_f64()?,
            ))
        })
        .collect()
}

/// 「控件 → 浮层」走廊的判据：两点外接框加一圈余量（弧线与落点抖动都落在这圈里），
/// 且末帧不得越过终点一侧（禁过冲）。
///
/// 起点没被显式传下去时，起步点会落在**目标**左上方 40~160px 处 —— 那必然越出这个框，
/// 所以这条断言真正杀得死「忘了传走廊起点」这个改动。
fn assert_pointer_stays_in_corridor(moves: &[(f64, f64)], from: (f64, f64), to: (f64, f64)) {
    assert!(moves.len() > 1, "浮层提交不得瞬移");
    let margin = 0.35 * (to.0 - from.0).hypot(to.1 - from.1);
    let min_x = from.0.min(to.0) - margin;
    let max_x = from.0.max(to.0) + margin;
    let min_y = from.1.min(to.1) - margin;
    let max_y = from.1.max(to.1) + margin;
    for (x, y) in moves {
        assert!(
            (min_x..=max_x).contains(x) && (min_y..=max_y).contains(y),
            "移动路径越出「控件 → 浮层」走廊：({x}, {y})"
        );
    }
    let last = moves.last().copied().expect("landing frame");
    assert!(
        last.1 >= to.1 - 4.0,
        "禁过冲：末帧不得越过浮层项落点（越过就等于甩出 hover 区）"
    );
}

#[tokio::test]
async fn facebook_reel_follow_reprobes_before_dispatch_and_rejects_author_movement() {
    let (port, server) =
        spawn_facebook_interaction_cdp(FacebookInteractionScenario::FollowMovedBeforeDispatch)
            .await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 8_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_follow_command(1))
        .await
        .expect("moved Reel follow");
    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("follow receipt") else {
        panic!("expected action receipt")
    };
    assert!(!receipt.ok);
    assert_eq!(
        receipt.reason.as_deref(),
        Some("target_moved_before_dispatch")
    );

    engine.shutdown().await;
    let requests = server.await.expect("Facebook interaction fake CDP");
    assert_eq!(router_call_count(&requests, "follow_probe"), 2);
    assert_eq!(mouse_dispatch_count(&requests), 0);
}

#[tokio::test]
async fn facebook_reel_follow_uses_one_pointer_write_and_same_author_postcondition() {
    let (port, server) =
        spawn_facebook_interaction_cdp(FacebookInteractionScenario::FollowConfirmed).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 8_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_follow_command(1))
        .await
        .expect("confirmed Reel follow");
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("follow receipt") else {
        panic!("expected action receipt")
    };
    assert!(receipt.ok);

    engine.shutdown().await;
    let requests = server.await.expect("Facebook interaction fake CDP");
    assert_eq!(router_call_count(&requests, "follow_probe"), 3);
    assert_eq!(pointer_event_count(&requests, "mousePressed"), 1);
    assert_eq!(pointer_event_count(&requests, "mouseReleased"), 1);
    assert!(mouse_dispatch_count(&requests) > 3, "点击必须逐帧移动");
}

#[tokio::test]
async fn facebook_reel_follow_waits_for_a_replacement_control_without_replaying_the_write() {
    let (port, server) =
        spawn_facebook_interaction_cdp(FacebookInteractionScenario::FollowTransientVerify).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 8_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_follow_command(1))
        .await
        .expect("transient Reel follow verification");
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("follow receipt") else {
        panic!("expected action receipt")
    };
    assert!(receipt.ok);

    engine.shutdown().await;
    let requests = server.await.expect("Facebook interaction fake CDP");
    assert_eq!(router_call_count(&requests, "follow_probe"), 4);
    assert_eq!(pointer_event_count(&requests, "mousePressed"), 1);
    assert_eq!(pointer_event_count(&requests, "mouseReleased"), 1);
}

#[tokio::test]
async fn facebook_reel_follow_stops_when_verification_observes_another_author() {
    let (port, server) =
        spawn_facebook_interaction_cdp(FacebookInteractionScenario::FollowMovedDuringVerify).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 8_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_follow_command(1))
        .await
        .expect("moved Reel follow verification");
    assert_eq!(outcome.effect_phase, EffectPhase::Ambiguous);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("follow receipt") else {
        panic!("expected action receipt")
    };
    assert!(!receipt.ok);
    assert_eq!(receipt.reason.as_deref(), Some("verify_indeterminate"));

    engine.shutdown().await;
    let requests = server.await.expect("Facebook interaction fake CDP");
    assert_eq!(router_call_count(&requests, "follow_probe"), 3);
    assert_eq!(pointer_event_count(&requests, "mousePressed"), 1);
    assert_eq!(pointer_event_count(&requests, "mouseReleased"), 1);
}

#[tokio::test]
async fn facebook_note_open_discards_unrelated_detail_until_requested_identity_hydrates() {
    let (port, server) = spawn_facebook_note_open_hydration_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 20_000;
    engine.open(&open).await.expect("open Facebook session");

    let target = "https://www.facebook.com/groups/100/posts/2579243155868042";
    let outcome = engine
        .execute(&facebook_note_open_command(1, target, 20_000))
        .await
        .expect("Facebook target detail");
    let CommandOutput::NoteDetail(detail) = outcome.output.expect("target detail output") else {
        panic!("expected note detail")
    };
    assert_eq!(
        detail.note_id,
        "https://www.facebook.com/permalink.php?story_fbid=2579243155868042&id=99"
    );

    engine.shutdown().await;
    let requests = server.await.expect("Facebook note hydration fake CDP");
    assert_eq!(
        router_call_count(&requests, "note_open"),
        2,
        "stale detail must be resampled until the requested identity hydrates"
    );
}

#[tokio::test]
async fn facebook_note_open_never_returns_mismatched_detail_as_success() {
    let (port, server) = spawn_facebook_note_open_mismatch_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    // 本例测的是**详情水合窗到点后如实报失败**，那个窗必须是唯一的约束项。
    // 2026-07-29 水合窗随整体 ×1.5 抬到 23s 后，原来的 20s 命令预算反而比内层窗还小：
    // 外层先到点，把诚实的 ProbeFailed 盖成合成的 CdpTimeout —— 正是本轮在治的那类倒挂。
    // 取默认命令天花板 45s，让内层窗继续当约束项。
    open.params.timeout_ms = 45_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_note_open_command(
            1,
            "https://www.facebook.com/groups/100/posts/2579243155868042",
            45_000,
        ))
        .await
        .expect("stored bounded target failure");
    assert!(
        outcome.output.is_none(),
        "mismatched detail must never escape as output"
    );
    assert_eq!(
        outcome.error.expect("target identity failure").code,
        ErrorCode::ProbeFailed
    );

    engine.shutdown().await;
    let samples = server.await.expect("Facebook note mismatch fake CDP");
    assert!(
        samples >= 2,
        "bounded wait must resample instead of accepting the first mismatch"
    );
}

#[tokio::test]
async fn facebook_first_post_scrolls_until_the_below_fold_candidate_hydrates() {
    let (port, server) = spawn_facebook_first_post_below_fold_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_first_post_command(1, 30_000))
        .await
        .expect("Facebook first-post detail");
    let CommandOutput::NoteDetail(detail) = outcome.output.expect("first-post detail output")
    else {
        panic!("expected note detail")
    };
    assert_eq!(
        detail.note_id,
        "https://www.facebook.com/groups/945390701793119/posts/333"
    );

    engine.shutdown().await;
    let requests = server.await.expect("Facebook first-post fake CDP");
    assert_eq!(router_call_count(&requests, "feed_refresh"), 1);
    assert_eq!(router_call_count(&requests, "browse_scroll"), 2);
    assert_eq!(router_call_count(&requests, "comment_editor_probe"), 1);
    assert_eq!(router_call_count(&requests, "note_open"), 1);
    assert_eq!(
        page_navigation_count_to(&requests, "https://www.facebook.com/groups/945390701793119"),
        0,
        "a reusable exact group root must not be navigated again"
    );
    assert_eq!(
        page_navigation_count_to(
            &requests,
            "https://www.facebook.com/groups/945390701793119/posts/333"
        ),
        1,
        "the permalink candidate still requires exactly one detail navigation"
    );
}

#[tokio::test]
async fn facebook_first_post_reuses_an_exact_group_root_for_a_bound_container() {
    let target_ref = format!("aidcp:facebook-group-feed-post:v1:{}", "a1".repeat(32));
    let (port, server) = spawn_facebook_bound_first_post_cdp(target_ref.clone()).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_first_post_command(1, 30_000))
        .await
        .expect("Facebook bound first-post detail");
    let CommandOutput::NoteDetail(detail) = outcome.output.expect("first-post detail output")
    else {
        panic!("expected note detail")
    };
    assert_eq!(detail.note_id, target_ref);
    assert_eq!(detail.content, "permalinkless first post");

    engine.shutdown().await;
    let requests = server.await.expect("Facebook bound first-post fake CDP");
    assert_eq!(router_call_count(&requests, "feed_refresh"), 1);
    assert_eq!(router_call_count(&requests, "browse_scroll"), 0);
    assert_eq!(router_call_count(&requests, "comment_editor_probe"), 1);
    assert_eq!(router_call_count(&requests, "note_open"), 1);
    assert_eq!(
        page_navigation_count_to(&requests, "https://www.facebook.com/groups/945390701793119"),
        0,
        "a ready exact group root with a bound target needs no navigation"
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "Page.navigate")
            .count(),
        0,
        "a bound first post must stay entirely on the reusable group page"
    );
}

#[tokio::test]
async fn facebook_first_post_navigates_once_when_the_current_root_is_not_reusable() {
    let cases = vec![
        (
            "wrong group",
            "https://www.facebook.com/groups/42",
            facebook_first_post_group_root_probe_cdp("/groups/42", "group", Some("42"), true),
        ),
        (
            "group subroute",
            "https://www.facebook.com/groups/945390701793119/posts/333",
            facebook_first_post_group_root_probe_cdp(
                "/groups/945390701793119/posts/333",
                "group",
                Some("945390701793119"),
                true,
            ),
        ),
        (
            "unknown surface",
            "https://www.facebook.com/",
            facebook_unknown_first_post_group_root_probe_cdp(),
        ),
        (
            "malformed probe",
            "https://www.facebook.com/groups/945390701793119",
            router_cdp(
                "first_post_group_root_probe",
                json!({
                    "origin": "https://www.facebook.com",
                    "path": "/groups/945390701793119"
                }),
            ),
        ),
    ];

    for (label, initial_url, root_probe) in cases {
        let target_ref = format!("aidcp:facebook-group-feed-post:v1:{}", "c3".repeat(32));
        let (port, server) = spawn_facebook_first_post_root_fallback_cdp(
            initial_url,
            root_probe,
            target_ref.clone(),
            false,
        )
        .await;
        let mut engine = Engine::default();
        let mut open = session_open(port);
        open.params.platform = Platform::Facebook;
        open.params.timeout_ms = 30_000;
        engine.open(&open).await.expect("open Facebook session");

        let outcome = engine
            .execute(&facebook_first_post_command(1, 30_000))
            .await
            .expect("Facebook first-post fallback detail");
        let CommandOutput::NoteDetail(detail) = outcome.output.expect("first-post detail output")
        else {
            panic!("{label}: expected note detail")
        };
        assert_eq!(detail.note_id, target_ref, "{label}");

        engine.shutdown().await;
        let requests = server.await.expect("Facebook first-post fallback fake CDP");
        assert_eq!(
            page_navigation_count_to(&requests, "https://www.facebook.com/groups/945390701793119"),
            1,
            "{label}: a non-reusable page must navigate to the canonical group root exactly once"
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request["method"] == "Page.navigate")
                .count(),
            1,
            "{label}: a bound target must not add a detail navigation"
        );
    }
}

#[tokio::test]
async fn facebook_first_post_scroll_race_restores_the_root_once_before_selecting() {
    let target_ref = format!("aidcp:facebook-group-feed-post:v1:{}", "d4".repeat(32));
    let (port, server) = spawn_facebook_first_post_root_fallback_cdp(
        "https://www.facebook.com/groups/945390701793119",
        facebook_first_post_group_root_probe_cdp(
            "/groups/945390701793119",
            "group",
            Some("945390701793119"),
            true,
        ),
        target_ref.clone(),
        true,
    )
    .await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_first_post_command(1, 30_000))
        .await
        .expect("Facebook first-post scroll-race recovery");
    let CommandOutput::NoteDetail(detail) = outcome.output.expect("first-post detail output")
    else {
        panic!("expected note detail")
    };
    assert_eq!(detail.note_id, target_ref);

    engine.shutdown().await;
    let requests = server
        .await
        .expect("Facebook first-post scroll-race fake CDP");
    assert_eq!(router_call_count(&requests, "feed_refresh"), 2);
    assert_eq!(
        page_navigation_count_to(&requests, "https://www.facebook.com/groups/945390701793119"),
        1,
        "a scroll-origin race gets one canonical-root recovery"
    );
    assert_eq!(router_call_count(&requests, "comment_editor_probe"), 1);
    assert_eq!(router_call_count(&requests, "note_open"), 1);
}

#[tokio::test]
async fn facebook_first_post_context_recovery_keeps_the_remaining_scroll_budget() {
    let (port, server) = spawn_facebook_first_post_late_context_mismatch_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_first_post_command(1, 30_000))
        .await
        .expect("stored Facebook first-post exhausted result");
    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::ActionReceipt(receipt) =
        outcome.output.expect("first-post exhausted receipt")
    else {
        panic!("expected first-post exhausted receipt")
    };
    assert_eq!(receipt.reason.as_deref(), Some("no_candidates"));

    engine.shutdown().await;
    let requests = server
        .await
        .expect("Facebook first-post remaining-budget fake CDP");
    assert_eq!(
        router_call_count(&requests, "browse_scroll"),
        4,
        "canonical recovery must not reset already consumed scroll rounds"
    );
    assert_eq!(
        page_navigation_count_to(&requests, "https://www.facebook.com/groups/945390701793119"),
        1
    );
    assert_eq!(router_call_count(&requests, "comment_editor_probe"), 0);
    assert_eq!(router_call_count(&requests, "note_open"), 0);
}

#[tokio::test]
async fn facebook_first_post_reuse_context_mismatch_falls_back_only_once() {
    let (port, server) = spawn_facebook_first_post_reuse_context_mismatch_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_first_post_command(1, 30_000))
        .await
        .expect("stored Facebook first-post context mismatch");
    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::ActionReceipt(receipt) =
        outcome.output.expect("first-post mismatch receipt")
    else {
        panic!("expected first-post mismatch receipt")
    };
    assert_eq!(receipt.reason.as_deref(), Some("target_context_mismatch"));

    engine.shutdown().await;
    let requests = server
        .await
        .expect("Facebook first-post context mismatch fake CDP");
    assert_eq!(
        router_call_count(&requests, "first_post_group_root_probe"),
        1,
        "the live-state reuse decision is made once"
    );
    assert_eq!(
        router_call_count(&requests, "feed_refresh"),
        2,
        "the candidate probe is retried once after canonical navigation"
    );
    assert_eq!(
        router_call_count(&requests, "browse_scroll"),
        4,
        "a posture-class probe failure spends the scroll budget before the corrective navigation"
    );
    assert_eq!(
        page_navigation_count_to(&requests, "https://www.facebook.com/groups/945390701793119"),
        1,
        "a reused-page context mismatch gets one canonical-root fallback"
    );
    assert_eq!(router_call_count(&requests, "comment_editor_probe"), 0);
    assert_eq!(router_call_count(&requests, "note_open"), 0);
}

#[tokio::test]
async fn facebook_first_post_cancellation_after_root_probe_never_navigates() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) =
        spawn_facebook_first_post_cancel_after_root_probe_cdp(cancellation.clone()).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute_cancellable(
            &facebook_first_post_command(1, 30_000),
            cancellation.clone(),
        )
        .await
        .expect("stored Facebook first-post cancellation");
    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    assert_eq!(
        outcome.error.expect("cancellation error").code,
        ErrorCode::Cancelled
    );

    engine.shutdown().await;
    let requests = server
        .await
        .expect("Facebook first-post cancellation fake CDP");
    assert_eq!(
        router_call_count(&requests, "first_post_group_root_probe"),
        1
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "Page.navigate")
            .count(),
        0,
        "cancellation observed after the reuse probe must stop before fallback navigation"
    );
}

#[tokio::test]
async fn facebook_first_post_hydrates_the_editor_with_one_native_cdp_click() {
    let target_ref = format!("aidcp:facebook-group-feed-post:v1:{}", "b2".repeat(32));
    let (port, server) =
        spawn_facebook_bound_first_post_click_hydration_cdp(target_ref.clone()).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_first_post_command(1, 30_000))
        .await
        .expect("Facebook bound first-post detail after native click");
    let CommandOutput::NoteDetail(detail) = outcome.output.expect("first-post detail output")
    else {
        panic!("expected note detail")
    };
    assert_eq!(detail.note_id, target_ref);
    assert_eq!(detail.content, "editor hydrated first post");

    engine.shutdown().await;
    let requests = server
        .await
        .expect("Facebook bound first-post click hydration fake CDP");
    assert_eq!(router_call_count(&requests, "feed_refresh"), 1);
    assert_eq!(router_call_count(&requests, "comment_action_probe"), 1);
    assert_eq!(router_call_count(&requests, "comment_editor_probe"), 2);
    assert_eq!(router_call_count(&requests, "note_open"), 1);
    // 点击是「逐帧移动 → 按下 → 抬起」：帧数按距离与分布采样，不是可断言的常数；
    // 可断言的是形状——移动帧不止一帧（不得瞬移），按下 / 抬起各恰好一次且成对。
    assert_humanized_single_click(&requests);
}

#[tokio::test]
async fn xhs_self_identity_uses_only_the_bound_canonical_profile() {
    let (port, server) = spawn_xhs_self_identity_cdp().await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open XHS session");
    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "identity-self-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 2_000,
            command: NativeCommand::IdentityReadSelfProfile(IdentityCaptureParams {
                capture_id: "capture-xhs-1".to_owned(),
                account_id: "author_123".to_owned(),
            }),
        })
        .await
        .expect("self profile identity");
    let CommandOutput::IdentityObservation(observation) =
        outcome.output.expect("identity observation")
    else {
        panic!("expected identity observation")
    };
    assert_eq!(observation.capture_id, "capture-xhs-1");
    assert_eq!(observation.account_id, "author_123");
    assert_eq!(observation.nickname.as_deref(), Some("工程师大白"));

    engine.shutdown().await;
    let requests = server.await.expect("XHS identity fake CDP");
    let navigations: Vec<&Value> = requests
        .iter()
        .filter(|request| request["method"] == "Page.navigate")
        .collect();
    assert_eq!(navigations.len(), 1);
    assert_eq!(
        navigations[0]
            .pointer("/params/url")
            .and_then(Value::as_str),
        Some("https://www.xiaohongshu.com/user/profile/author_123")
    );
}

#[tokio::test]
async fn xiaohongshu_search_types_one_unicode_scalar_per_insert_text_call() {
    let (port, server) = spawn_xhs_search_input_cdp(true).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open XHS session");
    let keyword = "AI 实战";
    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "search-input-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 15_000,
            command: NativeCommand::SearchExecute(SearchExecuteParams {
                keyword: keyword.to_owned(),
                container: None,
                source: None,
                max_results: None,
                sort: None,
                time_window: None,
            }),
        })
        .await
        .expect("search result");
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);

    engine.shutdown().await;
    let requests = server.await.expect("XHS search input fake CDP");
    let inserts: Vec<&str> = requests
        .iter()
        .filter(|request| request["method"] == "Input.insertText")
        .filter_map(|request| request.pointer("/params/text").and_then(Value::as_str))
        .collect();
    assert_eq!(inserts.concat(), keyword);
    assert_eq!(inserts.len(), keyword.chars().count());
    assert!(inserts.iter().all(|part| part.chars().count() == 1));
}

#[tokio::test]
async fn xiaohongshu_search_deadline_stops_before_text_and_enter_dispatch() {
    let (port, server) = spawn_xhs_search_input_cdp(true).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open XHS session");
    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "search-deadline-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 1_000,
            command: NativeCommand::SearchExecute(SearchExecuteParams {
                keyword: "deadline".to_owned(),
                container: None,
                source: None,
                max_results: None,
                sort: None,
                time_window: None,
            }),
        })
        .await
        .expect("search deadline receipt");
    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("search receipt") else {
        panic!("expected search receipt")
    };
    assert_eq!(
        receipt.reason.as_deref(),
        Some("search_input_deadline_exceeded")
    );

    engine.shutdown().await;
    let requests = server.await.expect("XHS search deadline fake CDP");
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Input.insertText")
    );
    assert!(requests.iter().all(|request| {
        request["method"] != "Input.dispatchKeyEvent" || request["params"]["key"] != "Enter"
    }));
}

#[tokio::test]
async fn xiaohongshu_search_focus_rejection_stops_before_text_dispatch() {
    let (port, server) = spawn_xhs_search_input_cdp(false).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open XHS session");
    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "search-focus-rejected-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 8_000,
            command: NativeCommand::SearchExecute(SearchExecuteParams {
                keyword: "focus".to_owned(),
                container: None,
                source: None,
                max_results: None,
                sort: None,
                time_window: None,
            }),
        })
        .await
        .expect("search focus receipt");
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("search receipt") else {
        panic!("expected search receipt")
    };
    assert_eq!(receipt.reason.as_deref(), Some("search_input_focus_failed"));

    engine.shutdown().await;
    let requests = server.await.expect("XHS search focus fake CDP");
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Input.insertText")
    );
}

/// 搜索框探针**自己炸了**，MUST NOT 被报成「页面上没有搜索框」。
///
/// 求值固定带 `silent: true`，页内异常不产生任何错误码，只让 `/result/value` 缺席。
/// 几何量那两处 `let Some(..) else` 与 `xhs_search_input_flag` 的 `unwrap_or(false)` 都会把它读成
/// `found=false`，于是一个从未被观测到的「页面上没有搜索框」被当成结构确定的结论回报。
/// 两档探针各有各的读法，所以两档各测一次——只测一档，另一档的兜底会静默留在原地。
async fn assert_search_probe_exception_is_not_a_missing_search_box(mode: &'static str) {
    let (port, server) = spawn_xhs_search_input_cdp_with(true, Some(mode)).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open XHS session");
    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "search-probe-raised-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            // 给足预算：本例要钉的是「页内异常怎么归类」，与时限无关。预算给紧了，
            // 机器一忙就会先撞 DeadlineExpired，用例变成一条时序 flake、测不到它该测的东西。
            deadline_unix_ms: unix_time_ms() + 30_000,
            command: NativeCommand::SearchExecute(SearchExecuteParams {
                keyword: "raise".to_owned(),
                container: None,
                source: None,
                max_results: None,
                sort: None,
                time_window: None,
            }),
        })
        .await
        .expect("search outcome");

    // 探测失败如实回报成一次**失败的探测**，而不是一份关于页面的结论。
    if let Some(CommandOutput::ActionReceipt(receipt)) = &outcome.output {
        assert_ne!(
            receipt.reason.as_deref(),
            Some("search_input_not_found"),
            "{mode} 探针抛异常 = 这一次没读到搜索框状态，MUST NOT 报成「页面上没有搜索框」",
        );
    }
    let error = outcome
        .error
        .unwrap_or_else(|| panic!("{mode} 的页内异常必须如实变成一次探测失败"));
    assert_eq!(error.code, ErrorCode::ProbeFailed);

    engine.shutdown().await;
    let requests = server.await.expect("XHS search probe fake CDP");
    // 读不到就绝不继续动作：既不打字、也不回车。
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Input.insertText")
    );
    assert!(requests.iter().all(|request| {
        request["method"] != "Input.dispatchKeyEvent" || request["params"]["key"] != "Enter"
    }));
}

#[tokio::test]
async fn xiaohongshu_search_geometry_exception_is_not_reported_as_a_missing_search_box() {
    assert_search_probe_exception_is_not_a_missing_search_box("(\"geometry\")").await;
}

#[tokio::test]
async fn xiaohongshu_search_focus_probe_exception_is_not_reported_as_a_missing_search_box() {
    assert_search_probe_exception_is_not_a_missing_search_box("(\"focus-clear\")").await;
}

#[tokio::test]
async fn captcha_text_uses_real_key_pairs_with_shift_and_zero_insert_text() {
    let (port, server) = spawn_captcha_text_input_cdp(false, true).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open XHS session");

    let capture = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "captcha-capture-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 5_000,
            command: NativeCommand::CaptchaCapture(CaptchaCaptureParams {
                incident_id: "incident-1".to_owned(),
                max_image_width: None,
                max_image_height: None,
                quality: None,
            }),
        })
        .await
        .expect("captcha capture");
    let CommandOutput::CaptchaSnapshot(snapshot) = capture.output.expect("captcha snapshot") else {
        panic!("expected captcha snapshot")
    };

    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "captcha-click-2".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 2,
            deadline_unix_ms: unix_time_ms() + 8_000,
            command: NativeCommand::CaptchaClick(CaptchaClickParams {
                incident_id: "incident-1".to_owned(),
                snapshot_id: snapshot.snapshot_id,
                points: vec![CaptchaPoint {
                    x: 0.5,
                    y: 0.5,
                    label: None,
                }],
                settle_ms: Some(10),
                text: Some("aB!".to_owned()),
                submit: None,
            }),
        })
        .await
        .expect("captcha text input");
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);

    engine.shutdown().await;
    let requests = server.await.expect("captcha input fake CDP");
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Input.insertText")
    );
    let character_downs: Vec<&Value> = requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchKeyEvent"
                && request["params"]["type"] == "keyDown"
                && request["params"].get("text").is_some()
        })
        .collect();
    let character_ups: Vec<&Value> = requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchKeyEvent"
                && request["params"]["type"] == "keyUp"
                && request["params"]["key"] != "Shift"
                && request["params"]["key"] != "Backspace"
                && matches!(request["params"]["modifiers"].as_u64(), Some(0) | Some(8))
        })
        .collect();
    assert_eq!(
        character_downs
            .iter()
            .filter_map(|request| request.pointer("/params/text").and_then(Value::as_str))
            .collect::<String>(),
        "aB!"
    );
    assert_eq!(character_downs.len(), 3);
    assert_eq!(character_ups.len(), 3);
    assert_eq!(
        requests
            .iter()
            .filter(|request| {
                request["method"] == "Input.dispatchKeyEvent"
                    && request["params"]["key"] == "Shift"
                    && request["params"]["type"] == "rawKeyDown"
            })
            .count(),
        2
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| {
                request["method"] == "Input.dispatchKeyEvent"
                    && request["params"]["key"] == "Shift"
                    && request["params"]["type"] == "keyUp"
            })
            .count(),
        2
    );
}

#[tokio::test]
async fn captcha_text_releases_the_character_key_after_keydown_failure() {
    let (port, server) = spawn_captcha_text_input_cdp(true, true).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open XHS session");
    let capture = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "captcha-capture-error-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 5_000,
            command: NativeCommand::CaptchaCapture(CaptchaCaptureParams {
                incident_id: "incident-error".to_owned(),
                max_image_width: None,
                max_image_height: None,
                quality: None,
            }),
        })
        .await
        .expect("captcha capture");
    let CommandOutput::CaptchaSnapshot(snapshot) = capture.output.expect("captcha snapshot") else {
        panic!("expected captcha snapshot")
    };
    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "captcha-click-error-2".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 2,
            deadline_unix_ms: unix_time_ms() + 8_000,
            command: NativeCommand::CaptchaClick(CaptchaClickParams {
                incident_id: "incident-error".to_owned(),
                snapshot_id: snapshot.snapshot_id,
                points: vec![CaptchaPoint {
                    x: 0.5,
                    y: 0.5,
                    label: None,
                }],
                settle_ms: Some(10),
                text: Some("x".to_owned()),
                submit: None,
            }),
        })
        .await
        .expect("honest captcha type failure");
    assert_eq!(outcome.effect_phase, EffectPhase::Dispatched);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("captcha failure receipt")
    else {
        panic!("expected captcha action receipt")
    };
    assert_eq!(receipt.reason.as_deref(), Some("captcha_type_failed"));

    engine.shutdown().await;
    let requests = server.await.expect("captcha key failure fake CDP");
    let x_events: Vec<&Value> = requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchKeyEvent" && request["params"]["key"] == "x"
        })
        .collect();
    assert_eq!(x_events.len(), 2);
    assert_eq!(x_events[0]["params"]["type"], "keyDown");
    assert_eq!(x_events[1]["params"]["type"], "keyUp");
}

#[tokio::test]
async fn captcha_text_without_a_focused_target_dispatches_zero_character_keys() {
    let (port, server) = spawn_captcha_text_input_cdp(false, false).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open XHS session");
    let capture = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "captcha-capture-no-focus-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 5_000,
            command: NativeCommand::CaptchaCapture(CaptchaCaptureParams {
                incident_id: "incident-no-focus".to_owned(),
                max_image_width: None,
                max_image_height: None,
                quality: None,
            }),
        })
        .await
        .expect("captcha capture");
    let CommandOutput::CaptchaSnapshot(snapshot) = capture.output.expect("captcha snapshot") else {
        panic!("expected captcha snapshot")
    };
    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "captcha-click-no-focus-2".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 2,
            deadline_unix_ms: unix_time_ms() + 8_000,
            command: NativeCommand::CaptchaClick(CaptchaClickParams {
                incident_id: "incident-no-focus".to_owned(),
                snapshot_id: snapshot.snapshot_id,
                points: vec![CaptchaPoint {
                    x: 0.5,
                    y: 0.5,
                    label: None,
                }],
                settle_ms: Some(10),
                text: Some("aB!".to_owned()),
                submit: None,
            }),
        })
        .await
        .expect("captcha no-focus receipt");
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("captcha receipt") else {
        panic!("expected captcha receipt")
    };
    assert_eq!(receipt.reason.as_deref(), Some("captcha_input_not_focused"));

    engine.shutdown().await;
    let requests = server.await.expect("captcha no-focus fake CDP");
    assert!(requests.iter().all(|request| {
        request["method"] != "Input.dispatchKeyEvent"
            || request
                .pointer("/params/text")
                .and_then(Value::as_str)
                .is_none()
    }));
}

#[tokio::test]
async fn facebook_comment_types_approved_text_one_unicode_scalar_at_a_time() {
    let (port, server) = spawn_facebook_comment_input_cdp(true).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 90_000;
    engine.open(&open).await.expect("open Facebook session");
    let body = "越南 job";
    let group_code = "Zalo:123";
    let expected = format!("{body}\n{group_code}");
    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "facebook-comment-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            // 提交前预留（FACEBOOK_COMMENT_PRE_SUBMIT_RESERVE_MS，2026-07-29 随整体 ×1.5 抬到 18s）
            // 会从命令死线里扣掉，剩下的才是逐字输入窗。20s 死线只剩 2s 打字，本例测的是
            // 「逐字输入」和「提交窗被拒」，不是死线，故给足 60s 让预留不再是约束项。
            deadline_unix_ms: unix_time_ms() + 60_000,
            command: NativeCommand::InteractionComment(CommentParams {
                note_id: "https://www.facebook.com/groups/42/posts/7".to_owned(),
                text: body.to_owned(),
                account_id: Some("61591824155856".to_owned()),
                group_chat_code: Some(group_code.to_owned()),
                fast_return_to_feed: None,
                reason: None,
                think_ms: None,
            }),
        })
        .await
        .expect("Facebook comment");
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("comment receipt") else {
        panic!("expected comment receipt")
    };
    assert!(receipt.ok);

    engine.shutdown().await;
    let requests = server.await.expect("Facebook comment input fake CDP");
    let inserts: Vec<&str> = requests
        .iter()
        .filter(|request| request["method"] == "Input.insertText")
        .filter_map(|request| request.pointer("/params/text").and_then(Value::as_str))
        .collect();
    assert_eq!(inserts.concat(), expected);
    assert_eq!(inserts.len(), expected.chars().count());
    assert!(inserts.iter().all(|part| part.chars().count() == 1));
}

#[tokio::test]
async fn facebook_comment_deadline_clears_and_never_submits_a_partial_comment() {
    let (port, server) = spawn_facebook_comment_input_cdp(true).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 90_000;
    engine.open(&open).await.expect("open Facebook session");
    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "facebook-comment-deadline-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            // 本例要钉的是**打字那一步的死线已过**：`comment.rs` 用
            // `deadline - FACEBOOK_COMMENT_PRE_SUBMIT_RESERVE_MS(12s)` 当打字死线，所以只要总预算
            // 小于 12s，打字死线在命令开始时就已经过去，一个字都不该被打出去。
            //
            // 而外层还有一道墙钟看门狗：`execute_platform_command` 用同一个 deadline 给整条命令
            // 设 timeout，写命令超时 ⇒ 归成 `Ambiguous`。原值是 1_000，于是
            // 「引擎走到打字那一步」必须在 1 秒内完成——cargo 并行跑 14 个测试二进制时，中间那几步
            // （开帖探测 / 拟人点击 / 清空 / 聚焦，全是带停顿的真手势）轻易超过 1 秒，外层看门狗先
            // 响，引擎于是**诚实**回 Ambiguous。实测：独立目录连跑 22 次全量红 2 次（≈9%），无人造负载。
            //
            // 安全断言（绝不写入 / 绝不回车）在两次红里都仍然通过 ⇒ 抖的是**用例前提**，不是引擎缺陷。
            // 故把总预算抬到 11s：仍 < 12s（打字死线照样在开始前就过期，被测语义一字不变），但留给
            // 「走到打字那一步」的墙钟从 1s 变成 11s。**MUST NOT 抬到 ≥ 12_000**——那会让打字死线变成
            // 未来时刻，用例就悄悄不再测「死线已过」了。
            deadline_unix_ms: unix_time_ms() + 11_000,
            command: NativeCommand::InteractionComment(CommentParams {
                note_id: "https://www.facebook.com/groups/42/posts/7".to_owned(),
                text: "deadline comment".to_owned(),
                account_id: Some("61591824155856".to_owned()),
                group_chat_code: None,
                fast_return_to_feed: None,
                reason: None,
                think_ms: None,
            }),
        })
        .await
        .expect("Facebook comment deadline receipt");
    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("comment receipt") else {
        panic!("expected comment receipt")
    };
    assert_eq!(receipt.reason.as_deref(), Some("comment_deadline_exceeded"));

    engine.shutdown().await;
    let requests = server.await.expect("Facebook comment deadline fake CDP");
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Input.insertText")
    );
    assert!(requests.iter().all(|request| {
        request["method"] != "Input.dispatchKeyEvent" || request["params"]["key"] != "Enter"
    }));
}

#[tokio::test]
async fn facebook_comment_commit_window_rejection_clears_and_never_submits() {
    let (port, server) = spawn_facebook_comment_input_cdp(true).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 90_000;
    engine.open(&open).await.expect("open Facebook session");
    let command = CommandRecord {
        protocol_version: 2,
        id: "facebook-comment-commit-rejected-1".to_owned(),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        command_id: 1,
        // 同上：提交前预留 18s 会从死线里扣掉，20s 只剩 2s 打字，测不到提交窗那一步。
        deadline_unix_ms: unix_time_ms() + 60_000,
        command: NativeCommand::InteractionComment(CommentParams {
            note_id: "https://www.facebook.com/groups/42/posts/7".to_owned(),
            text: "approved comment".to_owned(),
            account_id: Some("61591824155856".to_owned()),
            group_chat_code: None,
            fast_return_to_feed: None,
            reason: None,
            think_ms: None,
        }),
    };
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let execute = engine.execute_cancellable_with_commit_windows(
        &command,
        Arc::new(AtomicBool::new(false)),
        CommitWindowRequester::new(command.command_id, sender),
        EndpointResolver::in_process(command.command_id),
    );
    let reject = async move {
        let request = receiver.recv().await.expect("commit window request");
        request
            .acknowledgement
            .send(false)
            .expect("reject commit window");
    };
    let (outcome, ()) = tokio::join!(execute, reject);
    let outcome = outcome.expect("Facebook comment commit rejection");
    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    assert_eq!(
        outcome.error.expect("commit rejection error").code,
        ErrorCode::CommitWindowUnavailable
    );

    engine.shutdown().await;
    let requests = server.await.expect("Facebook comment commit fake CDP");
    assert!(
        requests
            .iter()
            .any(|request| request["method"] == "Input.insertText")
    );
    assert!(requests.iter().all(|request| {
        request["method"] != "Input.dispatchKeyEvent" || request["params"]["key"] != "Enter"
    }));
    let last_backspace = requests.iter().rposition(|request| {
        request["method"] == "Input.dispatchKeyEvent"
            && request["params"]["key"] == "Backspace"
            && request["params"]["type"] == "keyDown"
    });
    let last_insert = requests
        .iter()
        .rposition(|request| request["method"] == "Input.insertText");
    assert!(last_backspace > last_insert);
}

#[tokio::test]
async fn facebook_comment_focus_rejection_stops_before_text_dispatch() {
    let (port, server) = spawn_facebook_comment_input_cdp(false).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 90_000;
    engine.open(&open).await.expect("open Facebook session");
    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "facebook-comment-focus-rejected-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 8_000,
            command: NativeCommand::InteractionComment(CommentParams {
                note_id: "https://www.facebook.com/groups/42/posts/7".to_owned(),
                text: "focus".to_owned(),
                account_id: Some("61591824155856".to_owned()),
                group_chat_code: None,
                fast_return_to_feed: None,
                reason: None,
                think_ms: None,
            }),
        })
        .await
        .expect("Facebook comment focus receipt");
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("comment receipt") else {
        panic!("expected comment receipt")
    };
    assert_eq!(
        receipt.reason.as_deref(),
        Some("comment_editor_focus_failed")
    );

    engine.shutdown().await;
    let requests = server.await.expect("Facebook comment focus fake CDP");
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Input.insertText")
    );
}

/// 假浏览器进程的实例标识。宿主在开会话时把它当作**准入证据**交给引擎；
/// 引擎重连时按它复核「这一次连上的还是不是当初那一个浏览器」。
const ADMITTED_BROWSER_ID: &str = "fake-browser-0001";

fn session_open(port: u16) -> SessionOpenRecord {
    SessionOpenRecord {
        protocol_version: 2,
        id: "open-1".to_owned(),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Xiaohongshu,
            timeout_ms: 2_000,
            browser_debugger_url: Some(format!(
                "ws://127.0.0.1:{port}/devtools/browser/{ADMITTED_BROWSER_ID}"
            )),
        },
    }
}

fn page_probe_command(command_id: u64) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("command-{command_id}"),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + 2_000,
        command: NativeCommand::PageProbe(PageProbeParams::default()),
    }
}

fn facebook_note_open_command(command_id: u64, url: &str, timeout_ms: u64) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("facebook-note-open-{command_id}"),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + timeout_ms,
        command: NativeCommand::NoteOpen(NoteOpenParams {
            index: None,
            note_id: None,
            url: Some(url.to_owned()),
            reason: None,
            surface: None,
            purpose: None,
            think_ms: None,
            selection: None,
            container: None,
        }),
    }
}

fn facebook_first_post_command(command_id: u64, timeout_ms: u64) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("facebook-first-post-{command_id}"),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + timeout_ms,
        command: NativeCommand::NoteOpen(NoteOpenParams {
            selection: Some(NoteOpenSelection::FirstCommentableGroupPost),
            container: Some("https://www.facebook.com/groups/945390701793119".to_owned()),
            ..NoteOpenParams::default()
        }),
    }
}

fn browse_command(command_id: u64) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("command-{command_id}"),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + 2_000,
        command: NativeCommand::BrowseScroll(ReasonParams {
            reason: Some("initial_scan".to_owned()),
        }),
    }
}

fn facebook_reel_scroll_command(id: &str, command_id: u64, timeout_ms: u64) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: id.to_owned(),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + timeout_ms,
        command: NativeCommand::PageScroll(PageScrollParams {
            reason: Some("feed_scroll".to_owned()),
            surface: None,
            dwell_ms: None,
        }),
    }
}

fn facebook_like_command(command_id: u64) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("facebook-like-{command_id}"),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + 8_000,
        command: NativeCommand::InteractionLike(NoteInteractionParams {
            note_id: "https://www.facebook.com/reel/1".to_owned(),
            reason: None,
            think_ms: None,
        }),
    }
}

fn facebook_follow_command(command_id: u64) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("facebook-follow-{command_id}"),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + 8_000,
        command: NativeCommand::InteractionFollow(FollowParams {
            author_id: None,
            note_id: Some("https://www.facebook.com/reel/1".to_owned()),
            reason: None,
            think_ms: None,
        }),
    }
}

async fn spawn_router_result_cdp(
    disconnect_after_dispatch: bool,
) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing(&listener, port).await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        for _ in 0..3 {
            respond_to_call(&mut websocket, json!({})).await;
        }
        if disconnect_after_dispatch {
            let _ = websocket.next().await.expect("write dispatch");
            websocket
                .close(None)
                .await
                .expect("disconnect after dispatch");
            return;
        }
        respond_to_call(
            &mut websocket,
            json!({
                "result": { "value": {
                    "effectPhase": "confirmed",
                    "output": { "kind": "page_cards", "value": { "cards": [{
                        "index": 0, "title": "Native card", "likeCount": 1,
                        "collectCount": 2, "noteId": "n1"
                    }] } }
                } }
            }),
        )
        .await;
        let _ = websocket.close(None).await;
    });
    (port, server)
}

#[derive(Clone, Copy)]
enum FacebookInteractionScenario {
    LikeDirect,
    LikeMovedDuringVerify,
    LikeTransientVerify,
    LikePicker,
    FollowMovedBeforeDispatch,
    FollowMovedDuringVerify,
    FollowConfirmed,
    FollowTransientVerify,
}

async fn spawn_facebook_interaction_cdp(
    scenario: FacebookInteractionScenario,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, "https://www.facebook.com/reel/1").await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut follow_probes = 0_u32;
        let mut like_verifies = 0_u32;
        let mut picker_committed = false;

        while let Some(message) = websocket.next().await {
            let message = message.expect("valid CDP request");
            let Message::Text(text) = message else {
                if matches!(message, Message::Close(_)) {
                    break;
                }
                continue;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let method = request["method"].as_str().unwrap_or_default();
            let kind = router_kind(&request);
            if method == "Input.dispatchMouseEvent" && request["params"]["type"] == "mouseReleased"
            {
                picker_committed = true;
            }
            let result = match kind.as_deref() {
                Some("page_probe") => facebook_ready_cdp("/reel/1"),
                Some("consent_probe") => router_cdp(
                    "consent_probe",
                    json!({
                        "present": false,
                        "acceptAllAmbiguous": false,
                        "necessaryOnlyAmbiguous": false
                    }),
                ),
                Some("reel_probe") => {
                    reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1")
                }
                Some("like_probe") => router_cdp(
                    "like_probe",
                    json!({
                        "ok": true,
                        "noteId": "https://www.facebook.com/reel/1",
                        "already": false,
                        "cx": 1010.0,
                        "cy": 525.0
                    }),
                ),
                Some("like_primary_commit") => router_cdp(
                    "like_commit",
                    json!({
                        "ok": true,
                        "noteId": "https://www.facebook.com/reel/1",
                        "already": false,
                        "clicked": true
                    }),
                ),
                Some("like_verify") => {
                    like_verifies += 1;
                    let moved =
                        matches!(scenario, FacebookInteractionScenario::LikeMovedDuringVerify);
                    let transiently_unreadable =
                        matches!(scenario, FacebookInteractionScenario::LikeTransientVerify)
                            && like_verifies == 1;
                    let selected = matches!(scenario, FacebookInteractionScenario::LikeDirect)
                        || matches!(scenario, FacebookInteractionScenario::LikeTransientVerify)
                            && like_verifies >= 2
                        || picker_committed;
                    router_cdp(
                        "like_verify",
                        json!({
                            "ok": !transiently_unreadable && !moved,
                            "reason": transiently_unreadable.then_some("like_button_not_found"),
                            "noteId": if moved {
                                "https://www.facebook.com/reel/2"
                            } else {
                                "https://www.facebook.com/reel/1"
                            },
                            "selected": selected,
                            "witness": selected.then_some("aria_pressed")
                        }),
                    )
                }
                Some("like_picker_probe") => router_cdp(
                    "point_target",
                    json!({"ok": true, "cx": 955.0, "cy": 485.0}),
                ),
                Some("follow_probe") => {
                    follow_probes += 1;
                    if matches!(scenario, FacebookInteractionScenario::FollowTransientVerify)
                        && follow_probes == 3
                    {
                        router_cdp(
                            "follow_probe",
                            json!({
                                "ok": false,
                                "reason": "target_not_found",
                                "noteId": "https://www.facebook.com/reel/1",
                                "already": false
                            }),
                        )
                    } else {
                        let author = if matches!(
                            scenario,
                            FacebookInteractionScenario::FollowMovedBeforeDispatch
                        ) && follow_probes == 2
                            || matches!(
                                scenario,
                                FacebookInteractionScenario::FollowMovedDuringVerify
                            ) && follow_probes == 3
                        {
                            "Other Author"
                        } else {
                            "Re Su"
                        };
                        router_cdp(
                            "follow_probe",
                            json!({
                                "ok": true,
                                "noteId": "https://www.facebook.com/reel/1",
                                "author": author,
                                "already": matches!(
                                    scenario,
                                    FacebookInteractionScenario::FollowConfirmed
                                ) && follow_probes >= 3
                                    || matches!(
                                        scenario,
                                        FacebookInteractionScenario::FollowTransientVerify
                                    ) && follow_probes >= 4,
                                "cx": 730.0,
                                "cy": 670.0
                            }),
                        )
                    }
                }
                _ => json!({}),
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

fn router_cdp(kind: &str, value: Value) -> Value {
    json!({"result":{"value":router_result(kind, value)}})
}

fn router_kind(request: &Value) -> Option<String> {
    let expression = request["params"]["expression"].as_str()?;
    let invocation = expression.rsplit_once(")({")?.1;
    [
        "page_probe",
        "consent_probe",
        "feed_probe",
        "first_post_group_root_probe",
        "identity_candidates",
        "feed_recovery_target",
        "feed_refresh",
        "browse_scroll",
        "note_open",
        "comment_action_probe",
        "comment_editor_probe",
        "reel_probe",
        "like_probe",
        "like_primary_commit",
        "like_verify",
        "like_picker_probe",
        "follow_probe",
    ]
    .into_iter()
    .find(|kind| invocation.contains(&format!("\"kind\":\"{kind}\"")))
    .map(str::to_owned)
}

fn facebook_consent_absent_cdp() -> Value {
    router_cdp(
        "consent_probe",
        json!({
            "present": false,
            "acceptAllAmbiguous": false,
            "necessaryOnlyAmbiguous": false
        }),
    )
}

fn facebook_first_post_group_root_probe_cdp(
    path: &str,
    surface: &str,
    target_group_id: Option<&str>,
    scope_resolved: bool,
) -> Value {
    router_cdp(
        "first_post_group_root_probe",
        json!({
            "origin": "https://www.facebook.com",
            "path": path,
            "search": "",
            "hash": "",
            "surface": surface,
            "readyState": "complete",
            "blockingKind": "none",
            "visibleMainCount": 1,
            "visibleDialogCount": 0,
            "targetGroupId": target_group_id,
            "scopeResolved": scope_resolved,
            "scopeAmbiguous": false,
            "feedLoading": false,
            "scrollY": 0
        }),
    )
}

fn facebook_unknown_first_post_group_root_probe_cdp() -> Value {
    router_cdp(
        "first_post_group_root_probe",
        json!({
            "origin": "https://www.facebook.com",
            "path": "/",
            "search": "",
            "hash": "",
            "surface": "unknown",
            "readyState": "complete",
            "blockingKind": "none",
            "visibleMainCount": 1,
            "visibleDialogCount": 0,
            "targetGroupId": null,
            "scopeResolved": false,
            "scopeAmbiguous": false,
            "feedLoading": false,
            "scrollY": 0
        }),
    )
}

fn router_call_count(requests: &[Value], kind: &str) -> usize {
    requests
        .iter()
        .filter(|request| router_kind(request).as_deref() == Some(kind))
        .count()
}

fn router_request_count(requests: &[Value], kind: &str) -> usize {
    let token = format!("\"kind\":\"{kind}\"");
    requests
        .iter()
        .filter_map(|request| {
            request
                .pointer("/params/expression")
                .and_then(Value::as_str)
        })
        .filter(|expression| expression.contains(&token))
        .count()
}

fn page_navigation_count_to(requests: &[Value], url: &str) -> usize {
    requests
        .iter()
        .filter(|request| {
            request["method"] == "Page.navigate"
                && request.pointer("/params/url").and_then(Value::as_str) == Some(url)
        })
        .count()
}

fn mouse_dispatch_count(requests: &[Value]) -> usize {
    requests
        .iter()
        .filter(|request| request["method"] == "Input.dispatchMouseEvent")
        .count()
}

/// 一次提交式左键 = 一次按下 + 一次抬起。轨迹帧数按分布采样、**不是**可断言的常数，
/// 所以「只写一次」的判据是提交次数而不是鼠标事件总数。
fn pointer_event_count(requests: &[Value], kind: &str) -> usize {
    requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchMouseEvent" && request["params"]["type"] == kind
        })
        .count()
}

fn method_count(requests: &[Value], method: &str) -> usize {
    requests
        .iter()
        .filter(|request| request["method"] == method)
        .count()
}

fn dispatched_keys(requests: &[Value]) -> Vec<&str> {
    requests
        .iter()
        .filter(|request| request["method"] == "Input.dispatchKeyEvent")
        .filter_map(|request| request["params"]["key"].as_str())
        .collect()
}

fn raw_dispatched_keys(requests: &[Value]) -> Vec<&str> {
    requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchKeyEvent"
                && request["params"]["type"] == "rawKeyDown"
        })
        .filter_map(|request| request["params"]["key"].as_str())
        .collect()
}

fn method_index(requests: &[Value], method: &str, occurrence: usize) -> usize {
    requests
        .iter()
        .enumerate()
        .filter(|(_, request)| request["method"] == method)
        .nth(occurrence)
        .map(|(index, _)| index)
        .unwrap_or_else(|| panic!("missing {method} occurrence {occurrence}"))
}

/// 一次拟人点击的**可断言形状**：逐帧移动（帧数按距离与分布采样、不是常数）→ 按下 → 抬起，
/// 按下与抬起各恰好一次且相邻成对。
///
/// MUST NOT 退回 `vec!["mouseMoved", "mousePressed", "mouseReleased"]` 这种整串相等断言：
/// 那锁死的是「瞬移到目标再按下」这个**被本批修掉的缺陷形态**，一旦有人为了让它变绿去改实现，
/// 就等于把机器特征原样种回去。要防的是「不逐帧」和「按下没配平抬起」，不是帧数。
fn assert_humanized_single_click(requests: &[Value]) {
    let mouse_types = requests
        .iter()
        .filter(|request| request["method"] == "Input.dispatchMouseEvent")
        .filter_map(|request| request["params"]["type"].as_str())
        .collect::<Vec<_>>();
    assert!(
        mouse_types.len() > 2,
        "点击必须是「逐帧移动 + 按下 + 抬起」，实测事件：{mouse_types:?}"
    );
    let (moves, commit) = mouse_types.split_at(mouse_types.len() - 2);
    assert!(moves.len() > 1, "点击必须逐帧移动，不得瞬移到目标坐标");
    assert!(moves.iter().all(|kind| *kind == "mouseMoved"));
    assert_eq!(commit, ["mousePressed", "mouseReleased"]);
    assert_eq!(pointer_event_count(requests, "mousePressed"), 1);
    assert_eq!(pointer_event_count(requests, "mouseReleased"), 1);
}

/// 按下 / 抬起必须落在同一点，且该点在目标坐标的有界落点抖动内（原语上限 3px，留 1px 取整余量）。
///
/// MUST NOT 断言「每一个鼠标事件都恰在目标坐标」——移动帧沿轨迹分布，那条断言等于要求瞬移。
fn assert_pointer_commit_near(requests: &[Value], x: f64, y: f64) {
    const TOLERANCE_PX: f64 = 4.0;
    let commits = requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchMouseEvent"
                && matches!(
                    request["params"]["type"].as_str(),
                    Some("mousePressed" | "mouseReleased")
                )
        })
        .map(|request| {
            (
                request["params"]["x"].as_f64().expect("pointer x"),
                request["params"]["y"].as_f64().expect("pointer y"),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(commits.len(), 2, "提交式左键必须恰好一次按下 + 一次抬起");
    assert_eq!(commits[0], commits[1], "按下与抬起必须落在同一点");
    assert!(
        (commits[0].0 - x).abs() <= TOLERANCE_PX && (commits[0].1 - y).abs() <= TOLERANCE_PX,
        "落点 {:?} 偏离目标 ({x}, {y}) 超过 {TOLERANCE_PX}px",
        commits[0]
    );
}

async fn spawn_xhs_search_input_cdp(
    allow_focus: bool,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    spawn_xhs_search_input_cdp_with(allow_focus, None).await
}

/// `raise_on_mode`：哪一档搜索框探针的**页内表达式抛异常**（按模式串匹配，如 `("geometry")`）。
///
/// 这不是「CDP 调用失败」——求值固定带 `silent: true`，页内异常回的是一个格式完好的成功响应 +
/// `exceptionDetails`，`/result/value` 恰好缺席。所以必须照这个形状造，用错误码冒充测不到那口坑。
async fn spawn_xhs_search_input_cdp_with(
    allow_focus: bool,
    raise_on_mode: Option<&'static str>,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing(&listener, port).await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut text = String::new();
        let mut search_input_focused = false;
        let mut on_search_page = false;
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(raw)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&raw).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let method = request["method"].as_str().unwrap_or_default();
            let expression = request
                .pointer("/params/expression")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let response = if method == "Input.insertText" {
                if search_input_focused {
                    text.push_str(
                        request
                            .pointer("/params/text")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    );
                }
                json!({})
            } else if method == "Input.dispatchKeyEvent"
                && request.pointer("/params/key").and_then(Value::as_str) == Some("Enter")
                && request.pointer("/params/type").and_then(Value::as_str) == Some("keyDown")
            {
                if search_input_focused {
                    on_search_page = true;
                }
                json!({})
            } else if method == "Runtime.evaluate"
                && raise_on_mode.is_some_and(|mode| expression.contains(mode))
            {
                json!({
                    "result": {"type": "object", "subtype": "error", "className": "TypeError"},
                    "exceptionDetails": {
                        "exceptionId": 1,
                        "text": "Uncaught",
                        "lineNumber": 0,
                        "columnNumber": 0,
                        "exception": {
                            "type": "object",
                            "subtype": "error",
                            "className": "TypeError",
                            "description": "TypeError: Cannot read properties of null (reading 'getBoundingClientRect')"
                        }
                    }
                })
            } else if method == "Runtime.evaluate" && expression.contains("(\"geometry\")") {
                json!({"result":{"value":{"found":true,"x":640.0,"y":52.0}}})
            } else if method == "Runtime.evaluate" && expression.contains("(\"focus-clear\")") {
                search_input_focused = allow_focus;
                text.clear();
                json!({"result":{"value":{"found":true,"focused":search_input_focused,"value":text}}})
            } else if method == "Runtime.evaluate" && expression.contains("(\"focus\")") {
                search_input_focused = allow_focus;
                json!({"result":{"value":{"found":true,"focused":search_input_focused,"value":text}}})
            } else if method == "Runtime.evaluate" && expression.contains("feedCardCount") {
                json!({"result":{"value":{
                    "href":if on_search_page {
                        "https://www.xiaohongshu.com/search_result_ai?keyword=AI%20%E5%AE%9E%E6%88%98"
                    } else {
                        "https://www.xiaohongshu.com/explore"
                    },
                    "readyState":"complete",
                    "feedCardCount":if on_search_page {1} else {0},
                    "noteDetailCount":0,
                    "loginWallCount":0,
                    "captchaSignalCount":0,
                    "dialogCount":0,
                    "profileSignalCount":0,
                    "notificationSignalCount":0,
                    "publishSignalCount":0,
                    "errorSignalCount":0,
                    "mainCount":1
                }}})
            } else if method == "Runtime.evaluate" {
                json!({"result":{"value":router_result(
                    "page_cards",
                    json!({"cards":[{
                        "index":0,
                        "title":"search result",
                        "likeCount":1,
                        "collectCount":1,
                        "noteId":"note-1"
                    }]})
                )}})
            } else {
                json!({})
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":response}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

async fn spawn_captcha_text_input_cdp(
    fail_character_keydown: bool,
    focus_after_click: bool,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing(&listener, port).await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut text = String::new();
        let mut focused = false;
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(raw)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&raw).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let method = request["method"].as_str().unwrap_or_default();
            if fail_character_keydown
                && method == "Input.dispatchKeyEvent"
                && request.pointer("/params/type").and_then(Value::as_str) == Some("keyDown")
                && request.pointer("/params/text").and_then(Value::as_str) == Some("x")
            {
                requests.push(request);
                websocket
                    .send(Message::Text(
                        json!({"id":id,"error":{"code":-32000,"message":"synthetic keydown failure"}})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .expect("CDP error response");
                continue;
            }
            let response = match method {
                "Page.getLayoutMetrics" => {
                    json!({"cssVisualViewport":{"clientWidth":1000.0,"clientHeight":800.0}})
                }
                "Page.captureScreenshot" => json!({"data":"YWJj"}),
                "Input.dispatchMouseEvent"
                    if request.pointer("/params/type").and_then(Value::as_str)
                        == Some("mouseReleased") =>
                {
                    focused = focus_after_click;
                    json!({})
                }
                "Input.dispatchKeyEvent"
                    if request.pointer("/params/key").and_then(Value::as_str)
                        == Some("Backspace")
                        && request.pointer("/params/type").and_then(Value::as_str)
                            == Some("keyDown") =>
                {
                    if focused {
                        text.clear();
                    }
                    json!({})
                }
                "Input.dispatchKeyEvent"
                    if request.pointer("/params/type").and_then(Value::as_str)
                        == Some("keyDown") =>
                {
                    if focused
                        && let Some(value) = request.pointer("/params/text").and_then(Value::as_str)
                    {
                        text.push_str(value);
                    }
                    json!({})
                }
                "Runtime.evaluate"
                    if request
                        .pointer("/params/expression")
                        .and_then(Value::as_str)
                        .is_some_and(|expression| expression.contains("editable?'editable'")) =>
                {
                    json!({"result":{"value":if focused {"editable"} else {"none"}}})
                }
                "Runtime.evaluate"
                    if request
                        .pointer("/params/expression")
                        .and_then(Value::as_str)
                        .is_some_and(|expression| expression.contains("selectNodeContents")) =>
                {
                    json!({"result":{"value":focused}})
                }
                "Runtime.evaluate"
                    if request
                        .pointer("/params/expression")
                        .and_then(Value::as_str)
                        .is_some_and(|expression| expression.contains("'value' in e")) =>
                {
                    json!({"result":{"value":text}})
                }
                "Runtime.evaluate" => json!({"result":{"value":{
                    "href":"https://www.xiaohongshu.com/explore",
                    "readyState":"complete",
                    "feedCardCount":0,
                    "noteDetailCount":0,
                    "loginWallCount":0,
                    "captchaSignalCount":1,
                    "dialogCount":1,
                    "profileSignalCount":0,
                    "notificationSignalCount":0,
                    "publishSignalCount":0,
                    "errorSignalCount":0,
                    "mainCount":1
                }}}),
                _ => json!({}),
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":response}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

async fn spawn_facebook_comment_input_cdp(
    allow_focus: bool,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(
            &listener,
            port,
            "https://www.facebook.com/groups/42/posts/7",
        )
        .await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut text = String::new();
        let mut editor_focused = false;
        let mut editor_selected = false;
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(raw)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&raw).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let method = request["method"].as_str().unwrap_or_default();
            let expression = request
                .pointer("/params/expression")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let response = if method == "Input.insertText" {
                if editor_focused {
                    text.push_str(
                        request
                            .pointer("/params/text")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    );
                    editor_selected = false;
                }
                json!({})
            } else if method == "Input.dispatchKeyEvent"
                && request.pointer("/params/key").and_then(Value::as_str) == Some("Backspace")
                && request.pointer("/params/type").and_then(Value::as_str) == Some("keyDown")
            {
                if editor_focused && editor_selected {
                    text.clear();
                    editor_selected = false;
                }
                json!({})
            } else if expression.contains(r#""kind":"page_probe""#) {
                facebook_ready_cdp("/groups/42/posts/7")
            } else if expression.contains(r#""kind":"consent_probe""#) {
                facebook_consent_absent_cdp()
            } else if expression.contains(r#""kind":"comment_editor_probe""#) {
                let focus_requested = expression.contains(r#""focus":true"#);
                if focus_requested {
                    editor_focused = allow_focus;
                    editor_selected = expression.contains(r#""selectContents":true"#);
                    editor_selected = editor_selected && editor_focused;
                }
                router_cdp(
                    "text_target",
                    json!({
                        "ok":true,
                        "noteId":"https://www.facebook.com/groups/42/posts/7",
                        "cx":640.0,
                        "cy":700.0,
                        "value":text,
                        "focused":focus_requested && editor_focused,
                        "selected":focus_requested && editor_selected
                    }),
                )
            } else if expression.contains(r#""kind":"comment_ack_probe""#) {
                router_cdp(
                    "comment_ack_probe",
                    json!({
                        "ok":true,
                        "confirmed":true,
                        "pending":false,
                        "rejected":false,
                        "inFlight":false
                    }),
                )
            } else {
                json!({})
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":response}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

async fn spawn_fake_cdp() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        let (mut http, _) = listener.accept().await.expect("HTTP target request");
        let mut request = [0_u8; 2048];
        let _ = http.read(&mut request).await.expect("read target request");
        let body = json!([{
            "id": "target-1",
            "type": "page",
            "url": "https://www.xiaohongshu.com/search_result_ai?keyword=coffee",
            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/target-1")
        }])
        .to_string();
        let headers = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        http.write_all(headers.as_bytes()).await.expect("headers");
        http.write_all(body.as_bytes()).await.expect("body");
        http.shutdown().await.expect("HTTP shutdown");

        let (websocket_stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(websocket_stream)
            .await
            .expect("WebSocket handshake");
        respond_to_call(&mut websocket, json!({})).await;
        respond_to_call(&mut websocket, json!({})).await;
        respond_to_call(&mut websocket, json!({})).await;
        websocket
            .send(Message::Text(
                json!({"method":"Runtime.executionContextCreated","params":{}})
                    .to_string()
                    .into(),
            ))
            .await
            .expect("event");
        respond_to_call(
            &mut websocket,
            json!({
                "result": {
                    "value": {
                        "href": "https://www.xiaohongshu.com/search_result_ai?keyword=coffee",
                        "readyState": "complete",
                        "feedCardCount": 8,
                        "noteDetailCount": 0,
                        "loginWallCount": 0,
                        "captchaSignalCount": 0,
                        "dialogCount": 0,
                        "profileSignalCount": 0,
                        "mainCount": 1
                    }
                }
            }),
        )
        .await;
        let _ = websocket.close(None).await;
    });
    (port, server)
}

async fn spawn_facebook_identity_cdp() -> (u16, tokio::task::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, "https://www.facebook.com/").await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut methods = Vec::new();
        for _ in 0..3 {
            methods.push(respond_to_call_record(&mut websocket, json!({})).await);
        }
        methods.push(
            respond_to_call_record(
                &mut websocket,
                json!({"result":{"value":"https://www.facebook.com/"}}),
            )
            .await,
        );
        methods.push(respond_to_call_record(&mut websocket, json!({})).await);
        methods.push(
            respond_to_call_record(
                &mut websocket,
                json!({"cookies":[{
                    "name":"c_user",
                    "value":"61591824155856",
                    "domain":".facebook.com"
                }]}),
            )
            .await,
        );
        methods.push(
            respond_to_call_record(
                &mut websocket,
                json!({"result":{"value":{
                    "effectPhase":"confirmed",
                    "output":{"kind":"identity_receipt","value":{
                        "ok":true,
                        "accountId":"61591824155856",
                        "displayName":"Gi Vo",
                        "source":"facebook-cookie"
                    }}
                }}}),
            )
            .await,
        );
        let _ = websocket.close(None).await;
        methods
    });
    (port, server)
}

async fn spawn_facebook_group_join_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, "https://www.facebook.com/groups/42").await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        let mut join_probes = 0_u32;
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let method = request["method"].as_str().unwrap_or_default();
            let expression = request
                .pointer("/params/expression")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let result = if method == "Runtime.evaluate"
                && expression.contains(r#""kind":"join_probe""#)
            {
                join_probes += 1;
                facebook_join_probe_cdp(join_probes >= 3)
            } else if method == "Runtime.evaluate" && expression.contains(r#""kind":"page_probe""#)
            {
                facebook_join_page_probe_cdp()
            } else if method == "Runtime.evaluate"
                && expression.contains(r#""kind":"consent_probe""#)
            {
                json!({"result":{"value":router_result(
                    "consent_probe",
                    json!({
                        "present": false,
                        "acceptAll": null,
                        "necessaryOnly": null,
                        "acceptAllAmbiguous": false,
                        "necessaryOnlyAmbiguous": false
                    })
                )}})
            } else if method == "Runtime.evaluate" && expression.contains(r#""kind":"join_click""#)
            {
                json!({"result":{"value":router_result(
                    "join_click",
                    json!({"clicked":true})
                )}})
            } else {
                json!({})
            };
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("join CDP response");
            requests.push(request);
            if join_probes >= 3 {
                break;
            }
        }
        let _ = websocket.close(None).await;
        requests
    });
    (port, server)
}

async fn spawn_facebook_group_blocker_cdp(
    blocking_kind: &'static str,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, "https://www.facebook.com/").await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let method = request["method"].as_str().unwrap_or_default();
            let expression = request
                .pointer("/params/expression")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let is_page_probe =
                method == "Runtime.evaluate" && expression.contains(r#""kind":"page_probe""#);
            let result =
                if method == "Runtime.evaluate" && expression.contains(r#""kind":"join_probe""#) {
                    facebook_unscoped_join_probe_cdp()
                } else if is_page_probe {
                    facebook_join_blocker_page_probe_cdp(blocking_kind)
                } else {
                    json!({})
                };
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("blocker CDP response");
            requests.push(request);
            if is_page_probe {
                break;
            }
        }
        let _ = websocket.close(None).await;
        requests
    });
    (port, server)
}

async fn spawn_facebook_group_join_exception_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for attempt in 0..2 {
            // 第二轮是**重连**：引擎在挑目标之前先要复核这个端点还是不是当初那一个浏览器实例，
            // 所以要先答一次 `/json/version`。第一轮（开会话）没有这一步 ——
            // 那一刻身份是宿主随开会话参数交付的，引擎不自读。
            if attempt > 0 {
                serve_browser_version(&listener, port, ADMITTED_BROWSER_ID).await;
            }
            serve_target_listing_for(&listener, port, "https://www.facebook.com/groups/42").await;
            let (stream, _) = listener.accept().await.expect("WebSocket request");
            let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
            for _ in 0..3 {
                requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
            }
            while let Some(message) = websocket.next().await {
                let Ok(Message::Text(text)) = message else {
                    break;
                };
                let request: Value = serde_json::from_str(&text).expect("request JSON");
                let id = request["id"].as_u64().expect("request id");
                let method = request["method"].as_str().unwrap_or_default();
                let expression = request
                    .pointer("/params/expression")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let is_join_probe =
                    method == "Runtime.evaluate" && expression.contains(r#""kind":"join_probe""#);
                let result = if method == "Runtime.evaluate"
                    && expression.contains(r#""kind":"page_probe""#)
                {
                    facebook_join_page_probe_cdp()
                } else if method == "Runtime.evaluate"
                    && expression.contains(r#""kind":"consent_probe""#)
                {
                    json!({"result":{"value":router_result(
                        "consent_probe",
                        json!({
                            "present": false,
                            "acceptAll": null,
                            "necessaryOnly": null,
                            "acceptAllAmbiguous": false,
                            "necessaryOnlyAmbiguous": false
                        })
                    )}})
                } else if is_join_probe {
                    json!({
                        "result": {"type": "object"},
                        "exceptionDetails": {
                            "lineNumber": 13,
                            "columnNumber": 55,
                            "exception": {
                                "className": "TypeError",
                                "description": "TypeError: Cannot read properties of null (reading 'querySelectorAll')\nraw stack must not escape"
                            }
                        }
                    })
                } else {
                    json!({})
                };
                websocket
                    .send(Message::Text(
                        json!({"id":id,"result":result}).to_string().into(),
                    ))
                    .await
                    .expect("exception CDP response");
                requests.push(request);
                if is_join_probe {
                    break;
                }
            }
            let _ = websocket.close(None).await;
        }
        requests
    });
    (port, server)
}

fn facebook_unscoped_join_probe_cdp() -> Value {
    json!({"result":{"value":router_result(
        "join_probe",
        json!({
            "observation": {
                "groupUrl": null,
                "pageUrl": "https://www.facebook.com/",
                "membershipSignals": [],
                "loginRequired": false,
                "captchaDetected": false,
                "questionnaireRequired": false,
                "pendingRequest": false,
                "actionNodeCount": 0,
                "documentReady": "complete",
                "composerPresent": false,
                "joinCtaPresent": false,
                "targetGroupId": null,
                "scopeResolved": false,
                "outOfScopeJoinCount": 0,
                "ctaCandidates": []
            },
            "joined": false,
            "pending": false,
            "questionnaire": false,
            "found": false,
            "ambiguous": false
        })
    )}})
}

fn facebook_join_blocker_page_probe_cdp(blocking_kind: &str) -> Value {
    json!({"result":{"value":router_result(
        "page_probe",
        json!({
            "targetId": "",
            "origin": "https://www.facebook.com",
            "path": "/groups/42",
            "readyState": "complete",
            "pageKind": blocking_kind,
            "blockingKind": blocking_kind,
            "blockingText": if blocking_kind == "login" { "Log in to Facebook" } else { "CAPTCHA" },
            "signals": {
                "feedCardCount": 0,
                "noteDetailCount": 0,
                "loginWallCount": if blocking_kind == "login" { 1 } else { 0 },
                "captchaSignalCount": if blocking_kind == "captcha" { 1 } else { 0 },
                "dialogCount": 1,
                "profileSignalCount": 0,
                "notificationSignalCount": 0,
                "publishSignalCount": 0,
                "errorSignalCount": 0,
                "mainCount": 1
            }
        })
    )}})
}

fn facebook_join_page_probe_cdp() -> Value {
    json!({"result":{"value":router_result(
        "page_probe",
        json!({
            "targetId": "",
            "origin": "https://www.facebook.com",
            "path": "/groups/42",
            "readyState": "complete",
            "pageKind": "unknown",
            "blockingKind": "none",
            "signals": {
                "feedCardCount": 0,
                "noteDetailCount": 0,
                "loginWallCount": 0,
                "captchaSignalCount": 0,
                "dialogCount": 0,
                "profileSignalCount": 0,
                "notificationSignalCount": 0,
                "publishSignalCount": 0,
                "errorSignalCount": 0,
                "mainCount": 1
            }
        })
    )}})
}

fn facebook_join_probe_cdp(joined: bool) -> Value {
    let label = if joined { "Joined" } else { "Join group" };
    json!({"result":{"value":router_result(
        "join_probe",
        json!({
            "observation": {
                "groupUrl": "https://www.facebook.com/groups/42",
                "pageUrl": "https://www.facebook.com/groups/42",
                "title": "Agent Builders",
                "mainCtaText": label,
                "mainCtaAria": label,
                "headerText": "Agent Builders",
                "modalText": null,
                "membershipSignals": if joined { vec!["Joined"] } else { Vec::<&str>::new() },
                "loginRequired": false,
                "captchaDetected": false,
                "questionnaireRequired": false,
                "pendingRequest": false,
                "navError": null,
                "actionNodeCount": 1,
                "documentReady": "complete",
                "composerPresent": joined,
                "joinCtaPresent": !joined,
                "targetGroupId": "42",
                "scopeResolved": true,
                "outOfScopeJoinCount": 0,
                "ctaCandidates": [{
                    "text": label,
                    "kind": if joined { "joined" } else { "join" },
                    "inTargetScope": true
                }]
            },
            "joined": joined,
            "pending": false,
            "questionnaire": false,
            "found": !joined,
            "ambiguous": false,
            "cx": if joined { Value::Null } else { json!(50.0) },
            "cy": if joined { Value::Null } else { json!(20.0) }
        })
    )}})
}

async fn spawn_facebook_initial_scan_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(
            &listener,
            port,
            "https://www.facebook.com/reel/1528556722142425",
        )
        .await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let result = match router_kind(&request).as_deref() {
                Some("page_probe") => facebook_ready_cdp("/"),
                Some("consent_probe") => facebook_consent_absent_cdp(),
                Some("feed_probe") => router_cdp(
                    "feed_probe",
                    json!({
                        "cards": [{
                            "index": 0,
                            "title": "Home Feed card",
                            "likeCount": 0,
                            "collectCount": 0,
                            "noteId": "https://www.facebook.com/Alice/posts/pfbidHOME"
                        }],
                        "documentGeneration": "home-generation",
                        "listKind": "feed",
                        "listState": "ready",
                        "loading": false,
                        "articleCount": 1,
                        "explicitEmpty": false,
                        "explicitEnd": false,
                        "url": "https://www.facebook.com/",
                        "surface": "home",
                        "scrollY": 0,
                        "innerWidth": 1440,
                        "innerHeight": 800,
                        "scrollHeight": 1600,
                        "scrollViewportHeight": 800,
                        "documentTimeOriginMs": 1780000000000_u64,
                        "documentAgeMs": 1000
                    }),
                ),
                _ => json!({}),
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

async fn spawn_facebook_feed_scroll_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    spawn_facebook_feed_scroll_cdp_for("https://www.facebook.com/").await
}

async fn spawn_facebook_feed_scroll_cdp_for(
    initial_url: &'static str,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, initial_url).await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut feed_probes = 0usize;
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let result = match router_kind(&request).as_deref() {
                Some("reel_probe") => router_cdp(
                    "reel_probe",
                    json!({
                        "ok": false,
                        "reason": "not_reel"
                    }),
                ),
                Some("page_probe") => facebook_feed_page_probe_cdp(),
                Some("consent_probe") => facebook_consent_absent_cdp(),
                Some("feed_probe") => {
                    feed_probes += 1;
                    facebook_feed_scroll_probe_cdp(feed_probes >= 3)
                }
                _ => json!({}),
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

#[derive(Clone, Copy)]
enum FacebookFeedScrollRecovery {
    Moves,
    Still,
    Drifts,
}

async fn run_facebook_feed_scroll_recovery(
    recovery: FacebookFeedScrollRecovery,
) -> (StoredCommandResult, Vec<Value>) {
    let (port, server) = spawn_facebook_feed_scroll_recovery_cdp(recovery).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open Facebook session");
    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "feed-scroll-recovery-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 20_000,
            command: NativeCommand::PageScroll(PageScrollParams {
                reason: Some("feed_scroll".to_owned()),
                surface: None,
                dwell_ms: None,
            }),
        })
        .await
        .expect("Feed scroll recovery");
    engine.shutdown().await;
    let requests = server.await.expect("Facebook Feed recovery fake CDP");
    (outcome, requests)
}

async fn spawn_facebook_feed_scroll_recovery_cdp(
    recovery: FacebookFeedScrollRecovery,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, "https://www.facebook.com/").await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut foregrounded = false;
        let mut wheel_gestures = 0usize;
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            if request["method"] == "Page.bringToFront" {
                foregrounded = true;
            }
            if request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseMoved"
            {
                wheel_gestures += 1;
            }
            let result = match router_kind(&request).as_deref() {
                Some("reel_probe") => router_cdp(
                    "reel_probe",
                    json!({
                        "ok": false,
                        "reason": "not_reel"
                    }),
                ),
                Some("page_probe") => facebook_feed_page_probe_cdp(),
                Some("consent_probe") => facebook_consent_absent_cdp(),
                Some("feed_probe") => {
                    let drifted = matches!(recovery, FacebookFeedScrollRecovery::Drifts)
                        && wheel_gestures > 0;
                    let moved = matches!(recovery, FacebookFeedScrollRecovery::Moves)
                        && foregrounded
                        && wheel_gestures >= 2;
                    facebook_feed_scroll_recovery_probe_cdp(moved, drifted)
                }
                _ => json!({}),
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

async fn spawn_facebook_feed_recovery_cdp(
    confirm_home: bool,
    target: (f64, f64),
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, "https://www.facebook.com/").await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut clicked = false;
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            if request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseReleased"
            {
                clicked = true;
            }
            let result = match router_kind(&request).as_deref() {
                Some("reel_probe") => router_cdp(
                    "reel_probe",
                    json!({
                        "ok": false,
                        "reason": "not_reel"
                    }),
                ),
                Some("page_probe") => facebook_feed_page_probe_cdp(),
                Some("consent_probe") => facebook_consent_absent_cdp(),
                Some("feed_probe") => {
                    facebook_feed_recovery_probe_cdp(!clicked, clicked && confirm_home, target)
                }
                Some("feed_recovery_target") => router_cdp(
                    "point_target",
                    json!({
                        "ok": true,
                        "cx": target.0,
                        "cy": target.1
                    }),
                ),
                _ => json!({}),
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

fn facebook_feed_recovery_probe_cdp(
    prompt: bool,
    confirmed_home: bool,
    target: (f64, f64),
) -> Value {
    router_cdp(
        "feed_probe",
        json!({
            "cards": if confirmed_home {
                json!([{
                    "index": 0,
                    "title": "Recovered Feed card",
                    "likeCount": 0,
                    "collectCount": 0,
                    "noteId": "https://www.facebook.com/Alice/posts/pfbidRECOVERED"
                }])
            } else {
                json!([])
            },
            "documentGeneration": if confirmed_home {
                "recovered-home-generation"
            } else {
                "feed-recovery-generation"
            },
            "listKind": "feed",
            "listState": if confirmed_home { "ready" } else { "empty" },
            "loading": false,
            "articleCount": if confirmed_home { 1 } else { 0 },
            "explicitEmpty": false,
            "explicitEnd": false,
            "url": if prompt || confirmed_home {
                "https://www.facebook.com/"
            } else {
                "https://www.facebook.com/recovery-pending"
            },
            "surface": if prompt || confirmed_home { "home" } else { "unknown" },
            "feedRecoveryTarget": if prompt {
                json!({
                    "ok": true,
                    "cx": target.0,
                    "cy": target.1
                })
            } else {
                json!({
                    "ok": false,
                    "reason": "no_feed_recovery_target"
                })
            },
            "scrollY": 0,
            "innerWidth": 1440,
            "innerHeight": 800,
            "scrollHeight": 800,
            "scrollViewportHeight": 800,
            "documentTimeOriginMs": 1780000000000_u64,
            "documentAgeMs": 2000
        }),
    )
}

fn facebook_feed_page_probe_cdp() -> Value {
    router_cdp(
        "page_probe",
        json!({
            "targetId": "",
            "origin": "https://www.facebook.com",
            "path": "/",
            "readyState": "complete",
            "pageKind": "unknown",
            "blockingKind": "none",
            "signals": {
                "feedCardCount": 1,
                "noteDetailCount": 0,
                "loginWallCount": 0,
                "captchaSignalCount": 0,
                "dialogCount": 0,
                "profileSignalCount": 0,
                "notificationSignalCount": 0,
                "publishSignalCount": 0,
                "errorSignalCount": 0,
                "mainCount": 1
            }
        }),
    )
}

fn facebook_feed_scroll_probe_cdp(after_scroll: bool) -> Value {
    router_cdp(
        "feed_probe",
        json!({
            "cards": [{
                "index": 0,
                "title": if after_scroll { "After scroll" } else { "Before scroll" },
                "likeCount": 0,
                "collectCount": 0,
                "noteId": if after_scroll {
                    "https://www.facebook.com/Alice/posts/pfbidAFTER"
                } else {
                    "https://www.facebook.com/Alice/posts/pfbidBEFORE"
                }
            }],
            "documentGeneration": "home-generation",
            "listKind": "feed",
            "listState": "ready",
            "loading": false,
            "articleCount": 1,
            "explicitEmpty": false,
            "explicitEnd": false,
            "url": "https://www.facebook.com/",
            "surface": "home",
            "scrollY": if after_scroll { 650 } else { 0 },
            "innerWidth": 1440,
            "innerHeight": 800,
            "scrollHeight": 2400,
            "scrollViewportHeight": 800,
            "documentTimeOriginMs": 1780000000000_u64,
            "documentAgeMs": 2000
        }),
    )
}

fn facebook_feed_scroll_recovery_probe_cdp(moved: bool, drifted: bool) -> Value {
    router_cdp(
        "feed_probe",
        json!({
            "cards": [{
                "index": 0,
                "title": if moved {
                    "After recovery"
                } else if drifted {
                    "Different document"
                } else {
                    "Before recovery"
                },
                "likeCount": 0,
                "collectCount": 0,
                "noteId": if moved {
                    "https://www.facebook.com/Alice/posts/pfbidAFTER"
                } else if drifted {
                    "https://www.facebook.com/Alice/posts/pfbidDRIFT"
                } else {
                    "https://www.facebook.com/Alice/posts/pfbidBEFORE"
                }
            }],
            "documentGeneration": if drifted { "search-generation" } else { "home-generation" },
            "listKind": "feed",
            "listState": "ready",
            "loading": false,
            "articleCount": 1,
            "explicitEmpty": false,
            "explicitEnd": false,
            "url": if drifted {
                "https://www.facebook.com/search/posts?q=changed"
            } else {
                "https://www.facebook.com/"
            },
            "surface": if drifted { "search" } else { "home" },
            "scrollY": if moved { 650 } else { 0 },
            "innerWidth": 1440,
            "innerHeight": 800,
            "scrollHeight": 2400,
            "scrollViewportHeight": 800,
            "documentTimeOriginMs": if drifted {
                1780000001000_u64
            } else {
                1780000000000_u64
            },
            "documentAgeMs": 2000
        }),
    )
}

async fn spawn_facebook_initial_scan_navigation_failure_cdp()
-> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, "https://www.facebook.com/groups/123").await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        requests.push(reject_call_capture(&mut websocket, -32000, "navigation failed").await);
        let _ = websocket.close(None).await;
        requests
    });
    (port, server)
}

async fn spawn_facebook_note_open_hydration_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(
            &listener,
            port,
            "https://www.facebook.com/groups/100/posts/999",
        )
        .await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut detail_samples = 0_u32;
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let result = match router_kind(&request).as_deref() {
                Some("page_probe") => facebook_ready_cdp("/groups/100/posts/2579243155868042"),
                Some("consent_probe") => facebook_consent_absent_cdp(),
                Some("note_open") => {
                    detail_samples += 1;
                    if detail_samples == 1 {
                        facebook_note_detail_cdp(
                            "https://www.facebook.com/groups/100/posts/999",
                            "stale post",
                        )
                    } else {
                        facebook_note_detail_cdp(
                            "https://www.facebook.com/permalink.php?story_fbid=2579243155868042&id=99",
                            "requested post",
                        )
                    }
                }
                _ => json!({}),
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

async fn spawn_facebook_first_post_below_fold_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(
            &listener,
            port,
            "https://www.facebook.com/groups/945390701793119",
        )
        .await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut scrolls = 0_u32;
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let result = match router_kind(&request).as_deref() {
                Some("first_post_group_root_probe") => facebook_first_post_group_root_probe_cdp(
                    "/groups/945390701793119",
                    "group",
                    Some("945390701793119"),
                    true,
                ),
                Some("page_probe") => facebook_ready_cdp("/groups/945390701793119/posts/333"),
                Some("consent_probe") => facebook_consent_absent_cdp(),
                Some("feed_refresh") => router_cdp(
                    "page_cards",
                    json!({
                        "cards": [],
                        "listKind": "feed",
                        "listState": "present_unreportable"
                    }),
                ),
                Some("browse_scroll") => {
                    scrolls += 1;
                    let cards = if scrolls < 2 {
                        json!([])
                    } else {
                        json!([{
                            "index": 0,
                            "title": "below-fold first post",
                            "likeCount": 0,
                            "collectCount": 0,
                            "noteId": "https://www.facebook.com/groups/945390701793119/posts/333"
                        }])
                    };
                    router_cdp(
                        "page_cards",
                        json!({
                            "cards": cards,
                            "movement": {
                                "before": if scrolls == 1 { 0.0 } else { 852.0 },
                                "after": if scrolls == 1 { 852.0 } else { 1704.0 },
                                "moved": true,
                                "atBottom": false
                            },
                            "listKind": "feed",
                            "listState": if scrolls < 2 { "present_unreportable" } else { "ready" }
                        }),
                    )
                }
                Some("comment_editor_probe") => router_cdp(
                    "text_target",
                    json!({
                        "ok": true,
                        "noteId": "https://www.facebook.com/groups/945390701793119/posts/333",
                        "cx": 640.0,
                        "cy": 700.0,
                        "focused": false,
                        "selected": false
                    }),
                ),
                Some("note_open") => facebook_note_detail_cdp(
                    "https://www.facebook.com/groups/945390701793119/posts/333",
                    "below-fold first post",
                ),
                _ => json!({}),
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

async fn spawn_facebook_first_post_root_fallback_cdp(
    initial_url: &str,
    initial_root_probe: Value,
    target_ref: String,
    reject_first_feed_refresh: bool,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let initial_url = initial_url.to_owned();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, &initial_url).await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut navigated_to_group_root = false;
        let mut feed_refresh_count = 0_usize;
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            if request["method"] == "Page.navigate"
                && request.pointer("/params/url").and_then(Value::as_str)
                    == Some("https://www.facebook.com/groups/945390701793119")
            {
                navigated_to_group_root = true;
            }
            let result = match router_kind(&request).as_deref() {
                Some("first_post_group_root_probe") if navigated_to_group_root => {
                    facebook_first_post_group_root_probe_cdp(
                        "/groups/945390701793119",
                        "group",
                        Some("945390701793119"),
                        true,
                    )
                }
                Some("first_post_group_root_probe") => initial_root_probe.clone(),
                Some("page_probe") => facebook_ready_cdp("/groups/945390701793119"),
                Some("consent_probe") => facebook_consent_absent_cdp(),
                Some("feed_refresh") if reject_first_feed_refresh && feed_refresh_count == 0 => {
                    feed_refresh_count += 1;
                    router_cdp(
                        "page_cards",
                        json!({
                            "cards": [],
                            "selectionReason": "target_context_mismatch",
                            "listKind": "feed",
                            "listState": "present_unreportable"
                        }),
                    )
                }
                Some("feed_refresh") => {
                    feed_refresh_count += 1;
                    router_cdp(
                        "page_cards",
                        json!({
                            "cards": [{
                                "index": 0,
                                "title": "fallback first post",
                                "likeCount": 0,
                                "collectCount": 0,
                                "noteId": target_ref.clone()
                            }],
                            "listKind": "feed",
                            "listState": "ready"
                        }),
                    )
                }
                // 姿态类失败改为消费下滚预算后续探（change restore-facebook-first-post-recovery），
                // 于是这条竞态在纠正导航之前会先把四轮下滚走完。竞态本身在导航之前一直存在，
                // 所以每一轮都照旧回同一条姿态失败。
                Some("browse_scroll") => router_cdp(
                    "page_cards",
                    json!({
                        "cards": [],
                        "selectionReason": "target_context_mismatch",
                        "listKind": "feed",
                        "listState": "present_unreportable"
                    }),
                ),
                Some("comment_editor_probe") => router_cdp(
                    "text_target",
                    json!({
                        "ok": true,
                        "noteId": target_ref.clone(),
                        "cx": 640.0,
                        "cy": 700.0,
                        "focused": false,
                        "selected": false
                    }),
                ),
                Some("note_open") => facebook_note_detail_cdp(&target_ref, "fallback first post"),
                _ => json!({}),
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

async fn spawn_facebook_first_post_reuse_context_mismatch_cdp()
-> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(
            &listener,
            port,
            "https://www.facebook.com/groups/945390701793119",
        )
        .await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let result = match router_kind(&request).as_deref() {
                Some("first_post_group_root_probe") => facebook_first_post_group_root_probe_cdp(
                    "/groups/945390701793119",
                    "group",
                    Some("945390701793119"),
                    true,
                ),
                Some("page_probe") => facebook_ready_cdp("/groups/945390701793119"),
                Some("consent_probe") => facebook_consent_absent_cdp(),
                // 姿态类失败先消费下滚预算再走纠正导航，所以这一幕里每一轮下滚也照旧回同一条失败。
                Some("feed_refresh") | Some("browse_scroll") => router_cdp(
                    "page_cards",
                    json!({
                        "cards": [],
                        "selectionReason": "target_context_mismatch",
                        "listKind": "feed",
                        "listState": "present_unreportable"
                    }),
                ),
                _ => json!({}),
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

async fn spawn_facebook_first_post_late_context_mismatch_cdp()
-> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(
            &listener,
            port,
            "https://www.facebook.com/groups/945390701793119",
        )
        .await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut scrolls = 0_usize;
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let result = match router_kind(&request).as_deref() {
                Some("first_post_group_root_probe") => facebook_first_post_group_root_probe_cdp(
                    "/groups/945390701793119",
                    "group",
                    Some("945390701793119"),
                    true,
                ),
                Some("page_probe") => facebook_ready_cdp("/groups/945390701793119"),
                Some("consent_probe") => facebook_consent_absent_cdp(),
                Some("feed_refresh") => router_cdp(
                    "page_cards",
                    json!({
                        "cards": [],
                        "listKind": "feed",
                        "listState": "present_unreportable"
                    }),
                ),
                Some("browse_scroll") => {
                    scrolls += 1;
                    // 第三轮起才出姿态失败：既证明「预算中途的姿态失败不会弃掉剩余轮次」
                    // （否则只会看到 3 次下滚），也让预算耗尽时手里确实还捏着一条姿态失败，
                    // 从而走到那条纠正导航——本用例真正要守的是「纠正不重置已消费的轮次」。
                    let selection_reason = (scrolls >= 3).then_some("target_context_mismatch");
                    router_cdp(
                        "page_cards",
                        json!({
                            "cards": [],
                            "selectionReason": selection_reason,
                            "listKind": "feed",
                            "listState": "present_unreportable"
                        }),
                    )
                }
                _ => json!({}),
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

async fn spawn_facebook_first_post_cancel_after_root_probe_cdp(
    cancellation: Arc<AtomicBool>,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, "https://www.facebook.com/groups/42").await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let is_root_probe =
                router_kind(&request).as_deref() == Some("first_post_group_root_probe");
            let result = if is_root_probe {
                facebook_first_post_group_root_probe_cdp("/groups/42", "group", Some("42"), true)
            } else {
                json!({})
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
            if is_root_probe {
                cancellation.store(true, Ordering::Release);
            }
        }
        requests
    });
    (port, server)
}

async fn spawn_facebook_bound_first_post_cdp(
    target_ref: String,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(
            &listener,
            port,
            "https://www.facebook.com/groups/945390701793119",
        )
        .await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let result = match router_kind(&request).as_deref() {
                Some("first_post_group_root_probe") => facebook_first_post_group_root_probe_cdp(
                    "/groups/945390701793119",
                    "group",
                    Some("945390701793119"),
                    true,
                ),
                Some("page_probe") => facebook_ready_cdp("/groups/945390701793119"),
                Some("consent_probe") => facebook_consent_absent_cdp(),
                Some("feed_refresh") => router_cdp(
                    "page_cards",
                    json!({
                        "cards": [{
                            "index": 0,
                            "title": "permalinkless first post",
                            "likeCount": 0,
                            "collectCount": 0,
                            "noteId": target_ref.clone()
                        }],
                        "listKind": "feed",
                        "listState": "ready"
                    }),
                ),
                Some("comment_editor_probe") => router_cdp(
                    "text_target",
                    json!({
                        "ok": true,
                        "noteId": target_ref.clone(),
                        "cx": 640.0,
                        "cy": 700.0,
                        "focused": false,
                        "selected": false
                    }),
                ),
                Some("note_open") => {
                    facebook_note_detail_cdp(&target_ref, "permalinkless first post")
                }
                _ => json!({}),
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

async fn spawn_facebook_bound_first_post_click_hydration_cdp(
    target_ref: String,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(
            &listener,
            port,
            "https://www.facebook.com/groups/945390701793119",
        )
        .await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut editor_ready = false;
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let method = request["method"].as_str().unwrap_or_default();
            if method == "Input.dispatchMouseEvent" && request["params"]["type"] == "mouseReleased"
            {
                editor_ready = true;
            }
            let result = match router_kind(&request).as_deref() {
                Some("first_post_group_root_probe") => facebook_first_post_group_root_probe_cdp(
                    "/groups/945390701793119",
                    "group",
                    Some("945390701793119"),
                    true,
                ),
                Some("page_probe") => facebook_ready_cdp("/groups/945390701793119"),
                Some("consent_probe") => facebook_consent_absent_cdp(),
                Some("feed_refresh") => router_cdp(
                    "page_cards",
                    json!({
                        "cards": [{
                            "index": 0,
                            "title": "editor hydrated first post",
                            "likeCount": 0,
                            "collectCount": 0,
                            "noteId": target_ref.clone()
                        }],
                        "listKind": "feed",
                        "listState": "ready"
                    }),
                ),
                Some("comment_editor_probe") if editor_ready => router_cdp(
                    "text_target",
                    json!({
                        "ok": true,
                        "noteId": target_ref.clone(),
                        "cx": 640.0,
                        "cy": 700.0,
                        "focused": false,
                        "selected": false
                    }),
                ),
                Some("comment_editor_probe") => router_cdp(
                    "text_target",
                    json!({
                        "ok": false,
                        "noteId": target_ref.clone(),
                        "reason": "editor_not_found"
                    }),
                ),
                Some("comment_action_probe") => router_cdp(
                    "point_target",
                    json!({
                        "ok": true,
                        "cx": 520.0,
                        "cy": 680.0
                    }),
                ),
                Some("note_open") => {
                    facebook_note_detail_cdp(&target_ref, "editor hydrated first post")
                }
                _ => json!({}),
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

async fn spawn_facebook_note_open_mismatch_cdp() -> (u16, tokio::task::JoinHandle<usize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(
            &listener,
            port,
            "https://www.facebook.com/groups/100/posts/999",
        )
        .await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        for _ in 0..3 {
            respond_to_call(&mut websocket, json!({})).await;
        }
        let mut samples = 0;
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let result = match router_kind(&request).as_deref() {
                Some("page_probe") => facebook_ready_cdp("/groups/100/posts/2579243155868042"),
                Some("consent_probe") => facebook_consent_absent_cdp(),
                Some("note_open") => {
                    samples += 1;
                    facebook_note_detail_cdp(
                        "https://www.facebook.com/groups/100/posts/999",
                        "stale post",
                    )
                }
                _ => json!({}),
            };
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP mismatch response");
        }
        samples
    });
    (port, server)
}

fn facebook_ready_cdp(path: &str) -> Value {
    json!({"result":{"value":router_result(
        "page_probe",
        json!({
            "targetId": "",
            "origin": "https://www.facebook.com",
            "path": path,
            "readyState": "complete",
            "pageKind": "note_detail",
            "signals": {
                "feedCardCount": 0,
                "noteDetailCount": 1,
                "loginWallCount": 0,
                "captchaSignalCount": 0,
                "dialogCount": 0,
                "profileSignalCount": 0,
                "notificationSignalCount": 0,
                "publishSignalCount": 0,
                "errorSignalCount": 0,
                "mainCount": 1
            }
        })
    )}})
}

fn facebook_note_detail_cdp(note_id: &str, content: &str) -> Value {
    json!({"result":{"value":router_result(
        "note_detail",
        json!({
            "noteId": note_id,
            "title": content,
            "content": content,
            "likeCount": 0,
            "collectCount": 0
        })
    )}})
}

#[derive(Clone, Copy, Debug)]
enum FacebookReelsEntryScenario {
    FirstNavigationSucceeds,
    RetryNavigationSucceeds,
    ActivationRevealsReels,
    MissingActiveVideoSafe,
    AnonymousHydratesAfterFirstKey,
    AnonymousNeverMoves,
    AnonymousUnsafe,
    AnonymousInputSafetyMissing,
    BlockedByLogin,
    BlockedByCaptcha,
    BlockedByConsent,
    UnknownActionRestriction,
    BlockedAfterNavigation,
    CancelBeforeFirstNavigation,
    CancelBeforeRetryNavigation,
    DocumentDrifts,
}

const FACEBOOK_REELS_ENTRY_TEST_TIMEOUT_MS: u64 = 55_000;

#[derive(Clone, Copy)]
enum FacebookEntryPageState {
    Feed,
    UnknownFeed,
    Reels,
    Login,
    Captcha,
    Drifted,
}

async fn run_facebook_reels_entry(
    scenario: FacebookReelsEntryScenario,
) -> (StoredCommandResult, Vec<Value>) {
    let (port, server) = spawn_facebook_reels_entry_cdp(scenario).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = FACEBOOK_REELS_ENTRY_TEST_TIMEOUT_MS;
    engine.open(&open).await.expect("open Facebook session");
    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "reels-entry-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + FACEBOOK_REELS_ENTRY_TEST_TIMEOUT_MS,
            command: NativeCommand::PageScroll(PageScrollParams {
                reason: Some("resume_redrive".to_owned()),
                surface: Some(BrowseSurface::Reels),
                dwell_ms: None,
            }),
        })
        .await
        .expect("Reels entry command");
    engine.shutdown().await;
    let requests = server.await.expect("Reels entry fake CDP");
    (outcome, requests)
}

async fn run_facebook_reels_entry_with_cancellation(
    scenario: FacebookReelsEntryScenario,
) -> (StoredCommandResult, Vec<Value>) {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) =
        spawn_facebook_reels_entry_cdp_with_cancellation(scenario, Some(cancellation.clone()))
            .await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = FACEBOOK_REELS_ENTRY_TEST_TIMEOUT_MS;
    engine.open(&open).await.expect("open Facebook session");
    let outcome = engine
        .execute_cancellable(
            &CommandRecord {
                protocol_version: 2,
                id: "reels-entry-cancel-1".to_owned(),
                session_id: "session-1".to_owned(),
                task_id: "browse-1".to_owned(),
                command_id: 1,
                deadline_unix_ms: unix_time_ms() + FACEBOOK_REELS_ENTRY_TEST_TIMEOUT_MS,
                command: NativeCommand::PageScroll(PageScrollParams {
                    reason: Some("resume_redrive".to_owned()),
                    surface: Some(BrowseSurface::Reels),
                    dwell_ms: None,
                }),
            },
            cancellation,
        )
        .await
        .expect("cancelled Reels entry command");
    engine.shutdown().await;
    let requests = server.await.expect("cancelled Reels entry fake CDP");
    (outcome, requests)
}

async fn spawn_facebook_reels_entry_cdp(
    scenario: FacebookReelsEntryScenario,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    spawn_facebook_reels_entry_cdp_with_cancellation(scenario, None).await
}

async fn spawn_facebook_reels_entry_cdp_with_cancellation(
    scenario: FacebookReelsEntryScenario,
    cancellation: Option<Arc<AtomicBool>>,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let initial_url = if matches!(scenario, FacebookReelsEntryScenario::BlockedByLogin) {
        "https://www.facebook.com/login/"
    } else {
        "https://www.facebook.com/"
    };
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, initial_url).await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut state = match scenario {
            FacebookReelsEntryScenario::BlockedByLogin => FacebookEntryPageState::Login,
            FacebookReelsEntryScenario::BlockedByCaptcha => FacebookEntryPageState::Captcha,
            FacebookReelsEntryScenario::UnknownActionRestriction => {
                FacebookEntryPageState::UnknownFeed
            }
            _ => FacebookEntryPageState::Feed,
        };
        let mut navigation_count = 0_u32;
        let mut entry_advanced = false;
        let mut pending_identity_ready = false;
        let mut foregrounded = false;
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            if request["method"] == "Page.navigate" {
                navigation_count += 1;
                state = match scenario {
                    FacebookReelsEntryScenario::FirstNavigationSucceeds
                    | FacebookReelsEntryScenario::MissingActiveVideoSafe
                    | FacebookReelsEntryScenario::AnonymousHydratesAfterFirstKey
                    | FacebookReelsEntryScenario::AnonymousNeverMoves
                    | FacebookReelsEntryScenario::AnonymousUnsafe
                    | FacebookReelsEntryScenario::AnonymousInputSafetyMissing
                    | FacebookReelsEntryScenario::BlockedByConsent
                    | FacebookReelsEntryScenario::UnknownActionRestriction => {
                        FacebookEntryPageState::Reels
                    }
                    FacebookReelsEntryScenario::RetryNavigationSucceeds
                        if navigation_count >= 2 =>
                    {
                        FacebookEntryPageState::Reels
                    }
                    FacebookReelsEntryScenario::BlockedAfterNavigation => {
                        FacebookEntryPageState::Login
                    }
                    FacebookReelsEntryScenario::DocumentDrifts => FacebookEntryPageState::Drifted,
                    _ => state,
                };
            } else if request["method"] == "Page.bringToFront"
                && matches!(scenario, FacebookReelsEntryScenario::ActivationRevealsReels)
            {
                state = FacebookEntryPageState::Reels;
            }
            if request["method"] == "Page.bringToFront" {
                foregrounded = true;
            }
            if request["method"] == "Input.dispatchKeyEvent"
                && request["params"]["type"] == "rawKeyDown"
                && facebook_reels_entry_key(scenario)
                    .is_some_and(|key| request["params"]["key"] == key)
            {
                if matches!(
                    scenario,
                    FacebookReelsEntryScenario::AnonymousHydratesAfterFirstKey
                ) {
                    pending_identity_ready = true;
                } else if !matches!(scenario, FacebookReelsEntryScenario::AnonymousNeverMoves) {
                    entry_advanced = true;
                }
            }
            let result = if request["method"] == "Runtime.evaluate" {
                let expression = request["params"]["expression"].as_str().unwrap_or_default();
                if expression.contains("\"kind\":\"page_probe\"") {
                    facebook_entry_page_probe_cdp(state)
                } else if expression.contains("\"kind\":\"consent_probe\"") {
                    if matches!(scenario, FacebookReelsEntryScenario::BlockedByConsent) {
                        router_cdp(
                            "consent_probe",
                            json!({
                                "present": true,
                                "acceptAll": {"cx": 420.0, "cy": 680.0},
                                "necessaryOnly": null,
                                "acceptAllAmbiguous": false,
                                "necessaryOnlyAmbiguous": false
                            }),
                        )
                    } else {
                        facebook_consent_absent_cdp()
                    }
                } else if expression.contains("\"kind\":\"reel_probe\"") {
                    match state {
                        FacebookEntryPageState::Reels
                            if matches!(
                                scenario,
                                FacebookReelsEntryScenario::MissingActiveVideoSafe
                            ) =>
                        {
                            if entry_advanced {
                                reel_probe_cdp(
                                    "https://www.facebook.com/reel/2",
                                    "video-2@element:2",
                                )
                            } else {
                                structureless_reel_probe_cdp("no_active_video", Some(true))
                            }
                        }
                        FacebookEntryPageState::Reels
                            if matches!(
                                scenario,
                                FacebookReelsEntryScenario::AnonymousUnsafe
                                    | FacebookReelsEntryScenario::BlockedByConsent
                            ) =>
                        {
                            anonymous_reel_probe_with_safety_cdp("video-1@element:1", Some(false))
                        }
                        FacebookEntryPageState::Reels
                            if matches!(
                                scenario,
                                FacebookReelsEntryScenario::AnonymousInputSafetyMissing
                            ) =>
                        {
                            anonymous_reel_probe_with_safety_cdp("video-1@element:1", None)
                        }
                        FacebookEntryPageState::Reels
                            if matches!(
                                scenario,
                                FacebookReelsEntryScenario::AnonymousHydratesAfterFirstKey
                            ) =>
                        {
                            if pending_identity_ready {
                                reel_probe_cdp(
                                    "https://www.facebook.com/reel/1",
                                    "video-1@element:1",
                                )
                            } else {
                                anonymous_reel_probe_cdp("video-1@element:1")
                            }
                        }
                        FacebookEntryPageState::Reels
                            if matches!(
                                scenario,
                                FacebookReelsEntryScenario::AnonymousNeverMoves
                            ) =>
                        {
                            anonymous_reel_probe_cdp("video-1@element:1")
                        }
                        FacebookEntryPageState::Reels => {
                            reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1")
                        }
                        _ => router_cdp("reel_probe", json!({"ok": false, "reason": "not_reel"})),
                    }
                } else if expression.contains("\"kind\":\"reel_cards\"") {
                    match scenario {
                        FacebookReelsEntryScenario::MissingActiveVideoSafe if entry_advanced => {
                            reel_cards_cdp("https://www.facebook.com/reel/2")
                        }
                        FacebookReelsEntryScenario::MissingActiveVideoSafe
                        | FacebookReelsEntryScenario::AnonymousNeverMoves
                        | FacebookReelsEntryScenario::AnonymousUnsafe
                        | FacebookReelsEntryScenario::AnonymousInputSafetyMissing
                        | FacebookReelsEntryScenario::BlockedByConsent => reel_empty_cards_cdp(),
                        FacebookReelsEntryScenario::AnonymousHydratesAfterFirstKey
                            if pending_identity_ready =>
                        {
                            reel_cards_cdp("https://www.facebook.com/reel/1")
                        }
                        FacebookReelsEntryScenario::AnonymousHydratesAfterFirstKey => {
                            reel_empty_cards_cdp()
                        }
                        _ => reel_cards_cdp("https://www.facebook.com/reel/1"),
                    }
                } else {
                    json!({})
                }
            } else {
                json!({})
            };
            let cancel_after_probe = router_kind(&request).as_deref() == Some("page_probe")
                && match scenario {
                    FacebookReelsEntryScenario::CancelBeforeFirstNavigation => {
                        navigation_count == 0
                    }
                    FacebookReelsEntryScenario::CancelBeforeRetryNavigation => {
                        navigation_count == 1 && foregrounded
                    }
                    _ => false,
                };
            requests.push(request);
            if cancel_after_probe && let Some(cancellation) = cancellation.as_ref() {
                cancellation.store(true, Ordering::Release);
            }
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

fn facebook_reels_entry_key(scenario: FacebookReelsEntryScenario) -> Option<&'static str> {
    match scenario {
        FacebookReelsEntryScenario::MissingActiveVideoSafe
        | FacebookReelsEntryScenario::AnonymousHydratesAfterFirstKey
        | FacebookReelsEntryScenario::AnonymousNeverMoves => Some("ArrowRight"),
        _ => None,
    }
}

fn facebook_entry_page_probe_cdp(state: FacebookEntryPageState) -> Value {
    let (path, page_kind, blocking_kind) = match state {
        FacebookEntryPageState::Feed => ("/", "home", None),
        FacebookEntryPageState::UnknownFeed => ("/", "home", Some("unknown")),
        FacebookEntryPageState::Reels => ("/reels/", "unknown", None),
        FacebookEntryPageState::Login => ("/login/", "login", Some("login")),
        FacebookEntryPageState::Captcha => ("/checkpoint/", "unknown", Some("captcha")),
        FacebookEntryPageState::Drifted => ("/notifications/", "unknown", None),
    };
    router_cdp(
        "page_probe",
        json!({
            "targetId": "",
            "origin": "https://www.facebook.com",
            "path": path,
            "readyState": "complete",
            "pageKind": page_kind,
            "blockingKind": blocking_kind,
            "signals": {
                "feedCardCount": 1,
                "noteDetailCount": 0,
                "loginWallCount": u32::from(blocking_kind == Some("login")),
                "captchaSignalCount": u32::from(blocking_kind == Some("captcha")),
                "dialogCount": 0,
                "profileSignalCount": 0,
                "notificationSignalCount": 0,
                "publishSignalCount": 0,
                "errorSignalCount": 0,
                "mainCount": 1
            }
        }),
    )
}

fn reel_empty_cards_cdp() -> Value {
    router_cdp(
        "page_cards",
        json!({"cards": [], "listKind": "reels", "listState": "present_unreportable"}),
    )
}

#[derive(Clone, Copy)]
enum FacebookReelKeyScenario {
    RightMoves,
    RightMissesThenDownMoves,
    NeverMoves,
    UnsafeFocus,
    InputSafetyMissing,
    MissingActiveVideoSafe,
    AmbiguousActiveVideoSafe,
}

async fn run_facebook_reel_active_key_probe(
    scenario: FacebookReelKeyScenario,
) -> (StoredCommandResult, Vec<Value>) {
    let (port, server) = spawn_facebook_reel_active_key_probe_cdp(scenario).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 25_000;
    engine.open(&open).await.expect("open Facebook session");
    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "reel-active-key-probe-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 25_000,
            command: NativeCommand::PageScroll(PageScrollParams {
                reason: Some("feed_scroll".to_owned()),
                surface: None,
                dwell_ms: None,
            }),
        })
        .await
        .expect("active Reels key probe");
    engine.shutdown().await;
    let requests = server.await.expect("active Reels key fake CDP");
    (outcome, requests)
}

async fn spawn_facebook_reel_active_key_probe_cdp(
    scenario: FacebookReelKeyScenario,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    spawn_facebook_reel_active_key_probe_cdp_with_cancellation(scenario, None).await
}

async fn spawn_facebook_reel_active_key_probe_cdp_with_cancellation(
    scenario: FacebookReelKeyScenario,
    cancellation_after_first_probe: Option<Arc<AtomicBool>>,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let initial_url = if matches!(
        scenario,
        FacebookReelKeyScenario::MissingActiveVideoSafe
            | FacebookReelKeyScenario::AmbiguousActiveVideoSafe
    ) {
        "https://www.facebook.com/reel/"
    } else {
        "https://www.facebook.com/reel/1"
    };
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, initial_url).await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut forward_key_count = 0_u32;
        let mut reel_probe_count = 0_u32;
        let mut current_reel = 1_u32;
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            if request["method"] == "Input.dispatchKeyEvent"
                && request["params"]["type"] == "rawKeyDown"
            {
                forward_key_count += 1;
                let key = request["params"]["key"].as_str().unwrap_or_default();
                let key_moves = (matches!(scenario, FacebookReelKeyScenario::RightMoves)
                    && key == "ArrowRight")
                    || (matches!(scenario, FacebookReelKeyScenario::RightMissesThenDownMoves)
                        && key == "ArrowDown"
                        && forward_key_count >= 2);
                if key_moves {
                    current_reel = current_reel.saturating_add(1);
                } else if matches!(
                    scenario,
                    FacebookReelKeyScenario::MissingActiveVideoSafe
                        | FacebookReelKeyScenario::AmbiguousActiveVideoSafe
                ) && key == "ArrowRight"
                {
                    current_reel = 2;
                }
            }
            let result = if request["method"] == "Runtime.evaluate" {
                let expression = request["params"]["expression"].as_str().unwrap_or_default();
                if expression.contains("\"kind\":\"reel_probe\"") {
                    reel_probe_count += 1;
                    if matches!(scenario, FacebookReelKeyScenario::UnsafeFocus) {
                        router_cdp(
                            "reel_probe",
                            json!({
                                "ok": true,
                                "noteId": "https://www.facebook.com/reel/1",
                                "videoRect": {"left": 200.0, "top": 80.0, "right": 980.0, "bottom": 760.0},
                                "inputSafe": false
                            }),
                        )
                    } else if matches!(scenario, FacebookReelKeyScenario::InputSafetyMissing) {
                        router_cdp(
                            "reel_probe",
                            json!({
                                "ok": true,
                                "noteId": "https://www.facebook.com/reel/1",
                                "videoRect": {"left": 200.0, "top": 80.0, "right": 980.0, "bottom": 760.0}
                            }),
                        )
                    } else if current_reel == 1
                        && matches!(scenario, FacebookReelKeyScenario::MissingActiveVideoSafe)
                    {
                        structureless_reel_probe_cdp("no_active_video", Some(true))
                    } else if current_reel == 1
                        && matches!(scenario, FacebookReelKeyScenario::AmbiguousActiveVideoSafe)
                    {
                        structureless_reel_probe_cdp("ambiguous_target", Some(true))
                    } else {
                        let note_id = format!("https://www.facebook.com/reel/{current_reel}");
                        reel_probe_cdp(&note_id, "video@element")
                    }
                } else if expression.contains("\"kind\":\"reel_cards\"") {
                    let note_id = format!("https://www.facebook.com/reel/{current_reel}");
                    reel_cards_cdp(&note_id)
                } else {
                    json!({})
                }
            } else {
                json!({})
            };
            requests.push(request);
            if reel_probe_count == 1
                && cancellation_after_first_probe.is_some()
                && router_kind(requests.last().expect("captured request")).as_deref()
                    == Some("reel_probe")
                && let Some(cancellation) = cancellation_after_first_probe.as_ref()
            {
                cancellation.store(true, Ordering::Release);
            }
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

fn reel_probe_cdp(note_id: &str, _video_key: &str) -> Value {
    json!({"result":{"value":router_result(
        "reel_probe",
        json!({
            "ok": true,
            "noteId": note_id,
            "videoRect": {"left": 200.0, "top": 80.0, "right": 980.0, "bottom": 760.0},
            "inputSafe": true
        })
    )}})
}

fn structureless_reel_probe_cdp(reason: &str, input_safe: Option<bool>) -> Value {
    json!({"result":{"value":router_result(
        "reel_probe",
        json!({
            "ok": false,
            "reason": reason,
            "inputSafe": input_safe
        })
    )}})
}

fn anonymous_reel_probe_cdp(_video_key: &str) -> Value {
    anonymous_reel_probe_with_safety_cdp(_video_key, Some(true))
}

fn anonymous_reel_probe_with_safety_cdp(_video_key: &str, input_safe: Option<bool>) -> Value {
    json!({"result":{"value":router_result(
        "reel_probe",
        json!({
            "ok": true,
            "videoRect": {"left": 200.0, "top": 80.0, "right": 980.0, "bottom": 760.0},
            "inputSafe": input_safe
        })
    )}})
}

fn reel_cards_cdp(note_id: &str) -> Value {
    json!({"result":{"value":router_result(
        "page_cards",
        json!({
            "cards": [{
                "index": 0,
                "title": "Moved Reel",
                "likeCount": 0,
                "collectCount": 0,
                "noteId": note_id,
                "isVideo": true
            }],
            "listKind": "reels",
            "listState": "ready"
        })
    )}})
}

fn router_result(kind: &str, value: Value) -> Value {
    json!({
        "effectPhase": "confirmed",
        "output": {"kind": kind, "value": value}
    })
}

async fn spawn_xhs_self_identity_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing(&listener, port).await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        requests.push(
            respond_to_call_capture(
                &mut websocket,
                json!({"result":{"value":{
                    "href":"https://www.xiaohongshu.com/user/profile/author_123",
                    "readyState":"complete",
                    "feedCardCount":0,
                    "noteDetailCount":0,
                    "loginWallCount":0,
                    "captchaSignalCount":0,
                    "dialogCount":0,
                    "profileSignalCount":2,
                    "mainCount":1
                }}}),
            )
            .await,
        );
        requests.push(
            respond_to_call_capture(
                &mut websocket,
                json!({"result":{"value":{
                    "effectPhase":"confirmed",
                    "output":{"kind":"profile_detail","value":{
                        "authorId":"author_123",
                        "postsCount":5,
                        "followersCount":100,
                        "extracted":true,
                        "nickname":"工程师大白",
                        "url":"https://www.xiaohongshu.com/user/profile/author_123"
                    }}
                }}}),
            )
            .await,
        );
        let _ = websocket.close(None).await;
        requests
    });
    (port, server)
}

async fn spawn_disconnect_then_recover_cdp() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing(&listener, port).await;
        let (first_stream, _) = listener.accept().await.expect("first WebSocket request");
        let mut first = accept_async(first_stream)
            .await
            .expect("first WebSocket handshake");
        respond_to_call(&mut first, json!({})).await;
        respond_to_call(&mut first, json!({})).await;
        respond_to_call(&mut first, json!({})).await;
        let _ = first.next().await.expect("first evaluate request");
        first.close(None).await.expect("first close");

        // 重连的第一件事是复核实例身份：先答 `/json/version`，再答 `/json`。
        // 顺序不能反 —— 引擎在身份对上之前不会去问「你开了哪些页面」。
        serve_browser_version(&listener, port, ADMITTED_BROWSER_ID).await;
        serve_target_listing(&listener, port).await;
        let (second_stream, _) = listener.accept().await.expect("second WebSocket request");
        let mut second = accept_async(second_stream)
            .await
            .expect("second WebSocket handshake");
        respond_to_call(&mut second, json!({})).await;
        respond_to_call(&mut second, json!({})).await;
        respond_to_call(&mut second, json!({})).await;
        respond_to_call(
            &mut second,
            json!({
                "result": {
                    "value": {
                        "href": "https://www.xiaohongshu.com/explore",
                        "readyState": "complete",
                        "feedCardCount": 6,
                        "noteDetailCount": 0,
                        "loginWallCount": 0,
                        "captchaSignalCount": 0,
                        "dialogCount": 0,
                        "profileSignalCount": 0,
                        "mainCount": 1
                    }
                }
            }),
        )
        .await;
        let _ = second.close(None).await;
    });
    (port, server)
}

async fn serve_target_listing(listener: &TcpListener, port: u16) {
    serve_target_listing_for(listener, port, "https://www.xiaohongshu.com/explore").await;
}

/// 假浏览器自报实例标识（CDP `GET /json/version`）。
async fn serve_browser_version(listener: &TcpListener, port: u16, browser_id: &str) {
    let (mut http, _) = listener.accept().await.expect("HTTP version request");
    let mut request = [0_u8; 2048];
    let _ = http.read(&mut request).await.expect("read version request");
    let body = json!({
        "Browser": "Chrome/126.0.0.0",
        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/browser/{browser_id}")
    })
    .to_string();
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    http.write_all(headers.as_bytes()).await.expect("headers");
    http.write_all(body.as_bytes()).await.expect("body");
    http.shutdown().await.expect("HTTP shutdown");
}

async fn serve_target_listing_for(listener: &TcpListener, port: u16, url: &str) {
    let (mut http, _) = listener.accept().await.expect("HTTP target request");
    let mut request = [0_u8; 2048];
    let _ = http.read(&mut request).await.expect("read target request");
    let body = json!([{
        "id": "target-1",
        "type": "page",
        "url": url,
        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/target-1")
    }])
    .to_string();
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    http.write_all(headers.as_bytes()).await.expect("headers");
    http.write_all(body.as_bytes()).await.expect("body");
    http.shutdown().await.expect("HTTP shutdown");
}

async fn respond_to_call_record<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
    result: Value,
) -> String
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let message = websocket
        .next()
        .await
        .expect("CDP request")
        .expect("valid CDP request");
    let Message::Text(text) = message else {
        panic!("expected text request");
    };
    let request: Value = serde_json::from_str(&text).expect("request JSON");
    let id = request["id"].as_u64().expect("request id");
    websocket
        .send(Message::Text(
            json!({"id":id,"result":result}).to_string().into(),
        ))
        .await
        .expect("CDP response");
    request["method"].as_str().unwrap_or_default().to_owned()
}

async fn respond_to_call_capture<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
    result: Value,
) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let message = websocket
        .next()
        .await
        .expect("CDP request")
        .expect("valid CDP request");
    let Message::Text(text) = message else {
        panic!("expected text request");
    };
    let request: Value = serde_json::from_str(&text).expect("request JSON");
    let id = request["id"].as_u64().expect("request id");
    websocket
        .send(Message::Text(
            json!({"id":id,"result":result}).to_string().into(),
        ))
        .await
        .expect("CDP response");
    request
}

async fn reject_call_capture<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
    code: i64,
    message: &str,
) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let request_message = websocket
        .next()
        .await
        .expect("CDP request")
        .expect("valid CDP request");
    let Message::Text(text) = request_message else {
        panic!("expected text request");
    };
    let request: Value = serde_json::from_str(&text).expect("request JSON");
    let id = request["id"].as_u64().expect("request id");
    websocket
        .send(Message::Text(
            json!({"id":id,"error":{"code":code,"message":message}})
                .to_string()
                .into(),
        ))
        .await
        .expect("CDP error response");
    request
}

async fn respond_to_call<S>(websocket: &mut tokio_tungstenite::WebSocketStream<S>, result: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let message = websocket
        .next()
        .await
        .expect("CDP request")
        .expect("valid CDP request");
    let Message::Text(text) = message else {
        panic!("expected text request");
    };
    let request: Value = serde_json::from_str(&text).expect("request JSON");
    let id = request["id"].as_u64().expect("request id");
    websocket
        .send(Message::Text(
            json!({"id":id,"result":result}).to_string().into(),
        ))
        .await
        .expect("CDP response");
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// feed 面就地读报环境变化 → **本层**负责回落详情导航重读，且回落读到的必须是被请求的那条帖子。
/// 反例（本 change 前的行为）：脚本读不可信也照样把读数当成功回上去。
#[tokio::test]
async fn facebook_inline_context_change_falls_back_to_detail_navigation() {
    let target = "https://www.facebook.com/groups/100/posts/2579243155868042";
    let (port, server) = spawn_facebook_inline_context_change_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 20_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_inline_note_open_command(1, target, 20_000))
        .await
        .expect("detail fallback");
    let CommandOutput::NoteDetail(detail) = outcome.output.expect("fallback detail output") else {
        panic!("expected note detail after inline context change")
    };
    assert_eq!(detail.note_id, target);

    engine.shutdown().await;
    let requests = server.await.expect("Facebook inline fallback fake CDP");
    assert!(
        requests
            .iter()
            .any(|request| request["method"] == "Page.navigate"),
        "context_changed must navigate to the post instead of trusting the in-place read"
    );
    assert_eq!(
        router_call_count(&requests, "note_open"),
        2,
        "one in-place attempt plus one detail re-read"
    );
}

fn facebook_inline_note_open_command(
    command_id: u64,
    note_id: &str,
    timeout_ms: u64,
) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("facebook-inline-open-{command_id}"),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + timeout_ms,
        command: NativeCommand::NoteOpen(NoteOpenParams {
            index: None,
            note_id: Some(note_id.to_owned()),
            url: None,
            reason: None,
            surface: Some(NoteSurface::Feed),
            purpose: Some(NotePurpose::Read),
            think_ms: None,
            selection: None,
            container: None,
        }),
    }
}

async fn spawn_facebook_inline_context_change_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(
            &listener,
            port,
            "https://www.facebook.com/groups/100/posts/2579243155868042",
        )
        .await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut opens = 0_u32;
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let result = match router_kind(&request).as_deref() {
                Some("page_probe") => facebook_ready_cdp("/groups/100/posts/2579243155868042"),
                Some("consent_probe") => facebook_consent_absent_cdp(),
                Some("note_open") => {
                    opens += 1;
                    if opens == 1 {
                        json!({"result":{"value":{
                            "effectPhase":"not_started",
                            "output":{"kind":"action_receipt","value":{
                                "action":"open_note","ok":false,"reason":"context_changed"
                            }}
                        }}})
                    } else {
                        facebook_note_detail_cdp(
                            "https://www.facebook.com/groups/100/posts/2579243155868042",
                            "requested post",
                        )
                    }
                }
                _ => json!({}),
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

/// 身份采集夹具：首屏「有物理卡但零地址」，一次可信指针移动之后才出现带地址的卡。
/// 复刻 2026-07-29 越南语首页实测到的形态。
fn facebook_identity_probe_cdp(acquired: bool, moved: bool) -> Value {
    router_cdp(
        "feed_probe",
        json!({
            "cards": if acquired {
                json!([{
                    "index": 0,
                    "title": "Acquired",
                    "likeCount": 0,
                    "collectCount": 0,
                    "noteId": "https://www.facebook.com/Alice/posts/pfbidACQUIRED"
                }])
            } else {
                json!([])
            },
            "documentGeneration": "home-generation",
            "listKind": "feed",
            "listState": if acquired { "ready" } else { "present_unreportable" },
            "loading": false,
            "articleCount": 1,
            "explicitEmpty": false,
            "explicitEnd": false,
            "url": "https://www.facebook.com/",
            "surface": "home",
            "scrollY": if moved { 1300 } else { 650 },
            "innerWidth": 1440,
            "innerHeight": 800,
            "scrollHeight": 2400,
            "scrollViewportHeight": 800,
            "documentTimeOriginMs": 1780000000000_u64,
            "documentAgeMs": 2000
        }),
    )
}

fn facebook_identity_candidates_cdp(acquired: bool) -> Value {
    router_cdp(
        "identity_candidates",
        json!({
            "candidates": if acquired {
                json!([])
            } else {
                json!([{ "cardIndex": 0, "x": 512.0, "y": 240.0 }])
            },
            "cardCount": 1,
            "resolvedCount": if acquired { 1 } else { 0 }
        }),
    )
}

async fn spawn_facebook_identity_acquisition_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, "https://www.facebook.com/").await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut hovered = false;
        let mut wheel_gestures = 0usize;
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        while let Some(message) = websocket.next().await {
            let Ok(Message::Text(text)) = message else {
                break;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            if request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseMoved"
                && request["params"]["x"] == 512.0
            {
                hovered = true;
            }
            if request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseMoved"
                && request["params"]["x"] == 720.0
            {
                wheel_gestures += 1;
            }
            let result = match router_kind(&request).as_deref() {
                Some("reel_probe") => {
                    router_cdp("reel_probe", json!({"ok": false, "reason": "not_reel"}))
                }
                Some("page_probe") => facebook_feed_page_probe_cdp(),
                Some("consent_probe") => facebook_consent_absent_cdp(),
                Some("feed_probe") => facebook_identity_probe_cdp(hovered, wheel_gestures >= 2),
                Some("identity_candidates") => facebook_identity_candidates_cdp(hovered),
                Some("feed_recovery_target") => router_cdp(
                    "point_target",
                    json!({ "ok": false, "reason": "no_prompt" }),
                ),
                _ => json!({}),
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

#[tokio::test]
async fn facebook_identity_acquisition_hovers_without_ever_pressing() {
    let (port, server) = spawn_facebook_identity_acquisition_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    // 命令原子预算 = min(会话 timeout_ms, 命令种类上限)，而 session_open 的默认 timeout_ms 只有 2s。
    open.params.timeout_ms = 90_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "identity-acquire-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 30_000,
            command: NativeCommand::PageScroll(PageScrollParams {
                reason: Some("feed_scroll".to_owned()),
                surface: None,
                dwell_ms: None,
            }),
        })
        .await
        .expect("Feed scroll");

    let CommandOutput::PageCards(cards) = outcome.output.expect("Feed cards") else {
        panic!("expected Feed cards after identity acquisition")
    };
    assert_eq!(
        cards.cards[0].note_id.as_deref(),
        Some("https://www.facebook.com/Alice/posts/pfbidACQUIRED"),
        "acquisition must turn an address-less card into a reportable one"
    );

    engine.shutdown().await;
    let requests = server.await.expect("identity acquisition fake CDP");
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "Page.bringToFront")
            .count(),
        1,
        "identity acquisition is not movement, so the stalled wheel must recover once"
    );
    assert!(
        requests.iter().any(|request| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseMoved"
                && request["params"]["x"] == 512.0
                && request["params"]["y"] == 240.0
        }),
        "acquisition must move the trusted pointer onto the candidate"
    );
    // 红线：采集只移动，绝不按下。按下会打开帖子或触发控件，那是平台可见的写操作。
    assert!(
        requests.iter().all(|request| {
            request["method"] != "Input.dispatchMouseEvent"
                || (request["params"]["type"] != "mousePressed"
                    && request["params"]["type"] != "mouseReleased")
        }),
        "acquisition must never press or release the pointer"
    );
}
