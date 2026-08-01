//! 小红书写动作接上硬件级输入原语（change `restore-native-actuation-humanization-and-locating` §8 输入半边）。
//!
//! 迁移后小红书全线文本输入走的是注入路由里的「原型 value setter 整段赋值 + 手工派发合成事件」：
//! 一次赋值、`isTrusted=false`、没有任何键盘节奏。本组用例钉死四件事：
//!  ① 评论与发布正文的文本**真的逐字 / 分块派发**，且拼接起来逐字符等于要写的内容；
//!  ② 长正文只缩往返与停顿、**绝不丢字符**；
//!  ③ 预算耗尽 ⇒ 清空编辑器 + 诚实失败，**绝不**写了一半报成功；
//!  ④ 打字期间的接管**原样穿出**为取消，不被吞成一条普通失败回执。
//!
//! 另有一条钉死 8.3：富文本正文的换行是**独立的裸回车按键**，任何一次文本写入都不携带回车符。

use aidcp_page_engine::commit_window::CommitWindowRequester;
use aidcp_page_engine::endpoint_resolver::EndpointResolver;
use aidcp_page_engine::engine::{CommandOutput, Engine};
use aidcp_page_engine::error::ErrorCode;
use aidcp_page_engine::protocol::{
    CommandRecord, EffectPhase, NativeCommand, Platform, SessionOpenParams, SessionOpenRecord,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

/// 话题候选项的落点。与本文件其余落点（编辑器 240,300 / 提交 320,460）刻意拉开距离：
/// 指针原语记「上一次落点」是**进程级全局**，落点撞车会让轨迹塌成单帧、把帧数断言变成抖动
/// （见 tasks.md §9.5-7）。
const TOPIC_CANDIDATE_POINT: (f64, f64) = (612.0, 188.0);

/// 假 CDP 记录到的一次会话：页面收到的全部请求 + 真正被写进编辑器的文本。
struct Observed {
    requests: Vec<Value>,
    editor: String,
    enter_presses: usize,
    /// 编辑器 `op:"probe"` 读了几次（第 1 次是写前定位，第 2 次起才是写后回读）。
    editor_probes: usize,
    /// 提交之后的到达确认探针读了几次。有界轮询与「单次采样」的差别只能在这里看出来。
    ack_probes: usize,
    /// 话题候选探针读了几次。
    topic_candidate_probes: usize,
}

impl Observed {
    fn inserted_chunks(&self) -> Vec<String> {
        self.requests
            .iter()
            .filter(|entry| entry["method"] == "Input.insertText")
            .map(|entry| {
                entry
                    .pointer("/params/text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect()
    }

    fn evaluated(&self, needle: &str) -> usize {
        self.requests
            .iter()
            .filter(|entry| {
                entry
                    .pointer("/params/expression")
                    .and_then(Value::as_str)
                    .is_some_and(|expression| expression.contains(needle))
            })
            .count()
    }

    fn input_events(&self, method: &str) -> usize {
        self.requests
            .iter()
            .filter(|entry| entry["method"] == method)
            .count()
    }

    fn mouse_events(&self, kind: &str) -> usize {
        self.requests
            .iter()
            .filter(|entry| {
                entry["method"] == "Input.dispatchMouseEvent"
                    && entry.pointer("/params/type").and_then(Value::as_str) == Some(kind)
            })
            .count()
    }
}

#[derive(Clone, Copy)]
struct FakePage {
    /// 编辑器是不是受控框（`value` 语义）。false = contenteditable，换行走裸回车。
    plain_value: bool,
    /// 每次文本写入的假往返耗时，用来把预算真的撑破。
    insert_delay_ms: u64,
    /// 第几次文本写入之后置位接管信号（0 = 从不）。
    cancel_after_inserts: usize,
    /// 富文本编辑器把裸回车**吞掉**：按键照收（归尾探针照报换行数达标——那正是 ProseMirror
    /// 留下的空段 `<br>` 造成的现场），但编辑器里不真的多出一段。
    swallow_enter: bool,
    /// 回读时页面报的正文（`None` = 报真实写进去的内容）。只作用于 `op:"probe"`，
    /// 不动写前的清场 / 落焦读数。
    readback_override: Option<&'static str>,
    /// 第几次编辑器 `op:"probe"` 之后置位接管信号（0 = 从不）。
    cancel_at_editor_probe: usize,
    /// 第几次编辑器 `op:"probe"` 直接回 CDP 错误（0 = 从不）。
    reject_editor_probe_at: usize,
    /// 编辑器把**字面换行**吞掉：`Input.insertText("\n")` 照收，编辑器里不多出一段。
    swallow_literal_newline: bool,
    /// 归尾探针的假往返耗时。真机 RTT 几十毫秒 —— 正是「预算 ÷ 间隔」推算轮数时漏算的那一项。
    caret_probe_delay_ms: u64,
    /// 归尾探针永远报「光标不在末端」：确认这一层始终不收敛。
    caret_never_settles: bool,
    /// 第一次文本写入的一次性长停顿：模拟单次慢往返把实测成本永久抬高（单调 `max` 放大器）。
    first_insert_stall_ms: u64,
    /// 该 `op` 的分片求值直接抛异常：返回体只有 `exceptionDetails`、没有 `/result/value`。
    throw_at_editor_op: Option<&'static str>,
    /// 提交之后那道确认探针的读数。`Some(true)` = 评论出现了；`Some(false)` = 没出现；
    /// `None` = 分片抛异常，**读不到** —— 与「读到了一个否」是两态。
    ack_appeared: Option<bool>,
    /// 确认探针的**第二条独立证据**：编辑器有没有被平台清空。`Some(true)` = 清空了（提交被
    /// 平台受理的结构必要条件）；`Some(false)` = 没清空；`None` = 分片连编辑器都定位不到，
    /// 这一条**读不到** —— 同样与「读到了一个否」分两态。
    ack_editor_cleared: Option<bool>,
    /// 平台慢：前 N 次确认探针一律回「没出现、也没清空」，第 N+1 次才给出上面那两条读数。
    /// 0 = 第一次就绪。用来把「有界轮询」与「固定睡一觉后单次采样」分开。
    ack_ready_after_probes: usize,
    /// 话题建议下拉：`None` = 一直认不出目标项（既没有精确候选、也没有「新建话题」）；
    /// `Some(n)` = 前 n 次探针还没渲染出来，第 n+1 次给出目标项。
    topic_candidate_after_probes: Option<usize>,
    /// 点中候选之后，正文里到底会不会生成**真话题 token**。
    /// `false` 用来造出那个关键现场：字打进去了、候选也点了，但话题根本没贴上 ——
    /// 而正文里明明躺着一串 `#关键词`，任何「正文里搜得到就算成功」的判据都会在这里说谎。
    topic_commits_on_click: bool,
    /// 回读时不给 `paragraphs` 判定：分片认不出段落结构。段落数是换行的**唯一**结构证据 ——
    /// 两道文本比对（归一 / 汉字档）对换行完全免疫。
    omit_paragraphs: bool,
    /// 探针不给 `plainValue` 判定：编辑器形态**读不到**。
    omit_plain_value: bool,
    /// 第几次归尾探针**之后**置位接管信号（0 = 从不）。
    cancel_at_caret_probe: usize,
    /// 清场**自称成功**（`cleared:true`、当场回读也报空），编辑器里其实还躺着这段残文。
    /// 这是清场分片的判据与真实 DOM 不一致时的现场：受控框走原型 setter 生效了、
    /// 富文本的编辑器实例把内容又同步了回来，清场那一拍的读数因此是干净的。
    residual_after_clear: Option<&'static str>,
}

impl Default for FakePage {
    fn default() -> Self {
        Self {
            plain_value: true,
            insert_delay_ms: 0,
            cancel_after_inserts: 0,
            swallow_enter: false,
            readback_override: None,
            cancel_at_editor_probe: 0,
            reject_editor_probe_at: 0,
            swallow_literal_newline: false,
            caret_probe_delay_ms: 0,
            caret_never_settles: false,
            first_insert_stall_ms: 0,
            throw_at_editor_op: None,
            ack_appeared: Some(true),
            ack_editor_cleared: Some(true),
            ack_ready_after_probes: 0,
            topic_candidate_after_probes: Some(0),
            topic_commits_on_click: true,
            omit_paragraphs: false,
            omit_plain_value: false,
            cancel_at_caret_probe: 0,
            residual_after_clear: None,
        }
    }
}

#[tokio::test]
async fn a_comment_is_typed_character_by_character_instead_of_being_assigned_in_one_write() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(FakePage::default(), cancellation.clone()).await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(
                1,
                command(
                    r#"{"kind":"interaction_comment","params":{"noteId":"note-1","text":"好文，收藏了","groupChatCode":"vx-1234"}}"#,
                ),
                12_000,
            ),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::ActionReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected an action receipt");
    };
    assert_eq!(receipt.action, "comment");
    assert!(receipt.ok, "假页面回了确认，回执必须是成功");
    assert_eq!(result.effect_phase, EffectPhase::Confirmed);

    drop(engine);
    let observed = server.await.expect("fake page");
    let chunks = observed.inserted_chunks();
    // ① 真的分多次派发，而不是一次性赋值。
    assert!(
        chunks.len() >= 2,
        "文本必须逐字 / 分块派发，实测只有 {} 次写入",
        chunks.len()
    );
    // ② 拼起来逐字符等于人审看到的终稿（正文 + 换行 + 联系方式串码）。
    assert_eq!(chunks.concat(), "好文，收藏了\nvx-1234");
    assert_eq!(observed.editor, "好文，收藏了\nvx-1234");
    // ③ 落焦与提交都走拟人指针轨迹：多帧移动 + 成对的按下 / 抬起（两次点击 = 各 2 次）。
    assert!(observed.input_events("Input.dispatchMouseEvent") > 2 * 3);
    // ④ 注入路由的同名分支一次都不该被调用 —— 它已被引擎特化截走。
    assert_eq!(observed.evaluated(r#""kind":"interaction_comment""#), 0);
}

#[tokio::test]
async fn a_long_body_caps_round_trips_without_dropping_a_single_character() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(FakePage::default(), cancellation.clone()).await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let body: String = std::iter::repeat_n('字', 5_000).collect();
    let params = json!({
        "kind": "publish_fill_field",
        "params": {"recordId": 7, "seq": 3, "fieldType": "content", "value": body},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 8_000),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::PublishReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    assert!(receipt.ok, "5000 字必须写得完：{:?}", receipt.error);

    drop(engine);
    let observed = server.await.expect("fake page");
    let chunks = observed.inserted_chunks();
    assert!(chunks.len() >= 2, "长正文仍必须分多次派发");
    assert!(chunks.len() <= 240, "往返数越过上限：{} 次", chunks.len());
    // 红线：封顶只缩往返与停顿 —— 一个字符都不许少。
    assert_eq!(chunks.concat().chars().count(), 5_000);
    assert_eq!(observed.editor, body);
}

#[tokio::test]
async fn a_typing_deadline_clears_the_editor_and_fails_honestly() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            insert_delay_ms: 3_000,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let body: String = std::iter::repeat_n('字', 600).collect();
    let params = json!({
        "kind": "publish_fill_field",
        "params": {"recordId": 7, "seq": 4, "fieldType": "content", "value": body},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 5_500),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::PublishReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    assert!(!receipt.ok, "预算耗尽绝不许报成功");
    assert_eq!(
        receipt.error.as_deref(),
        Some("publish_field_deadline_exceeded")
    );

    drop(engine);
    let observed = server.await.expect("fake page");
    // 写了一半就超预算：编辑器必须被清空，不留半截草稿给下一次拼接 / 提交。
    assert!(!observed.inserted_chunks().is_empty(), "本轮确实写过一部分");
    assert_eq!(observed.editor, "", "失败出口必须先清场再回执");
}

#[tokio::test]
async fn a_takeover_during_typing_passes_through_as_cancelled() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            cancel_after_inserts: 2,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let body: String = std::iter::repeat_n('字', 400).collect();
    let params = json!({
        "kind": "publish_fill_field",
        "params": {"recordId": 7, "seq": 5, "fieldType": "content", "value": body},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 20_000),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    // 接管**原样穿出**：是一条取消错误，不是一条普通失败回执。
    let error = result.error.expect("takeover must surface as an error");
    assert_eq!(error.code, ErrorCode::Cancelled);
    assert!(result.output.is_none());

    drop(engine);
    let observed = server.await.expect("fake page");
    assert!(
        observed.inserted_chunks().len() >= 2,
        "接管发生在打字过程中（已经写过至少两块）"
    );
    assert_eq!(observed.editor, "", "让位之前必须先清场");
}

#[tokio::test]
async fn a_newline_in_the_rich_text_body_is_a_bare_enter_key_and_never_a_typed_character() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            plain_value: false,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let params = json!({
        "kind": "publish_fill_field",
        "params": {"recordId": 7, "seq": 6, "fieldType": "content", "value": "第一段内容\n第二段内容"},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 20_000),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::PublishReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    assert!(receipt.ok, "两段正文必须写得完：{:?}", receipt.error);

    drop(engine);
    let observed = server.await.expect("fake page");
    // ① 文本写入结构上不携带回车符。
    for chunk in observed.inserted_chunks() {
        assert!(
            !chunk.contains('\n') && !chunk.contains('\r'),
            "文本写入携带了回车符：{chunk:?}"
        );
    }
    // ② 换行改由独立的裸回车按键完成，次数恰等于正文里的换行数。
    assert_eq!(observed.enter_presses, 1);
    // ③ 每次回车之后都做了有界归尾确认（连续两轮命中才收敛 ⇒ 至少两次探针）。
    assert!(observed.evaluated(r#""kind":"content_caret_state""#) >= 2);
    assert_eq!(observed.editor, "第一段内容\n第二段内容");
}

/// 富文本正文的换行被编辑器吞掉（回车被 #话题 / @ 候选浮层接走）时，
/// MUST NOT 报 Confirmed —— 那是「静默假成功」的教科书形态。
///
/// 这一场专门躲开另外三道闸：首段满 20 字 ⇒ 头部前缀照样命中；归一把换行折成单空格、
/// 汉字档只留汉字 ⇒ 两道文本比对都对换行免疫。于是**只剩换行的结构证据**（段落数）拦得住它，
/// 而那道闸曾被限死在受控框上 —— 恰好是**唯一不走裸回车、最不可能丢段**的那条分支。
#[tokio::test]
async fn a_swallowed_paragraph_break_is_never_reported_as_a_confirmed_body() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            plain_value: false,
            swallow_enter: true,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let params = json!({
        "kind": "publish_fill_field",
        "params": {
            "recordId": 7, "seq": 9, "fieldType": "content",
            "value": "第一段内容第一段内容第一段内容第一段内容\n第二段内容",
        },
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 20_000),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::PublishReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    assert!(!receipt.ok, "两段正文只落地一段，绝不许报成功");
    assert_eq!(
        receipt.error.as_deref(),
        Some("publish_content_paragraphs_lost")
    );
    assert_eq!(result.effect_phase, EffectPhase::Ambiguous);

    drop(engine);
    let observed = server.await.expect("fake page");
    assert_eq!(
        observed.enter_presses, 1,
        "回车确实按下去了 —— 是编辑器吞的"
    );
    assert_eq!(observed.editor, "", "失败出口必须先清场");
}

/// 打字**完成之后**的接管：取消原样穿出，但让位之前编辑器必须先清空。
/// 不清场的现场是：人接手时，页面上正躺着一条填好、只差点一下发送的评论。
#[tokio::test]
async fn a_takeover_after_typing_still_clears_the_editor_before_it_surfaces() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            // 回读始终对不上 ⇒ 命令停在回读轮询里，接管缝落在打字之后。
            readback_override: Some("别人写的评论"),
            cancel_at_editor_probe: 2,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(
                1,
                command(
                    r#"{"kind":"interaction_comment","params":{"noteId":"note-1","text":"好文，收藏了","groupChatCode":"vx-1234"}}"#,
                ),
                12_000,
            ),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let error = result.error.expect("takeover must surface as an error");
    assert_eq!(
        error.code,
        ErrorCode::Cancelled,
        "接管原样穿出，不吞成普通失败"
    );
    assert!(result.output.is_none());

    drop(engine);
    let observed = server.await.expect("fake page");
    assert!(
        !observed.inserted_chunks().is_empty(),
        "接管发生在打字完成之后（这一轮确实写进去了）"
    );
    assert_eq!(observed.editor, "", "让位之前必须先清场");
}

/// 打字完成之后探针报错（CDP 抖动）：错误照样上抛，但编辑器不许留着半截草稿。
#[tokio::test]
async fn a_probe_failure_after_typing_clears_the_editor_before_it_surfaces() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            reject_editor_probe_at: 2,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let params = json!({
        "kind": "publish_fill_field",
        "params": {"recordId": 7, "seq": 10, "fieldType": "content", "value": "正文内容正文内容正文内容"},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 20_000),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    assert!(result.error.is_some(), "探针报错必须上抛，不得静默当成收敛");
    assert!(result.output.is_none());

    drop(engine);
    let observed = server.await.expect("fake page");
    assert!(!observed.inserted_chunks().is_empty(), "这一轮确实写过");
    assert_eq!(observed.editor, "", "失败出口必须先清场");
}

/// 有界回读始终对不上 ⇒ 诚实回 Ambiguous + 清场，MUST NOT 因为「写完了」就报 Confirmed。
#[tokio::test]
async fn a_body_that_never_reads_back_is_reported_ambiguous_instead_of_confirmed() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            readback_override: Some("完全不相干的内容"),
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let params = json!({
        "kind": "publish_fill_field",
        "params": {"recordId": 7, "seq": 11, "fieldType": "content", "value": "正文内容正文内容正文内容"},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 20_000),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::PublishReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    assert!(!receipt.ok, "回读没确认就报成功 = 静默假成功");
    assert_eq!(
        receipt.error.as_deref(),
        Some("publish_field_readback_mismatch")
    );
    assert_eq!(result.effect_phase, EffectPhase::Ambiguous);

    drop(engine);
    let observed = server.await.expect("fake page");
    assert!(!observed.inserted_chunks().is_empty(), "这一轮确实写过");
    assert_eq!(observed.editor, "", "失败出口必须先清场");
}

/// 评论回读没确认 ⇒ 在提交被点之前就诚实拒绝。提交是不可逆的，
/// 「写完了但没读到」绝不能一路点下去。
#[tokio::test]
async fn a_comment_that_never_reads_back_is_refused_before_the_submit_is_ever_clicked() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            readback_override: Some("别人写的评论"),
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(
                1,
                command(
                    r#"{"kind":"interaction_comment","params":{"noteId":"note-1","text":"好文，收藏了"}}"#,
                ),
                12_000,
            ),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::ActionReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected an action receipt");
    };
    assert!(!receipt.ok);
    assert_eq!(receipt.reason.as_deref(), Some("comment_readback_mismatch"));
    assert_eq!(result.effect_phase, EffectPhase::NotStarted);

    drop(engine);
    let observed = server.await.expect("fake page");
    // 整条命令只该有落焦那一次点击：提交一次都没被按下去。
    assert_eq!(
        observed.mouse_events("mousePressed"),
        1,
        "回读没确认却把提交点下去了"
    );
    assert_eq!(observed.editor, "", "拒绝出口必须先清场");
}

/// 编辑器的无害改写不该判成内容丢失 —— 严格等值会误杀。
/// 这一场**不含汉字**，所以只有语义相似度那一档救得了它（汉字退化档结构上进不去）。
#[tokio::test]
async fn a_harmless_rewrite_without_hanzi_still_confirms_through_the_similarity_lane() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            readback_override: Some("Hello world this is the body of the nate"),
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let params = json!({
        "kind": "publish_fill_field",
        "params": {
            "recordId": 7, "seq": 12, "fieldType": "content",
            "value": "Hello world this is the body of the note",
        },
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 20_000),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::PublishReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    assert!(
        receipt.ok,
        "一个字符的无害改写被判成内容丢失：{:?}",
        receipt.error
    );
    assert_eq!(result.effect_phase, EffectPhase::Confirmed);

    drop(engine);
    let _ = server.await.expect("fake page");
}

/// 全角 → 半角标点的整批改写：相似度会被拉到阈值以下，只有**汉字档退化比较**救得了它。
#[tokio::test]
async fn a_full_width_punctuation_rewrite_still_confirms_through_the_hanzi_lane() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            readback_override: Some("一二三四五六七八九十一二三四五六七八九十,,,,,,,,,,"),
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let params = json!({
        "kind": "publish_fill_field",
        "params": {
            "recordId": 7, "seq": 13, "fieldType": "content",
            "value": "一二三四五六七八九十一二三四五六七八九十，，，，，，，，，，",
        },
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 20_000),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::PublishReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    assert!(receipt.ok, "全半角改写被判成内容丢失：{:?}", receipt.error);
    assert_eq!(result.effect_phase, EffectPhase::Confirmed);

    drop(engine);
    let _ = server.await.expect("fake page");
}

/// 归尾确认的预算按**实际流逝**限界，不按「预算 ÷ 间隔」推算轮数。
///
/// 推算法漏掉了每轮的一次 `Runtime.evaluate` 往返（真机几十毫秒），实际墙钟能到分配值的两倍以上；
/// 而 `xhs_fill_budget` 正是按这个分配值把可用窗口的**一半**划给归尾确认的 —— 前提不成立时，
/// 12 段正文会把窗口吃干，正文那一半反而撞死线。
///
/// 判据取**探针次数**而非墙钟：往返由假页面强制成 200ms，推算法必然跑满 18 轮（1500ms ÷ 80ms），
/// 按实际流逝限界只跑得下 6 轮左右。
#[tokio::test]
async fn the_settle_confirmation_spends_the_budget_it_was_given_not_twice_that() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            plain_value: false,
            caret_probe_delay_ms: 200,
            caret_never_settles: true,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let params = json!({
        "kind": "publish_fill_field",
        "params": {"recordId": 7, "seq": 14, "fieldType": "content", "value": "第一段内容\n第二段内容"},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 20_000),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::PublishReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    // 始终没稳住 ⇒ 诚实失败（而不是「读不到」那一态）。
    assert_eq!(
        receipt.error.as_deref(),
        Some("publish_content_newline_unstable")
    );

    drop(engine);
    let observed = server.await.expect("fake page");
    let probes = observed.evaluated(r#""kind":"content_caret_state""#);
    assert!(
        probes >= 2,
        "至少要真的探两轮，否则这条断言是空跑：{probes}"
    );
    assert!(
        probes <= 10,
        "归尾确认按名义间隔推算轮数（1500ms÷80ms=18 轮），把分配给它的预算花掉了两倍以上：实测 {probes} 轮",
    );
}

/// 富文本评论框 + 联系方式串码：结构上带不了那条分隔换行 ⇒ **零派发**拒绝。
///
/// 字面 `\n` 在富文本里常常什么都不产生，而改走裸回车会把只写了一半的评论提交出去 ——
/// 比丢一条换行严重得多的不可逆后果。所以这里一个字符都不写、一次点击都不派发。
#[tokio::test]
async fn a_rich_text_comment_box_refuses_the_contact_separator_before_anything_is_dispatched() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            plain_value: false,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(
                1,
                command(
                    r#"{"kind":"interaction_comment","params":{"noteId":"note-1","text":"好文，收藏了","groupChatCode":"vx-1234"}}"#,
                ),
                12_000,
            ),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::ActionReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected an action receipt");
    };
    assert!(!receipt.ok);
    assert_eq!(
        receipt.reason.as_deref(),
        Some("comment_editor_cannot_carry_separator")
    );
    assert_eq!(result.effect_phase, EffectPhase::NotStarted);

    drop(engine);
    let observed = server.await.expect("fake page");
    assert!(
        observed.inserted_chunks().is_empty(),
        "零派发：一个字符都不许写"
    );
    assert_eq!(
        observed.mouse_events("mousePressed"),
        0,
        "零派发：一次点击都不许有"
    );
    assert_eq!(observed.enter_presses, 0, "评论框上的回车是提交，绝不许按");
}

/// 受控框里那条分隔换行被吞掉：两道文本比对都看不见（归一把换行折成空格），
/// 只剩段落数这一条结构证据拦得住 —— 拦不住的后果是「审=发」被破坏而没有任何一层发现。
#[tokio::test]
async fn a_swallowed_contact_separator_is_refused_before_the_submit_is_ever_clicked() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            swallow_literal_newline: true,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(
                1,
                command(
                    r#"{"kind":"interaction_comment","params":{"noteId":"note-1","text":"好文，收藏了","groupChatCode":"vx-1234"}}"#,
                ),
                12_000,
            ),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::ActionReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected an action receipt");
    };
    assert!(!receipt.ok, "终稿与人审看到的不是同一份，绝不许报成功");
    assert_eq!(receipt.reason.as_deref(), Some("comment_separator_lost"));
    assert_eq!(result.effect_phase, EffectPhase::NotStarted);

    drop(engine);
    let observed = server.await.expect("fake page");
    // 正文与串码都在、顺序也对 —— 两道文本比对确实放行了，是段落数这一条拦住的。
    assert!(
        observed.inserted_chunks().concat().contains('\n'),
        "换行确实写出去了 —— 是编辑器吞的"
    );
    assert_eq!(
        observed.mouse_events("mousePressed"),
        1,
        "只该有落焦那一次点击：提交一次都没被按下去"
    );
    assert_eq!(observed.editor, "", "拒绝出口必须先清场");
}

