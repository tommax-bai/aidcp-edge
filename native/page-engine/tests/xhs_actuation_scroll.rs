//! 小红书滚动接上共享惯性滚轮手势（change `restore-native-actuation-humanization-and-locating` §8.5 / 8.6）。
//!
//! 迁移后小红书三条滚动全是页面内的 `scrollBy({behavior:'smooth'})`：一次调用、零输入事件、
//! 位移写死成 0.78 屏。本组用例钉死五件事：
//!  ① 翻页真的派发**多帧滚轮手势**，且滚前把光标移到**实测**可滚区中心；
//!  ② 落点来自页面判据的实测几何，不是写死的视口中心、更不是别的平台的落点常量；
//!  ③ 单次位移是**约半屏**（重叠口径），按实测视口算而不是照抄定值；
//!  ④ 一次派发失败只中止本轮、命令仍按**实测位移**如实回报，绝不终结整个浏览循环；
//!  ⑤ 接管**原样穿出**为取消，不被吞成一条普通回执；评论区位置不再变化即停手，不空转。

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
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

/// 可滚区中心的实测值。刻意取一组**不等于**视口中心、也不等于 Facebook 那组
/// 写死落点的坐标——落点若来自任何常量，用例立刻红。
const AREA_X: f64 = 311.0;
const AREA_Y: f64 = 523.0;
/// 实测视口高度。半屏口径 ⇒ 基准位移 450px，手势内部再叠 ±20% ⇒ [360, 540]。
const VIEWPORT_HEIGHT: f64 = 900.0;
const FEED_BASELINE_PX: f64 = VIEWPORT_HEIGHT * 0.5;

struct Observed {
    requests: Vec<Value>,
    /// 可滚区当前位置，恒等于 `target - pending`（页面被锁死时两者都不动）。
    position: f64,
    wheel_deltas: Vec<f64>,
    /// 手势最终会把页面滚到哪（每一帧的 deltaY 累加）。
    target: f64,
    /// 还没落地的位移（惯性 / 平滑滚动尚未走完的那一段）。
    pending: f64,
    /// 还要读几次可滚区，`pending` 才会全部落地。
    inertia_left: usize,
}

impl Observed {
    fn methods(&self) -> Vec<(String, String)> {
        self.requests
            .iter()
            .map(|entry| {
                (
                    entry["method"].as_str().unwrap_or_default().to_owned(),
                    entry
                        .pointer("/params/type")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                )
            })
            .collect()
    }

    fn mouse_events(&self, kind: &str) -> Vec<&Value> {
        self.requests
            .iter()
            .filter(|entry| {
                entry["method"] == "Input.dispatchMouseEvent"
                    && entry.pointer("/params/type").and_then(Value::as_str) == Some(kind)
            })
            .collect()
    }

    /// 第一条某类鼠标事件在整串请求里的序号（用来判先后，不判绝对位置）。
    fn first_index(&self, kind: &str) -> Option<usize> {
        self.methods()
            .iter()
            .position(|(method, event)| method == "Input.dispatchMouseEvent" && event == kind)
    }
}

#[derive(Clone, Copy)]
struct FakePage {
    /// 页面是否真的随滚轮位移。false = 到底 / 不可滚。
    scrolls: bool,
    /// 详情浮层是否存在（`browse_next` 滚前须先关）。
    overlay: bool,
    /// 拒发第几次 `mouseWheel`（0 = 从不）。
    reject_wheel_at: usize,
    /// 第几次 `mouseWheel` 之后置位接管（0 = 从不）。
    cancel_at_wheel: usize,
    /// 评论区页面上真实可见的行数。
    comment_rows: u32,
    /// 惯性 / 懒渲染：手势派完之后位移还要再走几拍才停。0 = 位移随手势瞬时落地。
    /// 位移没落定前，只读扫描回的仍是**滚动前那一屏**卡片。
    inertia_probes: usize,
}

impl Default for FakePage {
    fn default() -> Self {
        Self {
            scrolls: true,
            overlay: false,
            reject_wheel_at: 0,
            cancel_at_wheel: 0,
            comment_rows: 0,
            inertia_probes: 0,
        }
    }
}

