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
    /// 还要读几次可滚区，位移才**开始**动。平滑滚动的起步比一次探针还慢时的现场。
    stall_left: usize,
    /// 可滚区一共被读了几次（含手势前那一次基准读数）。用来钉「一次位移都没读到时的最小耐心」。
    area_reads: usize,
    /// 已经收到几帧滚轮：用来把「手势之后的读数」与手势前那次基准读数分开。
    wheels_seen: usize,
    /// 手势之后可滚区被读了几次。「读不到」的注入窗口按这个序号开合。
    area_reads_after_gesture: usize,
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
    /// 平滑滚动的**起步延迟**：手势派完之后还要读几次可滚区，位移才开始动。
    /// 这几拍里位置逐字等于滚动前那一个值 —— 与「不会再动了」长得一模一样。
    startup_probes: usize,
    /// 「读不到」注入窗口的起点：手势之后第几次读可滚区**之后**开始瞎（0 = 从第一次就瞎）。
    blind_after_reads: usize,
    /// 连着几次读可滚区**读不到**（分片这一轮解析不出可滚区，回 `found:false`）。
    /// 这几拍既不推进惯性、也不改变位置 —— 引擎这一轮什么都没学到。
    blind_reads: usize,
    /// 「读不到」那几拍之后，位置还会**停住**几次可读的读数才继续走。
    /// 真机成因是同一件事：懒渲染换掉了滚动容器 —— 换的那一拍分片解析不出容器（读不到），
    /// 换完那一拍新容器的 scrollTop 还停在换之前那个值。于是读数长成「p、读不到、p」，
    /// 与「连读两次 p」只差中间那一拍是不是真读到了。
    frozen_reads_after_blind: usize,
    /// 评论可滚区**不给** `rows` 判定：分片数不出页面上有几行评论。
    /// 与「数到了 0 行」是两态 —— 折成任何一个具体数字都是拿读不到的量冒充实测量。
    omit_comment_rows: bool,
    /// 详情浮层探针**不给** `overlay` 判定：关闭控件认出来了，浮层在不在却读不到。
    omit_overlay_verdict: bool,
    /// 可滚区的 `atBottom` 判定。`None` = 分片不给这一项（读不到），
    /// **不是** `false`（读到了、不在底部）。
    at_bottom: Option<bool>,
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
            startup_probes: 0,
            blind_after_reads: 0,
            blind_reads: 0,
            frozen_reads_after_blind: 0,
            omit_comment_rows: false,
            omit_overlay_verdict: false,
            at_bottom: Some(false),
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

/// 「还没开始动」与「不会再动了」是两态，读数却长得一模一样：位置连着几拍逐字等于滚动前那个值。
///
/// 平滑滚动的起步可能比一次探针还慢，所以「连读两次同一个位置」在**一次位移都没见过**时
/// 不足以断言到底 —— 那一步之差恰好复现「只刷不点」活锁：位移回报 `moved=false`，
/// 重扫拿到的还是滚动前那一屏卡片，云端于是反复选中已访问过的笔记或继续下发翻页。
/// 而回执本身是诚实的（位移确实是实测的），现场没有任何错误码指向这里。
///
/// **这一条钉的是「有耐心」这件事本身，不是耐心的具体轮数**：起步拖了 3 拍，所以它只证明
/// 最小耐心 ≥ 4 轮，常量从 6 削到 4 仍会照绿。轮数下界由下面那条
/// `a_page_that_never_moves_is_declared_settled_only_after_the_minimum_patience` 单独钉。
#[tokio::test]
async fn feed_paging_gives_a_slow_starting_scroll_the_rounds_to_prove_it_is_moving() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            // 前三次读可滚区，位置一动不动；第四次才开始走。
            startup_probes: 3,
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
    assert!(
        movement.moved,
        "起步慢被当成了「不会再动了」：位移回报成一步没动",
    );
    assert_eq!(
        movement.after, total,
        "收工太早：读到的是起步前那个值 {} 而不是终值 {total}",
        movement.after
    );
    // 后果面：断早了就在懒渲染之前重扫，拿到的还是滚动前那一屏 ——「只刷不点」活锁。
    assert_eq!(
        cards.cards.first().and_then(|card| card.note_id.as_deref()),
        Some("note-fresh"),
        "重扫发生在页面真正动起来之前",
    );
}

