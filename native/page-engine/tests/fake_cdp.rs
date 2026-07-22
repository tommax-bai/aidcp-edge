use aidcp_page_engine::command::ReasonParams;
use aidcp_page_engine::engine::{CommandOutput, Engine};
use aidcp_page_engine::protocol::{
    CommandRecord, EffectPhase, NativeCommand, PageProbeParams, Platform, SessionCloseRecord,
    SessionOpenParams, SessionOpenRecord,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn long_lived_engine_uses_correlated_fake_cdp_and_deduplicates_commands() {
    let (port, server) = spawn_fake_cdp().await;
    let mut engine = Engine::default();
    let open = session_open(port);
    let info = engine.open(&open).await.expect("open session");
    assert_eq!(info.state, "ready");
    assert_eq!(info.target_id, "target-1");

    let command = page_probe_command(1);
    let first = engine.execute(&command).await.expect("first probe");
    let CommandOutput::PageProbe(first_probe) = first.output.expect("first output") else {
        panic!("expected page probe output")
    };
    assert_eq!(first_probe.path, "/search_result_ai");

    let duplicate = engine.execute(&command).await.expect("deduplicated probe");
    let CommandOutput::PageProbe(duplicate_probe) = duplicate.output.expect("duplicate output")
    else {
        panic!("expected duplicate page probe output")
    };
    assert_eq!(duplicate_probe, first_probe);

    let closed = engine
        .close(&SessionCloseRecord {
            protocol_version: 2,
            id: "close-1".to_owned(),
            session_id: "session-1".to_owned(),
        })
        .await
        .expect("close session");
    assert_eq!(closed.state, "closed");
    server.await.expect("fake CDP server");
}

#[tokio::test]
async fn read_only_command_reconnects_once_without_replaying_a_write() {
    let (port, server) = spawn_disconnect_then_recover_cdp().await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open session");
    let outcome = engine
        .execute(&page_probe_command(1))
        .await
        .expect("reconnected probe");
    let CommandOutput::PageProbe(probe) = outcome.output.expect("probe output") else {
        panic!("expected reconnected page probe output")
    };
    assert_eq!(probe.page_kind, aidcp_page_engine::probe::PageKind::Explore);
    engine.shutdown().await;
    server.await.expect("reconnect server");
}

#[tokio::test]
async fn high_level_command_returns_a_bounded_typed_projection() {
    let (port, server) = spawn_router_result_cdp(false).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open session");
    let outcome = engine
        .execute(&browse_command(1))
        .await
        .expect("browse command");
    assert_eq!(outcome.effect_phase, EffectPhase::Confirmed);
    let CommandOutput::PageCards(cards) = outcome.output.expect("cards output") else {
        panic!("expected page cards output")
    };
    assert_eq!(cards.cards.len(), 1);
    assert_eq!(cards.cards[0].note_id.as_deref(), Some("n1"));
    engine.shutdown().await;
    server.await.expect("router result server");
}

#[tokio::test]
async fn dispatched_write_disconnect_is_ambiguous_and_is_not_replayed() {
    let (port, server) = spawn_router_result_cdp(true).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open session");
    let outcome = engine
        .execute(&browse_command(1))
        .await
        .expect("write result");
    assert_eq!(outcome.effect_phase, EffectPhase::Ambiguous);
    assert!(outcome.output.is_none());
    assert!(outcome.error.is_some());
    engine.shutdown().await;
    server.await.expect("write disconnect server");
}

fn session_open(port: u16) -> SessionOpenRecord {
    SessionOpenRecord {
        protocol_version: 2,
        id: "open-1".to_owned(),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Xiaohongshu,
            timeout_ms: 2_000,
        },
    }
}

fn page_probe_command(command_id: u64) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("command-{command_id}"),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + 2_000,
        command: NativeCommand::PageProbe(PageProbeParams::default()),
    }
}

fn browse_command(command_id: u64) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("command-{command_id}"),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + 2_000,
        command: NativeCommand::BrowseScroll(ReasonParams {
            reason: Some("initial_scan".to_owned()),
        }),
    }
}

