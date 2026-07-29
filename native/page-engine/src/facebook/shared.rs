use crate::commit_window::CommitWindowRequester;
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::input::{
    PointerClickOptions, PointerInputFailure, PointerPoint, dispatch_pointer_click,
};
use crate::model::{ActionReceipt, PublishReceipt};
use crate::probe::ProbeResult;
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

pub(crate) const FACEBOOK_HOME_URL: &str = "https://www.facebook.com/";
// 时间预算整体 ×1.5（用户口径，2026-07-29）。只放大**等页面的容错窗**；
// 拟人停顿、限流地板、判稳预算不动——它们不是容错：判稳是「页面渲染完要多久」的经验值，
// 且身份采集（下方常量）明确依赖「8 轮判稳要装进命令预算」，放大它会直接撑爆那条算式。
pub(crate) const FACEBOOK_DETAIL_HYDRATION_TIMEOUT: Duration = Duration::from_secs(23);
pub(crate) const FACEBOOK_FEED_SETTLE_NAV: Duration = Duration::from_secs(6);
pub(crate) const FACEBOOK_FEED_SETTLE_IN_PLACE: Duration = Duration::from_millis(3_500);
pub(crate) const FACEBOOK_FEED_SCROLL_ROUNDS: usize = 8;

// 身份采集（change acquire-facebook-feed-post-identity-by-hover）。Facebook 把帖子地址扣在 DOM 之外，
// 只有可信指针落到时间戳上才换出真地址。
//
// **预算必须按「整条命令」算，不能按轮算**：滚动命令的原子预算上限是 engine.rs 的
// DEFAULT_COMMAND_TIMEOUT_MS = 30s（实际取 min(会话 timeout_ms, 该上限)），超时即 CdpTimeout / Ambiguous。
// 而零卡屏上判稳本身最坏就要 8 轮 × 3.5s ≈ 28s。采集若按轮给预算、8 轮各来一次，必然把整条命令撑爆。
// 故给一个跨轮共享的小预算：最坏 3 卡 × 2 候选 × 1.2s ≈ 7.2s，由 8s 总预算兜住。
// 调大前先算清楚它与判稳耗时之和是否仍显著小于 30s。
pub(crate) const FACEBOOK_IDENTITY_SETTLE: Duration = Duration::from_millis(1_200);
pub(crate) const FACEBOOK_IDENTITY_MAX_CANDIDATES_PER_CARD: usize = 2;
pub(crate) const FACEBOOK_IDENTITY_MAX_CARDS_PER_ROUND: usize = 3;
pub(crate) const FACEBOOK_IDENTITY_COMMAND_BUDGET: Duration = Duration::from_secs(8);
/// 两次「刷新导致整页重载」之间的最小间隔：**限流地板**，不是超时，不随预算放大。
pub(crate) const FACEBOOK_REFRESH_RELOAD_FLOOR_MS: u64 = 180_000;
pub(crate) const FACEBOOK_JOIN_READY_TIMEOUT: Duration = Duration::from_secs(45);
/// 点击前后的拟人停顿：**节奏**不是容错，不随预算放大。
pub(crate) const FACEBOOK_JOIN_HYDRATION_SETTLE: Duration = Duration::from_secs(2);
pub(crate) const FACEBOOK_JOIN_POST_CLICK_SETTLE: Duration = Duration::from_millis(1_500);
pub(crate) const FACEBOOK_JOIN_VERIFY_TIMEOUT: Duration = Duration::from_secs(68);
pub(crate) const FACEBOOK_PUBLISH_UPLOAD_VERIFY_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) static FACEBOOK_FEED_LIKE_OPERATION: AtomicU64 = AtomicU64::new(1);

pub(crate) fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub(crate) fn cancelled_before_dispatch() -> EngineError {
    EngineError::new(
        ErrorCode::Cancelled,
        "native page engine command cancelled before dispatch",
    )
}

pub(crate) fn facebook_command_cancelled(cancellation: Option<&AtomicBool>) -> bool {
    cancellation.is_some_and(|value| value.load(Ordering::Acquire))
}

