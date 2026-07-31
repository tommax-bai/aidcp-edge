//! 重连时的**实例绑定**与**预算**。
//!
//! 治的是这一条：同机多环境并行时，指纹浏览器释放的调试端口会被另一个环境复用。
//! 重连若只按「目标类型 + 平台域名 + 端口」挑目标，就可能附着到**别的分身的浏览器**上，
//! 此后一切动作都落在别人的账号里 —— 而且全程没有任何一处会报错。
//!
//! 四条用例分别钉死：
//!  ① 端口对上、平台域名也对上，但实例身份对不上 ⇒ 拒绝附着，且**一条命令都不执行**；
//!  ② 压根没有准入基线 ⇒ 诚实拒绝，且**连端点都不去碰**（没有基线时读回来的东西无从比对，不叫证据）；
//!  ③ 浏览器换了端口 ⇒ 向宿主重新解析端点，在新端口上认出同一个实例并接着干；
//!  ④ 重连 + 重试的总耗时不越过原命令预算，预算耗尽后单命令槽位被释放。

use aidcp_page_engine::command::IdentityCaptureParams;
use aidcp_page_engine::commit_window::CommitWindowRequester;
use aidcp_page_engine::endpoint_resolver::{EndpointResolver, ResolvedEndpoint};
use aidcp_page_engine::engine::{CommandOutput, Engine};
use aidcp_page_engine::error::ErrorCode;
use aidcp_page_engine::protocol::{
    CommandRecord, NativeCommand, PageProbeParams, Platform, SessionOpenParams, SessionOpenRecord,
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::{accept_async, tungstenite::Message};

/// 当初被准入的那一个浏览器进程。
const ADMITTED_BROWSER_ID: &str = "admitted-browser-aaaa";
/// 端口被回收之后占上来的**另一个环境**的浏览器进程。换进程必换标识 —— 这正是判据的立足点。
const INTRUDER_BROWSER_ID: &str = "intruder-browser-bbbb";

// ---- 假浏览器 ----

/// 读出请求行但**不消费**流：同一个监听端口上既有 CDP 的 HTTP 探测，也有 WebSocket 升级，
/// 要按路径分流又不能把字节吃掉（吃掉了就没法交给 WebSocket 握手）。
async fn peek_request_line(stream: &TcpStream) -> String {
    let mut buffer = [0_u8; 512];
    for _ in 0..200 {
        let read = stream.peek(&mut buffer).await.expect("peek request");
        let head = String::from_utf8_lossy(&buffer[..read]).to_string();
        if head.contains("\r\n") || read == buffer.len() {
            return head.lines().next().unwrap_or_default().to_owned();
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    String::new()
}

async fn write_http_json(stream: &mut TcpStream, body: &str) {
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(headers.as_bytes()).await.expect("headers");
    stream.write_all(body.as_bytes()).await.expect("body");
    stream.shutdown().await.expect("HTTP shutdown");
}

fn version_body(port: u16, browser_id: &str) -> String {
    json!({
        "Browser": "Chrome/126.0.0.0",
        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/browser/{browser_id}")
    })
    .to_string()
}

fn targets_body(port: u16, target_id: &str, url: &str) -> String {
    json!([{
        "id": target_id,
        "type": "page",
        "url": url,
        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/{target_id}")
    }])
    .to_string()
}

/// 假浏览器收到的每一次接入，按类别记账。用它来断言「**没有**发生过什么」。
#[derive(Clone, Debug, Eq, PartialEq)]
enum Visit {
    Version,
    Targets,
    WebSocket,
}

/// 一个浏览器实例：一个监听端口 + 一个自报标识 + 一张页面目标表。
///
/// `websocket_script` 决定连上来的 CDP 会话怎么答：先答 `connect_calls` 条握手调用，
/// 之后按 `after_handshake` 处理下一条命令。
struct FakeBrowser {
    listener: TcpListener,
    port: u16,
    browser_id: String,
    page_url: String,
    target_id: String,
    /// 接入流水共享给用例：有的用例要在假服务器还没收工时就读它。
    visits: Arc<Mutex<Vec<Visit>>>,
}

#[derive(Clone, Copy)]
enum AfterHandshake {
    /// 命令一到就断链 —— 这是触发重连的那一下。
    Disconnect,
    /// 收下命令但永不作答（连接一直开着）。用来测「重试是否有界」。
    Silence,
    /// 正常答一次小红书页面探针。
    AnswerProbe,
}

impl FakeBrowser {
    async fn bind(browser_id: &str, page_url: &str, target_id: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let port = listener.local_addr().expect("address").port();
        Self {
            listener,
            port,
            browser_id: browser_id.to_owned(),
            page_url: page_url.to_owned(),
            target_id: target_id.to_owned(),
            visits: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn visits(&self) -> Arc<Mutex<Vec<Visit>>> {
        self.visits.clone()
    }

    /// 处理 `rounds` 次接入（HTTP 按路径分流，WebSocket 走 CDP 脚本），返回接入流水。
    async fn serve(self, rounds: usize, script: &[AfterHandshake]) -> Vec<Visit> {
        let mut websocket_index = 0;
        let record = |visit: Visit| {
            self.visits.lock().expect("visit log").push(visit);
        };
        for _ in 0..rounds {
            let Ok(Ok((mut stream, _))) =
                tokio::time::timeout(Duration::from_secs(5), self.listener.accept()).await
            else {
                break;
            };
            let request_line = peek_request_line(&stream).await;
            if request_line.starts_with("GET /json/version") {
                record(Visit::Version);
                let mut sink = [0_u8; 2048];
                let _ = stream.read(&mut sink).await.expect("read version request");
                write_http_json(&mut stream, &version_body(self.port, &self.browser_id)).await;
                continue;
            }
            if request_line.starts_with("GET /json") {
                record(Visit::Targets);
                let mut sink = [0_u8; 2048];
                let _ = stream.read(&mut sink).await.expect("read targets request");
                write_http_json(
                    &mut stream,
                    &targets_body(self.port, &self.target_id, &self.page_url),
                )
                .await;
                continue;
            }
            record(Visit::WebSocket);
            let after = script
                .get(websocket_index)
                .copied()
                .unwrap_or(AfterHandshake::Disconnect);
            websocket_index += 1;
            serve_cdp(stream, after).await;
        }
        self.visits.lock().expect("visit log").clone()
    }
}

async fn serve_cdp(stream: TcpStream, after: AfterHandshake) {
    let mut websocket = accept_async(stream).await.expect("WebSocket handshake");
    // `CdpSession::connect` 固定发三条域启用调用。
    for _ in 0..3 {
        let Some(Ok(Message::Text(text))) = websocket.next().await else {
            return;
        };
        let request: Value = serde_json::from_str(&text).expect("request JSON");
        let id = request["id"].as_u64().expect("request id");
        websocket
            .send(Message::Text(
                json!({"id":id,"result":{}}).to_string().into(),
            ))
            .await
            .expect("handshake response");
    }
    let Some(Ok(Message::Text(text))) = websocket.next().await else {
        return;
    };
    match after {
        AfterHandshake::Disconnect => {
            let _ = websocket.close(None).await;
        }
        AfterHandshake::Silence => {
            // 收下了，但永不作答。连接保持打开 —— 这样引擎不会看到断链、只会一直等。
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
        AfterHandshake::AnswerProbe => {
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            websocket
                .send(Message::Text(
                    json!({
                        "id": id,
                        "result": {
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
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("probe response");
            let _ = websocket.close(None).await;
        }
    }
}

use futures_util::SinkExt;

// ---- 请求构造 ----

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn session_open(port: u16, admitted: Option<&str>) -> SessionOpenRecord {
    SessionOpenRecord {
        protocol_version: 2,
        id: "open-1".to_owned(),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Xiaohongshu,
            timeout_ms: 5_000,
            browser_debugger_url: admitted
                .map(|id| format!("ws://127.0.0.1:{port}/devtools/browser/{id}")),
        },
    }
}

fn page_probe_command(command_id: u64, budget_ms: u64) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("command-{command_id}"),
        session_id: "session-1".to_owned(),
        task_id: "browse-1".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + budget_ms,
        command: NativeCommand::PageProbe(PageProbeParams {}),
    }
}

// ---- 用例 ----

/// 🔴 本轮的核心红线：**端口对上不等于是同一个浏览器**。
///
/// 把 `reconnect` 里的 `ensure_admitted_instance` / `select_target_for_instance`
/// 换回旧的 `select_target`，这条用例立刻红 —— 引擎会在入侵者的浏览器上接着执行命令。
#[tokio::test]
async fn a_port_match_with_a_different_browser_instance_attaches_nothing_and_runs_no_command() {
    let browser = FakeBrowser::bind(
        INTRUDER_BROWSER_ID,
        "https://www.xiaohongshu.com/explore",
        "target-1",
    )
    .await;
    let port = browser.port;
    // 开会话（/json + WS#1）→ 命令一到就断链 → 重连读 /json/version（这里是**另一个**实例标识）。
    // 之后再给两轮接入余量：真要是漏判了，引擎会去要目标表、并连上第二条 WS —— 流水里就会有。
    let server = tokio::spawn(browser.serve(4, &[AfterHandshake::Disconnect]));

    let mut engine = Engine::default();
    engine
        .open(&session_open(port, Some(ADMITTED_BROWSER_ID)))
        .await
        .expect("open session");
    let outcome = engine
        .execute(&page_probe_command(1, 4_000))
        .await
        .expect("stored refusal");

    assert!(
        outcome.output.is_none(),
        "身份对不上就绝不许有任何输出：{outcome:?}"
    );
    assert_eq!(
        outcome.error.expect("honest refusal").code,
        ErrorCode::EndpointUnreachable,
        "对不上的实例必须回执行器健康类失败，而不是退化成端口对上就接管"
    );

    engine.shutdown().await;
    let visits = tokio::time::timeout(Duration::from_secs(6), server)
        .await
        .expect("fake browser")
        .expect("fake browser task");
    assert_eq!(
        visits,
        vec![Visit::Targets, Visit::WebSocket, Visit::Version],
        "复核不通过之后，MUST NOT 再问目标表、更不许连第二条 CDP 会话：{visits:?}"
    );
}

/// 没有准入基线（旧宿主不带身份证据）⇒ 诚实拒绝，且**连端点都不去碰**。
///
/// 「读回来一个无从比对的标识」不是证据。把 `reconnect` 里那句
/// `admitted.ok_or_else(...)` 删掉、改成拿不到就跳过复核，这条用例立刻红。
#[tokio::test]
async fn a_reconnect_without_an_admitted_baseline_refuses_before_touching_the_endpoint() {
    let browser = FakeBrowser::bind(
        ADMITTED_BROWSER_ID,
        "https://www.xiaohongshu.com/explore",
        "target-1",
    )
    .await;
    let port = browser.port;
    let server = tokio::spawn(browser.serve(4, &[AfterHandshake::Disconnect]));

    let mut engine = Engine::default();
    engine
        .open(&session_open(port, None))
        .await
        .expect("open session");
    let outcome = engine
        .execute(&page_probe_command(1, 4_000))
        .await
        .expect("stored refusal");

    assert!(outcome.output.is_none());
    assert_eq!(
        outcome.error.expect("honest refusal").code,
        ErrorCode::EndpointUnreachable
    );

    engine.shutdown().await;
    let visits = tokio::time::timeout(Duration::from_secs(6), server)
        .await
        .expect("fake browser")
        .expect("fake browser task");
    assert_eq!(
        visits,
        vec![Visit::Targets, Visit::WebSocket],
        "没有基线就没有可复核的对象：既不该去读实例标识，也不该去要目标表：{visits:?}"
    );
}

/// 浏览器换了端口（冷待机唤醒就是这样）：向宿主**重新解析**端点，
/// 在新端口上认出同一个实例，然后接着干。
///
/// 把 `reconnect` 改回复用会话结构里存的 `host`/`port`，这条用例立刻红 ——
/// 旧端口上已经没有浏览器了。
#[tokio::test]
async fn a_relocated_browser_is_found_again_by_re_resolving_the_endpoint_with_the_host() {
    let first = FakeBrowser::bind(
        ADMITTED_BROWSER_ID,
        "https://www.xiaohongshu.com/explore",
        "target-1",
    )
    .await;
    let relocated = FakeBrowser::bind(
        ADMITTED_BROWSER_ID,
        "https://www.xiaohongshu.com/explore",
        "target-2",
    )
    .await;
    let first_port = first.port;
    let relocated_port = relocated.port;
    // 旧端口：开会话 + 一条命令就断链，之后不再有任何接入。
    let first_server = tokio::spawn(first.serve(2, &[AfterHandshake::Disconnect]));
    // 新端口：实例标识 → 目标表 → 一条能答探针的 CDP 会话。
    let relocated_server = tokio::spawn(relocated.serve(3, &[AfterHandshake::AnswerProbe]));

    let mut engine = Engine::default();
    engine
        .open(&session_open(first_port, Some(ADMITTED_BROWSER_ID)))
        .await
        .expect("open session");

    let (sender, mut receiver) = mpsc::unbounded_channel();
    let command = page_probe_command(1, 8_000);
    let resolver = EndpointResolver::new(command.command_id, sender);
    // 宿主：会话期内可重复取值的端点解析入口。这里答的是**新**端口。
    let host = tokio::spawn(async move {
        let mut answered = 0_u32;
        while let Some(request) = receiver.recv().await {
            answered += 1;
            let _ = request.response.send(Some(ResolvedEndpoint {
                host: "127.0.0.1".to_owned(),
                port: relocated_port,
            }));
        }
        answered
    });

    let outcome = engine
        .execute_cancellable_with_commit_windows(
            &command,
            Arc::new(AtomicBool::new(false)),
            CommitWindowRequester::in_process(command.command_id),
            resolver,
        )
        .await
        .expect("reconnected probe");

    let Some(CommandOutput::PageProbe(probe)) = outcome.output.as_ref() else {
        panic!("expected a page probe output, got {outcome:?}");
    };
    assert_eq!(probe.page_kind, aidcp_page_engine::probe::PageKind::Explore);

    engine.shutdown().await;
    drop(engine);
    let answered = tokio::time::timeout(Duration::from_secs(6), host)
        .await
        .expect("host resolver")
        .expect("host resolver task");
    assert_eq!(answered, 1, "一次重连恰好向宿主要一次端点");
    let first_visits = tokio::time::timeout(Duration::from_secs(6), first_server)
        .await
        .expect("first browser")
        .expect("first browser task");
    assert_eq!(first_visits, vec![Visit::Targets, Visit::WebSocket]);
    let relocated_visits = tokio::time::timeout(Duration::from_secs(6), relocated_server)
        .await
        .expect("relocated browser")
        .expect("relocated browser task");
    assert_eq!(
        relocated_visits,
        vec![Visit::Version, Visit::Targets, Visit::WebSocket],
        "新端点上必须先自证是同一个实例，再问目标表：{relocated_visits:?}"
    );
}

/// 重连之后的那一次重试 MUST 与首跑同受一条绝对截止线约束，并且预算耗尽之后
/// 单命令槽位要被释放 —— 否则下一条命令会被 `CommandInProgress` 顶回，而且没人救得了它。
///
/// 把 `execute_platform_command` 里包住重试的 `tokio::time::timeout` 去掉，这条用例立刻红：
/// 重试会在一条永不作答的 CDP 会话上无限期地等下去，外层的 6 秒保护当场触发。
#[tokio::test]
async fn a_retry_after_reconnect_stays_inside_the_original_budget_and_frees_the_slot() {
    let browser =
        FakeBrowser::bind(ADMITTED_BROWSER_ID, "https://www.facebook.com/", "target-1").await;
    let port = browser.port;
    let visits = browser.visits();
    // 开会话 → 命令一到就断链 → 复核实例 → 目标表 → 第二条 CDP 会话**永不作答**。
    let server =
        tokio::spawn(browser.serve(5, &[AfterHandshake::Disconnect, AfterHandshake::Silence]));

    let mut engine = Engine::default();
    let mut open = session_open(port, Some(ADMITTED_BROWSER_ID));
    open.params.platform = Platform::Facebook;
    open.params.timeout_ms = 20_000;
    engine.open(&open).await.expect("open session");

    const BUDGET_MS: u64 = 1_500;
    let mut command = page_probe_command(1, BUDGET_MS);
    // 读命令才会走「重连 + 重试」那条路（写命令一旦派发过就不许重放）。
    command.command = NativeCommand::IdentityReadCurrent(IdentityCaptureParams {
        capture_id: "capture-1".to_owned(),
        account_id: "61591824155856".to_owned(),
    });

    let started = Instant::now();
    let outcome = tokio::time::timeout(Duration::from_secs(6), engine.execute(&command))
        .await
        .expect("重连 + 重试必须在原命令预算内收敛，绝不允许无界地等下去")
        .expect("stored timeout");
    let elapsed = started.elapsed();

    assert_eq!(
        outcome.error.expect("timeout").code,
        ErrorCode::CdpTimeout,
        "预算耗尽必须如实回超时"
    );
    assert!(
        elapsed < Duration::from_millis(BUDGET_MS + 1_500),
        "重连 + 重试共耗时 {elapsed:?}，越出了原命令预算 {BUDGET_MS}ms"
    );
    // 防空转：这条用例只有真的走完「断链 → 复核 → 重连 → 重试」才算数。
    // 少了任何一步，下面这张流水就对不上，超时断言也就不再证明「重试有界」。
    assert_eq!(
        visits.lock().expect("visit log").clone(),
        vec![
            Visit::Targets,
            Visit::WebSocket,
            Visit::Version,
            Visit::Targets,
            Visit::WebSocket
        ],
        "重试必须真的发生在重连之后的第二条 CDP 会话上"
    );

    // 槽位必须已经释放：下一条命令可以是任何失败，就是不能是「上一条还占着」。
    let next = engine
        .execute(&page_probe_command(2, 400))
        .await
        .expect("stored next outcome");
    assert_ne!(
        next.error.map(|error| error.code),
        Some(ErrorCode::CommandInProgress),
        "预算耗尽之后单命令槽位必须已经释放"
    );

    engine.shutdown().await;
    drop(server);
}
