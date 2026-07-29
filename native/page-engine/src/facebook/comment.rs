use super::shared::*;
use crate::commit_window::CommitWindowRequester;
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::input::{
    TextInputFailure, WheelInputFailure, dispatch_wheel_humanized, type_text_humanized,
};
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

/// 逐字输入之后**留给提交那一段**的预算（回读校验 + 动作闸 + 提交窗 + 聚焦 + Enter + 就地确认 + 交回执）。
/// 输入死线 = 命令死线 − 本值。留少了的失败形态正是用户报的「输入完还是失败」：字打完了却没时间提交。
///
/// 取值不能机械 ×1.5：这一段的内容是 回读 5s + 就地确认 13.5s = 18.5s，
/// 机械算出的 18s **本身就是负余量**（原值 12s 对 3s+9s=12s 同样是零余量，那条不变式一直是破的）。
/// 取 21s，给「把诚实回执交出去」留约 2.5s——判据同 `feed.rs` 的恢复回执余量。
const FACEBOOK_COMMENT_PRE_SUBMIT_RESERVE_MS: u64 = 21_000;
const FACEBOOK_COMMENT_READBACK_BUDGET: Duration = Duration::from_secs(5);

pub(crate) async fn execute(
    session: &mut EngineSession,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    commit_windows: &CommitWindowRequester,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let NativeCommand::InteractionComment(params) = command else {
        return Err(EngineError::new(
            ErrorCode::EngineInternal,
            "native Facebook Comment capability received another owner's command",
        ));
    };
    execute_facebook_comment(
        session,
        params,
        command,
        cancellation,
        commit_windows,
        deadline_unix_ms,
    )
    .await
}

