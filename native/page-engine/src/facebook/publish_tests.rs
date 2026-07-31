use super::*;
use crate::cdp::CdpSession;
use crate::command::{
    PublishFieldParams, PublishFileParams, PublishIdentity, PublishSelectModeParams,
};
use crate::endpoint::CdpTarget;
use crate::protocol::Platform;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_tungstenite::{accept_async, tungstenite::Message};

/// Deadline-crossing tests: keep the two magnitudes far apart.
///
/// This family asserts "the absolute deadline is crossed *at a particular step* of the flow".
/// It used to express that with 25..250ms of real wall clock, so under concurrent load (several
/// `cargo test` binaries plus `npm test` on the same machine) the crossing point drifted from the
/// step under test to an *earlier* probe, and the assertion flipped from `Ambiguous` to
/// `NotStarted`. Measured at roughly 12% red across full runs, always under load, never idle.
///
/// The fix is not a bigger budget - it is two separated magnitudes:
/// - `DEADLINE_HEADROOM_MS` leaves the steps that MUST NOT cross far more room than scheduling
///   jitter can eat.
/// - `SLOW_PROBE_DELAY_MS` makes the step that MUST cross do so from the fake CDP server's own
///   sleep, which only ever gets longer under load - so the crossing is deterministic in the
///   direction the assertion needs.
///
/// MUST keep `SLOW_PROBE_DELAY_MS > DEADLINE_HEADROOM_MS`; moving them together trades the
/// determinism straight back for a race. The const assertion below enforces it.
const DEADLINE_HEADROOM_MS: u64 = 1_200;
const SLOW_PROBE_DELAY_MS: u64 = 2_500;
const _: () = assert!(
    SLOW_PROBE_DELAY_MS > DEADLINE_HEADROOM_MS,
    "the slow probe must outlast the deadline, or the crossing becomes load-dependent again"
);

#[derive(Clone, Copy)]
enum PublishScenario {
    Navigate,
    TransientNavigateProbe,
    LateEntry,
    AlreadyOpen,
    HomeLoss,
    BlockingDialog,
    EditorTimeout,
    SlowAlreadyOpen,
    SlowPostClick,
    TransientPostClickProbe,
    SubmitState,
    SlowSubmitState,
    TransientSubmitProbe,
    FillAccepted,
    FillDelayedReadback,
    FillRejected,
    FillFocusRejected,
    FillFocusLost,
    UploadConfirmed,
}

#[derive(Default)]
struct FakeCalls {
    page_probes: usize,
    home_probes: usize,
    entry_probes: usize,
    editor_probes: usize,
    submitted_probes: usize,
    mouse_releases: usize,
    navigations: usize,
    inserted_texts: Vec<String>,
    editor_value: String,
    backspaces: usize,
    editor_focused: bool,
    editor_selected: bool,
    bound_editor_probes: usize,
    upload_target_probes: usize,
    upload_preview_probes: usize,
    file_sets: usize,
    preview_file_name: String,
}

fn browser_result(kind: &str, value: Value) -> Value {
    json!({
        "result": {
            "value": {
                "effectPhase": "confirmed",
                "output": { "kind": kind, "value": value }
            }
        }
    })
}

fn expression_input(expression: &str) -> Value {
    let start = expression.rfind(")({").expect("router expression input") + 2;
    serde_json::from_str(&expression[start..expression.len() - 1]).expect("router input")
}

fn expression_kind(expression: &str) -> &str {
    let input = expression_input(expression);
    match input.get("kind").and_then(Value::as_str) {
        Some("page_probe") => "page_probe",
        Some("consent_probe") => "consent_probe",
        Some("publish_home_probe") => "publish_home_probe",
        Some("publish_entry_probe") => "publish_entry_probe",
        Some("publish_editor_probe") => "publish_editor_probe",
        Some("publish_bound_editor_probe") => "publish_bound_editor_probe",
        Some("publish_upload_target_probe") => "publish_upload_target_probe",
        Some("publish_upload_preview_probe") => "publish_upload_preview_probe",
        Some("publish_submit_probe") => "publish_submit_probe",
        Some("publish_submitted_probe") => "publish_submitted_probe",
        other => panic!("unexpected router input {other:?}"),
    }
}

