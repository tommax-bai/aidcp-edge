//! 验证码协助键入的**取证诚实化**（change restore-native-xiaohongshu-session-guards §3）。
//!
//! 迁移后每一个验证码返回点都只带一个原因串，五项取证一项都不产出，而键入函数的字符计数在
//! **成功路径也被丢弃**、失败路径压根不存在。后果是宿主只能按请求载荷推断「点击并键入」：
//! 下发了文本、一个字符都没打进去，回执照样说打了。
//!
//! 本组用例钉死的语义：
//!  ① 走完整条链（聚焦 → 清空 → 键入 → 回读 → 提交 → 复检）时，六格取证齐全且逐格属实；
//!  ② 焦点没落定是**结构确定**的失败：取证在场、`typed=0`、`submitted=false`，且零字符按键；
//!  ③ 中途失败时 `typed` 是**实际派发数**、不是请求文本长度，且**绝不提交**；
//!  ④ 纯点击（未下发文本）不产出取证，且线上 JSON 里 `typeReport` **整格缺席**——
//!     不是 `null`。宿主对回执做盲展开，一格 `null` 会被读成「有一段空取证」；
//!  ⑤ 回读是三态：读到且一致 / 读到但不一致 / 根本没读到——「没读到」MUST NOT 记成「不一致」。

use aidcp_page_engine::command::{CaptchaCaptureParams, CaptchaClickParams, CaptchaPoint};
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

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_millis() as u64
}

fn session_open(port: u16) -> SessionOpenRecord {
    SessionOpenRecord {
        protocol_version: 2,
        id: "open-forensics".to_owned(),
        session_id: "session-forensics".to_owned(),
        task_id: "browse-forensics".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Xiaohongshu,
            timeout_ms: 30_000,
        },
    }
}

fn record(command_id: u64, command: NativeCommand) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("forensics-{command_id}"),
        session_id: "session-forensics".to_owned(),
        task_id: "browse-forensics".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + 20_000,
        command,
    }
}

fn capture(command_id: u64, incident: &str) -> CommandRecord {
    record(
        command_id,
        NativeCommand::CaptchaCapture(CaptchaCaptureParams {
            incident_id: incident.to_owned(),
            max_image_width: None,
            max_image_height: None,
            quality: None,
        }),
    )
}

fn click(
    command_id: u64,
    incident: &str,
    snapshot_id: String,
    text: Option<&str>,
    submit: Option<&str>,
) -> CommandRecord {
    record(
        command_id,
        NativeCommand::CaptchaClick(CaptchaClickParams {
            incident_id: incident.to_owned(),
            snapshot_id,
            points: vec![CaptchaPoint {
                x: 0.5,
                y: 0.5,
                label: None,
            }],
            settle_ms: Some(10),
            text: text.map(str::to_owned),
            submit: submit.map(str::to_owned),
        }),
    )
}

/// 走一遍「抓帧 → 点击（可带文本 / 提交）」，回引擎回执与假 CDP 收到的全部请求。
async fn run_assist(
    port: u16,
    server: tokio::task::JoinHandle<Vec<Value>>,
    incident: &str,
    text: Option<&str>,
    submit: Option<&str>,
) -> (
    EffectPhase,
    Box<aidcp_page_engine::model::ActionReceipt>,
    Vec<Value>,
) {
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open session");
    let captured = engine
        .execute(&capture(1, incident))
        .await
        .expect("captcha capture");
    let CommandOutput::CaptchaSnapshot(snapshot) = captured.output.expect("snapshot output") else {
        panic!("expected a captcha snapshot")
    };
    let outcome = engine
        .execute(&click(2, incident, snapshot.snapshot_id, text, submit))
        .await
        .expect("captcha click");
    let phase = outcome.effect_phase;
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("receipt output") else {
        panic!("expected a captcha action receipt")
    };
    engine.shutdown().await;
    let requests = server.await.expect("fake CDP");
    (phase, receipt, requests)
}