#[tokio::test]
async fn feed_paging_hovers_the_measured_scroll_area_then_dispatches_a_multi_frame_wheel_gesture() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(FakePage::default(), cancellation.clone()).await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute(&scroll_command(
            1,
            command(r#"{"kind":"browse_scroll","params":{"reason":"feed_paging"}}"#),
            25_000,
        ))
        .await
        .expect("command result");

    let CommandOutput::PageCards(cards) = result.output.expect("output") else {
        panic!("expected page cards");
    };
    let movement = cards.movement.expect("翻页必须带上实测位移");
    assert!(movement.moved, "假页面真的滚动了，位移必须如实回报");

    drop(engine);
    let observed = server.await.expect("fake page");

    // ① 光标先移到可滚区，再逐帧滚——顺序反了等于「先滚再指」，滚轮会落在上一处光标下。
    let moved_at = observed
        .first_index("mouseMoved")
        .expect("滚前必须把光标移到可滚区");
    let wheel_at = observed.first_index("mouseWheel").expect("必须派发滚轮");
    assert!(moved_at < wheel_at, "光标必须先到位，再开始滚");

    // ② 落点逐字来自页面判据的实测几何。用例给的这组坐标既不是视口中心、也不是任何常量，
    //    所以任何写死落点的实现都会在这里红。
    let hover = observed.mouse_events("mouseMoved");
    assert_eq!(hover.len(), 1, "一次手势只需要一次移动到位");
    assert_eq!(
        hover[0].pointer("/params/x").and_then(Value::as_f64),
        Some(AREA_X)
    );
    assert_eq!(
        hover[0].pointer("/params/y").and_then(Value::as_f64),
        Some(AREA_Y)
    );
    for wheel in observed.mouse_events("mouseWheel") {
        assert_eq!(
            wheel.pointer("/params/x").and_then(Value::as_f64),
            Some(AREA_X)
        );
        assert_eq!(
            wheel.pointer("/params/y").and_then(Value::as_f64),
            Some(AREA_Y)
        );
    }

    // ③ 多帧、同向、总位移落在「半屏 ±20%」内 —— 半屏是重叠口径（相邻两次扫描的可见卡片
    //    必须有重叠，整屏会让 borderline 卡只剩一次评估机会）。
    assert!(
        observed.wheel_deltas.len() >= 8,
        "惯性手势至少 8 帧，实得 {}",
        observed.wheel_deltas.len()
    );
    assert!(
        observed.wheel_deltas.iter().all(|delta| *delta > 0.0),
        "同一次手势内不得反向：{:?}",
        observed.wheel_deltas
    );
    let total: f64 = observed.wheel_deltas.iter().sum();
    assert!(
        (FEED_BASELINE_PX * 0.8..=FEED_BASELINE_PX * 1.2).contains(&total),
        "单次位移应为约半屏（{FEED_BASELINE_PX}px）的 ±20%，实得 {total}"
    );
}

/// 落定判据必须是「位置**不再变化**」，不是「出现了第一次变化」。
///
/// 手势原语把 8–15 帧全部派完才返回，所以「等到第一次位移」恒在一个探针往返后命中：
/// 此刻惯性还没走完、懒渲染还没触发，只读重扫拿到的仍是滚动前那一屏 ⇒ 云端反复选中
/// 已访问过的笔记、或判定无新候选继续翻页 ⇒「只刷不点」活锁。回执本身是诚实的
/// （位移确实实测），所以现场没有任何错误码指向这里 —— 只能靠这条用例守。
#[tokio::test]
async fn feed_paging_waits_for_the_position_to_stop_changing_before_it_rescans() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            inertia_probes: 3,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute(&scroll_command(
            1,
            command(r#"{"kind":"browse_scroll","params":{"reason":"feed_paging"}}"#),
            25_000,
        ))
        .await
        .expect("command result");

    let CommandOutput::PageCards(cards) = result.output.expect("output") else {
        panic!("expected page cards");
    };
    let movement = cards.movement.expect("翻页必须带上实测位移");

    drop(engine);
    let observed = server.await.expect("fake page");
    let total: f64 = observed.wheel_deltas.iter().sum();
    assert!(total > 0.0, "这一场确实滚出去了");
    // 位移读的是**落定之后**的终值，不是惯性第一拍的中间值。
    assert!(movement.moved);
    assert_eq!(
        movement.after, total,
        "位移还在走就收工：读到的是中间值 {} 而不是终值 {total}",
        movement.after
    );
    // 后果面：位移没落定就重扫，拿到的是滚动前那一屏卡片。
    assert_eq!(
        cards.cards.first().and_then(|card| card.note_id.as_deref()),
        Some("note-fresh"),
        "重扫发生在懒渲染之前，拿到的还是滚动前那一屏",
    );
}

