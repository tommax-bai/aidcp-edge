//! 指针原语的执行契约（假 CDP 层）。
//!
//! 锁三件事：
//! ① **按下失败仍补发抬起**——按下发了、抬起没发 = 左键按住不放，此后所有移动都变成拖拽 /
//!    框选，页面被不可见地污染，而调用方只看到一个普通异常。这是「已执行、未后置校验」窗口
//!    的最恶形态。
//! ② **按下已派发的失败必须如实说**——绝不能被上游读成「压根没点」而重投（那会双发）。
//! ③ **点击不是坐标瞬移**——一次点击派发多帧移动，且反应浮层那一步的路径贴住
//!    「控件 → 浮层」走廊、不过冲（过冲会甩出浮层 hover 区致其收起）。

use aidcp_page_engine::command::{CommentParams, NoteInteractionParams};
use aidcp_page_engine::engine::Engine;
use aidcp_page_engine::protocol::{
    CommandRecord, NativeCommand, Platform, SessionOpenParams, SessionOpenRecord,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

const NOTE_ID: &str = "https://www.facebook.com/groups/42/posts/7";
const FEED_NOTE_ID: &str = "https://www.facebook.com/Alice/posts/pfbidTARGET";
/// 帖级 react 控件坐标（走廊起点）与浮层「赞」项坐标（走廊终点）。
const CORRIDOR_FROM: (f64, f64) = (320.0, 620.0);
const CORRIDOR_TO: (f64, f64) = (420.0, 470.0);

#[tokio::test]
async fn a_failed_press_still_dispatches_its_release_and_never_reports_not_started() {
    let (port, server) = spawn_pointer_cdp(true).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open Facebook session");
    let outcome = engine.execute(&comment_command()).await.expect("receipt");
    engine.shutdown().await;

    let error = outcome.error.expect("按下失败必须上抛，不得被吞成成功");
    assert!(
        error.message.contains("already dispatched"),
        "按下已派发的失败必须如实标注，实得：{}",
        error.message
    );
    assert!(
        error.message.contains("MUST NOT be replayed"),
        "已派发的提交必须显式禁止被当成「未开始」重投，实得：{}",
        error.message
    );
    // 已知缺口（不在本轮改动面内）：命令层把任何带错误的写一律记成「未开始」这一步在引擎
    // 主干里，本轮不动那个文件。真相目前只由上面这条错误文案承载，尚未反映到阶段字段上。

    let requests = server.await.expect("pointer fake CDP");
    let pressed = count_mouse(&requests, "mousePressed");
    let released = count_mouse(&requests, "mouseReleased");
    assert_eq!(pressed, 1);
    assert_eq!(
        released, pressed,
        "按下失败也必须补发抬起，否则左键留在按下状态"
    );
    let press_index = index_of_mouse(&requests, "mousePressed").expect("press");
    let release_index = index_of_mouse(&requests, "mouseReleased").expect("release");
    assert!(release_index > press_index, "抬起必须紧随按下");
}

#[tokio::test]
async fn a_click_moves_frame_by_frame_instead_of_teleporting_to_the_target() {
    let (port, server) = spawn_pointer_cdp(false).await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open Facebook session");
    let _ = engine.execute(&comment_command()).await.expect("receipt");
    engine.shutdown().await;

    let requests = server.await.expect("pointer fake CDP");
    let moves = count_mouse(&requests, "mouseMoved");
    assert!(
        moves > 1,
        "一次点击只发一帧移动就等于瞬移到目标坐标，实得 {moves} 帧"
    );
    let press_index = index_of_mouse(&requests, "mousePressed").expect("press");
    assert!(
        index_of_mouse(&requests, "mouseMoved").expect("move") < press_index,
        "移动必须发生在按下之前"
    );
}

#[tokio::test]
async fn the_reaction_picker_commit_stays_inside_the_control_to_flyout_corridor() {
    let (port, server) = spawn_feed_like_picker_cdp().await;
    let mut engine = Engine::default();
    let mut open = session_open(port);
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 30_000;
    engine.open(&open).await.expect("open Facebook session");
    let _ = engine.execute(&like_command()).await.expect("like receipt");
    engine.shutdown().await;

    let requests = server.await.expect("picker fake CDP");
    // 浮层提交那一段轨迹：起点是帖级 react 控件坐标，终点是浮层「赞」项坐标。
    let press_index = index_of_mouse(&requests, "mousePressed").expect("picker press");
    let corridor: Vec<(f64, f64)> = requests
        .iter()
        .take(press_index)
        .filter(|request| {
            request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mouseMoved"
        })
        .filter_map(|request| {
            Some((
                request["params"]["x"].as_f64()?,
                request["params"]["y"].as_f64()?,
            ))
        })
        .collect();
    assert!(corridor.len() > 1, "浮层提交同样不得瞬移");
    // 走廊 = 两点外接框加一圈余量（弧线与落点抖动都在这圈里）。禁过冲保证不会越出终点一侧。
    let margin = 0.35 * (CORRIDOR_TO.0 - CORRIDOR_FROM.0).hypot(CORRIDOR_TO.1 - CORRIDOR_FROM.1);
    let min_x = CORRIDOR_FROM.0.min(CORRIDOR_TO.0) - margin;
    let max_x = CORRIDOR_FROM.0.max(CORRIDOR_TO.0) + margin;
    let min_y = CORRIDOR_FROM.1.min(CORRIDOR_TO.1) - margin;
    let max_y = CORRIDOR_FROM.1.max(CORRIDOR_TO.1) + margin;
    for (x, y) in &corridor {
        assert!(
            (min_x..=max_x).contains(x) && (min_y..=max_y).contains(y),
            "移动路径越出「控件 → 浮层」走廊：({x}, {y})"
        );
    }
    let last = corridor.last().copied().expect("landing frame");
    assert!(
        last.1 >= CORRIDOR_TO.1 - 4.0,
        "禁过冲：末帧不得越过浮层项落点"
    );
}

fn count_mouse(requests: &[Value], kind: &str) -> usize {
    requests
        .iter()
        .filter(|request| {
            request["method"] == "Input.dispatchMouseEvent" && request["params"]["type"] == kind
        })
        .count()
}

fn index_of_mouse(requests: &[Value], kind: &str) -> Option<usize> {
    requests.iter().position(|request| {
        request["method"] == "Input.dispatchMouseEvent" && request["params"]["type"] == kind
    })
}

fn session_open(port: u16) -> SessionOpenRecord {
    SessionOpenRecord {
        protocol_version: 2,
        id: "open-pointer".to_owned(),
        session_id: "session-pointer".to_owned(),
        task_id: "browse-pointer".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Facebook,
            timeout_ms: 30_000,
        },
    }
}

