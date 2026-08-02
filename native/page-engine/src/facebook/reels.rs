use super::feed::execute_facebook_feed_scroll;
use super::shared::*;
use crate::engine::{CommandOutput, EngineSession, FacebookPendingReelTransition};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::input::{WheelInputFailure, dispatch_wheel_humanized, unix_time_ms};
use crate::model::{FacebookListKind, FacebookListState, PostIdentityKind};
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// 短视频兜底滚轮的基线位移。共享手势会在此基线上下 ±20% 采样，落在改动前的 70~100px 区间内。
const FACEBOOK_REEL_FALLBACK_WHEEL_BASELINE_PX: f64 = 85.0;

/// Reels 已到达或活动视频已切换后，等待规范身份与卡片完成水合的有界窗口。
const FACEBOOK_REEL_IDENTITY_HYDRATION_TIMEOUT: Duration = Duration::from_secs(15);
const FACEBOOK_REEL_ENTRY_POST_INPUT_RESERVE_MS: u64 = 18_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReelNavigationMode {
    Standard,
    AnonymousEntry,
}

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
    if session.facebook.pending_reel_transition.is_some() {
        return recover_pending_facebook_reel_transition(session, command, &before).await;
    }
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

    execute_facebook_reel_navigation(
        session,
        command,
        before,
        ReelNavigationMode::Standard,
        cancellation,
        deadline_unix_ms,
    )
    .await
}

pub(crate) async fn finish_facebook_reels_entry(
    session: &mut EngineSession,
    command: &NativeCommand,
    initial: &facebook::FacebookReelProbe,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if let Some(output) = wait_for_canonical_facebook_reel_card(
        session,
        command,
        initial,
        false,
        None,
        None,
        FACEBOOK_REEL_IDENTITY_HYDRATION_TIMEOUT,
    )
    .await?
    {
        session.facebook.pending_reel_transition = None;
        return Ok((EffectPhase::Confirmed, output));
    }

    let fresh = probe_facebook_reel(session).await?;
    if !fresh.is_reels_surface() {
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            "reels_entry_unconfirmed",
        ));
    }

    // A spontaneous transition also consumes the one permitted entry advance. Never add another
    // write merely because the moved-to Reel is still anonymous.
    if fresh.active_video_moved_from(initial) {
        remember_pending_reel_identity(
            session,
            fresh.video_key.as_deref(),
            canonical_reel_id(initial.note_id.as_deref()),
        );
        return recover_pending_facebook_reel_transition(session, command, &fresh).await;
    }

    // The same video's canonical identity may appear exactly as the original hydration window
    // closes. Keep it in place, but do not start a second 15-second entry window.
    if fresh.note_id.is_some() {
        return finish_entry_boundary_identity(session, command, initial, &fresh).await;
    }

    if !fresh.is_unique_anonymous_video() || !fresh.is_explicitly_keyboard_input_safe() {
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            anonymous_entry_unavailable_reason(&fresh),
        ));
    }
    if let Some(result) = anonymous_entry_write_gate(cancellation, deadline_unix_ms, false)? {
        return Ok(result);
    }

    execute_facebook_reel_navigation(
        session,
        command,
        fresh,
        ReelNavigationMode::AnonymousEntry,
        cancellation,
        deadline_unix_ms,
    )
    .await
}

async fn finish_entry_boundary_identity(
    session: &mut EngineSession,
    command: &NativeCommand,
    previous: &facebook::FacebookReelProbe,
    current: &facebook::FacebookReelProbe,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let Some(video_key) = current
        .video_key
        .as_deref()
        .filter(|value| !value.is_empty())
    else {
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            "reels_entry_target_unavailable",
        ));
    };
    if let Some(output) =
        read_canonical_facebook_reel_card(session, command, previous, false, Some(video_key), None)
            .await?
    {
        session.facebook.pending_reel_transition = None;
        return Ok((EffectPhase::Confirmed, output));
    }
    remember_pending_reel_identity(session, Some(video_key), None);
    Ok(facebook_scroll_failure(
        EffectPhase::Ambiguous,
        "reels_entry_identity_pending",
    ))
}