#[tokio::test]
async fn an_initial_scan_reads_the_page_without_dispatching_any_gesture() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(FakePage::default(), cancellation.clone()).await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute(&scroll_command(
            1,
            command(r#"{"kind":"browse_next","params":{"reason":"initial_scan"}}"#),
            25_000,
        ))
        .await
        .expect("command result");
    assert!(matches!(
        result.output.expect("output"),
        CommandOutput::PageCards(_)
    ));

    drop(engine);
    let observed = server.await.expect("fake page");
    // 只读扫描是「看一眼」，不是「翻一页」：一次输入事件都不许发。
    assert!(observed.mouse_events("mouseWheel").is_empty());
    assert!(observed.mouse_events("mouseMoved").is_empty());
}

#[tokio::test]
async fn a_failed_wheel_dispatch_aborts_only_this_round_and_still_reports_measured_movement() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            reject_wheel_at: 3,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute(&scroll_command(
            1,
            command(r#"{"kind":"browse_scroll","params":{"reason":"feed_paging"}}"#),
            25_000,
        ))
        .await
        .expect("command result");

    // 派发失败只中止本轮：命令仍回一个回执，绝不上抛（上抛会一次瞬时超时终结整个浏览循环）。
    assert!(result.error.is_none(), "一次派发失败不得终结命令");
    let CommandOutput::PageCards(cards) = result.output.expect("output") else {
        panic!("expected page cards");
    };
    let movement = cards.movement.expect("中止之后仍必须按实测位移回报");

    drop(engine);
    let observed = server.await.expect("fake page");
    let dispatched: f64 = observed.wheel_deltas.iter().sum();
    assert!(dispatched > 0.0, "被拒之前确实滚出去了两帧");
    assert!(
        observed.wheel_deltas.len() < 8,
        "被拒之后必须停发本轮剩余帧，实得 {}",
        observed.wheel_deltas.len()
    );
    // 回报的是**实测**位移，不是请求值：只滚出去了两帧就只报这两帧。
    assert_eq!(movement.before, 0.0);
    assert_eq!(movement.after, dispatched);
    assert!(movement.moved);
}

#[tokio::test]
async fn a_takeover_during_a_feed_gesture_passes_through_as_cancelled() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            cancel_at_wheel: 2,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute_cancellable_with_commit_windows(
            &scroll_command(
                1,
                command(r#"{"kind":"browse_scroll","params":{"reason":"feed_paging"}}"#),
                25_000,
            ),
            cancellation,
            CommitWindowRequester::in_process(1),
        )
        .await
        .expect("command result");

    // 接管优先于死线，且**原样穿出**：是一条取消错误，不是一条「滚了但没动」的回执。
    let error = result.error.expect("takeover must surface as an error");
    assert_eq!(error.code, ErrorCode::Cancelled);
    assert!(result.output.is_none());

    drop(engine);
    let _ = server.await.expect("fake page");
}

#[tokio::test]
async fn browse_next_closes_the_detail_overlay_before_it_scrolls() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            overlay: true,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    engine
        .execute(&scroll_command(
            1,
            command(r#"{"kind":"browse_next","params":{"reason":"feed_paging"}}"#),
            25_000,
        ))
        .await
        .expect("command result");

    drop(engine);
    let observed = server.await.expect("fake page");
    // 浮层没关就滚 = 在浮层上滚：位移读到了，feed 却一步没动。
    let press_at = observed
        .first_index("mousePressed")
        .expect("浮层在场时必须先点关闭");
    let wheel_at = observed.first_index("mouseWheel").expect("随后才滚");
    assert!(press_at < wheel_at, "关闭浮层必须发生在第一帧滚轮之前");
}

