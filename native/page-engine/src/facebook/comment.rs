use super::shared::*;
use crate::commit_window::CommitWindowRequester;
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::input::{TextInputFailure, type_text_humanized};
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

const FACEBOOK_COMMENT_PRE_SUBMIT_RESERVE_MS: u64 = 12_000;
const FACEBOOK_COMMENT_READBACK_BUDGET: Duration = Duration::from_secs(3);

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
    for _ in 0..6 {
        if editor.ok {
            break;
        }
        if editor.reason.as_deref() == Some("target_not_found") {
            break;
        }
        session.cdp.dispatch_wheel(720.0, 440.0, 560.0).await?;
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
                TextInputFailure::Cancelled => unreachable!(),
            },
            Some(params.note_id.clone()),
            None,
        ));
    }
    let accepted = facebook_comment_editor_matches(
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
        || protected_editor.value.as_deref().is_none_or(|value| {
            normalize_facebook_text(value) != normalize_facebook_text(&full_text)
        })
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
        && editor.value.as_deref().is_some_and(|value| {
            normalize_facebook_text(value) == normalize_facebook_text(&full_text)
        }))
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

    let deadline = tokio::time::Instant::now() + Duration::from_secs(9);
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
    match facebook_comment_editor_matches(session, note_id, "", Duration::from_secs(1)).await {
        Ok(true) => FacebookCommentCleanup::Cleared,
        Ok(false) | Err(_) => FacebookCommentCleanup::Dirty,
    }
}

async fn facebook_comment_editor_matches(
    session: &mut EngineSession,
    note_id: &str,
    expected: &str,
    timeout: Duration,
) -> Result<bool, EngineError> {
    let expected = normalize_facebook_text(expected);
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let editor = probe_facebook_comment_editor(session, note_id).await?;
        if editor
            .value
            .as_deref()
            .is_some_and(|value| normalize_facebook_text(value) == expected)
        {
            return Ok(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
