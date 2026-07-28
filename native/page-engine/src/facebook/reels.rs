use super::feed::execute_facebook_feed_scroll;
use super::shared::*;
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

pub(crate) async fn execute(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let NativeCommand::InteractionFollow(params) = command else {
        return Err(EngineError::new(
            ErrorCode::EngineInternal,
            "native Facebook Reels capability received another owner's command",
        ));
    };
    execute_facebook_follow(session, params, command).await
}

pub(crate) async fn execute_facebook_follow(
    session: &mut EngineSession,
    params: &crate::command::FollowParams,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    if !probe_facebook_reel(session).await?.is_reels_surface() {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "follow",
            false,
            "capability_unsupported",
            params.note_id.clone(),
            None,
        ));
    }
    let Some(expected_note_id) = params.note_id.as_deref() else {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "follow",
            false,
            "target_not_found",
            None,
            None,
        ));
    };
    let before = probe_facebook_follow(session, Some(expected_note_id)).await?;
    if !before.ok || before.author.as_deref().is_none_or(str::is_empty) {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "follow",
            false,
            before
                .reason
                .as_deref()
                .unwrap_or("follow_author_not_found"),
            before.note_id,
            None,
        ));
    }
    if before.already {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "follow",
            true,
            "already_following",
            before.note_id,
            None,
        ));
    }
    let fresh = probe_facebook_follow(session, Some(expected_note_id)).await?;
    if !fresh.ok || fresh.author.as_deref().is_none_or(str::is_empty) {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "follow",
            false,
            fresh.reason.as_deref().unwrap_or("follow_author_not_found"),
            fresh.note_id.or(before.note_id),
            None,
        ));
    }
    if fresh.note_id != before.note_id
        || fresh.video_key != before.video_key
        || fresh.author != before.author
    {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "follow",
            false,
            "target_moved_before_dispatch",
            before.note_id,
            None,
        ));
    }
    if fresh.already {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "follow",
            true,
            "already_following",
            fresh.note_id,
            None,
        ));
    }
    let (Some(x), Some(y)) = (fresh.cx, fresh.cy) else {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "follow",
            false,
            "follow_button_not_found",
            fresh.note_id,
            None,
        ));
    };
    dispatch_facebook_click(session, x, y).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    loop {
        let after = probe_facebook_follow(session, Some(expected_note_id)).await?;
        if after.note_id != fresh.note_id
            || after.video_key != fresh.video_key
            || after.author != fresh.author
        {
            return Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "follow",
                false,
                "verify_indeterminate",
                fresh.note_id,
                None,
            ));
        }
        if after.ok && after.already {
            return Ok(facebook_action_result(
                EffectPhase::Confirmed,
                "follow",
                true,
                "",
                after.note_id,
                None,
            ));
        }
        if !after.ok
            && matches!(
                after.reason.as_deref(),
                Some("target_not_found" | "ambiguous_target")
            )
        {
            return Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "follow",
                false,
                "verify_indeterminate",
                fresh.note_id,
                None,
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "follow",
                false,
                "follow_unconfirmed",
                fresh.note_id,
                None,
            ));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

pub(crate) async fn execute_facebook_page_scroll(
    session: &mut EngineSession,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    session.cdp.bring_to_front().await?;
    let before = probe_facebook_reel(session).await?;
    if !before.is_reels_surface() {
        return execute_facebook_feed_scroll(session, cancellation, deadline_unix_ms).await;
    }
    if !before.ok || before.video_key.is_none() {
        return Ok(facebook_scroll_failure(
            EffectPhase::NotStarted,
            "no_target",
        ));
    }

    let navigation = probe_facebook_reel_next_target(session).await?;
    if !reel_navigation_target_matches(&navigation, &before) {
        return Ok(facebook_scroll_failure(
            EffectPhase::NotStarted,
            "no_target",
        ));
    }
    let Some(axis) = navigation.axis else {
        return Ok(facebook_scroll_failure(
            EffectPhase::NotStarted,
            "no_target",
        ));
    };
    let (key, key_code) = reel_forward_key(axis);
    session
        .cdp
        .dispatch_key("rawKeyDown", key, key, key_code)
        .await?;
    session
        .cdp
        .dispatch_key("keyUp", key, key, key_code)
        .await?;
    if wait_for_facebook_reel_movement(session, &before)
        .await?
        .is_some()
    {
        return finish_facebook_reel_transition(session, command, &before).await;
    }

    if axis == facebook::FacebookReelAxis::Vertical {
        let before_wheel = probe_facebook_reel(session).await?;
        if reel_transition_observed(&before_wheel, &before) {
            return finish_facebook_reel_transition(session, command, &before).await;
        }
        let Some(rect) = before_wheel
            .video_rect
            .as_ref()
            .filter(|_| reel_probe_matches(&before_wheel, &before))
        else {
            return Ok(facebook_scroll_failure(
                EffectPhase::Ambiguous,
                "reels_navigation_unconfirmed",
            ));
        };
        let delta_y = 70.0 + (unix_time_ms() % 31) as f64;
        session
            .cdp
            .dispatch_wheel(
                (rect.left + rect.right) / 2.0,
                (rect.top + rect.bottom) / 2.0,
                delta_y,
            )
            .await?;
        if wait_for_facebook_reel_movement(session, &before)
            .await?
            .is_some()
        {
            return finish_facebook_reel_transition(session, command, &before).await;
        }
    }

    let target = probe_facebook_reel_next_target(session).await?;
    if reel_target_transition_observed(&target, &before) {
        return finish_facebook_reel_transition(session, command, &before).await;
    }
    if !reel_navigation_target_matches(&target, &before)
        || !target.found
        || target.ambiguous
        || target.axis != Some(axis)
    {
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            "reels_navigation_unconfirmed",
        ));
    }
    let (Some(x), Some(y)) = (target.cx, target.cy) else {
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            "reels_navigation_unconfirmed",
        ));
    };
    session
        .cdp
        .dispatch_mouse("mouseMoved", x, y, "none", 0)
        .await?;
    session
        .cdp
        .dispatch_mouse("mousePressed", x, y, "left", 1)
        .await?;
    session
        .cdp
        .dispatch_mouse("mouseReleased", x, y, "left", 1)
        .await?;
    if wait_for_facebook_reel_movement(session, &before)
        .await?
        .is_some()
    {
        return finish_facebook_reel_transition(session, command, &before).await;
    }

    Ok(facebook_scroll_failure(
        EffectPhase::Ambiguous,
        "reels_navigation_unconfirmed",
    ))
}

