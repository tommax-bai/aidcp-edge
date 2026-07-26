use aidcp_page_engine::command::{
    FollowParams, GroupJoinParams, IdentityCaptureParams, NoteInteractionParams, NoteOpenParams,
    PageScrollParams, ReasonParams,
};
use aidcp_page_engine::engine::{CommandOutput, Engine};
use aidcp_page_engine::error::ErrorCode;
use aidcp_page_engine::model::FacebookListKind;
use aidcp_page_engine::protocol::{
    CommandRecord, EffectPhase, NativeCommand, PageProbeParams, Platform, SessionCloseRecord,
    SessionOpenParams, SessionOpenRecord,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
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
async fn facebook_reel_scroll_uses_trusted_arrow_and_requires_identity_movement() {
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
                reason: Some("feed_scroll".to_owned()),
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
async fn facebook_reel_scroll_uses_one_active_video_wheel_after_unchanged_arrow() {
    let (port, server) = spawn_facebook_reel_wheel_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "reel-scroll-wheel-1".to_owned(),
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
    let wheel_requests = requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseWheel"
        })
        .collect::<Vec<_>>();
    assert_eq!(wheel_requests.len(), 1);
    assert_eq!(wheel_requests[0]["params"]["x"], 590.0);
    assert_eq!(wheel_requests[0]["params"]["y"], 420.0);
    let delta = wheel_requests[0]["params"]["deltaY"]
        .as_f64()
        .expect("wheel delta");
    assert!((70.0..=100.0).contains(&delta));
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
async fn facebook_reel_scroll_returns_no_target_without_fabricated_cards() {
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

    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("scroll receipt") else {
        panic!("expected scroll action receipt")
    };
    assert_eq!(receipt.action, "scroll");
    assert!(!receipt.ok);
    assert_eq!(receipt.reason.as_deref(), Some("no_target"));

    engine.shutdown().await;
    let requests = server.await.expect("Facebook Reel no-target fake CDP");
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Page.navigate")
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| {
                request["method"] == "Input.dispatchMouseEvent"
                    && request["params"]["type"] == "mouseWheel"
            })
            .count(),
        1
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
    assert_eq!(mouse_dispatch_count(&requests), 3);
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
    assert_eq!(mouse_dispatch_count(&requests), 3);
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
    open.params.timeout_ms = 20_000;
    engine.open(&open).await.expect("open Facebook session");

    let outcome = engine
        .execute(&facebook_note_open_command(
            1,
            "https://www.facebook.com/groups/100/posts/2579243155868042",
            20_000,
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
        "note_open",
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

fn router_call_count(requests: &[Value], kind: &str) -> usize {
    requests
        .iter()
        .filter(|request| router_kind(request).as_deref() == Some(kind))
        .count()
}

fn mouse_dispatch_count(requests: &[Value]) -> usize {
    requests
        .iter()
        .filter(|request| request["method"] == "Input.dispatchMouseEvent")
        .count()
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
                        "url": "https://www.facebook.com/",
                        "surface": "home",
                        "scrollY": 0,
                        "innerWidth": 1440,
                        "innerHeight": 800,
                        "scrollHeight": 1600,
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
        requests.push(
            respond_to_call_capture(
                &mut websocket,
                reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1"),
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
            requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        }
        requests.push(
            respond_to_call_capture(
                &mut websocket,
                reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1"),
            )
            .await,
        );
        requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        for _ in 0..6 {
            requests.push(
                respond_to_call_capture(
                    &mut websocket,
                    reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1"),
                )
                .await,
            );
        }
        requests.push(
            respond_to_call_capture(
                &mut websocket,
                reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1"),
            )
            .await,
        );
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

async fn spawn_facebook_reel_no_target_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
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
                reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1"),
            )
            .await,
        );
        requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        for _ in 0..6 {
            requests.push(
                respond_to_call_capture(
                    &mut websocket,
                    reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1"),
                )
                .await,
            );
        }
        requests.push(
            respond_to_call_capture(
                &mut websocket,
                reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1"),
            )
            .await,
        );
        requests.push(respond_to_call_capture(&mut websocket, json!({})).await);
        for _ in 0..6 {
            requests.push(
                respond_to_call_capture(
                    &mut websocket,
                    reel_probe_cdp("https://www.facebook.com/reel/1", "video-1@element:1"),
                )
                .await,
            );
        }
        requests.push(
            respond_to_call_capture(
                &mut websocket,
                json!({"result":{"value":router_result(
                    "reel_next_target",
                    json!({
                        "ok": true,
                        "noteId": "https://www.facebook.com/reel/1",
                        "videoKey": "video-1@element:1",
                        "videoRect": {"left": 200.0, "top": 80.0, "right": 980.0, "bottom": 760.0},
                        "found": false,
                        "ambiguous": false
                    })
                )}}),
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
