//! 同意闸的失败分档与探测失败降级。
//!
//! 同意闸是所有 Facebook 写 / 读动作的统一前置：评论、点赞、发帖、加群、滚动、刷新都过它。
//! 它一旦把「探不到按钮」和「探测本身炸了」都算成阻断，整台账号的每个动作都会被同一条结论杀掉。

use aidcp_page_engine::command::CommentParams;
use aidcp_page_engine::engine::{CommandOutput, Engine};
use aidcp_page_engine::protocol::{
    CommandRecord, EffectPhase, NativeCommand, Platform, SessionOpenParams, SessionOpenRecord,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

const NOTE_ID: &str = "https://www.facebook.com/groups/42/posts/7";

#[derive(Clone, Copy)]
enum Consent {
    /// 认出了同意条，但策略所需的按钮一个都定位不到（文案 / 布局漂移）。
    PresentWithoutButtons,
    /// 认出了同意条、也点得到，但点满上限仍清不掉。
    PresentButNeverClears,
    /// 探测本身失败（页面规则求值炸了）。
    ProbeFails,
}

#[tokio::test]
async fn a_missing_policy_button_stops_without_touching_the_page() {
    let (port, server) = spawn_consent_cdp(Consent::PresentWithoutButtons).await;
    let outcome = run_comment(port).await;

    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("gate receipt") else {
        panic!("expected an action receipt")
    };
    assert_eq!(receipt.reason.as_deref(), Some("blocked_by_consent"));
    assert_eq!(
        receipt.clicked,
        Some(false),
        "策略所需按钮定位不到这一档，页面一次都没被动过"
    );

    let requests = server.await.expect("consent fake CDP");
    assert_eq!(
        count_mouse(&requests, "mousePressed"),
        0,
        "策略所需按钮缺失时绝不改点另一个按钮"
    );
}

#[tokio::test]
async fn a_banner_that_never_clears_escalates_after_bounded_attempts() {
    let (port, server) = spawn_consent_cdp(Consent::PresentButNeverClears).await;
    let outcome = run_comment(port).await;

    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("gate receipt") else {
        panic!("expected an action receipt")
    };
    assert_eq!(receipt.reason.as_deref(), Some("blocked_by_consent"));
    assert_eq!(
        receipt.clicked,
        Some(true),
        "升级停手这一档与「按钮定位不到」必须可分"
    );

    let requests = server.await.expect("consent fake CDP");
    assert_eq!(
        count_mouse(&requests, "mousePressed"),
        3,
        "有界重试：点三次仍在就停手，绝不无限点下去"
    );
}

#[tokio::test]
async fn a_failed_consent_probe_is_treated_as_no_consent_rather_than_a_dead_command() {
    let (port, server) = spawn_consent_cdp(Consent::ProbeFails).await;
    let outcome = run_comment(port).await;

    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("comment receipt") else {
        panic!("expected an action receipt")
    };
    assert_ne!(
        receipt.reason.as_deref(),
        Some("blocked_by_consent"),
        "探测失败既不假设有同意条、也不假成功"
    );

    let requests = server.await.expect("consent fake CDP");
    assert!(
        requests.iter().any(|request| {
            request["params"]["expression"]
                .as_str()
                .is_some_and(|expression| expression.contains(r#""kind":"comment_editor_probe""#))
        }),
        "探测失败之后动作必须照常继续，而不是整条命令变成引擎错误"
    );
}

async fn run_comment(port: u16) -> aidcp_page_engine::engine::StoredCommandResult {
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 90_000;
    engine.open(&open).await.expect("open Facebook session");
    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "facebook-consent-gate-1".to_owned(),
            session_id: "session-consent-gate".to_owned(),
            task_id: "browse-consent-gate".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 30_000,
            command: NativeCommand::InteractionComment(CommentParams {
                note_id: NOTE_ID.to_owned(),
                text: "a useful reply".to_owned(),
                account_id: Some("61591824155856".to_owned()),
                group_chat_code: None,
                fast_return_to_feed: None,
                reason: None,
                think_ms: None,
            }),
        })
        .await
        .expect("Facebook comment receipt");
    engine.shutdown().await;
    outcome
}

fn count_mouse(requests: &[Value], kind: &str) -> usize {
    requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchMouseEvent" && request["params"]["type"] == kind
        })
        .count()
}

fn session_open(port: u16) -> SessionOpenRecord {
    SessionOpenRecord {
        protocol_version: 2,
        id: "open-consent-gate".to_owned(),
        session_id: "session-consent-gate".to_owned(),
        task_id: "browse-consent-gate".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Facebook,
            timeout_ms: 8_000,
        },
    }
}

async fn spawn_consent_cdp(consent: Consent) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
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
            let expression = request["params"]["expression"].as_str().unwrap_or_default();
            let result = if expression.contains(r#""kind":"page_probe""#) {
                runtime_value("page_probe", page_probe_value())
            } else if expression.contains(r#""kind":"consent_probe""#) {
                consent_value(consent)
            } else if expression.contains(r#""kind":"comment_editor_probe""#) {
                runtime_value(
                    "text_target",
                    json!({"ok": false, "reason": "editor_not_found"}),
                )
            } else if expression.contains(r#""kind":"comment_action_probe""#) {
                runtime_value("point_target", json!({"ok": false, "reason": "no_target"}))
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

fn consent_value(consent: Consent) -> Value {
    match consent {
        Consent::PresentWithoutButtons => runtime_value(
            "consent_probe",
            json!({
                "present": true,
                "acceptAllAmbiguous": false,
                "necessaryOnlyAmbiguous": false
            }),
        ),
        Consent::PresentButNeverClears => runtime_value(
            "consent_probe",
            json!({
                "present": true,
                "acceptAll": {"cx": 640.0, "cy": 700.0},
                "acceptAllAmbiguous": false,
                "necessaryOnlyAmbiguous": false
            }),
        ),
        // 页面规则求值返回了一个引擎认不出的形状 —— 等价于探测失败。
        Consent::ProbeFails => json!({"result": {"value": {"broken": true}}}),
    }
}

fn page_probe_value() -> Value {
    json!({
        "targetId": "",
        "origin": "https://www.facebook.com",
        "path": "/groups/42/posts/7",
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
        "id": "target-consent-gate",
        "type": "page",
        "url": "https://www.facebook.com/groups/42/posts/7",
        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/target-consent-gate")
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
