use aidcp_page_engine::command::{
    CaptchaCaptureParams, CaptchaClickParams, CaptchaPoint, CommentParams, FollowParams,
    GroupJoinParams, IdentityCaptureParams, NoteInteractionParams, NoteOpenParams,
    NoteOpenSelection, NotePurpose, NoteSurface, PageScrollParams, ReasonParams,
    SearchExecuteParams,
};
use aidcp_page_engine::commit_window::CommitWindowRequester;
use aidcp_page_engine::engine::{CommandOutput, Engine};
use aidcp_page_engine::error::{CdpExceptionClass, CdpExceptionReason, ErrorCode};
use aidcp_page_engine::model::FacebookListKind;
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
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&browse_command(1))
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
async fn facebook_feed_recovery_uses_one_trusted_cdp_click_before_returning_cards() {
    let (port, server) = spawn_facebook_feed_recovery_cdp(true).await;
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
    assert_pointer_commit_near(&requests, 540.0, 330.0);
}

#[tokio::test]
async fn facebook_watchdog_feed_recovery_foregrounds_once_without_duplicate_activation() {
    let (port, server) = spawn_facebook_feed_recovery_cdp(true).await;
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
    assert_pointer_commit_near(&requests, 540.0, 330.0);
}

#[tokio::test]
async fn facebook_feed_recovery_click_without_home_postcondition_is_ambiguous() {
    let (port, server) = spawn_facebook_feed_recovery_cdp(false).await;
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
}

#[tokio::test]
async fn facebook_watchdog_reel_scroll_foregrounds_once_before_trusted_arrow() {
    let (port, server) = spawn_facebook_reel_arrow_cdp().await;
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
    assert_eq!(input_requests[0]["params"]["key"], "ArrowDown");
    assert_eq!(input_requests[1]["params"]["type"], "keyUp");
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Input.dispatchMouseEvent")
    );
}

#[tokio::test]
async fn facebook_anonymous_reel_scroll_uses_horizontal_arrow_and_requires_canonical_next_identity()
{
    let (port, server) = spawn_facebook_reel_anonymous_horizontal_cdp().await;
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
                dwell_ms: None,
            }),
        })
        .await
        .expect("anonymous horizontal Reel scroll");

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
    let requests = server.await.expect("anonymous horizontal Reel fake CDP");
    let input_requests = requests
        .iter()
        .filter(|request| request["method"] == "Input.dispatchKeyEvent")
        .collect::<Vec<_>>();
    assert_eq!(input_requests.len(), 2);
    assert_eq!(input_requests[0]["params"]["key"], "ArrowRight");
    assert_eq!(input_requests[0]["params"]["windowsVirtualKeyCode"], 39);
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
async fn facebook_reel_scroll_uses_one_active_video_wheel_after_unchanged_arrow() {
    let (port, server) = spawn_facebook_reel_wheel_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    // 两个上限都要抬：只抬下面那条命令死线是空操作，实际预算被会话的默认 2s 卡死。见常量注释。
    open.params.timeout_ms = HUMANIZED_GESTURE_SESSION_TIMEOUT_MS;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "reel-scroll-wheel-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + HUMANIZED_GESTURE_DEADLINE_MS,
            command: NativeCommand::PageScroll(PageScrollParams {
                reason: Some("feed_scroll".to_owned()),
                dwell_ms: None,
            }),
        })
        .await
        .expect("Reel wheel fallback");
    let CommandOutput::PageCards(cards) = outcome.output.expect("Reel cards") else {
        panic!("expected Reel cards")
    };
    assert_eq!(
        cards.cards[0].note_id.as_deref(),
        Some("https://www.facebook.com/reel/2")
    );

    engine.shutdown().await;
    let requests = server.await.expect("Facebook Reel wheel fake CDP");
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Page.bringToFront"),
        "routine Reels wheel fallback must remain in the background"
    );
    let wheel_requests = requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseWheel"
        })
        .collect::<Vec<_>>();
    // 兜底滚轮走共享惯性手势：8~15 帧、滚前先把光标移到可滚区中心、总位移在基线 ±20% 内。
    // 单帧精确位移与「墙钟毫秒取模」的伪随机都不再允许。
    assert!((8..=15).contains(&wheel_requests.len()));
    assert!(
        wheel_requests
            .iter()
            .all(|request| { request["params"]["x"] == 590.0 && request["params"]["y"] == 420.0 })
    );
    let total: f64 = wheel_requests
        .iter()
        .map(|request| request["params"]["deltaY"].as_f64().expect("wheel delta"))
        .sum();
    assert!(
        (68.0..=102.0).contains(&total),
        "总位移 {total} 越出基线 ±20%"
    );
    let first_wheel = requests
        .iter()
        .position(|request| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseWheel"
        })
        .expect("wheel frame");
    let first_move = requests
        .iter()
        .position(|request| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseMoved"
        })
        .expect("pointer move before the wheel");
    assert!(first_move < first_wheel);
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
async fn facebook_reel_scroll_without_active_video_does_not_foreground_or_dispatch() {
    let (port, server) = spawn_facebook_reel_missing_active_video_cdp().await;
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
                dwell_ms: None,
            }),
        })
        .await
        .expect("Reel scroll without active video");

    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("scroll receipt") else {
        panic!("expected scroll action receipt")
    };
    assert_eq!(receipt.reason.as_deref(), Some("no_target"));

    engine.shutdown().await;
    let requests = server
        .await
        .expect("Facebook missing active video fake CDP");
    assert!(requests.iter().all(|request| {
        request["method"] != "Page.bringToFront"
            && !request["method"]
                .as_str()
                .is_some_and(|method| method.starts_with("Input."))
    }));
}

