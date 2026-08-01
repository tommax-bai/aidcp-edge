//! 上传配图的判据必须绑定**本次**上传（change `extend-native-postcondition-coverage` §3.2）。
//!
//! 迁移后这条命令的判据是「那个序号位上存在预览图」——**上一次留下的残留预览同样满足**。
//! 于是一次根本没生效的上传照样回确认，上游据此一路走到提交，最后发出去的稿子少一张图或配错图。
//! 后置校验盘点里它因此记为 below_bar。
//!
//! 本组钉死四件事，每一件都对着一种「会被读成成功」的现场：
//!  ① 残留预览 **MUST NOT** 算证据：写下去了、那一位还是原来那张 ⇒ 不确定，不是确认；
//!  ② 真换了新的一张才算确认；
//!  ③ 「那一位的身份读不出来」与「那一位根本没有」是**两态**，各有各的原因码 ——
//!     压成一态就等于替页面下了个它从没说过的结论；
//!  ④ 基线读不到时**在写文件之前**停手：这时候什么都还没发生，回「未开始」是实话。
//!     带着读不到的基线写下去，判据就悄悄退回成「有预览图即可」——正是这次要消灭的那条。

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

/// 一份合法的授权发布图。引擎侧 `validate_publish_file` 只按扩展名 / 绝对路径 / 普通文件 /
/// 元数据可读放行（字节嗅探在宿主侧，见 `AC-PUB-N04`），所以夹具给个真实存在的小文件即可。
fn authorized_image(tag: &str) -> String {
    let path = std::env::temp_dir().join(format!("aidcp-upload-binding-{tag}.jpg"));
    std::fs::write(&path, b"fixture").expect("write fixture image");
    path.to_string_lossy().into_owned()
}

fn preview(id: &str) -> Value {
    json!({"index":0,"id":id,"blank":false})
}

/// 一次预览位读数。`items` 缺席 = 分片形状漂了（调用方读不出来），与「空列表」不是一回事。
fn previews(items: Vec<Value>) -> Value {
    json!({"result":{"value":{"found":true,"count":items.len(),"items":items}}})
}

fn unreadable_previews() -> Value {
    json!({"result":{"value":{"found":true,"count":0}}})
}

struct Outcome {
    phase: EffectPhase,
    ok: bool,
    error: Option<String>,
    file_dispatched: bool,
}

/// 跑一次上传命令。`reads` 是预览位读数脚本，**按顺序**消费：第 1 条是写文件之前的基线，
/// 其余是写之后的有界轮询；用完之后一直重复最后一条。
async fn run_upload(tag: &'static str, reads: Vec<Value>) -> Outcome {
    let (port, server) = spawn_publish_cdp(reads).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open session");
    let path = authorized_image(tag);
    let command: NativeCommand = serde_json::from_value(json!({
        "kind": "publish_upload_image",
        "params": {"recordId": 9, "seq": 2, "path": path, "imageIndex": 0}
    }))
    .expect("upload command");
    let result = engine
        .execute(&CommandRecord {
            protocol_version: 2,
            id: "command-upload".to_owned(),
            session_id: "session-upload".to_owned(),
            task_id: "publish-upload".to_owned(),
            command_id: 1,
            deadline_unix_ms: unix_time_ms() + 60_000,
            command,
        })
        .await
        .expect("execute upload");
    drop(engine);
    let requests = server.await.expect("fake CDP");

    let receipt = match result.output.expect("upload output") {
        CommandOutput::PublishReceipt(receipt) => receipt,
        other => panic!("上传回执必须仍是发布回执，云端按 recordId/seq 关联：{other:?}"),
    };
    assert_eq!(
        receipt.kind, "upload_image",
        "回执种类是云端的关联键，改了不会报错、只会让云端永远等不到这条"
    );
    Outcome {
        phase: result.effect_phase,
        ok: receipt.ok,
        error: receipt.error,
        file_dispatched: requests
            .iter()
            .any(|request| request["method"] == "DOM.setFileInputFiles"),
    }
}

#[tokio::test]
async fn a_residual_preview_is_never_evidence_that_this_upload_landed() {
    // 现场：上一次的预览还挂在第 0 位，这次的附件写下去之后页面毫无变化。
    // 旧判据「那一位上有预览图」在这里恒真 —— 一次没生效的上传会被回成确认。
    let outcome = run_upload(
        "residual",
        vec![
            previews(vec![preview("2a:deadbeef")]),
            previews(vec![preview("2a:deadbeef")]),
        ],
    )
    .await;

    assert!(
        outcome.file_dispatched,
        "附件确实写下去了，所以这条失败必须是「不确定」而不是「未开始」"
    );
    assert_eq!(outcome.phase, EffectPhase::Ambiguous);
    assert!(!outcome.ok);
    assert_eq!(
        outcome.error.as_deref(),
        Some("publish_upload_preview_not_new"),
        "原因码要说清「还是原来那张」，而不是笼统的未确认"
    );
}

#[tokio::test]
async fn a_preview_that_this_upload_produced_confirms_it() {
    // 基线是空的，写完之后第 0 位出现了一张基线里没有的图 —— 这才是这条命令的业务结果。
    let outcome = run_upload(
        "fresh",
        vec![previews(vec![]), previews(vec![preview("31:c0ffee00")])],
    )
    .await;

    assert!(outcome.file_dispatched);
    assert_eq!(outcome.phase, EffectPhase::Confirmed);
    assert!(outcome.ok);
    assert_eq!(outcome.error, None);
}