async fn execute_facebook_reel_navigation(
    session: &mut EngineSession,
    command: &NativeCommand,
    before: facebook::FacebookReelProbe,
    mode: ReelNavigationMode,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let entry_mode = mode == ReelNavigationMode::AnonymousEntry;

    let navigation = probe_facebook_reel_next_target(session).await?;
    if entry_mode && reel_target_transition_observed(&navigation, &before) {
        remember_pending_reel_identity(
            session,
            navigation.video_key.as_deref(),
            canonical_reel_id(before.note_id.as_deref()),
        );
        let current = probe_facebook_reel(session).await?;
        return recover_pending_facebook_reel_transition(session, command, &current).await;
    }
    if entry_mode && navigation.note_id.is_some() {
        let current = probe_facebook_reel(session).await?;
        return finish_entry_boundary_identity(session, command, &before, &current).await;
    }
    if !reel_navigation_probe_matches_active(&navigation, &before)
        || (entry_mode && !navigation.is_explicitly_keyboard_input_safe())
    {
        return Ok(facebook_scroll_failure(
            navigation_failure_phase(mode, false),
            navigation_failure_reason(mode, false),
        ));
    }
    let key_order = reel_key_order(navigation.axis, session.facebook.preferred_reel_axis);
    let last_key_axis = key_order[1];
    let mut last_dispatched_axis = None;
    for axis in key_order {
        if entry_mode {
            let precommit = probe_facebook_reel(session).await?;
            if reel_transition_observed(&precommit, &before) {
                remember_pending_reel_identity(
                    session,
                    precommit.video_key.as_deref(),
                    canonical_reel_id(before.note_id.as_deref()),
                );
                if let Some(dispatched_axis) = last_dispatched_axis {
                    session.facebook.preferred_reel_axis = Some(dispatched_axis);
                }
                return finish_facebook_reel_transition_for_mode(session, command, &before, mode)
                    .await;
            }
            if precommit.note_id.is_some() {
                if last_dispatched_axis.is_some() {
                    return recover_pending_facebook_reel_transition(session, command, &precommit)
                        .await;
                }
                return finish_entry_boundary_identity(session, command, &before, &precommit).await;
            }
            if !reel_probe_matches(&precommit, &before)
                || !precommit.is_unique_anonymous_video()
                || !precommit.is_explicitly_keyboard_input_safe()
            {
                if session.facebook.pending_reel_transition.is_some() {
                    return recover_pending_facebook_reel_transition(session, command, &precommit)
                        .await;
                }
                return Ok(facebook_scroll_failure(
                    EffectPhase::Ambiguous,
                    anonymous_entry_unavailable_reason(&precommit),
                ));
            }
            if let Some(result) = anonymous_entry_write_gate(
                cancellation,
                deadline_unix_ms,
                last_dispatched_axis.is_some(),
            )? {
                return Ok(result);
            }
            remember_pending_reel_movement(session, before.video_key.as_deref());
        }
        let (key, key_code) = reel_forward_key(axis);
        session
            .cdp
            .dispatch_key("rawKeyDown", key, key, key_code)
            .await?;
        session
            .cdp
            .dispatch_key("keyUp", key, key, key_code)
            .await?;
        last_dispatched_axis = Some(axis);
        if let Some(moved) = wait_for_facebook_reel_movement(session, &before).await? {
            remember_pending_reel_identity_after_movement(
                session,
                moved.video_key.as_deref(),
                &before,
            );
            session.facebook.preferred_reel_axis = Some(axis);
            return finish_facebook_reel_transition_for_mode(session, command, &before, mode).await;
        }

        // The observation loop may finish one scheduling turn before Facebook commits the
        // transition. This fresh pre-commit readback both catches that late movement and proves
        // that the second key would still target the exact same safe Reel.
        let fresh = probe_facebook_reel(session).await?;
        if reel_transition_observed(&fresh, &before) {
            remember_pending_reel_identity_after_movement(
                session,
                fresh.video_key.as_deref(),
                &before,
            );
            session.facebook.preferred_reel_axis = Some(axis);
            return finish_facebook_reel_transition_for_mode(session, command, &before, mode).await;
        }
        if entry_mode && fresh.note_id.is_some() {
            return recover_pending_facebook_reel_transition(session, command, &fresh).await;
        }
        if !reel_probe_matches(&fresh, &before)
            || !fresh.is_keyboard_input_safe()
            || (entry_mode && !fresh.is_explicitly_keyboard_input_safe())
            || (entry_mode && !fresh.is_unique_anonymous_video())
        {
            return Ok(facebook_scroll_failure(
                EffectPhase::Ambiguous,
                navigation_failure_reason(mode, true),
            ));
        }
        if session.facebook.preferred_reel_axis == Some(axis) {
            session.facebook.preferred_reel_axis = None;
        }
    }

    let mut target = probe_facebook_reel_next_target(session).await?;
    if reel_target_transition_observed(&target, &before) {
        remember_pending_reel_identity_after_movement(
            session,
            target.video_key.as_deref(),
            &before,
        );
        session.facebook.preferred_reel_axis = Some(last_key_axis);
        return finish_facebook_reel_transition_for_mode(session, command, &before, mode).await;
    }
    if entry_mode && target.note_id.is_some() {
        let current = probe_facebook_reel(session).await?;
        return recover_pending_facebook_reel_transition(session, command, &current).await;
    }
    if !reel_navigation_target_matches(&target, &before)
        || (entry_mode && !target.is_explicitly_keyboard_input_safe())
    {
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            navigation_failure_reason(mode, true),
        ));
    }
    let Some(axis) = target.axis else {
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            navigation_failure_reason(mode, true),
        ));
    };

    if axis == facebook::FacebookReelAxis::Vertical {
        let before_wheel = probe_facebook_reel(session).await?;
        if reel_transition_observed(&before_wheel, &before) {
            remember_pending_reel_identity_after_movement(
                session,
                before_wheel.video_key.as_deref(),
                &before,
            );
            session.facebook.preferred_reel_axis = Some(last_key_axis);
            return finish_facebook_reel_transition_for_mode(session, command, &before, mode).await;
        }
        if entry_mode && before_wheel.note_id.is_some() {
            return recover_pending_facebook_reel_transition(session, command, &before_wheel).await;
        }
        let Some(rect) = before_wheel.video_rect.as_ref().filter(|_| {
            reel_probe_matches(&before_wheel, &before)
                && before_wheel.is_keyboard_input_safe()
                && (!entry_mode || before_wheel.is_explicitly_keyboard_input_safe())
                && (!entry_mode || before_wheel.is_unique_anonymous_video())
        }) else {
            return Ok(facebook_scroll_failure(
                EffectPhase::Ambiguous,
                navigation_failure_reason(mode, true),
            ));
        };
        if entry_mode
            && let Some(result) = anonymous_entry_write_gate(cancellation, deadline_unix_ms, true)?
        {
            return Ok(result);
        }
        // 兜底滚轮改走共享惯性手势：手势自身在基线附近采样位移（±20%）并逐帧派发，滚前先把
        // 光标移到可滚区中心。原实现用「当前毫秒时间戳对 31 取模」当随机源——同一毫秒内多次
        // 调用完全相同、分布还与墙钟耦合，那不是随机。
        let wheel_result = dispatch_wheel_humanized(
            &mut session.cdp,
            (rect.left + rect.right) / 2.0,
            (rect.top + rect.bottom) / 2.0,
            FACEBOOK_REEL_FALLBACK_WHEEL_BASELINE_PX,
            cancellation,
            deadline_unix_ms,
        )
        .await;
        if matches!(
            &wheel_result,
            Err(WheelInputFailure::Cancelled | WheelInputFailure::Deadline)
        ) {
            return Ok(facebook_scroll_failure(
                EffectPhase::Ambiguous,
                navigation_failure_reason(mode, true),
            ));
        }
        wheel_result.map_err(|failure| match failure {
            WheelInputFailure::Cancelled => cancelled_before_dispatch(),
            WheelInputFailure::Deadline => EngineError::new(
                ErrorCode::CdpTimeout,
                "native Facebook Reel wheel gesture exceeded its deadline",
            ),
            WheelInputFailure::Cdp(error) => error,
        })?;
        if let Some(moved) = wait_for_facebook_reel_movement(session, &before).await? {
            remember_pending_reel_identity_after_movement(
                session,
                moved.video_key.as_deref(),
                &before,
            );
            return finish_facebook_reel_transition_for_mode(session, command, &before, mode).await;
        }
        target = probe_facebook_reel_next_target(session).await?;
    }

    if reel_target_transition_observed(&target, &before) {
        remember_pending_reel_identity_after_movement(
            session,
            target.video_key.as_deref(),
            &before,
        );
        return finish_facebook_reel_transition_for_mode(session, command, &before, mode).await;
    }
    if entry_mode && target.note_id.is_some() {
        let current = probe_facebook_reel(session).await?;
        return recover_pending_facebook_reel_transition(session, command, &current).await;
    }
    if !reel_navigation_target_matches(&target, &before)
        || (entry_mode && !target.is_explicitly_keyboard_input_safe())
        || !target.found
        || target.ambiguous
        || target.axis != Some(axis)
    {
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            navigation_failure_reason(mode, true),
        ));
    }
    let (Some(x), Some(y)) = (target.cx, target.cy) else {
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            navigation_failure_reason(mode, true),
        ));
    };
    if entry_mode
        && let Some(result) = anonymous_entry_write_gate(cancellation, deadline_unix_ms, true)?
    {
        return Ok(result);
    }
    // 「下一个」按钮改走共享指针原语：多帧轨迹 + 落点抖动 + 按下 / 抬起配平，
    // 不再是三条裸事件（裸事件形态下按下失败即早返回、抬起永不发出）。
    dispatch_facebook_click(session, x, y).await?;
    if let Some(moved) = wait_for_facebook_reel_movement(session, &before).await? {
        remember_pending_reel_identity_after_movement(session, moved.video_key.as_deref(), &before);
        return finish_facebook_reel_transition_for_mode(session, command, &before, mode).await;
    }

    Ok(facebook_scroll_failure(
        EffectPhase::Ambiguous,
        navigation_failure_reason(mode, true),
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

async fn finish_facebook_reel_transition_for_mode(
    session: &mut EngineSession,
    command: &NativeCommand,
    previous: &facebook::FacebookReelProbe,
    mode: ReelNavigationMode,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let timeout_reason = match mode {
        ReelNavigationMode::AnonymousEntry => "reels_post_transition_identity_pending",
        ReelNavigationMode::Standard if previous.note_id.is_none() => "reels_identity_unresolved",
        ReelNavigationMode::Standard => "reels_navigation_unconfirmed",
    };
    let current = probe_facebook_reel(session).await?;
    recover_pending_facebook_reel_transition_with_timeout_reason(
        session,
        command,
        &current,
        Some(timeout_reason),
    )
    .await
}

async fn wait_for_canonical_facebook_reel_card(
    session: &mut EngineSession,
    command: &NativeCommand,
    previous: &facebook::FacebookReelProbe,
    require_movement: bool,
    expected_video_key: Option<&str>,
    forbidden_reel_id: Option<&str>,
    timeout: Duration,
) -> Result<Option<CommandOutput>, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(output) = read_canonical_facebook_reel_card(
            session,
            command,
            previous,
            require_movement,
            expected_video_key,
            forbidden_reel_id,
        )
        .await?
        {
            return Ok(Some(output));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(None);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn read_canonical_facebook_reel_card(
    session: &mut EngineSession,
    command: &NativeCommand,
    previous: &facebook::FacebookReelProbe,
    require_movement: bool,
    expected_video_key: Option<&str>,
    forbidden_reel_id: Option<&str>,
) -> Result<Option<CommandOutput>, EngineError> {
    let (output, current) = read_facebook_reel_card_snapshot(session, command).await?;
    Ok(canonical_facebook_reel_card_matches(
        &output,
        &current,
        previous,
        require_movement,
        expected_video_key,
        forbidden_reel_id,
    )
    .then_some(output))
}

async fn read_facebook_reel_card_snapshot(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(CommandOutput, facebook::FacebookReelProbe), EngineError> {
    let expression = facebook::reel_cards_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = facebook::result_from_cdp(&raw)?;
    let output = facebook::typed_output(command, result.output, session.cdp.target_id())?;
    let current = probe_facebook_reel(session).await?;
    Ok((output, current))
}

fn canonical_facebook_reel_card_matches(
    output: &CommandOutput,
    current: &facebook::FacebookReelProbe,
    previous: &facebook::FacebookReelProbe,
    require_movement: bool,
    expected_video_key: Option<&str>,
    forbidden_reel_id: Option<&str>,
) -> bool {
    let CommandOutput::PageCards(cards) = output else {
        return false;
    };
    if cards.list_kind != Some(FacebookListKind::Reels)
        || cards.list_state != Some(FacebookListState::Ready)
        || cards.cards.len() != 1
    {
        return false;
    }
    if !current.ok || current.video_key.is_none() || current.note_id.is_none() {
        return false;
    }
    if expected_video_key.is_some() && current.video_key.as_deref() != expected_video_key {
        return false;
    }
    if require_movement && !current.moved_from(previous) {
        return false;
    }
    let card = &cards.cards[0];
    if card.is_video != Some(true) {
        return false;
    }
    if !matches!(card.note_id_kind, Some(PostIdentityKind::Permalink) | None) {
        return false;
    }
    let (Some(current_note_id), Some(card_note_id)) =
        (current.note_id.as_deref(), card.note_id.as_deref())
    else {
        return false;
    };
    if !is_facebook_reel_url(current_note_id) || !is_facebook_reel_url(card_note_id) {
        return false;
    }
    let (Some(current_id), Some(card_id)) = (
        canonical_facebook_post_id(current_note_id),
        canonical_facebook_post_id(card_note_id),
    ) else {
        return false;
    };
    current_id == card_id && forbidden_reel_id != Some(current_id.as_str())
}

async fn recover_pending_facebook_reel_transition(
    session: &mut EngineSession,
    command: &NativeCommand,
    current: &facebook::FacebookReelProbe,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    recover_pending_facebook_reel_transition_with_timeout_reason(session, command, current, None)
        .await
}

async fn recover_pending_facebook_reel_transition_with_timeout_reason(
    session: &mut EngineSession,
    command: &NativeCommand,
    current: &facebook::FacebookReelProbe,
    timeout_reason: Option<&'static str>,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if !current.is_reels_surface() {
        session.facebook.pending_reel_transition = None;
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            "reels_pending_surface_lost",
        ));
    }
    let Some(mut pending) = session.facebook.pending_reel_transition.clone() else {
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            "reels_pending_state_missing",
        ));
    };
    if let Some(reason) = reconcile_pending_reel_target(&mut pending, current) {
        session.facebook.pending_reel_transition = Some(pending);
        return pending_reel_failure(reason);
    }
    session.facebook.pending_reel_transition = Some(pending.clone());

    let deadline = tokio::time::Instant::now() + FACEBOOK_REEL_IDENTITY_HYDRATION_TIMEOUT;
    loop {
        let (output, observed) = read_facebook_reel_card_snapshot(session, command).await?;
        if !observed.is_reels_surface() {
            session.facebook.pending_reel_transition = None;
            return Ok(facebook_scroll_failure(
                EffectPhase::Ambiguous,
                "reels_pending_surface_lost",
            ));
        }
        if let Some(reason) = reconcile_pending_reel_target(&mut pending, &observed) {
            session.facebook.pending_reel_transition = Some(pending);
            return pending_reel_failure(reason);
        }
        session.facebook.pending_reel_transition = Some(pending.clone());
        let expected_video_key = pending_reel_video_key(&pending);
        if canonical_facebook_reel_card_matches(
            &output,
            &observed,
            current,
            false,
            Some(expected_video_key),
            pending_forbidden_reel_id(&pending),
        ) {
            session.facebook.pending_reel_transition = None;
            return Ok((EffectPhase::Confirmed, output));
        }
        if tokio::time::Instant::now() >= deadline {
            let reason = timeout_reason.unwrap_or(match pending {
                FacebookPendingReelTransition::AwaitingMovement { .. } => {
                    "reels_entry_navigation_unconfirmed"
                }
                FacebookPendingReelTransition::AwaitingIdentity { .. } => {
                    "reels_post_transition_identity_pending"
                }
                FacebookPendingReelTransition::TargetChanged { .. } => {
                    "reels_pending_target_changed"
                }
            });
            return Ok(facebook_scroll_failure(EffectPhase::Ambiguous, reason));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn remember_pending_reel_movement(session: &mut EngineSession, video_key: Option<&str>) {
    if let Some(video_key) = video_key.filter(|value| !value.is_empty())
        && session.facebook.pending_reel_transition.is_none()
    {
        session.facebook.pending_reel_transition =
            Some(FacebookPendingReelTransition::AwaitingMovement {
                original_video_key: video_key.to_owned(),
            });
    }
}

fn remember_pending_reel_identity(
    session: &mut EngineSession,
    video_key: Option<&str>,
    forbidden_reel_id: Option<String>,
) {
    if let Some(video_key) = video_key.filter(|value| !value.is_empty()) {
        session.facebook.pending_reel_transition =
            Some(FacebookPendingReelTransition::AwaitingIdentity {
                moved_video_key: video_key.to_owned(),
                forbidden_reel_id,
            });
    }
}

fn remember_pending_reel_identity_after_movement(
    session: &mut EngineSession,
    video_key: Option<&str>,
    previous: &facebook::FacebookReelProbe,
) {
    // A proven transition with no canonical card must be recovered before any later scroll,
    // regardless of whether it happened during first entry or ordinary Reels browsing.
    remember_pending_reel_identity(
        session,
        video_key,
        canonical_reel_id(previous.note_id.as_deref()),
    );
}

fn reconcile_pending_reel_target(
    pending: &mut FacebookPendingReelTransition,
    current: &facebook::FacebookReelProbe,
) -> Option<&'static str> {
    if matches!(pending, FacebookPendingReelTransition::TargetChanged { .. }) {
        return Some("reels_pending_target_changed");
    }
    let Some(current_video_key) = current
        .ok
        .then_some(current.video_key.as_deref())
        .flatten()
        .filter(|value| !value.is_empty())
    else {
        return Some("reels_pending_target_unavailable");
    };
    match pending {
        FacebookPendingReelTransition::AwaitingMovement { original_video_key }
            if current_video_key != original_video_key =>
        {
            *pending = FacebookPendingReelTransition::AwaitingIdentity {
                moved_video_key: current_video_key.to_owned(),
                forbidden_reel_id: None,
            };
            None
        }
        FacebookPendingReelTransition::AwaitingMovement { .. } => None,
        FacebookPendingReelTransition::AwaitingIdentity {
            moved_video_key, ..
        } if current_video_key == moved_video_key => None,
        FacebookPendingReelTransition::AwaitingIdentity {
            moved_video_key, ..
        } => {
            let expected_video_key = moved_video_key.clone();
            *pending = FacebookPendingReelTransition::TargetChanged { expected_video_key };
            Some("reels_pending_target_changed")
        }
        FacebookPendingReelTransition::TargetChanged { .. } => Some("reels_pending_target_changed"),
    }
}

fn pending_reel_video_key(pending: &FacebookPendingReelTransition) -> &str {
    match pending {
        FacebookPendingReelTransition::AwaitingMovement { original_video_key } => {
            original_video_key
        }
        FacebookPendingReelTransition::AwaitingIdentity {
            moved_video_key, ..
        } => moved_video_key,
        FacebookPendingReelTransition::TargetChanged { expected_video_key } => expected_video_key,
    }
}

fn pending_forbidden_reel_id(pending: &FacebookPendingReelTransition) -> Option<&str> {
    match pending {
        FacebookPendingReelTransition::AwaitingMovement { .. } => None,
        FacebookPendingReelTransition::AwaitingIdentity {
            forbidden_reel_id, ..
        } => forbidden_reel_id.as_deref(),
        FacebookPendingReelTransition::TargetChanged { .. } => None,
    }
}

fn canonical_reel_id(note_id: Option<&str>) -> Option<String> {
    note_id
        .filter(|value| is_facebook_reel_url(value))
        .and_then(canonical_facebook_post_id)
}

fn pending_reel_failure(reason: &'static str) -> Result<(EffectPhase, CommandOutput), EngineError> {
    Ok(facebook_scroll_failure(EffectPhase::Ambiguous, reason))
}

fn anonymous_entry_unavailable_reason(probe: &facebook::FacebookReelProbe) -> &'static str {
    match probe.reason.as_deref() {
        Some("no_active_video") => "reels_entry_active_video_missing",
        Some("ambiguous_target") => "reels_entry_active_video_ambiguous",
        _ if !probe.is_explicitly_keyboard_input_safe() => "reels_entry_input_unsafe",
        _ => "reels_entry_target_unavailable",
    }
}