/// 「这一轮读不到」是第三态，既不算「还在动」也不算「不会再动了」。
///
/// 把它计进落定连击、就此收工，就是拿一次读不到冒充「位置不再变化」——「只刷不点」活锁换个门
/// 原样回来：位移还在惯性里走，引擎却已经去重扫，拿到的是滚动前那一屏卡片，云端于是反复选中
/// 已访问过的笔记。这一场里位移**已经动过**（`moved` 为真），所以「最小耐心轮次」那道闸兜不住它 ——
/// 唯一挡在中间的就是「读不到必须把连击清零、继续有界重试」。
///
/// 现场铺的读数是「p、读不到、p」，因此**两个折叠方向都能杀**：
///  - 读不到直接计进连击并收工 ⇒ 停在第一个 p；
///  - 只把连击 +1、不清 `previous` ⇒ 后面那个 p 与前面那个 p 接上，凑成一次假的「连读两次同值」。
///
/// 真机成因是同一件事：懒渲染换掉了滚动容器 —— 换的那一拍分片解析不出容器，换完那一拍
/// 新容器的 scrollTop 还停在换之前那个值。而回执本身始终是诚实的（位移确实是实测的），
/// 现场没有任何错误码指向这里。
#[tokio::test]
async fn feed_paging_never_counts_an_unreadable_round_as_a_settled_position() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            // 惯性要走 4 拍；手势之后第 2 次读**读不到**，第 3 次读得到、位置却还停在原处。
            inertia_probes: 4,
            blind_after_reads: 1,
            blind_reads: 1,
            frozen_reads_after_blind: 1,
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
    assert!(movement.moved);
    assert_eq!(
        movement.after, total,
        "中途一次读不到被当成了落定：读到的是惯性中间值 {} 而不是终值 {total}",
        movement.after
    );
    // 后果面：读不到被当成落定就会提前重扫，拿到的还是滚动前那一屏 ——「只刷不点」活锁。
    assert_eq!(
        cards.cards.first().and_then(|card| card.note_id.as_deref()),
        Some("note-fresh"),
        "重扫发生在位移真正落定之前",
    );
}

/// 一次位移都没读到时的**最小耐心轮次**：不到轮数不许断言「不会再动了」。
///
/// 上面那条起步慢的用例只证明「有耐心」，证不出耐心有多长（它只需要 4 轮就能通过）。
/// 这一条直接数引擎读了几次可滚区：页面**从头到尾一动不动**，引擎必须读满最小耐心轮次
/// 才允许收工 —— 常量被削小，这里当场少几次读数。
///
/// 断言取的是**下界**：物理量其实是「轮次 × 探针间隔」≈ 300ms 的起步耐心，6 是实测经验值、
/// 不是推导出来的精确值。所以这里只拦「变小」，不拦「变大」；若日后把间隔改大、轮次改小
/// 而总耐心不变，这条断言需要跟着改口径，而不是照着数字硬凑。
#[tokio::test]
async fn a_page_that_never_moves_is_declared_settled_only_after_the_minimum_patience() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            scrolls: false,
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
    assert!(
        !cards.movement.expect("翻页必须带上实测位移").moved,
        "这一场页面确实一步没动",
    );

    drop(engine);
    let observed = server.await.expect("fake page");
    // 1 次基准读数 + 最小耐心 6 轮 = 7。少于这个数就是「还没开始动」被当成了「不会再动了」。
    assert!(
        observed.area_reads >= 7,
        "最小耐心轮次被削短：可滚区只读了 {} 次",
        observed.area_reads
    );
    // 另一头：耐心是**有界**的，不许把命令预算耗在这里空转。
    assert!(
        observed.area_reads <= 15,
        "等落定必须按迭代次数限界，实得 {} 次读数",
        observed.area_reads
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

/// 「浮层不在」与「浮层在不在读不到」是两态。
///
/// 把读不到当成「浮层不在」就直接跳过关闭，手势于是落在浮层上 —— 浮层自己也能滚：
/// 位移**读到了**、feed 却一步没动，回执还是诚实的（位移确实实测），云端照单全收当成翻了一页。
/// 这一场里关闭控件本身认出来了、坐标也给了，只有「浮层在不在」这一项分片给不出来；
/// 该走的处置是「按浮层可能在办」，照常去点关闭。
#[tokio::test]
async fn browse_next_still_closes_the_overlay_when_the_overlay_verdict_is_unreadable() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            omit_overlay_verdict: true,
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
    let press_at = observed
        .first_index("mousePressed")
        .expect("「浮层在不在」读不到被当成了「浮层不在」：关闭一次都没点");
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

/// 「滚了几条」数不出来时必须回**读不到**，MUST NOT 顶成 1。
///
/// 这正是红线原文点名的那个反模式（「按真实数量如实回报，不再 `count||1`」）：
/// `scrolled=1` 与「确实只滚出一条」逐字不可分，云端据此判定这条笔记的评论区已经见底、
/// 不再往下读，而页面上其实还有几十条。回执照样 `ok=true`，没有任何一层会发现。
#[tokio::test]
async fn comment_scrolling_reports_an_unreadable_row_count_as_unknown_never_as_one() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            omit_comment_rows: true,
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
    // 页面确实滚动了，所以这条动作本身是成功的 —— 不诚实的只会是那个数字。
    assert!(receipt.ok);
    assert_eq!(result.effect_phase, EffectPhase::Confirmed);
    assert_eq!(
        receipt.reason, None,
        "行数读不到却报了个数：{:?}",
        receipt.reason
    );
    assert_eq!(
        receipt
            .observation
            .as_ref()
            .and_then(|observation| observation.article_index),
        None,
        "读不到的量被顶成了实测量",
    );

    drop(engine);
    let observed = server.await.expect("fake page");
    assert_eq!(
        observed.mouse_events("mouseMoved").len(),
        2,
        "两步都真的派发了手势 —— 不诚实的只会是那个行数"
    );
}

