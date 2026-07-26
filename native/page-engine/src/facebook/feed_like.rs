use super::reels::probe_facebook_reel;
use super::shared::*;
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::Ordering;
use std::time::Duration;

pub(crate) async fn execute(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let NativeCommand::InteractionLike(params) = command else {
        return Err(EngineError::new(
            ErrorCode::EngineInternal,
            "native Facebook Like capability received another owner's command",
        ));
    };
    execute_facebook_like(session, params, command).await
}

pub(crate) async fn execute_facebook_like(
    session: &mut EngineSession,
    params: &crate::command::NoteInteractionParams,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    if !probe_facebook_reel(session).await?.is_reels_surface() {
        return execute_facebook_feed_like(session, params).await;
    }
    execute_facebook_reel_like(session, params).await
}

async fn execute_facebook_reel_like(
    session: &mut EngineSession,
    params: &crate::command::NoteInteractionParams,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let before = probe_facebook_like(session, &params.note_id).await?;
    if !before.ok {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "like",
            false,
            before.reason.as_deref().unwrap_or("target_not_found"),
            Some(params.note_id.clone()),
            before.observation,
        ));
    }
    if before.already {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "like",
            true,
            "already_liked",
            before.note_id,
            before.observation,
        ));
    }
    if is_facebook_reel_url(&params.note_id) {
        let commit = commit_facebook_reel_like(session, &params.note_id).await?;
        if !commit.ok {
            return Ok(facebook_action_result(
                EffectPhase::NotStarted,
                "like",
                false,
                commit.reason.as_deref().unwrap_or("like_button_not_found"),
                commit.note_id,
                commit.observation.or(before.observation),
            ));
        }
        if commit.already {
            return Ok(facebook_action_result(
                EffectPhase::Confirmed,
                "like",
                true,
                "already_liked",
                commit.note_id,
                commit.observation.or(before.observation),
            ));
        }
        if !commit.clicked {
            return Ok(facebook_action_result(
                EffectPhase::NotStarted,
                "like",
                false,
                commit.reason.as_deref().unwrap_or("like_dispatch_failed"),
                commit.note_id,
                commit.observation.or(before.observation),
            ));
        }
        let note_id = commit.note_id.or(before.note_id);
        let observation = commit.observation.or(before.observation);
        match wait_for_facebook_reel_like(session, &params.note_id, Duration::from_secs(2)).await? {
            FacebookReelLikeVerification::Selected => {
                return Ok(facebook_action_result(
                    EffectPhase::Confirmed,
                    "like",
                    true,
                    "",
                    note_id,
                    observation,
                ));
            }
            FacebookReelLikeVerification::Indeterminate => {
                return Ok(facebook_action_result(
                    EffectPhase::Ambiguous,
                    "like",
                    false,
                    "verify_indeterminate",
                    note_id,
                    observation,
                ));
            }
            FacebookReelLikeVerification::Unchanged => {}
        }

        let picker = probe_facebook_like_picker(session, &params.note_id).await?;
        if picker.ok {
            if let (Some(x), Some(y)) = (picker.cx, picker.cy) {
                dispatch_facebook_click(session, x, y).await?;
            }
        } else if matches!(
            picker.reason.as_deref(),
            Some("target_not_found" | "ambiguous_target" | "like_primary_target_lost")
        ) {
            return Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "like",
                false,
                "verify_indeterminate",
                note_id,
                observation,
            ));
        }
        return match wait_for_facebook_reel_like(session, &params.note_id, Duration::from_secs(3))
            .await?
        {
            FacebookReelLikeVerification::Selected => Ok(facebook_action_result(
                EffectPhase::Confirmed,
                "like",
                true,
                "",
                note_id,
                observation,
            )),
            FacebookReelLikeVerification::Indeterminate => Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "like",
                false,
                "verify_indeterminate",
                note_id,
                observation,
            )),
            FacebookReelLikeVerification::Unchanged => Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "like",
                false,
                "like_unconfirmed",
                note_id,
                observation,
            )),
        };
    }
    let (Some(x), Some(y)) = (before.cx, before.cy) else {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "like",
            false,
            "like_button_not_found",
            before.note_id,
            before.observation,
        ));
    };
    dispatch_facebook_click(session, x, y).await?;
    if wait_for_facebook_like(session, &params.note_id, Duration::from_secs(2)).await? {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "like",
            true,
            "",
            before.note_id,
            before.observation,
        ));
    }

    let picker = probe_facebook_like_picker(session, &params.note_id).await?;
    if picker.ok
        && let (Some(x), Some(y)) = (picker.cx, picker.cy)
    {
        dispatch_facebook_click(session, x, y).await?;
    }
    if wait_for_facebook_like(session, &params.note_id, Duration::from_secs(3)).await? {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "like",
            true,
            "",
            before.note_id,
            before.observation,
        ));
    }
    Ok(facebook_action_result(
        EffectPhase::Ambiguous,
        "like",
        false,
        "like_unconfirmed",
        before.note_id,
        before.observation,
    ))
}

