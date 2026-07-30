use super::reels::probe_facebook_reel;
use super::shared::*;
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::input::{
    PointerClickOptions, PointerPoint, WheelInputFailure, dispatch_wheel_humanized, sample_pause_ms,
};
use crate::locating::{
    Actuation, AnchorCache, AnchorCacheMode, AnchorSource, EscalationKind, LocatingOutcome,
    LocatingSteps, Resolution, ResolvedTarget, Verdict, run_locating_gates,
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
    run_reel_surface_like_gates(session, params, before).await
}

/// 单次尝试的后置校验预算。第一轮 2s、第二轮 3s，与接线前逐字一致。
const REEL_SURFACE_LIKE_VERIFY_MS: [u64; 2] = [2_000, 3_000];
/// 与 `capability.rs` 的 `interaction_like` 条目 `max_dispatch_count = 2` 对齐：
/// 每轮最多派发一次，所以轮次上限就是派发上限。抬高这个数会让台账里那个 2 变成假话。
const REEL_SURFACE_LIKE_MAX_ATTEMPTS: u32 = 2;

/// Reels 面上「身份退化」那条点赞分支的三道闸接线。
///
/// **这不是「视频点赞主路径」**：进到这里的前提是 Reels 面（页面规则的 `reelSurface()`）
/// 且 `note_id` 不是 `/reel/` 地址。此时页面规则的身份比对两侧都归约成空串、等于真空通过 ——
/// 所以本接线拿到的收益是**「读不到」不再被谎报成「没点上」**，
/// **不是**「定位自愈恢复了」。
///
/// 闸③（锚点暂存 / 反污染）在这条路径上**恒空转**：目标来自编译进二进制的固定选择器，
/// 是 `AnchorSource::Deterministic`，`stage_non_deterministic` 会直接早退。
/// 因此这里显式用 `AnchorCacheMode::ReadOnly`，让空转是**声明出来的**而不是碰巧的。
/// MUST NOT 因为本接线落地就声称第三道闸已生效 —— 那是 7.16 待裁定的事。
async fn run_reel_surface_like_gates(
    session: &mut EngineSession,
    params: &crate::command::NoteInteractionParams,
    before: facebook::FacebookLikeProbe,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let fallback_note_id = before.note_id.clone();
    let fallback_observation = before.observation.clone();
    let mut steps = ReelSurfaceLikeSteps {
        session,
        note_id: &params.note_id,
        first_probe: Some(before),
        pending_point: None,
        primary_dispatched: false,
        attempt: 0,
        last_resolve_reason: None,
        last_verdict: None,
        already_confirmed: false,
        note_id_seen: None,
        observation: None,
    };
    let mut cache = AnchorCache::new(AnchorCacheMode::ReadOnly, 2);
    let outcome =
        run_locating_gates(&mut steps, &mut cache, REEL_SURFACE_LIKE_MAX_ATTEMPTS).await?;

    let note_id = steps.note_id_seen.take().or(fallback_note_id);
    let observation = steps.observation.take().or(fallback_observation);
    // 一次新鲜探针读到「已经赞过」就是正面证据，不能因为本轮没派发新点击而报成找不到目标。
    if steps.already_confirmed {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "like",
            true,
            "already_liked",
            note_id,
            observation,
        ));
    }
    Ok(match outcome {
        LocatingOutcome::Confirmed { .. } => facebook_action_result(
            EffectPhase::Confirmed,
            "like",
            true,
            "",
            note_id,
            observation,
        ),
        // 一次都没写下去：按最后一次解析失败的真实原因回报。
        // `LocatingOutcome` 只带 attempts、不带原因，所以原因必须由 steps 自己存 ——
        // 否则接线本身就把三档失败压成一档，正是本 change 要修的病。
        LocatingOutcome::NoTarget { .. } => facebook_action_result(
            EffectPhase::NotStarted,
            "like",
            false,
            steps
                .last_resolve_reason
                .as_deref()
                .unwrap_or("like_button_not_found"),
            note_id,
            observation,
        ),
        // 写已经派发但判不了。本路径 `replayable` 恒为真，所以这一支实际到不了；
        // 留着是为了「哪天改成不可重放时不会静默走进别的分支」。
        LocatingOutcome::Ambiguous { reason, .. } => facebook_action_result(
            EffectPhase::Ambiguous,
            "like",
            false,
            reason,
            note_id,
            observation,
        ),
        // 升级出口。**MUST NOT 回 NotStarted**——写已经派发过了。
        // 台账 `capability.rs` 声明的终局里没有 escalated 这一档，所以这里必须映射回 Ambiguous。
        LocatingOutcome::Escalated { kind, .. } => {
            let reason = match (kind, steps.last_verdict) {
                // 闸①真正修掉的那一档：探针读不到 ≠ 读到了、确实没点上。
                (_, Some(Verdict::Indeterminate)) => "verify_indeterminate",
                (EscalationKind::ResolverUnavailable, _) => "verify_indeterminate",
                _ => "like_unconfirmed",
            };
            facebook_action_result(
                EffectPhase::Ambiguous,
                "like",
                false,
                reason,
                note_id,
                observation,
            )
        }
    })
}

