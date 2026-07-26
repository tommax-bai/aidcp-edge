use super::file_input_selector;
use super::shared::*;
use crate::commit_window::CommitWindowRequester;
use crate::engine::{CommandOutput, EngineSession, validate_publish_file};
use crate::error::{EngineError, ErrorCode};
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

pub(crate) async fn execute(
    session: &mut EngineSession,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    commit_windows: &CommitWindowRequester,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    match command {
        NativeCommand::PublishNavigateEntry(_) => {
            session.cdp.navigate("https://www.facebook.com/").await?;
            wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
            execute_facebook_publish_entry(session, command).await
        }
        NativeCommand::PublishUploadImage(params) => {
            validate_publish_file(&params.path)?;
            let selector = file_input_selector()?;
            let node_id = session.cdp.query_selector_node(&selector).await?;
            session
                .cdp
                .set_file_input_files(node_id, std::slice::from_ref(&params.path))
                .await?;
            verify_facebook_uploaded_preview(session, command).await
        }
        NativeCommand::PublishFillField(params) => {
            execute_facebook_publish_fill(session, params, command).await
        }
        NativeCommand::PublishSubmit(params) => {
            execute_facebook_publish_submit(
                session,
                params,
                command,
                cancellation,
                commit_windows,
                deadline_unix_ms,
            )
            .await
        }
        NativeCommand::PublishSelectMode(_)
        | NativeCommand::PublishSetCover(_)
        | NativeCommand::PublishAddWithCandidate(_)
        | NativeCommand::PublishSetOption(_)
        | NativeCommand::PublishSetSchedule(_)
        | NativeCommand::PublishCapturePostId(_)
        | NativeCommand::PublishCaptureScheduled(_)
        | NativeCommand::PublishReconcileScheduled(_) => {
            evaluate_facebook_router(session, command).await
        }
        _ => Err(EngineError::new(
            ErrorCode::EngineInternal,
            "native Facebook Publish capability received another owner's command",
        )),
    }
}

pub(crate) async fn execute_facebook_publish_entry(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let NativeCommand::PublishNavigateEntry(params) = command else {
        unreachable!("publish entry handler requires publish navigate command");
    };
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    let target = probe_facebook_publish_entry(session).await?;
    if !target.ok {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "navigate_entry",
            false,
            false,
            target
                .reason
                .as_deref()
                .unwrap_or("composer_entry_not_found"),
        ));
    }
    let (Some(x), Some(y)) = (target.cx, target.cy) else {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "navigate_entry",
            false,
            false,
            "composer_entry_not_found",
        ));
    };
    dispatch_facebook_click(session, x, y).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        let editor = probe_facebook_publish_editor(session).await?;
        if editor.ok {
            return Ok(facebook_publish_result(
                EffectPhase::Confirmed,
                params.record_id,
                params.seq,
                "navigate_entry",
                true,
                true,
                "",
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(facebook_publish_result(
                EffectPhase::Ambiguous,
                params.record_id,
                params.seq,
                "navigate_entry",
                false,
                true,
                "composer_unconfirmed",
            ));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

pub(crate) async fn execute_facebook_publish_fill(
    session: &mut EngineSession,
    params: &crate::command::PublishFieldParams,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if params.field_type == "title" {
        return Ok(facebook_publish_result(
            EffectPhase::Confirmed,
            params.record_id,
            params.seq,
            "fill_field",
            true,
            false,
            "",
        ));
    }
    let value = params.value.trim();
    if value.is_empty() {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "fill_field",
            false,
            false,
            "empty_content",
        ));
    }
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    let editor = probe_facebook_publish_editor(session).await?;
    if !editor.ok {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "fill_field",
            false,
            false,
            editor
                .reason
                .as_deref()
                .unwrap_or("composer_editor_not_found"),
        ));
    }
    let (Some(x), Some(y)) = (editor.cx, editor.cy) else {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "fill_field",
            false,
            false,
            "composer_editor_not_found",
        ));
    };
    dispatch_facebook_click(session, x, y).await?;
    replace_focused_text(session, value).await?;
    let readback = probe_facebook_publish_editor(session).await?;
    if readback
        .value
        .as_deref()
        .is_none_or(|readback| normalize_facebook_text(readback) != normalize_facebook_text(value))
    {
        replace_focused_text(session, "").await?;
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "fill_field",
            false,
            false,
            "composer_readback_mismatch",
        ));
    }
    Ok(facebook_publish_result(
        EffectPhase::Confirmed,
        params.record_id,
        params.seq,
        "fill_field",
        true,
        true,
        "",
    ))
}

pub(crate) async fn execute_facebook_publish_submit(
    session: &mut EngineSession,
    params: &crate::command::PublishIdentity,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    commit_windows: &CommitWindowRequester,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    let target = probe_facebook_publish_submit(session).await?;
    if !target.ok {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "submit",
            false,
            false,
            target.reason.as_deref().unwrap_or("submit_not_found"),
        ));
    }
    if target.cx.is_none() || target.cy.is_none() {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "submit",
            false,
            false,
            "submit_not_found",
        ));
    }
    enter_facebook_commit_window(command, commit_windows, deadline_unix_ms, cancellation).await?;
    let protected_target = probe_facebook_publish_submit(session).await?;
    let (Some(x), Some(y)) = (protected_target.cx, protected_target.cy) else {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "submit",
            false,
            false,
            "target_moved_before_commit",
        ));
    };
    if !protected_target.ok {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "submit",
            false,
            false,
            protected_target
                .reason
                .as_deref()
                .unwrap_or("target_moved_before_commit"),
        ));
    }
    if facebook_command_cancelled(cancellation) {
        return Err(cancelled_before_dispatch());
    }
    dispatch_facebook_click(session, x, y).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        if facebook_command_cancelled(cancellation) {
            return Ok(facebook_publish_result(
                EffectPhase::Ambiguous,
                params.record_id,
                params.seq,
                "submit",
                false,
                true,
                "preempted_by_task",
            ));
        }
        let after = probe_facebook_publish_submit(session).await?;
        if !after.composer_open {
            return Ok(facebook_publish_result(
                EffectPhase::Confirmed,
                params.record_id,
                params.seq,
                "submit",
                true,
                true,
                "",
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(facebook_publish_result(
                EffectPhase::Ambiguous,
                params.record_id,
                params.seq,
                "submit",
                false,
                true,
                "submit_verification_ambiguous",
            ));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}