async fn execute_facebook_feed_like(
    session: &mut EngineSession,
    params: &crate::command::NoteInteractionParams,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let operation_id = format!(
        "feed-like-{}-{}",
        unix_time_ms(),
        FACEBOOK_FEED_LIKE_OPERATION.fetch_add(1, Ordering::Relaxed)
    );
    let outcome = execute_facebook_feed_like_inner(session, params, &operation_id).await;
    if let Ok(expression) = facebook::feed_like_clear_expression(&operation_id)
        && let Ok(raw) = session.cdp.evaluate(&expression, true).await
    {
        let _ = facebook::feed_like_clear_from_cdp(&raw);
    }
    outcome
}

async fn execute_facebook_feed_like_inner(
    session: &mut EngineSession,
    params: &crate::command::NoteInteractionParams,
    operation_id: &str,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let mut target = probe_facebook_feed_like_target(session, &params.note_id).await?;
    for round in 0..FACEBOOK_FEED_SCROLL_ROUNDS {
        if !target.ok {
            return Ok(facebook_action_result(
                EffectPhase::NotStarted,
                "like",
                false,
                target.reason.as_deref().unwrap_or("target_not_found"),
                target.note_id.or_else(|| Some(params.note_id.clone())),
                target.observation,
            ));
        }
        if target.in_viewport {
            break;
        }
        if round + 1 >= FACEBOOK_FEED_SCROLL_ROUNDS {
            return Ok(facebook_action_result(
                EffectPhase::NotStarted,
                "like",
                false,
                "target_not_visible",
                target.note_id.or_else(|| Some(params.note_id.clone())),
                target.observation,
            ));
        }
        let viewport_height = target.viewport_height.unwrap_or(800.0).max(1.0);
        let control_top = target.top.unwrap_or(viewport_height);
        let delta_y = (control_top - viewport_height * 0.55).clamp(-620.0, 620.0);
        session
            .cdp
            .dispatch_wheel(
                target.cx.unwrap_or(720.0).max(1.0),
                (viewport_height * 0.55).max(1.0),
                delta_y,
            )
            .await?;
        tokio::time::sleep(Duration::from_millis(250)).await;
        target = probe_facebook_feed_like_target(session, &params.note_id).await?;
    }

    let commit = commit_facebook_feed_like(session, &params.note_id, operation_id).await?;
    if commit.already {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "like",
            true,
            "already_liked",
            commit.note_id,
            commit.observation,
        ));
    }
    if !commit.started {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "like",
            false,
            commit.reason.as_deref().unwrap_or("like_dispatch_failed"),
            commit.note_id.or_else(|| Some(params.note_id.clone())),
            commit.observation,
        ));
    }

    let first = wait_for_facebook_feed_like(
        session,
        &params.note_id,
        operation_id,
        Duration::from_secs(2),
    )
    .await?;
    if first.state == "confirmed" {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "like",
            true,
            "",
            first.note_id.or(commit.note_id),
            first.observation.or(commit.observation),
        ));
    }
    if matches!(first.state.as_str(), "target_lost" | "identity_mismatch") {
        return Ok(facebook_action_result(
            EffectPhase::Ambiguous,
            "like",
            false,
            "verify_indeterminate",
            commit.note_id,
            commit.observation,
        ));
    }

    let picker = probe_facebook_feed_like_picker(session, &params.note_id, operation_id).await?;
    if picker.ok
        && let (Some(from_x), Some(from_y), Some(x), Some(y)) =
            (picker.from_x, picker.from_y, picker.cx, picker.cy)
    {
        dispatch_facebook_picker_click(session, from_x, from_y, x, y).await?;
    }

    let final_verification = wait_for_facebook_feed_like(
        session,
        &params.note_id,
        operation_id,
        Duration::from_secs(3),
    )
    .await?;
    if final_verification.state == "confirmed" {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "like",
            true,
            "",
            final_verification.note_id.or(commit.note_id),
            final_verification.observation.or(commit.observation),
        ));
    }
    let reason = if matches!(
        final_verification.state.as_str(),
        "target_lost" | "identity_mismatch"
    ) {
        "verify_indeterminate"
    } else {
        "state_unchanged"
    };
    Ok(facebook_action_result(
        EffectPhase::Ambiguous,
        "like",
        false,
        reason,
        commit.note_id,
        commit.observation,
    ))
}

