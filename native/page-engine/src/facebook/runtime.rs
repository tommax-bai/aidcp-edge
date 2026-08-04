use super::capability::{self, FacebookCapability};
use super::shared::{
    FACEBOOK_GROUP_ROOT_LANDING_TIMEOUT, cancelled_before_dispatch, canonical_facebook_post_id,
    dispatch_facebook_click, ensure_facebook_action_gate, evaluate_facebook_first_post_router,
    evaluate_facebook_router, evaluate_facebook_router_until_requested_detail,
    facebook_action_result, facebook_command_cancelled, facebook_group_root_landed,
    is_facebook_content_ref, probe_facebook_comment_action, probe_facebook_comment_editor,
    probe_facebook_first_post_group_root, validate_facebook_origin, validated_facebook_group_url,
    wait_for_facebook_group_root_landing, wait_for_facebook_ready,
};
use super::{comment, feed, feed_like, group_join, publish, reels, session};
use crate::command::{
    FeedRefreshParams, NoteOpenParams, NoteOpenSelection, NotePurpose, NoteSurface, ReasonParams,
};
use crate::commit_window::CommitWindowRequester;
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::model::PageCards;
use crate::protocol::{EffectPhase, NativeCommand};
use serde_json::json;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use url::Url;

const FIRST_POST_SCROLL_ROUNDS: usize = 4;
/// 纠正导航预算（change restore-facebook-first-post-recovery）。
///
/// 它与「准备阶段跳没跳」是**两个量**：为准备工作花掉的那次导航 MUST NOT 记作已经重试过。
/// 取 1 沿用改造前的量级——那条自救分支本来也只打算跳一次，本次不动重试深度，只让它真能跑到。
const FIRST_POST_CORRECTIVE_NAVIGATIONS: usize = 1;
/// 认不出来的探测失败以这个名字露出。**MUST NOT 折进任何已有失败名**：
/// 折进去，跨层传下去就成了终局判决，而没有任何作者做过那个决定。
const UNRECOGNIZED_FIRST_POST_PROBE_FAILURE: &str = "unrecognized_probe_failure";
/// 群根导航发出了，但有界窗口内没确认落到那个群根。姿态类，**不是**帖子身份问题。
const FIRST_POST_GROUP_ROOT_NOT_LANDED: FirstPostProbeFailure = FirstPostProbeFailure {
    reason: "group_root_not_landed",
    class: FirstPostFailureClass::Posture,
};
// 首帖这两个窗口是本链的实测失败边界（change restore-facebook-post-join-comment-continuity）：
// 近两日全部首帖失败耗时 9.8–15.8s、全部成功 ≤7s，判别量是页面水合速度而非账号 / 版面 / 群。
// 绑定窗从「文档可交互」起算，而这类群页的内容水合发生在其后，4s 过紧；身份回读窗原为普通读
// 路径同一件事所给窗口（15s）的一半。放宽后外层原子上限必须同步抬（src/native-page-engine/
// browse-session.ts），否则外层先到点、产出的是信息量更低的合成失败。加群侧预算不在本次范围内。
// 2026-07-29 随整体 ×1.5 再放大一档（12→18 / 20→30），外层原子上限同步抬到 135s。
const FIRST_POST_EDITOR_TIMEOUT: Duration = Duration::from_secs(18);
const FIRST_POST_DETAIL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Eq, PartialEq)]
enum FirstPostTarget {
    Permalink(Url),
    BoundRef(String),
}

impl FirstPostTarget {
    fn note_id(&self) -> String {
        match self {
            Self::Permalink(url) => url.to_string(),
            Self::BoundRef(target_ref) => target_ref.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FirstPostGroupRootReuseReason {
    ExactRootReusable,
    ProbeFailed,
    OriginMismatch,
    GroupMismatch,
    NotGroupRoot,
    DocumentNotReady,
    BlockedPage,
    MainUnresolved,
    ScopeUnresolved,
    DialogPresent,
    FeedLoading,
    ScrollNotAtTop,
    ContextChanged,
}

impl FirstPostGroupRootReuseReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::ExactRootReusable => "exact_root_reusable",
            Self::ProbeFailed => "probe_failed",
            Self::OriginMismatch => "origin_mismatch",
            Self::GroupMismatch => "group_mismatch",
            Self::NotGroupRoot => "not_group_root",
            Self::DocumentNotReady => "document_not_ready",
            Self::BlockedPage => "blocked_page",
            Self::MainUnresolved => "main_unresolved",
            Self::ScopeUnresolved => "scope_unresolved",
            Self::DialogPresent => "dialog_present",
            Self::FeedLoading => "feed_loading",
            Self::ScrollNotAtTop => "scroll_not_at_top",
            Self::ContextChanged => "context_changed",
        }
    }
}

/// 探测失败的类别（change restore-facebook-first-post-recovery）。
///
/// 分类决定的是「这一趟继不继续」，不是「回执写什么」——回执永远原样写叶子原因。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FirstPostFailureClass {
    /// 姿态类：只描述目标周边的处境（还没落地、还没水合、区域划不清）。
    /// 换一张重新加载后的页面再来一次，完全可能得到不同结果 ⇒ 有界续跑，MUST NOT 单凭它终局。
    Posture,
    /// 身份类：候选绑定冲突、证据在已解析的候选下变了。
    /// 再走下去有写到**另一条帖子**上的风险 ⇒ 立即终止。
    Identity,
    /// 入参类：请求给过来的根本不是群地址形态。重来多少次都一样 ⇒ 立即终止，
    /// 但与身份类**分开具名**：这条要去查调用方，不是去查页面。
    Request,
}

impl FirstPostFailureClass {
    fn as_str(self) -> &'static str {
        match self {
            Self::Posture => "posture",
            Self::Identity => "identity",
            Self::Request => "request",
        }
    }
}