#[tokio::test]
async fn facebook_reel_scroll_returns_ambiguous_after_dispatched_methods_without_fabricated_cards()
{
    let (port, server) = spawn_facebook_reel_no_target_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 8_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "reel-scroll-no-target-1".to_owned(),
            session_id: "session-1".to_owned(),
            task_id: "browse-1".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 8_000,
            command: NativeCommand::PageScroll(PageScrollParams {
                reason: Some("feed_scroll".to_owned()),
                dwell_ms: None,
            }),
        })
        .await
        .expect("Reel no-target terminal");

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

    engine.shutdown().await;
    let requests = server.await.expect("Facebook Reel no-target fake CDP");
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
    // 兜底滚轮已是多帧惯性手势，帧数按分布采样；可断言的是「确实滚了一次手势」而非帧数常量。
    assert!(
        (8..=15).contains(
            &requests
                .iter()
                .filter(|request| {
                    request["method"] == "Input.dispatchMouseEvent"
                        && request["params"]["type"] == "mouseWheel"
                })
                .count()
        )
    );
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
    LikePicker,
    FollowMovedBeforeDispatch,
    FollowConfirmed,
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
                Some("like_verify") => router_cdp(
                    "like_verify",
                    json!({
                        "ok": true,
                        "noteId": "https://www.facebook.com/reel/1",
                        "selected": matches!(scenario, FacebookInteractionScenario::LikeDirect)
                            || picker_committed,
                        "witness": if matches!(scenario, FacebookInteractionScenario::LikeDirect)
                            || picker_committed
                        {
                            Some("aria_pressed")
                        } else {
                            None
                        }
                    }),
                ),
                Some("like_picker_probe") => router_cdp(
                    "point_target",
                    json!({"ok": true, "cx": 955.0, "cy": 485.0}),
                ),
                Some("follow_probe") => {
                    follow_probes += 1;
                    let author = if matches!(
                        scenario,
                        FacebookInteractionScenario::FollowMovedBeforeDispatch
                    ) && follow_probes == 2
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
                            "videoKey": "video-1@element:1",
                            "author": author,
                            "already": matches!(
                                scenario,
                                FacebookInteractionScenario::FollowConfirmed
                            ) && follow_probes >= 3,
                            "cx": 730.0,
                            "cy": 670.0
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
        for _ in 0..2 {
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
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, "https://www.facebook.com/").await;
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

async fn spawn_facebook_feed_recovery_cdp(
    confirm_home: bool,
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
                    facebook_feed_recovery_probe_cdp(!clicked, clicked && confirm_home)
                }
                Some("feed_recovery_target") => router_cdp(
                    "point_target",
                    json!({
                        "ok": true,
                        "cx": 540.0,
                        "cy": 330.0
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

fn facebook_feed_recovery_probe_cdp(prompt: bool, confirmed_home: bool) -> Value {
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
                    "cx": 540.0,
                    "cy": 330.0
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
                Some("feed_refresh") => router_cdp(
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
                    let selection_reason = (scrolls == 3).then_some("target_context_mismatch");
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

async fn spawn_facebook_reel_arrow_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, "https://www.facebook.com/reel/1").await;
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
                reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1"),
            )
            .await,
        );
        requests.push(
            respond_to_call_capture(
                &mut websocket,
                reel_next_target_cdp(
                    "https://www.facebook.com/reel/1",
                    "video-1@element:1",
                    "vertical",
                    true,
                ),
            )
            .await,
        );
        requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        requests.push(
            respond_to_call_capture(
                &mut websocket,
                reel_probe_cdp("https://www.facebook.com/reel/2", "video-2@element:2"),
            )
            .await,
        );
        requests.push(
            respond_to_call_capture(
                &mut websocket,
                reel_cards_cdp("https://www.facebook.com/reel/2"),
            )
            .await,
        );
        let _ = websocket.close(None).await;
        requests
    });
    (port, server)
}

