//! Facebook 未实现的发布命令必须在**动作之前**被显式拒绝。
//!
//! 跑到页面规则里才报 `kind_not_implemented`，等于白起一次会话动作（导航 / 输入 / 点击 /
//! 提交窗口），还把写截止时间耗在一件注定不做的事上。这组用例锁的是「一次 CDP 都不发」。

use aidcp_page_engine::command::{
    PublishCandidateParams, PublishCaptureParams, PublishCoverParams, PublishOptionParams,
    PublishScheduleParams,
};
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

fn unsupported_commands() -> Vec<(&'static str, NativeCommand)> {
    vec![
        (
            "set_cover",
            NativeCommand::PublishSetCover(PublishCoverParams {
                record_id: 1,
                seq: 1,
                image_index: 0,
            }),
        ),
        (
            "add_with_candidate",
            NativeCommand::PublishAddWithCandidate(PublishCandidateParams {
                record_id: 1,
                seq: 2,
                candidate_kind: "topic".to_owned(),
                value: "agent".to_owned(),
                candidates: vec!["agent".to_owned()],
            }),
        ),
        (
            "set_option",
            NativeCommand::PublishSetOption(PublishOptionParams {
                record_id: 1,
                seq: 3,
                option_kind: "visibility".to_owned(),
                option_value: "public".to_owned(),
            }),
        ),
        (
            "set_schedule",
            NativeCommand::PublishSetSchedule(PublishScheduleParams {
                record_id: 1,
                seq: 4,
                publish_time: 1_800_000_000,
            }),
        ),
    ]
}

fn unsupported_publish_receipts() -> Vec<(&'static str, NativeCommand)> {
    vec![
        (
            "capture_scheduled",
            NativeCommand::PublishCaptureScheduled(PublishCaptureParams {
                record_id: 1,
                seq: 5,
                scheduled_title: None,
                scheduled_platform_id: None,
                publish_time: None,
            }),
        ),
        (
            "reconcile_scheduled",
            NativeCommand::PublishReconcileScheduled(PublishCaptureParams {
                record_id: 1,
                seq: 6,
                scheduled_title: None,
                scheduled_platform_id: None,
                publish_time: None,
            }),
        ),
    ]
}

#[tokio::test]
async fn unsupported_publish_commands_touch_the_page_zero_times() {
    let (port, server) = spawn_silent_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    engine.open(&open).await.expect("open Facebook session");

    let mut command_id = 0_u32;
    for (action, command) in unsupported_commands() {
        command_id += 1;
        let outcome = engine
            .execute(&record(command_id, command))
            .await
            .expect("unsupported publish command");
        assert_eq!(outcome.effect_phase, EffectPhase::NotStarted, "{action}");
        let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("receipt") else {
            panic!("{action} must stay an action receipt")
        };
        assert_eq!(receipt.action, action);
        assert!(!receipt.ok);
        assert_eq!(receipt.reason.as_deref(), Some("kind_not_implemented"));
    }
    for (kind, command) in unsupported_publish_receipts() {
        command_id += 1;
        let outcome = engine
            .execute(&record(command_id, command))
            .await
            .expect("unsupported publish command");
        assert_eq!(outcome.effect_phase, EffectPhase::NotStarted, "{kind}");
        let CommandOutput::PublishReceipt(receipt) = outcome.output.expect("receipt") else {
            panic!("{kind} must stay a publish receipt")
        };
        assert_eq!(receipt.kind, kind);
        assert!(!receipt.ok);
        assert_eq!(receipt.error.as_deref(), Some("kind_not_implemented"));
    }

    engine.shutdown().await;
    let requests = server.await.expect("silent fake CDP");
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Runtime.evaluate"),
        "不支持的命令绝不许求值任何页面规则：{requests:?}"
    );
    assert!(
        requests.iter().all(|request| !request["method"]
            .as_str()
            .unwrap_or_default()
            .starts_with("Input.")),
        "不支持的命令绝不许派发任何输入"
    );
}

fn record(command_id: u32, command: NativeCommand) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("facebook-publish-unsupported-{command_id}"),
        session_id: "session-publish-unsupported".to_owned(),
        task_id: "publish-unsupported".to_owned(),
        command_id: command_id.into(),
        deadline_unix_ms: unix_time_ms() + 30_000,
        command,
    }
}

fn session_open(port: u16) -> SessionOpenRecord {
    SessionOpenRecord {
        protocol_version: 2,
        id: "open-publish-unsupported".to_owned(),
        session_id: "session-publish-unsupported".to_owned(),
        task_id: "publish-unsupported".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Facebook,
            timeout_ms: 8_000,
        },
    }
}

async fn spawn_silent_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
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
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":{}}).to_string().into(),
                ))
                .await
                .expect("CDP response");
            requests.push(request);
        }
        requests
    });
    (port, server)
}

async fn serve_target_listing(listener: &TcpListener, port: u16) {
    let (mut http, _) = listener.accept().await.expect("HTTP target request");
    let mut request = [0_u8; 2048];
    let _ = http.read(&mut request).await.expect("read target request");
    let body = json!([{
        "id": "target-publish-unsupported",
        "type": "page",
        "url": "https://www.facebook.com/",
        "webSocketDebuggerUrl":
            format!("ws://127.0.0.1:{port}/devtools/page/target-publish-unsupported")
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