fn comment_command() -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: "pointer-comment-1".to_owned(),
        session_id: "session-pointer".to_owned(),
        task_id: "browse-pointer".to_owned(),
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
    }
}

fn like_command() -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: "pointer-like-1".to_owned(),
        session_id: "session-pointer".to_owned(),
        task_id: "browse-pointer".to_owned(),
        command_id: 1,
        deadline_unix_ms: unix_time_ms() + 30_000,
        command: NativeCommand::InteractionLike(NoteInteractionParams {
            note_id: FEED_NOTE_ID.to_owned(),
            reason: Some("feed_like".to_owned()),
            think_ms: None,
        }),
    }
}

/// 折叠态评论入口的最小场景：一次入口点击。`reject_press` 为真时按下被 CDP 拒绝。
async fn spawn_pointer_cdp(reject_press: bool) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing(&listener, port, "/groups/42/posts/7", "target-pointer").await;
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
            let press = request["method"] == "Input.dispatchMouseEvent"
                && request["params"]["type"] == "mousePressed";
            if press {
                entry_clicked = true;
            }
            let expression = request["params"]["expression"].as_str().unwrap_or_default();
            let response = if press && reject_press {
                json!({"id":id,"error":{"code":-32000,"message":"pointer press rejected"}})
            } else {
                let result = if expression.contains(r#""kind":"page_probe""#) {
                    runtime_value("page_probe", note_detail_probe())
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
                    runtime_value(
                        "point_target",
                        json!({"ok": true, "cx": 300.0, "cy": 460.0}),
                    )
                } else if expression.contains(r#""kind":"comment_ack_probe""#) {
                    runtime_value(
                        "comment_ack_probe",
                        json!({"confirmed": false, "rejected": false, "pending": false}),
                    )
                } else {
                    json!({})
                };
                json!({"id":id,"result":result})
            };
            websocket
                .send(Message::Text(response.to_string().into()))
                .await
                .expect("CDP response");
            requests.push(request);
        }
        requests
    });
    (port, server)
}

/// 首页两步点赞：主控件提交后状态未翻转，落到反应浮层那一步。
async fn spawn_feed_like_picker_cdp() -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing(&listener, port, "/", "target-picker").await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let mut requests = Vec::new();
        let mut picker_probed = false;
        while let Some(message) = websocket.next().await {
            let message = message.expect("valid CDP request");
            let Message::Text(text) = message else {
                continue;
            };
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let expression = request["params"]["expression"].as_str().unwrap_or_default();
            let result = if expression.contains(r#""kind":"page_probe""#) {
                runtime_value("page_probe", home_probe())
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
                runtime_value(
                    "feed_like_target_probe",
                    json!({
                        "ok": true,
                        "noteId": FEED_NOTE_ID,
                        "state": "neutral",
                        "cx": CORRIDOR_FROM.0,
                        "cy": CORRIDOR_FROM.1,
                        "top": 600.0,
                        "bottom": 640.0,
                        "viewportHeight": 800.0,
                        "inViewport": true
                    }),
                )
            } else if expression.contains(r#""kind":"feed_like_commit""#) {
                runtime_value(
                    "feed_like_commit",
                    json!({"started": true, "already": false, "noteId": FEED_NOTE_ID}),
                )
            } else if expression.contains(r#""kind":"feed_like_verify""#) {
                runtime_value(
                    "feed_like_verify",
                    json!({
                        "state": if picker_probed {"confirmed"} else {"picker_open"},
                        "noteId": FEED_NOTE_ID
                    }),
                )
            } else if expression.contains(r#""kind":"feed_like_picker_probe""#) {
                picker_probed = true;
                runtime_value(
                    "feed_like_picker_probe",
                    json!({
                        "ok": true,
                        "cx": CORRIDOR_TO.0,
                        "cy": CORRIDOR_TO.1,
                        "fromX": CORRIDOR_FROM.0,
                        "fromY": CORRIDOR_FROM.1
                    }),
                )
            } else if expression.contains(r#""kind":"feed_like_clear""#) {
                runtime_value("feed_like_clear", json!({"cleared": true}))
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

fn note_detail_probe() -> Value {
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

fn home_probe() -> Value {
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
    })
}

fn runtime_value(kind: &str, value: Value) -> Value {
    json!({"result":{"value":{
        "effectPhase":"confirmed",
        "output":{"kind":kind,"value":value}
    }}})
}

async fn serve_target_listing(listener: &TcpListener, port: u16, path: &str, target_id: &str) {
    let (mut http, _) = listener.accept().await.expect("HTTP target request");
    let mut request = [0_u8; 2048];
    let _ = http.read(&mut request).await.expect("read target request");
    let body = json!([{
        "id": target_id,
        "type": "page",
        "url": format!("https://www.facebook.com{path}"),
        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/{target_id}")
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