async fn spawn_facebook_reel_anonymous_horizontal_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>)
{
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, "https://www.facebook.com/reel/").await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        requests.push(
            respond_to_call_capture(
                &mut websocket,
                anonymous_reel_probe_cdp("video-1@element:1"),
            )
            .await,
        );
        requests.push(
            respond_to_call_capture(
                &mut websocket,
                anonymous_reel_next_target_cdp("video-1@element:1", "horizontal"),
            )
            .await,
        );
        requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        requests.push(
            respond_to_call_capture(
                &mut websocket,
                reel_probe_cdp("https://www.facebook.com/reel/2", "video-2@element:2"),
            )
            .await,
        );
        requests.push(
            respond_to_call_capture(
                &mut websocket,
                reel_cards_cdp("https://www.facebook.com/reel/2"),
            )
            .await,
        );
        let _ = websocket.close(None).await;
        requests
    });
    (port, server)
}

async fn spawn_facebook_reel_wheel_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, "https://www.facebook.com/reel/1").await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        for _ in 0..3 {
            requests.extend(respond_to_call_capture_all(&mut websocket, json!({})).await);
        }
        requests.extend(
            respond_to_call_capture_all(
                &mut websocket,
                reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1"),
            )
            .await,
        );
        requests.extend(
            respond_to_call_capture_all(
                &mut websocket,
                reel_next_target_cdp(
                    "https://www.facebook.com/reel/1",
                    "video-1@element:1",
                    "vertical",
                    true,
                ),
            )
            .await,
        );
        requests.extend(respond_to_call_capture_all(&mut websocket, json!({})).await);
        requests.extend(respond_to_call_capture_all(&mut websocket, json!({})).await);
        for _ in 0..6 {
            requests.extend(
                respond_to_call_capture_all(
                    &mut websocket,
                    reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1"),
                )
                .await,
            );
        }
        requests.extend(
            respond_to_call_capture_all(
                &mut websocket,
                reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1"),
            )
            .await,
        );
        // 兜底滚轮已改为多帧惯性手势，其帧数不固定：滚轮事件由上面的应答器透明放行，
        // 脚本这里不再为「单帧滚轮」预留一格。
        requests.extend(
            respond_to_call_capture_all(
                &mut websocket,
                reel_probe_cdp("https://www.facebook.com/reel/2", "video-2@element:2"),
            )
            .await,
        );
        requests.extend(
            respond_to_call_capture_all(
                &mut websocket,
                reel_cards_cdp("https://www.facebook.com/reel/2"),
            )
            .await,
        );
        let _ = websocket.close(None).await;
        requests
    });
    (port, server)
}