/// 一次探测失败：上报值 + 类别。两者**成对产出**，杜绝「加了原因值却忘了归类」。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FirstPostProbeFailure {
    reason: &'static str,
    class: FirstPostFailureClass,
}

/// 失败之后走哪一步。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FirstPostRecoveryStep {
    /// 有界纠正：重新导航到群根、确认落地后复测。
    Renavigate,
    /// 终局：如实回叶子原因。
    Terminate,
}

pub(crate) async fn execute(
    engine_session: &mut EngineSession,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    commit_windows: &CommitWindowRequester,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if matches!(
        command,
        NativeCommand::NoteOpen(NoteOpenParams {
            selection: Some(NoteOpenSelection::FirstCommentableGroupPost),
            ..
        })
    ) {
        return execute_first_commentable_group_post(engine_session, command, cancellation).await;
    }
    let owner = capability::owner(command).ok_or_else(|| {
        EngineError::new(
            ErrorCode::UnsupportedCommand,
            "native Facebook command has no capability owner",
        )
    })?;
    match owner {
        FacebookCapability::Session => {
            session::execute(engine_session, command, cancellation, deadline_unix_ms).await
        }
        FacebookCapability::Auth => {
            super::auth::execute(engine_session, command, cancellation, deadline_unix_ms).await
        }
        FacebookCapability::Feed => {
            feed::execute(engine_session, command, cancellation, deadline_unix_ms).await
        }
        FacebookCapability::FeedLike => {
            feed_like::execute(engine_session, command, cancellation, deadline_unix_ms).await
        }
        FacebookCapability::Reels => reels::execute(engine_session, command).await,
        FacebookCapability::GroupJoin => {
            group_join::execute(
                engine_session,
                command,
                cancellation,
                commit_windows,
                deadline_unix_ms,
            )
            .await
        }
        FacebookCapability::Comment => {
            comment::execute(
                engine_session,
                command,
                cancellation,
                commit_windows,
                deadline_unix_ms,
            )
            .await
        }
        FacebookCapability::Publish => {
            publish::execute(
                engine_session,
                command,
                cancellation,
                commit_windows,
                deadline_unix_ms,
            )
            .await
        }
    }
}

async fn execute_first_commentable_group_post(
    session: &mut EngineSession,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let NativeCommand::NoteOpen(params) = command else {
        unreachable!("first-post routing requires note.open");
    };
    if facebook_command_cancelled(cancellation) {
        return Err(cancelled_before_dispatch());
    }
    let group_url = validated_facebook_group_url(params.container.as_deref().unwrap_or_default())?;
    let probe_command = NativeCommand::FeedRefresh(FeedRefreshParams {
        reason: Some("first_commentable_group_post_probe".to_owned()),
        think_ms: None,
    });
    let scroll_command = NativeCommand::BrowseScroll(ReasonParams {
        reason: Some("first_commentable_group_post_probe".to_owned()),
    });

    let (root_probe, probe_error_code) = match probe_facebook_first_post_group_root(session).await {
        Ok(probe) => (Some(probe), None),
        Err(error) => {
            if let Some(diagnostic) = error.bounded_diagnostic_json() {
                eprintln!("native_page_engine_decode_diagnostic:{diagnostic}");
            }
            (None, Some(format!("{:?}", error.code)))
        }
    };
    if facebook_command_cancelled(cancellation) {
        return Err(cancelled_before_dispatch());
    }
    let reuse_reason = root_probe
        .as_ref()
        .map(|probe| first_post_group_root_reuse_reason(probe, &group_url))
        .unwrap_or(FirstPostGroupRootReuseReason::ProbeFailed);
    // 两个量必须分开（change restore-facebook-first-post-recovery）：
    // `prepared_navigation` 只记「准备阶段跳没跳」，供日志与去重；
    // `corrective_budget` 是纠正预算，**初值恒为满额、只被失败递减**。
    // 合成一个变量正是那条自救分支静态不可达的根因：加群之后起始页几乎必然不是干净群根
    // ⇒ 准备必跳 ⇒ 标记必真 ⇒ 要求「还没跳过」的自救分支永远走不到，
    // 而唯一能用上它的情形恰恰是「页面本来就对、根本不需要自救」。
    let prepared_navigation = reuse_reason != FirstPostGroupRootReuseReason::ExactRootReusable;
    let mut corrective_budget = initial_first_post_corrective_budget(prepared_navigation);
    let mut corrective_spent = 0usize;
    log_first_post_group_root_decision(
        session,
        &group_url,
        if prepared_navigation {
            "navigate"
        } else {
            "reuse"
        },
        reuse_reason,
        root_probe.as_ref(),
        probe_error_code.as_deref(),
        if prepared_navigation { 1 } else { 0 },
    );
    let mut pending_failure = if prepared_navigation {
        navigate_first_post_group_root(session, &group_url, cancellation).await?
    } else {
        None
    };

    let mut remaining_scroll_rounds = FIRST_POST_SCROLL_ROUNDS;
    let candidate = loop {
        session.facebook.active_list_url = group_url.to_string();
        session.facebook.seen_post_ids.clear();
        // 落地没确认时不必再把上一页探一遍（那页本来就不是目标），但**阻断浮层照查**：
        // 验证码 / 登录墙本身就会让落地判据不成立，若因此只报「没落地」，真正的原因就被盖掉了。
        let landing_failure = pending_failure.take();
        if landing_failure.is_none() {
            wait_for_facebook_ready(session).await?;
        }
        if let Some(output) = ensure_facebook_action_gate(session, command).await? {
            return Ok((EffectPhase::NotStarted, output));
        }
        let probe_failure = match landing_failure {
            Some(failure) => Some(failure),
            None => {
                let (candidate, probe_failure) = select_first_post_candidate(
                    session,
                    &group_url,
                    &probe_command,
                    &scroll_command,
                    &mut remaining_scroll_rounds,
                    cancellation,
                )
                .await?;
                if let Some(candidate) = candidate {
                    break candidate;
                }
                probe_failure
            }
        };

        if first_post_recovery_step(probe_failure, corrective_budget)
            == FirstPostRecoveryStep::Renavigate
        {
            corrective_budget -= 1;
            corrective_spent += 1;
            pending_failure =
                navigate_first_post_group_root(session, &group_url, cancellation).await?;
            log_first_post_group_root_decision(
                session,
                &group_url,
                "navigate",
                FirstPostGroupRootReuseReason::ContextChanged,
                None,
                None,
                corrective_spent,
            );
            continue;
        }
        eprintln!(
            "native_page_engine_first_post_recovery:{}",
            first_post_recovery_diagnostic(
                probe_failure,
                corrective_spent,
                FIRST_POST_CORRECTIVE_NAVIGATIONS,
            )
        );
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "open_note",
            false,
            first_post_terminal_reason(probe_failure),
            None,
            None,
        ));
    };

    let candidate_id = candidate.note_id();
    if let FirstPostTarget::Permalink(candidate_url) = &candidate {
        if facebook_command_cancelled(cancellation) {
            return Err(cancelled_before_dispatch());
        }
        session.cdp.navigate(candidate_url.as_str()).await?;
        wait_for_facebook_ready(session).await?;
    }

    let editor_reason = wait_for_first_post_editor(
        session,
        &candidate_id,
        FIRST_POST_EDITOR_TIMEOUT,
        cancellation,
    )
    .await?;
    if let Some(reason) = editor_reason {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "open_note",
            false,
            reason,
            Some(candidate_id),
            None,
        ));
    }

    let detail_command = NativeCommand::NoteOpen(NoteOpenParams {
        note_id: Some(candidate_id.clone()),
        url: match &candidate {
            FirstPostTarget::Permalink(url) => Some(url.to_string()),
            FirstPostTarget::BoundRef(_) => None,
        },
        surface: Some(match &candidate {
            FirstPostTarget::Permalink(_) => NoteSurface::Detail,
            FirstPostTarget::BoundRef(_) => NoteSurface::Feed,
        }),
        purpose: Some(NotePurpose::Read),
        ..NoteOpenParams::default()
    });
    let detail = match &candidate {
        FirstPostTarget::Permalink(candidate_url) => {
            let target_post_id = canonical_facebook_post_id(candidate_url.as_str())
                .expect("validated candidate has a post id");
            evaluate_facebook_router_until_requested_detail(
                session,
                &detail_command,
                &target_post_id,
                FIRST_POST_DETAIL_TIMEOUT,
            )
            .await
        }
        FirstPostTarget::BoundRef(target_ref) => {
            evaluate_facebook_router_until_bound_detail(
                session,
                &detail_command,
                target_ref,
                FIRST_POST_DETAIL_TIMEOUT,
            )
            .await
        }
    };
    match detail {
        Ok(result) => Ok(result),
        Err(error) if error.code == ErrorCode::ProbeFailed => Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "open_note",
            false,
            "target_context_mismatch",
            Some(candidate_id),
            None,
        )),
        Err(error) => Err(error),
    }
}

