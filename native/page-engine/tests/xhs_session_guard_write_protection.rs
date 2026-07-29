//! 小红书不可逆写入的两道保护：**提交前的即席阻断复检** 与 **提交窗口**。
//!
//! 迁移后这两道在小红书上整段消失：执行入口的签名里根本没有提交窗口这一路（Facebook 分支拿到、
//! 小红书分支被丢弃），四处不可逆写入等价于「无声照写」；点赞 / 收藏 / 关注 / 评论也没有任何
//! 提交前闸，会一路在验证码墙上按下去，且没有一个诚实的原因码可回。
//!
//! 三条本组用例钉死的语义：
//!  ① 四条窗口契约的标签与预算是迁前实测值，**发布提交是 15s、不是 Facebook 的 20s**；
//!  ② 拿不到窗口 ⇒ 一个字节都不写页面，终局是**未开始**（而不是 ambiguous，更不是先写了再说）；
//!  ③ 提交前闸只认验证码与登录墙两桶；**页面类型未识别 MUST NOT 拒绝**；探测**本身**失败按「有挑战」保守拒绝。

use aidcp_page_engine::commit_window::xiaohongshu_commit_window;
use aidcp_page_engine::commit_window::{CommitWindowRequest, CommitWindowRequester};
use aidcp_page_engine::engine::{CommandOutput, DEFAULT_COMMAND_TIMEOUT_MS, Engine};
use aidcp_page_engine::error::ErrorCode;
use aidcp_page_engine::protocol::{
    CommandRecord, EffectPhase, NativeCommand, Platform, SessionOpenParams, SessionOpenRecord,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::{accept_async, tungstenite::Message};

fn command(raw: &str) -> NativeCommand {
    serde_json::from_str(raw).expect("native command fixture")
}

fn comment_command() -> NativeCommand {
    command(r#"{"kind":"interaction_comment","params":{"noteId":"note-1","text":"hi"}}"#)
}

#[test]
fn xiaohongshu_commit_window_contracts_keep_the_pre_migration_labels_and_budgets() {
    // 评论回车：点下即进入「已提交、结果未知」区，取消 = 把一条可能已发出的评论当成没发生。
    let comment = xiaohongshu_commit_window(&comment_command()).expect("comment window");
    assert_eq!(comment.label, "xhs_comment_submit");
    // 硬件级逐字输入整段落在窗口内之后，4s 必被打穿；预算抬到命令墙钟上限。
    // 打穿的后果实测是「窗口静默过期 ⇒ 抢占可以落在提交那一刻」，不是「写入被拒发」。
    // 判据是**这条恒等式**、不是某个具体毫秒数：命令上限是会被调的（曾整体 ×1.5），
    // 在这里手抄一个字面量等于把同一颗雷原样往后推一次。
    assert_eq!(comment.budget_ms, DEFAULT_COMMAND_TIMEOUT_MS);

    // 三条通知分类栏：点击**消费未读、无回滚**，窗口 MUST 覆盖点击那一刻。
    let comments = xiaohongshu_commit_window(&command(
        r#"{"kind":"notification_browse_comments","params":{}}"#,
    ))
    .expect("notification comments window");
    assert_eq!(comments.label, "xhs_notification_comments");
    assert_eq!(comments.budget_ms, 20_000);

    let likes = xiaohongshu_commit_window(&command(
        r#"{"kind":"notification_browse_likes","params":{}}"#,
    ))
    .expect("notification likes window");
    assert_eq!(likes.label, "xhs_notification_likes");
    assert_eq!(likes.budget_ms, 20_000);

    let follows = xiaohongshu_commit_window(&command(
        r#"{"kind":"notification_browse_follows","params":{}}"#,
    ))
    .expect("notification follows window");
    assert_eq!(follows.label, "xhs_notification_follows");
    assert_eq!(follows.budget_ms, 20_000);

    // 发布提交：迁前实测 15s。20s 是 Facebook 的 `fb_publish_submit`，两者 MUST NOT 混用。
    let publish = xiaohongshu_commit_window(&command(
        r#"{"kind":"publish_submit","params":{"recordId":7,"seq":3}}"#,
    ))
    .expect("publish window");
    assert_eq!(publish.label, "xhs_publish_submit");
    assert_eq!(publish.budget_ms, 15_000);
    assert_ne!(publish.budget_ms, 20_000, "发布提交的预算不得照抄 Facebook");

    // 读命令与可重放的导航不占窗口：把整条命令包进窗口等于把「不可逆写入保护」
    // 偷换成「命令期间禁抢占」，抢占能力会事实上失效。
    assert!(xiaohongshu_commit_window(&command(r#"{"kind":"page_scroll","params":{}}"#)).is_none());
    assert!(xiaohongshu_commit_window(&command(r#"{"kind":"page_probe","params":{}}"#)).is_none());
    assert!(
        xiaohongshu_commit_window(&command(
            r#"{"kind":"note_open","params":{"noteId":"note-1"}}"#
        ))
        .is_none()
    );
}

#[tokio::test]
async fn comment_submit_requests_its_commit_window_before_any_write_dispatch() {
    // 真正的不变量是**顺序**：提交窗口先于任何触碰页面的写动作，而不是「必须调用注入路由」。
    // 后者是迁移期的实现细节 —— 写动作一旦被引擎特化截走，那条断言会连同缺陷一起变绿。
    let observed_requests = Arc::new(AtomicUsize::new(0));
    let (port, server) =
        spawn_counted_xhs_cdp("note_detail", None, observed_requests.clone()).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open session");
    // 会话打开本身不该触碰页面：后面的「窗口之前只发生过阻断闸那一次探针」以此为基线。
    let baseline = observed_requests.load(Ordering::Acquire);

    let (sender, mut receiver) = mpsc::unbounded_channel::<CommitWindowRequest>();
    let seen_at_window = observed_requests.clone();
    let arbiter = tokio::spawn(async move {
        let request = receiver.recv().await.expect("commit window request");
        // 引擎此刻正阻塞等确认，计数在这一瞬是稳定的。
        let observed = (
            request.label,
            request.budget_ms,
            seen_at_window.load(Ordering::Acquire),
        );
        request.acknowledgement.send(true).expect("ack");
        observed
    });

    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, comment_command()),
            Arc::new(AtomicBool::new(false)),
            CommitWindowRequester::new(1, sender),
        )
        .await
        .expect("command result");

    let (label, budget_ms, requests_before_window) = arbiter.await.expect("arbiter");
    assert_eq!(label, "xhs_comment_submit");
    // 逐字输入整段落在窗口内，预算随之抬到命令墙钟上限（推导见 commit_window.rs）。
    // 同上：钉的是恒等式，不是字面量。
    assert_eq!(budget_ms, DEFAULT_COMMAND_TIMEOUT_MS);
    assert_eq!(
        requests_before_window - baseline,
        1,
        "开窗之前只允许发生提交前阻断闸那一次页面探针"
    );

    drop(engine);
    let requests = server.await.expect("fake CDP");
    // 窗口拿到之后引擎才继续往下走：请求总数必须真的增长过（否则上面那条计数断言恒真）。
    assert!(
        requests.len() > requests_before_window,
        "窗口拿到之后才允许继续触碰页面"
    );
    assert!(result.output.is_some() || result.error.is_some());
}

#[tokio::test]
async fn a_refused_commit_window_dispatches_nothing_and_terminates_as_not_started() {
    let (port, server) = spawn_xhs_cdp("note_detail", None).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open session");

    let (sender, mut receiver) = mpsc::unbounded_channel::<CommitWindowRequest>();
    let arbiter = tokio::spawn(async move {
        let request = receiver.recv().await.expect("commit window request");
        // 协调器不给窗口（另一独占任务正在写）。
        request.acknowledgement.send(false).expect("reject");
    });

    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, comment_command()),
            Arc::new(AtomicBool::new(false)),
            CommitWindowRequester::new(1, sender),
        )
        .await
        .expect("command result");
    arbiter.await.expect("arbiter");

    let error = result
        .error
        .expect("commit window refusal must be an honest failure");
    assert_eq!(error.code, ErrorCode::CommitWindowUnavailable);
    assert_eq!(
        result.effect_phase,
        EffectPhase::NotStarted,
        "拿不到窗口 = 一个字节都没写过页面，绝不含糊成 ambiguous"
    );

    drop(engine);
    let requests = server.await.expect("fake CDP");
    // 「某某不得出现」这种否定式检查会被特化悄悄喂成恒真（被禁的东西本来就不再产生了）。
    // 改成**穷举**：窗口被拒之后页面上只应留下阻断闸那一次探针，输入事件一个都没有。
    let evaluated: Vec<&str> = requests
        .iter()
        .filter(|entry| entry["method"] == "Runtime.evaluate")
        .map(|entry| {
            entry
                .pointer("/params/expression")
                .and_then(Value::as_str)
                .unwrap_or_default()
        })
        .collect();
    assert_eq!(
        evaluated.len(),
        1,
        "窗口被拒后除阻断闸那一次探针外不许再有任何求值：{evaluated:?}"
    );
    assert!(
        evaluated[0].contains("feedCardCount"),
        "那唯一一次求值就是提交前的阻断闸页面探针"
    );
    assert_eq!(
        requests
            .iter()
            .filter(|entry| entry["method"]
                .as_str()
                .is_some_and(|method| method.starts_with("Input.")))
            .count(),
        0,
        "窗口被拒时一个输入事件都不许派发"
    );
}

#[tokio::test]
async fn a_captcha_page_refuses_the_like_before_any_dispatch() {
    let (port, server) = spawn_xhs_cdp("captcha", None).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open session");

    let result = engine
        .execute(&write_command(
            1,
            command(r#"{"kind":"interaction_like","params":{"noteId":"note-1"}}"#),
        ))
        .await
        .expect("command result");

    assert_eq!(result.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::ActionReceipt(receipt) = result.output.expect("gate receipt") else {
        panic!("expected an action receipt");
    };
    assert_eq!(receipt.action, "like");
    assert!(!receipt.ok);
    assert_eq!(receipt.reason.as_deref(), Some("blocked_by_captcha"));

    drop(engine);
    let requests = server.await.expect("fake CDP");
    assert!(
        !requests.iter().any(|entry| {
            entry
                .pointer("/params/expression")
                .and_then(Value::as_str)
                .is_some_and(|expression| expression.contains(r#""kind":"interaction_like""#))
        }),
        "命中验证码即零派发：页面规则一次都不许被调用"
    );
}

#[tokio::test]
async fn a_login_wall_refuses_the_follow_with_its_own_reason() {
    let (port, server) = spawn_xhs_cdp("login", None).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open session");

    let result = engine
        .execute(&write_command(
            1,
            command(r#"{"kind":"interaction_follow","params":{"authorId":"author-1"}}"#),
        ))
        .await
        .expect("command result");

    assert_eq!(result.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::ActionReceipt(receipt) = result.output.expect("gate receipt") else {
        panic!("expected an action receipt");
    };
    assert_eq!(receipt.action, "follow");
    assert_eq!(receipt.reason.as_deref(), Some("login_required"));
    drop(engine);
    server.await.expect("fake CDP");
}

#[tokio::test]
async fn an_unidentified_page_kind_never_refuses_the_action() {
    // 小红书的看图态 / AI 搜索结果页 / 详情弹层都会落进「未识别」。把它算作拒绝
    // 等于把「没认出来」变成「所有互动都不做了」——那不是保守，那是停摆。
    let (port, server) = spawn_xhs_cdp("unknown", None).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open session");

    let _ = engine
        .execute(&write_command(
            1,
            command(r#"{"kind":"interaction_collect","params":{"noteId":"note-1"}}"#),
        ))
        .await
        .expect("command result");

    drop(engine);
    let requests = server.await.expect("fake CDP");
    assert!(
        requests.iter().any(|entry| {
            entry
                .pointer("/params/expression")
                .and_then(Value::as_str)
                .is_some_and(|expression| expression.contains(r#""kind":"interaction_collect""#))
        }),
        "页面类型未识别 MUST NOT 拒绝动作"
    );
}

#[tokio::test]
async fn an_unreadable_probe_refuses_conservatively_instead_of_failing_the_command() {
    // 复检拿不到判定：保守当成有挑战、零派发。错过一次点赞很便宜，点进风控墙很贵。
    // 注意方向——这一档是**诚实回执**，不是把一次探测抖动升级成整条命令的引擎错误。
    let (port, server) = spawn_xhs_cdp("note_detail", Some(json!({"exceptionDetails": {}}))).await;
    let mut engine = Engine::default();
    engine
        .open(&session_open(port))
        .await
        .expect("open session");

    let result = engine
        .execute(&write_command(
            1,
            command(r#"{"kind":"interaction_like","params":{"noteId":"note-1"}}"#),
        ))
        .await
        .expect("command result");

    assert!(result.error.is_none(), "保守拒绝不是命令失败");
    assert_eq!(result.effect_phase, EffectPhase::NotStarted);
    let CommandOutput::ActionReceipt(receipt) = result.output.expect("gate receipt") else {
        panic!("expected an action receipt");
    };
    assert!(!receipt.ok);
    assert_eq!(receipt.reason.as_deref(), Some("blocked_by_captcha"));
    drop(engine);
    server.await.expect("fake CDP");
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn session_open(port: u16) -> SessionOpenRecord {
    SessionOpenRecord {
        protocol_version: 2,
        id: "open-guard".to_owned(),
        session_id: "session-guard".to_owned(),
        task_id: "browse-guard".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Xiaohongshu,
            timeout_ms: 30_000,
        },
    }
}

fn write_command(command_id: u64, command: NativeCommand) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("command-{command_id}"),
        session_id: "session-guard".to_owned(),
        task_id: "browse-guard".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + 30_000,
        command,
    }
}

/// 一台按页型作答的假 CDP：`page_kind` 决定页面探针回什么，`probe_override` 用来模拟探测本身读不到。
/// 页面规则的返回一律是一个诚实的失败终局——本组用例只关心「有没有走到页面规则」，不关心它做了什么。
async fn spawn_xhs_cdp(
    page_kind: &'static str,
    probe_override: Option<Value>,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    spawn_counted_xhs_cdp(page_kind, probe_override, Arc::new(AtomicUsize::new(0))).await
}

async fn spawn_counted_xhs_cdp(
    page_kind: &'static str,
    probe_override: Option<Value>,
    observed: Arc<AtomicUsize>,
) -> (u16, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().expect("address").port();
    let server = tokio::spawn(async move {
        let (mut http, _) = listener.accept().await.expect("HTTP target request");
        let mut request = [0_u8; 2048];
        let _ = http.read(&mut request).await.expect("read target request");
        let body = json!([{
            "id": "target-guard",
            "type": "page",
            "url": "https://www.xiaohongshu.com/explore/note-1",
            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/target-guard")
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
        while let Some(Ok(Message::Text(text))) = websocket.next().await {
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let method = request["method"].as_str().unwrap_or_default().to_owned();
            let expression = request
                .pointer("/params/expression")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let response = if method == "Runtime.evaluate" && expression.contains("feedCardCount") {
                match &probe_override {
                    Some(value) => value.clone(),
                    None => probe_signals(page_kind),
                }
            } else if method == "Runtime.evaluate" {
                json!({"result":{"value":{
                    "effectPhase":"not_started",
                    "output":{"kind":"action_receipt","value":{"action":"noop","ok":false,"reason":"no_target"}}
                }}})
            } else {
                json!({})
            };
            observed.fetch_add(1, Ordering::Release);
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

fn probe_signals(page_kind: &str) -> Value {
    let href = match page_kind {
        "unknown" => "https://www.xiaohongshu.com/some/unmapped/surface",
        _ => "https://www.xiaohongshu.com/explore/note-1",
    };
    json!({"result":{"value":{
        "href": href,
        "readyState": "complete",
        "feedCardCount": 0,
        "noteDetailCount": if page_kind == "note_detail" { 1 } else { 0 },
        "loginWallCount": if page_kind == "login" { 1 } else { 0 },
        "captchaSignalCount": if page_kind == "captcha" { 1 } else { 0 },
        "dialogCount": 0,
        "profileSignalCount": 0,
        "notificationSignalCount": 0,
        "publishSignalCount": 0,
        "errorSignalCount": 0,
        "mainCount": if page_kind == "unknown" { 0 } else { 1 }
    }}})
}
