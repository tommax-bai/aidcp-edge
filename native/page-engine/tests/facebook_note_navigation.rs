//! 用途为「导航」的开帖必须真导航。
//!
//! 这条命令要的是「账号真的落在那一页」，不是拿一份详情读物。缺面别参数时读当前页返回详情
//! 等于页面没动却报开成功，后续所有以「已在目标页」为前提的动作都会打在错的页面上。

use aidcp_page_engine::command::{NoteOpenParams, NotePurpose};
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

const TARGET: &str = "https://www.facebook.com/groups/42/posts/7";
const ELSEWHERE: &str = "https://www.facebook.com/groups/42/posts/9";

#[tokio::test]
async fn a_navigate_purpose_open_navigates_and_reports_an_action_receipt() {
    let (port, server) = spawn_navigation_cdp(TARGET).await;
    let outcome = run_navigate(port, Some(TARGET.to_owned())).await;

    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("navigation receipt") else {
        panic!("导航用途下永不产出详情输出")
    };
    assert!(receipt.ok);
    assert_eq!(receipt.action, "open_note");
    assert_eq!(
        receipt
            .observation
            .as_ref()
            .and_then(|evidence| evidence.surface.as_deref()),
        Some("group_post")
    );

    let requests = server.await.expect("navigation fake CDP");
    assert!(
        requests.iter().any(|request| {
            request["method"] == "Page.navigate" && request["params"]["url"] == TARGET
        }),
        "只带 permalink 的导航用途必须真的导航过去"
    );
}

#[tokio::test]
async fn a_navigate_purpose_open_without_a_navigable_target_never_navigates() {
    let (port, server) = spawn_navigation_cdp(TARGET).await;
    let outcome = run_navigate(port, None).await;

    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("navigation receipt") else {
        panic!("导航用途下永不产出详情输出")
    };
    assert!(!receipt.ok);
    assert_eq!(receipt.reason.as_deref(), Some("target_not_found"));

    let requests = server.await.expect("navigation fake CDP");
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Page.navigate"),
        "解析不出可导航目标时零导航"
    );
}

#[tokio::test]
async fn landing_on_another_post_is_never_reported_as_an_opened_target() {
    let (port, server) = spawn_navigation_cdp(ELSEWHERE).await;
    let outcome = run_navigate(port, Some(TARGET.to_owned())).await;

    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("navigation receipt") else {
        panic!("身份不符时也绝不上报详情")
    };
    assert!(!receipt.ok);
    assert_eq!(receipt.reason.as_deref(), Some("target_context_mismatch"));

    let _ = server.await.expect("navigation fake CDP");
}

async fn run_navigate(
    port: u16,
    note_id: Option<String>,
) -> aidcp_page_engine::engine::StoredCommandResult {
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    engine.open(&open).await.expect("open Facebook session");
    let outcome = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "facebook-note-navigate-1".to_owned(),
            session_id: "session-note-navigate".to_owned(),
            task_id: "browse-note-navigate".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 30_000,
            command: NativeCommand::NoteOpen(NoteOpenParams {
                note_id,
                purpose: Some(NotePurpose::Navigate),
                ..NoteOpenParams::default()
            }),
        })
        .await
        .expect("Facebook navigate receipt");
    engine.shutdown().await;
    outcome
}

fn session_open(port: u16) -> SessionOpenRecord {
    SessionOpenRecord {
        protocol_version: 2,
        id: "open-note-navigate".to_owned(),
        session_id: "session-note-navigate".to_owned(),
        task_id: "browse-note-navigate".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Facebook,
            timeout_ms: 8_000,
        },
    }
}

async fn spawn_navigation_cdp(landing: &'static str) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
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
                runtime_value(
                    "consent_probe",
                    json!({
                        "present": false,
                        "acceptAllAmbiguous": false,
                        "necessaryOnlyAmbiguous": false
                    }),
                )
            } else if expression.contains(r#""kind":"feed_probe""#) {
                runtime_value("feed_probe", feed_probe_value(landing))
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

fn feed_probe_value(landing: &str) -> Value {
    json!({
        "cards": [],
        "documentGeneration": "doc-1",
        "listKind": "feed",
        "listState": "empty",
        "loading": false,
        "articleCount": 1,
        "explicitEmpty": false,
        "explicitEnd": false,
        "url": landing,
        "surface": "group_post",
        "scrollY": 0.0,
        "innerWidth": 1440.0,
        "innerHeight": 900.0,
        "scrollHeight": 2400.0,
        "scrollViewportHeight": 900.0,
        "documentTimeOriginMs": 1_780_000_000_000_u64,
        "documentAgeMs": 10_000
    })
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
        "id": "target-note-navigate",
        "type": "page",
        "url": "https://www.facebook.com/",
        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/target-note-navigate")
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