/// 分片脚本抛异常时，**所有**布尔判定都读不到。折成 false 会把病因记成一个不存在的现场：
/// 真机上照着 `editor_not_clean` 去查「上一条评论的残文」，而编辑器其实是空的。
#[tokio::test]
async fn a_probe_that_threw_is_reported_as_unreadable_and_never_as_a_dirty_editor() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            throw_at_editor_op: Some("clear"),
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(
                1,
                command(
                    r#"{"kind":"interaction_comment","params":{"noteId":"note-1","text":"好文，收藏了"}}"#,
                ),
                12_000,
            ),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::ActionReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected an action receipt");
    };
    assert!(!receipt.ok);
    assert_eq!(
        receipt.reason.as_deref(),
        Some("comment_editor_clear_unreadable"),
        "「读不到」被折成了「读到了一个坏消息」"
    );
    assert_eq!(result.effect_phase, EffectPhase::NotStarted);

    drop(engine);
    let observed = server.await.expect("fake page");
    assert!(
        observed.inserted_chunks().is_empty(),
        "判据读不到时一个字符都不许写"
    );
}

/// 清场分片**自称**清干净了，落焦回读却发现编辑器里还躺着上一条评论的残文 —— 以回读为准。
///
/// 这道复核是「审=发」的最后一环，也是唯一一环：清场那一拍的读数是分片自己给的，
/// 它说干净就干净；只有换一拍、换一道 `op` 再读一次，才可能撞见判据与真实 DOM 不一致的现场。
/// 少了它，新评论会被逐字追加到残文后面发出去 —— 人审看到的终稿与真正发出去的不是同一份。
/// 而后面那道回读比对用的是 `find(body)`（子串命中即可），残文在前照样命中、顺序照样正确，
/// 于是 `ok=true`：这条链路上**没有任何一层**会发现，只能靠这条用例守。
#[tokio::test]
async fn a_draft_that_survived_a_clear_claiming_success_is_refused_before_any_keystroke() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            residual_after_clear: Some("上一条没发出去的评论"),
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(
                1,
                command(
                    r#"{"kind":"interaction_comment","params":{"noteId":"note-1","text":"好文，收藏了"}}"#,
                ),
                12_000,
            ),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::ActionReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected an action receipt");
    };
    assert!(!receipt.ok);
    assert_eq!(
        receipt.reason.as_deref(),
        Some("editor_not_clean"),
        "残文还在就往里写，发出去的是「残文 + 新评论」",
    );
    assert_eq!(result.effect_phase, EffectPhase::NotStarted);

    drop(engine);
    let observed = server.await.expect("fake page");
    assert!(
        observed.inserted_chunks().is_empty(),
        "零派发：编辑器不干净时一个字符都不许写",
    );
    assert_eq!(
        observed.mouse_events("mousePressed"),
        1,
        "只该有落焦那一次点击：提交一次都没被按下去",
    );
}