fn evaluated_result(scenario: PublishScenario, calls: &mut FakeCalls, expression: &str) -> Value {
    match expression_kind(expression) {
        "page_probe" => {
            calls.page_probes += 1;
            let loading_after_navigation = matches!(scenario, PublishScenario::Navigate)
                && calls.navigations == 1
                && calls.page_probes == 2;
            let home_lost = matches!(scenario, PublishScenario::HomeLoss) && calls.page_probes >= 2;
            browser_result(
                "page_probe",
                json!({
                    "targetId": "",
                    "origin": "https://www.facebook.com",
                    "path": if home_lost { "/search/" } else { "/" },
                    "readyState": if loading_after_navigation { "loading" } else { "complete" },
                    "pageKind": if home_lost { "search" } else { "home" },
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
                        "mainCount": if loading_after_navigation { 0 } else { 1 }
                    }
                }),
            )
        }
        "consent_probe" => browser_result(
            "consent_probe",
            json!({
                "present": false,
                "acceptAllAmbiguous": false,
                "necessaryOnlyAmbiguous": false
            }),
        ),
        "publish_home_probe" => {
            calls.home_probes += 1;
            if matches!(scenario, PublishScenario::TransientNavigateProbe) && calls.home_probes == 1
            {
                return json!({});
            }
            let loading_after_navigation = matches!(scenario, PublishScenario::Navigate)
                && calls.navigations == 1
                && calls.home_probes == 1;
            let home_lost = matches!(scenario, PublishScenario::HomeLoss);
            let blocking_dialog = matches!(scenario, PublishScenario::BlockingDialog);
            let editor_ready = matches!(
                scenario,
                PublishScenario::AlreadyOpen | PublishScenario::SlowAlreadyOpen
            );
            browser_result(
                "publish_home_probe",
                json!({
                    "href": if home_lost {
                        "https://www.facebook.com/search/"
                    } else {
                        "https://www.facebook.com/"
                    },
                    "readyState": if loading_after_navigation { "loading" } else { "complete" },
                    "mainVisible": !loading_after_navigation,
                    "editorReady": editor_ready,
                    "blockingDialog": blocking_dialog,
                    "credentialInput": false
                }),
            )
        }
        "publish_entry_probe" => {
            calls.entry_probes += 1;
            let ready = !matches!(scenario, PublishScenario::LateEntry) || calls.entry_probes >= 2;
            browser_result(
                "point_target",
                if ready {
                    json!({ "ok": true, "cx": 120.0, "cy": 80.0 })
                } else {
                    json!({ "ok": false, "reason": "composer_entry_not_found" })
                },
            )
        }
        "publish_editor_probe" => {
            calls.editor_probes += 1;
            let input = expression_input(expression);
            let focus_requested =
                input.pointer("/params/focus").and_then(Value::as_bool) == Some(true);
            let select_requested = input
                .pointer("/params/selectContents")
                .and_then(Value::as_bool)
                == Some(true);
            if focus_requested {
                calls.editor_focused = !matches!(scenario, PublishScenario::FillFocusRejected);
                calls.editor_selected = calls.editor_focused && select_requested;
            }
            if matches!(scenario, PublishScenario::TransientPostClickProbe)
                && calls.mouse_releases > 0
                && calls.editor_probes == 2
            {
                return json!({});
            }
            let open = matches!(
                scenario,
                PublishScenario::AlreadyOpen
                    | PublishScenario::SlowAlreadyOpen
                    | PublishScenario::FillAccepted
                    | PublishScenario::FillDelayedReadback
                    | PublishScenario::FillRejected
                    | PublishScenario::FillFocusRejected
                    | PublishScenario::FillFocusLost
                    | PublishScenario::UploadConfirmed
            ) || (matches!(
                scenario,
                PublishScenario::LateEntry
                    | PublishScenario::SlowPostClick
                    | PublishScenario::TransientPostClickProbe
            ) && calls.mouse_releases > 0);
            browser_result(
                "text_target",
                if open {
                    let value = if matches!(scenario, PublishScenario::FillDelayedReadback)
                        && calls.editor_probes == 3
                    {
                        String::new()
                    } else {
                        calls.editor_value.clone()
                    };
                    json!({
                        "ok": true,
                        "cx": 180.0,
                        "cy": 140.0,
                        "value": value,
                        "focused": calls.editor_focused,
                        "selected": calls.editor_selected
                    })
                } else {
                    json!({ "ok": false, "reason": "composer_not_open" })
                },
            )
        }
        "publish_bound_editor_probe" => {
            calls.bound_editor_probes += 1;
            let input = expression_input(expression);
            let focus_requested =
                input.pointer("/params/focus").and_then(Value::as_bool) == Some(true);
            let select_requested = input
                .pointer("/params/selectContents")
                .and_then(Value::as_bool)
                == Some(true);
            if matches!(scenario, PublishScenario::FillFocusLost)
                && !focus_requested
                && calls.inserted_texts.len() >= 2
            {
                calls.editor_focused = false;
            }
            if focus_requested {
                calls.editor_focused = true;
                calls.editor_selected = select_requested;
            }
            browser_result(
                "text_target",
                json!({
                    "ok": true,
                    "cx": 180.0,
                    "cy": 140.0,
                    "value": calls.editor_value,
                    "focused": calls.editor_focused,
                    "selected": calls.editor_selected
                }),
            )
        }
        "publish_upload_target_probe" => {
            calls.upload_target_probes += 1;
            browser_result("point_target", json!({ "ok": true }))
        }
        "publish_upload_preview_probe" => {
            calls.upload_preview_probes += 1;
            let input = expression_input(expression);
            calls.preview_file_name = input
                .pointer("/params/fileName")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            browser_result("point_target", json!({ "ok": true }))
        }
        "publish_submit_probe" => browser_result(
            "publish_submit_probe",
            json!({
                "ok": true,
                "composerOpen": true,
                "disabled": false,
                "cx": 240.0,
                "cy": 180.0
            }),
        ),
        "publish_submitted_probe" => {
            calls.submitted_probes += 1;
            if matches!(scenario, PublishScenario::TransientSubmitProbe)
                && calls.submitted_probes == 1
            {
                return json!({});
            }
            browser_result(
                "publish_submitted_probe",
                json!({
                    "confirmed": matches!(
                        scenario,
                        PublishScenario::SubmitState | PublishScenario::TransientSubmitProbe
                    )
                        && calls.mouse_releases > 0
                        || matches!(scenario, PublishScenario::SlowSubmitState)
                            && calls.mouse_releases > 0,
                    "witness": if matches!(
                        scenario,
                        PublishScenario::SubmitState
                            | PublishScenario::SlowSubmitState
                            | PublishScenario::TransientSubmitProbe
                    )
                        && calls.mouse_releases > 0
                    {
                        Some("submitted_state")
                    } else {
                        None
                    }
                }),
            )
        }
        _ => unreachable!(),
    }
}