async fn spawn_facebook_reel_missing_active_video_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>)
{
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, "https://www.facebook.com/reel/1").await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        for _ in 0..3 {
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        requests.push(
            respond_to_call_capture(
                &mut websocket,
                router_cdp("reel_probe", json!({"ok": false, "reason": "no_target"})),
            )
            .await,
        );
        let _ = websocket.close(None).await;
        requests
    });
    (port, server)
}

async fn spawn_facebook_reel_no_target_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing_for(&listener, port, "https://www.facebook.com/reel/1").await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        for _ in 0..3 {
            requests.extend(respond_to_call_capture_all(&mut websocket, json!({})).await);
        }
        requests.extend(
            respond_to_call_capture_all(
                &mut websocket,
                reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1"),
            )
            .await,
        );
        requests.extend(
            respond_to_call_capture_all(
                &mut websocket,
                reel_next_target_cdp(
                    "https://www.facebook.com/reel/1",
                    "video-1@element:1",
                    "vertical",
                    true,
                ),
            )
            .await,
        );
        requests.extend(respond_to_call_capture_all(&mut websocket, json!({})).await);
        requests.extend(respond_to_call_capture_all(&mut websocket, json!({})).await);
        for _ in 0..6 {
            requests.extend(
                respond_to_call_capture_all(
                    &mut websocket,
                    reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1"),
                )
                .await,
            );
        }
        requests.extend(
            respond_to_call_capture_all(
                &mut websocket,
                reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1"),
            )
            .await,
        );
        // 同上：多帧惯性手势的滚轮事件透明放行，脚本不再为单帧滚轮预留一格。
        for _ in 0..6 {
            requests.extend(
                respond_to_call_capture_all(
                    &mut websocket,
                    reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1"),
                )
                .await,
            );
        }
        requests.extend(
            respond_to_call_capture_all(
                &mut websocket,
                reel_next_target_cdp(
                    "https://www.facebook.com/reel/1",
                    "video-1@element:1",
                    "vertical",
                    false,
                ),
            )
            .await,
        );
        let _ = websocket.close(None).await;
        requests
    });
    (port, server)
}

fn reel_probe_cdp(note_id: &str, video_key: &str) -> Value {
    json!({"result":{"value":router_result(
        "reel_probe",
        json!({
            "ok": true,
            "noteId": note_id,
            "videoKey": video_key,
            "videoRect": {"left": 200.0, "top": 80.0, "right": 980.0, "bottom": 760.0}
        })
    )}})
}

fn anonymous_reel_probe_cdp(video_key: &str) -> Value {
    json!({"result":{"value":router_result(
        "reel_probe",
        json!({
            "ok": true,
            "videoKey": video_key,
            "videoRect": {"left": 200.0, "top": 80.0, "right": 980.0, "bottom": 760.0}
        })
    )}})
}

fn anonymous_reel_next_target_cdp(video_key: &str, axis: &str) -> Value {
    json!({"result":{"value":router_result(
        "reel_next_target",
        json!({
            "ok": true,
            "videoKey": video_key,
            "videoRect": {"left": 200.0, "top": 80.0, "right": 980.0, "bottom": 760.0},
            "found": true,
            "ambiguous": false,
            "axis": axis,
            "cx": 1_230.0,
            "cy": 400.0
        })
    )}})
}

