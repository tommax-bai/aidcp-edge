use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn process_accepts_cancel_while_cdp_command_is_in_flight() {
    let (port, server) = spawn_stalling_cdp().await;
    let mut child = Command::new(env!("CARGO_BIN_EXE_aidcp-page-engine"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn engine");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout")).lines();

    let ready = read_json_line(&mut stdout).await;
    assert_eq!(ready["protocolVersion"], 2);

    write_json_line(
        &mut stdin,
        json!({
            "type": "session_open",
            "protocolVersion": 2,
            "id": "open-1",
            "sessionId": "session-1",
            "taskId": "task-1",
            "params": {
                "host": "127.0.0.1",
                "port": port,
                "platform": "xiaohongshu",
                "timeoutMs": 2000
            }
        }),
    )
    .await;
    let opened = read_json_line(&mut stdout).await;
    assert_eq!(opened["ok"], true);

    write_json_line(
        &mut stdin,
        json!({
            "type": "command",
            "protocolVersion": 2,
            "id": "command-1",
            "sessionId": "session-1",
            "taskId": "task-1",
            "commandId": 1,
            "deadlineUnixMs": unix_time_ms() + 5000,
            "command": { "kind": "page_probe", "params": {} }
        }),
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    write_json_line(
        &mut stdin,
        json!({
            "type": "cancel",
            "protocolVersion": 2,
            "id": "cancel-1",
            "sessionId": "session-1",
            "taskId": "task-1",
            "commandId": 1,
            "reason": "test_cancel"
        }),
    )
    .await;

    let first = read_json_line(&mut stdout).await;
    let second = read_json_line(&mut stdout).await;
    let records = [first, second];
    let cancel = records
        .iter()
        .find(|record| record["id"] == "cancel-1")
        .expect("cancel response");
    assert_eq!(cancel["result"]["accepted"], true);
    let command = records
        .iter()
        .find(|record| record["id"] == "command-1")
        .expect("command result");
    assert_eq!(command["effectPhase"], "not_started");
    assert_eq!(command["reasonCode"], "cancelled");
    assert_eq!(command["ok"], false);

    write_json_line(
        &mut stdin,
        json!({
            "type": "shutdown",
            "protocolVersion": 2,
            "id": "shutdown-1"
        }),
    )
    .await;
    let shutdown = read_json_line(&mut stdout).await;
    assert_eq!(shutdown["ok"], true);
    let status = child.wait().await.expect("engine exit");
    assert!(status.success());
    server.abort();
}

async fn spawn_stalling_cdp() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        let (mut http, _) = listener.accept().await.expect("HTTP target request");
        let mut request = [0_u8; 2048];
        let _ = http.read(&mut request).await.expect("read HTTP request");
        let body = json!([{
            "id": "target-1",
            "type": "page",
            "url": "https://www.xiaohongshu.com/explore",
            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/target-1")
        }])
        .to_string();
        let headers = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        http.write_all(headers.as_bytes()).await.expect("headers");
        http.write_all(body.as_bytes()).await.expect("body");

        let (stream, _) = listener.accept().await.expect("WebSocket request");
        let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
        let enable = websocket
            .next()
            .await
            .expect("enable request")
            .expect("enable message");
        let Message::Text(enable) = enable else {
            panic!("expected text enable");
        };
        let enable: Value = serde_json::from_str(&enable).expect("enable JSON");
        websocket
            .send(Message::Text(
                json!({"id":enable["id"],"result":{}}).to_string().into(),
            ))
            .await
            .expect("enable response");
        for _ in 0..2 {
            let enable = websocket
                .next()
                .await
                .expect("domain enable request")
                .expect("domain enable message");
            let Message::Text(enable) = enable else {
                panic!("expected text enable");
            };
            let enable: Value = serde_json::from_str(&enable).expect("enable JSON");
            websocket
                .send(Message::Text(
                    json!({"id":enable["id"],"result":{}}).to_string().into(),
                ))
                .await
                .expect("enable response");
        }
        let _evaluate = websocket.next().await;
        while let Some(message) = websocket.next().await {
            if matches!(message, Ok(Message::Close(_))) {
                break;
            }
        }
    });
    (port, server)
}

async fn write_json_line(stdin: &mut tokio::process::ChildStdin, value: Value) {
    stdin
        .write_all(format!("{}\n", value).as_bytes())
        .await
        .expect("write engine record");
    stdin.flush().await.expect("flush engine record");
}

async fn read_json_line(
    stdout: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
) -> Value {
    let line = tokio::time::timeout(std::time::Duration::from_secs(5), stdout.next_line())
        .await
        .expect("engine response timeout")
        .expect("engine stdout")
        .expect("engine response");
    serde_json::from_str(&line).expect("engine response JSON")
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