#[tokio::test]
async fn an_unreadable_identity_is_not_the_same_as_an_absent_preview() {
    // 那一位在，但地址读不出来。**MUST NOT** 当成「基线里没有 ⇒ 是新的」——
    // 空身份彼此相等，会让两张读不出地址的图互相冒充。也 MUST NOT 说成「那一位没有」。
    let blank = run_upload(
        "blank",
        vec![
            previews(vec![]),
            previews(vec![json!({"index":0,"id":"","blank":true})]),
        ],
    )
    .await;
    assert_eq!(blank.phase, EffectPhase::Ambiguous);
    assert_eq!(
        blank.error.as_deref(),
        Some("publish_upload_preview_unreadable")
    );

    // 同族的第二种现场：分片连 `blank` 这一格都没给（形状漂了）。**缺席不是「读到了一个否」**——
    // 判定必须落回「读不出来」，否则一个身份不明的预览位会被当成一张新图。
    // 这一条与上面那条不能合并：上面走的是显式 `blank:true`，这条走的是**缺省值**，
    // 而缺省值取悲观还是乐观，恰恰是这里唯一能证明的事。
    let missing_flag = run_upload(
        "missing-flag",
        vec![previews(vec![]), previews(vec![json!({"index":0,"id":""})])],
    )
    .await;
    assert_eq!(missing_flag.phase, EffectPhase::Ambiguous);
    assert_eq!(
        missing_flag.error.as_deref(),
        Some("publish_upload_preview_unreadable")
    );

    // 对照组：那一位真的不存在，原因码必须与上面两条**不同**。
    let absent = run_upload("absent", vec![previews(vec![]), previews(vec![])]).await;
    assert_eq!(absent.phase, EffectPhase::Ambiguous);
    assert_eq!(
        absent.error.as_deref(),
        Some("publish_upload_preview_absent"),
        "「读不出来」与「确实没有」压成一态，就等于替页面下了个它没说过的结论"
    );
}

#[tokio::test]
async fn an_unreadable_baseline_stops_before_the_file_is_ever_written() {
    // 基线读不到 ⇒ 这次上传**无从绑定**。此时唯一诚实的做法是在派发之前停手：
    // 继续写下去，判据就只剩「有预览图即可」，而那条正是本次要消灭的静默降级。
    let outcome = run_upload(
        "no-baseline",
        vec![
            unreadable_previews(),
            previews(vec![preview("31:c0ffee00")]),
        ],
    )
    .await;

    assert!(
        !outcome.file_dispatched,
        "基线读不到还把附件写下去，就是拿「不确定」换「假成功」"
    );
    assert_eq!(outcome.phase, EffectPhase::NotStarted);
    assert!(!outcome.ok);
    assert_eq!(
        outcome.error.as_deref(),
        Some("publish_upload_baseline_unreadable")
    );
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_millis() as u64
}

fn session_open(port: u16) -> SessionOpenRecord {
    SessionOpenRecord {
        protocol_version: 2,
        id: "open-upload".to_owned(),
        session_id: "session-upload".to_owned(),
        task_id: "publish-upload".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Xiaohongshu,
            timeout_ms: 30_000,
            browser_debugger_url: None,
        },
    }
}

/// 一台只管发布页的假 CDP：页面探针回创作页，预览位读数按脚本逐次给出，
/// 文件输入的定位与写入照常应答。
async fn spawn_publish_cdp(reads: Vec<Value>) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        let (mut http, _) = listener.accept().await.expect("HTTP target request");
        let mut request = [0_u8; 2048];
        let _ = http.read(&mut request).await.expect("read target request");
        let body = json!([{
            "id": "target-upload",
            "type": "page",
            "url": "https://creator.xiaohongshu.com/publish/publish",
            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/target-upload")
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
        let mut preview_reads = 0_usize;
        while let Some(Ok(Message::Text(text))) = websocket.next().await {
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let method = request["method"].as_str().unwrap_or_default().to_owned();
            let expression = request
                .pointer("/params/expression")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let response = if method == "Runtime.evaluate"
                && expression.contains("\"publish_previews\"")
            {
                let value = reads
                    .get(preview_reads)
                    .or_else(|| reads.last())
                    .cloned()
                    .expect("preview read script must not be empty");
                preview_reads += 1;
                value
            } else if method == "Runtime.evaluate" && expression.contains("feedCardCount") {
                json!({"result":{"value":{
                    "href": "https://creator.xiaohongshu.com/publish/publish",
                    "readyState": "complete",
                    "feedCardCount": 0,
                    "noteDetailCount": 0,
                    "loginWallCount": 0,
                    "captchaSignalCount": 0,
                    "dialogCount": 0,
                    "profileSignalCount": 0,
                    "notificationSignalCount": 0,
                    "publishSignalCount": 1,
                    "errorSignalCount": 0,
                    "mainCount": 1
                }}})
            } else if method == "DOM.getDocument" {
                json!({"root":{"nodeId":1}})
            } else if method == "DOM.querySelector" {
                json!({"nodeId":42})
            } else if method == "Runtime.evaluate" {
                json!({"result":{"value":{
                    "effectPhase":"not_started",
                    "output":{"kind":"action_receipt","value":{"action":"noop","ok":false,"reason":"no_target"}}
                }}})
            } else {
                json!({})
            };
            requests.push(request);
            websocket
                .send(Message::Text(
                    json!({"id":id,"result":response}).to_string().into(),
                ))
                .await
                .expect("CDP response");
        }
        requests
    });
    (port, server)
}