async fn spawn_router_result_cdp(
    disconnect_after_dispatch: bool,
) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing(&listener, port).await;
        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        for _ in 0..3 {
            respond_to_call(&mut websocket, json!({})).await;
        }
        if disconnect_after_dispatch {
            let _ = websocket.next().await.expect("write dispatch");
            websocket
                .close(None)
                .await
                .expect("disconnect after dispatch");
            return;
        }
        respond_to_call(
            &mut websocket,
            json!({
                "result": { "value": {
                    "effectPhase": "confirmed",
                    "output": { "kind": "page_cards", "value": { "cards": [{
                        "index": 0, "title": "Native card", "likeCount": 1,
                        "collectCount": 2, "noteId": "n1"
                    }] } }
                } }
            }),
        )
        .await;
        let _ = websocket.close(None).await;
    });
    (port, server)
}

async fn spawn_fake_cdp() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        let (mut http, _) = listener.accept().await.expect("HTTP target request");
        let mut request = [0_u8; 2048];
        let _ = http.read(&mut request).await.expect("read target request");
        let body = json!([{
            "id": "target-1",
            "type": "page",
            "url": "https://www.xiaohongshu.com/search_result_ai?keyword=coffee",
            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/target-1")
        }])
        .to_string();
        let headers = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        http.write_all(headers.as_bytes()).await.expect("headers");
        http.write_all(body.as_bytes()).await.expect("body");
        http.shutdown().await.expect("HTTP shutdown");

        let (websocket_stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(websocket_stream)
            .await
            .expect("WebSocket handshake");
        respond_to_call(&mut websocket, json!({})).await;
        respond_to_call(&mut websocket, json!({})).await;
        respond_to_call(&mut websocket, json!({})).await;
        websocket
            .send(Message::Text(
                json!({"method":"Runtime.executionContextCreated","params":{}})
                    .to_string()
                    .into(),
            ))
            .await
            .expect("event");
        respond_to_call(
            &mut websocket,
            json!({
                "result": {
                    "value": {
                        "href": "https://www.xiaohongshu.com/search_result_ai?keyword=coffee",
                        "readyState": "complete",
                        "feedCardCount": 8,
                        "noteDetailCount": 0,
                        "loginWallCount": 0,
                        "captchaSignalCount": 0,
                        "dialogCount": 0,
                        "profileSignalCount": 0,
                        "mainCount": 1
                    }
                }
            }),
        )
        .await;
        let _ = websocket.close(None).await;
    });
    (port, server)
}

async fn spawn_disconnect_then_recover_cdp() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        serve_target_listing(&listener, port).await;
        let (first_stream, _) = listener.accept().await.expect("first WebSocket request");
        let mut first = accept_async(first_stream)
            .await
            .expect("first WebSocket handshake");
        respond_to_call(&mut first, json!({})).await;
        respond_to_call(&mut first, json!({})).await;
        respond_to_call(&mut first, json!({})).await;
        let _ = first.next().await.expect("first evaluate request");
        first.close(None).await.expect("first close");

        serve_target_listing(&listener, port).await;
        let (second_stream, _) = listener.accept().await.expect("second WebSocket request");
        let mut second = accept_async(second_stream)
            .await
            .expect("second WebSocket handshake");
        respond_to_call(&mut second, json!({})).await;
        respond_to_call(&mut second, json!({})).await;
        respond_to_call(&mut second, json!({})).await;
        respond_to_call(
            &mut second,
            json!({
                "result": {
                    "value": {
                        "href": "https://www.xiaohongshu.com/explore",
                        "readyState": "complete",
                        "feedCardCount": 6,
                        "noteDetailCount": 0,
                        "loginWallCount": 0,
                        "captchaSignalCount": 0,
                        "dialogCount": 0,
                        "profileSignalCount": 0,
                        "mainCount": 1
                    }
                }
            }),
        )
        .await;
        let _ = second.close(None).await;
    });
    (port, server)
}

async fn serve_target_listing(listener: &TcpListener, port: u16) {
    let (mut http, _) = listener.accept().await.expect("HTTP target request");
    let mut request = [0_u8; 2048];
    let _ = http.read(&mut request).await.expect("read target request");
    let body = json!([{
        "id": "target-1",
        "type": "page",
        "url": "https://www.xiaohongshu.com/explore",
        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/target-1")
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

async fn respond_to_call<S>(websocket: &mut tokio_tungstenite::WebSocketStream<S>, result: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let message = websocket
        .next()
        .await
        .expect("CDP request")
        .expect("valid CDP request");
    let Message::Text(text) = message else {
        panic!("expected text request");
    };
    let request: Value = serde_json::from_str(&text).expect("request JSON");
    let id = request["id"].as_u64().expect("request id");
    websocket
        .send(Message::Text(
            json!({"id":id,"result":result}).to_string().into(),
        ))
        .await
        .expect("CDP response");
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