#[tokio::test]
async fn comment_scrolling_stops_when_the_position_stops_changing() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            scrolls: false,
            comment_rows: 4,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute(&scroll_command(
            1,
            command(r#"{"kind":"note_scroll_comments","params":{"noteId":"note-1","count":5}}"#),
            25_000,
        ))
        .await
        .expect("command result");

    let CommandOutput::ActionReceipt(receipt) = result.output.expect("output") else {
        panic!("expected an action receipt");
    };
    // 一次都没位移 = 没滚动成功，如实报，绝不把「下发了 5 步」当成「滚了 5 屏」。
    assert!(!receipt.ok);
    assert_eq!(receipt.reason.as_deref(), Some("no_scroll"));
    assert_eq!(result.effect_phase, EffectPhase::Ambiguous);

    drop(engine);
    let observed = server.await.expect("fake page");
    assert_eq!(
        observed.mouse_events("mouseMoved").len(),
        1,
        "位置不再变化就停手，不许把剩下 4 步空转完"
    );
}

#[tokio::test]
async fn comment_scrolling_reports_the_row_count_it_measured_not_the_step_count() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            comment_rows: 7,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute(&scroll_command(
            1,
            command(r#"{"kind":"note_scroll_comments","params":{"noteId":"note-1","count":2}}"#),
            25_000,
        ))
        .await
        .expect("command result");

    let CommandOutput::ActionReceipt(receipt) = result.output.expect("output") else {
        panic!("expected an action receipt");
    };
    assert!(receipt.ok);
    // 「滚了几条」= 页面上真实可见的评论行数（7），不是下发的步数（2）。
    assert_eq!(receipt.reason.as_deref(), Some("scrolled=7"));
    assert_eq!(
        receipt
            .observation
            .as_ref()
            .and_then(|observation| observation.article_index),
        Some(7)
    );

    drop(engine);
    let observed = server.await.expect("fake page");
    assert_eq!(
        observed.mouse_events("mouseMoved").len(),
        2,
        "两步都真的派发了手势"
    );
}

#[tokio::test]
async fn comment_scrolling_refuses_a_note_it_is_not_standing_on() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(FakePage::default(), cancellation.clone()).await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute(&scroll_command(
            1,
            command(
                r#"{"kind":"note_scroll_comments","params":{"noteId":"other-note","count":3}}"#,
            ),
            25_000,
        ))
        .await
        .expect("command result");

    let CommandOutput::ActionReceipt(receipt) = result.output.expect("output") else {
        panic!("expected an action receipt");
    };
    assert_eq!(receipt.reason.as_deref(), Some("note_page_mismatch"));
    assert_eq!(result.effect_phase, EffectPhase::NotStarted);

    drop(engine);
    let observed = server.await.expect("fake page");
    assert!(
        observed.mouse_events("mouseWheel").is_empty(),
        "闸没过就零派发"
    );
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

fn session_open(port: u16) -> SessionOpenRecord {
    SessionOpenRecord {
        protocol_version: 2,
        id: "open-scroll".to_owned(),
        session_id: "session-scroll".to_owned(),
        task_id: "browse-scroll".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Xiaohongshu,
            timeout_ms: 30_000,
        },
    }
}

fn scroll_command(command_id: u64, command: NativeCommand, budget_ms: u64) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("command-{command_id}"),
        session_id: "session-scroll".to_owned(),
        task_id: "browse-scroll".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + budget_ms,
        command,
    }
}