pub(crate) async fn probe_facebook_reel(
    session: &mut EngineSession,
) -> Result<facebook::FacebookReelProbe, EngineError> {
    let expression = facebook::reel_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::reel_probe_from_cdp(&raw)
}

async fn probe_facebook_reel_next_target(
    session: &mut EngineSession,
) -> Result<facebook::FacebookReelNextTarget, EngineError> {
    let expression = facebook::reel_next_target_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::reel_next_target_from_cdp(&raw)
}

async fn wait_for_facebook_reel_movement(
    session: &mut EngineSession,
    previous: &facebook::FacebookReelProbe,
) -> Result<Option<facebook::FacebookReelProbe>, EngineError> {
    for round in 0..6 {
        let current = probe_facebook_reel(session).await?;
        if reel_transition_observed(&current, previous) {
            return Ok(Some(current));
        }
        if round < 5 {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
    Ok(None)
}

async fn finish_facebook_reel_transition(
    session: &mut EngineSession,
    command: &NativeCommand,
    previous: &facebook::FacebookReelProbe,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let expression = facebook::reel_cards_expression()?;
        let raw = session.cdp.evaluate(&expression, true).await?;
        let result = facebook::result_from_cdp(&raw)?;
        let output = facebook::typed_output(command, result.output, session.cdp.target_id())?;
        if matches!(&output, CommandOutput::PageCards(cards) if !cards.cards.is_empty()) {
            return Ok((EffectPhase::Confirmed, output));
        }
        if tokio::time::Instant::now() >= deadline {
            let reason = if previous.note_id.is_none() {
                "reels_identity_unresolved"
            } else {
                "reels_navigation_unconfirmed"
            };
            return Ok(facebook_scroll_failure(EffectPhase::Ambiguous, reason));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn reel_probe_matches(
    current: &facebook::FacebookReelProbe,
    previous: &facebook::FacebookReelProbe,
) -> bool {
    current.ok
        && current.video_key == previous.video_key
        && (previous.note_id.is_none() || current.note_id == previous.note_id)
}

fn reel_navigation_target_matches(
    target: &facebook::FacebookReelNextTarget,
    previous: &facebook::FacebookReelProbe,
) -> bool {
    target.ok
        && !target.ambiguous
        && target.video_key == previous.video_key
        && (previous.note_id.is_none() || target.note_id == previous.note_id)
}

fn reel_transition_observed(
    current: &facebook::FacebookReelProbe,
    previous: &facebook::FacebookReelProbe,
) -> bool {
    current.active_video_moved_from(previous) || current.moved_from(previous)
}

fn reel_target_transition_observed(
    target: &facebook::FacebookReelNextTarget,
    previous: &facebook::FacebookReelProbe,
) -> bool {
    target.ok
        && target.video_key.is_some()
        && previous.video_key.is_some()
        && (target.video_key != previous.video_key
            || (previous.note_id.is_some()
                && target.note_id.is_some()
                && target.note_id != previous.note_id))
}

pub(crate) fn reel_forward_key(axis: facebook::FacebookReelAxis) -> (&'static str, u32) {
    match axis {
        facebook::FacebookReelAxis::Vertical => ("ArrowDown", 40),
        facebook::FacebookReelAxis::Horizontal => ("ArrowRight", 39),
    }
}

#[cfg(test)]
pub(crate) fn reel_identity_moved(
    note_id: Option<&str>,
    video_key: Option<&str>,
    previous: &facebook::FacebookReelProbe,
) -> bool {
    let video_moved = video_key.is_some()
        && previous.video_key.is_some()
        && video_key != previous.video_key.as_deref();
    note_id.is_some()
        && video_key.is_some()
        && if previous.note_id.is_none() {
            video_moved
        } else {
            note_id != previous.note_id.as_deref() || video_moved
        }
}