/// 群根导航：发出跳转，然后**真的等它落地**。
///
/// 返回 `Some(...)` 表示有界窗口内没确认落地。那是姿态类失败（可被纠正预算消费），
/// MUST NOT 复用帖子身份的原因值，也 MUST NOT 在这里终局。
async fn navigate_first_post_group_root(
    session: &mut EngineSession,
    group_url: &Url,
    cancellation: Option<&AtomicBool>,
) -> Result<Option<FirstPostProbeFailure>, EngineError> {
    if facebook_command_cancelled(cancellation) {
        return Err(cancelled_before_dispatch());
    }
    session.cdp.navigate(group_url.as_str()).await?;
    let landed = wait_for_facebook_group_root_landing(
        session,
        group_url,
        FACEBOOK_GROUP_ROOT_LANDING_TIMEOUT,
        cancellation,
    )
    .await?;
    Ok((!landed).then_some(FIRST_POST_GROUP_ROOT_NOT_LANDED))
}

async fn select_first_post_candidate(
    session: &mut EngineSession,
    group_url: &Url,
    probe_command: &NativeCommand,
    scroll_command: &NativeCommand,
    remaining_scroll_rounds: &mut usize,
    cancellation: Option<&AtomicBool>,
) -> Result<(Option<FirstPostTarget>, Option<FirstPostProbeFailure>), EngineError> {
    let mut latest = evaluate_facebook_first_post_router(session, probe_command, group_url).await?;
    loop {
        let candidate = first_same_group_post_target(&latest.1, group_url);
        let probe_failure = first_post_probe_failure(&latest.1);
        if probe_failure
            .is_some_and(|failure| failure.reason == UNRECOGNIZED_FIRST_POST_PROBE_FAILURE)
        {
            let raw = first_post_probe_selection_reason(&latest.1).unwrap_or_default();
            eprintln!(
                "native_page_engine_first_post_unrecognized_failure:{}",
                json!({ "selectionReason": bounded_log_value(raw) })
            );
        }
        if first_post_scroll_loop_stops(
            candidate.is_some(),
            probe_failure,
            first_post_probe_is_exhausted(&latest.1),
            *remaining_scroll_rounds,
        ) {
            return Ok((candidate, probe_failure));
        }
        if facebook_command_cancelled(cancellation) {
            return Err(cancelled_before_dispatch());
        }
        *remaining_scroll_rounds -= 1;
        latest = evaluate_facebook_first_post_router(session, scroll_command, group_url).await?;
    }
}