pub(crate) async fn execute_facebook_comment(
    session: &mut EngineSession,
    params: &crate::command::CommentParams,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    commit_windows: &CommitWindowRequester,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let account_id = params.account_id.as_deref().unwrap_or_default();
    if account_id.len() < 5 || !account_id.chars().all(|value| value.is_ascii_digit()) {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            "identity_unknown",
            Some(params.note_id.clone()),
            None,
        ));
    }
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    let body = params.text.trim();
    if body.is_empty() {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            "comment_text_empty",
            Some(params.note_id.clone()),
            None,
        ));
    }
    let full_text = match params
        .group_chat_code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(code) => format!("{body}\n{code}"),
        None => body.to_owned(),
    };

    let mut editor = probe_facebook_comment_editor(session, &params.note_id).await?;
    // 折叠态是就地评论才有的形态：编辑框还没渲染出来，光滚屏永远催不出来。
    // 退役实现靠「先按 permalink 整页导航到详情页」绕开它，本引擎在列表 / 就地上下文里评论，
    // 没有那条豁免，必须自己把入口点开。每条命令最多点一次。
    let mut entry_probed = false;
    for _ in 0..6 {
        if editor.ok {
            break;
        }
        if editor.reason.as_deref() == Some("target_not_found") {
            break;
        }
        if !entry_probed && editor.reason.as_deref() == Some("editor_not_found") {
            entry_probed = true;
            let entry = probe_facebook_comment_action(session, &params.note_id).await?;
            // 入口探针自己说不清目标时，按对应终态直接收敛，一次点击都不派发——
            // 作用域内不唯一 / 上下文不符时点下去就是往别人的帖子里打字。
            if let Some(reason) = entry.reason.as_deref()
                && matches!(
                    reason,
                    "ambiguous_target"
                        | "pending_group_approval"
                        | "target_context_mismatch"
                        | "target_not_found"
                )
            {
                return Ok(facebook_action_result(
                    EffectPhase::NotStarted,
                    "comment",
                    false,
                    reason,
                    Some(params.note_id.clone()),
                    None,
                ));
            }
            if entry.ok
                && let (Some(x), Some(y)) = (entry.cx, entry.cy)
            {
                if facebook_command_cancelled(cancellation) {
                    return Err(cancelled_before_dispatch());
                }
                dispatch_facebook_click(session, x, y).await?;
                tokio::time::sleep(Duration::from_millis(500)).await;
                editor = probe_facebook_comment_editor(session, &params.note_id).await?;
                continue;
            }
        }
        match dispatch_wheel_humanized(
            &mut session.cdp,
            720.0,
            440.0,
            650.0,
            cancellation,
            deadline_unix_ms,
        )
        .await
        {
            Ok(()) => {}
            Err(WheelInputFailure::Cancelled) => return Err(cancelled_before_dispatch()),
            Err(WheelInputFailure::Deadline) => {
                return Ok(facebook_action_result(
                    EffectPhase::NotStarted,
                    "comment",
                    false,
                    "comment_deadline_exceeded",
                    Some(params.note_id.clone()),
                    None,
                ));
            }
            Err(WheelInputFailure::Cdp(error)) => return Err(error),
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        editor = probe_facebook_comment_editor(session, &params.note_id).await?;
    }
    if !editor.ok {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            editor.reason.as_deref().unwrap_or("editor_not_found"),
            Some(params.note_id.clone()),
            None,
        ));
    }
    let (Some(x), Some(y)) = (editor.cx, editor.cy) else {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            "editor_not_found",
            Some(params.note_id.clone()),
            None,
        ));
    };
    dispatch_facebook_click(session, x, y).await?;
    let cleanup = clear_facebook_comment_editor(session, &params.note_id).await;
    if !matches!(cleanup, FacebookCommentCleanup::Cleared) {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            match cleanup {
                FacebookCommentCleanup::TargetGone => "editor_not_found",
                FacebookCommentCleanup::FocusFailed => "comment_editor_focus_failed",
                FacebookCommentCleanup::Dirty => "comment_editor_clear_failed",
                FacebookCommentCleanup::Cleared => unreachable!(),
            },
            Some(params.note_id.clone()),
            None,
        ));
    }
    let focused = focus_facebook_comment_editor(session, &params.note_id, false).await;
    if !matches!(&focused, Ok(editor)
    if editor.ok
        && editor.focused
        && editor.value.as_deref().is_some_and(|value| {
            normalize_facebook_text(value).is_empty()
        }))
    {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            "comment_editor_focus_failed",
            Some(params.note_id.clone()),
            None,
        ));
    }
    let typing_deadline_unix_ms =
        deadline_unix_ms.saturating_sub(FACEBOOK_COMMENT_PRE_SUBMIT_RESERVE_MS);
    if let Err(failure) = type_text_humanized(
        &mut session.cdp,
        &full_text,
        cancellation,
        typing_deadline_unix_ms,
    )
    .await
    {
        let _ = clear_facebook_comment_editor(session, &params.note_id).await;
        if matches!(failure, TextInputFailure::Cancelled) {
            return Err(cancelled_before_dispatch());
        }
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            match failure {
                TextInputFailure::Deadline => "comment_deadline_exceeded",
                TextInputFailure::Engine => "comment_input_failed",
                TextInputFailure::TargetLost => "comment_input_focus_lost",
                // 逐字原语不含换行单元，这一态在本路径上结构上不可达。
                TextInputFailure::NewlineUnstable => "comment_input_failed",
                TextInputFailure::Cancelled => unreachable!(),
            },
            Some(params.note_id.clone()),
            None,
        ));
    }
    let accepted = facebook_comment_editor_accepts(
        session,
        &params.note_id,
        &full_text,
        FACEBOOK_COMMENT_READBACK_BUDGET,
    )
    .await;
    if !matches!(&accepted, Ok(true)) {
        let _ = clear_facebook_comment_editor(session, &params.note_id).await;
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            if accepted.is_err() {
                "comment_readback_failed"
            } else {
                "marker_not_accepted"
            },
            Some(params.note_id.clone()),
            None,
        ));
    }
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        let _ = clear_facebook_comment_editor(session, &params.note_id).await;
        return Ok((EffectPhase::NotStarted, output));
    }
    if let Err(error) =
        enter_facebook_commit_window(command, commit_windows, deadline_unix_ms, cancellation).await
    {
        let _ = clear_facebook_comment_editor(session, &params.note_id).await;
        return Err(error);
    }
    let protected_editor = match probe_facebook_comment_editor(session, &params.note_id).await {
        Ok(editor) => editor,
        Err(_) => {
            let _ = clear_facebook_comment_editor(session, &params.note_id).await;
            return Ok(facebook_action_result(
                EffectPhase::NotStarted,
                "comment",
                false,
                "target_recheck_failed",
                Some(params.note_id.clone()),
                None,
            ));
        }
    };
    if !protected_editor.ok
        || protected_editor
            .value
            .as_deref()
            .is_none_or(|value| !facebook_comment_text_accepted(value, &full_text))
    {
        let _ = clear_facebook_comment_editor(session, &params.note_id).await;
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            "target_moved_before_commit",
            Some(params.note_id.clone()),
            None,
        ));
    }
    if facebook_command_cancelled(cancellation) {
        let _ = clear_facebook_comment_editor(session, &params.note_id).await;
        return Err(cancelled_before_dispatch());
    }
    if unix_time_ms() >= deadline_unix_ms {
        let _ = clear_facebook_comment_editor(session, &params.note_id).await;
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            "deadline_expired_before_dispatch",
            Some(params.note_id.clone()),
            None,
        ));
    }
    let focused = focus_facebook_comment_editor(session, &params.note_id, false).await;
    if !matches!(&focused, Ok(editor)
    if editor.ok
        && editor.focused
        && editor
            .value
            .as_deref()
            .is_some_and(|value| facebook_comment_text_accepted(value, &full_text)))
    {
        let _ = clear_facebook_comment_editor(session, &params.note_id).await;
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            "comment_editor_focus_failed",
            Some(params.note_id.clone()),
            None,
        ));
    }
    session
        .cdp
        .dispatch_key("rawKeyDown", "Enter", "Enter", 13)
        .await?;
    session
        .cdp
        .dispatch_key("keyUp", "Enter", "Enter", 13)
        .await?;

    if params.fast_return_to_feed == Some(true) {
        tokio::time::sleep(Duration::from_millis(500)).await;
        session.cdp.navigate(FACEBOOK_HOME_URL).await?;
        session.facebook.active_list_url = FACEBOOK_HOME_URL.to_owned();
        return Ok(facebook_action_result(
            EffectPhase::Ambiguous,
            "comment",
            false,
            "verification_ambiguous",
            Some(params.note_id.clone()),
            None,
        ));
    }

    // 就地确认轮询窗：随整体 ×1.5（9s → 13.5s）。它整段落在提交前预留之内，改这里必须复核预留够不够。
    let deadline = tokio::time::Instant::now() + Duration::from_millis(13_500);
    loop {
        if facebook_command_cancelled(cancellation) {
            return Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "comment",
                false,
                "preempted_by_task",
                Some(params.note_id.clone()),
                None,
            ));
        }
        let ack =
            probe_facebook_comment_ack(session, &params.note_id, &full_text, account_id).await?;
        if ack.confirmed {
            return Ok(facebook_action_result(
                EffectPhase::Confirmed,
                "comment",
                true,
                "",
                Some(params.note_id.clone()),
                None,
            ));
        }
        if ack.rejected {
            return Ok(facebook_action_result(
                EffectPhase::Confirmed,
                "comment",
                false,
                "comment_rejected",
                Some(params.note_id.clone()),
                None,
            ));
        }
        if ack.pending {
            return Ok(facebook_action_result(
                EffectPhase::Confirmed,
                "comment",
                false,
                "pending_group_approval",
                Some(params.note_id.clone()),
                None,
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "comment",
                false,
                "verification_ambiguous",
                Some(params.note_id.clone()),
                None,
            ));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FacebookCommentCleanup {
    Cleared,
    TargetGone,
    FocusFailed,
    Dirty,
}

async fn clear_facebook_comment_editor(
    session: &mut EngineSession,
    note_id: &str,
) -> FacebookCommentCleanup {
    let focused = match focus_facebook_comment_editor(session, note_id, true).await {
        Ok(editor) => editor,
        Err(_) => return FacebookCommentCleanup::Dirty,
    };
    if !focused.ok {
        return FacebookCommentCleanup::TargetGone;
    }
    if !focused.focused || !focused.selected {
        return FacebookCommentCleanup::FocusFailed;
    }
    if delete_selected_text(session).await.is_err() {
        return FacebookCommentCleanup::Dirty;
    }
    match facebook_comment_editor_cleared(session, note_id, Duration::from_secs(1)).await {
        Ok(true) => FacebookCommentCleanup::Cleared,
        Ok(false) | Err(_) => FacebookCommentCleanup::Dirty,
    }
}

/// 编辑器回读归一：在既有空白折叠之上再剥掉零宽字符。
/// Facebook 的富文本编辑器会自己往正文里塞零宽字符 / 不间断空格——
/// 「归一后逐字相等」会被这些无害残留直接判失败，正文明明进去了却报「文本未被接受」。
fn normalize_facebook_comment_text(value: &str) -> String {
    normalize_facebook_text(
        &value
            .chars()
            .filter(|value| !matches!(value, '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{feff}'))
            .collect::<String>(),
    )
}

/// 评论文本接受判据。三处回读（打字后、进提交窗口后、回车前聚焦时）共用它，
/// 判据是「规范化后**包含**命令文本 + 多余字符不超过容差」：
/// 纯相等会被编辑器残留误杀，纯包含又会放过打字途中被 typeahead 塞进来的 @提及。
/// 注意：正文与联系方式是拼成一串一次打完的，所以「只有正文进去、联系方式没进去」
/// 在这条判据下同样不成立 —— 拒绝并清场，绝不裸发缺联系方式的正文。
fn facebook_comment_text_accepted(actual: &str, expected: &str) -> bool {
    let actual = normalize_facebook_comment_text(actual);
    let expected = normalize_facebook_comment_text(expected);
    actual.contains(&expected)
        && actual
            .chars()
            .count()
            .saturating_sub(expected.chars().count())
            <= FACEBOOK_TEXT_EXTRA_CHAR_TOLERANCE
}

async fn facebook_comment_editor_accepts(
    session: &mut EngineSession,
    note_id: &str,
    expected: &str,
    timeout: Duration,
) -> Result<bool, EngineError> {
    facebook_comment_editor_settles(session, note_id, timeout, |value| {
        facebook_comment_text_accepted(value, expected)
    })
    .await
}

/// 清场确认必须是**逐字相等的空**，绝不能借用包含判据——任何串都包含空串，
/// 那会让「没清干净」被判成「已清干净」，正是静默假成功。
async fn facebook_comment_editor_cleared(
    session: &mut EngineSession,
    note_id: &str,
    timeout: Duration,
) -> Result<bool, EngineError> {
    facebook_comment_editor_settles(session, note_id, timeout, |value| {
        normalize_facebook_comment_text(value).is_empty()
    })
    .await
}

async fn facebook_comment_editor_settles(
    session: &mut EngineSession,
    note_id: &str,
    timeout: Duration,
    accepts: impl Fn(&str) -> bool,
) -> Result<bool, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let editor = probe_facebook_comment_editor(session, note_id).await?;
        if editor.value.as_deref().is_some_and(&accepts) {
            return Ok(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harmless_editor_residue_no_longer_fails_an_accepted_comment() {
        let expected = "有用的回复";
        assert!(facebook_comment_text_accepted(
            "\u{200b}有用的回复\u{feff}",
            expected
        ));
        assert!(facebook_comment_text_accepted(" 有用的回复 ", expected));
        assert!(facebook_comment_text_accepted("有用的回复 ", expected));
    }

    #[test]
    fn a_truncated_comment_is_never_accepted() {
        assert!(!facebook_comment_text_accepted("有用的回", "有用的回复"));
        assert!(!facebook_comment_text_accepted("", "有用的回复"));
    }

    #[test]
    fn typeahead_pollution_beyond_the_tolerance_is_rejected() {
        let expected = "有用的回复";
        let within = format!(
            "{expected}{}",
            "x".repeat(FACEBOOK_TEXT_EXTRA_CHAR_TOLERANCE)
        );
        let beyond = format!(
            "{expected}{}",
            "x".repeat(FACEBOOK_TEXT_EXTRA_CHAR_TOLERANCE + 1)
        );
        assert!(facebook_comment_text_accepted(&within, expected));
        assert!(
            !facebook_comment_text_accepted(&beyond, expected),
            "被 typeahead 塞进整个 @提及的正文 MUST NOT 发出去"
        );
    }

    #[test]
    fn a_body_without_its_contact_line_is_rejected_as_one_string() {
        // 正文与联系方式拼成一串一次打完，所以「只有正文进去、联系方式没进去」
        // 在包含判据下同样不成立：拒绝并清场，绝不裸发缺联系方式的正文。
        // 代价是诊断粒度——这一档与其他文本未被接受合并成同一个原因码（见台账里的记载）。
        let full = "有用的回复\ngroup-chat-code-42";
        assert!(!facebook_comment_text_accepted("有用的回复", full));
        assert!(facebook_comment_text_accepted(
            "有用的回复 group-chat-code-42",
            full
        ));
    }

    #[test]
    fn the_clear_check_is_exact_emptiness_not_containment() {
        assert!(normalize_facebook_comment_text("\u{200b} \u{feff}").is_empty());
        assert!(!normalize_facebook_comment_text("leftover").is_empty());
        // 若清场借用包含判据，任何残留都会被判成「已清干净」——那是静默假成功。
        assert!(facebook_comment_text_accepted("leftover", ""));
    }
}