/// 降级判据不是死码：一次慢往返（单调 `max` 放大器）足以把剩余尾巴推进「买不起拟人粒度」的区间，
/// 真的产生一次远超人感上限的整块写入。内容仍然一个字符都不许少。
///
/// 这一条钉的是**可达性**——降级标记会在真实流量里点亮；「标记 ⇒ 记账行」那半边由
/// `input.rs` 的单元用例钉死（记账行本身走 stderr，libtest 没有稳定接口读回自己的输出）。
#[tokio::test]
async fn one_slow_round_trip_pushes_the_tail_past_the_humane_chunk_bound() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            first_insert_stall_ms: 4_000,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let body: String = std::iter::repeat_n('字', 2_000).collect();
    let params = json!({
        "kind": "publish_fill_field",
        "params": {"recordId": 7, "seq": 15, "fieldType": "content", "value": body},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 14_000),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::PublishReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    assert!(receipt.ok, "降级不许把内容写丢：{:?}", receipt.error);

    drop(engine);
    let observed = server.await.expect("fake page");
    let widest = observed
        .inserted_chunks()
        .iter()
        .map(|chunk| chunk.chars().count())
        .max()
        .unwrap_or_default();
    assert!(
        widest > 120,
        "这一场本该落进降级区间（最大单次写入 {widest} 字），否则上面那条断言什么也没证明",
    );
    assert_eq!(observed.editor, body, "封顶只缩往返与停顿，绝不缩内容");
}

