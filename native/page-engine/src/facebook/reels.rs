use super::feed::execute_facebook_feed_scroll;
use super::shared::*;
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::input::{WheelInputFailure, dispatch_wheel_humanized};
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

/// 短视频兜底滚轮的基线位移。共享手势会在此基线上下 ±20% 采样，落在改动前的 70~100px 区间内。
const FACEBOOK_REEL_FALLBACK_WHEEL_BASELINE_PX: f64 = 85.0;

/// Reels 已到达或活动视频已切换后，等待规范身份与卡片完成水合的有界窗口。
const FACEBOOK_REEL_IDENTITY_HYDRATION_TIMEOUT: Duration = Duration::from_secs(15);

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
    let foreground_activated = matches!(
        command,
        NativeCommand::PageScroll(params)
            if params.reason.as_deref() == Some("idle_recover_nudge")
    );
    if foreground_activated {
        session.cdp.bring_to_front().await?;
    }
    let before = probe_facebook_reel(session).await?;
    if !before.is_reels_surface() {
        return execute_facebook_feed_scroll(
            session,
            cancellation,
            deadline_unix_ms,
            foreground_activated,
        )
        .await;
    }
    if !before.ok || before.video_key.is_none() || !before.is_keyboard_input_safe() {
        return Ok(facebook_scroll_failure(
            EffectPhase::NotStarted,
            "no_target",
        ));
    }

    let navigation = probe_facebook_reel_next_target(session).await?;
    if !reel_navigation_probe_matches_active(&navigation, &before) {
        return Ok(facebook_scroll_failure(
            EffectPhase::NotStarted,
            "no_target",
        ));
    }
    let key_order = reel_key_order(navigation.axis, session.facebook.preferred_reel_axis);
    let last_key_axis = key_order[1];
    for axis in key_order {
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
            session.facebook.preferred_reel_axis = Some(axis);
            return finish_facebook_reel_transition(session, command, &before).await;
        }

        // The observation loop may finish one scheduling turn before Facebook commits the
        // transition. This fresh pre-commit readback both catches that late movement and proves
        // that the second key would still target the exact same safe Reel.
        let fresh = probe_facebook_reel(session).await?;
        if reel_transition_observed(&fresh, &before) {
            session.facebook.preferred_reel_axis = Some(axis);
            return finish_facebook_reel_transition(session, command, &before).await;
        }
        if !reel_probe_matches(&fresh, &before) || !fresh.is_keyboard_input_safe() {
            return Ok(facebook_scroll_failure(
                EffectPhase::Ambiguous,
                "reels_navigation_unconfirmed",
            ));
        }
        if session.facebook.preferred_reel_axis == Some(axis) {
            session.facebook.preferred_reel_axis = None;
        }
    }

    let mut target = probe_facebook_reel_next_target(session).await?;
    if reel_target_transition_observed(&target, &before) {
        session.facebook.preferred_reel_axis = Some(last_key_axis);
        return finish_facebook_reel_transition(session, command, &before).await;
    }
    if !reel_navigation_target_matches(&target, &before) {
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            "reels_navigation_unconfirmed",
        ));
    }
    let Some(axis) = target.axis else {
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            "reels_navigation_unconfirmed",
        ));
    };

    if axis == facebook::FacebookReelAxis::Vertical {
        let before_wheel = probe_facebook_reel(session).await?;
        if reel_transition_observed(&before_wheel, &before) {
            session.facebook.preferred_reel_axis = Some(last_key_axis);
            return finish_facebook_reel_transition(session, command, &before).await;
        }
        let Some(rect) = before_wheel.video_rect.as_ref().filter(|_| {
            reel_probe_matches(&before_wheel, &before) && before_wheel.is_keyboard_input_safe()
        }) else {
            return Ok(facebook_scroll_failure(
                EffectPhase::Ambiguous,
                "reels_navigation_unconfirmed",
            ));
        };
        // 兜底滚轮改走共享惯性手势：手势自身在基线附近采样位移（±20%）并逐帧派发，滚前先把
        // 光标移到可滚区中心。原实现用「当前毫秒时间戳对 31 取模」当随机源——同一毫秒内多次
        // 调用完全相同、分布还与墙钟耦合，那不是随机。
        dispatch_wheel_humanized(
            &mut session.cdp,
            (rect.left + rect.right) / 2.0,
            (rect.top + rect.bottom) / 2.0,
            FACEBOOK_REEL_FALLBACK_WHEEL_BASELINE_PX,
            cancellation,
            deadline_unix_ms,
        )
        .await
        .map_err(|failure| match failure {
            WheelInputFailure::Cancelled => cancelled_before_dispatch(),
            WheelInputFailure::Deadline => EngineError::new(
                ErrorCode::CdpTimeout,
                "native Facebook Reel wheel gesture exceeded its deadline",
            ),
            WheelInputFailure::Cdp(error) => error,
        })?;
        if wait_for_facebook_reel_movement(session, &before)
            .await?
            .is_some()
        {
            return finish_facebook_reel_transition(session, command, &before).await;
        }
        target = probe_facebook_reel_next_target(session).await?;
    }

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
    // 「下一个」按钮改走共享指针原语：多帧轨迹 + 落点抖动 + 按下 / 抬起配平，
    // 不再是三条裸事件（裸事件形态下按下失败即早返回、抬起永不发出）。
    dispatch_facebook_click(session, x, y).await?;
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

pub(crate) async fn finish_facebook_reel_transition(
    session: &mut EngineSession,
    command: &NativeCommand,
    previous: &facebook::FacebookReelProbe,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let deadline = tokio::time::Instant::now() + FACEBOOK_REEL_IDENTITY_HYDRATION_TIMEOUT;
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

fn reel_navigation_probe_matches_active(
    target: &facebook::FacebookReelNextTarget,
    previous: &facebook::FacebookReelProbe,
) -> bool {
    // Control ambiguity is intentionally not an admission gate for keyboard probing. Only the
    // exact active Reel binding matters here; pointer safety remains in
    // `reel_navigation_target_matches` below.
    target.ok
        && target.is_keyboard_input_safe()
        && target.video_key == previous.video_key
        && (previous.note_id.is_none() || target.note_id == previous.note_id)
}

fn reel_navigation_target_matches(
    target: &facebook::FacebookReelNextTarget,
    previous: &facebook::FacebookReelProbe,
) -> bool {
    // A proven axis may still authorize the vertical wheel when its overlay is unsafe to click.
    // Every other `found:false` reason blocks the post-key pointer/wheel ladder; it does not gate
    // the bounded keyboard discovery above.
    let input_eligible = if target.found {
        target.reason.is_none()
    } else {
        target.reason.as_deref() == Some("next_control_not_click_safe")
    };
    target.ok
        && target.is_keyboard_input_safe()
        && !target.ambiguous
        && input_eligible
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

pub(crate) fn reel_key_order(
    structural_hint: Option<facebook::FacebookReelAxis>,
    preferred: Option<facebook::FacebookReelAxis>,
) -> [facebook::FacebookReelAxis; 2] {
    let first = structural_hint
        .or(preferred)
        .unwrap_or(facebook::FacebookReelAxis::Horizontal);
    let second = match first {
        facebook::FacebookReelAxis::Vertical => facebook::FacebookReelAxis::Horizontal,
        facebook::FacebookReelAxis::Horizontal => facebook::FacebookReelAxis::Vertical,
    };
    [first, second]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reel_identity_hydration_window_is_fifteen_seconds() {
        assert_eq!(
            FACEBOOK_REEL_IDENTITY_HYDRATION_TIMEOUT,
            Duration::from_secs(15)
        );
    }
}