/// 有界下滚这一轮该不该停。
///
/// **姿态类失败不在这里停** —— 下滚预算存在的全部意义就是容忍这类抖动；
/// 一次姿态不符就把剩余轮次全弃掉，等于让预算形同虚设。
/// 身份类与入参类立即停：前者再走下去有写到别的帖子的风险，后者重来也一样。
fn first_post_scroll_loop_stops(
    candidate_found: bool,
    probe_failure: Option<FirstPostProbeFailure>,
    exhausted: bool,
    remaining_scroll_rounds: usize,
) -> bool {
    candidate_found
        || probe_failure.is_some_and(|failure| failure.class != FirstPostFailureClass::Posture)
        || exhausted
        || remaining_scroll_rounds == 0
}

/// 纠正预算的初值：**恒为满额**，与准备阶段跳没跳无关。
///
/// 参数刻意保留：它记的是「这个量曾被错误地与准备动作耦合」这条判例。
/// 一旦把它接回返回值，自救分支立刻重新变成死代码
/// （回归断言见本文件 `the_preparation_jump_never_shrinks_the_corrective_budget`）。
fn initial_first_post_corrective_budget(_prepared_navigation: bool) -> usize {
    FIRST_POST_CORRECTIVE_NAVIGATIONS
}

/// 这一次失败之后走哪一步。
///
/// **准备阶段跳没跳不是这里的输入**——那正是旧实现把自救分支写死的地方。
/// 只看两件事：失败是不是姿态类、纠正预算还剩没剩。
fn first_post_recovery_step(
    probe_failure: Option<FirstPostProbeFailure>,
    corrective_budget: usize,
) -> FirstPostRecoveryStep {
    match probe_failure {
        Some(failure)
            if failure.class == FirstPostFailureClass::Posture && corrective_budget > 0 =>
        {
            FirstPostRecoveryStep::Renavigate
        }
        _ => FirstPostRecoveryStep::Terminate,
    }
}

/// 终局回执的原因值：**原样保留叶子原因**。
///
/// 跨层义务（`docs/stop-or-continue.md` §4）：叶子层可恢复的原因 MUST NOT 在这里被换成
/// 一个读起来像「做不到」的结构性名字。「重试了几次」另走诊断，不覆盖叶子。
fn first_post_terminal_reason(probe_failure: Option<FirstPostProbeFailure>) -> &'static str {
    probe_failure.map_or("no_candidates", |failure| failure.reason)
}

/// 终局诊断：预算耗尽时必须读得出「重试 N 次未成」，而不是一句「做不到」。
fn first_post_recovery_diagnostic(
    probe_failure: Option<FirstPostProbeFailure>,
    corrective_spent: usize,
    corrective_budget: usize,
) -> String {
    json!({
        "reason": first_post_terminal_reason(probe_failure),
        "failureClass": probe_failure.map(|failure| failure.class.as_str()),
        "correctiveNavigationsSpent": corrective_spent,
        "correctiveNavigationBudget": corrective_budget,
        "outcome": if corrective_spent > 0 { "retried_without_success" } else { "not_retried" },
    })
    .to_string()
}

fn first_post_group_root_reuse_reason(
    probe: &super::FacebookFirstPostGroupRootProbe,
    group_url: &Url,
) -> FirstPostGroupRootReuseReason {
    if probe.origin != group_url.origin().ascii_serialization() {
        return FirstPostGroupRootReuseReason::OriginMismatch;
    }
    let expected_path = group_url.path().trim_end_matches('/');
    let observed_path = probe.path.trim_end_matches('/');
    if observed_path != expected_path {
        let expected_parts = path_parts(group_url);
        let observed_parts: Vec<_> = observed_path
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        return if observed_parts.first() == Some(&"groups")
            && observed_parts.get(1) != expected_parts.get(1)
        {
            FirstPostGroupRootReuseReason::GroupMismatch
        } else {
            FirstPostGroupRootReuseReason::NotGroupRoot
        };
    }
    if !probe.search.is_empty() || !probe.hash.is_empty() || probe.surface != "group" {
        return FirstPostGroupRootReuseReason::NotGroupRoot;
    }
    let expected_parts = path_parts(group_url);
    let expected_group_id = expected_parts.get(1).copied().unwrap_or_default();
    if !probe
        .target_group_id
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case(expected_group_id))
    {
        return FirstPostGroupRootReuseReason::GroupMismatch;
    }
    if !matches!(probe.ready_state.as_str(), "interactive" | "complete") {
        return FirstPostGroupRootReuseReason::DocumentNotReady;
    }
    if probe.blocking_kind != "none" {
        return FirstPostGroupRootReuseReason::BlockedPage;
    }
    if probe.visible_main_count != 1 {
        return FirstPostGroupRootReuseReason::MainUnresolved;
    }
    if !probe.scope_resolved || probe.scope_ambiguous {
        return FirstPostGroupRootReuseReason::ScopeUnresolved;
    }
    if probe.visible_dialog_count != 0 {
        return FirstPostGroupRootReuseReason::DialogPresent;
    }
    if probe.feed_loading {
        return FirstPostGroupRootReuseReason::FeedLoading;
    }
    if !probe.scroll_y.is_finite() || !(0.0..=1.0).contains(&probe.scroll_y) {
        return FirstPostGroupRootReuseReason::ScrollNotAtTop;
    }
    FirstPostGroupRootReuseReason::ExactRootReusable
}