/// 提交按钮已经按下去 ⇒ 这条评论**可能已经发出去了**。此后确认这一层只有三种读数，
/// 只有「读到它出现了」那一种配 Confirmed。
///
/// 另外两种压成 Confirmed 的代价不同、但都不可接受：
///  - 读到「没出现」压成成功 ⇒ 上游不再重投，这条评论就此丢了，没有任何一层会发现；
///  - **读不到**压成成功 ⇒ 把「不知道」说成「确定成了」，正是红线本身。
///
/// 两种都回 Ambiguous，但病因必须分开记：前者指向提交多半没生效，后者指向确认层自己瞎了。
/// 真机上这是唯一能把它们分开的证据。
#[tokio::test]
async fn a_comment_ack_that_is_not_a_clear_yes_stays_ambiguous_with_its_own_cause() {
    for (ack, cause) in [
        (Some(false), "submitted_unconfirmed"),
        (None, "submitted_ack_unreadable"),
    ] {
        let cancellation = Arc::new(AtomicBool::new(false));
        let (port, server) = spawn_page(
            FakePage {
                ack_appeared: ack,
                ..FakePage::default()
            },
            cancellation.clone(),
        )
        .await;
        let mut engine = Engine::default();
        engine.open(&session_open(port)).await.expect("open");

        let result = engine
            .execute_cancellable_with_commit_windows(
                &write_command(
                    1,
                    command(
                        r#"{"kind":"interaction_comment","params":{"noteId":"note-1","text":"好文，收藏了"}}"#,
                    ),
                    12_000,
                ),
                cancellation,
                CommitWindowRequester::in_process(1),
                EndpointResolver::in_process(1),
            )
            .await
            .expect("command result");

        let CommandOutput::ActionReceipt(receipt) = result.output.expect("receipt") else {
            panic!("expected an action receipt");
        };
        assert!(
            !receipt.ok,
            "确认层没读到「出现了」就报成功 = 静默假成功（ack={ack:?}）"
        );
        assert_eq!(
            receipt.reason.as_deref(),
            Some(cause),
            "两种读数的病因被压成了一态（ack={ack:?}）"
        );
        assert_eq!(
            result.effect_phase,
            EffectPhase::Ambiguous,
            "提交已派发，既不是 Confirmed 也不是 NotStarted（ack={ack:?}）"
        );

        drop(engine);
        let observed = server.await.expect("fake page");
        // 「可能已发出」不是修辞：提交那一下真的按下去了，所以绝不许回「没开始」。
        assert_eq!(
            observed.mouse_events("mousePressed"),
            2,
            "落焦 + 提交各一次（ack={ack:?}）"
        );
    }
}

