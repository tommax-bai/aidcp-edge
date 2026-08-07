use aidcp_page_engine::command::NoteInteractionParams;
use aidcp_page_engine::engine::{CommandOutput, Engine};
use aidcp_page_engine::error::ErrorCode;
use aidcp_page_engine::protocol::{
    CommandRecord, EffectPhase, NativeCommand, Platform, SessionOpenParams, SessionOpenRecord,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn primary_commit_uses_dom_evaluation_without_pointer_press() {
    let (port, server) = spawn_facebook_feed_like_cdp(false).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open Facebook session");

    let outcome = engine
        .execute(&like_command("facebook-feed-like-1"))
        .await
        .expect("Facebook Feed like");
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::ActionReceipt(receipt) = outcome.output.expect("like receipt") else {
        panic!("expected action receipt")
    };
    assert!(receipt.ok);
    assert_eq!(receipt.action, "like");

    engine.shutdown().await;
    let requests = server.await.expect("Facebook Feed like fake CDP");
    assert!(requests.iter().any(|request| {
        request["params"]["expression"]
            .as_str()
            .is_some_and(|expression| expression.contains(r#""kind":"feed_like_commit""#))
    }));
    assert!(requests.iter().all(|request| {
        request["method"] != "Input.dispatchMouseEvent"
            || request["params"]["type"] != "mousePressed"
    }));
}

#[tokio::test]
async fn picker_dispatches_exactly_one_pointer_commit_after_probe() {
    let (port, server) = spawn_facebook_feed_like_cdp(true).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open Facebook session");

    let outcome = engine
        .execute(&like_command("facebook-feed-like-picker-1"))
        .await
        .expect("Facebook Feed picker like");
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);

    engine.shutdown().await;
    let requests = server.await.expect("Facebook Feed picker fake CDP");
    let picker_index = requests
        .iter()
        .position(|request| {
            request["params"]["expression"]
                .as_str()
                .is_some_and(|expression| expression.contains(r#""kind":"feed_like_picker_probe""#))
        })
        .expect("picker probe");
    let pressed = requests
        .iter()
        .enumerate()
        .filter(|(_, request)| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mousePressed"
        })
        .collect::<Vec<_>>();
    let released = requests
        .iter()
        .enumerate()
        .filter(|(_, request)| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseReleased"
        })
        .collect::<Vec<_>>();
    assert_eq!(pressed.len(), 1);
    assert_eq!(released.len(), 1);
    assert!(pressed[0].0 > picker_index);
    assert!(released[0].0 > pressed[0].0);
}

/// 对齐滚动此前**零假 CDP 覆盖**：把它改回「单帧精确位移」不会有任何测试变红。
///
/// 这里钉的是手势形状——多帧滚轮 + 滚前先把光标移到落点。逐帧延迟的非恒定性由
/// `input.rs` 的轨迹层单测承担（假 CDP 记录里没有可靠的墙钟间隔可读，在这里断言
/// 「间隔不相等」等于断言测试机的调度抖动）。
#[tokio::test]
async fn align_scroll_uses_a_multi_frame_humanized_wheel_before_the_like() {
    let (port, server) = spawn_facebook_feed_like_cdp_with(false, 2, None).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open Facebook session");
    let outcome = engine
        .execute(&like_command("facebook-feed-like-align-1"))
        .await
        .expect("Facebook Feed like");
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    engine.shutdown().await;
    let requests = server.await.expect("Facebook Feed like fake CDP");

    let wheels: Vec<f64> = requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseWheel"
        })
        .filter_map(|request| request["params"]["deltaY"].as_f64())
        .collect();
    assert!(
        wheels.len() > 2,
        "两轮对齐滚动必须逐帧派发滚轮，实际 {} 帧",
        wheels.len()
    );
    // 单帧精确位移的形态是「一轮一帧、位移恰好等于控件偏移」。多帧包络下每帧都是小位移，
    // 且没有任何一帧等于整段位移 —— 这条断言正是用来杀掉「改回单帧」的。
    let total: f64 = wheels.iter().sum();
    assert!(
        wheels.iter().all(|delta| delta.abs() < total.abs()),
        "任何一帧都不该等于整段位移：{wheels:?}"
    );
    // 滚前先把光标移到可滚区：真人不会在光标停在别处时滚这一段。
    let first_wheel = requests
        .iter()
        .position(|request| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseWheel"
        })
        .expect("wheel dispatched");
    assert!(
        requests
            .iter()
            .take(first_wheel)
            .any(|request| request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseMoved"),
        "滚动前必须先移动光标"
    );
}