/// 一台会「记住自己被滚到哪」的假页面：每一帧滚轮把位置往前推 deltaY，页面判据按当前位置作答。
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
            "id": "target-scroll",
            "type": "page",
            "url": "https://www.xiaohongshu.com/explore/note-1",
            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/target-scroll")
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
            position: 0.0,
            wheel_deltas: Vec::new(),
            target: 0.0,
            pending: 0.0,
            inertia_left: 0,
        };
        let mut wheels = 0_usize;
        while let Some(Ok(Message::Text(text))) = websocket.next().await {
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let method = request["method"].as_str().unwrap_or_default().to_owned();
            let event = request
                .pointer("/params/type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let expression = request
                .pointer("/params/expression")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();

            let mut rejected = false;
            if method == "Input.dispatchMouseEvent" && event == "mouseWheel" {
                wheels += 1;
                if page.reject_wheel_at > 0 && wheels == page.reject_wheel_at {
                    rejected = true;
                } else {
                    let delta = request
                        .pointer("/params/deltaY")
                        .and_then(Value::as_f64)
                        .unwrap_or_default();
                    observed.wheel_deltas.push(delta);
                    if page.scrolls {
                        observed.target += delta;
                        if page.inertia_probes > 0 {
                            observed.pending += delta;
                            observed.inertia_left = page.inertia_probes;
                        }
                        observed.position = observed.target - observed.pending;
                    }
                }
                if page.cancel_at_wheel > 0 && wheels == page.cancel_at_wheel {
                    cancellation.store(true, Ordering::Release);
                }
            }

            let response = if rejected {
                json!({"id": id, "error": {"code": -32000, "message": "wheel rejected"}})
            } else {
                let result = if method == "Runtime.evaluate" {
                    evaluate(&expression, &page, &mut observed)
                } else {
                    json!({})
                };
                json!({"id": id, "result": result})
            };
            observed.requests.push(request);
            websocket
                .send(Message::Text(response.to_string().into()))
                .await
                .expect("CDP response");
        }
        observed
    });
    (port, server)
}

fn evaluate(expression: &str, page: &FakePage, observed: &mut Observed) -> Value {
    // 每读一次可滚区，还没落地的位移就送出去一格；`inertia_probes` 拍之后才真正停下。
    // 这台假页面因此能区分「刚开始动」与「不动了」——引擎的落定判据只有真的等到
    // 位置不再变化，才会拿到终值。
    let reads_scroll_area = expression.contains(r#""kind":"feed_scroll_area""#)
        || expression.contains(r#""kind":"comment_scroll_area""#);
    if reads_scroll_area && observed.inertia_left > 0 {
        observed.inertia_left -= 1;
        // 最后一拍**精确**归零：位置的终值必须逐位等于目标值，否则用例分不清
        // 「引擎没等落定」与「假页面自己算出了浮点残差」。
        observed.pending = if observed.inertia_left == 0 {
            0.0
        } else {
            observed.pending * observed.inertia_left as f64 / (observed.inertia_left + 1) as f64
        };
        observed.position = observed.target - observed.pending;
    }
    if expression.contains("feedCardCount") {
        return json!({"result":{"value":{
            "href": "https://www.xiaohongshu.com/explore/note-1",
            "readyState": "complete",
            "feedCardCount": 6,
            "noteDetailCount": 0,
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
        let wanted = expression.contains(r#""noteId":"note-1""#);
        return value(json!({"found": true, "match": wanted, "noteId": "note-1"}));
    }
    if expression.contains(r#""kind":"detail_close""#) {
        return if page.overlay {
            value(json!({"found": true, "overlay": true, "x": 180.0, "y": 96.0}))
        } else {
            value(json!({"found": false, "overlay": false}))
        };
    }
    if expression.contains(r#""kind":"feed_scroll_area""#) {
        return value(json!({
            "found": true,
            "scroller": "element",
            "position": observed.position,
            "windowPosition": observed.position,
            "viewportHeight": VIEWPORT_HEIGHT,
            "atBottom": false,
            "x": AREA_X,
            "y": AREA_Y,
        }));
    }
    if expression.contains(r#""kind":"comment_scroll_area""#) {
        return value(json!({
            "found": true,
            "scroller": "element",
            "position": observed.position,
            "windowPosition": 0.0,
            "viewportHeight": VIEWPORT_HEIGHT,
            "atBottom": false,
            "rows": page.comment_rows,
            "x": AREA_X,
            "y": AREA_Y,
        }));
    }
    // 只读扫描（注入路由唯一不带副作用的分支）。
    // 位移还没落定时页面上仍是**滚动前那一屏**——feed 是滚动触发懒渲染的。
    if expression.contains(r#""reason":"initial_scan""#) {
        let note_id = if observed.pending > 0.5 {
            "note-stale"
        } else {
            "note-fresh"
        };
        return json!({"result":{"value":{
            "effectPhase": "confirmed",
            "output": {"kind": "page_cards", "value": {"cards": [{
                "index": 0,
                "title": "一张卡",
                "likeCount": 3,
                "collectCount": 1,
                "noteId": note_id
            }]}}
        }}});
    }
    value(json!({"found": false}))
}

fn value(inner: Value) -> Value {
    json!({"result": {"value": inner}})
}
