//! 评论正文未被编辑器接受时的**收场**契约。
//!
//! 谓词层（「多打了几个字算无害残留 / 少打了就是被截断」）已由 `facebook/comment.rs` 的单测锁住，
//! 那里只判「接受还是拒绝」。这一组锁的是拒绝之后**页面被留成什么样**：
//! 编辑框里那半截正文必须被清干净、命令收敛回「未开始」、一次提交都不许发出去。
//!
//! 少了这道端到端断言，一个「判定为拒绝、但忘了清场」的实现照样全绿：
//! 半截正文留在编辑框里，下一条命令接着往后打字，最后发出去的是**两条正文黏在一起**的评论——
//! 这正是「静默假成功」的另一种长相：本次回执诚实说失败，代价却留在页面上由下一次买单。

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
const COMMENT_TEXT: &str = "a useful reply";
/// 假页面的编辑框只吃得下前 8 个字符就停了——回读拿到的是被截断的正文。
/// 真机上的对应形态是输入被富文本编辑器吞掉 / 焦点中途被抢走。
const EDITOR_INTAKE_LIMIT: usize = 8;

/// 假页面把编辑框当**有状态的东西**建模：清没清干净是页面事实，不是某条请求的存在性。
/// 只查「有没有派发退格」会被一个「退格发了但没生效」的实现骗过去。
#[derive(Default)]
struct FakeEditor {
    value: String,
    selected: bool,
}

impl FakeEditor {
    fn insert(&mut self, text: &str) {
        self.selected = false;
        for character in text.chars() {
            if self.value.chars().count() >= EDITOR_INTAKE_LIMIT {
                return;
            }
            self.value.push(character);
        }
    }

    fn backspace(&mut self) {
        if self.selected {
            self.value.clear();
            self.selected = false;
        } else {
            self.value.pop();
        }
    }

    fn probe(&mut self, focus: bool, select_contents: bool) -> Value {
        if focus {
            self.selected = select_contents;
        }
        json!({
            "ok": true,
            "noteId": NOTE_ID,
            "cx": 300.0,
            "cy": 500.0,
            "value": self.value,
            "focused": true,
            "selected": self.selected
        })
    }
}

struct FakePage {
    requests: Vec<Value>,
    editor_value: String,
}

#[tokio::test]
async fn a_rejected_comment_body_is_wiped_from_the_editor_and_stays_not_started() {
    let (port, server) = spawn_truncating_editor_cdp().await;
    let outcome = run_comment(port).await;

    assert_eq!(
        outcome.effect_phase,
        EffectPhase::NotStarted,
        "文本没进去就是一步都没走成，绝不许报成「已提交、待确认」"
    );
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("comment receipt") else {
        panic!("expected comment receipt")
    };
    assert!(!receipt.ok);
    assert_eq!(receipt.reason.as_deref(), Some("marker_not_accepted"));

    let page = server.await.expect("truncating editor fake CDP");
    assert_eq!(
        page.editor_value, "",
        "被拒的半截正文 MUST 从编辑框里清干净，绝不许留给下一条命令继续往后打"
    );
    assert_eq!(
        count_key(&page.requests, "Enter"),
        0,
        "文本未被接受时一次提交都不许发出去"
    );
    assert!(
        page.requests
            .iter()
            .any(|request| request["method"] == "Input.insertText"),
        "本用例必须真走到「打完字再回读」那一步，否则断言的是另一条路径"
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
            id: "facebook-comment-rejection-1".to_owned(),
            session_id: "session-comment-rejection".to_owned(),
            task_id: "browse-comment-rejection".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 60_000,
            command: NativeCommand::InteractionComment(CommentParams {
                note_id: NOTE_ID.to_owned(),
                text: COMMENT_TEXT.to_owned(),
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

fn count_key(requests: &[Value], key: &str) -> usize {
    requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchKeyEvent" && request["params"]["key"] == key
        })
        .count()
}

fn session_open(port: u16) -> SessionOpenRecord {
    SessionOpenRecord {
        protocol_version: 2,
        id: "open-comment-rejection".to_owned(),
        session_id: "session-comment-rejection".to_owned(),
        task_id: "browse-comment-rejection".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Facebook,
            timeout_ms: 8_000,
            browser_debugger_url: None,
        },
    }
}

async fn spawn_truncating_editor_cdp() -> (u16, tokio::task::JoinHandle<FakePage>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing(&listener, port).await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut editor = FakeEditor::default();
        while let Some(message) = websocket.next().await {
            let message = message.expect("valid CDP request");
            let Message::Text(text) = message else {
                continue;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            if request["method"] == "Input.insertText" {
                editor.insert(request["params"]["text"].as_str().unwrap_or_default());
            }
            if request["method"] == "Input.dispatchKeyEvent"
                && request["params"]["key"] == "Backspace"
                && request["params"]["type"] == "keyDown"
            {
                editor.backspace();
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
                runtime_value(
                    "text_target",
                    editor.probe(
                        expression.contains(r#""focus":true"#),
                        expression.contains(r#""selectContents":true"#),
                    ),
                )
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
        FakePage {
            requests,
            editor_value: editor.value,
        }
    });
    (port, server)
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
        "id": "target-comment-rejection",
        "type": "page",
        "url": "https://www.facebook.com/groups/42/posts/7",
        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/target-comment-rejection")
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