/// 「到底了」是**三态**，两个折叠方向都是错的，所以这一条要双向可杀。
///
/// 折成「没到底」⇒ 云端永远等不到停止信号，在一条已经见底的 feed 上无限翻页；
/// 折成「到底了」⇒ 云端提前收工，这个账号这一轮就少刷了大半个 feed。
/// 断言因此落在**云端真正看到的那份回执**上：读不到时这一项必须是空的，让上游回落到它自己的
/// 推断（`browse-session.ts` 的 `afterProbe.atBottom ?? …`）；任何一个确定的布尔值都会
/// 顶掉那条兜底，把「不知道」变成一句替云端拍的板。
#[tokio::test]
async fn the_at_bottom_verdict_reaches_the_cloud_exactly_as_the_page_reported_it() {
    for reported in [Some(true), Some(false), None] {
        let cancellation = Arc::new(AtomicBool::new(false));
        let (port, server) = spawn_page(
            FakePage {
                at_bottom: reported,
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
        // 上线形态就是这份 JSON：云端读的是它，不是 Rust 里的那个 Option。
        let wire = serde_json::to_value(&cards).expect("serialize page cards");
        let at_bottom = wire
            .pointer("/movement/atBottom")
            .cloned()
            .unwrap_or(Value::Null);

        match reported {
            Some(verdict) => assert_eq!(
                at_bottom,
                Value::Bool(verdict),
                "页面给了确定判定却没原样带出去",
            ),
            None => assert!(
                !at_bottom.is_boolean(),
                "「到底了」读不到，却给云端递了一个确定的 {at_bottom} —— \
                 false 会让它无限翻页，true 会让它提前收工，两个方向都是替云端拍板",
            ),
        }

        drop(engine);
        let _ = server.await.expect("fake page");
    }
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
            stall_left: 0,
            area_reads: 0,
            wheels_seen: 0,
            area_reads_after_gesture: 0,
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
                observed.wheels_seen += 1;
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
                        if page.inertia_probes > 0 || page.startup_probes > 0 {
                            observed.pending += delta;
                            observed.inertia_left = page.inertia_probes.max(1);
                            observed.stall_left = page.startup_probes;
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
    if reads_scroll_area {
        observed.area_reads += 1;
        if observed.wheels_seen > 0 {
            observed.area_reads_after_gesture += 1;
        }
    }
    // 「这一轮读不到」的现场：分片解析不出可滚区，回 `found:false`。位置与惯性**都不推进** ——
    // 这一拍引擎什么都没学到，所以它既不算「还在动」也不算「已停」。
    let blind_ends = page.blind_after_reads + page.blind_reads;
    if reads_scroll_area && page.blind_reads > 0 {
        let since = observed.area_reads_after_gesture;
        if since > page.blind_after_reads && since <= blind_ends {
            return value(json!({"found": false}));
        }
    }
    // 读不到那几拍之后位置还停住几拍：这一拍照常可读，但惯性不推进 ——
    // 读数因此长成「p、读不到、p」。
    let frozen = page.frozen_reads_after_blind > 0
        && observed.area_reads_after_gesture > blind_ends
        && observed.area_reads_after_gesture <= blind_ends + page.frozen_reads_after_blind;
    if reads_scroll_area && !frozen {
        // 起步延迟这几拍里位置**逐字不动**：读数与「不会再动了」完全一样，只有多等几轮才分得开。
        if observed.stall_left > 0 {
            observed.stall_left -= 1;
        } else if observed.inertia_left > 0 {
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
        // 判定缺席的现场：关闭控件认出来了、坐标也给了，只有「浮层在不在」这一项分片给不出来。
        if page.omit_overlay_verdict {
            return value(json!({"found": true, "x": 180.0, "y": 96.0}));
        }
        return if page.overlay {
            value(json!({"found": true, "overlay": true, "x": 180.0, "y": 96.0}))
        } else {
            value(json!({"found": false, "overlay": false}))
        };
    }
    if expression.contains(r#""kind":"feed_scroll_area""#) {
        let mut area = json!({
            "found": true,
            "scroller": "element",
            "position": observed.position,
            "windowPosition": observed.position,
            "viewportHeight": VIEWPORT_HEIGHT,
            "x": AREA_X,
            "y": AREA_Y,
        });
        if let Some(at_bottom) = page.at_bottom {
            area["atBottom"] = json!(at_bottom);
        }
        return value(area);
    }
    if expression.contains(r#""kind":"comment_scroll_area""#) {
        let mut area = json!({
            "found": true,
            "scroller": "element",
            "position": observed.position,
            "windowPosition": 0.0,
            "viewportHeight": VIEWPORT_HEIGHT,
            "x": AREA_X,
            "y": AREA_Y,
        });
        if let Some(at_bottom) = page.at_bottom {
            area["atBottom"] = json!(at_bottom);
        }
        // 「数不出来」与「数到了 0」是两态：前者把这一项整个拿掉，后者给出 0。
        if !page.omit_comment_rows {
            area["rows"] = json!(page.comment_rows);
        }
        return value(area);
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