fn reel_next_target_cdp(note_id: &str, video_key: &str, axis: &str, found: bool) -> Value {
    json!({"result":{"value":router_result(
        "reel_next_target",
        json!({
            "ok": true,
            "noteId": note_id,
            "videoKey": video_key,
            "videoRect": {"left": 200.0, "top": 80.0, "right": 980.0, "bottom": 760.0},
            "found": found,
            "ambiguous": false,
            "axis": axis,
            "cx": found.then_some(1_230.0),
            "cy": found.then_some(400.0)
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

/// 应答一条脚本化的 CDP 请求；沿途出现的指针 / 滚轮事件先就地应答并一并记录。
///
/// 拟人化输入是**多帧**的（轨迹帧数、滚轮帧数都按分布采样），一问一答的脚本对不上号——
/// 这里让输入事件透明通过并保留在记录里，脚本只对下一条非输入请求生效。
async fn respond_to_call_capture_all<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
    result: Value,
) -> Vec<Value>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut captured = Vec::new();
    loop {
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
        let pointer_frame = request["method"] == "Input.dispatchMouseEvent";
        let payload = if pointer_frame {
            json!({})
        } else {
            result.clone()
        };
        websocket
            .send(Message::Text(
                json!({"id":id,"result":payload}).to_string().into(),
            ))
            .await
            .expect("CDP response");
        captured.push(request);
        if !pointer_frame {
            return captured;
        }
    }
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

/// 拟人手势类用例的墙钟预算。
///
/// 这些用例断言的是**手势形状**（帧数 / 落点坐标 / 总位移），墙钟死线在其中只是「别跑成死循环」的
/// 兜底，不承载任何被断言的语义。而 cargo 会并行跑 14 个测试二进制，负载一上来，同一段带停顿的手势
/// 真实耗时会被拉长数倍。把兜底值定在手势自身的量级，门禁就变成掷骰子。
///
/// ── 上一轮在这里犯的错，必须写下来 ──
/// 上一轮只把命令死线从 8s 抬到本常量，就宣布「修好了」。**那个改动完全没有生效**：真正的预算是
/// `engine.rs::remaining_budget` 算出来的
///     `min(deadline - now, min(session.timeout_ms, 该命令的 ceiling))`
/// 而 `session_open()` 的 `timeout_ms` 默认是 **2_000**。也就是说无论死线写多大，实际budget 恒为 2 秒——
/// 抬死线是一次**空操作**。之所以当时看着像修好了，只是因为验证量太小、又恰好没抽到。
/// 本轮独立目录连跑 14 次全量，这条仍红 2 次（≈14%），失败在 `outcome.output.expect("Reel cards")`：
/// 命令被外层看门狗掐掉、`output` 为 `None`。
///
/// 结论（用这条常量时必须同时做的事）：**两个上限都要抬，只抬一个等于没抬。**
///   ① 命令死线 `deadline_unix_ms` ← 本常量；
///   ② 会话 `open.params.timeout_ms`（默认 2s，Facebook 上限 90s、其他平台 30s，见 protocol.rs）。
/// 断言不会因此变松——形状断言不看时间。真要覆盖「超时会怎样」，请显式写一个小死线 + 小会话预算，
/// 别指望这些形状用例顺手覆盖到。
const HUMANIZED_GESTURE_DEADLINE_MS: u64 = 120_000;

/// 与上面配套的会话预算：Facebook 会话允许的最大值（`protocol.rs::MAX_FACEBOOK_TIMEOUT_MS`）。
/// 单独抬 `HUMANIZED_GESTURE_DEADLINE_MS` 不生效，见那条常量的注释。
const HUMANIZED_GESTURE_SESSION_TIMEOUT_MS: u64 = 90_000;

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
fn facebook_identity_probe_cdp(acquired: bool) -> Value {
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
            "scrollY": 650,
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
            let result = match router_kind(&request).as_deref() {
                Some("reel_probe") => {
                    router_cdp("reel_probe", json!({"ok": false, "reason": "not_reel"}))
                }
                Some("page_probe") => facebook_feed_page_probe_cdp(),
                Some("consent_probe") => facebook_consent_absent_cdp(),
                Some("feed_probe") => facebook_identity_probe_cdp(hovered),
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
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Page.bringToFront"),
        "routine identity-acquisition scroll must remain in the background"
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