/// 评论到达确认要**两条独立证据**，缺一不可（H.1）：正文出现在评论区，且编辑器已被平台清空。
///
/// 迁移到原生引擎时丢掉的正是后者 —— 退役实现把它当结构必要条件。丢掉之后判据只剩一条
/// 宽松子串扫描：详情页内任一 class 含 comment 的元素，整段文本包含本次正文即判确认。
/// 而**我们自己刚写进去的正文就在页面上**（富文本编辑器的 textContent 是活的），
/// 它但凡落进那张扫描网，确认就恒真 —— 一条根本没发出去的评论会被回报成已确认。
/// 今天挡住它的只是一个没有任何用例断言过的 DOM 嵌套巧合。
///
/// 「读到了、没清空」与「压根读不到」同样分两态：两者都不是确认，但真机上要查的东西不同。
#[tokio::test]
async fn a_comment_ack_needs_the_editor_to_have_been_cleared_by_the_platform() {
    for (cleared, cause) in [
        (Some(false), "submitted_editor_not_cleared"),
        (None, "submitted_ack_unreadable"),
    ] {
        let cancellation = Arc::new(AtomicBool::new(false));
        let (port, server) = spawn_page(
            FakePage {
                // 业务结果那一条**读到了「出现了」** —— 单看它，改动前会当场判确认。
                ack_appeared: Some(true),
                ack_editor_cleared: cleared,
                ..FakePage::default()
            },
            cancellation.clone(),
        )
        .await;
        let mut engine = Engine::default();
        engine.open(&session_open(port)).await.expect("open");

        let result = engine
            .execute_cancellable_with_commit_windows(
                &write_command(
                    1,
                    command(
                        r#"{"kind":"interaction_comment","params":{"noteId":"note-1","text":"好文，收藏了"}}"#,
                    ),
                    12_000,
                ),
                cancellation,
                CommitWindowRequester::in_process(1),
                EndpointResolver::in_process(1),
            )
            .await
            .expect("command result");

        let CommandOutput::ActionReceipt(receipt) = result.output.expect("receipt") else {
            panic!("expected an action receipt");
        };
        assert!(
            !receipt.ok,
            "结构必要条件不成立仍报确认 = 一条宽松子串扫描说了算（cleared={cleared:?}）",
        );
        assert_eq!(
            receipt.reason.as_deref(),
            Some(cause),
            "「没清空」与「读不到」的病因被压成一态（cleared={cleared:?}）",
        );
        assert_eq!(result.effect_phase, EffectPhase::Ambiguous);

        drop(engine);
        let _ = server.await.expect("fake page");
    }
}

/// 两条证据都成立才配 Confirmed —— 上一条用例只证明了「缺一条会被拦下」，
/// 不证明「齐了就放行」。少了这一条，把确认闸改成恒假同样全绿。
#[tokio::test]
async fn a_comment_ack_with_both_evidences_confirms() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            ack_appeared: Some(true),
            ack_editor_cleared: Some(true),
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(
                1,
                command(
                    r#"{"kind":"interaction_comment","params":{"noteId":"note-1","text":"好文，收藏了"}}"#,
                ),
                12_000,
            ),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::ActionReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected an action receipt");
    };
    assert!(receipt.ok, "两条证据齐了却不确认 = 把成功的评论记成不确定");
    assert_eq!(result.effect_phase, EffectPhase::Confirmed);

    drop(engine);
    let _ = server.await.expect("fake page");
}

/// 加话题（8.1 的第三个消费点）：确认必须来自正文里生成的**真话题 token**，
/// 不是「正文里搜得到这几个字」。
///
/// 这一场造的是那条判据说谎时的现场：字打进去了、候选也点了，但平台没把它变成话题。
/// 正文里此刻明明躺着一串 `#关键词`（我们自己打的），所以任何拿正文子串当证据的判据
/// 都会在这里回「成功」—— 而稿子发出去时那只是一串普通文字，拿不到话题带来的分发，
/// 回执上却一切正常。**自证循环：用输入证明输入生效。**
#[tokio::test]
async fn a_topic_that_never_became_a_real_token_is_never_confirmed() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            plain_value: false,
            topic_commits_on_click: false,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let params = json!({
        "kind": "publish_add_with_candidate",
        "params": {"recordId": 9, "seq": 2, "candidateKind": "topic", "value": "考研", "candidates": ["考研"]},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 25_000),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::PublishReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    assert!(!receipt.ok, "话题没真的贴上却报成功 = 静默假成功");
    assert_eq!(
        receipt.error.as_deref(),
        Some("publish_candidate_unconfirmed")
    );
    // 字已经打进正文了 ⇒ 这一条 MUST NOT 回「未开始」（那等于说正文没被碰过）。
    assert_eq!(result.effect_phase, EffectPhase::Ambiguous);

    drop(engine);
    let observed = server.await.expect("fake page");
    // 正文里确实躺着我们打进去的那串字 —— 这正是旧判据会读到并当成证据的东西。
    assert!(
        observed.editor.contains("#考研"),
        "这一场的前提是正文里真有那串字，否则它什么也没证明：{:?}",
        observed.editor
    );
}

