use super::shared::*;
use crate::commit_window::CommitWindowRequester;
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub(crate) async fn execute(
    session: &mut EngineSession,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    commit_windows: &CommitWindowRequester,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let NativeCommand::GroupJoin(params) = command else {
        return Err(EngineError::new(
            ErrorCode::EngineInternal,
            "native Facebook Group Join capability received another owner's command",
        ));
    };
    let url = validated_facebook_group_url(&params.group_url)?;
    let reuse_current_page = if params.click == Some(true) {
        probe_facebook_join(session)
            .await
            .ok()
            .and_then(|probe| probe.observation.group_url)
            .is_some_and(|current| current == url.as_str())
    } else {
        false
    };
    if !reuse_current_page {
        session.cdp.navigate(url.as_str()).await?;
    }
    execute_facebook_group_join(
        session,
        params,
        command,
        cancellation,
        commit_windows,
        deadline_unix_ms,
    )
    .await
}

pub(crate) async fn execute_facebook_group_join(
    session: &mut EngineSession,
    params: &crate::command::GroupJoinParams,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    commit_windows: &CommitWindowRequester,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    if facebook_join_cancelled(cancellation) {
        return Err(cancelled_before_dispatch());
    }
    let readiness_deadline = tokio::time::Instant::now() + FACEBOOK_JOIN_READY_TIMEOUT;
    let before = loop {
        if facebook_join_cancelled(cancellation) {
            return Err(cancelled_before_dispatch());
        }
        let probe = probe_facebook_join(session).await?;
        if facebook_join_readiness_decisive(
            &probe,
            tokio::time::Instant::now() >= readiness_deadline,
        ) {
            break probe;
        }
        if facebook_join_sleep_or_cancel(Duration::from_millis(500), cancellation).await {
            return Err(cancelled_before_dispatch());
        }
    };
    if before.observation.login_required == Some(true) {
        return Ok(facebook_join_result(
            EffectPhase::NotStarted,
            false,
            "login_required",
            false,
            before.observation,
            None,
        ));
    }
    if before.observation.captcha_detected == Some(true) {
        return Ok(facebook_join_result(
            EffectPhase::NotStarted,
            false,
            "blocked_by_captcha",
            false,
            before.observation,
            None,
        ));
    }
    if before.joined && !before.found {
        return Ok(facebook_join_result(
            EffectPhase::Confirmed,
            false,
            "already_member",
            false,
            before.observation,
            None,
        ));
    }
    if before.pending {
        return Ok(facebook_join_result(
            EffectPhase::Confirmed,
            false,
            "pending",
            false,
            before.observation,
            None,
        ));
    }
    if before.questionnaire {
        return Ok(facebook_join_result(
            EffectPhase::NotStarted,
            false,
            "questionnaire_required",
            false,
            before.observation,
            None,
        ));
    }
    if params.click != Some(true) {
        return Ok(facebook_join_result(
            EffectPhase::Confirmed,
            false,
            "observation_only",
            false,
            before.observation,
            None,
        ));
    }
    if before.ambiguous || !before.found {
        return Ok(facebook_join_result(
            EffectPhase::NotStarted,
            false,
            "not_ready",
            false,
            before.observation,
            None,
        ));
    }
    let (Some(x), Some(y)) = (before.cx, before.cy) else {
        return Ok(facebook_join_result(
            EffectPhase::NotStarted,
            false,
            "no_button",
            false,
            before.observation,
            None,
        ));
    };
    if facebook_join_sleep_or_cancel(FACEBOOK_JOIN_HYDRATION_SETTLE, cancellation).await {
        return Err(cancelled_before_dispatch());
    }
    let _ = session
        .cdp
        .dispatch_mouse("mouseMoved", x, y, "none", 0)
        .await;
    if facebook_join_cancelled(cancellation) {
        return Err(cancelled_before_dispatch());
    }
    enter_facebook_commit_window(command, commit_windows, deadline_unix_ms, cancellation).await?;
    let click = execute_facebook_join_click(session).await?;
    if !click.clicked {
        let reason = click.reason.as_deref().unwrap_or("no_button");
        if matches!(
            reason,
            "login_required" | "blocked_by_captcha" | "blocked_by_unknown"
        ) {
            return Ok(facebook_join_result(
                EffectPhase::NotStarted,
                false,
                reason,
                false,
                before.observation,
                None,
            ));
        }
        let retryable = matches!(
            reason,
            "scope_unresolved" | "no_target_in_scope" | "ambiguous_target"
        );
        return Ok(facebook_join_result(
            EffectPhase::NotStarted,
            false,
            if retryable { "not_ready" } else { "no_button" },
            false,
            before.observation,
            None,
        ));
    }
    let initial_observation = before.observation;
    if facebook_join_sleep_or_cancel(FACEBOOK_JOIN_POST_CLICK_SETTLE, cancellation).await {
        return Ok(facebook_join_result(
            EffectPhase::Ambiguous,
            false,
            "preempted_by_task",
            true,
            initial_observation,
            None,
        ));
    }
    let verify_deadline = tokio::time::Instant::now() + FACEBOOK_JOIN_VERIFY_TIMEOUT;
    loop {
        let after = probe_facebook_join(session).await?;
        let structural_transition = initial_observation.composer_present != Some(true)
            && after.observation.composer_present == Some(true)
            && after.observation.join_cta_present != Some(true)
            && after.observation.document_ready.as_deref() != Some("loading");
        match facebook_join_post_decision(
            &after,
            structural_transition,
            facebook_join_cancelled(cancellation),
        ) {
            FacebookJoinPostDecision::Login => {
                return Ok(facebook_join_result(
                    EffectPhase::Ambiguous,
                    false,
                    "login_required",
                    true,
                    initial_observation,
                    Some(after.observation),
                ));
            }
            FacebookJoinPostDecision::Captcha => {
                return Ok(facebook_join_result(
                    EffectPhase::Ambiguous,
                    false,
                    "blocked_by_captcha",
                    true,
                    initial_observation,
                    Some(after.observation),
                ));
            }
            FacebookJoinPostDecision::Pending => {
                return Ok(facebook_join_result(
                    EffectPhase::Confirmed,
                    false,
                    "pending",
                    true,
                    initial_observation,
                    Some(after.observation),
                ));
            }
            FacebookJoinPostDecision::Questionnaire => {
                return Ok(facebook_join_result(
                    EffectPhase::Confirmed,
                    false,
                    "questionnaire_required",
                    true,
                    initial_observation,
                    Some(after.observation),
                ));
            }
            FacebookJoinPostDecision::Joined => {
                return Ok(facebook_join_result(
                    EffectPhase::Confirmed,
                    true,
                    "",
                    true,
                    initial_observation,
                    Some(after.observation),
                ));
            }
            FacebookJoinPostDecision::Preempted => {
                return Ok(facebook_join_result(
                    EffectPhase::Ambiguous,
                    false,
                    "preempted_by_task",
                    true,
                    initial_observation,
                    Some(after.observation),
                ));
            }
            FacebookJoinPostDecision::Continue => {}
        }
        if tokio::time::Instant::now() >= verify_deadline {
            return Ok(facebook_join_result(
                EffectPhase::Ambiguous,
                false,
                "join_verification_ambiguous",
                true,
                initial_observation,
                Some(after.observation),
            ));
        }
        if facebook_join_sleep_or_cancel(Duration::from_millis(500), cancellation).await {
            return Ok(facebook_join_result(
                EffectPhase::Ambiguous,
                false,
                "preempted_by_task",
                true,
                initial_observation,
                Some(after.observation),
            ));
        }
    }
}

