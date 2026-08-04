use crate::commit_window::CommitWindowRequester;
use crate::effect::error_code_means_not_started;
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::input::{
    PointerClickOptions, PointerInputFailure, PointerPoint, dispatch_pointer_click,
};
use crate::model::{ActionReceipt, PublishReceipt};
use crate::probe::ProbeResult;
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

pub(crate) const FACEBOOK_HOME_URL: &str = "https://www.facebook.com/";
// 时间预算整体 ×1.5（用户口径，2026-07-29）。只放大**等页面的容错窗**；
// 拟人停顿、限流地板、判稳预算不动——它们不是容错：判稳是「页面渲染完要多久」的经验值，
// 且身份采集（下方常量）明确依赖「8 轮判稳要装进命令预算」，放大它会直接撑爆那条算式。
pub(crate) const FACEBOOK_DETAIL_HYDRATION_TIMEOUT: Duration = Duration::from_secs(23);
pub(crate) const FACEBOOK_FEED_SETTLE_NAV: Duration = Duration::from_secs(6);
pub(crate) const FACEBOOK_FEED_SETTLE_IN_PLACE: Duration = Duration::from_millis(3_500);
pub(crate) const FACEBOOK_FEED_SCROLL_ROUNDS: usize = 8;

// 身份采集（change acquire-facebook-feed-post-identity-by-hover）。Facebook 把帖子地址扣在 DOM 之外，
// 只有可信指针落到时间戳上才换出真地址。
//
// **预算必须按「整条命令」算，不能按轮算**：滚动命令的原子预算上限是 engine.rs 的
// DEFAULT_COMMAND_TIMEOUT_MS = 30s（实际取 min(会话 timeout_ms, 该上限)），超时即 CdpTimeout / Ambiguous。
// 而零卡屏上判稳本身最坏就要 8 轮 × 3.5s ≈ 28s。采集若按轮给预算、8 轮各来一次，必然把整条命令撑爆。
// 故给一个跨轮共享的小预算：最坏 3 卡 × 2 候选 × 1.2s ≈ 7.2s，由 8s 总预算兜住。
// 调大前先算清楚它与判稳耗时之和是否仍显著小于 30s。
pub(crate) const FACEBOOK_IDENTITY_SETTLE: Duration = Duration::from_millis(1_200);
pub(crate) const FACEBOOK_IDENTITY_MAX_CANDIDATES_PER_CARD: usize = 2;
pub(crate) const FACEBOOK_IDENTITY_MAX_CARDS_PER_ROUND: usize = 3;
pub(crate) const FACEBOOK_IDENTITY_COMMAND_BUDGET: Duration = Duration::from_secs(8);
/// 两次「刷新导致整页重载」之间的最小间隔：**限流地板**，不是超时，不随预算放大。
pub(crate) const FACEBOOK_REFRESH_RELOAD_FLOOR_MS: u64 = 180_000;
pub(crate) const FACEBOOK_JOIN_READY_TIMEOUT: Duration = Duration::from_secs(45);
/// 点击前后的拟人停顿：**节奏**不是容错，不随预算放大。
pub(crate) const FACEBOOK_JOIN_HYDRATION_SETTLE: Duration = Duration::from_secs(2);
pub(crate) const FACEBOOK_JOIN_POST_CLICK_SETTLE: Duration = Duration::from_millis(1_500);
pub(crate) const FACEBOOK_JOIN_VERIFY_TIMEOUT: Duration = Duration::from_secs(68);
pub(crate) const FACEBOOK_PUBLISH_UPLOAD_VERIFY_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) static FACEBOOK_FEED_LIKE_OPERATION: AtomicU64 = AtomicU64::new(1);

pub(crate) fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub(crate) fn cancelled_before_dispatch() -> EngineError {
    EngineError::new(
        ErrorCode::Cancelled,
        "native page engine command cancelled before dispatch",
    )
}

pub(crate) fn facebook_command_cancelled(cancellation: Option<&AtomicBool>) -> bool {
    cancellation.is_some_and(|value| value.load(Ordering::Acquire))
}