/// 反向那一半：真 token 出来了才配 Confirmed。少了它，把确认闸改成恒假同样全绿。
/// 顺带钉住三件只有到这一步才成立的事：逐字打、拟人指针点候选、注入路由分支零调用。
#[tokio::test]
async fn a_topic_that_became_a_real_token_confirms_after_hardware_typing() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            plain_value: false,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let params = json!({
        "kind": "publish_add_with_candidate",
        "params": {"recordId": 9, "seq": 2, "candidateKind": "topic", "value": "考研", "candidates": ["考研"]},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 25_000),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::PublishReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    assert!(receipt.ok, "真 token 出来了却不确认：{:?}", receipt.error);
    assert_eq!(result.effect_phase, EffectPhase::Confirmed);

    drop(engine);
    let observed = server.await.expect("fake page");
    // ① 触发串是**逐字**打出去的，不是把整段正文重新赋值一次。
    let chunks = observed.inserted_chunks();
    assert!(
        chunks.len() >= " #考研".chars().count(),
        "触发串必须逐字派发，实得 {} 次写入：{chunks:?}",
        chunks.len()
    );
    assert_eq!(chunks.concat(), " #考研");
    // ② 候选是**拟人指针轨迹**点的：页面侧 .click() 实测不提交那个待定 span。
    assert!(observed.input_events("Input.dispatchMouseEvent") > 2 * 2);
    // ③ 注入路由的同名分支一次都不该被调用 —— 已被引擎特化截走。
    assert_eq!(
        observed.evaluated(r#""kind":"publish_add_with_candidate""#),
        0
    );
}

/// 下拉里既没有精确候选、也没有「新建话题」时 MUST **不点**。
///
/// 随便点一个的代价是**不可逆**：稿子上贴了一个无关话题，之后没有任何一步会去撤它。
/// 诚实的做法是不点、如实回未确认 —— 正文里会留下一串裸 `#关键词`（与退役实现同行为），
/// 而云端把这条指令算作尽力而为，稿子照发。
#[tokio::test]
async fn a_dropdown_without_a_matching_candidate_is_never_clicked() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            plain_value: false,
            topic_candidate_after_probes: None,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let params = json!({
        "kind": "publish_add_with_candidate",
        "params": {"recordId": 9, "seq": 2, "candidateKind": "topic", "value": "考研", "candidates": ["考研"]},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 25_000),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::PublishReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    assert!(!receipt.ok);
    assert_eq!(
        receipt.error.as_deref(),
        Some("publish_candidate_not_found")
    );
    assert_eq!(result.effect_phase, EffectPhase::Ambiguous);

    drop(engine);
    let observed = server.await.expect("fake page");
    // 只有落焦那一次点击，没有第二次 —— 候选一次都没被点。
    assert_eq!(
        observed.mouse_events("mousePressed"),
        1,
        "认不出目标候选时多点了一下：那一下会贴上一个无关话题"
    );
}

/// 到达确认是**有界轮询**，不是「固定睡一觉之后单次采样」（H.1 的另一半）。
///
/// 单次采样只有一个采样点，落早了就读不到 —— 一条真的发出去了的评论被回报成不确定，
/// 上游据此重投就是重复评论。轮询按迭代次数限界（不按墙钟裸跑），命中即收工，
/// 所以顺利时反而比原来的固定 800ms 更快。
#[tokio::test]
async fn a_slow_platform_still_confirms_because_the_ack_is_polled_not_sampled_once() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            // 前三次探针两条证据都还不成立，第四次才就绪。
            ack_ready_after_probes: 3,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(
                1,
                command(
                    r#"{"kind":"interaction_comment","params":{"noteId":"note-1","text":"好文，收藏了"}}"#,
                ),
                12_000,
            ),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::ActionReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected an action receipt");
    };
    assert!(receipt.ok, "平台慢一点就把已发出的评论报成不确定");
    assert_eq!(result.effect_phase, EffectPhase::Confirmed);

    drop(engine);
    let observed = server.await.expect("fake page");
    let probes = observed.evaluated(r#""kind":"comment_ack""#);
    assert!(
        probes >= 4,
        "确认只探了 {probes} 次 —— 那是单次采样，不是轮询"
    );
}

/// 归尾确认的最后一轮**连间隔都排不下**时，那次零等待的接管 / 死线检查不是可省的礼节。
///
/// 省掉它直接 `break`，接管就被 `NewlineUnstable` 这条本地结局盖掉：上游收到的是一条
/// 「换行没稳住」的普通失败回执，而不是「有人接手了」。红线是接管**原样穿出**——
/// 让位的语义与失败的语义不是一回事，上游对两者的处置也完全不同。
#[tokio::test]
async fn a_takeover_at_the_last_unschedulable_settle_round_still_passes_through() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            plain_value: false,
            // 归尾始终不收敛 ⇒ 命令停在确认循环里，且预算只够排下第一轮。
            caret_never_settles: true,
            caret_probe_delay_ms: 1_450,
            cancel_at_caret_probe: 1,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let params = json!({
        "kind": "publish_fill_field",
        "params": {"recordId": 7, "seq": 16, "fieldType": "content", "value": "甲\n乙"},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 8_000),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let error = result
        .error
        .expect("接管必须原样穿出，不许被「没稳住」盖成一条普通回执");
    assert_eq!(error.code, ErrorCode::Cancelled);
    assert!(result.output.is_none());

    drop(engine);
    let observed = server.await.expect("fake page");
    assert_eq!(
        observed.evaluated(r#""kind":"content_caret_state""#),
        1,
        "第二轮连间隔都排不下 —— 正是那次零等待检查该开口的一刻",
    );
    assert_eq!(observed.editor, "", "让位之前必须先清场");
}

/// 段落数**读不到**时放行，就是把「读不到」当成「没有问题」。
///
/// 这一条尤其阴：下面两道文本比对（归一 / 汉字档）对换行完全免疫，段落数是换行仅有的
/// 结构证据。放行的后果不是报错，而是一份段落被吞光的正文以 Confirmed 回报，
/// 发布链继续往下走 —— 没有任何一层会发现。
#[tokio::test]
async fn a_body_whose_paragraph_count_cannot_be_read_is_never_confirmed() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            omit_paragraphs: true,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let body = "第一段内容\n第二段内容";
    let params = json!({
        "kind": "publish_fill_field",
        "params": {"recordId": 7, "seq": 17, "fieldType": "content", "value": body},
    });
    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(1, serde_json::from_value(params).expect("command"), 20_000),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::PublishReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    assert!(!receipt.ok, "段落证据读不到就放行 = 静默假成功");
    assert_eq!(
        receipt.error.as_deref(),
        Some("publish_content_paragraphs_unreadable"),
        "「读不到」被记成了「段落数不够」或者干脆被放行"
    );
    assert_eq!(result.effect_phase, EffectPhase::Ambiguous);

    drop(engine);
    let observed = server.await.expect("fake page");
    // 文本本身一个字都不差：两道文本比对本来会照常放行，拦住它的只有段落这一条。
    assert_eq!(observed.inserted_chunks().concat(), body);
    assert_eq!(observed.editor, "", "失败出口必须先清场");
}

