use aidcp_page_engine::command::NoteInteractionParams;
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
        }),
    }
}

async fn spawn_facebook_feed_like_cdp(
    with_picker: bool,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing(&listener, port).await;
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
                runtime_value(
                    "feed_like_target_probe",
                    json!({
                        "ok": true,
                        "noteId": "https://www.facebook.com/Alice/posts/pfbidTARGET",
                        "state": "neutral",
                        "cx": 320.0,
                        "cy": 420.0,
                        "top": 400.0,
                        "bottom": 440.0,
                        "viewportHeight": 800.0,
                        "inViewport": true
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