pub(crate) async fn wait_for_cancellation(cancellation: &AtomicBool) {
    while !cancellation.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

pub(crate) async fn probe_facebook_like(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookLikeProbe, EngineError> {
    let expression = facebook::like_probe_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::like_probe_from_cdp(&raw)
}

pub(crate) async fn commit_facebook_reel_like(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookLikeCommit, EngineError> {
    let expression = facebook::like_primary_commit_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::like_commit_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_like_picker(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookPointTarget, EngineError> {
    let expression = facebook::like_picker_probe_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::point_target_from_cdp(&raw)
}

pub(crate) enum FacebookReelLikeVerification {
    Selected,
    Unchanged,
    Indeterminate,
}

pub(crate) async fn wait_for_facebook_reel_like(
    session: &mut EngineSession,
    note_id: &str,
    timeout: Duration,
) -> Result<FacebookReelLikeVerification, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    let expected_post_id = canonical_facebook_post_id(note_id);
    loop {
        let expression = facebook::like_verify_expression(note_id)?;
        let raw = session.cdp.evaluate(&expression, true).await?;
        let probe = facebook::like_verify_from_cdp(&raw)?;
        let observed_post_id = probe
            .note_id
            .as_deref()
            .and_then(canonical_facebook_post_id);
        // A missing replacement control is only an observation gap; a different canonical Reel
        // is the evidence that makes continued verification unsafe.
        if observed_post_id
            .as_deref()
            .is_some_and(|observed| expected_post_id.as_deref() != Some(observed))
        {
            return Ok(FacebookReelLikeVerification::Indeterminate);
        }
        let probe_readable =
            probe.ok && observed_post_id.is_some() && observed_post_id == expected_post_id;
        if probe_readable && probe.selected {
            return Ok(FacebookReelLikeVerification::Selected);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(if probe_readable {
                FacebookReelLikeVerification::Unchanged
            } else {
                FacebookReelLikeVerification::Indeterminate
            });
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

// `wait_for_facebook_like` 曾在此处，已删除。它返回 `bool`：把「探针读不到」与
// 「读到了、确实没点上」压成同一个 `false`，调用方因此只能一律回报 `like_unconfirmed` ——
// 正是「『读不到』与『没有』不得压成一态」这条红线的违规。
// 它唯二的调用点在 `feed_like.rs` 的 Reels 面点赞分支，现已改走三道闸编排：
// 后置校验落在 `ReelSurfaceLikeSteps::validate`，按三态（Confirmed / Unchanged / Indeterminate）回报。
// 同族的三态版本 `wait_for_facebook_reel_like`（就在上面）保留，供 `/reel/` 分支继续使用。

pub(crate) async fn probe_facebook_follow(
    session: &mut EngineSession,
    note_id: Option<&str>,
) -> Result<facebook::FacebookFollowProbe, EngineError> {
    let expression = facebook::follow_probe_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::follow_probe_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_comment_action(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookPointTarget, EngineError> {
    let expression = facebook::comment_action_probe_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::point_target_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_comment_editor(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookTextTarget, EngineError> {
    let expression = facebook::comment_editor_probe_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::text_target_from_cdp(&raw)
}

pub(crate) async fn focus_facebook_comment_editor(
    session: &mut EngineSession,
    note_id: &str,
    select_contents: bool,
) -> Result<facebook::FacebookTextTarget, EngineError> {
    let expression = facebook::comment_editor_focus_expression(note_id, select_contents)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::text_target_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_comment_ack(
    session: &mut EngineSession,
    note_id: &str,
    text: &str,
    account_id: &str,
) -> Result<facebook::FacebookCommentAckProbe, EngineError> {
    let expression = facebook::comment_ack_probe_expression(note_id, text, account_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::comment_ack_probe_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_join(
    session: &mut EngineSession,
) -> Result<facebook::FacebookJoinProbe, EngineError> {
    let expression = facebook::join_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::join_probe_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_first_post_group_root(
    session: &mut EngineSession,
) -> Result<facebook::FacebookFirstPostGroupRootProbe, EngineError> {
    let expression = facebook::first_post_group_root_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::first_post_group_root_probe_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_publish_home_snapshot(
    session: &mut EngineSession,
) -> Result<facebook::FacebookPublishHomeProbe, EngineError> {
    let expression = facebook::publish_home_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::publish_home_probe_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_publish_entry(
    session: &mut EngineSession,
) -> Result<facebook::FacebookPointTarget, EngineError> {
    let expression = facebook::publish_entry_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::point_target_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_publish_editor(
    session: &mut EngineSession,
) -> Result<facebook::FacebookTextTarget, EngineError> {
    let expression = facebook::publish_editor_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::text_target_from_cdp(&raw)
}

pub(crate) async fn focus_facebook_publish_editor(
    session: &mut EngineSession,
    select_contents: bool,
) -> Result<facebook::FacebookTextTarget, EngineError> {
    let expression = facebook::publish_editor_focus_expression(select_contents)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::text_target_from_cdp(&raw)
}

pub(crate) async fn probe_bound_facebook_publish_editor(
    session: &mut EngineSession,
    focus: bool,
    select_contents: bool,
) -> Result<facebook::FacebookTextTarget, EngineError> {
    let expression = facebook::publish_bound_editor_probe_expression(focus, select_contents)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::text_target_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_publish_upload_target(
    session: &mut EngineSession,
) -> Result<facebook::FacebookPointTarget, EngineError> {
    let expression = facebook::publish_upload_target_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::point_target_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_publish_upload_preview(
    session: &mut EngineSession,
    file_name: &str,
) -> Result<facebook::FacebookPointTarget, EngineError> {
    let expression = facebook::publish_upload_preview_probe_expression(file_name)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::point_target_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_publish_submit(
    session: &mut EngineSession,
    bind_target: bool,
) -> Result<facebook::FacebookPublishSubmitProbe, EngineError> {
    let expression = facebook::publish_submit_probe_expression(bind_target)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::publish_submit_probe_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_publish_submitted(
    session: &mut EngineSession,
) -> Result<facebook::FacebookPublishSubmittedProbe, EngineError> {
    let expression = facebook::publish_submitted_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::publish_submitted_probe_from_cdp(&raw)
}

pub(crate) async fn delete_selected_text(session: &mut EngineSession) -> Result<(), EngineError> {
    session
        .cdp
        .dispatch_key("keyDown", "Backspace", "Backspace", 8)
        .await?;
    session
        .cdp
        .dispatch_key("keyUp", "Backspace", "Backspace", 8)
        .await?;
    Ok(())
}

pub(crate) fn normalize_facebook_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 写动作回读的「多出来的字符数」容差。
/// 编辑器会带入零宽字符 / 不间断空格之类的无害残留；超出这个容差就是真被塞了东西
/// （最常见的是打字途中被 typeahead 劫持插入了 @提及），那样的正文 MUST NOT 发出去。
/// 评论侧与发布侧共用同一个取值——两条链路面对的是同一个富文本编辑器。
/// 取值本身仍待真机采样定论（见 change 的真机项 9.8：退役实现取 4 且有成文立论，
/// Native 迁移改成 10 无对应记录；本轮只做收口到一处，不替真机结论下判断）。
pub(crate) const FACEBOOK_TEXT_EXTRA_CHAR_TOLERANCE: usize = 10;

pub(crate) fn facebook_action_result(
    phase: EffectPhase,
    action: &str,
    ok: bool,
    reason: &str,
    note_id: Option<String>,
    observation: Option<crate::model::ActionEvidence>,
) -> (EffectPhase, CommandOutput) {
    (
        phase,
        CommandOutput::ActionReceipt(Box::new(ActionReceipt {
            action: action.to_owned(),
            ok,
            reason: (!reason.is_empty()).then(|| reason.to_owned()),
            note_id,
            observation,
            post_observation: None,
            group_observation: None,
            group_url: None,
            clicked: None,
            candidates: Vec::new(),
            type_report: None,
        })),
    )
}

pub(crate) fn facebook_join_result(
    phase: EffectPhase,
    ok: bool,
    reason: &str,
    clicked: bool,
    observation: crate::model::FacebookGroupJoinObservation,
    post_observation: Option<crate::model::FacebookGroupJoinObservation>,
) -> (EffectPhase, CommandOutput) {
    let group_url = observation.group_url.clone();
    (
        phase,
        CommandOutput::ActionReceipt(Box::new(ActionReceipt {
            action: "join_group".to_owned(),
            ok,
            reason: (!reason.is_empty()).then(|| reason.to_owned()),
            note_id: None,
            observation: None,
            post_observation,
            group_observation: Some(observation),
            group_url,
            clicked: Some(clicked),
            candidates: Vec::new(),
            type_report: None,
        })),
    )
}

pub(crate) fn facebook_publish_result(
    phase: EffectPhase,
    record_id: u64,
    seq: u32,
    kind: &str,
    ok: bool,
    dispatched: bool,
    error: &str,
) -> (EffectPhase, CommandOutput) {
    (
        phase,
        CommandOutput::PublishReceipt(
            PublishReceipt {
                record_id,
                seq,
                kind: kind.to_owned(),
                ok,
                submit_dispatched: (kind == "submit").then_some(dispatched),
                value: None,
                post_url: None,
                error: (!error.is_empty()).then(|| error.to_owned()),
            }
            .bounded(),
        ),
    )
}

pub(crate) async fn enter_facebook_commit_window(
    command: &NativeCommand,
    requester: &CommitWindowRequester,
    deadline_unix_ms: u64,
    cancellation: Option<&AtomicBool>,
) -> Result<(), EngineError> {
    let contract = facebook::capability::parity(command)
        .and_then(|entry| entry.commit_window)
        .ok_or_else(|| {
            EngineError::new(
                ErrorCode::EngineInternal,
                "native Facebook irreversible write has no commit window contract",
            )
        })?;
    requester
        .enter(contract.label, deadline_unix_ms, cancellation)
        .await
}

pub(crate) async fn ensure_facebook_action_gate(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<Option<CommandOutput>, EngineError> {
    ensure_facebook_action_gate_inner(session, command, None).await
}

pub(crate) async fn ensure_facebook_group_join_action_gate(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<Option<CommandOutput>, EngineError> {
    ensure_facebook_action_gate_inner(
        session,
        command,
        Some((
            "action_gate_page_probe",
            "action_gate_consent_probe",
            "action_gate_result",
        )),
    )
    .await
}

async fn ensure_facebook_action_gate_inner(
    session: &mut EngineSession,
    command: &NativeCommand,
    operation_stages: Option<(&'static str, &'static str, &'static str)>,
) -> Result<Option<CommandOutput>, EngineError> {
    let probe = probe_facebook_page(session)
        .await
        .map_err(|error| annotate_operation(error, operation_stages.map(|stages| stages.0)))?;
    let reason = match probe.blocking_kind.as_deref() {
        Some("login") => Some("login_required"),
        Some("captcha") => Some("blocked_by_captcha"),
        Some("unknown") => Some("blocked_by_unknown"),
        _ => None,
    };
    if let Some(reason) = reason {
        return facebook_gate_failure(session, command, reason)
            .map(Some)
            .map_err(|error| annotate_operation(error, operation_stages.map(|stages| stages.2)));
    }

    let mut attempts = 0_u32;
    while attempts < FACEBOOK_CONSENT_MAX_ATTEMPTS {
        let consent = match probe_facebook_consent(session).await {
            Ok(consent) => consent,
            // 一次都还没动过页面就探测失败：既不假设有同意条、也不假成功——
            // 当作「无同意条」让既有闸继续处置。把错误上抛会让整条命令变成引擎错误，
            // 等于把一次探测抖动升级成动作失败。
            Err(_) if attempts == 0 => return Ok(None),
            // 已经点过接受按钮了，复探却读不回来：这一次**不知道**横幅清没清掉。
            // 照旧放行等于拿「不知道」冒充「已清掉」，而且从回执上看与「压根没探到同意条」
            // 一模一样——退役实现在这一档同样停手（consent.ts 的 re-probe failed 分支）。
            Err(_) => {
                return facebook_consent_gate_stop(
                    session,
                    command,
                    FacebookConsentGateOutcome {
                        handled: true,
                        cleared: FacebookConsentCleared::Unknown,
                        attempts,
                    },
                    operation_stages,
                );
            }
        };
        if !consent.present {
            // 放行前把这一趟的处理结果交给诊断通道：点过之后横幅确实不见了，
            // 与「这台页面上压根没有同意条」是两件事，MUST NOT 因为都放行就抹平。
            report_facebook_consent_gate(
                FacebookConsentGateOutcome {
                    handled: attempts > 0,
                    cleared: if attempts > 0 {
                        FacebookConsentCleared::Confirmed
                    } else {
                        FacebookConsentCleared::NotApplicable
                    },
                    attempts,
                },
                None,
            );
            return Ok(None);
        }
        let necessary_only = matches!(
            std::env::var("AIDCP_FB_COOKIE_CONSENT")
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
                .as_str(),
            "necessary_only" | "necessary" | "essential"
        );
        let point = if necessary_only {
            if consent.necessary_only_ambiguous {
                None
            } else {
                consent.necessary_only
            }
        } else if consent.accept_all_ambiguous {
            None
        } else {
            consent.accept_all
        };
        let Some(point) = point else {
            // 认出了同意条，但**策略所需**的按钮定位不到（文案 / 布局漂移，或同文案按钮不唯一）。
            // 诚实停手：绝不改点另一个按钮。这一档与「点满三次仍清不掉」是两回事——
            // 前者页面没被动过（clicked=false），后者是升级停手（clicked=true）。
            return facebook_consent_gate_stop(
                session,
                command,
                FacebookConsentGateOutcome {
                    handled: true,
                    cleared: FacebookConsentCleared::StillPresent,
                    attempts,
                },
                operation_stages,
            );
        };
        dispatch_facebook_click(session, point.cx, point.cy).await?;
        attempts += 1;
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
    let final_probe = match probe_facebook_consent(session).await {
        Ok(final_probe) => final_probe,
        // 同上：点满上限之后复探读不回来，「不知道清没清掉」不得当成「清掉了」放行。
        Err(_) => {
            return facebook_consent_gate_stop(
                session,
                command,
                FacebookConsentGateOutcome {
                    handled: true,
                    cleared: FacebookConsentCleared::Unknown,
                    attempts,
                },
                operation_stages,
            );
        }
    };
    if final_probe.present {
        // 有界重试到上限仍在——停手升级，绝不静默假成功。
        return facebook_consent_gate_stop(
            session,
            command,
            FacebookConsentGateOutcome {
                handled: true,
                cleared: FacebookConsentCleared::StillPresent,
                attempts,
            },
            operation_stages,
        );
    }
    report_facebook_consent_gate(
        FacebookConsentGateOutcome {
            handled: true,
            cleared: FacebookConsentCleared::Confirmed,
            attempts,
        },
        None,
    );
    Ok(None)
}

/// 同意条的有界重试上限。到顶仍在就停手升级，绝不无限点下去。
const FACEBOOK_CONSENT_MAX_ATTEMPTS: u32 = 3;

/// 同意闸这一趟的处理结果，三格与退役实现 `src/facebook/consent.ts` 的
/// `handled / cleared / attempts` 一一对应（第四格 `reason` 随停手回执一起给）。
///
/// 它存在的直接理由：闸放行时走的是同一条「无输出」出口，于是
/// 「认出了同意条、点了一次、复探读不回来」与「这台页面上压根没有同意条」
/// 在外面看起来完全一样——三项事实全部消失，真机上无从判断账号到底撞没撞上同意条。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FacebookConsentGateOutcome {
    /// 探到没探到：这一趟有没有认出一条需要处理的同意条。
    handled: bool,
    /// 清没清掉。
    cleared: FacebookConsentCleared,
    /// 点了几次接受按钮。
    attempts: u32,
}

/// 「清没清掉」是四态不是布尔。`Unknown` 与 `StillPresent` 合成一态，
/// 就是把「这一次没读到」说成「读到了坏消息」——同 `FocusGuardVerdict` 的三态口径。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FacebookConsentCleared {
    /// 复探确认横幅已经不在了。
    Confirmed,
    /// 复探确认横幅仍在。
    StillPresent,
    /// 点过之后复探失败：这一次读不到结论，MUST NOT 冒充成上面任何一态。
    Unknown,
    /// 压根没有同意条要清。
    NotApplicable,
}

impl FacebookConsentCleared {
    fn as_str(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::StillPresent => "still_present",
            Self::Unknown => "unknown",
            Self::NotApplicable => "not_applicable",
        }
    }
}

/// 同意闸停手回执 + 观测。原因码保持既有的 `blocked_by_consent`（云端无第二个归宿，
/// 新造原因码只会多一条没人接的字符串）；两档失败靠回执上的「有没有真点过」区分：
/// `clicked=false` = 探到同意条但策略按钮定位不到（可诊断的文案 / 布局漂移，页面未被动过）；
/// `clicked=true` = 点过仍未清掉（含「复探读不回来、这一次不知道清没清掉」）。
///
/// 回执只放得下这一位；`attempts` 与「清没清掉」的四态另走诊断通道——
/// 往回执上加新字段属协议载荷改动（两份 `protocol.ts` + `model.rs` 须同批），不在本条范围内。
fn facebook_consent_gate_stop(
    session: &EngineSession,
    command: &NativeCommand,
    outcome: FacebookConsentGateOutcome,
    operation_stages: Option<(&'static str, &'static str, &'static str)>,
) -> Result<Option<CommandOutput>, EngineError> {
    report_facebook_consent_gate(outcome, Some("blocked_by_consent"));
    let mut output = facebook_gate_failure(session, command, "blocked_by_consent")
        .map_err(|error| annotate_operation(error, operation_stages.map(|stages| stages.2)))?;
    if let CommandOutput::ActionReceipt(receipt) = &mut output {
        receipt.clicked = Some(outcome.attempts > 0);
    }
    Ok(Some(output))
}

fn report_facebook_consent_gate(outcome: FacebookConsentGateOutcome, reason: Option<&str>) {
    // 绝大多数命令根本不会撞上同意条，逐条打日志只会把真正撞上的那几条淹掉。
    if !outcome.handled {
        return;
    }
    let diagnostic = facebook_consent_gate_diagnostic(outcome, reason);
    eprintln!("native_page_engine_facebook_consent_gate:{diagnostic}");
}

fn facebook_consent_gate_diagnostic(
    outcome: FacebookConsentGateOutcome,
    reason: Option<&str>,
) -> String {
    serde_json::json!({
        "handled": outcome.handled,
        "cleared": outcome.cleared.as_str(),
        "attempts": outcome.attempts,
        "reason": reason,
    })
    .to_string()
}

fn annotate_operation(error: EngineError, operation_stage: Option<&'static str>) -> EngineError {
    match operation_stage {
        Some(operation_stage) => error.with_operation_stage(operation_stage),
        None => error,
    }
}

pub(crate) async fn probe_facebook_page(
    session: &mut EngineSession,
) -> Result<ProbeResult, EngineError> {
    let expression = facebook::page_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = facebook::result_from_cdp(&raw)?;
    let command = NativeCommand::PageProbe(crate::command::EmptyParams::default());
    let output = facebook::typed_output(&command, result.output, session.cdp.target_id())?;
    let CommandOutput::PageProbe(probe) = output else {
        return Err(EngineError::new(
            ErrorCode::ProbeFailed,
            "native Facebook blocker probe returned an invalid output",
        ));
    };
    Ok(probe)
}

pub(crate) async fn probe_facebook_consent(
    session: &mut EngineSession,
) -> Result<facebook::FacebookConsentProbe, EngineError> {
    let expression = facebook::consent_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::consent_probe_from_cdp(&raw)
}

pub(crate) fn facebook_gate_failure(
    session: &EngineSession,
    command: &NativeCommand,
    reason: &str,
) -> Result<CommandOutput, EngineError> {
    facebook::failure_output(
        command,
        facebook_action_name(command),
        reason,
        session.cdp.target_id(),
    )
}

pub(crate) fn facebook_command_requires_gate(command: &NativeCommand) -> bool {
    !matches!(
        command,
        NativeCommand::PageProbe(_)
            | NativeCommand::SessionStop(_)
            | NativeCommand::IdentityBootstrap(_)
            | NativeCommand::IdentityReadCurrent(_)
            | NativeCommand::CaptchaCapture(_)
            | NativeCommand::CaptchaClick(_)
    )
}

pub(crate) fn facebook_action_name(command: &NativeCommand) -> &'static str {
    match command {
        NativeCommand::BrowseNext(_)
        | NativeCommand::BrowseScroll(_)
        | NativeCommand::PageScroll(_) => "scroll",
        NativeCommand::FeedRefresh(_) => "refresh",
        NativeCommand::SearchExecute(_) => "search",
        NativeCommand::NoteOpen(_) => "open_note",
        NativeCommand::NoteClose(_) => "close",
        NativeCommand::NavigationBack(_) => "back",
        NativeCommand::InteractionLike(_) => "like",
        NativeCommand::InteractionFollow(_) => "follow",
        NativeCommand::InteractionComment(_) => "comment",
        NativeCommand::GroupJoin(_) => "join_group",
        NativeCommand::PublishNavigateEntry(_) => "navigate_entry",
        NativeCommand::PublishSelectMode(_) => "select_mode",
        NativeCommand::PublishUploadImage(_) => "upload_image",
        NativeCommand::PublishSetCover(_) => "set_cover",
        NativeCommand::PublishFillField(_) => "fill_field",
        NativeCommand::PublishAddWithCandidate(_) => "add_with_candidate",
        NativeCommand::PublishSetOption(_) => "set_option",
        NativeCommand::PublishSetSchedule(_) => "set_schedule",
        NativeCommand::PublishSubmit(_) => "submit",
        NativeCommand::PublishCapturePostId(_) => "capture_post_id",
        NativeCommand::PublishCaptureScheduled(_) => "capture_scheduled",
        NativeCommand::PublishReconcileScheduled(_) => "reconcile_scheduled",
        _ => "page",
    }
}

pub(crate) async fn evaluate_facebook_router(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if facebook_command_requires_gate(command)
        && let Some(output) = ensure_facebook_action_gate(session, command).await?
    {
        return Ok((EffectPhase::NotStarted, output));
    }
    let expression = facebook::command_expression(command)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = facebook::result_from_cdp(&raw)?;
    let output = facebook::typed_output(command, result.output, session.cdp.target_id())?;
    Ok((result.effect_phase, output))
}

pub(crate) async fn evaluate_facebook_first_post_router(
    session: &mut EngineSession,
    command: &NativeCommand,
    group_url: &Url,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if facebook_command_requires_gate(command)
        && let Some(output) = ensure_facebook_action_gate(session, command).await?
    {
        return Ok((EffectPhase::NotStarted, output));
    }
    let expression = facebook::first_post_command_expression(command, group_url)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = facebook::result_from_cdp(&raw)?;
    let output = facebook::typed_output(command, result.output, session.cdp.target_id())?;
    Ok((result.effect_phase, output))
}

pub(crate) async fn evaluate_facebook_router_until_requested_detail(
    session: &mut EngineSession,
    command: &NativeCommand,
    target_post_id: &str,
    timeout: Duration,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let latest = evaluate_facebook_router(session, command).await?;
        if matches!(
            &latest.1,
            CommandOutput::NoteDetail(detail)
                if canonical_facebook_post_id(&detail.note_id).as_deref() == Some(target_post_id)
        ) {
            return Ok(latest);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(EngineError::new(
                ErrorCode::ProbeFailed,
                "native Facebook target detail identity was not confirmed",
            ));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// 文档就绪等待。**判据只有文档状态，不含任何地址判据** —— 这是刻意的：
/// 它有十几个调用点（feed / session / runtime），各自跳向互不相同的目的地，
/// 给它加「必须落到某个地址」会一次性改写全部调用方的语义。
/// 需要「确认落到某个地址」的路径请用各自的专用等待
/// （群根见 `wait_for_facebook_group_root_landing`）。
pub(crate) async fn wait_for_facebook_ready(
    session: &mut EngineSession,
    timeout: Duration,
) -> Result<(), EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let expression = facebook::page_probe_expression()?;
        let raw = session.cdp.evaluate(&expression, true).await?;
        let result = facebook::result_from_cdp(&raw)?;
        let ready = result
            .output
            .pointer("/value/readyState")
            .and_then(serde_json::Value::as_str);
        if matches!(ready, Some("interactive" | "complete")) {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(EngineError::new(
                ErrorCode::ProbeFailed,
                "native Facebook navigation did not reach a ready document",
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// 群根落地确认窗（change restore-facebook-first-post-recovery）。
///
/// 只覆盖「地址换过来」这一件事，比内容水合快得多，10s 已经很宽。
/// 抬高它前先算首帖命令的外层原子上限还剩多少余量
/// （`src/native-page-engine/browse-session.ts` 的 `FACEBOOK_FIRST_POST_OPEN_TIMEOUT_MS` = 135s）：
/// 只放宽内层而不抬外层，等于把边端一个具名失败改判成外层合成失败。
pub(crate) const FACEBOOK_GROUP_ROOT_LANDING_TIMEOUT: Duration = Duration::from_secs(10);

/// 「跳转真的落地了吗」的纯判据。
///
/// 只有两条，且都是**落地必需**的，MUST NOT 借机塞姿态项
/// （带不带查询串、水合完没完、区域划不划得清都各有归属，塞进来就是把一次可恢复的抖动变成终局）：
/// ① 文档就绪；② 当前地址就是请求的那个群根。
///
/// 读数刻意取自页面基础探测（就绪等待用的同一个），**不用群根复用探测**：
/// 后者是「这一页能不能直接复用」那个决策的读数，两件事共用一个读数会让「决策做了几次」
/// 与「等了几轮」在观测上分不开。
pub(crate) fn facebook_group_root_landed(
    origin: Option<&str>,
    path: Option<&str>,
    ready_state: Option<&str>,
    group_url: &Url,
) -> bool {
    if !matches!(ready_state, Some("interactive" | "complete")) {
        return false;
    }
    if origin != Some(group_url.origin().ascii_serialization().as_str()) {
        return false;
    }
    let Some(path) = path else {
        return false;
    };
    let observed = facebook_path_parts(path);
    let expected = facebook_path_parts(group_url.path());
    observed.len() == 2
        && expected.len() == 2
        && observed[0].eq_ignore_ascii_case(expected[0])
        && observed[1].eq_ignore_ascii_case(expected[1])
}

fn facebook_path_parts(path: &str) -> Vec<&str> {
    path.split('/').filter(|part| !part.is_empty()).collect()
}

async fn probe_facebook_group_root_landing(
    session: &mut EngineSession,
    group_url: &Url,
) -> Result<bool, EngineError> {
    let expression = facebook::page_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = facebook::result_from_cdp(&raw)?;
    Ok(facebook_group_root_landed(
        result
            .output
            .pointer("/value/origin")
            .and_then(serde_json::Value::as_str),
        result
            .output
            .pointer("/value/path")
            .and_then(serde_json::Value::as_str),
        result
            .output
            .pointer("/value/readyState")
            .and_then(serde_json::Value::as_str),
        group_url,
    ))
}

/// 群根导航的落地等待。
///
/// 导航是「发出即返回」的（`cdp.rs` 的 `navigate` 只把命令送出去，不等新文档接管），
/// 新文档接管之前**上一页仍然是 ready 的** —— 只看文档就绪的等待会瞬间通过，
/// 于是后面每一道检查都跑在上一页上，一次「上一段任务把浏览器留在同群某条帖详情页」的衔接
/// 就会让评论落到陌生人的帖子下。
///
/// 返回 `Ok(false)` = 有界窗口内没确认落地。**这不是终局**，由调用方按姿态类处置。
pub(crate) async fn wait_for_facebook_group_root_landing(
    session: &mut EngineSession,
    group_url: &Url,
    timeout: Duration,
    cancellation: Option<&AtomicBool>,
) -> Result<bool, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if facebook_command_cancelled(cancellation) {
            return Err(cancelled_before_dispatch());
        }
        // 换页途中旧执行上下文会被销毁、探测会报错。那是「还没落地」而非失败：
        // 照 `?` 抛出去等于把一次正常的换页判成终局。
        if probe_facebook_group_root_landing(session, group_url)
            .await
            .unwrap_or(false)
        {
            return Ok(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

pub(crate) async fn verify_facebook_uploaded_preview(
    session: &mut EngineSession,
    record_id: u64,
    seq: u32,
    file_name: &str,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let remaining = Duration::from_millis(deadline_unix_ms.saturating_sub(unix_time_ms()));
    let deadline =
        tokio::time::Instant::now() + remaining.min(FACEBOOK_PUBLISH_UPLOAD_VERIFY_TIMEOUT);
    loop {
        let preview = probe_facebook_publish_upload_preview(session, file_name).await?;
        if preview.ok {
            return Ok(facebook_publish_result(
                EffectPhase::Confirmed,
                record_id,
                seq,
                "upload_image",
                true,
                true,
                "",
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(facebook_publish_result(
                EffectPhase::Ambiguous,
                record_id,
                seq,
                "upload_image",
                false,
                true,
                preview
                    .reason
                    .as_deref()
                    .unwrap_or("media_preview_unconfirmed"),
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// 内容派生的会话内帖子引用前缀（change generalize-facebook-content-derived-post-identity）。
/// 前缀是历史命名（当初只服务群组首帖），语义已是「内容派生的会话内帖子引用」；
/// 不改名是刻意取舍——云端评论链路按它匹配，改名会失配。
pub(crate) const FACEBOOK_CONTENT_REF_PREFIX: &str = "aidcp:facebook-group-feed-post:v1:";

/// 这个 noteId 是不是内容派生的会话内引用。
///
/// 它**不是地址**：没有平台永久链接，导航 / 打开详情 / 定向评论结构性做不到。
/// 判定严格到摘要长度与字符集——形似而不合格的值一律不算，走既有的诚实失败。
pub(crate) fn is_facebook_content_ref(value: &str) -> bool {
    value
        .strip_prefix(FACEBOOK_CONTENT_REF_PREFIX)
        .is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

pub(crate) fn validated_facebook_content_url(
    raw: &str,
    expected: Option<&str>,
) -> Result<Url, EngineError> {
    let url = Url::parse(raw).map_err(|_| invalid_facebook_navigation_target())?;
    validate_facebook_origin(&url)?;
    let path = url.path().to_ascii_lowercase();
    let is_content = path.contains("/posts/")
        || path.contains("/videos/")
        || path.starts_with("/reel/")
        || path.contains("/permalink.php")
        || path.starts_with("/groups/")
        || url
            .query_pairs()
            .any(|(key, _)| matches!(key.as_ref(), "story_fbid" | "multi_permalinks" | "v"));
    if !is_content || expected.is_some_and(|value| value != raw && !raw.contains(value)) {
        return Err(invalid_facebook_navigation_target());
    }
    Ok(url)
}

pub(crate) fn canonical_facebook_post_id(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    validate_facebook_origin(&url).ok()?;
    let path = url.path().to_ascii_lowercase();
    let query_id = url
        .query_pairs()
        .find_map(|(key, value)| match key.as_ref() {
            "multi_permalinks" | "story_fbid" => Some(value.into_owned()),
            "v" if path == "/watch" || path == "/watch/" => Some(value.into_owned()),
            _ => None,
        })
        .filter(|value| !value.is_empty());
    if query_id.is_some() {
        return query_id;
    }
    let segments: Vec<_> = url
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect();
    for (index, segment) in segments.iter().enumerate() {
        if matches!(
            segment.to_ascii_lowercase().as_str(),
            "posts" | "videos" | "reel" | "permalink"
        ) {
            return segments
                .get(index + 1)
                .filter(|value| !value.is_empty())
                .map(|value| (*value).to_owned());
        }
    }
    None
}

pub(crate) fn is_facebook_reel_url(raw: &str) -> bool {
    Url::parse(raw)
        .ok()
        .filter(|url| validate_facebook_origin(url).is_ok())
        .is_some_and(|url| url.path().to_ascii_lowercase().starts_with("/reel/"))
}

pub(crate) fn validated_facebook_group_url(raw: &str) -> Result<Url, EngineError> {
    let url = Url::parse(raw).map_err(|_| invalid_facebook_navigation_target())?;
    validate_facebook_origin(&url)?;
    let parts: Vec<_> = url
        .path_segments()
        .map(|segments| segments.filter(|segment| !segment.is_empty()).collect())
        .unwrap_or_default();
    if parts.first() != Some(&"groups") || parts.get(1).is_none_or(|value| value.is_empty()) {
        return Err(invalid_facebook_navigation_target());
    }
    Url::parse(&format!("https://www.facebook.com/groups/{}", parts[1]))
        .map_err(|_| invalid_facebook_navigation_target())
}

pub(crate) fn validated_facebook_search_url(raw: &str, keyword: &str) -> Result<Url, EngineError> {
    let url = Url::parse(raw).map_err(|_| invalid_facebook_navigation_target())?;
    validate_facebook_origin(&url)?;
    let parts: Vec<_> = url
        .path_segments()
        .map(|segments| segments.filter(|segment| !segment.is_empty()).collect())
        .unwrap_or_default();
    let path = if parts.first() == Some(&"groups") {
        let group = parts
            .get(1)
            .filter(|value| !value.is_empty())
            .ok_or_else(invalid_facebook_navigation_target)?;
        format!("/groups/{group}/search/")
    } else if parts.len() == 1 {
        format!("/{}/search/", parts[0])
    } else {
        return Err(invalid_facebook_navigation_target());
    };
    let mut target =
        Url::parse("https://www.facebook.com").map_err(|_| invalid_facebook_navigation_target())?;
    target.set_path(&path);
    target.query_pairs_mut().append_pair("q", keyword);
    Ok(target)
}

pub(crate) fn validate_facebook_origin(url: &Url) -> Result<(), EngineError> {
    let host = url
        .host_str()
        .ok_or_else(invalid_facebook_navigation_target)?;
    if url.scheme() != "https"
        || !(host == "facebook.com" || host.ends_with(".facebook.com"))
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid_facebook_navigation_target());
    }
    Ok(())
}

pub(crate) fn invalid_facebook_navigation_target() -> EngineError {
    EngineError::new(
        ErrorCode::InvalidRequest,
        "native navigation target is not an allowlisted Facebook page",
    )
}

pub(crate) async fn dispatch_facebook_click(
    session: &mut EngineSession,
    x: f64,
    y: f64,
) -> Result<(), EngineError> {
    dispatch_facebook_click_with(session, x, y, PointerClickOptions::default())
        .await
        .map(|_| ())
}

/// 带形状的点击出口：调用方可指定起步点与是否允许过冲，其余与两参形态等价。
/// 返回**真实落点**，供多点循环把上一落点当作下一点的起步点（保光标连续）。
pub(crate) async fn dispatch_facebook_click_with(
    session: &mut EngineSession,
    x: f64,
    y: f64,
    options: PointerClickOptions,
) -> Result<PointerPoint, EngineError> {
    // 说明：Facebook 的点击调用点目前拿不到取消信号与绝对截止（它们止步于命令分发层，
    // 而那几个文件不在本次改动面内），故此处传 None / 无截止；原语内部的取消与截止检查仍
    // 全部落在按下之前，按下 / 抬起配平不受影响。
    dispatch_pointer_click(&mut session.cdp, x, y, options, None, u64::MAX)
        .await
        .map_err(pointer_failure_to_engine_error)
}

pub(crate) fn pointer_failure_to_engine_error(failure: PointerInputFailure) -> EngineError {
    match failure {
        PointerInputFailure::CancelledBeforePress => cancelled_before_dispatch(),
        PointerInputFailure::DeadlineBeforePress => EngineError::new(
            ErrorCode::CdpTimeout,
            "native pointer click exceeded its deadline before the submit press",
        ),
        PointerInputFailure::MoveFailed(error) => error,
        // 诚实红线：按下已经派发出去了，点击可能已生效。绝不能让上游把它读成「压根没点」而重投。
        //
        // 错误码原样继承底层 CDP 失败（诊断需要），**但有一条例外**：命令层认一小撮错误码为
        // 「未开始 ＝ 可安全重投」（`error_code_means_not_started`）。一个已经派发出去的提交
        // 若碰巧戴上其中一顶帽子，下面那句文案再明确也没用 —— 云端读的是相位字段，
        // 它会看到「未开始」，然后重投。这条转译在**两个文件**里各判一次，
        // 所以判据必须按引用取用，不许再抄一份。
        PointerInputFailure::SubmitDispatched(error) => EngineError::new(
            if error_code_means_not_started(error.code) {
                ErrorCode::CdpError
            } else {
                error.code
            },
            "native pointer submit press was already dispatched before the failure; the click may have taken effect and MUST NOT be replayed as not started",
        ),
    }
}

pub(crate) fn facebook_scroll_failure(
    phase: EffectPhase,
    reason: &str,
) -> (EffectPhase, CommandOutput) {
    facebook_scroll_failure_on_surface(phase, reason, None)
}

/// 带列表面观测的滚动失败回执。「本批看完」的处置在首页与小组页 / 搜索页上并不相同，
/// 云端要按面分流就必须知道这条回执来自哪个面。不新增协议字段——复用既有观测里的面别位。
pub(crate) fn facebook_scroll_failure_on_surface(
    phase: EffectPhase,
    reason: &str,
    surface: Option<&str>,
) -> (EffectPhase, CommandOutput) {
    (
        phase,
        CommandOutput::ActionReceipt(Box::new(ActionReceipt {
            action: "scroll".to_owned(),
            ok: false,
            reason: Some(reason.to_owned()),
            note_id: None,
            observation: surface.filter(|value| !value.is_empty()).map(|value| {
                crate::model::ActionEvidence {
                    surface: Some(value.to_owned()),
                    list_key: None,
                    author: None,
                    text_preview_head: None,
                    reaction_text: None,
                    article_index: None,
                }
            }),
            post_observation: None,
            group_observation: None,
            group_url: None,
            clicked: None,
            candidates: Vec::new(),
            type_report: None,
        })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 已派发的提交失败 MUST NOT 带上「命令层等同于未开始」的错误码 —— 不管底层 CDP
    /// 失败自称是什么。判据按引用取用（`error_code_means_not_started`），不是抄一份码表：
    /// 抄一份的话，往那张表里新增一个码时这里不会有任何提示，缝会静默重新裂开。
    #[test]
    fn a_dispatched_submit_failure_never_wears_a_replayable_error_code() {
        for code in [ErrorCode::Cancelled, ErrorCode::CommitWindowUnavailable] {
            assert!(
                error_code_means_not_started(code),
                "这一场的前提是 {code:?} 确实在那张表里，否则它什么也没证明",
            );
            let translated =
                pointer_failure_to_engine_error(PointerInputFailure::SubmitDispatched(
                    EngineError::new(code, "underlying cdp failure"),
                ));
            assert!(
                !error_code_means_not_started(translated.code),
                "已派发的提交失败被译成了 {:?} —— 上游会当成压根没点而重投",
                translated.code,
            );
        }
    }

    /// 反向那一半：不在表里的错误码必须原样保留，否则诊断会被抹平成一个笼统的码。
    #[test]
    fn a_dispatched_submit_failure_keeps_a_diagnosable_error_code() {
        let translated = pointer_failure_to_engine_error(PointerInputFailure::SubmitDispatched(
            EngineError::new(ErrorCode::CdpTimeout, "underlying cdp failure"),
        ));
        assert_eq!(translated.code, ErrorCode::CdpTimeout);
    }

    /// 「探到了但没清掉」与「压根没探到」在**观测通道**上必须是两条不同的读数。
    /// 它们在闸里走的是同一条放行出口，只有这三格写下来才分得开。
    #[test]
    fn a_handled_banner_and_a_page_without_one_are_different_readings() {
        let handled = facebook_consent_gate_diagnostic(
            FacebookConsentGateOutcome {
                handled: true,
                cleared: FacebookConsentCleared::Unknown,
                attempts: 1,
            },
            Some("blocked_by_consent"),
        );
        let never_seen = facebook_consent_gate_diagnostic(
            FacebookConsentGateOutcome {
                handled: false,
                cleared: FacebookConsentCleared::NotApplicable,
                attempts: 0,
            },
            None,
        );
        assert_ne!(handled, never_seen);
        assert!(handled.contains(r#""handled":true"#));
        assert!(handled.contains(r#""attempts":1"#));
        assert!(never_seen.contains(r#""handled":false"#));
        assert!(never_seen.contains(r#""attempts":0"#));
    }

    /// 「点过之后复探读不回来」与「复探确认横幅仍在」是两件事：
    /// 前者是这一次没读到，后者是读到了坏消息。合成一态就是把不知道说成知道。
    #[test]
    fn an_unreadable_re_probe_is_never_written_down_as_a_confirmed_verdict() {
        for cleared in [
            FacebookConsentCleared::Confirmed,
            FacebookConsentCleared::StillPresent,
            FacebookConsentCleared::NotApplicable,
        ] {
            assert_ne!(cleared.as_str(), FacebookConsentCleared::Unknown.as_str());
        }
        let unknown = facebook_consent_gate_diagnostic(
            FacebookConsentGateOutcome {
                handled: true,
                cleared: FacebookConsentCleared::Unknown,
                attempts: 3,
            },
            Some("blocked_by_consent"),
        );
        assert!(unknown.contains(r#""cleared":"unknown""#));
        assert!(unknown.contains(r#""attempts":3"#));
    }

    /// task 5.1 —— 陈旧就绪文档不算落地。
    ///
    /// 导航发出即返回，新文档接管前上一页仍然 `complete`。若落地判据只看文档状态，
    /// 「还站在上一段任务留下的同群某条帖详情页上」这一幕会**瞬间**通过，
    /// 后面每一道检查都跑在上一页上。
    #[test]
    fn a_ready_document_on_the_previous_page_is_never_landing_evidence() {
        let group = validated_facebook_group_url("https://www.facebook.com/groups/945390701793119")
            .expect("group");
        let origin = Some("https://www.facebook.com");

        // 上一页：同一个群的某条帖详情页，文档已经 complete。
        assert!(!facebook_group_root_landed(
            origin,
            Some("/groups/945390701793119/posts/7"),
            Some("complete"),
            &group,
        ));

        // 别的群的群根同样不算落地（地址判据必须比到群号）。
        assert!(!facebook_group_root_landed(
            origin,
            Some("/groups/42"),
            Some("complete"),
            &group,
        ));

        // 地址对了但文档还没就绪 —— 也不算落地。
        assert!(!facebook_group_root_landed(
            origin,
            Some("/groups/945390701793119"),
            Some("loading"),
            &group,
        ));

        // 读不出地址时不得当作落地（读不到 MUST NOT 判成「就是那一页」）。
        assert!(!facebook_group_root_landed(
            origin,
            None,
            Some("complete"),
            &group
        ));

        // 正常落地：地址已换到请求的群根且文档就绪。尾斜杠与大小写不参与判定。
        assert!(facebook_group_root_landed(
            origin,
            Some("/groups/945390701793119"),
            Some("interactive"),
            &group,
        ));
        assert!(facebook_group_root_landed(
            origin,
            Some("/groups/945390701793119/"),
            Some("complete"),
            &group,
        ));
    }
}
