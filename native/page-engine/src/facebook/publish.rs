use super::file_input_selector;
use super::shared::*;
use crate::commit_window::CommitWindowRequester;
use crate::engine::{CommandOutput, EngineSession, validate_publish_file};
use crate::error::{EngineError, ErrorCode};
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use url::Url;

const FACEBOOK_PUBLISH_NAVIGATION_BUDGET: Duration = Duration::from_secs(20);
const FACEBOOK_PUBLISH_COMMAND_BUDGET: Duration = Duration::from_secs(40);
const FACEBOOK_PUBLISH_SUBMIT_VERIFY_BUDGET: Duration = Duration::from_secs(20);
const FACEBOOK_PUBLISH_TRIGGER_BUDGET: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FacebookPublishHomeState {
    Ready,
    Loading,
    NotHome,
    Blocked(&'static str),
}

pub(crate) async fn execute(
    session: &mut EngineSession,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    commit_windows: &CommitWindowRequester,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    match command {
        NativeCommand::PublishNavigateEntry(_) => {
            execute_facebook_publish_entry(session, command, deadline_unix_ms).await
        }
        NativeCommand::PublishSelectMode(params) => {
            execute_facebook_publish_select_mode(session, params, command, deadline_unix_ms).await
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
        NativeCommand::PublishSetCover(_)
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
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let NativeCommand::PublishNavigateEntry(params) = command else {
        unreachable!("publish entry handler requires publish navigate command");
    };
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    session.cdp.navigate(FACEBOOK_HOME_URL).await?;
    let deadline =
        bounded_facebook_publish_deadline(deadline_unix_ms, FACEBOOK_PUBLISH_NAVIGATION_BUDGET);
    let mut home_observed = false;
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Ok(facebook_publish_result(
                EffectPhase::NotStarted,
                params.record_id,
                params.seq,
                "navigate_entry",
                false,
                false,
                if home_observed {
                    "home_not_reached"
                } else {
                    "home_probe_failed"
                },
            ));
        }
        let home = match probe_facebook_publish_home(session).await {
            Ok(home) => {
                home_observed = true;
                home
            }
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(250)).await;
                continue;
            }
        };
        if tokio::time::Instant::now() >= deadline {
            return Ok(facebook_publish_result(
                EffectPhase::NotStarted,
                params.record_id,
                params.seq,
                "navigate_entry",
                false,
                false,
                "home_not_reached",
            ));
        }
        match home {
            FacebookPublishHomeState::Ready => {
                if let Some(output) = ensure_facebook_action_gate(session, command).await? {
                    return Ok((EffectPhase::NotStarted, output));
                }
                if tokio::time::Instant::now() >= deadline {
                    return Ok(facebook_publish_result(
                        EffectPhase::NotStarted,
                        params.record_id,
                        params.seq,
                        "navigate_entry",
                        false,
                        false,
                        "home_not_reached",
                    ));
                }
                return Ok(facebook_publish_result(
                    EffectPhase::Confirmed,
                    params.record_id,
                    params.seq,
                    "navigate_entry",
                    true,
                    false,
                    "",
                ));
            }
            FacebookPublishHomeState::Blocked(reason) => {
                return Ok(facebook_publish_result(
                    EffectPhase::NotStarted,
                    params.record_id,
                    params.seq,
                    "navigate_entry",
                    false,
                    false,
                    reason,
                ));
            }
            FacebookPublishHomeState::Loading | FacebookPublishHomeState::NotHome => {}
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn execute_facebook_publish_select_mode(
    session: &mut EngineSession,
    params: &crate::command::PublishSelectModeParams,
    command: &NativeCommand,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if params
        .option_kind
        .as_deref()
        .is_some_and(|kind| kind != "target")
        || params.option_value.as_deref() != Some("facebook_personal_timeline")
    {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "select_mode",
            false,
            false,
            "unsupported_target",
        ));
    }
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    let command_deadline =
        bounded_facebook_publish_deadline(deadline_unix_ms, FACEBOOK_PUBLISH_COMMAND_BUDGET);
    let trigger_deadline =
        bounded_facebook_publish_deadline(deadline_unix_ms, FACEBOOK_PUBLISH_TRIGGER_BUDGET);
    loop {
        if tokio::time::Instant::now() >= command_deadline {
            return Ok(facebook_publish_result(
                EffectPhase::NotStarted,
                params.record_id,
                params.seq,
                "select_mode",
                false,
                false,
                "deadline_expired_before_dispatch",
            ));
        }
        let home = probe_facebook_publish_home(session).await?;
        if tokio::time::Instant::now() >= command_deadline {
            return Ok(facebook_publish_result(
                EffectPhase::NotStarted,
                params.record_id,
                params.seq,
                "select_mode",
                false,
                false,
                "deadline_expired_before_dispatch",
            ));
        }
        match home {
            FacebookPublishHomeState::Ready => {}
            FacebookPublishHomeState::Blocked(reason) => {
                return Ok(facebook_publish_result(
                    EffectPhase::NotStarted,
                    params.record_id,
                    params.seq,
                    "select_mode",
                    false,
                    false,
                    reason,
                ));
            }
            FacebookPublishHomeState::Loading | FacebookPublishHomeState::NotHome => {
                return Ok(facebook_publish_result(
                    EffectPhase::NotStarted,
                    params.record_id,
                    params.seq,
                    "select_mode",
                    false,
                    false,
                    "home_not_reached",
                ));
            }
        }
        let editor = probe_facebook_publish_editor(session).await?;
        if tokio::time::Instant::now() >= command_deadline {
            return Ok(facebook_publish_result(
                EffectPhase::NotStarted,
                params.record_id,
                params.seq,
                "select_mode",
                false,
                false,
                "deadline_expired_before_dispatch",
            ));
        }
        if editor.ok {
            return Ok(facebook_publish_result(
                EffectPhase::Confirmed,
                params.record_id,
                params.seq,
                "select_mode",
                true,
                false,
                "",
            ));
        }
        let target = probe_facebook_publish_entry(session).await?;
        if tokio::time::Instant::now() >= trigger_deadline {
            return Ok(facebook_publish_result(
                EffectPhase::NotStarted,
                params.record_id,
                params.seq,
                "select_mode",
                false,
                false,
                if target.ok {
                    "trigger_deadline_expired"
                } else {
                    target
                        .reason
                        .as_deref()
                        .unwrap_or("composer_entry_not_found")
                },
            ));
        }
        if target.ok {
            let fresh = probe_facebook_publish_entry(session).await?;
            if tokio::time::Instant::now() >= trigger_deadline {
                return Ok(facebook_publish_result(
                    EffectPhase::NotStarted,
                    params.record_id,
                    params.seq,
                    "select_mode",
                    false,
                    false,
                    "trigger_deadline_expired",
                ));
            }
            if !fresh.ok {
                tokio::time::sleep(Duration::from_millis(400)).await;
                continue;
            }
            let (Some(x), Some(y)) = (fresh.cx, fresh.cy) else {
                tokio::time::sleep(Duration::from_millis(400)).await;
                continue;
            };
            dispatch_facebook_click(session, x, y).await?;
            loop {
                let editor = match probe_facebook_publish_editor(session).await {
                    Ok(editor) => editor,
                    Err(_) => {
                        if tokio::time::Instant::now() >= command_deadline {
                            return Ok(facebook_publish_result(
                                EffectPhase::Ambiguous,
                                params.record_id,
                                params.seq,
                                "select_mode",
                                false,
                                true,
                                "composer_unconfirmed",
                            ));
                        }
                        tokio::time::sleep(Duration::from_millis(400)).await;
                        continue;
                    }
                };
                if tokio::time::Instant::now() >= command_deadline {
                    return Ok(facebook_publish_result(
                        EffectPhase::Ambiguous,
                        params.record_id,
                        params.seq,
                        "select_mode",
                        false,
                        true,
                        "composer_unconfirmed",
                    ));
                }
                if editor.ok {
                    return Ok(facebook_publish_result(
                        EffectPhase::Confirmed,
                        params.record_id,
                        params.seq,
                        "select_mode",
                        true,
                        true,
                        "",
                    ));
                }
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

fn bounded_facebook_publish_deadline(
    deadline_unix_ms: u64,
    maximum: Duration,
) -> tokio::time::Instant {
    let remaining = Duration::from_millis(deadline_unix_ms.saturating_sub(unix_time_ms()));
    tokio::time::Instant::now() + remaining.min(maximum)
}

async fn probe_facebook_publish_home(
    session: &mut EngineSession,
) -> Result<FacebookPublishHomeState, EngineError> {
    let page = probe_facebook_publish_home_snapshot(session).await?;
    let Ok(url) = Url::parse(&page.href) else {
        return Ok(FacebookPublishHomeState::Blocked("not_facebook"));
    };
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let facebook_host = host == "facebook.com"
        || host.ends_with(".facebook.com")
        || host == "facebookcorewwwi.onion"
        || host.ends_with(".facebookcorewwwi.onion");
    if !facebook_host {
        return Ok(FacebookPublishHomeState::Blocked("not_facebook"));
    }
    let path = url.path().to_ascii_lowercase();
    if path.starts_with("/checkpoint") {
        return Ok(FacebookPublishHomeState::Blocked("checkpoint_detected"));
    }
    if path.starts_with("/login") || page.credential_input {
        return Ok(FacebookPublishHomeState::Blocked("login_required"));
    }
    if page.blocking_dialog && !page.editor_ready {
        return Ok(FacebookPublishHomeState::Blocked("blocked_dialog"));
    }
    if !matches!(page.ready_state.as_str(), "interactive" | "complete") {
        return Ok(FacebookPublishHomeState::Loading);
    }
    if path != "/" {
        return Ok(FacebookPublishHomeState::NotHome);
    }
    if page.main_visible || page.editor_ready {
        return Ok(FacebookPublishHomeState::Ready);
    }
    Ok(FacebookPublishHomeState::Loading)
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
    if unix_time_ms() >= deadline_unix_ms {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "submit",
            false,
            false,
            "deadline_expired_before_dispatch",
        ));
    }
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
    if unix_time_ms() >= deadline_unix_ms {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "submit",
            false,
            false,
            "deadline_expired_before_dispatch",
        ));
    }
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
    let deadline =
        bounded_facebook_publish_deadline(deadline_unix_ms, FACEBOOK_PUBLISH_SUBMIT_VERIFY_BUDGET);
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
        let after = match probe_facebook_publish_submitted(session).await {
            Ok(after) => after,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(400)).await;
                continue;
            }
        };
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
        if after.confirmed {
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
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

#[cfg(test)]
#[path = "publish_tests.rs"]
mod tests;