/// 评论路径上的同一道闸，后果更重一级：放行之后紧接着就是**点提交**。
/// 串码在场时终稿必须是「正文 + 换行 + 串码」（审=发），而两道文本比对看不见那条换行——
/// 段落数读不到还照样确认，等于把一条与人审看到的不是同一份的评论发出去。
#[tokio::test]
async fn a_comment_whose_paragraph_count_cannot_be_read_never_reaches_the_submit() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            omit_paragraphs: true,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let result = engine
        .execute_cancellable_with_commit_windows(
            &write_command(
                1,
                command(
                    r#"{"kind":"interaction_comment","params":{"noteId":"note-1","text":"好文，收藏了","groupChatCode":"vx-1234"}}"#,
                ),
                12_000,
            ),
            cancellation,
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");

    let CommandOutput::ActionReceipt(receipt) = result.output.expect("receipt") else {
        panic!("expected an action receipt");
    };
    assert!(!receipt.ok);
    assert_eq!(
        receipt.reason.as_deref(),
        Some("comment_paragraphs_unreadable")
    );
    assert_eq!(result.effect_phase, EffectPhase::NotStarted);

    drop(engine);
    let observed = server.await.expect("fake page");
    assert_eq!(
        observed.mouse_events("mousePressed"),
        1,
        "只该有落焦那一次点击：提交一次都没被按下去"
    );
    assert_eq!(observed.editor, "", "拒绝出口必须先清场");
}

/// 编辑器形态**读不到**时不猜：猜错的两个方向都通向不可逆的错误提交。
///
/// 猜成受控框 ⇒ 往富文本里写字面 `\n`，那条分隔换行常常什么都不产生，终稿与人审看到的
/// 不是同一份；猜成富文本 ⇒ 改走裸回车，而评论框上的回车**就是提交**，会把只写了一半的
/// 评论原样发出去。所以这里在零派发处结构性拒绝，一个字符不写、一次点击不派。
///
/// 发布正文那一处是同一道闸的另一半：猜错只会写出一份「不是那份内容」的正文，
/// 同样必须在开工前拒绝。
#[tokio::test]
async fn an_editor_whose_form_cannot_be_read_refuses_before_a_single_keystroke() {
    let cancellation = Arc::new(AtomicBool::new(false));
    let (port, server) = spawn_page(
        FakePage {
            omit_plain_value: true,
            ..FakePage::default()
        },
        cancellation.clone(),
    )
    .await;
    let mut engine = Engine::default();
    engine.open(&session_open(port)).await.expect("open");

    let comment = engine
        .execute_cancellable_with_commit_windows(
            &write_command(
                1,
                command(
                    r#"{"kind":"interaction_comment","params":{"noteId":"note-1","text":"好文，收藏了","groupChatCode":"vx-1234"}}"#,
                ),
                12_000,
            ),
            cancellation.clone(),
            CommitWindowRequester::in_process(1),
            EndpointResolver::in_process(1),
        )
        .await
        .expect("command result");
    let CommandOutput::ActionReceipt(receipt) = comment.output.expect("receipt") else {
        panic!("expected an action receipt");
    };
    assert_eq!(
        receipt.reason.as_deref(),
        Some("comment_editor_form_unreadable"),
        "形态读不到被当成了读到了"
    );
    assert_eq!(comment.effect_phase, EffectPhase::NotStarted);

    let params = json!({
        "kind": "publish_fill_field",
        "params": {"recordId": 7, "seq": 18, "fieldType": "content", "value": "第一段内容\n第二段内容"},
    });
    let publish = engine
        .execute_cancellable_with_commit_windows(
            &write_command(2, serde_json::from_value(params).expect("command"), 20_000),
            cancellation,
            CommitWindowRequester::in_process(2),
            EndpointResolver::in_process(2),
        )
        .await
        .expect("command result");
    let CommandOutput::PublishReceipt(receipt) = publish.output.expect("receipt") else {
        panic!("expected a publish receipt");
    };
    assert_eq!(
        receipt.error.as_deref(),
        Some("publish_field_form_unreadable"),
        "形态读不到被当成了读到了"
    );
    assert_eq!(publish.effect_phase, EffectPhase::NotStarted);

    drop(engine);
    let observed = server.await.expect("fake page");
    assert!(
        observed.inserted_chunks().is_empty(),
        "零派发：一个字符都不许写"
    );
    assert_eq!(
        observed.mouse_events("mousePressed"),
        0,
        "零派发：一次点击都不许有"
    );
    assert_eq!(observed.enter_presses, 0, "零派发：一次回车都不许按");
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

/// 命令原子预算 = `min(会话 timeout_ms, 命令上限)`，只放宽 `deadline_unix_ms` 无效。
fn session_open(port: u16) -> SessionOpenRecord {
    SessionOpenRecord {
        protocol_version: 2,
        id: "open-typing".to_owned(),
        session_id: "session-typing".to_owned(),
        task_id: "browse-typing".to_owned(),
        params: SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Xiaohongshu,
            timeout_ms: 30_000,
            browser_debugger_url: None,
        },
    }
}

fn write_command(command_id: u64, command: NativeCommand, budget_ms: u64) -> CommandRecord {
    CommandRecord {
        protocol_version: 2,
        id: format!("command-{command_id}"),
        session_id: "session-typing".to_owned(),
        task_id: "browse-typing".to_owned(),
        command_id,
        deadline_unix_ms: unix_time_ms() + budget_ms,
        command,
    }
}