async fn probe_facebook_feed_like_target(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookFeedLikeTarget, EngineError> {
    let expression = facebook::feed_like_target_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::feed_like_target_from_cdp(&raw)
}

async fn commit_facebook_feed_like(
    session: &mut EngineSession,
    note_id: &str,
    operation_id: &str,
) -> Result<facebook::FacebookFeedLikeCommit, EngineError> {
    let expression = facebook::feed_like_commit_expression(note_id, operation_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::feed_like_commit_from_cdp(&raw)
}

async fn wait_for_facebook_feed_like(
    session: &mut EngineSession,
    note_id: &str,
    operation_id: &str,
    timeout: Duration,
) -> Result<facebook::FacebookFeedLikeVerification, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let expression = facebook::feed_like_verify_expression(note_id, operation_id)?;
        let raw = session.cdp.evaluate(&expression, true).await?;
        let verification = facebook::feed_like_verify_from_cdp(&raw)?;
        if verification.state != "pending" && verification.state != "control_missing" {
            return Ok(verification);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(verification);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn probe_facebook_feed_like_picker(
    session: &mut EngineSession,
    note_id: &str,
    operation_id: &str,
) -> Result<facebook::FacebookFeedLikePicker, EngineError> {
    let expression = facebook::feed_like_picker_expression(note_id, operation_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::feed_like_picker_from_cdp(&raw)
}

async fn dispatch_facebook_picker_click(
    session: &mut EngineSession,
    from_x: f64,
    from_y: f64,
    x: f64,
    y: f64,
) -> Result<(), EngineError> {
    for step in 0..=4 {
        let progress = step as f64 / 4.0;
        let eased = progress * progress * (3.0 - 2.0 * progress);
        let current_x = from_x + (x - from_x) * eased;
        let current_y = from_y + (y - from_y) * eased;
        session
            .cdp
            .dispatch_mouse("mouseMoved", current_x, current_y, "none", 0)
            .await?;
        if step < 4 {
            tokio::time::sleep(Duration::from_millis(18)).await;
        }
    }
    session
        .cdp
        .dispatch_mouse("mousePressed", x, y, "left", 1)
        .await?;
    session
        .cdp
        .dispatch_mouse("mouseReleased", x, y, "left", 1)
        .await
        .map(|_| ())
}