pub(crate) async fn wait_for_cancellation(cancellation: &AtomicBool) {
    while !cancellation.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

pub(crate) async fn probe_facebook_like(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookLikeProbe, EngineError> {
    let expression = facebook::like_probe_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::like_probe_from_cdp(&raw)
}

pub(crate) async fn commit_facebook_reel_like(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookLikeCommit, EngineError> {
    let expression = facebook::like_primary_commit_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::like_commit_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_like_picker(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookPointTarget, EngineError> {
    let expression = facebook::like_picker_probe_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::point_target_from_cdp(&raw)
}

pub(crate) enum FacebookReelLikeVerification {
    Selected,
    Unchanged,
    Indeterminate,
}

pub(crate) async fn wait_for_facebook_reel_like(
    session: &mut EngineSession,
    note_id: &str,
    timeout: Duration,
) -> Result<FacebookReelLikeVerification, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let expression = facebook::like_verify_expression(note_id)?;
        let raw = session.cdp.evaluate(&expression, true).await?;
        let probe = facebook::like_verify_from_cdp(&raw)?;
        if !probe.ok {
            return Ok(FacebookReelLikeVerification::Indeterminate);
        }
        if probe.selected {
            return Ok(FacebookReelLikeVerification::Selected);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(FacebookReelLikeVerification::Unchanged);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

pub(crate) async fn wait_for_facebook_like(
    session: &mut EngineSession,
    note_id: &str,
    timeout: Duration,
) -> Result<bool, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let probe = probe_facebook_like(session, note_id).await?;
        if probe.ok && probe.already {
            return Ok(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

pub(crate) async fn probe_facebook_follow(
    session: &mut EngineSession,
    note_id: Option<&str>,
) -> Result<facebook::FacebookFollowProbe, EngineError> {
    let expression = facebook::follow_probe_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::follow_probe_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_comment_action(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookPointTarget, EngineError> {
    let expression = facebook::comment_action_probe_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::point_target_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_comment_editor(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookTextTarget, EngineError> {
    let expression = facebook::comment_editor_probe_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::text_target_from_cdp(&raw)
}

pub(crate) async fn focus_facebook_comment_editor(
    session: &mut EngineSession,
    note_id: &str,
    select_contents: bool,
) -> Result<facebook::FacebookTextTarget, EngineError> {
    let expression = facebook::comment_editor_focus_expression(note_id, select_contents)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::text_target_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_comment_ack(
    session: &mut EngineSession,
    note_id: &str,
    text: &str,
    account_id: &str,
) -> Result<facebook::FacebookCommentAckProbe, EngineError> {
    let expression = facebook::comment_ack_probe_expression(note_id, text, account_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::comment_ack_probe_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_join(
    session: &mut EngineSession,
) -> Result<facebook::FacebookJoinProbe, EngineError> {
    let expression = facebook::join_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::join_probe_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_first_post_group_root(
    session: &mut EngineSession,
) -> Result<facebook::FacebookFirstPostGroupRootProbe, EngineError> {
    let expression = facebook::first_post_group_root_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::first_post_group_root_probe_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_publish_home_snapshot(
    session: &mut EngineSession,
) -> Result<facebook::FacebookPublishHomeProbe, EngineError> {
    let expression = facebook::publish_home_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::publish_home_probe_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_publish_entry(
    session: &mut EngineSession,
) -> Result<facebook::FacebookPointTarget, EngineError> {
    let expression = facebook::publish_entry_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::point_target_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_publish_editor(
    session: &mut EngineSession,
) -> Result<facebook::FacebookTextTarget, EngineError> {
    let expression = facebook::publish_editor_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::text_target_from_cdp(&raw)
}

pub(crate) async fn focus_facebook_publish_editor(
    session: &mut EngineSession,
    select_contents: bool,
) -> Result<facebook::FacebookTextTarget, EngineError> {
    let expression = facebook::publish_editor_focus_expression(select_contents)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::text_target_from_cdp(&raw)
}

pub(crate) async fn probe_bound_facebook_publish_editor(
    session: &mut EngineSession,
    focus: bool,
    select_contents: bool,
) -> Result<facebook::FacebookTextTarget, EngineError> {
    let expression = facebook::publish_bound_editor_probe_expression(focus, select_contents)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::text_target_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_publish_upload_target(
    session: &mut EngineSession,
) -> Result<facebook::FacebookPointTarget, EngineError> {
    let expression = facebook::publish_upload_target_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::point_target_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_publish_upload_preview(
    session: &mut EngineSession,
    file_name: &str,
) -> Result<facebook::FacebookPointTarget, EngineError> {
    let expression = facebook::publish_upload_preview_probe_expression(file_name)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::point_target_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_publish_submit(
    session: &mut EngineSession,
    bind_target: bool,
) -> Result<facebook::FacebookPublishSubmitProbe, EngineError> {
    let expression = facebook::publish_submit_probe_expression(bind_target)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::publish_submit_probe_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_publish_submitted(
    session: &mut EngineSession,
) -> Result<facebook::FacebookPublishSubmittedProbe, EngineError> {
    let expression = facebook::publish_submitted_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::publish_submitted_probe_from_cdp(&raw)
}

pub(crate) async fn delete_selected_text(session: &mut EngineSession) -> Result<(), EngineError> {
    session
        .cdp
        .dispatch_key("keyDown", "Backspace", "Backspace", 8)
        .await?;
    session
        .cdp
        .dispatch_key("keyUp", "Backspace", "Backspace", 8)
        .await?;
    Ok(())
}

pub(crate) fn normalize_facebook_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 写动作回读的「多出来的字符数」容差。
/// 编辑器会带入零宽字符 / 不间断空格之类的无害残留；超出这个容差就是真被塞了东西
/// （最常见的是打字途中被 typeahead 劫持插入了 @提及），那样的正文 MUST NOT 发出去。
/// 评论侧与发布侧共用同一个取值——两条链路面对的是同一个富文本编辑器。
/// 取值本身仍待真机采样定论（见 change 的真机项 9.8：退役实现取 4 且有成文立论，
/// Native 迁移改成 10 无对应记录；本轮只做收口到一处，不替真机结论下判断）。
pub(crate) const FACEBOOK_TEXT_EXTRA_CHAR_TOLERANCE: usize = 10;

pub(crate) fn facebook_action_result(
    phase: EffectPhase,
    action: &str,
    ok: bool,
    reason: &str,
    note_id: Option<String>,
    observation: Option<crate::model::ActionEvidence>,
) -> (EffectPhase, CommandOutput) {
    (
        phase,
        CommandOutput::ActionReceipt(Box::new(ActionReceipt {
            action: action.to_owned(),
            ok,
            reason: (!reason.is_empty()).then(|| reason.to_owned()),
            note_id,
            observation,
            post_observation: None,
            group_observation: None,
            group_url: None,
            clicked: None,
            candidates: Vec::new(),
        })),
    )
}

pub(crate) fn facebook_join_result(
    phase: EffectPhase,
    ok: bool,
    reason: &str,
    clicked: bool,
    observation: crate::model::FacebookGroupJoinObservation,
    post_observation: Option<crate::model::FacebookGroupJoinObservation>,
) -> (EffectPhase, CommandOutput) {
    let group_url = observation.group_url.clone();
    (
        phase,
        CommandOutput::ActionReceipt(Box::new(ActionReceipt {
            action: "join_group".to_owned(),
            ok,
            reason: (!reason.is_empty()).then(|| reason.to_owned()),
            note_id: None,
            observation: None,
            post_observation,
            group_observation: Some(observation),
            group_url,
            clicked: Some(clicked),
            candidates: Vec::new(),
        })),
    )
}

pub(crate) fn facebook_publish_result(
    phase: EffectPhase,
    record_id: u64,
    seq: u32,
    kind: &str,
    ok: bool,
    dispatched: bool,
    error: &str,
) -> (EffectPhase, CommandOutput) {
    (
        phase,
        CommandOutput::PublishReceipt(
            PublishReceipt {
                record_id,
                seq,
                kind: kind.to_owned(),
                ok,
                submit_dispatched: (kind == "submit").then_some(dispatched),
                value: None,
                post_url: None,
                error: (!error.is_empty()).then(|| error.to_owned()),
            }
            .bounded(),
        ),
    )
}

pub(crate) async fn enter_facebook_commit_window(
    command: &NativeCommand,
    requester: &CommitWindowRequester,
    deadline_unix_ms: u64,
    cancellation: Option<&AtomicBool>,
) -> Result<(), EngineError> {
    let contract = facebook::capability::parity(command)
        .and_then(|entry| entry.commit_window)
        .ok_or_else(|| {
            EngineError::new(
                ErrorCode::EngineInternal,
                "native Facebook irreversible write has no commit window contract",
            )
        })?;
    requester
        .enter(
            contract.label,
            contract.budget_ms,
            deadline_unix_ms,
            cancellation,
        )
        .await
}

pub(crate) async fn ensure_facebook_action_gate(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<Option<CommandOutput>, EngineError> {
    ensure_facebook_action_gate_inner(session, command, None).await
}

pub(crate) async fn ensure_facebook_group_join_action_gate(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<Option<CommandOutput>, EngineError> {
    ensure_facebook_action_gate_inner(
        session,
        command,
        Some((
            "action_gate_page_probe",
            "action_gate_consent_probe",
            "action_gate_result",
        )),
    )
    .await
}

async fn ensure_facebook_action_gate_inner(
    session: &mut EngineSession,
    command: &NativeCommand,
    operation_stages: Option<(&'static str, &'static str, &'static str)>,
) -> Result<Option<CommandOutput>, EngineError> {
    let probe = probe_facebook_page(session)
        .await
        .map_err(|error| annotate_operation(error, operation_stages.map(|stages| stages.0)))?;
    let reason = match probe.blocking_kind.as_deref() {
        Some("login") => Some("login_required"),
        Some("captcha") => Some("blocked_by_captcha"),
        Some("unknown") => Some("blocked_by_unknown"),
        _ => None,
    };
    if let Some(reason) = reason {
        return facebook_gate_failure(session, command, reason)
            .map(Some)
            .map_err(|error| annotate_operation(error, operation_stages.map(|stages| stages.2)));
    }

    for _ in 0..3 {
        // 探测本身失败：既不假设有同意条、也不假成功——当作「无同意条」让既有闸继续处置。
        // 把错误上抛会让整条命令变成引擎错误，等于把一次探测抖动升级成动作失败。
        let Ok(consent) = probe_facebook_consent(session).await else {
            return Ok(None);
        };
        if !consent.present {
            return Ok(None);
        }
        let necessary_only = matches!(
            std::env::var("AIDCP_FB_COOKIE_CONSENT")
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
                .as_str(),
            "necessary_only" | "necessary" | "essential"
        );
        let point = if necessary_only {
            if consent.necessary_only_ambiguous {
                None
            } else {
                consent.necessary_only
            }
        } else if consent.accept_all_ambiguous {
            None
        } else {
            consent.accept_all
        };
        let Some(point) = point else {
            // 认出了同意条，但**策略所需**的按钮定位不到（文案 / 布局漂移，或同文案按钮不唯一）。
            // 诚实停手：绝不改点另一个按钮。这一档与「点满三次仍清不掉」是两回事——
            // 前者一次都没动过页面（clicked=false），后者是升级停手（clicked=true）。
            return facebook_consent_gate_failure(session, command, false)
                .map(Some)
                .map_err(|error| {
                    annotate_operation(error, operation_stages.map(|stages| stages.2))
                });
        };
        dispatch_facebook_click(session, point.cx, point.cy).await?;
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
    let Ok(final_probe) = probe_facebook_consent(session).await else {
        return Ok(None);
    };
    if final_probe.present {
        // 有界重试到上限仍在——停手升级，绝不静默假成功。
        return facebook_consent_gate_failure(session, command, true)
            .map(Some)
            .map_err(|error| annotate_operation(error, operation_stages.map(|stages| stages.2)));
    }
    Ok(None)
}

/// 同意闸失败回执。原因码保持既有的 `blocked_by_consent`（云端无第二个归宿，
/// 新造原因码只会多一条没人接的字符串）；两档失败靠回执上的「有没有真点过」区分：
/// `clicked=false` = 探到同意条但策略按钮定位不到（可诊断的文案 / 布局漂移，页面未被动过）；
/// `clicked=true` = 点过仍未清掉（升级停手）。
/// 「探到没探到」由回执本身表达：探不到时闸直接放行、根本不产出这条回执。
fn facebook_consent_gate_failure(
    session: &EngineSession,
    command: &NativeCommand,
    clicked: bool,
) -> Result<CommandOutput, EngineError> {
    let mut output = facebook_gate_failure(session, command, "blocked_by_consent")?;
    if let CommandOutput::ActionReceipt(receipt) = &mut output {
        receipt.clicked = Some(clicked);
    }
    Ok(output)
}

fn annotate_operation(error: EngineError, operation_stage: Option<&'static str>) -> EngineError {
    match operation_stage {
        Some(operation_stage) => error.with_operation_stage(operation_stage),
        None => error,
    }
}

pub(crate) async fn probe_facebook_page(
    session: &mut EngineSession,
) -> Result<ProbeResult, EngineError> {
    let expression = facebook::page_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = facebook::result_from_cdp(&raw)?;
    let command = NativeCommand::PageProbe(crate::command::EmptyParams::default());
    let output = facebook::typed_output(&command, result.output, session.cdp.target_id())?;
    let CommandOutput::PageProbe(probe) = output else {
        return Err(EngineError::new(
            ErrorCode::ProbeFailed,
            "native Facebook blocker probe returned an invalid output",
        ));
    };
    Ok(probe)
}

pub(crate) async fn probe_facebook_consent(
    session: &mut EngineSession,
) -> Result<facebook::FacebookConsentProbe, EngineError> {
    let expression = facebook::consent_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::consent_probe_from_cdp(&raw)
}

pub(crate) fn facebook_gate_failure(
    session: &EngineSession,
    command: &NativeCommand,
    reason: &str,
) -> Result<CommandOutput, EngineError> {
    facebook::failure_output(
        command,
        facebook_action_name(command),
        reason,
        session.cdp.target_id(),
    )
}

pub(crate) fn facebook_command_requires_gate(command: &NativeCommand) -> bool {
    !matches!(
        command,
        NativeCommand::PageProbe(_)
            | NativeCommand::SessionStop(_)
            | NativeCommand::IdentityBootstrap(_)
            | NativeCommand::IdentityReadCurrent(_)
            | NativeCommand::CaptchaCapture(_)
            | NativeCommand::CaptchaClick(_)
    )
}

pub(crate) fn facebook_action_name(command: &NativeCommand) -> &'static str {
    match command {
        NativeCommand::BrowseNext(_)
        | NativeCommand::BrowseScroll(_)
        | NativeCommand::PageScroll(_) => "scroll",
        NativeCommand::FeedRefresh(_) => "refresh",
        NativeCommand::SearchExecute(_) => "search",
        NativeCommand::NoteOpen(_) => "open_note",
        NativeCommand::NoteClose(_) => "close",
        NativeCommand::NavigationBack(_) => "back",
        NativeCommand::InteractionLike(_) => "like",
        NativeCommand::InteractionFollow(_) => "follow",
        NativeCommand::InteractionComment(_) => "comment",
        NativeCommand::GroupJoin(_) => "join_group",
        NativeCommand::PublishNavigateEntry(_) => "navigate_entry",
        NativeCommand::PublishSelectMode(_) => "select_mode",
        NativeCommand::PublishUploadImage(_) => "upload_image",
        NativeCommand::PublishSetCover(_) => "set_cover",
        NativeCommand::PublishFillField(_) => "fill_field",
        NativeCommand::PublishAddWithCandidate(_) => "add_with_candidate",
        NativeCommand::PublishSetOption(_) => "set_option",
        NativeCommand::PublishSetSchedule(_) => "set_schedule",
        NativeCommand::PublishSubmit(_) => "submit",
        NativeCommand::PublishCapturePostId(_) => "capture_post_id",
        NativeCommand::PublishCaptureScheduled(_) => "capture_scheduled",
        NativeCommand::PublishReconcileScheduled(_) => "reconcile_scheduled",
        _ => "page",
    }
}

pub(crate) async fn evaluate_facebook_router(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if facebook_command_requires_gate(command)
        && let Some(output) = ensure_facebook_action_gate(session, command).await?
    {
        return Ok((EffectPhase::NotStarted, output));
    }
    let expression = facebook::command_expression(command)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = facebook::result_from_cdp(&raw)?;
    let output = facebook::typed_output(command, result.output, session.cdp.target_id())?;
    Ok((result.effect_phase, output))
}

pub(crate) async fn evaluate_facebook_first_post_router(
    session: &mut EngineSession,
    command: &NativeCommand,
    group_url: &Url,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if facebook_command_requires_gate(command)
        && let Some(output) = ensure_facebook_action_gate(session, command).await?
    {
        return Ok((EffectPhase::NotStarted, output));
    }
    let expression = facebook::first_post_command_expression(command, group_url)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = facebook::result_from_cdp(&raw)?;
    let output = facebook::typed_output(command, result.output, session.cdp.target_id())?;
    Ok((result.effect_phase, output))
}

pub(crate) async fn evaluate_facebook_router_until_cards(
    session: &mut EngineSession,
    command: &NativeCommand,
    timeout: Duration,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let latest = evaluate_facebook_router(session, command).await?;
        if matches!(&latest.1, CommandOutput::PageCards(cards) if !cards.cards.is_empty())
            || tokio::time::Instant::now() >= deadline
        {
            return Ok(latest);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

pub(crate) async fn evaluate_facebook_router_until_requested_detail(
    session: &mut EngineSession,
    command: &NativeCommand,
    target_post_id: &str,
    timeout: Duration,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let latest = evaluate_facebook_router(session, command).await?;
        if matches!(
            &latest.1,
            CommandOutput::NoteDetail(detail)
                if canonical_facebook_post_id(&detail.note_id).as_deref() == Some(target_post_id)
        ) {
            return Ok(latest);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(EngineError::new(
                ErrorCode::ProbeFailed,
                "native Facebook target detail identity was not confirmed",
            ));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

pub(crate) async fn wait_for_facebook_ready(
    session: &mut EngineSession,
    timeout: Duration,
) -> Result<(), EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let expression = facebook::page_probe_expression()?;
        let raw = session.cdp.evaluate(&expression, true).await?;
        let result = facebook::result_from_cdp(&raw)?;
        let ready = result
            .output
            .pointer("/value/readyState")
            .and_then(serde_json::Value::as_str);
        if matches!(ready, Some("interactive" | "complete")) {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(EngineError::new(
                ErrorCode::ProbeFailed,
                "native Facebook navigation did not reach a ready document",
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

pub(crate) async fn verify_facebook_uploaded_preview(
    session: &mut EngineSession,
    record_id: u64,
    seq: u32,
    file_name: &str,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let remaining = Duration::from_millis(deadline_unix_ms.saturating_sub(unix_time_ms()));
    let deadline =
        tokio::time::Instant::now() + remaining.min(FACEBOOK_PUBLISH_UPLOAD_VERIFY_TIMEOUT);
    loop {
        let preview = probe_facebook_publish_upload_preview(session, file_name).await?;
        if preview.ok {
            return Ok(facebook_publish_result(
                EffectPhase::Confirmed,
                record_id,
                seq,
                "upload_image",
                true,
                true,
                "",
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(facebook_publish_result(
                EffectPhase::Ambiguous,
                record_id,
                seq,
                "upload_image",
                false,
                true,
                preview
                    .reason
                    .as_deref()
                    .unwrap_or("media_preview_unconfirmed"),
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// 内容派生的会话内帖子引用前缀（change generalize-facebook-content-derived-post-identity）。
/// 前缀是历史命名（当初只服务群组首帖），语义已是「内容派生的会话内帖子引用」；
/// 不改名是刻意取舍——云端评论链路按它匹配，改名会失配。
pub(crate) const FACEBOOK_CONTENT_REF_PREFIX: &str = "aidcp:facebook-group-feed-post:v1:";

/// 这个 noteId 是不是内容派生的会话内引用。
///
/// 它**不是地址**：没有平台永久链接，导航 / 打开详情 / 定向评论结构性做不到。
/// 判定严格到摘要长度与字符集——形似而不合格的值一律不算，走既有的诚实失败。
pub(crate) fn is_facebook_content_ref(value: &str) -> bool {
    value
        .strip_prefix(FACEBOOK_CONTENT_REF_PREFIX)
        .is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

pub(crate) fn validated_facebook_content_url(
    raw: &str,
    expected: Option<&str>,
) -> Result<Url, EngineError> {
    let url = Url::parse(raw).map_err(|_| invalid_facebook_navigation_target())?;
    validate_facebook_origin(&url)?;
    let path = url.path().to_ascii_lowercase();
    let is_content = path.contains("/posts/")
        || path.contains("/videos/")
        || path.starts_with("/reel/")
        || path.contains("/permalink.php")
        || path.starts_with("/groups/")
        || url
            .query_pairs()
            .any(|(key, _)| matches!(key.as_ref(), "story_fbid" | "multi_permalinks" | "v"));
    if !is_content || expected.is_some_and(|value| value != raw && !raw.contains(value)) {
        return Err(invalid_facebook_navigation_target());
    }
    Ok(url)
}

pub(crate) fn canonical_facebook_post_id(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    validate_facebook_origin(&url).ok()?;
    let path = url.path().to_ascii_lowercase();
    let query_id = url
        .query_pairs()
        .find_map(|(key, value)| match key.as_ref() {
            "multi_permalinks" | "story_fbid" => Some(value.into_owned()),
            "v" if path == "/watch" || path == "/watch/" => Some(value.into_owned()),
            _ => None,
        })
        .filter(|value| !value.is_empty());
    if query_id.is_some() {
        return query_id;
    }
    let segments: Vec<_> = url
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect();
    for (index, segment) in segments.iter().enumerate() {
        if matches!(
            segment.to_ascii_lowercase().as_str(),
            "posts" | "videos" | "reel" | "permalink"
        ) {
            return segments
                .get(index + 1)
                .filter(|value| !value.is_empty())
                .map(|value| (*value).to_owned());
        }
    }
    None
}

pub(crate) fn is_facebook_reel_url(raw: &str) -> bool {
    Url::parse(raw)
        .ok()
        .filter(|url| validate_facebook_origin(url).is_ok())
        .is_some_and(|url| url.path().to_ascii_lowercase().starts_with("/reel/"))
}

pub(crate) fn validated_facebook_group_url(raw: &str) -> Result<Url, EngineError> {
    let url = Url::parse(raw).map_err(|_| invalid_facebook_navigation_target())?;
    validate_facebook_origin(&url)?;
    let parts: Vec<_> = url
        .path_segments()
        .map(|segments| segments.filter(|segment| !segment.is_empty()).collect())
        .unwrap_or_default();
    if parts.first() != Some(&"groups") || parts.get(1).is_none_or(|value| value.is_empty()) {
        return Err(invalid_facebook_navigation_target());
    }
    Url::parse(&format!("https://www.facebook.com/groups/{}", parts[1]))
        .map_err(|_| invalid_facebook_navigation_target())
}

pub(crate) fn validated_facebook_search_url(raw: &str, keyword: &str) -> Result<Url, EngineError> {
    let url = Url::parse(raw).map_err(|_| invalid_facebook_navigation_target())?;
    validate_facebook_origin(&url)?;
    let parts: Vec<_> = url
        .path_segments()
        .map(|segments| segments.filter(|segment| !segment.is_empty()).collect())
        .unwrap_or_default();
    let path = if parts.first() == Some(&"groups") {
        let group = parts
            .get(1)
            .filter(|value| !value.is_empty())
            .ok_or_else(invalid_facebook_navigation_target)?;
        format!("/groups/{group}/search/")
    } else if parts.len() == 1 {
        format!("/{}/search/", parts[0])
    } else {
        return Err(invalid_facebook_navigation_target());
    };
    let mut target =
        Url::parse("https://www.facebook.com").map_err(|_| invalid_facebook_navigation_target())?;
    target.set_path(&path);
    target.query_pairs_mut().append_pair("q", keyword);
    Ok(target)
}

pub(crate) fn validate_facebook_origin(url: &Url) -> Result<(), EngineError> {
    let host = url
        .host_str()
        .ok_or_else(invalid_facebook_navigation_target)?;
    if url.scheme() != "https"
        || !(host == "facebook.com" || host.ends_with(".facebook.com"))
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid_facebook_navigation_target());
    }
    Ok(())
}

pub(crate) fn invalid_facebook_navigation_target() -> EngineError {
    EngineError::new(
        ErrorCode::InvalidRequest,
        "native navigation target is not an allowlisted Facebook page",
    )
}

pub(crate) async fn dispatch_facebook_click(
    session: &mut EngineSession,
    x: f64,
    y: f64,
) -> Result<(), EngineError> {
    dispatch_facebook_click_with(session, x, y, PointerClickOptions::default())
        .await
        .map(|_| ())
}

/// 带形状的点击出口：调用方可指定起步点与是否允许过冲，其余与两参形态等价。
/// 返回**真实落点**，供多点循环把上一落点当作下一点的起步点（保光标连续）。
pub(crate) async fn dispatch_facebook_click_with(
    session: &mut EngineSession,
    x: f64,
    y: f64,
    options: PointerClickOptions,
) -> Result<PointerPoint, EngineError> {
    // 说明：Facebook 的点击调用点目前拿不到取消信号与绝对截止（它们止步于命令分发层，
    // 而那几个文件不在本次改动面内），故此处传 None / 无截止；原语内部的取消与截止检查仍
    // 全部落在按下之前，按下 / 抬起配平不受影响。
    dispatch_pointer_click(&mut session.cdp, x, y, options, None, u64::MAX)
        .await
        .map_err(pointer_failure_to_engine_error)
}

pub(crate) fn pointer_failure_to_engine_error(failure: PointerInputFailure) -> EngineError {
    match failure {
        PointerInputFailure::CancelledBeforePress => cancelled_before_dispatch(),
        PointerInputFailure::DeadlineBeforePress => EngineError::new(
            ErrorCode::CdpTimeout,
            "native pointer click exceeded its deadline before the submit press",
        ),
        PointerInputFailure::MoveFailed(error) => error,
        // 诚实红线：按下已经派发出去了，点击可能已生效。绝不能让上游把它读成「压根没点」而重投。
        PointerInputFailure::SubmitDispatched(error) => EngineError::new(
            error.code,
            "native pointer submit press was already dispatched before the failure; the click may have taken effect and MUST NOT be replayed as not started",
        ),
    }
}

pub(crate) fn facebook_scroll_failure(
    phase: EffectPhase,
    reason: &str,
) -> (EffectPhase, CommandOutput) {
    facebook_scroll_failure_on_surface(phase, reason, None)
}

/// 带列表面观测的滚动失败回执。「本批看完」的处置在首页与小组页 / 搜索页上并不相同，
/// 云端要按面分流就必须知道这条回执来自哪个面。不新增协议字段——复用既有观测里的面别位。
pub(crate) fn facebook_scroll_failure_on_surface(
    phase: EffectPhase,
    reason: &str,
    surface: Option<&str>,
) -> (EffectPhase, CommandOutput) {
    (
        phase,
        CommandOutput::ActionReceipt(Box::new(ActionReceipt {
            action: "scroll".to_owned(),
            ok: false,
            reason: Some(reason.to_owned()),
            note_id: None,
            observation: surface.filter(|value| !value.is_empty()).map(|value| {
                crate::model::ActionEvidence {
                    surface: Some(value.to_owned()),
                    list_key: None,
                    author: None,
                    text_preview_head: None,
                    reaction_text: None,
                    article_index: None,
                }
            }),
            post_observation: None,
            group_observation: None,
            group_url: None,
            clicked: None,
            candidates: Vec::new(),
        })),
    )
}
