use aidcp_page_engine::command::{
    FacebookAuthProbeParams, FacebookAuthSignalParams, FacebookAuthTotpEntryParams,
    FacebookAuthTotpWindowParams,
};
use aidcp_page_engine::engine::{CommandOutput, Engine, StoredCommandResult};
use aidcp_page_engine::protocol::{
    CommandRecord, EffectPhase, NativeCommand, Platform, SessionOpenParams, SessionOpenRecord,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn manual_login_probe_preserves_the_structured_reason_without_input() {
    let observations = VecDeque::from([blocked_observation(
        "manual_login_required",
        "credential_fill_unavailable",
    )]);
    let (port, server) = spawn_auth_cdp(observations, VecDeque::new()).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open Facebook manual login session");

    let outcome = execute(
        &mut engine,
        1,
        NativeCommand::FacebookAuthProbe(FacebookAuthProbeParams::default()),
    )
    .await;
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::FacebookAuthProbe(receipt) = outcome.output.expect("probe receipt") else {
        panic!("expected Facebook auth probe receipt")
    };
    assert_eq!(
        receipt.signal,
        aidcp_page_engine::model::FacebookAuthSignal::ManualLoginRequired
    );
    assert_eq!(
        receipt.reason.as_deref(),
        Some("credential_fill_unavailable")
    );

    engine.shutdown().await;
    let requests = server.await.expect("Facebook manual login fake CDP");
    assert!(requests.iter().all(|request| {
        !request["method"]
            .as_str()
            .is_some_and(|method| method.starts_with("Input."))
    }));
}

#[tokio::test]
async fn suspension_appeal_fresh_revalidation_clicks_once_confirms_successor_and_refuses_replay() {
    let signal = signal_id('f');
    let observations = VecDeque::from([actionable_observation("suspension_appeal_start", &signal)]);
    let (port, server) = spawn_auth_cdp(observations, VecDeque::new()).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open Facebook suspension appeal session");

    let confirmed = execute(
        &mut engine,
        1,
        NativeCommand::FacebookAuthStartSuspensionAppeal(FacebookAuthSignalParams {
            signal_id: signal.clone(),
        }),
    )
    .await;
    assert_confirmed(&confirmed, "facebook_auth_start_suspension_appeal");

    let replay = execute(
        &mut engine,
        2,
        NativeCommand::FacebookAuthStartSuspensionAppeal(FacebookAuthSignalParams {
            signal_id: signal,
        }),
    )
    .await;
    assert_refused(&replay, "auth_signal_already_consumed");

    engine.shutdown().await;
    let requests = server.await.expect("Facebook suspension appeal fake CDP");
    assert_eq!(count_auth_probes(&requests), 1);
    assert_eq!(count_mouse_pressed(&requests), 1);
    assert!(requests.iter().any(|request| {
        request["params"]["expression"]
            .as_str()
            .is_some_and(|expression| {
                expression.contains(r#""kind":"auth_postcondition""#)
                    && expression.contains(r#""expectedSignal":"suspension_appeal_start""#)
            })
    }));
    assert_action_probes_allow_auth_actions(&requests);
}

#[tokio::test]
async fn refused_auth_signals_dispatch_zero_input_and_a_consumed_signal_is_not_replayed() {
    let stale_requested = signal_id('a');
    let stale_observed = signal_id('b');
    let wrong_signal = signal_id('c');
    let captcha_signal = signal_id('d');
    let ambiguous_signal = signal_id('e');
    let unknown_signal = signal_id('f');
    let valid_signal = signal_id('1');
    let observations = VecDeque::from([
        actionable_observation("login_submit_ready", &stale_observed),
        actionable_observation("login_submit_ready", &wrong_signal),
        blocked_observation("blocked_human_verification", "human_verification_required"),
        blocked_observation("blocked_unknown", "login_form_ambiguous"),
        blocked_observation("blocked_unknown", "unsupported_facebook_auth_state"),
        actionable_observation("login_submit_ready", &valid_signal),
    ]);
    let (port, server) = spawn_auth_cdp(observations, VecDeque::new()).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open Facebook auth session");

    let refused = [
        (
            NativeCommand::FacebookAuthSubmitLogin(FacebookAuthSignalParams {
                signal_id: stale_requested,
            }),
            "stale_auth_signal",
        ),
        (
            NativeCommand::FacebookAuthDismissWarning(FacebookAuthSignalParams {
                signal_id: wrong_signal,
            }),
            "stale_auth_signal",
        ),
        (
            NativeCommand::FacebookAuthSubmitLogin(FacebookAuthSignalParams {
                signal_id: captcha_signal,
            }),
            "stale_auth_signal",
        ),
        (
            NativeCommand::FacebookAuthSubmitLogin(FacebookAuthSignalParams {
                signal_id: ambiguous_signal,
            }),
            "stale_auth_signal",
        ),
        (
            NativeCommand::FacebookAuthSubmitLogin(FacebookAuthSignalParams {
                signal_id: unknown_signal,
            }),
            "stale_auth_signal",
        ),
    ];
    for (index, (command, reason)) in refused.into_iter().enumerate() {
        let outcome = execute(&mut engine, index as u64 + 1, command).await;
        assert_refused(&outcome, reason);
    }

    let first = execute(
        &mut engine,
        6,
        NativeCommand::FacebookAuthSubmitLogin(FacebookAuthSignalParams {
            signal_id: valid_signal.clone(),
        }),
    )
    .await;
    assert_eq!(first.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::FacebookAuthAction(receipt) = first.output.expect("first action receipt")
    else {
        panic!("expected Facebook auth action receipt")
    };
    assert!(receipt.ok);
    assert_eq!(receipt.signal_id, valid_signal);

    let replay = execute(
        &mut engine,
        7,
        NativeCommand::FacebookAuthSubmitLogin(FacebookAuthSignalParams {
            signal_id: valid_signal,
        }),
    )
    .await;
    assert_refused(&replay, "auth_signal_already_consumed");

    engine.shutdown().await;
    let requests = server.await.expect("Facebook auth fake CDP");
    let first_input = requests
        .iter()
        .position(|request| {
            request["method"]
                .as_str()
                .is_some_and(|method| method.starts_with("Input."))
        })
        .expect("the valid action dispatches Native input");
    assert!(
        requests[..first_input]
            .iter()
            .all(|request| !request["method"]
                .as_str()
                .is_some_and(|method| method.starts_with("Input."))),
        "stale, wrong-signal, CAPTCHA, ambiguous, and unknown observations dispatch zero input"
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "Input.dispatchMouseEvent")
            .filter(|request| request["params"]["type"] == "mousePressed")
            .count(),
        1,
        "one signal id can commit at most one click"
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| {
                request["params"]["expression"]
                    .as_str()
                    .is_some_and(|expression| expression.contains(r#""kind":"auth_probe""#))
            })
            .count(),
        6,
        "the replay is rejected from session state before another page probe"
    );
    assert_action_probes_allow_auth_actions(&requests);
}

#[tokio::test]
async fn totp_entry_rejects_short_and_wrong_windows_before_input_then_confirms_readback() {
    const WINDOW_START: u64 = 1_800_000_000_000;
    const WINDOW_END: u64 = WINDOW_START + 30_000;
    let short_signal = signal_id('2');
    let wrong_window_signal = signal_id('3');
    let valid_signal = signal_id('4');
    let observations = VecDeque::from([
        totp_observation(
            "totp_entry_ready",
            &short_signal,
            WINDOW_END - 9_999,
            220.0,
            180.0,
        ),
        totp_observation(
            "totp_entry_ready",
            &wrong_window_signal,
            WINDOW_START + 15_000,
            220.0,
            180.0,
        ),
        totp_observation(
            "totp_entry_ready",
            &valid_signal,
            WINDOW_START + 15_000,
            220.0,
            180.0,
        ),
    ]);
    let readbacks = VecDeque::from([json!({
        "bound": true,
        "empty": false,
        "length": 6,
        "matches": true
    })]);
    let (port, server) = spawn_auth_cdp(observations, readbacks).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open Facebook TOTP entry session");

    let short = execute(
        &mut engine,
        1,
        NativeCommand::FacebookAuthEnterTotp(FacebookAuthTotpEntryParams {
            signal_id: short_signal,
            totp_code: "123456".to_owned(),
            totp_window_start_unix_ms: WINDOW_START,
            totp_window_end_unix_ms: WINDOW_END,
        }),
    )
    .await;
    assert_refused(&short, "totp_window_too_short_or_changed");

    let wrong_window = execute(
        &mut engine,
        2,
        NativeCommand::FacebookAuthEnterTotp(FacebookAuthTotpEntryParams {
            signal_id: wrong_window_signal,
            totp_code: "123456".to_owned(),
            totp_window_start_unix_ms: WINDOW_END,
            totp_window_end_unix_ms: WINDOW_END + 30_000,
        }),
    )
    .await;
    assert_refused(&wrong_window, "totp_window_too_short_or_changed");

    let valid = execute(
        &mut engine,
        3,
        NativeCommand::FacebookAuthEnterTotp(FacebookAuthTotpEntryParams {
            signal_id: valid_signal,
            totp_code: "123456".to_owned(),
            totp_window_start_unix_ms: WINDOW_START,
            totp_window_end_unix_ms: WINDOW_END,
        }),
    )
    .await;
    assert_confirmed(&valid, "facebook_auth_enter_totp");

    engine.shutdown().await;
    let requests = server.await.expect("Facebook TOTP entry fake CDP");
    let first_input = first_input_index(&requests);
    assert_eq!(
        count_auth_probes(&requests[..first_input]),
        3,
        "both invalid windows must finish before the first Native input"
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "Input.insertText")
            .count(),
        1,
        "TOTP entry uses one paste-like Native insertion"
    );
    let insertion = requests
        .iter()
        .find(|request| request["method"] == "Input.insertText")
        .expect("one TOTP insertion");
    assert_eq!(insertion["params"]["text"], "123456");
    assert_eq!(
        requests
            .iter()
            .filter(|request| {
                request["params"]["expression"]
                    .as_str()
                    .is_some_and(|expression| expression.contains(r#""kind":"auth_focus_guard""#))
            })
            .count(),
        1,
        "the paste-like insertion is guarded once before the complete code"
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| {
                request["params"]["expression"]
                    .as_str()
                    .is_some_and(|expression| expression.contains(r#""kind":"auth_totp_readback""#))
            })
            .count(),
        1,
        "entry confirmation requires one bounded readback"
    );
    assert_action_probes_allow_auth_actions(&requests);
}

#[tokio::test]
async fn totp_submit_rejects_a_short_window_then_clicks_once_with_a_bound_postcondition() {
    const WINDOW_START: u64 = 1_800_000_000_000;
    const WINDOW_END: u64 = WINDOW_START + 30_000;
    let short_signal = signal_id('5');
    let valid_signal = signal_id('6');
    let observations = VecDeque::from([
        totp_observation(
            "totp_submit_ready",
            &short_signal,
            WINDOW_END - 9_999,
            420.0,
            360.0,
        ),
        totp_observation(
            "totp_submit_ready",
            &valid_signal,
            WINDOW_START + 15_000,
            420.0,
            360.0,
        ),
    ]);
    let (port, server) = spawn_auth_cdp(observations, VecDeque::new()).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open Facebook TOTP submit session");

    let short = execute(
        &mut engine,
        1,
        NativeCommand::FacebookAuthSubmitTotp(FacebookAuthTotpWindowParams {
            signal_id: short_signal,
            totp_window_start_unix_ms: WINDOW_START,
            totp_window_end_unix_ms: WINDOW_END,
        }),
    )
    .await;
    assert_refused(&short, "totp_window_too_short_or_changed");

    let valid = execute(
        &mut engine,
        2,
        NativeCommand::FacebookAuthSubmitTotp(FacebookAuthTotpWindowParams {
            signal_id: valid_signal,
            totp_window_start_unix_ms: WINDOW_START,
            totp_window_end_unix_ms: WINDOW_END,
        }),
    )
    .await;
    assert_confirmed(&valid, "facebook_auth_submit_totp");

    engine.shutdown().await;
    let requests = server.await.expect("Facebook TOTP submit fake CDP");
    let submit_probe_expressions: Vec<_> = requests
        .iter()
        .filter_map(|request| request["params"]["expression"].as_str())
        .filter(|expression| expression.contains(r#""kind":"auth_probe""#))
        .collect();
    assert_eq!(submit_probe_expressions.len(), 2);
    assert!(
        submit_probe_expressions.iter().all(|expression| {
            expression.contains(&format!(r#""enteredTotpWindowStartUnixMs":{WINDOW_START}"#))
                && expression.contains(&format!(r#""enteredTotpWindowEndUnixMs":{WINDOW_END}"#))
        }),
        "a submit fresh probe must retain its coordinator-owned window"
    );
    let first_input = first_input_index(&requests);
    assert_eq!(
        count_auth_probes(&requests[..first_input]),
        2,
        "the short-window submit must dispatch zero input"
    );
    assert_eq!(
        count_mouse_pressed(&requests),
        1,
        "valid submit clicks once"
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| {
                request["params"]["expression"]
                    .as_str()
                    .is_some_and(|expression| {
                        expression.contains(r#""kind":"auth_postcondition""#)
                            && expression.contains(r#""candidateKey":"#)
                    })
            })
            .count(),
        1,
        "submit confirmation remains bound to the original candidate"
    );
    assert_action_probes_allow_auth_actions(&requests);
}

#[tokio::test]
async fn totp_submit_hydration_waits_without_consuming_the_later_enabled_signal() {
    const WINDOW_START: u64 = 1_800_000_000_000;
    const WINDOW_END: u64 = WINDOW_START + 30_000;
    let signal = signal_id('9');
    let observations = VecDeque::from([
        blocked_observation("none", "totp_submit_hydrating"),
        totp_observation(
            "totp_submit_ready",
            &signal,
            WINDOW_START + 15_000,
            420.0,
            360.0,
        ),
    ]);
    let (port, server) = spawn_auth_cdp(observations, VecDeque::new()).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open Facebook hydrating TOTP submit session");

    let refused = execute(
        &mut engine,
        1,
        NativeCommand::FacebookAuthSubmitTotp(FacebookAuthTotpWindowParams {
            signal_id: signal.clone(),
            totp_window_start_unix_ms: WINDOW_START,
            totp_window_end_unix_ms: WINDOW_END,
        }),
    )
    .await;
    assert_refused(&refused, "stale_auth_signal");

    let confirmed = execute(
        &mut engine,
        2,
        NativeCommand::FacebookAuthSubmitTotp(FacebookAuthTotpWindowParams {
            signal_id: signal,
            totp_window_start_unix_ms: WINDOW_START,
            totp_window_end_unix_ms: WINDOW_END,
        }),
    )
    .await;
    assert_confirmed(&confirmed, "facebook_auth_submit_totp");

    engine.shutdown().await;
    let requests = server.await.expect("Facebook hydrating TOTP fake CDP");
    assert_eq!(count_auth_probes(&requests), 2);
    let first_input = first_input_index(&requests);
    assert_eq!(
        count_auth_probes(&requests[..first_input]),
        2,
        "hydration must dispatch zero input and leave the signal available for one fresh enabled probe"
    );
    assert_eq!(count_mouse_pressed(&requests), 1);
    assert_action_probes_allow_auth_actions(&requests);
}

#[tokio::test]
async fn totp_clear_fresh_probes_a_complete_orphan_without_a_submit_window_and_confirms_empty_readback()
 {
    const WINDOW_START: u64 = 1_800_000_000_000;
    const WINDOW_END: u64 = WINDOW_START + 30_000;
    let clear_signal = signal_id('7');
    let observations = VecDeque::from([complete_orphan_observation(
        &clear_signal,
        WINDOW_END - 1_000,
        220.0,
        180.0,
    )]);
    let readbacks = VecDeque::from([json!({
        "bound": true,
        "empty": true,
        "length": 0,
        "matches": false
    })]);
    let (port, server) = spawn_auth_cdp(observations, readbacks).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open Facebook TOTP clear session");

    let cleared = execute(
        &mut engine,
        1,
        NativeCommand::FacebookAuthClearTotp(FacebookAuthTotpWindowParams {
            signal_id: clear_signal,
            totp_window_start_unix_ms: WINDOW_START,
            totp_window_end_unix_ms: WINDOW_END,
        }),
    )
    .await;
    assert_confirmed(&cleared, "facebook_auth_clear_totp");

    engine.shutdown().await;
    let requests = server.await.expect("Facebook TOTP clear fake CDP");
    let clear_probe = requests
        .iter()
        .filter_map(|request| request["params"]["expression"].as_str())
        .find(|expression| expression.contains(r#""kind":"auth_probe""#))
        .expect("one fresh TOTP clear probe");
    assert!(
        clear_probe.contains(r#""enteredTotpWindowStartUnixMs":null"#)
            && clear_probe.contains(r#""enteredTotpWindowEndUnixMs":null"#),
        "a clear-only fresh probe must not turn a complete orphan into submit-ready evidence"
    );
    assert_eq!(
        count_mouse_pressed(&requests),
        1,
        "clear focuses one exact input"
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| {
                request["method"] == "Input.dispatchKeyEvent" && request["params"]["key"] == "End"
            })
            .count(),
        2,
        "clear brackets End with key down and key up"
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| {
                request["method"] == "Input.dispatchKeyEvent"
                    && request["params"]["key"] == "Backspace"
            })
            .count(),
        24,
        "clear uses twelve bounded Backspace down/up pairs"
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| {
                request["params"]["expression"]
                    .as_str()
                    .is_some_and(|expression| expression.contains(r#""kind":"auth_totp_readback""#))
            })
            .count(),
        1,
        "clear confirms an empty bounded readback"
    );
    assert_action_probes_allow_auth_actions(&requests);
}

#[tokio::test]
async fn totp_clear_refuses_a_changed_refresh_value_signal_before_any_input() {
    const WINDOW_START: u64 = 1_800_000_000_000;
    const WINDOW_END: u64 = WINDOW_START + 30_000;
    let requested_signal = signal_id('8');
    let changed_value_signal = signal_id('9');
    let observations = VecDeque::from([complete_orphan_observation(
        &changed_value_signal,
        WINDOW_START + 15_000,
        220.0,
        180.0,
    )]);
    let (port, server) = spawn_auth_cdp(observations, VecDeque::new()).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open changed Facebook TOTP clear session");

    let refused = execute(
        &mut engine,
        1,
        NativeCommand::FacebookAuthClearTotp(FacebookAuthTotpWindowParams {
            signal_id: requested_signal,
            totp_window_start_unix_ms: WINDOW_START,
            totp_window_end_unix_ms: WINDOW_END,
        }),
    )
    .await;
    assert_refused(&refused, "stale_auth_signal");

    engine.shutdown().await;
    let requests = server.await.expect("changed Facebook TOTP clear fake CDP");
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"]
                .as_str()
                .is_some_and(|method| method.starts_with("Input.")))
            .count(),
        0,
        "a changed value-bound refresh signal must dispatch zero Native input"
    );
}

async fn execute(
    engine: &mut Engine,
    command_id: u64,
    command: NativeCommand,
) -> StoredCommandResult {
    engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: format!("facebook-auth-{command_id}"),
            session_id: "session-facebook-auth".to_owned(),
            task_id: "startup-facebook-auth".to_owned(),
            command_id,
            deadline_unix_ms: unix_time_ms() + 30_000,
            command,
        })
        .await
        .expect("Facebook auth command result")
}

fn assert_refused(outcome: &StoredCommandResult, reason: &str) {
    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::FacebookAuthAction(receipt) =
        outcome.output.as_ref().expect("refused action receipt")
    else {
        panic!("expected Facebook auth action receipt")
    };
    assert!(!receipt.ok);
    assert_eq!(receipt.reason.as_deref(), Some(reason));
}

fn assert_confirmed(outcome: &StoredCommandResult, action: &str) {
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::FacebookAuthAction(receipt) =
        outcome.output.as_ref().expect("confirmed action receipt")
    else {
        panic!("expected Facebook auth action receipt")
    };
    assert!(receipt.ok);
    assert_eq!(receipt.action, action);
    assert_eq!(receipt.reason, None);
}

fn first_input_index(requests: &[Value]) -> usize {
    requests
        .iter()
        .position(|request| {
            request["method"]
                .as_str()
                .is_some_and(|method| method.starts_with("Input."))
        })
        .expect("expected at least one Native input request")
}

fn count_auth_probes(requests: &[Value]) -> usize {
    requests
        .iter()
        .filter(|request| {
            request["params"]["expression"]
                .as_str()
                .is_some_and(|expression| expression.contains(r#""kind":"auth_probe""#))
        })
        .count()
}

fn count_mouse_pressed(requests: &[Value]) -> usize {
    requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mousePressed"
        })
        .count()
}

fn assert_action_probes_allow_auth_actions(requests: &[Value]) {
    let probes: Vec<&str> = requests
        .iter()
        .filter_map(|request| request["params"]["expression"].as_str())
        .filter(|expression| expression.contains(r#""kind":"auth_probe""#))
        .collect();
    assert!(
        !probes.is_empty(),
        "expected at least one fresh action probe"
    );
    assert!(
        probes
            .iter()
            .all(|expression| expression.contains(r#""allowAuthActions":true"#)),
        "Native action revalidation must never be short-circuited by authenticated cookies"
    );
}

fn signal_id(character: char) -> String {
    format!(
        "aidcp:facebook-auth:v1:{}",
        character.to_string().repeat(64)
    )
}

fn actionable_observation(signal: &str, signal_id: &str) -> Value {
    json!({
        "signal": signal,
        "signalId": signal_id,
        "documentGeneration": "https://www.facebook.com/login/|1800000000000",
        "candidate": {
            "candidateKey": "0".repeat(64),
            "cx": 320.0,
            "cy": 240.0
        }
    })
}

fn totp_observation(
    signal: &str,
    signal_id: &str,
    server_epoch_ms: u64,
    cx: f64,
    cy: f64,
) -> Value {
    json!({
        "signal": signal,
        "signalId": signal_id,
        "documentGeneration": "https://www.facebook.com/two_step_verification/two_factor/|1800000000000",
        "candidate": {
            "candidateKey": "1".repeat(64),
            "cx": cx,
            "cy": cy
        },
        "serverEpochMs": server_epoch_ms
    })
}

fn complete_orphan_observation(signal_id: &str, server_epoch_ms: u64, cx: f64, cy: f64) -> Value {
    let mut observation =
        totp_observation("totp_refresh_required", signal_id, server_epoch_ms, cx, cy);
    observation["reason"] = json!("entered_totp_window_unavailable");
    observation
}

fn blocked_observation(signal: &str, reason: &str) -> Value {
    json!({
        "signal": signal,
        "documentGeneration": "https://www.facebook.com/login/|1800000000000",
        "reason": reason
    })
}

fn session_open(port: u16) -> SessionOpenRecord {
    SessionOpenRecord {
        protocol_version: 2,
        id: "open-facebook-auth".to_owned(),
        session_id: "session-facebook-auth".to_owned(),
        task_id: "startup-facebook-auth".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Facebook,
            timeout_ms: 45_000,
            browser_debugger_url: None,
        },
    }
}

async fn spawn_auth_cdp(
    mut observations: VecDeque<Value>,
    mut readbacks: VecDeque<Value>,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing(&listener, port).await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        while let Some(message) = websocket.next().await {
            let message = message.expect("valid CDP request");
            let Message::Text(text) = message else {
                continue;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let method = request["method"].as_str().unwrap_or_default();
            let expression = request["params"]["expression"].as_str().unwrap_or_default();
            let result = if method == "Network.getAllCookies" {
                json!({"cookies":[]})
            } else if expression.contains(r#""kind":"auth_probe""#) {
                runtime_value(
                    "facebook_auth_observation",
                    observations
                        .pop_front()
                        .expect("one auth observation per fresh action"),
                )
            } else if expression.contains(r#""kind":"auth_focus_guard""#) {
                runtime_value("text_target", json!({"ok":true,"focused":true}))
            } else if expression.contains(r#""kind":"auth_totp_readback""#) {
                runtime_value(
                    "auth_totp_readback",
                    readbacks.pop_front().expect("one configured TOTP readback"),
                )
            } else if expression.contains(r#""kind":"auth_postcondition""#) {
                runtime_value(
                    "facebook_auth_postcondition",
                    json!({
                        "satisfied": true,
                        "documentChanged": true,
                        "signalGone": true
                    }),
                )
            } else {
                json!({})
            };
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .expect("CDP response");
            requests.push(request);
        }
        requests
    });
    (port, server)
}

fn runtime_value(kind: &str, value: Value) -> Value {
    json!({"result":{"value":{
        "effectPhase":"confirmed",
        "output":{"kind":kind,"value":value}
    }}})
}

async fn serve_target_listing(listener: &TcpListener, port: u16) {
    let (mut http, _) = listener.accept().await.expect("HTTP target request");
    let mut request = [0_u8; 2048];
    let _ = http.read(&mut request).await.expect("read target request");
    let body = json!([{
        "id": "target-facebook-auth",
        "type": "page",
        "url": "https://www.facebook.com/login/",
        "webSocketDebuggerUrl": format!(
            "ws://127.0.0.1:{port}/devtools/page/target-facebook-auth"
        )
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

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
