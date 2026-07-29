//! 小红书写动作接上硬件级输入原语（change `restore-native-actuation-humanization-and-locating` §8 输入半边）。
//!
//! 迁移后小红书全线文本输入走的是注入路由里的「原型 value setter 整段赋值 + 手工派发合成事件」：
//! 一次赋值、`isTrusted=false`、没有任何键盘节奏。本组用例钉死四件事：
//!  ① 评论与发布正文的文本**真的逐字 / 分块派发**，且拼接起来逐字符等于要写的内容；
//!  ② 长正文只缩往返与停顿、**绝不丢字符**；
//!  ③ 预算耗尽 ⇒ 清空编辑器 + 诚实失败，**绝不**写了一半报成功；
//!  ④ 打字期间的接管**原样穿出**为取消，不被吞成一条普通失败回执。
//!
//! 另有一条钉死 8.3：富文本正文的换行是**独立的裸回车按键**，任何一次文本写入都不携带回车符。

use aidcp_page_engine::commit_window::CommitWindowRequester;
use aidcp_page_engine::engine::{CommandOutput, Engine};
use aidcp_page_engine::error::ErrorCode;
use aidcp_page_engine::protocol::{
    CommandRecord, EffectPhase, NativeCommand, Platform, SessionOpenParams, SessionOpenRecord,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

/// 假 CDP 记录到的一次会话：页面收到的全部请求 + 真正被写进编辑器的文本。
struct Observed {
    requests: Vec<Value>,
    editor: String,
    enter_presses: usize,
}

impl Observed {
    fn inserted_chunks(&self) -> Vec<String> {
        self.requests
            .iter()
            .filter(|entry| entry["method"] == "Input.insertText")
            .map(|entry| {
                entry
                    .pointer("/params/text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect()
    }

    fn evaluated(&self, needle: &str) -> usize {
        self.requests
            .iter()
            .filter(|entry| {
                entry
                    .pointer("/params/expression")
                    .and_then(Value::as_str)
                    .is_some_and(|expression| expression.contains(needle))
            })
            .count()
    }

    fn input_events(&self, method: &str) -> usize {
        self.requests
            .iter()
            .filter(|entry| entry["method"] == method)
            .count()
    }
}

#[derive(Clone, Copy)]
struct FakePage {
    /// 编辑器是不是受控框（`value` 语义）。false = contenteditable，换行走裸回车。
    plain_value: bool,
    /// 每次文本写入的假往返耗时，用来把预算真的撑破。
    insert_delay_ms: u64,
    /// 第几次文本写入之后置位接管信号（0 = 从不）。
    cancel_after_inserts: usize,
}

impl Default for FakePage {
    fn default() -> Self {
        Self {
            plain_value: true,
            insert_delay_ms: 0,
            cancel_after_inserts: 0,
        }
    }
}

#[tokio::test]
async fn a_comment_is_typed_character_by_character_instead_of_being_assigned_in_one_write() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(FakePage::default(), cancellation.clone()).await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(
                1,
                command(
                    r#"{"kind":"interaction_comment","params":{"noteId":"note-1","text":"好文，收藏了","groupChatCode":"vx-1234"}}"#,
                ),
                12_000,
            ),
            cancellation,
            CommitWindowRequester::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::ActionReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected an action receipt");
    };
    assert_eq!(receipt.action, "comment");
    assert!(receipt.ok, "假页面回了确认，回执必须是成功");
    assert_eq!(result.effect_phase, EffectPhase::Confirmed);

    drop(engine);
    let observed = server.await.expect("fake page");
    let chunks = observed.inserted_chunks();
    // ① 真的分多次派发，而不是一次性赋值。
    assert!(
        chunks.len() >= 2,
        "文本必须逐字 / 分块派发，实测只有 {} 次写入",
        chunks.len()
    );
    // ② 拼起来逐字符等于人审看到的终稿（正文 + 换行 + 联系方式串码）。
    assert_eq!(chunks.concat(), "好文，收藏了\nvx-1234");
    assert_eq!(observed.editor, "好文，收藏了\nvx-1234");
    // ③ 落焦与提交都走拟人指针轨迹：多帧移动 + 成对的按下 / 抬起（两次点击 = 各 2 次）。
    assert!(observed.input_events("Input.dispatchMouseEvent") > 2 * 3);
    // ④ 注入路由的同名分支一次都不该被调用 —— 它已被引擎特化截走。
    assert_eq!(observed.evaluated(r#""kind":"interaction_comment""#), 0);
}

#[tokio::test]
async fn a_long_body_caps_round_trips_without_dropping_a_single_character() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(FakePage::default(), cancellation.clone()).await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let body: String = std::iter::repeat_n('字', 5_000).collect();
    let params = json!({
        "kind": "publish_fill_field",
        "params": {"recordId": 7, "seq": 3, "fieldType": "content", "value": body},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 8_000),
            cancellation,
            CommitWindowRequester::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::PublishReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    assert!(receipt.ok, "5000 字必须写得完：{:?}", receipt.error);

    drop(engine);
    let observed = server.await.expect("fake page");
    let chunks = observed.inserted_chunks();
    assert!(chunks.len() >= 2, "长正文仍必须分多次派发");
    assert!(chunks.len() <= 240, "往返数越过上限：{} 次", chunks.len());
    // 红线：封顶只缩往返与停顿 —— 一个字符都不许少。
    assert_eq!(chunks.concat().chars().count(), 5_000);
    assert_eq!(observed.editor, body);
}

#[tokio::test]
async fn a_typing_deadline_clears_the_editor_and_fails_honestly() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            insert_delay_ms: 3_000,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let body: String = std::iter::repeat_n('字', 600).collect();
    let params = json!({
        "kind": "publish_fill_field",
        "params": {"recordId": 7, "seq": 4, "fieldType": "content", "value": body},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 5_500),
            cancellation,
            CommitWindowRequester::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::PublishReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    assert!(!receipt.ok, "预算耗尽绝不许报成功");
    assert_eq!(
        receipt.error.as_deref(),
        Some("publish_field_deadline_exceeded")
    );

    drop(engine);
    let observed = server.await.expect("fake page");
    // 写了一半就超预算：编辑器必须被清空，不留半截草稿给下一次拼接 / 提交。
    assert!(!observed.inserted_chunks().is_empty(), "本轮确实写过一部分");
    assert_eq!(observed.editor, "", "失败出口必须先清场再回执");
}

#[tokio::test]
async fn a_takeover_during_typing_passes_through_as_cancelled() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            cancel_after_inserts: 2,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let body: String = std::iter::repeat_n('字', 400).collect();
    let params = json!({
        "kind": "publish_fill_field",
        "params": {"recordId": 7, "seq": 5, "fieldType": "content", "value": body},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 20_000),
            cancellation,
            CommitWindowRequester::in_process(1),
        )
        .await
        .expect("command result");

    // 接管**原样穿出**：是一条取消错误，不是一条普通失败回执。
    let error = result.error.expect("takeover must surface as an error");
    assert_eq!(error.code, ErrorCode::Cancelled);
    assert!(result.output.is_none());

    drop(engine);
    let observed = server.await.expect("fake page");
    assert!(
        observed.inserted_chunks().len() >= 2,
        "接管发生在打字过程中（已经写过至少两块）"
    );
    assert_eq!(observed.editor, "", "让位之前必须先清场");
}

#[tokio::test]
async fn a_newline_in_the_rich_text_body_is_a_bare_enter_key_and_never_a_typed_character() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            plain_value: false,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let params = json!({
        "kind": "publish_fill_field",
        "params": {"recordId": 7, "seq": 6, "fieldType": "content", "value": "第一段内容\n第二段内容"},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 20_000),
            cancellation,
            CommitWindowRequester::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::PublishReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    assert!(receipt.ok, "两段正文必须写得完：{:?}", receipt.error);

    drop(engine);
    let observed = server.await.expect("fake page");
    // ① 文本写入结构上不携带回车符。
    for chunk in observed.inserted_chunks() {
        assert!(
            !chunk.contains('\n') && !chunk.contains('\r'),
            "文本写入携带了回车符：{chunk:?}"
        );
    }
    // ② 换行改由独立的裸回车按键完成，次数恰等于正文里的换行数。
    assert_eq!(observed.enter_presses, 1);
    // ③ 每次回车之后都做了有界归尾确认（连续两轮命中才收敛 ⇒ 至少两次探针）。
    assert!(observed.evaluated(r#""kind":"content_caret_state""#) >= 2);
    assert_eq!(observed.editor, "第一段内容\n第二段内容");
}

fn command(raw: &str) -> NativeCommand {
    serde_json::from_str(raw).expect("native command fixture")
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// 命令原子预算 = `min(会话 timeout_ms, 命令上限)`，只放宽 `deadline_unix_ms` 无效。
fn session_open(port: u16) -> SessionOpenRecord {
    SessionOpenRecord {
        protocol_version: 2,
        id: "open-typing".to_owned(),
        session_id: "session-typing".to_owned(),
        task_id: "browse-typing".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Xiaohongshu,
            timeout_ms: 30_000,
        },
    }
}

fn write_command(command_id: u64, command: NativeCommand, budget_ms: u64) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("command-{command_id}"),
        session_id: "session-typing".to_owned(),
        task_id: "browse-typing".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + budget_ms,
        command,
    }
}

/// 一台会「记住被写进去了什么」的假页面：文本写入累加进编辑器，裸回车按 ProseMirror 的语义
/// 在编辑器里拆一段。页面判据分片按 `kind` / `op` 作答。
async fn spawn_page(
    page: FakePage,
    cancellation: Arc<AtomicBool>,
) -> (u16, tokio::task::JoinHandle<Observed>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        let (mut http, _) = listener.accept().await.expect("HTTP target request");
        let mut request = [0_u8; 2048];
        let _ = http.read(&mut request).await.expect("read target request");
        let body = json!([{
            "id": "target-typing",
            "type": "page",
            "url": "https://www.xiaohongshu.com/explore/note-1",
            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/target-typing")
        }])
        .to_string();
        let headers = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        http.write_all(headers.as_bytes()).await.expect("headers");
        http.write_all(body.as_bytes()).await.expect("body");
        http.shutdown().await.expect("HTTP shutdown");

        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut observed = Observed {
            requests: Vec::new(),
            editor: String::new(),
            enter_presses: 0,
        };
        let mut inserts = 0_usize;
        while let Some(Ok(Message::Text(text))) = websocket.next().await {
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let method = request["method"].as_str().unwrap_or_default().to_owned();
            let expression = request
                .pointer("/params/expression")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();

            if method == "Input.insertText" {
                let chunk = request
                    .pointer("/params/text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                observed.editor.push_str(chunk);
                inserts += 1;
                if page.insert_delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(page.insert_delay_ms)).await;
                }
                if page.cancel_after_inserts > 0 && inserts == page.cancel_after_inserts {
                    cancellation.store(true, Ordering::Release);
                }
            }
            if method == "Input.dispatchKeyEvent"
                && request.pointer("/params/key").and_then(Value::as_str) == Some("Enter")
                && request.pointer("/params/type").and_then(Value::as_str) == Some("rawKeyDown")
            {
                observed.enter_presses += 1;
                observed.editor.push('\n');
            }

            let response = if method == "Runtime.evaluate" {
                evaluate(&expression, &page, &mut observed)
            } else {
                json!({})
            };
            observed.requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id": id, "result": response}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        observed
    });
    (port, server)
}

fn evaluate(expression: &str, page: &FakePage, observed: &mut Observed) -> Value {
    if expression.contains("feedCardCount") {
        return json!({"result":{"value":{
            "href": "https://www.xiaohongshu.com/explore/note-1",
            "readyState": "complete",
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
        }}});
    }
    if expression.contains(r#""kind":"note_guard""#) {
        return value(json!({"found": true, "match": true, "noteId": "note-1"}));
    }
    if expression.contains(r#""kind":"comment_submit""#) {
        return value(json!({"found": true, "x": 320.0, "y": 460.0}));
    }
    if expression.contains(r#""kind":"comment_ack""#) {
        return value(json!({"found": true, "appeared": true}));
    }
    if expression.contains(r#""kind":"content_caret_state""#) {
        return value(json!({
            "found": true,
            "text": normalized(&observed.editor),
            "newlines": observed.enter_presses,
            "atEnd": true,
        }));
    }
    if expression.contains(r#""kind":"comment_editor""#)
        || expression.contains(r#""kind":"publish_field""#)
    {
        if expression.contains(r#""op":"clear""#) {
            observed.editor.clear();
            return value(json!({
                "found": true, "cleared": true, "focused": true, "value": "",
                "plainValue": page.plain_value, "x": 240.0, "y": 300.0, "paragraphs": 0,
            }));
        }
        let paragraphs = observed
            .editor
            .split('\n')
            .filter(|line| !line.trim().is_empty())
            .count();
        return value(json!({
            "found": true, "cleared": observed.editor.is_empty(), "focused": true,
            "value": observed.editor, "plainValue": page.plain_value,
            "x": 240.0, "y": 300.0, "paragraphs": paragraphs,
        }));
    }
    value(json!({"found": false}))
}

fn value(inner: Value) -> Value {
    json!({"result": {"value": inner}})
}

fn normalized(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