/// 三段步骤的承载体。字段全是**出口要用、而 `LocatingOutcome` 不带**的东西。
struct ReelSurfaceLikeSteps<'a> {
    session: &'a mut EngineSession,
    note_id: &'a str,
    /// 进闸前已经做过一次的主控件探针，第一轮直接复用，避免白白多打一次 CDP 往返。
    first_probe: Option<facebook::FacebookLikeProbe>,
    /// 本轮解析出的落点。`ResolvedTarget` 只带字符串，坐标只能自己拿着。
    pending_point: Option<(f64, f64)>,
    /// 主控件是否已经点过。决定下一轮该解析主控件还是反应浮层。
    primary_dispatched: bool,
    attempt: u32,
    /// 最后一次解析失败的原因（`target_not_found` / `like_button_not_found` / `ambiguous_target` …）。
    last_resolve_reason: Option<String>,
    /// 最后一次后置校验的判定，用来在升级出口区分「读不到」与「确实没点上」。
    last_verdict: Option<Verdict>,
    /// 某一轮的新鲜探针读到了「已经赞过」。
    already_confirmed: bool,
    note_id_seen: Option<String>,
    observation: Option<crate::facebook::ActionEvidence>,
}

impl ReelSurfaceLikeSteps<'_> {
    fn absorb(
        &mut self,
        note_id: Option<String>,
        observation: Option<crate::facebook::ActionEvidence>,
    ) {
        if let Some(note_id) = note_id {
            self.note_id_seen = Some(note_id);
        }
        if observation.is_some() {
            self.observation = observation;
        }
    }
}

impl LocatingSteps for ReelSurfaceLikeSteps<'_> {
    async fn resolve(&mut self, attempt: u32) -> Result<Resolution, EngineError> {
        self.attempt = attempt;
        self.pending_point = None;
        // 主控件还没点下去之前，每一轮都重新解析主控件——不复用上一轮的活引用（闸①的要求）。
        // 主控件点过之后，下一轮的目标换成**反应浮层**：这条路径的两次派发是**两个不同的目标**，
        // 绝不是对同一个控件重试。见 `actuate` 里 `replayable` 那段注释。
        if !self.primary_dispatched {
            let probe = match self.first_probe.take() {
                Some(probe) => probe,
                None => probe_facebook_like(self.session, self.note_id).await?,
            };
            self.absorb(probe.note_id.clone(), probe.observation.clone());
            if !probe.ok {
                self.last_resolve_reason = Some(
                    probe
                        .reason
                        .unwrap_or_else(|| "target_not_found".to_owned()),
                );
                return Ok(Resolution::Missing);
            }
            if probe.already {
                self.already_confirmed = true;
                return Ok(Resolution::Missing);
            }
            let (Some(x), Some(y)) = (probe.cx, probe.cy) else {
                self.last_resolve_reason = Some("like_button_not_found".to_owned());
                return Ok(Resolution::Missing);
            };
            self.pending_point = Some((x, y));
            return Ok(Resolution::Found(ResolvedTarget {
                key: "facebook.reels.like.primary".to_owned(),
                anchor: format!("primary@{x},{y}"),
                source: AnchorSource::Deterministic,
            }));
        }
        let picker = probe_facebook_like_picker(self.session, self.note_id).await?;
        if !picker.ok {
            self.last_resolve_reason = Some(
                picker
                    .reason
                    .unwrap_or_else(|| "like_picker_not_found".to_owned()),
            );
            return Ok(Resolution::Missing);
        }
        let (Some(x), Some(y)) = (picker.cx, picker.cy) else {
            self.last_resolve_reason = Some("like_picker_not_found".to_owned());
            return Ok(Resolution::Missing);
        };
        self.pending_point = Some((x, y));
        Ok(Resolution::Found(ResolvedTarget {
            key: "facebook.reels.like.picker".to_owned(),
            anchor: format!("picker@{x},{y}"),
            source: AnchorSource::Deterministic,
        }))
    }

    async fn actuate(&mut self, _target: &ResolvedTarget) -> Result<Actuation, EngineError> {
        let Some((x, y)) = self.pending_point else {
            return Ok(Actuation {
                dispatched: false,
                replayable: true,
            });
        };
        dispatch_facebook_click(self.session, x, y).await?;
        let was_primary = !self.primary_dispatched;
        if was_primary {
            self.primary_dispatched = true;
        }
        Ok(Actuation {
            dispatched: true,
            // ⚠️ 这里的「可重放」**不是**「同一个控件可以再点一次」。
            // 对帖级主控件再点一次会把赞**取消掉**（`locating.rs` 里 `replayable` 的文档注释
            // 说「点赞这类幂等翻转可重放」，照它朴素理解就会踩这个坑）。
            // 本路径成立的依据是：下一轮的目标由 `resolve` 换成反应浮层，
            // **同一个控件永远只点一次**。改 `resolve` 的分轮逻辑前先想清楚这条。
            replayable: true,
        })
    }

    async fn validate(&mut self, _target: &ResolvedTarget) -> Result<Verdict, EngineError> {
        let budget = REEL_SURFACE_LIKE_VERIFY_MS
            [(self.attempt.max(1) as usize - 1).min(REEL_SURFACE_LIKE_VERIFY_MS.len() - 1)];
        let deadline = tokio::time::Instant::now() + Duration::from_millis(budget);
        let verdict = loop {
            let probe = probe_facebook_like(self.session, self.note_id).await?;
            self.absorb(probe.note_id.clone(), probe.observation.clone());
            // 🔴 本次接线修掉的红线：探针读不到 ≠ 读到了、确实没点上。
            // 改动前 `wait_for_facebook_like` 把这两态一起压成 `false`，
            // 于是「目标丢了 / 身份读不出」被回报成 `like_unconfirmed`（＝确实没点上）。
            if !probe.ok {
                break Verdict::Indeterminate;
            }
            if probe.already {
                break Verdict::Confirmed;
            }
            if tokio::time::Instant::now() >= deadline {
                break Verdict::Unchanged;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        };
        self.last_verdict = Some(verdict);
        Ok(verdict)
    }
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