/// 对齐循环是**本可让位**的路径：它只是在滚动与重探，页面上还没有该账号名下的任何新痕迹。
///
/// 而点赞是**写命令**，宿主对写命令**刻意不做**外层的取消竞速（写到一半被撕断比等它跑完更坏）。
/// 所以在这条路径上，取消信号能不能被看见，完全取决于它有没有被传进循环里 ——
/// 接线前传的是 `None`，于是协调器已经叫停、对齐循环仍然一轮轮滚下去，
/// **并且滚到目标之后真的把赞点了出去**：一次已经被叫停的动作，在平台上留下了新痕迹。
#[tokio::test]
async fn align_scroll_yields_to_a_takeover_instead_of_liking_anyway() {
    let cancellation = Arc::new(AtomicBool::new(false));
    // 第一次目标探针回「不在视口」并**就地置位取消**；第二次就会回「在视口内」——
    // 接线前的实现会照常滚过去、照常提交。
    let (port, server) =
        spawn_facebook_feed_like_cancel_after_first_probe_cdp(cancellation.clone()).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open Facebook session");

    let outcome = engine
        .execute_cancellable(
            &like_command("facebook-feed-like-align-takeover"),
            cancellation.clone(),
        )
        .await
        .expect("command result");
    engine.shutdown().await;
    let requests = server.await.expect("Facebook Feed like fake CDP");

    assert_eq!(outcome.effect_phase, EffectPhase::NotStarted);
    assert_eq!(
        outcome.error.expect("叫停必须如实报出").code,
        ErrorCode::Cancelled
    );
    // 唯一真正要紧的那条：**叫停之后不许再写页面**。
    assert!(
        requests.iter().all(|request| {
            request["params"]["expression"]
                .as_str()
                .is_none_or(|expression| !expression.contains(r#""kind":"feed_like_commit""#))
        }),
        "已经叫停了还是把赞点了出去"
    );
}

fn session_open(port: u16) -> SessionOpenRecord {
    SessionOpenRecord {
        protocol_version: 2,
        id: "open-feed-like".to_owned(),
        session_id: "session-feed-like".to_owned(),
        task_id: "browse-feed-like".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Facebook,
            timeout_ms: 8_000,
            browser_debugger_url: None,
        },
    }
}

fn like_command(id: &str) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: id.to_owned(),
        session_id: "session-feed-like".to_owned(),
        task_id: "browse-feed-like".to_owned(),
        command_id: 1,
        deadline_unix_ms: unix_time_ms() + 8_000,
        command: NativeCommand::InteractionLike(NoteInteractionParams {
            note_id: "https://www.facebook.com/Alice/posts/pfbidTARGET".to_owned(),
            reason: Some("feed_like".to_owned()),
            think_ms: None,
            object: None,
        }),
    }
}

async fn spawn_facebook_feed_like_cdp(
    with_picker: bool,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    spawn_facebook_feed_like_cdp_with(with_picker, 0, None).await
}

/// 目标第一次回「不在视口」并同时置位取消；第二次回「在视口内」。
async fn spawn_facebook_feed_like_cancel_after_first_probe_cdp(
    cancellation: Arc<AtomicBool>,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    spawn_facebook_feed_like_cdp_with(false, 1, Some(cancellation)).await
}