/// 一台会「记住被写进去了什么」的假页面：文本写入累加进编辑器，裸回车按 ProseMirror 的语义
/// 在编辑器里拆一段。页面判据分片按 `kind` / `op` 作答。
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
            "id": "target-typing",
            "type": "page",
            "url": "https://www.xiaohongshu.com/explore/note-1",
            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/target-typing")
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
            editor: String::new(),
            enter_presses: 0,
            editor_probes: 0,
            ack_probes: 0,
            topic_candidate_probes: 0,
        };
        let mut inserts = 0_usize;
        let mut caret_probes = 0_usize;
        while let Some(Ok(Message::Text(text))) = websocket.next().await {
            let request: Value = serde_json::from_str(&text).expect("request JSON");
            let id = request["id"].as_u64().expect("request id");
            let method = request["method"].as_str().unwrap_or_default().to_owned();
            let expression = request
                .pointer("/params/expression")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();

            if method == "Input.insertText" {
                let chunk = request
                    .pointer("/params/text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !(page.swallow_literal_newline && chunk == "\n") {
                    observed.editor.push_str(chunk);
                }
                inserts += 1;
                if inserts == 1 && page.first_insert_stall_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(page.first_insert_stall_ms)).await;
                }
                if page.insert_delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(page.insert_delay_ms)).await;
                }
                if page.cancel_after_inserts > 0 && inserts == page.cancel_after_inserts {
                    cancellation.store(true, Ordering::Release);
                }
            }
            if method == "Input.dispatchKeyEvent"
                && request.pointer("/params/key").and_then(Value::as_str) == Some("Enter")
                && request.pointer("/params/type").and_then(Value::as_str) == Some("rawKeyDown")
            {
                observed.enter_presses += 1;
                // 吞回车的现场：按键计数照增（归尾探针据此认为换行数已达标），
                // 但编辑器里不真的拆出新的一段。
                if !page.swallow_enter {
                    observed.editor.push('\n');
                }
            }

            if method == "Runtime.evaluate"
                && expression.contains(r#""kind":"content_caret_state""#)
            {
                if page.caret_probe_delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(page.caret_probe_delay_ms)).await;
                }
                caret_probes += 1;
                if page.cancel_at_caret_probe > 0 && caret_probes == page.cancel_at_caret_probe {
                    cancellation.store(true, Ordering::Release);
                }
            }

            let mut rejected = false;
            if method == "Runtime.evaluate" && is_editor_probe(&expression) {
                observed.editor_probes += 1;
                if page.reject_editor_probe_at > 0
                    && observed.editor_probes == page.reject_editor_probe_at
                {
                    rejected = true;
                }
                if page.cancel_at_editor_probe > 0
                    && observed.editor_probes == page.cancel_at_editor_probe
                {
                    cancellation.store(true, Ordering::Release);
                }
            }

            let response = if rejected {
                json!({"id": id, "error": {"code": -32000, "message": "probe rejected"}})
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

fn is_editor_probe(expression: &str) -> bool {
    (expression.contains(r#""kind":"comment_editor""#)
        || expression.contains(r#""kind":"publish_field""#))
        && expression.contains(r#""op":"probe""#)
}

fn evaluate(expression: &str, page: &FakePage, observed: &mut Observed) -> Value {
    if expression.contains("feedCardCount") {
        return json!({"result":{"value":{
            "href": "https://www.xiaohongshu.com/explore/note-1",
            "readyState": "complete",
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
        }}});
    }
    if expression.contains(r#""kind":"note_guard""#) {
        return value(json!({"found": true, "match": true, "noteId": "note-1"}));
    }
    if expression.contains(r#""kind":"topic_candidate""#) {
        observed.topic_candidate_probes += 1;
        return match page.topic_candidate_after_probes {
            Some(ready_after) if observed.topic_candidate_probes > ready_after => value(json!({
                "found": true, "dropdown": true, "matched": "exact",
                "x": TOPIC_CANDIDATE_POINT.0, "y": TOPIC_CANDIDATE_POINT.1,
            })),
            // 下拉在、但里面既没有精确候选也没有「新建话题」：MUST 报没找到，
            // 让引擎**不点** —— 随便点一个会给稿子贴上一个无关话题。
            _ => value(json!({"found": false, "dropdown": true})),
        };
    }
    if expression.contains(r#""kind":"topic_committed""#) {
        // 真 token 只在候选**真的被点过**之后才出现。正文里那串 `#关键词` 一直都在
        // （它是我们自己打进去的），所以任何拿正文子串当证据的判据在这里都会说谎。
        // 落点带 ±3px 抖动（拟人化），所以按**距离**认，不按逐字相等 —— 后者会把
        // 「点到了」误判成「没点」，用例于是变成一个恒红的抖动源。
        let clicked = observed.requests.iter().any(|request| {
            if request["method"] != "Input.dispatchMouseEvent"
                || request["params"]["type"] != "mousePressed"
            {
                return false;
            }
            let (Some(x), Some(y)) = (
                request["params"]["x"].as_f64(),
                request["params"]["y"].as_f64(),
            ) else {
                return false;
            };
            (x - TOPIC_CANDIDATE_POINT.0).abs() <= 8.0 && (y - TOPIC_CANDIDATE_POINT.1).abs() <= 8.0
        });
        let committed = clicked && page.topic_commits_on_click;
        return value(json!({
            "found": true,
            "committed": committed,
            "pills": if committed { 1 } else { 0 },
        }));
    }
    if expression.contains(r#""kind":"comment_submit""#) {
        return value(json!({"found": true, "x": 320.0, "y": 460.0}));
    }
    if expression.contains(r#""kind":"comment_ack""#) {
        observed.ack_probes += 1;
        // 平台还没渲染出来：两条证据都还不成立。单次采样在这里就收工了。
        if observed.ack_probes <= page.ack_ready_after_probes {
            return value(json!({"found": true, "appeared": false, "editorCleared": false}));
        }
        // `None` = 分片抛异常：连 `/result/value` 都没有，`appeared` 因此**读不到**。
        return match page.ack_appeared {
            Some(appeared) => {
                let mut payload = json!({"found": true, "appeared": appeared});
                // 编辑器读不到时分片**不写** `editorCleared` 这个键（缺席 = 读不到），
                // 而不是写一个 false —— 那会把「不知道」说成「读到了、没清空」。
                if let Some(cleared) = page.ack_editor_cleared {
                    payload["editorCleared"] = json!(cleared);
                }
                value(payload)
            }
            None => json!({"exceptionDetails": {
                "text": "Uncaught",
                "exception": {"className": "TypeError", "description": "boom"},
            }}),
        };
    }
    if expression.contains(r#""kind":"content_caret_state""#) {
        return value(json!({
            "found": true,
            "text": normalized(&observed.editor),
            "newlines": observed.enter_presses,
            "atEnd": !page.caret_never_settles,
        }));
    }
    if expression.contains(r#""kind":"comment_editor""#)
        || expression.contains(r#""kind":"publish_field""#)
    {
        // 分片脚本抛异常：`silent:true` 下 CDP 不报错，返回体里只有 `exceptionDetails`。
        // 所有布尔判定因此都读不到 —— 折成 false 的话，病因会被记成一个不存在的现场。
        if let Some(op) = page.throw_at_editor_op
            && expression.contains(&format!(r#""op":"{op}""#))
        {
            return json!({"exceptionDetails": {
                "text": "Uncaught",
                "exception": {"className": "TypeError", "description": "boom"},
            }});
        }
        if expression.contains(r#""op":"cursor_to_end""#) {
            return value(json!({
                "found": true, "cursorAtEnd": true, "focused": true,
                "value": observed.editor.clone(), "plainValue": page.plain_value,
                "x": 240.0, "y": 300.0, "paragraphs": 0,
            }));
        }
        if expression.contains(r#""op":"clear""#) {
            // 清场自称成功那一拍的读数照样是干净的（`cleared:true` / `value:""`），
            // 残文只有在**下一次**读编辑器时才现形 —— 那正是落焦回读那一拍。
            observed.editor = page.residual_after_clear.unwrap_or_default().to_owned();
            return value(json!({
                "found": true, "cleared": true, "focused": true, "value": "",
                "plainValue": page.plain_value, "x": 240.0, "y": 300.0, "paragraphs": 0,
            }));
        }
        // 回读覆盖只作用于 `op:"probe"`：写前的清场 / 落焦读数照报真实状态，
        // 否则「编辑器里还有残文」那道闸会先把用例拦掉，跑不到回读这一段。
        let reported = match page.readback_override {
            Some(text) if expression.contains(r#""op":"probe""#) => text.to_owned(),
            _ => observed.editor.clone(),
        };
        let paragraphs = reported
            .split('\n')
            .filter(|line| !line.trim().is_empty())
            .count();
        let mut reading = json!({
            "found": true, "cleared": reported.is_empty(), "focused": true,
            "value": reported, "plainValue": page.plain_value,
            "x": 240.0, "y": 300.0, "paragraphs": paragraphs,
        });
        // 「判定缺席」的现场：分片没抛异常，只是这一项它给不出来。所有别的判定照常可读 ——
        // 折成 false / 0 的话，缺席会伪装成一个确定的坏消息（或者更糟：一个确定的好消息）。
        let absent = reading.as_object_mut().expect("reading object");
        if page.omit_paragraphs {
            absent.remove("paragraphs");
        }
        if page.omit_plain_value {
            absent.remove("plainValue");
        }
        return value(reading);
    }
    value(json!({"found": false}))
}

fn value(inner: Value) -> Value {
    json!({"result": {"value": inner}})
}

fn normalized(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