fn log_first_post_group_root_decision(
    session: &EngineSession,
    group_url: &Url,
    strategy: &'static str,
    reason: FirstPostGroupRootReuseReason,
    probe: Option<&super::FacebookFirstPostGroupRootProbe>,
    probe_error_code: Option<&str>,
    fallback_count: usize,
) {
    // 诊断只留结论，不留原始页面串（change restore-facebook-first-post-recovery）。
    // `bounded_log_value` 只截长度，**截断不是脱敏**：这行以前随进程丢弃所以无后果，
    // 引擎诊断通路一打通就会持续落进运营机日志，届时地址 / 选择器 / 页面文本一律 MUST NOT 出现。
    // 那两个原始路径（请求的 + 读回的）唯一的用途是人工比对同一件事——
    // 「当前地址是不是请求的那个群根」——那就直接报这个结论。不匹配时「我在哪」由 `surface`
    // 回答，它本来就是有限词表。判据复用落地等待的同一支纯函数：同一个判断只有一份实现，
    // 两处永远不会各自漂。
    let at_requested_group_root = probe.map(|value| {
        facebook_group_root_landed(
            Some(value.origin.as_str()),
            Some(value.path.as_str()),
            Some(value.ready_state.as_str()),
            group_url,
        )
    });
    let surface = probe.map(|value| bounded_log_value(&value.surface));
    let ready_state = probe.map(|value| bounded_log_value(&value.ready_state));
    let blocking_kind = probe.map(|value| bounded_log_value(&value.blocking_kind));
    let diagnostic = json!({
        "strategy": strategy,
        "reason": reason.as_str(),
        "targetId": bounded_log_value(session.cdp.target_id()),
        "atRequestedGroupRoot": at_requested_group_root,
        "surface": surface,
        "readyState": ready_state,
        "blockingKind": blocking_kind,
        "feedLoading": probe.map(|value| value.feed_loading),
        "scrollY": probe.map(|value| value.scroll_y),
        "fallbackCount": fallback_count,
        "probeErrorCode": probe_error_code,
    });
    eprintln!("native_page_engine_first_post_group_root:{diagnostic}");
}

fn bounded_log_value(value: &str) -> String {
    value.chars().take(256).collect()
}

fn first_same_group_post_target(
    output: &CommandOutput,
    group_url: &Url,
) -> Option<FirstPostTarget> {
    let CommandOutput::PageCards(PageCards { cards, .. }) = output else {
        return None;
    };
    cards
        .iter()
        .filter_map(|card| card.note_id.as_deref())
        .find_map(|raw| {
            canonical_same_group_post_url(raw, group_url)
                .map(FirstPostTarget::Permalink)
                .or_else(|| {
                    is_first_post_target_ref(raw).then(|| FirstPostTarget::BoundRef(raw.to_owned()))
                })
        })
}

/// 首帖引用 = 内容派生的会话内引用（同一个东西，同一份判据）。
/// 泛化到整个信息流后判据被多处共用，故收口到 shared，这里只保留本模块的历史命名。
fn is_first_post_target_ref(value: &str) -> bool {
    is_facebook_content_ref(value)
}

fn first_post_probe_selection_reason(output: &CommandOutput) -> Option<&str> {
    let CommandOutput::PageCards(PageCards {
        selection_reason: Some(reason),
        ..
    }) = output
    else {
        return None;
    };
    Some(reason.as_str())
}

fn first_post_probe_failure(output: &CommandOutput) -> Option<FirstPostProbeFailure> {
    first_post_probe_selection_reason(output).map(classify_first_post_probe_reason)
}

/// 页面规则回上来的 selectionReason → 上报值 + 类别。**穷举，不留兜底桶**。
///
/// 旧实现把认不出来的值一律折成 `target_context_mismatch`：那是一个已经有确切含义的失败名，
/// 折进去之后跨层传下去就成了终局判决——而且没有任何作者做过那个决定。
/// 认不出来的一律以「未识别原因」具名露出，并按**姿态类**处置（保守地允许有界续跑）。
fn classify_first_post_probe_reason(reason: &str) -> FirstPostProbeFailure {
    let (reason, class) = match reason {
        // 身份类：候选绑定冲突 / 已解析候选的证据变了。
        "ambiguous_target" => ("ambiguous_target", FirstPostFailureClass::Identity),
        "stale_target" => ("stale_target", FirstPostFailureClass::Identity),
        // 入参类：请求给的不是群地址形态。要去查调用方，不是查页面。
        "invalid_requested_group_url" => (
            "invalid_requested_group_url",
            FirstPostFailureClass::Request,
        ),
        // 姿态类：只描述目标周边的处境。
        "target_context_mismatch" => ("target_context_mismatch", FirstPostFailureClass::Posture),
        "editor_not_found" => ("editor_not_found", FirstPostFailureClass::Posture),
        _ => (
            UNRECOGNIZED_FIRST_POST_PROBE_FAILURE,
            FirstPostFailureClass::Posture,
        ),
    };
    FirstPostProbeFailure { reason, class }
}

fn first_post_probe_is_exhausted(output: &CommandOutput) -> bool {
    matches!(
        output,
        CommandOutput::PageCards(PageCards {
            movement: Some(movement),
            ..
        }) if movement.at_bottom == Some(true) && !movement.moved
    )
}

fn canonical_same_group_post_url(raw: &str, group_url: &Url) -> Option<Url> {
    let candidate = Url::parse(raw).ok()?;
    validate_facebook_origin(&candidate).ok()?;
    let group_parts = path_parts(group_url);
    let candidate_parts = path_parts(&candidate);
    let group_id = *group_parts.get(1)?;
    if group_parts.first() != Some(&"groups")
        || candidate_parts.first() != Some(&"groups")
        || candidate_parts.get(1) != Some(&group_id)
    {
        return None;
    }

    if matches!(candidate_parts.get(2), Some(&"posts") | Some(&"permalink")) {
        let post_id = *candidate_parts.get(3)?;
        if post_id.is_empty() {
            return None;
        }
        return Url::parse(&format!(
            "https://www.facebook.com/groups/{group_id}/{}/{post_id}",
            candidate_parts[2]
        ))
        .ok();
    }

    if candidate_parts.len() == 2 {
        let pairs: Vec<_> = candidate.query_pairs().collect();
        if pairs.len() != 1 || pairs[0].0 != "multi_permalinks" || pairs[0].1.is_empty() {
            return None;
        }
        let post_id = pairs[0].1.as_ref();
        let mut normalized =
            Url::parse(&format!("https://www.facebook.com/groups/{group_id}")).ok()?;
        normalized
            .query_pairs_mut()
            .append_pair("multi_permalinks", post_id);
        return Some(normalized);
    }
    None
}