/// `offscreen_rounds` = 前多少次目标探针回报「控件不在视口内」。每回报一次，宿主就会做一轮
/// 对齐滚动再重探 —— 这正是本文件此前完全没有覆盖到的那段路径。
async fn spawn_facebook_feed_like_cdp_with(
    with_picker: bool,
    offscreen_rounds: usize,
    cancel_after_first_probe: Option<Arc<AtomicBool>>,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing(&listener, port).await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut picker_probed = false;
        let mut target_probes = 0usize;
        while let Some(message) = websocket.next().await {
            let message = message.expect("valid CDP request");
            let Message::Text(text) = message else {
                continue;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let expression = request["params"]["expression"].as_str().unwrap_or_default();
            let result = if expression.contains(r#""kind":"page_probe""#) {
                runtime_value(
                    "page_probe",
                    json!({
                        "targetId": "",
                        "origin": "https://www.facebook.com",
                        "path": "/",
                        "readyState": "complete",
                        "pageKind": "home",
                        "signals": {
                            "feedCardCount": 1,
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
                    }),
                )
            } else if expression.contains(r#""kind":"consent_probe""#) {
                runtime_value(
                    "consent_probe",
                    json!({
                        "present": false,
                        "acceptAllAmbiguous": false,
                        "necessaryOnlyAmbiguous": false
                    }),
                )
            } else if expression.contains(r#""kind":"reel_probe""#) {
                runtime_value("reel_probe", json!({"ok":false,"reason":"not_reel"}))
            } else if expression.contains(r#""kind":"feed_like_target_probe""#) {
                target_probes += 1;
                let offscreen = target_probes <= offscreen_rounds;
                if target_probes == 1
                    && let Some(flag) = cancel_after_first_probe.as_ref()
                {
                    flag.store(true, Ordering::Release);
                }
                runtime_value(
                    "feed_like_target_probe",
                    json!({
                        "ok": true,
                        "noteId": "https://www.facebook.com/Alice/posts/pfbidTARGET",
                        "state": "neutral",
                        "cx": 320.0,
                        "cy": if offscreen { 1180.0 } else { 420.0 },
                        // 控件在视口下方 1160px 处：宿主要把它滚上来才动手。
                        "top": if offscreen { 1160.0 } else { 400.0 },
                        "bottom": if offscreen { 1200.0 } else { 440.0 },
                        "viewportHeight": 800.0,
                        "inViewport": !offscreen
                    }),
                )
            } else if expression.contains(r#""kind":"feed_like_commit""#) {
                runtime_value(
                    "feed_like_commit",
                    json!({
                        "started": true,
                        "already": false,
                        "noteId": "https://www.facebook.com/Alice/posts/pfbidTARGET"
                    }),
                )
            } else if expression.contains(r#""kind":"feed_like_verify""#) {
                runtime_value(
                    "feed_like_verify",
                    json!({
                        "state": if with_picker && !picker_probed {"picker_open"} else {"confirmed"},
                        "noteId": "https://www.facebook.com/Alice/posts/pfbidTARGET"
                    }),
                )
            } else if expression.contains(r#""kind":"feed_like_picker_probe""#) {
                picker_probed = true;
                runtime_value(
                    "feed_like_picker_probe",
                    if with_picker {
                        json!({
                            "ok": true,
                            "cx": 420.0,
                            "cy": 360.0,
                            "fromX": 320.0,
                            "fromY": 420.0
                        })
                    } else {
                        json!({"ok":false,"reason":"like_picker_not_found"})
                    },
                )
            } else if expression.contains(r#""kind":"feed_like_clear""#) {
                runtime_value("feed_like_clear", json!({"cleared":true}))
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
        "id": "target-feed-like",
        "type": "page",
        "url": "https://www.facebook.com/",
        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/target-feed-like")
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