pub(crate) fn facebook_join_readiness_decisive(
    probe: &facebook::FacebookJoinProbe,
    deadline_reached: bool,
) -> bool {
    probe.observation.login_required == Some(true)
        || probe.observation.captcha_detected == Some(true)
        || probe.joined
        || probe.pending
        || probe.questionnaire
        || probe.ambiguous
        || (probe.found && probe.observation.document_ready.as_deref() != Some("loading"))
        || deadline_reached
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FacebookJoinPostDecision {
    Login,
    Captcha,
    Pending,
    Questionnaire,
    Joined,
    Preempted,
    Continue,
}

pub(crate) fn facebook_join_post_decision(
    probe: &facebook::FacebookJoinProbe,
    structural_transition: bool,
    cancelled: bool,
) -> FacebookJoinPostDecision {
    if probe.observation.login_required == Some(true) {
        FacebookJoinPostDecision::Login
    } else if probe.observation.captcha_detected == Some(true) {
        FacebookJoinPostDecision::Captcha
    } else if probe.pending {
        FacebookJoinPostDecision::Pending
    } else if probe.questionnaire {
        FacebookJoinPostDecision::Questionnaire
    } else if probe.joined || structural_transition {
        FacebookJoinPostDecision::Joined
    } else if cancelled {
        FacebookJoinPostDecision::Preempted
    } else {
        FacebookJoinPostDecision::Continue
    }
}

fn facebook_join_cancelled(cancellation: Option<&AtomicBool>) -> bool {
    cancellation.is_some_and(|value| value.load(Ordering::Acquire))
}

async fn facebook_join_sleep_or_cancel(
    duration: Duration,
    cancellation: Option<&AtomicBool>,
) -> bool {
    let Some(cancellation) = cancellation else {
        tokio::time::sleep(duration).await;
        return false;
    };
    if cancellation.load(Ordering::Acquire) {
        return true;
    }
    tokio::select! {
        _ = tokio::time::sleep(duration) => false,
        _ = wait_for_cancellation(cancellation) => true,
    }
}

pub(crate) async fn execute_facebook_join_click(
    session: &mut EngineSession,
) -> Result<facebook::FacebookJoinClickResult, EngineError> {
    let expression = facebook::join_click_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::join_click_from_cdp(&raw)
}
