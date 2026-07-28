use super::reels::probe_facebook_reel;
use super::shared::*;
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::input::{
    PointerClickOptions, PointerPoint, WheelInputFailure, dispatch_wheel_humanized, sample_pause_ms,
};
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::Ordering;
use std::time::Duration;

/// 对齐滚动把控件带到视口的这个纵向比例处（与改动前一致）。
const FACEBOOK_ALIGN_SCROLL_VIEW_RATIO: f64 = 0.55;
/// 对齐滚动后重新解析目标的间隔中心值（改动前是固定 250ms）。
const FACEBOOK_ALIGN_SCROLL_REPROBE_CENTER_MS: f64 = 250.0;

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
        // 基线位移仍按控件偏移算，但交给共享惯性手势去采样：手势自带 ±20% 抖动，把
        // 「位移 = 位置的确定函数」打散成「位移 ≈ 位置的带噪估计」——人手滚不出与目标位置
        // 精确相关的位移量（design D5）。轮次结构与每轮重解析保持不变。
        let baseline_distance_px =
            (control_top - viewport_height * FACEBOOK_ALIGN_SCROLL_VIEW_RATIO).clamp(-620.0, 620.0);
        dispatch_wheel_humanized(
            &mut session.cdp,
            target.cx.unwrap_or(720.0).max(1.0),
            (viewport_height * FACEBOOK_ALIGN_SCROLL_VIEW_RATIO).max(1.0),
            baseline_distance_px,
            None,
            u64::MAX,
        )
        .await
        .map_err(|failure| match failure {
            WheelInputFailure::Cancelled => cancelled_before_dispatch(),
            WheelInputFailure::Deadline => EngineError::new(
                ErrorCode::CdpTimeout,
                "native Facebook align scroll exceeded its deadline",
            ),
            WheelInputFailure::Cdp(error) => error,
        })?;
        // 固定 250ms 重探间隔本身是机器特征，改为围绕同一中心值的对数正态采样。
        tokio::time::sleep(Duration::from_millis(sample_pause_ms(
            FACEBOOK_ALIGN_SCROLL_REPROBE_CENTER_MS,
        )))
        .await;
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

/// 反应浮层「赞」项的提交：起点显式取帖级 react 控件坐标、禁用过冲——路径必须紧贴
/// 「控件 → 浮层」走廊，过冲会甩出浮层 hover 区致其收起（见 design D3 与本轮的走廊断言）。
async fn dispatch_facebook_picker_click(
    session: &mut EngineSession,
    from_x: f64,
    from_y: f64,
    x: f64,
    y: f64,
) -> Result<(), EngineError> {
    dispatch_facebook_click_with(
        session,
        x,
        y,
        PointerClickOptions::from_corridor(PointerPoint {
            x: from_x,
            y: from_y,
        }),
    )
    .await
    .map(|_| ())
}