/// 打完字之后那一次**回读**的形态。清空阶段（还没打过字）一律照实回空串，
/// 否则清空确认会先失败，根本走不到要测的那一步。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Readback {
    /// 照实回显打进去的字符。
    Echo,
    /// 读到了，但不是打进去的那一串。
    Wrong,
    /// 通道通了、页面回 null：此刻没有可读的焦点元素。
    Null,
    /// 回读求值本身失败。
    ChannelError,
}

/// 一台可编程的假 CDP：
///  - `focus_after_click`：点击之后焦点是否落到一个可编辑输入框上；
///  - `fail_character_keydown_at`：第几个字符的 keyDown 失败（1 基；`None` 表示都不失败）；
///  - `readback`：打完字之后那次回读的形态。
///
/// 页面探针一律回「非阻断」，让成功路径能走到 `cleared`。
async fn spawn_captcha_cdp(
    focus_after_click: bool,
    fail_character_keydown_at: Option<usize>,
    readback: Readback,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        let (mut http, _) = listener.accept().await.expect("HTTP target request");
        let mut request = [0_u8; 2048];
        let _ = http.read(&mut request).await.expect("read target request");
        let body = json!([{
            "id": "target-forensics",
            "type": "page",
            "url": "https://www.xiaohongshu.com/explore",
            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/target-forensics")
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
        let mut requests: Vec<Value> = Vec::new();
        let mut typed = String::new();
        let mut focused = false;
        let mut character_keydowns = 0_usize;
        while let Some(Ok(Message::Text(raw))) = websocket.next().await {
            let request: Value = serde_json::from_str(&raw).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let method = request["method"].as_str().unwrap_or_default().to_owned();
            let event_type = request
                .pointer("/params/type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let key = request
                .pointer("/params/key")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let character = request
                .pointer("/params/text")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let expression = request
                .pointer("/params/expression")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();

            let is_character_keydown = method == "Input.dispatchKeyEvent"
                && event_type == "keyDown"
                && key != "Enter"
                && key != "Backspace"
                && character.is_some();
            if is_character_keydown {
                character_keydowns += 1;
            }
            if is_character_keydown && fail_character_keydown_at == Some(character_keydowns) {
                requests.push(request);
                websocket
                    .send(Message::Text(
                        json!({"id": id, "error": {"code": -32000, "message": "synthetic keydown failure"}})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .expect("CDP error response");
                continue;
            }

            // 「打完字之后」的那次回读：清空阶段那次（此时还没打过字）不受 knob 影响。
            let is_post_type_readback = method == "Runtime.evaluate"
                && expression.contains("'value' in e")
                && !typed.is_empty();
            if is_post_type_readback && readback == Readback::ChannelError {
                requests.push(request);
                websocket
                    .send(Message::Text(
                        json!({"id": id, "error": {"code": -32000, "message": "synthetic readback failure"}})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .expect("CDP error response");
                continue;
            }

            let response = if method == "Page.getLayoutMetrics" {
                json!({"cssVisualViewport": {"clientWidth": 1000.0, "clientHeight": 800.0}})
            } else if method == "Page.captureScreenshot" {
                json!({"data": "YWJj"})
            } else if method == "Input.dispatchMouseEvent" && event_type == "mouseReleased" {
                focused = focus_after_click;
                json!({})
            } else if method == "Input.dispatchKeyEvent" && event_type == "keyDown" {
                if key == "Backspace" {
                    if focused {
                        typed.clear();
                    }
                } else if focused && let Some(value) = &character {
                    typed.push_str(value);
                }
                json!({})
            } else if method == "Runtime.evaluate" && expression.contains("editable?'editable'") {
                json!({"result": {"value": if focused { "editable:INPUT" } else { "none:BODY" }}})
            } else if method == "Runtime.evaluate" && expression.contains("selectNodeContents") {
                json!({"result": {"value": focused}})
            } else if method == "Runtime.evaluate" && expression.contains("'value' in e") {
                match (is_post_type_readback, readback) {
                    (true, Readback::Wrong) => {
                        json!({"result": {"value": format!("{typed}-drift")}})
                    }
                    (true, Readback::Null) => json!({"result": {"value": Value::Null}}),
                    _ => json!({"result": {"value": typed.clone()}}),
                }
            } else if method == "Runtime.evaluate" && expression.contains("feedCardCount") {
                json!({"result": {"value": {
                    "href": "https://www.xiaohongshu.com/explore",
                    "readyState": "complete",
                    "feedCardCount": 3,
                    "noteDetailCount": 0,
                    "loginWallCount": 0,
                    "captchaSignalCount": 0,
                    "dialogCount": 0,
                    "profileSignalCount": 0,
                    "notificationSignalCount": 0,
                    "publishSignalCount": 0,
                    "errorSignalCount": 0,
                    "mainCount": 1
                }}})
            } else {
                json!({})
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id": id, "result": response}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}

fn character_keydown_count(requests: &[Value]) -> usize {
    requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchKeyEvent"
                && request["params"]["type"] == "keyDown"
                && request["params"]["key"] != "Enter"
                && request["params"]["key"] != "Backspace"
                && request["params"].get("text").is_some()
        })
        .count()
}

fn enter_keydown_count(requests: &[Value]) -> usize {
    requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchKeyEvent"
                && request["params"]["type"] == "keyDown"
                && request["params"]["key"] == "Enter"
        })
        .count()
}

#[tokio::test]
async fn a_completed_captcha_assist_reports_all_six_forensic_facts() {
    let (port, server) = spawn_captcha_cdp(true, None, Readback::Echo).await;
    let (phase, receipt, requests) = run_assist(
        port,
        server,
        "incident-complete",
        Some("aB12"),
        Some("enter"),
    )
    .await;

    assert_eq!(phase, EffectPhase::Confirmed);
    assert_eq!(receipt.reason.as_deref(), Some("cleared"));
    let report = receipt.type_report.expect("完整链路必须产出键入取证");
    assert_eq!(report.focus, "editable");
    assert_eq!(report.focus_tag.as_deref(), Some("INPUT"));
    assert_eq!(report.cleared.as_deref(), Some("verified"));
    assert_eq!(report.typed, 4);
    assert_eq!(report.verified.as_deref(), Some("match"));
    assert!(report.submitted);
    assert_eq!(character_keydown_count(&requests), 4);
    assert_eq!(enter_keydown_count(&requests), 1);
}

#[tokio::test]
async fn a_captcha_assist_without_focus_reports_zero_dispatch_instead_of_claiming_a_type() {
    let (port, server) = spawn_captcha_cdp(false, None, Readback::Echo).await;
    let (_, receipt, requests) = run_assist(
        port,
        server,
        "incident-no-focus",
        Some("aB12"),
        Some("enter"),
    )
    .await;

    assert_eq!(receipt.reason.as_deref(), Some("captcha_input_not_focused"));
    // 焦点档**读得到**（是 none），故取证在场；缺席只留给「读不到」。
    let report = receipt.type_report.expect("焦点没落定也是一份确定的取证");
    assert_eq!(report.focus, "none");
    assert_eq!(report.typed, 0);
    assert!(!report.submitted);
    assert_eq!(report.cleared, None);
    assert_eq!(report.verified, None);
    // 零派发是硬约束：一个字符按键都不许出去，Enter 更不许。
    assert_eq!(character_keydown_count(&requests), 0);
    assert_eq!(enter_keydown_count(&requests), 0);
}

#[tokio::test]
async fn an_interrupted_captcha_assist_reports_the_characters_it_actually_dispatched() {
    // 第 4 个字符的按下失败：真实派发数确定为 3，与请求文本长度 6 明确不同。
    let (port, server) = spawn_captcha_cdp(true, Some(4), Readback::Echo).await;
    let (_, receipt, requests) = run_assist(
        port,
        server,
        "incident-interrupted",
        Some("abcdef"),
        Some("enter"),
    )
    .await;

    assert_eq!(receipt.reason.as_deref(), Some("captcha_type_failed"));
    let report = receipt.type_report.expect("中途失败同样要给出取证");
    assert_eq!(
        report.typed, 3,
        "取证的字符数必须是实际派发数，MUST NOT 回退成请求文本长度"
    );
    assert_ne!(report.typed, "abcdef".chars().count());
    assert!(!report.submitted, "键入没打完就绝不提交");
    assert_eq!(report.cleared.as_deref(), Some("verified"));
    // 回读根本没走到，结论必须缺席而不是被填成 mismatch。
    assert_eq!(report.verified, None);
    assert_eq!(enter_keydown_count(&requests), 0);
}

#[tokio::test]
async fn a_click_only_captcha_assist_carries_no_type_report_field_at_all() {
    let (port, server) = spawn_captcha_cdp(true, None, Readback::Echo).await;
    let (_, receipt, requests) = run_assist(port, server, "incident-click-only", None, None).await;

    assert_eq!(receipt.reason.as_deref(), Some("cleared"));
    assert!(receipt.type_report.is_none());
    // 线上形状：整格**缺席**，不是 `typeReport: null`——宿主对回执做盲展开，
    // 一格 null 会被读成「有一段空取证」，并原样发到云端。
    let wire = serde_json::to_value(CommandOutput::ActionReceipt(receipt)).expect("wire JSON");
    assert!(wire.pointer("/value/typeReport").is_none());
    assert_eq!(character_keydown_count(&requests), 0);
}

/// 回读是**三态**，不是布尔：读到且一致 / 读到但不一致 / 根本没读到。
///
/// 退役实现把「没读到」压成「不一致」——那是把不知道说成知道。三种形态在这里必须各有各的说法，
/// 而且不论哪一种，**已经打进去的字符数都不许跟着结论一起蒸发**，也都不许继续提交。
#[tokio::test]
async fn captcha_readback_keeps_unread_and_read_but_wrong_as_two_states() {
    let (port, server) = spawn_captcha_cdp(true, None, Readback::Wrong).await;
    let (_, receipt, requests) =
        run_assist(port, server, "incident-drift", Some("aB12"), Some("enter")).await;
    assert_eq!(receipt.reason.as_deref(), Some("text_readback_mismatch"));
    let report = receipt.type_report.expect("读到了坏消息也是一份取证");
    assert_eq!(report.verified.as_deref(), Some("mismatch"));
    assert_eq!(report.typed, 4);
    assert!(!report.submitted);
    assert_eq!(enter_keydown_count(&requests), 0);

    let (port, server) = spawn_captcha_cdp(true, None, Readback::Null).await;
    let (_, receipt, requests) = run_assist(
        port,
        server,
        "incident-unreadable",
        Some("aB12"),
        Some("enter"),
    )
    .await;
    assert_eq!(receipt.reason.as_deref(), Some("text_readback_unreadable"));
    let report = receipt.type_report.expect("没读到同样要给出取证");
    assert_eq!(
        report.verified.as_deref(),
        Some("unverifiable"),
        "页面说「此刻没有可读的焦点元素」是结构上验不了，MUST NOT 记成「不一致」"
    );
    assert_eq!(report.typed, 4);
    assert_eq!(enter_keydown_count(&requests), 0);

    let (port, server) = spawn_captcha_cdp(true, None, Readback::ChannelError).await;
    let (_, receipt, requests) = run_assist(
        port,
        server,
        "incident-readback-down",
        Some("aB12"),
        Some("enter"),
    )
    .await;
    assert_eq!(receipt.reason.as_deref(), Some("text_readback_failed"));
    let report = receipt
        .type_report
        .expect("回读通道失败也不该让取证整份消失");
    assert_eq!(
        report.verified, None,
        "回读通道本身失败时连「验不了」都说不出口，这一格必须整格缺席"
    );
    assert_eq!(
        report.typed, 4,
        "回读失败不改变「已经打进去四个字符」这个既成事实"
    );
    assert_eq!(enter_keydown_count(&requests), 0);
}