fn anonymous_entry_write_gate(
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
    input_dispatched: bool,
) -> Result<Option<(EffectPhase, CommandOutput)>, EngineError> {
    if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
        return Ok(Some(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            if input_dispatched {
                "reels_entry_navigation_unconfirmed"
            } else {
                "reels_entry_cancelled_after_route"
            },
        )));
    }
    if deadline_unix_ms.saturating_sub(unix_time_ms()) < FACEBOOK_REEL_ENTRY_POST_INPUT_RESERVE_MS {
        return Ok(Some(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            if input_dispatched {
                "reels_entry_deadline_insufficient_after_input"
            } else {
                "reels_entry_deadline_insufficient"
            },
        )));
    }
    Ok(None)
}

fn navigation_failure_phase(mode: ReelNavigationMode, input_dispatched: bool) -> EffectPhase {
    if input_dispatched || mode == ReelNavigationMode::AnonymousEntry {
        EffectPhase::Ambiguous
    } else {
        EffectPhase::NotStarted
    }
}

fn navigation_failure_reason(mode: ReelNavigationMode, input_dispatched: bool) -> &'static str {
    match (mode, input_dispatched) {
        (ReelNavigationMode::AnonymousEntry, true) => "reels_entry_navigation_unconfirmed",
        (ReelNavigationMode::AnonymousEntry, false) => "reels_entry_target_unavailable",
        (ReelNavigationMode::Standard, true) => "reels_navigation_unconfirmed",
        (ReelNavigationMode::Standard, false) => "no_target",
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
    use crate::model::{FacebookListState, PageCard, PageCards};

    fn reel_probe(note_id: Option<&str>, video_key: &str) -> facebook::FacebookReelProbe {
        facebook::FacebookReelProbe {
            ok: true,
            reason: None,
            note_id: note_id.map(str::to_owned),
            video_key: Some(video_key.to_owned()),
            video_rect: None,
            input_safe: Some(true),
        }
    }

    fn reel_cards(note_id: &str, kind: Option<PostIdentityKind>, count: usize) -> CommandOutput {
        CommandOutput::PageCards(PageCards {
            cards: (0..count)
                .map(|index| PageCard {
                    index: index as u32,
                    title: "Reel".to_owned(),
                    author: None,
                    like_count: 0,
                    collect_count: 0,
                    cover_desc: None,
                    note_id: Some(note_id.to_owned()),
                    note_id_kind: kind,
                    is_video: Some(true),
                })
                .collect(),
            movement: None,
            document_generation: None,
            container_name: None,
            list_kind: Some(FacebookListKind::Reels),
            list_state: Some(FacebookListState::Ready),
            selection_reason: None,
        })
    }

    #[test]
    fn reel_identity_hydration_window_is_fifteen_seconds() {
        assert_eq!(
            FACEBOOK_REEL_IDENTITY_HYDRATION_TIMEOUT,
            Duration::from_secs(15)
        );
    }

    #[test]
    fn canonical_reel_completion_requires_one_matching_permalink_card() {
        let before = reel_probe(None, "video-1");
        let moved = reel_probe(Some("https://www.facebook.com/reel/2"), "video-2");
        let exact = reel_cards("https://www.facebook.com/reel/2", None, 1);
        assert!(canonical_facebook_reel_card_matches(
            &exact,
            &moved,
            &before,
            true,
            Some("video-2"),
            None
        ));

        let anonymous = reel_probe(None, "video-2");
        assert!(!canonical_facebook_reel_card_matches(
            &exact,
            &anonymous,
            &before,
            true,
            Some("video-2"),
            None
        ));

        let content_ref = reel_cards(
            "facebook-content-ref:session:2",
            Some(PostIdentityKind::ContentRef),
            1,
        );
        let content_ref_probe = reel_probe(Some("facebook-content-ref:session:2"), "video-2");
        assert!(!canonical_facebook_reel_card_matches(
            &content_ref,
            &content_ref_probe,
            &before,
            true,
            Some("video-2"),
            None
        ));

        let multiple = reel_cards("https://www.facebook.com/reel/2", None, 2);
        assert!(!canonical_facebook_reel_card_matches(
            &multiple,
            &moved,
            &before,
            true,
            Some("video-2"),
            None
        ));

        let mismatched = reel_cards("https://www.facebook.com/reel/3", None, 1);
        assert!(!canonical_facebook_reel_card_matches(
            &mismatched,
            &moved,
            &before,
            true,
            Some("video-2"),
            None
        ));

        assert!(!canonical_facebook_reel_card_matches(
            &exact,
            &moved,
            &before,
            true,
            Some("video-3"),
            None
        ));

        let evil_url = "https://facebook.com.evil.test/reel/2";
        let evil_probe = reel_probe(Some(evil_url), "video-2");
        let evil_card = reel_cards(evil_url, Some(PostIdentityKind::Permalink), 1);
        assert!(!canonical_facebook_reel_card_matches(
            &evil_card,
            &evil_probe,
            &before,
            true,
            Some("video-2"),
            None
        ));

        let post_url = "https://www.facebook.com/groups/1/posts/2";
        let post_probe = reel_probe(Some(post_url), "video-2");
        let post_card = reel_cards(post_url, Some(PostIdentityKind::Permalink), 1);
        assert!(!canonical_facebook_reel_card_matches(
            &post_card,
            &post_probe,
            &before,
            true,
            Some("video-2"),
            None
        ));

        let mut not_video = exact.clone();
        let CommandOutput::PageCards(cards) = &mut not_video else {
            unreachable!()
        };
        cards.cards[0].is_video = Some(false);
        assert!(!canonical_facebook_reel_card_matches(
            &not_video,
            &moved,
            &before,
            true,
            Some("video-2"),
            None
        ));

        let mut not_ready = exact.clone();
        let CommandOutput::PageCards(cards) = &mut not_ready else {
            unreachable!()
        };
        cards.list_state = Some(FacebookListState::PresentUnreportable);
        assert!(!canonical_facebook_reel_card_matches(
            &not_ready,
            &moved,
            &before,
            true,
            Some("video-2"),
            None
        ));

        let canonical_before = reel_probe(Some("https://www.facebook.com/reel/1"), "video-1");
        let remounted_same_reel = reel_probe(Some("https://www.facebook.com/reel/1"), "video-2");
        let same_reel_card = reel_cards("https://www.facebook.com/reel/1", None, 1);
        assert!(!canonical_facebook_reel_card_matches(
            &same_reel_card,
            &remounted_same_reel,
            &canonical_before,
            true,
            Some("video-2"),
            Some("1")
        ));
    }

    #[test]
    fn canonical_entry_hydration_does_not_require_video_movement() {
        let anonymous = reel_probe(None, "video-1");
        let hydrated = reel_probe(Some("https://www.facebook.com/reel/1"), "video-1");
        let exact = reel_cards("https://www.facebook.com/reel/1", None, 1);
        assert!(canonical_facebook_reel_card_matches(
            &exact,
            &hydrated,
            &anonymous,
            false,
            Some("video-1"),
            None
        ));
        assert!(!canonical_facebook_reel_card_matches(
            &exact,
            &hydrated,
            &anonymous,
            true,
            Some("video-1"),
            None
        ));
    }

    #[test]
    fn pending_reel_observation_adopts_only_one_late_video_change() {
        let mut pending = FacebookPendingReelTransition::AwaitingMovement {
            original_video_key: "video-1".to_owned(),
        };
        let moved = reel_probe(None, "video-2");
        assert_eq!(reconcile_pending_reel_target(&mut pending, &moved), None);
        assert_eq!(
            pending,
            FacebookPendingReelTransition::AwaitingIdentity {
                moved_video_key: "video-2".to_owned(),
                forbidden_reel_id: None
            }
        );
        let same_target = reel_probe(Some("https://www.facebook.com/reel/2"), "video-2");
        assert_eq!(
            reconcile_pending_reel_target(&mut pending, &same_target),
            None
        );

        let drifted = reel_probe(Some("https://www.facebook.com/reel/3"), "video-3");
        assert_eq!(
            reconcile_pending_reel_target(&mut pending, &drifted),
            Some("reels_pending_target_changed")
        );
        assert_eq!(
            pending,
            FacebookPendingReelTransition::TargetChanged {
                expected_video_key: "video-2".to_owned()
            }
        );
        let returned = reel_probe(Some("https://www.facebook.com/reel/2"), "video-2");
        assert_eq!(
            reconcile_pending_reel_target(&mut pending, &returned),
            Some("reels_pending_target_changed")
        );
    }

    #[test]
    fn entry_write_gate_is_ambiguous_after_route_or_input() {
        let cancelled = AtomicBool::new(true);
        for (input_dispatched, expected_reason) in [
            (false, "reels_entry_cancelled_after_route"),
            (true, "reels_entry_navigation_unconfirmed"),
        ] {
            let (phase, output) =
                anonymous_entry_write_gate(Some(&cancelled), u64::MAX, input_dispatched)
                    .expect("entry gate")
                    .expect("cancelled entry receipt");
            assert_eq!(phase, EffectPhase::Ambiguous);
            let CommandOutput::ActionReceipt(receipt) = output else {
                panic!("expected entry cancellation receipt")
            };
            assert_eq!(receipt.reason.as_deref(), Some(expected_reason));
        }
    }

    #[test]
    fn anonymous_entry_unavailable_reasons_distinguish_target_states() {
        let missing = facebook::FacebookReelProbe {
            ok: false,
            reason: Some("no_active_video".to_owned()),
            note_id: None,
            video_key: None,
            video_rect: None,
            input_safe: None,
        };
        assert_eq!(
            anonymous_entry_unavailable_reason(&missing),
            "reels_entry_active_video_missing"
        );

        let ambiguous = facebook::FacebookReelProbe {
            reason: Some("ambiguous_target".to_owned()),
            ..missing.clone()
        };
        assert_eq!(
            anonymous_entry_unavailable_reason(&ambiguous),
            "reels_entry_active_video_ambiguous"
        );

        let unsafe_video = facebook::FacebookReelProbe {
            ok: true,
            reason: None,
            note_id: None,
            video_key: Some("video-1".to_owned()),
            video_rect: None,
            input_safe: Some(false),
        };
        assert_eq!(
            anonymous_entry_unavailable_reason(&unsafe_video),
            "reels_entry_input_unsafe"
        );

        let safety_missing = facebook::FacebookReelProbe {
            input_safe: None,
            ..unsafe_video
        };
        assert_eq!(
            anonymous_entry_unavailable_reason(&safety_missing),
            "reels_entry_input_unsafe"
        );
    }
}