fn path_parts(url: &Url) -> Vec<&str> {
    url.path_segments()
        .map(|parts| parts.filter(|part| !part.is_empty()).collect())
        .unwrap_or_default()
}

async fn wait_for_first_post_editor(
    session: &mut EngineSession,
    note_id: &str,
    timeout: Duration,
    cancellation: Option<&AtomicBool>,
) -> Result<Option<&'static str>, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut target_mismatch = false;
    let mut action_probed = false;
    loop {
        if facebook_command_cancelled(cancellation) {
            return Err(cancelled_before_dispatch());
        }
        let editor = probe_facebook_comment_editor(session, note_id).await?;
        if editor.ok {
            return Ok(None);
        }
        target_mismatch |= matches!(
            editor.reason.as_deref(),
            Some("target_context_mismatch" | "target_not_found")
        );
        if !action_probed && editor.reason.as_deref() == Some("editor_not_found") {
            action_probed = true;
            let action = probe_facebook_comment_action(session, note_id).await?;
            match action.reason.as_deref() {
                Some("ambiguous_target") => return Ok(Some("ambiguous_target")),
                Some("pending_group_approval") => return Ok(Some("pending_group_approval")),
                Some("target_context_mismatch" | "target_not_found") => target_mismatch = true,
                _ => {}
            }
            if action.ok {
                let (Some(x), Some(y)) = (action.cx, action.cy) else {
                    return Ok(Some("editor_not_found"));
                };
                if facebook_command_cancelled(cancellation) {
                    return Err(cancelled_before_dispatch());
                }
                dispatch_facebook_click(session, x, y).await?;
                continue;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(Some(if target_mismatch {
                "target_context_mismatch"
            } else {
                "editor_not_found"
            }));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn evaluate_facebook_router_until_bound_detail(
    session: &mut EngineSession,
    command: &NativeCommand,
    target_ref: &str,
    timeout: Duration,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let latest = evaluate_facebook_router(session, command).await?;
        if matches!(&latest.1, CommandOutput::NoteDetail(detail) if detail.note_id == target_ref) {
            return Ok(latest);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(EngineError::new(
                ErrorCode::ProbeFailed,
                "native Facebook bound first-post detail was not confirmed",
            ));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facebook::FacebookFirstPostGroupRootProbe;
    use crate::model::{PageCard, PageMovement};

    fn cards(note_ids: &[&str], movement: Option<PageMovement>) -> CommandOutput {
        CommandOutput::PageCards(PageCards {
            cards: note_ids
                .iter()
                .enumerate()
                .map(|(index, note_id)| PageCard {
                    index: index as u32,
                    title: String::new(),
                    author: None,
                    like_count: 0,
                    collect_count: 0,
                    cover_desc: None,
                    note_id: Some((*note_id).to_owned()),
                    note_id_kind: None,
                    is_video: None,
                })
                .collect(),
            movement,
            document_generation: None,
            container_name: None,
            list_kind: None,
            list_state: None,
            selection_reason: None,
        })
    }

    fn reusable_group_root_probe() -> FacebookFirstPostGroupRootProbe {
        FacebookFirstPostGroupRootProbe {
            origin: "https://www.facebook.com".to_owned(),
            path: "/groups/945390701793119".to_owned(),
            search: String::new(),
            hash: String::new(),
            surface: "group".to_owned(),
            ready_state: "complete".to_owned(),
            blocking_kind: "none".to_owned(),
            visible_main_count: 1,
            visible_dialog_count: 0,
            target_group_id: Some("945390701793119".to_owned()),
            scope_resolved: true,
            scope_ambiguous: false,
            feed_loading: false,
            scroll_y: 0.0,
        }
    }

    #[test]
    fn reuses_only_an_exact_ready_unblocked_group_root_at_the_feed_origin() {
        let group = validated_facebook_group_url("https://www.facebook.com/groups/945390701793119")
            .expect("group");
        let exact = reusable_group_root_probe();
        assert_eq!(
            first_post_group_root_reuse_reason(&exact, &group),
            FirstPostGroupRootReuseReason::ExactRootReusable
        );

        let mut probe = exact.clone();
        probe.origin = "https://m.facebook.com".to_owned();
        assert_eq!(
            first_post_group_root_reuse_reason(&probe, &group),
            FirstPostGroupRootReuseReason::OriginMismatch
        );

        let mut probe = exact.clone();
        probe.path = "/groups/42".to_owned();
        assert_eq!(
            first_post_group_root_reuse_reason(&probe, &group),
            FirstPostGroupRootReuseReason::GroupMismatch
        );

        let mut probe = exact.clone();
        probe.path = "/groups/945390701793119/posts/7".to_owned();
        assert_eq!(
            first_post_group_root_reuse_reason(&probe, &group),
            FirstPostGroupRootReuseReason::NotGroupRoot
        );

        let mut probe = exact.clone();
        probe.search = "?multi_permalinks=7".to_owned();
        assert_eq!(
            first_post_group_root_reuse_reason(&probe, &group),
            FirstPostGroupRootReuseReason::NotGroupRoot
        );

        let mut probe = exact.clone();
        probe.ready_state = "loading".to_owned();
        assert_eq!(
            first_post_group_root_reuse_reason(&probe, &group),
            FirstPostGroupRootReuseReason::DocumentNotReady
        );

        let mut probe = exact.clone();
        probe.blocking_kind = "captcha".to_owned();
        assert_eq!(
            first_post_group_root_reuse_reason(&probe, &group),
            FirstPostGroupRootReuseReason::BlockedPage
        );

        let mut probe = exact.clone();
        probe.visible_main_count = 0;
        assert_eq!(
            first_post_group_root_reuse_reason(&probe, &group),
            FirstPostGroupRootReuseReason::MainUnresolved
        );

        let mut probe = exact.clone();
        probe.scope_ambiguous = true;
        assert_eq!(
            first_post_group_root_reuse_reason(&probe, &group),
            FirstPostGroupRootReuseReason::ScopeUnresolved
        );

        let mut probe = exact.clone();
        probe.visible_dialog_count = 1;
        assert_eq!(
            first_post_group_root_reuse_reason(&probe, &group),
            FirstPostGroupRootReuseReason::DialogPresent
        );

        let mut probe = exact.clone();
        probe.feed_loading = true;
        assert_eq!(
            first_post_group_root_reuse_reason(&probe, &group),
            FirstPostGroupRootReuseReason::FeedLoading
        );

        let mut probe = exact;
        probe.scroll_y = 1.5;
        assert_eq!(
            first_post_group_root_reuse_reason(&probe, &group),
            FirstPostGroupRootReuseReason::ScrollNotAtTop
        );
    }

    #[test]
    fn selects_only_the_first_canonical_post_from_the_exact_group() {
        let group = validated_facebook_group_url(
            "https://www.facebook.com/groups/945390701793119?sorting_setting=CHRONOLOGICAL",
        )
        .expect("group");
        let output = cards(
            &[
                "https://www.facebook.com/groups/42/posts/900",
                "https://www.facebook.com/groups/945390701793119/posts/111?tracking=ignored",
                "https://www.facebook.com/groups/945390701793119/posts/222",
            ],
            None,
        );
        let selected = first_same_group_post_target(&output, &group).expect("same-group post");
        assert_eq!(
            selected,
            FirstPostTarget::Permalink(
                Url::parse("https://www.facebook.com/groups/945390701793119/posts/111")
                    .expect("url")
            )
        );
    }

    #[test]
    fn accepts_only_strict_bound_first_post_references() {
        // 前缀的单一事实源在 shared（泛化后由整个信息流共用）。
        use super::super::shared::FACEBOOK_CONTENT_REF_PREFIX as FIRST_POST_TARGET_PREFIX;
        let group = validated_facebook_group_url("https://www.facebook.com/groups/945390701793119")
            .expect("group");
        let valid = format!("{FIRST_POST_TARGET_PREFIX}{}", "a1".repeat(32));
        let output = cards(&[&valid], None);
        assert_eq!(
            first_same_group_post_target(&output, &group),
            Some(FirstPostTarget::BoundRef(valid.clone()))
        );
        assert!(is_first_post_target_ref(&valid));
        assert!(!is_first_post_target_ref(&format!(
            "{FIRST_POST_TARGET_PREFIX}{}",
            "A1".repeat(32)
        )));
        assert!(!is_first_post_target_ref(&format!(
            "{FIRST_POST_TARGET_PREFIX}{}",
            "a1".repeat(31)
        )));
        assert!(!is_first_post_target_ref(
            "https://www.facebook.com/groups/945390701793119#opaque"
        ));
    }

    #[test]
    fn accepts_explicit_multi_permalink_and_rejects_group_root_or_opaque_fragment() {
        let group = validated_facebook_group_url("https://www.facebook.com/groups/945390701793119")
            .expect("group");
        assert_eq!(
            canonical_same_group_post_url(
                "https://www.facebook.com/groups/945390701793119?multi_permalinks=333",
                &group,
            )
            .expect("multi permalink")
            .as_str(),
            "https://www.facebook.com/groups/945390701793119?multi_permalinks=333"
        );
        assert!(
            canonical_same_group_post_url(
                "https://www.facebook.com/groups/945390701793119",
                &group
            )
            .is_none()
        );
        assert!(
            canonical_same_group_post_url(
                "https://www.facebook.com/groups/945390701793119#opaque",
                &group
            )
            .is_none()
        );
        assert!(
            canonical_same_group_post_url(
                "https://www.facebook.com/groups/945390701793119?multi_permalinks=333&tracking=1",
                &group
            )
            .is_none()
        );
    }

    /// task 5.2 —— 那条自救分支的死代码回归断言。
    ///
    /// 旧实现把「准备阶段跳没跳」当成纠正预算本身：加群之后起始页几乎必然不是干净群根
    /// ⇒ 准备必跳 ⇒ 标记必真 ⇒ 要求「还没跳过」的自救分支**永远**走不到，
    /// 而唯一能用上它的情形恰恰是「页面本来就对、根本不需要自救」。
    /// 一旦谁把这两个量又接回一起，下面第一组断言立刻红。
    #[test]
    fn the_preparation_jump_never_shrinks_the_corrective_budget() {
        assert_eq!(
            initial_first_post_corrective_budget(true),
            FIRST_POST_CORRECTIVE_NAVIGATIONS,
            "准备阶段跳过一次，纠正预算仍必须是满额",
        );
        assert_eq!(
            initial_first_post_corrective_budget(false),
            initial_first_post_corrective_budget(true),
            "纠正预算 MUST NOT 随准备动作变化",
        );

        // 加群之后的真实一幕：准备阶段跳过一次，随后落地没确认（姿态类）。
        let budget = initial_first_post_corrective_budget(true);
        assert_eq!(
            first_post_recovery_step(Some(FIRST_POST_GROUP_ROOT_NOT_LANDED), budget),
            FirstPostRecoveryStep::Renavigate,
            "准备阶段跳过之后，纠正导航必须仍然可达",
        );

        // 预算只被失败消费；耗尽之后才终局，且终局时叶子原因原样保留。
        assert_eq!(
            first_post_recovery_step(Some(FIRST_POST_GROUP_ROOT_NOT_LANDED), 0),
            FirstPostRecoveryStep::Terminate,
        );
        assert_eq!(
            first_post_terminal_reason(Some(FIRST_POST_GROUP_ROOT_NOT_LANDED)),
            "group_root_not_landed",
        );
        assert_ne!(
            first_post_terminal_reason(Some(FIRST_POST_GROUP_ROOT_NOT_LANDED)),
            "target_context_mismatch",
            "落地没确认 MUST NOT 复用帖子身份的原因值",
        );
    }

    /// task 2.3 —— 预算耗尽要读得出「重试 N 次未成」，不得读成「做不到」。
    #[test]
    fn an_exhausted_corrective_budget_reads_as_retried_not_as_impossible() {
        let exhausted = first_post_recovery_diagnostic(
            Some(FIRST_POST_GROUP_ROOT_NOT_LANDED),
            FIRST_POST_CORRECTIVE_NAVIGATIONS,
            FIRST_POST_CORRECTIVE_NAVIGATIONS,
        );
        assert!(exhausted.contains(r#""outcome":"retried_without_success""#));
        assert!(exhausted.contains(&format!(
            r#""correctiveNavigationsSpent":{FIRST_POST_CORRECTIVE_NAVIGATIONS}"#
        )));
        // 叶子原因原样保留（跨层义务）：不许换成一个读起来像结构性的名字。
        assert!(exhausted.contains(r#""reason":"group_root_not_landed""#));
        assert!(exhausted.contains(r#""failureClass":"posture""#));

        // 「一次都没重试就终局」与「重试过但没成」必须是两条不同读数。
        let never_retried = first_post_recovery_diagnostic(
            Some(FIRST_POST_GROUP_ROOT_NOT_LANDED),
            0,
            FIRST_POST_CORRECTIVE_NAVIGATIONS,
        );
        assert!(never_retried.contains(r#""outcome":"not_retried""#));
        assert_ne!(exhausted, never_retried);
    }

    /// task 5.3 —— 下滚预算按失败类别消费。
    ///
    /// 姿态类只描述目标周边处境，重新加载后再来一次完全可能不同 ⇒ 消费一轮继续探；
    /// 身份类继续下去有写到**另一条帖子**上的风险 ⇒ 立即终止，且不得消费纠正预算。
    #[test]
    fn posture_failures_spend_a_scroll_round_while_identity_failures_stop_at_once() {
        let posture = classify_first_post_probe_reason("target_context_mismatch");
        assert_eq!(posture.class, FirstPostFailureClass::Posture);
        assert!(
            !first_post_scroll_loop_stops(false, Some(posture), false, FIRST_POST_SCROLL_ROUNDS),
            "姿态类失败 MUST NOT 弃掉剩余下滚预算",
        );
        assert!(
            first_post_scroll_loop_stops(false, Some(posture), false, 0),
            "预算耗尽才停",
        );

        for reason in ["ambiguous_target", "stale_target"] {
            let identity = classify_first_post_probe_reason(reason);
            assert_eq!(identity.class, FirstPostFailureClass::Identity, "{reason}");
            assert!(
                first_post_scroll_loop_stops(
                    false,
                    Some(identity),
                    false,
                    FIRST_POST_SCROLL_ROUNDS
                ),
                "{reason}：身份类失败必须立即终止",
            );
            assert_eq!(
                first_post_recovery_step(Some(identity), FIRST_POST_CORRECTIVE_NAVIGATIONS),
                FirstPostRecoveryStep::Terminate,
                "{reason}：身份类失败不得消费纠正预算",
            );
        }

        // 找到候选、或探测自称到底，仍然照旧停下（本次没有放宽这两条）。
        assert!(first_post_scroll_loop_stops(
            true,
            None,
            false,
            FIRST_POST_SCROLL_ROUNDS
        ));
        assert!(first_post_scroll_loop_stops(
            false,
            None,
            true,
            FIRST_POST_SCROLL_ROUNDS
        ));
    }

    /// task 3.1 / 4.2 —— 失败分类穷举，**没有兜底桶**；入参问题不冒充身份问题。
    #[test]
    fn an_unrecognized_probe_reason_surfaces_under_its_own_name() {
        let unknown = classify_first_post_probe_reason("a_reason_nobody_has_written_yet");
        assert_eq!(
            unknown.reason, UNRECOGNIZED_FIRST_POST_PROBE_FAILURE,
            "认不出来的原因 MUST NOT 折进任何已有失败名",
        );
        assert_eq!(unknown.class, FirstPostFailureClass::Posture);

        for known in [
            "ambiguous_target",
            "stale_target",
            "invalid_requested_group_url",
            "target_context_mismatch",
            "editor_not_found",
        ] {
            assert_eq!(classify_first_post_probe_reason(known).reason, known);
        }

        let request = classify_first_post_probe_reason("invalid_requested_group_url");
        assert_eq!(request.class, FirstPostFailureClass::Request);
        assert_ne!(
            request.reason,
            classify_first_post_probe_reason("target_context_mismatch").reason,
            "「请求的群地址无效」MUST NOT 复用帖子身份的原因值",
        );
        assert_eq!(
            first_post_recovery_step(Some(request), FIRST_POST_CORRECTIVE_NAVIGATIONS),
            FirstPostRecoveryStep::Terminate,
            "入参不对，重来多少次都一样",
        );
    }

    #[test]
    fn stops_bounded_hydration_only_on_confirmed_bottom_without_movement() {
        assert!(first_post_probe_is_exhausted(&cards(
            &[],
            Some(PageMovement {
                before: 100.0,
                after: 100.0,
                moved: false,
                at_bottom: Some(true),
            }),
        )));
        assert!(!first_post_probe_is_exhausted(&cards(
            &[],
            Some(PageMovement {
                before: 100.0,
                after: 100.0,
                moved: false,
                at_bottom: Some(false),
            }),
        )));
    }
}
