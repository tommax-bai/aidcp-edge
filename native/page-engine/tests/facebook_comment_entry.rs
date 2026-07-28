//! 折叠态评论入口的执行契约。
//!
//! 就地评论（在列表 / 群 feed 上下文里评论）会碰到「评论框还没渲染出来」的折叠态——
//! 退役实现靠先按 permalink 整页导航到详情页绕开它，本引擎没有那条豁免，
//! 必须把入口点开。这组用例锁三件事：点得到、最多点一次、探针说不清时一次都不点。

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

/// 入口探针的应答形态。
#[derive(Clone, Copy)]
enum EntryProbe {
    /// 目标唯一、可点。点开后编辑框才出现。
    Actionable,
    /// 目标不唯一——一次点击都不许派发。
    Ambiguous,
    /// 待审入群闸。
    PendingGroupApproval,
}

#[tokio::test]
async fn collapsed_comment_entry_is_clicked_once_and_then_the_editor_is_reprobed() {
    let (port, server) = spawn_comment_entry_cdp(EntryProbe::Actionable).await;
    let outcome = run_comment(port).await;

    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("comment receipt") else {
        panic!("expected comment receipt")
    };
    // 点开之后编辑框出现，命令得以继续；本用例只到「不再是 editor_not_found」为止。
    assert_ne!(receipt.reason.as_deref(), Some("editor_not_found"));

    let requests = server.await.expect("comment entry fake CDP");
    assert_eq!(
        count_expressions(&requests, r#""kind":"comment_action_probe""#),
        1,
        "入口探针每条命令最多探一次"
    );
    // 入口点位 (300,460) 与编辑框聚焦点位 (300,500) 分得开：
    // 入口只许被按一次，编辑框那一下是既有的聚焦动作、不算入口点击。
    assert_eq!(
        count_mouse_at(&requests, "mousePressed", 460.0),
        1,
        "入口最多点一次，绝不反复点开又收起"
    );
}

#[tokio::test]
async fn an_ambiguous_comment_entry_dispatches_no_click_at_all() {
    let (port, server) = spawn_comment_entry_cdp(EntryProbe::Ambiguous).await;
    let outcome = run_comment(port).await;

    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("comment receipt") else {
        panic!("expected comment receipt")
    };
    assert_eq!(receipt.reason.as_deref(), Some("ambiguous_target"));
    assert!(!receipt.ok);

    let requests = server.await.expect("comment entry fake CDP");
    assert_eq!(
        count_mouse(&requests, "mousePressed"),
        0,
        "作用域内目标不唯一时点下去就是往别人的帖子里打字"
    );
    assert!(
        requests
            .iter()
            .all(|request| request["method"] != "Input.insertText"),
        "未开始的命令绝不打字"
    );
}

#[tokio::test]
async fn a_pending_group_approval_entry_converges_on_its_own_terminal() {
    let (port, server) = spawn_comment_entry_cdp(EntryProbe::PendingGroupApproval).await;
    let outcome = run_comment(port).await;

    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("comment receipt") else {
        panic!("expected comment receipt")
    };
    assert_eq!(receipt.reason.as_deref(), Some("pending_group_approval"));

    let requests = server.await.expect("comment entry fake CDP");
    assert_eq!(count_mouse(&requests, "mousePressed"), 0);
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
            id: "facebook-comment-entry-1".to_owned(),
            session_id: "session-comment-entry".to_owned(),
            task_id: "browse-comment-entry".to_owned(),
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

fn count_expressions(requests: &[Value], needle: &str) -> usize {
    requests
        .iter()
        .filter(|request| {
            request["params"]["expression"]
                .as_str()
                .is_some_and(|expression| expression.contains(needle))
        })
        .count()
}

fn count_mouse_at(requests: &[Value], kind: &str, y: f64) -> usize {
    requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == kind
                && request["params"]["y"].as_f64() == Some(y)
        })
        .count()
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
        id: "open-comment-entry".to_owned(),
        session_id: "session-comment-entry".to_owned(),
        task_id: "browse-comment-entry".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Facebook,
            timeout_ms: 8_000,
        },
    }
}

async fn spawn_comment_entry_cdp(entry: EntryProbe) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing(&listener, port).await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut entry_clicked = false;
        while let Some(message) = websocket.next().await {
            let message = message.expect("valid CDP request");
            let Message::Text(text) = message else {
                continue;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            if request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mousePressed"
            {
                entry_clicked = true;
            }
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
            } else if expression.contains(r#""kind":"comment_editor_probe""#) {
                // 折叠态：入口没被点开之前，编辑框根本不存在。
                if entry_clicked {
                    runtime_value(
                        "text_target",
                        json!({
                            "ok": true,
                            "noteId": NOTE_ID,
                            "cx": 300.0,
                            "cy": 500.0,
                            "value": "",
                            "focused": true,
                            "selected": true
                        }),
                    )
                } else {
                    runtime_value(
                        "text_target",
                        json!({"ok": false, "reason": "editor_not_found"}),
                    )
                }
            } else if expression.contains(r#""kind":"comment_action_probe""#) {
                runtime_value("point_target", entry_probe_value(entry))
            } else if expression.contains(r#""kind":"comment_ack_probe""#) {
                runtime_value(
                    "comment_ack_probe",
                    json!({"confirmed": false, "rejected": false, "pending": false}),
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

fn entry_probe_value(entry: EntryProbe) -> Value {
    match entry {
        EntryProbe::Actionable => json!({"ok": true, "cx": 300.0, "cy": 460.0}),
        EntryProbe::Ambiguous => json!({"ok": false, "reason": "ambiguous_target"}),
        EntryProbe::PendingGroupApproval => {
            json!({"ok": false, "reason": "pending_group_approval"})
        }
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
        "id": "target-comment-entry",
        "type": "page",
        "url": "https://www.facebook.com/groups/42/posts/7",
        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/target-comment-entry")
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