async fn fake_session(
    scenario: PublishScenario,
) -> (EngineSession, Arc<Mutex<FakeCalls>>, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let address = listener.local_addr().expect("listener address");
    let calls = Arc::new(Mutex::new(FakeCalls::default()));
    let server_calls = Arc::clone(&calls);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("accept");
        let mut websocket = accept_async(stream).await.expect("websocket");
        while let Some(message) = websocket.next().await {
            let message = message.expect("client message");
            let Message::Text(text) = message else {
                if matches!(message, Message::Close(_)) {
                    break;
                }
                continue;
            };
            let request: Value = serde_json::from_slice(text.as_bytes()).expect("CDP request");
            let id = request
                .get("id")
                .and_then(Value::as_u64)
                .expect("request id");
            let method = request
                .get("method")
                .and_then(Value::as_str)
                .expect("CDP method");
            let result = match method {
                "Runtime.evaluate" => {
                    let expression = request
                        .pointer("/params/expression")
                        .and_then(Value::as_str)
                        .expect("expression");
                    let kind = expression_kind(expression);
                    let result = {
                        let mut calls = server_calls.lock().expect("calls");
                        evaluated_result(scenario, &mut calls, expression)
                    };
                    let should_delay = matches!(scenario, PublishScenario::SlowAlreadyOpen)
                        && kind == "publish_editor_probe"
                        || matches!(scenario, PublishScenario::SlowPostClick)
                            && kind == "publish_editor_probe"
                            && server_calls.lock().expect("calls").mouse_releases > 0
                        || matches!(scenario, PublishScenario::SlowSubmitState)
                            && kind == "publish_submitted_probe";
                    if should_delay {
                        // One delay for all three slow scenarios: each of them exists so that the
                        // probe it slows down is the step that crosses the deadline. Per-scenario
                        // values only made it harder to see that they must all outlast
                        // DEADLINE_HEADROOM_MS.
                        tokio::time::sleep(Duration::from_millis(SLOW_PROBE_DELAY_MS)).await;
                    }
                    result
                }
                "Page.navigate" => {
                    server_calls.lock().expect("calls").navigations += 1;
                    json!({})
                }
                "Input.dispatchMouseEvent" => {
                    if request.pointer("/params/type").and_then(Value::as_str)
                        == Some("mouseReleased")
                    {
                        server_calls.lock().expect("calls").mouse_releases += 1;
                    }
                    json!({})
                }
                "Input.dispatchKeyEvent" => {
                    if request.pointer("/params/type").and_then(Value::as_str) == Some("keyDown")
                        && request.pointer("/params/key").and_then(Value::as_str)
                            == Some("Backspace")
                    {
                        let mut calls = server_calls.lock().expect("calls");
                        calls.backspaces += 1;
                        if calls.editor_focused && calls.editor_selected {
                            calls.editor_value.clear();
                            calls.editor_selected = false;
                        }
                    }
                    json!({})
                }
                "Input.insertText" => {
                    let inserted = request
                        .pointer("/params/text")
                        .and_then(Value::as_str)
                        .expect("insert text")
                        .to_owned();
                    let mut calls = server_calls.lock().expect("calls");
                    if calls.editor_focused {
                        calls.inserted_texts.push(inserted.clone());
                        calls.editor_selected = false;
                        if !matches!(scenario, PublishScenario::FillRejected) {
                            calls.editor_value.push_str(&inserted);
                        }
                    }
                    json!({})
                }
                "DOM.getDocument" => json!({ "root": { "nodeId": 1 } }),
                "DOM.querySelector" => json!({ "nodeId": 2 }),
                "DOM.setFileInputFiles" => {
                    server_calls.lock().expect("calls").file_sets += 1;
                    json!({})
                }
                _ => json!({}),
            };
            websocket
                .send(Message::Text(
                    json!({ "id": id, "result": result }).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
    });
    let target = CdpTarget {
        id: "facebook-test-target".to_owned(),
        target_type: "page".to_owned(),
        url: "https://www.facebook.com/".to_owned(),
        web_socket_debugger_url: format!("ws://{address}"),
    };
    let cdp = CdpSession::connect(&target).await.expect("CDP session");
    (
        EngineSession::for_test(cdp, Platform::Facebook),
        calls,
        server,
    )
}

fn select_command(option_value: &str) -> NativeCommand {
    NativeCommand::PublishSelectMode(PublishSelectModeParams {
        record_id: 7,
        seq: 2,
        option_kind: Some("target".to_owned()),
        option_value: Some(option_value.to_owned()),
    })
}

fn receipt(output: CommandOutput) -> crate::model::PublishReceipt {
    let CommandOutput::PublishReceipt(receipt) = output else {
        panic!("expected publish receipt");
    };
    receipt
}

fn fill_command(value: &str) -> (PublishFieldParams, NativeCommand) {
    let params = PublishFieldParams {
        record_id: 7,
        seq: 3,
        field_type: "content".to_owned(),
        value: value.to_owned(),
    };
    let command = NativeCommand::PublishFillField(params.clone());
    (params, command)
}

#[tokio::test]
async fn navigate_entry_waits_for_home_without_clicking_the_composer() {
    let (mut session, calls, server) = fake_session(PublishScenario::Navigate).await;
    let command = NativeCommand::PublishNavigateEntry(PublishIdentity {
        record_id: 7,
        seq: 1,
    });

    let (phase, output) =
        execute_facebook_publish_entry(&mut session, &command, unix_time_ms() + 2_000)
            .await
            .expect("navigate entry");

    assert_eq!(phase, EffectPhase::Confirmed);
    assert!(receipt(output).ok);
    {
        let calls = calls.lock().expect("calls");
        assert_eq!(calls.navigations, 1);
        assert_eq!(calls.mouse_releases, 0);
        assert!(calls.page_probes >= 2);
        assert!(calls.home_probes >= 2);
    }
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn navigate_entry_tolerates_one_transient_home_probe_failure() {
    let (mut session, calls, server) = fake_session(PublishScenario::TransientNavigateProbe).await;
    let command = NativeCommand::PublishNavigateEntry(PublishIdentity {
        record_id: 7,
        seq: 1,
    });

    let (phase, output) =
        execute_facebook_publish_entry(&mut session, &command, unix_time_ms() + 2_000)
            .await
            .expect("navigate entry");

    assert_eq!(phase, EffectPhase::Confirmed);
    assert!(receipt(output).ok);
    assert!(calls.lock().expect("calls").home_probes >= 2);
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn select_mode_waits_for_late_entry_and_clicks_once() {
    let (mut session, calls, server) = fake_session(PublishScenario::LateEntry).await;
    let command = select_command("facebook_personal_timeline");
    let NativeCommand::PublishSelectMode(params) = &command else {
        unreachable!();
    };

    let (phase, output) = execute_facebook_publish_select_mode(
        &mut session,
        params,
        &command,
        unix_time_ms() + 2_000,
    )
    .await
    .expect("select mode");

    assert_eq!(phase, EffectPhase::Confirmed);
    assert!(receipt(output).ok);
    {
        let calls = calls.lock().expect("calls");
        assert!(calls.entry_probes >= 3);
        assert_eq!(calls.mouse_releases, 1);
    }
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn select_mode_accepts_an_open_editor_without_dispatch() {
    let (mut session, calls, server) = fake_session(PublishScenario::AlreadyOpen).await;
    let command = select_command("facebook_personal_timeline");
    let NativeCommand::PublishSelectMode(params) = &command else {
        unreachable!();
    };

    let (phase, output) = execute_facebook_publish_select_mode(
        &mut session,
        params,
        &command,
        unix_time_ms() + 1_000,
    )
    .await
    .expect("select mode");

    assert_eq!(phase, EffectPhase::Confirmed);
    assert!(receipt(output).ok);
    {
        let calls = calls.lock().expect("calls");
        assert_eq!(calls.entry_probes, 0);
        assert_eq!(calls.mouse_releases, 0);
    }
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn select_mode_retains_the_legacy_optional_target_kind() {
    let (mut session, calls, server) = fake_session(PublishScenario::AlreadyOpen).await;
    let command = NativeCommand::PublishSelectMode(PublishSelectModeParams {
        record_id: 7,
        seq: 2,
        option_kind: None,
        option_value: Some("facebook_personal_timeline".to_owned()),
    });
    let NativeCommand::PublishSelectMode(params) = &command else {
        unreachable!();
    };

    let (phase, output) = execute_facebook_publish_select_mode(
        &mut session,
        params,
        &command,
        unix_time_ms() + 1_000,
    )
    .await
    .expect("select mode");

    assert_eq!(phase, EffectPhase::Confirmed);
    assert!(receipt(output).ok);
    assert_eq!(calls.lock().expect("calls").mouse_releases, 0);
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn select_mode_stops_before_dispatch_after_home_loss() {
    let (mut session, calls, server) = fake_session(PublishScenario::HomeLoss).await;
    let command = select_command("facebook_personal_timeline");
    let NativeCommand::PublishSelectMode(params) = &command else {
        unreachable!();
    };

    let (phase, output) = execute_facebook_publish_select_mode(
        &mut session,
        params,
        &command,
        unix_time_ms() + 1_000,
    )
    .await
    .expect("select mode");
    let receipt = receipt(output);

    assert_eq!(phase, EffectPhase::NotStarted);
    assert!(!receipt.ok);
    assert_eq!(receipt.error.as_deref(), Some("home_not_reached"));
    assert_eq!(calls.lock().expect("calls").mouse_releases, 0);
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn select_mode_rejects_a_visible_non_composer_blocking_dialog() {
    let (mut session, calls, server) = fake_session(PublishScenario::BlockingDialog).await;
    let command = select_command("facebook_personal_timeline");
    let NativeCommand::PublishSelectMode(params) = &command else {
        unreachable!();
    };

    let (phase, output) = execute_facebook_publish_select_mode(
        &mut session,
        params,
        &command,
        unix_time_ms() + 1_000,
    )
    .await
    .expect("select mode");

    assert_eq!(phase, EffectPhase::NotStarted);
    assert_eq!(receipt(output).error.as_deref(), Some("blocked_dialog"));
    assert_eq!(calls.lock().expect("calls").mouse_releases, 0);
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn select_mode_reports_ambiguous_after_one_unconfirmed_click() {
    let (mut session, calls, server) = fake_session(PublishScenario::EditorTimeout).await;
    let command = select_command("facebook_personal_timeline");
    let NativeCommand::PublishSelectMode(params) = &command else {
        unreachable!();
    };

    let (phase, output) = execute_facebook_publish_select_mode(
        &mut session,
        params,
        &command,
        unix_time_ms() + DEADLINE_HEADROOM_MS,
    )
    .await
    .expect("select mode");
    let receipt = receipt(output);

    assert_eq!(phase, EffectPhase::Ambiguous);
    assert!(!receipt.ok);
    assert_eq!(receipt.error.as_deref(), Some("composer_unconfirmed"));
    assert_eq!(calls.lock().expect("calls").mouse_releases, 1);
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn select_mode_never_clicks_after_the_absolute_deadline() {
    let (mut session, calls, server) = fake_session(PublishScenario::EditorTimeout).await;
    let command = select_command("facebook_personal_timeline");
    let NativeCommand::PublishSelectMode(params) = &command else {
        unreachable!();
    };

    let (phase, output) =
        execute_facebook_publish_select_mode(&mut session, params, &command, unix_time_ms())
            .await
            .expect("select mode");
    let receipt = receipt(output);

    assert_eq!(phase, EffectPhase::NotStarted);
    assert_eq!(
        receipt.error.as_deref(),
        Some("deadline_expired_before_dispatch")
    );
    assert_eq!(calls.lock().expect("calls").mouse_releases, 0);
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn select_mode_does_not_confirm_when_an_open_editor_probe_crosses_the_deadline() {
    let (mut session, calls, server) = fake_session(PublishScenario::SlowAlreadyOpen).await;
    let command = select_command("facebook_personal_timeline");
    let NativeCommand::PublishSelectMode(params) = &command else {
        unreachable!();
    };

    let (phase, output) = execute_facebook_publish_select_mode(
        &mut session,
        params,
        &command,
        unix_time_ms() + DEADLINE_HEADROOM_MS,
    )
    .await
    .expect("select mode");

    assert_eq!(phase, EffectPhase::NotStarted);
    assert_eq!(
        receipt(output).error.as_deref(),
        Some("deadline_expired_before_dispatch")
    );
    assert_eq!(calls.lock().expect("calls").mouse_releases, 0);
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn select_mode_is_ambiguous_when_post_click_confirmation_crosses_the_deadline() {
    let (mut session, calls, server) = fake_session(PublishScenario::SlowPostClick).await;
    let command = select_command("facebook_personal_timeline");
    let NativeCommand::PublishSelectMode(params) = &command else {
        unreachable!();
    };

    let (phase, output) = execute_facebook_publish_select_mode(
        &mut session,
        params,
        &command,
        unix_time_ms() + DEADLINE_HEADROOM_MS,
    )
    .await
    .expect("select mode");

    assert_eq!(phase, EffectPhase::Ambiguous);
    assert_eq!(
        receipt(output).error.as_deref(),
        Some("composer_unconfirmed")
    );
    assert_eq!(calls.lock().expect("calls").mouse_releases, 1);
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn select_mode_tolerates_one_transient_post_click_probe_failure() {
    let (mut session, calls, server) = fake_session(PublishScenario::TransientPostClickProbe).await;
    let command = select_command("facebook_personal_timeline");
    let NativeCommand::PublishSelectMode(params) = &command else {
        unreachable!();
    };

    let (phase, output) = execute_facebook_publish_select_mode(
        &mut session,
        params,
        &command,
        unix_time_ms() + 2_000,
    )
    .await
    .expect("select mode");

    assert_eq!(phase, EffectPhase::Confirmed);
    assert!(receipt(output).ok);
    assert_eq!(calls.lock().expect("calls").mouse_releases, 1);
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn fill_types_one_unicode_scalar_at_a_time_and_preserves_approved_whitespace() {
    let (mut session, calls, server) = fake_session(PublishScenario::FillAccepted).await;
    let value = " Việt🙂\n";
    let (params, command) = fill_command(value);

    let (phase, output) = execute_facebook_publish_fill(
        &mut session,
        &params,
        &command,
        None,
        unix_time_ms() + 30_000,
    )
    .await
    .expect("fill content");

    assert_eq!(phase, EffectPhase::Confirmed);
    assert!(receipt(output).ok);
    {
        let calls = calls.lock().expect("calls");
        let expected = value
            .chars()
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        assert_eq!(calls.inserted_texts, expected);
        assert_eq!(calls.editor_value, value);
        assert!(calls.backspaces >= 1);
    }
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn fill_polls_until_delayed_lexical_readback_contains_the_full_text() {
    let (mut session, calls, server) = fake_session(PublishScenario::FillDelayedReadback).await;
    let value = "Việt";
    let (params, command) = fill_command(value);

    let (phase, output) = execute_facebook_publish_fill(
        &mut session,
        &params,
        &command,
        None,
        unix_time_ms() + 30_000,
    )
    .await
    .expect("fill delayed content");

    assert_eq!(phase, EffectPhase::Confirmed);
    assert!(receipt(output).ok);
    assert!(calls.lock().expect("calls").editor_probes >= 4);
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn fill_rejection_clears_the_editor_and_never_confirms() {
    let (mut session, calls, server) = fake_session(PublishScenario::FillRejected).await;
    let (params, command) = fill_command("Việt");

    let (phase, output) = execute_facebook_publish_fill(
        &mut session,
        &params,
        &command,
        None,
        unix_time_ms() + 30_000,
    )
    .await
    .expect("rejected fill");
    let receipt = receipt(output);

    assert_eq!(phase, EffectPhase::NotStarted);
    assert_eq!(receipt.error.as_deref(), Some("composer_readback_mismatch"));
    {
        let calls = calls.lock().expect("calls");
        assert!(calls.backspaces >= 2);
        assert!(calls.editor_value.is_empty());
        assert_eq!(calls.inserted_texts.len(), "Việt".chars().count());
    }
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn fill_focus_rejection_stops_before_any_character_dispatch() {
    let (mut session, calls, server) = fake_session(PublishScenario::FillFocusRejected).await;
    let (params, command) = fill_command("Việt");

    let (phase, output) = execute_facebook_publish_fill(
        &mut session,
        &params,
        &command,
        None,
        unix_time_ms() + 30_000,
    )
    .await
    .expect("focus rejection");
    let receipt = receipt(output);

    assert_eq!(phase, EffectPhase::NotStarted);
    assert_eq!(receipt.error.as_deref(), Some("composer_focus_failed"));
    assert!(calls.lock().expect("calls").inserted_texts.is_empty());
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn fill_focus_loss_stops_before_the_next_character_and_cleans_the_bound_editor() {
    let (mut session, calls, server) = fake_session(PublishScenario::FillFocusLost).await;
    let (params, command) = fill_command("abcdef");

    let (phase, output) = execute_facebook_publish_fill(
        &mut session,
        &params,
        &command,
        None,
        unix_time_ms() + 30_000,
    )
    .await
    .expect("focus loss");
    let receipt = receipt(output);

    assert_eq!(phase, EffectPhase::NotStarted);
    assert_eq!(receipt.error.as_deref(), Some("composer_focus_lost"));
    {
        let calls = calls.lock().expect("calls");
        assert_eq!(calls.inserted_texts, ["a", "b"]);
        assert!(calls.editor_value.is_empty());
        assert!(calls.bound_editor_probes >= 3);
    }
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn upload_binds_the_current_file_input_and_confirms_the_exact_file_preview() {
    let (mut session, calls, server) = fake_session(PublishScenario::UploadConfirmed).await;
    let path = std::env::temp_dir().join(format!("aidcp-native-upload-{}.jpg", unix_time_ms()));
    std::fs::write(&path, b"image").expect("write upload fixture");
    let command = NativeCommand::PublishUploadImage(PublishFileParams {
        record_id: 7,
        seq: 3,
        path: path.to_string_lossy().into_owned(),
        image_index: 0,
    });

    let (phase, output) = execute(
        &mut session,
        &command,
        None,
        &CommitWindowRequester::in_process(3),
        unix_time_ms() + 10_000,
    )
    .await
    .expect("upload image");
    let receipt = receipt(output);

    assert_eq!(phase, EffectPhase::Confirmed);
    assert!(receipt.ok);
    {
        let calls = calls.lock().expect("calls");
        assert_eq!(calls.upload_target_probes, 1);
        assert_eq!(calls.file_sets, 1);
        assert_eq!(calls.upload_preview_probes, 1);
        assert_eq!(
            calls.preview_file_name,
            path.file_name().unwrap().to_string_lossy()
        );
    }
    session.cdp.close().await;
    server.await.expect("server");
    std::fs::remove_file(path).expect("remove upload fixture");
}

#[tokio::test]
async fn fill_deadline_stops_before_the_next_character_and_clears_partial_text() {
    let (mut session, calls, server) = fake_session(PublishScenario::FillAccepted).await;
    let (params, command) = fill_command("abcdef");

    let (phase, output) = execute_facebook_publish_fill(
        &mut session,
        &params,
        &command,
        None,
        unix_time_ms() + FACEBOOK_PUBLISH_FILL_RESERVE_MS + 10,
    )
    .await
    .expect("deadline fill");
    let receipt = receipt(output);

    assert_eq!(phase, EffectPhase::NotStarted);
    assert_eq!(receipt.error.as_deref(), Some("fill_deadline_exceeded"));
    {
        let calls = calls.lock().expect("calls");
        assert!(calls.inserted_texts.len() < "abcdef".chars().count());
        assert!(calls.editor_value.is_empty());
        assert!(calls.backspaces >= 2);
    }
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn submit_accepts_the_localized_submitted_state_probe_after_one_click() {
    let (mut session, calls, server) = fake_session(PublishScenario::SubmitState).await;
    let params = PublishIdentity {
        record_id: 7,
        seq: 3,
    };
    let command = NativeCommand::PublishSubmit(params.clone());
    let requester = CommitWindowRequester::in_process(3);

    let (phase, output) = execute_facebook_publish_submit(
        &mut session,
        &params,
        &command,
        None,
        &requester,
        unix_time_ms() + 1_000,
    )
    .await
    .expect("submit");
    let receipt = receipt(output);

    assert_eq!(phase, EffectPhase::Confirmed);
    assert!(receipt.ok);
    assert_eq!(receipt.submit_dispatched, Some(true));
    assert_eq!(calls.lock().expect("calls").mouse_releases, 1);
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn submit_does_not_confirm_when_the_submitted_probe_crosses_the_deadline() {
    let (mut session, calls, server) = fake_session(PublishScenario::SlowSubmitState).await;
    let params = PublishIdentity {
        record_id: 7,
        seq: 3,
    };
    let command = NativeCommand::PublishSubmit(params.clone());
    let requester = CommitWindowRequester::in_process(3);

    let (phase, output) = execute_facebook_publish_submit(
        &mut session,
        &params,
        &command,
        None,
        &requester,
        unix_time_ms() + DEADLINE_HEADROOM_MS,
    )
    .await
    .expect("submit");

    assert_eq!(phase, EffectPhase::Ambiguous);
    assert_eq!(
        receipt(output).error.as_deref(),
        Some("submit_verification_ambiguous")
    );
    assert_eq!(calls.lock().expect("calls").mouse_releases, 1);
    session.cdp.close().await;
    server.await.expect("server");
}

#[tokio::test]
async fn submit_tolerates_one_transient_post_click_probe_failure() {
    let (mut session, calls, server) = fake_session(PublishScenario::TransientSubmitProbe).await;
    let params = PublishIdentity {
        record_id: 7,
        seq: 3,
    };
    let command = NativeCommand::PublishSubmit(params.clone());
    let requester = CommitWindowRequester::in_process(3);

    let (phase, output) = execute_facebook_publish_submit(
        &mut session,
        &params,
        &command,
        None,
        &requester,
        unix_time_ms() + 2_000,
    )
    .await
    .expect("submit");

    assert_eq!(phase, EffectPhase::Confirmed);
    assert!(receipt(output).ok);
    assert_eq!(calls.lock().expect("calls").mouse_releases, 1);
    session.cdp.close().await;
    server.await.expect("server");
}
