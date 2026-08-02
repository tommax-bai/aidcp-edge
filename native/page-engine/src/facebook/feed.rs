use super::reels::{
    execute_facebook_page_scroll, finish_facebook_reel_transition, probe_facebook_reel,
};
use super::shared::*;
use crate::command::{NoteOpenParams, NotePurpose, NoteSurface};
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::input::{WheelInputFailure, dispatch_wheel_humanized};
use crate::model::{PageCard, PageCards, PageMovement, PostIdentityKind};
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

/// 就地读回落判据：只认页面规则脚本发出的那条具名终态，MUST NOT 按 ok=false 泛化——
/// `target_not_found` / `expand_no_effect` 都是终局，回落导航救不了，救了反而变成
/// 「读不到就换个页面读点别的回来」的假成功。
fn facebook_inline_read_context_changed(output: &CommandOutput) -> bool {
    matches!(
        output,
        CommandOutput::ActionReceipt(receipt)
            if receipt.action == "open_note"
                && !receipt.ok
                && receipt.reason.as_deref() == Some("context_changed")
    )
}

const FACEBOOK_FEED_RECOVERY_TIMEOUT: Duration = Duration::from_secs(12);
/// 恢复等待必须给「把诚实回执交出去」留出的余量。
///
/// 这一层是本 change 的核心命题在小尺度上的复现：**外层原子上限先到点，会把一个具名回执
/// （feed_recovery_navigation_unconfirmed）改判成信息量更低的合成 CdpTimeout。**
/// 250ms 只够无争用时的一次返回；机器有负载时（并发跑测试、生产上多环境并行）光调度抖动
/// 就能吃掉它，于是「偶发」退化成合成失败。取 1s：相对 8s 恢复窗仍是小头，却扛得住抖动。
const FACEBOOK_FEED_RECOVERY_RECEIPT_MARGIN: Duration = Duration::from_millis(1_000);

fn facebook_reels_entry_reason(reason: Option<&str>) -> bool {
    matches!(
        reason,
        Some("facebook_reels_primary") | Some("empty_feed_reels_fallback")
    )
}

pub(crate) async fn execute(
    session: &mut EngineSession,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    match command {
        NativeCommand::BrowseScroll(params) if params.reason.as_deref() == Some("initial_scan") => {
            execute_facebook_initial_feed(session, cancellation, deadline_unix_ms).await
        }
        NativeCommand::NoteOpen(params)
            if params.purpose == Some(crate::command::NotePurpose::Navigate) =>
        {
            execute_facebook_note_navigation(session, params, command).await
        }
        NativeCommand::SearchExecute(params) if params.container.is_some() => {
            execute_facebook_search(session, params, command, cancellation, deadline_unix_ms).await
        }
        NativeCommand::NoteOpen(params) if params.url.is_some() => {
            let url = validated_facebook_content_url(
                params.url.as_deref().unwrap_or_default(),
                params.note_id.as_deref(),
            )?;
            let target_post_id = canonical_facebook_post_id(url.as_str())
                .ok_or_else(invalid_facebook_navigation_target)?;
            session.cdp.navigate(url.as_str()).await?;
            wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
            evaluate_facebook_router_until_requested_detail(
                session,
                command,
                &target_post_id,
                FACEBOOK_DETAIL_HYDRATION_TIMEOUT,
            )
            .await
        }
        // feed 面就地读：页内展开与校验归页面规则脚本，**只有环境变化后的导航回落归这里**。
        // 脚本没法诚实地自己跳转（跳走后它的执行上下文即刻失效，回执发不出去），且导航必须过
        // URL 白名单校验与就绪等待——这两样都是本层的既有职责。
        NativeCommand::NoteOpen(params)
            if params.surface == Some(NoteSurface::Feed) && params.url.is_none() =>
        {
            let latest = evaluate_facebook_router(session, command).await?;
            if !facebook_inline_read_context_changed(&latest.1) {
                return Ok(latest);
            }
            let Some(note_id) = params.note_id.clone() else {
                return Ok(latest);
            };
            // 会话内引用没有平台地址，导航回落**结构性做不到**
            // （change generalize-facebook-content-derived-post-identity）。
            // 此刻必须把就地读那条具名回执（context_changed）如实交出去：拿一次必然失败的地址校验
            // 去换一个信息量更低的合成错误，等于把「换页了、这一条没读成」抹成「命令非法」。
            // 更不许猜地址去跳——那是把静默假成功换了个位置。
            if is_facebook_content_ref(&note_id) {
                return Ok(latest);
            }
            let url = validated_facebook_content_url(note_id.as_str(), Some(note_id.as_str()))?;
            let target_post_id = canonical_facebook_post_id(url.as_str())
                .ok_or_else(invalid_facebook_navigation_target)?;
            let detail_command = NativeCommand::NoteOpen(NoteOpenParams {
                note_id: Some(note_id.clone()),
                url: Some(url.to_string()),
                surface: Some(NoteSurface::Detail),
                purpose: Some(NotePurpose::Read),
                ..NoteOpenParams::default()
            });
            session.cdp.navigate(url.as_str()).await?;
            wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
            match evaluate_facebook_router_until_requested_detail(
                session,
                &detail_command,
                &target_post_id,
                FACEBOOK_DETAIL_HYDRATION_TIMEOUT,
            )
            .await
            {
                Ok(result) => Ok(result),
                // 回落也没读成：诚实具名失败，MUST NOT 退回就地读那条不可信的读数当成功。
                Err(error) if error.code == ErrorCode::ProbeFailed => Ok(facebook_action_result(
                    EffectPhase::NotStarted,
                    "open_note",
                    false,
                    "inline_fallback_detail_unconfirmed",
                    Some(note_id),
                    None,
                )),
                Err(error) => Err(error),
            }
        }
        NativeCommand::PageScroll(params)
            if facebook_reels_entry_reason(params.reason.as_deref()) =>
        {
            execute_facebook_reels_entry(session, command).await
        }
        NativeCommand::PageScroll(_) => {
            execute_facebook_page_scroll(session, command, cancellation, deadline_unix_ms).await
        }
        NativeCommand::FeedRefresh(_) => execute_facebook_feed_refresh(session).await,
        NativeCommand::NoteClose(_) | NativeCommand::NavigationBack(_) => {
            execute_facebook_back_to_list(session).await
        }
        NativeCommand::BrowseNext(_)
        | NativeCommand::BrowseScroll(_)
        | NativeCommand::SearchExecute(_)
        | NativeCommand::NoteOpen(_) => evaluate_facebook_router(session, command).await,
        _ => Err(EngineError::new(
            ErrorCode::EngineInternal,
            "native Facebook Feed capability received another owner's command",
        )),
    }
}

async fn execute_facebook_reels_entry(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let initial_page = probe_facebook_page(session).await?;
    if let Some(output) = facebook_reels_entry_blocker(session, command, &initial_page).await? {
        return Ok((EffectPhase::NotStarted, output));
    }

    session
        .cdp
        .navigate("https://www.facebook.com/reels/")
        .await?;
    wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    let first = probe_facebook_reel(session).await?;
    if first.is_reels_surface() {
        return finish_facebook_reel_transition(session, command, &first).await;
    }

    let unchanged_page = probe_facebook_page(session).await?;
    if let Some(output) = facebook_reels_entry_blocker(session, command, &unchanged_page).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    if !facebook_same_page_context(&initial_page, &unchanged_page) {
        return Ok(facebook_scroll_failure(
            EffectPhase::NotStarted,
            "no_target",
        ));
    }

    session.cdp.bring_to_front().await?;
    let after_activation = probe_facebook_reel(session).await?;
    if after_activation.is_reels_surface() {
        return finish_facebook_reel_transition(session, command, &after_activation).await;
    }

    let retry_page = probe_facebook_page(session).await?;
    if let Some(output) = facebook_reels_entry_blocker(session, command, &retry_page).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    if !facebook_same_page_context(&initial_page, &retry_page) {
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            "reels_entry_unconfirmed",
        ));
    }

    session
        .cdp
        .navigate("https://www.facebook.com/reels/")
        .await?;
    wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    let retried = probe_facebook_reel(session).await?;
    if retried.is_reels_surface() {
        return finish_facebook_reel_transition(session, command, &retried).await;
    }
    let final_page = probe_facebook_page(session).await?;
    if let Some(output) = facebook_reels_entry_blocker(session, command, &final_page).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    Ok(facebook_scroll_failure(
        EffectPhase::Ambiguous,
        "reels_entry_unconfirmed",
    ))
}

async fn facebook_reels_entry_blocker(
    session: &mut EngineSession,
    command: &NativeCommand,
    page: &crate::probe::ProbeResult,
) -> Result<Option<CommandOutput>, EngineError> {
    let reason = match page.blocking_kind.as_deref() {
        Some("login") => Some("login_required"),
        Some("captcha") => Some("blocked_by_captcha"),
        Some("unknown") => Some("blocked_by_unknown"),
        _ => None,
    };
    if let Some(reason) = reason {
        return facebook_gate_failure(session, command, reason).map(Some);
    }
    if !matches!(
        page.origin.as_str(),
        "https://www.facebook.com" | "https://facebook.com"
    ) {
        return facebook_gate_failure(session, command, "target_not_found").map(Some);
    }
    let consent = probe_facebook_consent(session).await?;
    if consent.present {
        return facebook_gate_failure(session, command, "blocked_by_consent").map(Some);
    }
    Ok(None)
}

fn facebook_same_page_context(
    initial: &crate::probe::ProbeResult,
    current: &crate::probe::ProbeResult,
) -> bool {
    initial.target_id == current.target_id
        && initial.origin == current.origin
        && initial.path == current.path
}

/// 用途为「导航」的开帖：这条命令要的是**账号真的落在那一页**，不是拿一份详情读物。
/// 迁移后用途字段没人读，命令被当成普通开帖；缺面别参数时页面规则直接把**当前页**的详情
/// 回上去——页面根本没被动过，回执却像是开成功了。后续所有以「已在目标页」为前提的动作
/// 都会打在错的页面上。
async fn execute_facebook_note_navigation(
    session: &mut EngineSession,
    params: &crate::command::NoteOpenParams,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    // Facebook 的 noteId 本身就是规范 permalink；显式 url 优先。
    let requested = params
        .url
        .as_deref()
        .or(params.note_id.as_deref())
        .unwrap_or_default();
    let target = validated_facebook_content_url(requested, params.note_id.as_deref())
        .ok()
        .and_then(|url| canonical_facebook_post_id(url.as_str()).map(|post_id| (url, post_id)));
    let Some((url, expected_post_id)) = target else {
        // 解析不出可导航的规范目标——诚实报「未开始」，绝不退化成读当前页。
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "open_note",
            false,
            "target_not_found",
            params.note_id.clone(),
            None,
        ));
    };
    session.cdp.navigate(url.as_str()).await?;
    wait_for_facebook_ready(session, Duration::from_secs(8)).await?;

    let landed = probe_facebook_feed(session).await?;
    let observation = crate::model::ActionEvidence {
        surface: Some(landed.surface.clone()),
        list_key: None,
        author: None,
        text_preview_head: None,
        reaction_text: None,
        article_index: None,
    };
    // 落地身份由**页面自己**派生，不采信命令里的那一份——否则「导航失败但留在原页」
    // 会被当成成功。
    if canonical_facebook_post_id(&landed.url).as_deref() != Some(expected_post_id.as_str()) {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "open_note",
            false,
            "target_context_mismatch",
            Some(url.to_string()),
            Some(observation),
        ));
    }
    Ok(facebook_action_result(
        EffectPhase::Confirmed,
        "open_note",
        true,
        "",
        Some(url.to_string()),
        Some(observation),
    ))
}

pub(crate) async fn execute_facebook_initial_feed(
    session: &mut EngineSession,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    session.cdp.navigate(FACEBOOK_HOME_URL).await?;
    session.facebook.active_list_url = FACEBOOK_HOME_URL.to_owned();
    session.facebook.seen_post_ids.clear();
    wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    let command = NativeCommand::BrowseScroll(crate::command::ReasonParams {
        reason: Some("initial_scan".to_owned()),
    });
    if let Some(output) = ensure_facebook_action_gate(session, &command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }

    // 采集预算按整条命令算、跨轮共享：滚动命令的原子上限是 30s，判稳本身在零卡屏上就要占掉大半。
    let acquire_deadline = tokio::time::Instant::now() + FACEBOOK_IDENTITY_COMMAND_BUDGET;
    let mut last = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_NAV).await?;
    last = match recover_facebook_feed_prompt(session, last, cancellation, deadline_unix_ms).await?
    {
        FacebookFeedRecovery::Continue(probe) => *probe,
        FacebookFeedRecovery::Failure(phase, reason) => {
            return Ok(facebook_scroll_failure(phase, reason));
        }
    };
    for round in 0..FACEBOOK_FEED_SCROLL_ROUNDS {
        if !last.cards.is_empty() {
            let cards = facebook_page_cards(session, last, false, None);
            return Ok((EffectPhase::Confirmed, CommandOutput::PageCards(cards)));
        }
        if round + 1 >= FACEBOOK_FEED_SCROLL_ROUNDS || last.explicit_empty {
            break;
        }
        dispatch_facebook_feed_wheel(session, &last, cancellation, deadline_unix_ms).await?;
        last = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_IN_PLACE).await?;
        last = acquire_facebook_feed_identities(
            session,
            last,
            acquire_deadline,
            cancellation,
            deadline_unix_ms,
        )
        .await?;
    }

    if facebook_zero_card_terminal(session, &last).await? != FacebookZeroCardTerminal::None {
        let cards = facebook_page_cards(session, last, false, None);
        return Ok((EffectPhase::Confirmed, CommandOutput::PageCards(cards)));
    }
    let reason = if last.loading {
        "feed_still_loading"
    } else {
        "no_target"
    };
    Ok(facebook_scroll_failure(EffectPhase::NotStarted, reason))
}

pub(crate) async fn execute_facebook_search(
    session: &mut EngineSession,
    params: &crate::command::SearchExecuteParams,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let container = params
        .container
        .as_deref()
        .expect("search handler requires a validated container");
    let url = validated_facebook_search_url(container, &params.keyword)?;
    session.cdp.navigate(url.as_str()).await?;
    session.facebook.active_list_url = url.to_string();
    session.facebook.seen_post_ids.clear();
    wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }

    let mut last = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_NAV).await?;
    for round in 0..FACEBOOK_FEED_SCROLL_ROUNDS {
        if !last.cards.is_empty() {
            let mut cards = facebook_page_cards(session, last, false, None);
            if let Some(max_results) = params.max_results.filter(|value| *value > 0) {
                cards.cards.truncate(max_results as usize);
            }
            return Ok((EffectPhase::Confirmed, CommandOutput::PageCards(cards)));
        }
        if last.article_count == 0 && !last.loading {
            let cards = facebook_page_cards(session, last, false, None);
            return Ok((EffectPhase::Confirmed, CommandOutput::PageCards(cards)));
        }
        if round + 1 >= FACEBOOK_FEED_SCROLL_ROUNDS {
            break;
        }
        dispatch_facebook_feed_wheel(session, &last, cancellation, deadline_unix_ms).await?;
        last = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_IN_PLACE).await?;
    }

    Ok(facebook_action_result(
        EffectPhase::Confirmed,
        "search",
        false,
        if last.loading {
            "feed_still_loading"
        } else {
            "search_unavailable"
        },
        None,
        None,
    ))
}

pub(crate) async fn execute_facebook_feed_scroll(
    session: &mut EngineSession,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
    mut foreground_activated: bool,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let expected_list_url = session.facebook.active_list_url.clone();
    ensure_facebook_active_list(session).await?;
    let command = NativeCommand::PageScroll(crate::command::PageScrollParams {
        reason: None,
        dwell_ms: None,
    });
    if let Some(output) = ensure_facebook_action_gate(session, &command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    // 采集预算按整条命令算、跨轮共享（见 FACEBOOK_IDENTITY_COMMAND_BUDGET 的注释：
    // 滚动命令原子上限 30s，零卡屏上判稳本身就要占掉大半，按轮给预算必然撑爆）。
    let acquire_deadline = tokio::time::Instant::now() + FACEBOOK_IDENTITY_COMMAND_BUDGET;
    let mut current = probe_facebook_feed(session).await?;
    current = match recover_facebook_feed_prompt(session, current, cancellation, deadline_unix_ms)
        .await?
    {
        FacebookFeedRecovery::Continue(probe) => *probe,
        FacebookFeedRecovery::Failure(phase, reason) => {
            return Ok(facebook_scroll_failure(phase, reason));
        }
    };
    let start_y = current.scroll_y;
    let initial = current.clone();
    let mut saw_any_card = !current.cards.is_empty();
    let mut validated_card_witness = FacebookValidatedFeedCardWitness::from_probe(&current);

    for _ in 0..FACEBOOK_FEED_SCROLL_ROUNDS {
        let wheel_was_foregrounded = foreground_activated;
        let before = current;
        dispatch_facebook_feed_wheel(session, &before, cancellation, deadline_unix_ms).await?;
        let after = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_IN_PLACE).await?;
        // 采集插在判稳之后、终态判定之前：命中的卡还能按普通卡批上报，来不及的留给后续轮次。
        let after = acquire_facebook_feed_identities(
            session,
            after,
            acquire_deadline,
            cancellation,
            deadline_unix_ms,
        )
        .await?;
        saw_any_card |= !after.cards.is_empty();
        if let Some(witness) = FacebookValidatedFeedCardWitness::from_probe(&after) {
            validated_card_witness = Some(witness);
        }
        let movement = PageMovement {
            before: start_y,
            after: after.scroll_y,
            moved: after.scroll_y != start_y,
            at_bottom: Some(facebook_near_bottom(&after)),
        };
        if facebook_feed_no_movement_recovery_eligible(&initial, &before, &after) {
            if wheel_was_foregrounded {
                return Ok(facebook_scroll_failure(
                    EffectPhase::Ambiguous,
                    "scroll_movement_unconfirmed",
                ));
            }
            session.cdp.bring_to_front().await?;
            foreground_activated = true;
            let refreshed = probe_facebook_feed(session).await?;
            if !facebook_feed_foreground_retry_context_matches(&after, &refreshed) {
                return Ok(facebook_scroll_failure(
                    EffectPhase::Ambiguous,
                    "scroll_movement_unconfirmed",
                ));
            }
            current = refreshed;
            continue;
        }
        let fresh = facebook_page_cards(session, after.clone(), true, Some(movement));
        if !fresh.cards.is_empty() {
            return Ok((EffectPhase::Confirmed, CommandOutput::PageCards(fresh)));
        }

        let grew = facebook_feed_height_grew(&before, &after);
        // 到底确认对**每一个已声明的列表面**开放。首页限定是迁移时新加的：退役实现的滚动逻辑面无关，
        // 小组页 / 搜索结果页照样会滚到底。把它们永远挡在确认之外，滚满轮次后就只剩「找不到目标」这条死胡同。
        if grew || !facebook_near_bottom(&after) || !facebook_list_surface(&after.surface) {
            current = after;
            continue;
        }

        let allow_marker_free_home =
            expected_list_url == FACEBOOK_HOME_URL && after.url == expected_list_url;
        let (confirmation, confirmed) = confirm_facebook_feed_bottom(
            session,
            &after,
            allow_marker_free_home,
            cancellation,
            deadline_unix_ms,
        )
        .await?;
        saw_any_card |= !confirmed.cards.is_empty();
        if let Some(witness) = FacebookValidatedFeedCardWitness::from_probe(&confirmed) {
            validated_card_witness = Some(witness);
        }
        let movement = PageMovement {
            before: start_y,
            after: confirmed.scroll_y,
            moved: confirmed.scroll_y != start_y,
            at_bottom: Some(facebook_near_bottom(&confirmed)),
        };
        let fresh = facebook_page_cards(session, confirmed.clone(), true, Some(movement));
        if !fresh.cards.is_empty() {
            return Ok((EffectPhase::Confirmed, CommandOutput::PageCards(fresh)));
        }
        let has_validated_card_on_confirmed_document = validated_card_witness
            .as_ref()
            .is_some_and(|witness| witness.matches(&confirmed));
        if let Some(reason) = facebook_bottom_completion_reason(
            confirmation,
            has_validated_card_on_confirmed_document,
        ) {
            return Ok(facebook_scroll_failure_on_surface(
                EffectPhase::Confirmed,
                reason,
                Some(confirmed.surface.as_str()),
            ));
        }
        current = confirmed;
    }

    // 轮次耗尽仍无新卡：先走与启动首扫**共用**的零卡证据阶梯，再落原因码分类。
    // 缺这一步就是 2026-07-28 线上 17 分钟空转的成因——裸 no_target 在云端没有归宿，
    // 账号被钉在同一屏，只剩 240s 闲置看门狗每 4 分钟补一次注定同样失败的滚动。
    if facebook_zero_card_terminal(session, &current).await? != FacebookZeroCardTerminal::None {
        let cards = facebook_page_cards(session, current, false, None);
        return Ok((EffectPhase::Confirmed, CommandOutput::PageCards(cards)));
    }

    Ok(facebook_scroll_failure_on_surface(
        EffectPhase::Confirmed,
        facebook_unconfirmed_scroll_reason(saw_any_card, &current),
        Some(current.surface.as_str()),
    ))
}

pub(crate) async fn execute_facebook_back_to_list(
    session: &mut EngineSession,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let target = session.facebook.active_list_url.clone();
    let current = probe_facebook_feed(session).await?;
    if current.url != target || !matches!(current.surface.as_str(), "home" | "search" | "group") {
        session.cdp.navigate(&target).await?;
        wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    }
    let command = NativeCommand::NavigationBack(crate::command::NavigationBackParams {
        reason: None,
        target_page: None,
        dwell_ms: None,
    });
    if let Some(output) = ensure_facebook_action_gate(session, &command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    let probe = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_NAV).await?;
    if probe.cards.is_empty() {
        return Ok(facebook_scroll_failure(
            EffectPhase::NotStarted,
            if probe.loading {
                "feed_still_loading"
            } else {
                "no_feed"
            },
        ));
    }
    let cards = facebook_page_cards(session, probe, false, None);
    Ok((EffectPhase::Confirmed, CommandOutput::PageCards(cards)))
}

pub(crate) async fn execute_facebook_feed_refresh(
    session: &mut EngineSession,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if session.facebook.active_list_url != FACEBOOK_HOME_URL {
        session.cdp.navigate(FACEBOOK_HOME_URL).await?;
        session.facebook.active_list_url = FACEBOOK_HOME_URL.to_owned();
        wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    }
    let command = NativeCommand::FeedRefresh(crate::command::FeedRefreshParams {
        reason: None,
        think_ms: None,
    });
    if let Some(output) = ensure_facebook_action_gate(session, &command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    let before = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_IN_PLACE).await?;
    let before_top = before
        .cards
        .first()
        .and_then(|card| card.note_id.as_deref())
        .and_then(canonical_facebook_post_id);

    let target = probe_facebook_home_target(session).await?;
    let clicked = if target.ok {
        if let (Some(x), Some(y)) = (target.cx, target.cy) {
            dispatch_facebook_click(session, x, y).await?;
            true
        } else {
            false
        }
    } else {
        false
    };
    if !clicked {
        let now = unix_time_ms();
        if session.facebook.last_refresh_reload_at_ms != 0
            && now.saturating_sub(session.facebook.last_refresh_reload_at_ms)
                < FACEBOOK_REFRESH_RELOAD_FLOOR_MS
        {
            return Ok(facebook_scroll_failure(
                EffectPhase::NotStarted,
                target.reason.as_deref().unwrap_or("no_home_link"),
            ));
        }
        session.facebook.last_refresh_reload_at_ms = now;
        session.cdp.reload().await?;
    }
    wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    let after = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_IN_PLACE).await?;
    let after_top = after
        .cards
        .first()
        .and_then(|card| card.note_id.as_deref())
        .and_then(canonical_facebook_post_id);
    if after.cards.is_empty() || after_top.is_none() || after_top == before_top {
        return Ok(facebook_scroll_failure(
            if clicked {
                EffectPhase::Confirmed
            } else {
                EffectPhase::Ambiguous
            },
            if after.loading {
                "feed_still_loading"
            } else {
                "not_refreshed"
            },
        ));
    }
    session.facebook.seen_post_ids.clear();
    let cards = facebook_page_cards(session, after, false, None);
    Ok((EffectPhase::Confirmed, CommandOutput::PageCards(cards)))
}

/// 已声明的列表面。滚动 / 到底确认 / 轮次耗尽分类共用同一份判据，
/// 免得「哪些面算列表面」在三处各写一遍、各漏一个。
pub(crate) fn facebook_list_surface(surface: &str) -> bool {
    matches!(surface, "home" | "search" | "group")
}

async fn ensure_facebook_active_list(session: &mut EngineSession) -> Result<(), EngineError> {
    let probe = probe_facebook_feed(session).await?;
    let on_list = facebook_list_surface(&probe.surface);
    if !on_list || probe.url != session.facebook.active_list_url {
        let target = session.facebook.active_list_url.clone();
        session.cdp.navigate(&target).await?;
        wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    }
    Ok(())
}

/// 判稳扫卡。**零卡视口不算稳定**——Facebook 的 feed 是懒加载的，下一批要时间渲染，
/// 两次探测都读到 0 卡只说明「还没长出来」，不说明「没有」。所以早退需要三条同时成立：
/// 卡集合与上一轮一致、不在 loading、且**本轮至少扫到一张卡**。零卡时一律轮询到预算耗尽，
/// 让懒加载有机会出批（退役实现 src/facebook/feed-reader.ts 的 settleCards 即此口径）。
///
/// 少掉「至少一张卡」这一条的后果：零卡页面约 500ms 就返回，八轮在约 10 秒内跑完，
/// 每一轮都在页面还没渲染时判零卡——等于把八轮压缩成一轮有效。
async fn settle_facebook_feed(
    session: &mut EngineSession,
    timeout: Duration,
) -> Result<facebook::FacebookFeedProbe, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut previous = None;
    loop {
        let current = probe_facebook_feed(session).await?;
        let key = facebook_feed_settle_key(&current);
        let stable = previous.as_ref() == Some(&key);
        if facebook_feed_settled(stable, &current) {
            return Ok(current);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(current);
        }
        previous = Some(key);
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// 判稳早退的判据本体（抽成纯函数以便单测）：稳定 + 不 loading + **本轮至少一张卡**。
fn facebook_feed_settled(stable: bool, probe: &facebook::FacebookFeedProbe) -> bool {
    stable && !probe.loading && !probe.cards.is_empty()
}

/// 零卡时的终态证据阶梯（启动首扫与云端命令驱动的常规滚动共用，绝不各写一份）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FacebookZeroCardTerminal {
    /// 首页确实有物理卡、只是读不出可信身份 ⇒ 交云端单点授权切 Reels。
    PresentUnreportable,
    /// 首页确认空态 ⇒ 交云端单点授权切 Reels。
    Empty,
    /// 阶梯都不成立 ⇒ 由调用方落各自的诚实失败原因码。
    None,
}

/// 准入判据严格照已合并规格 facebook-feed-browse 的最后一条 Scenario：
/// loading / 登录 / 同意浮层 / checkpoint / 未知 / 非首页 / 无物理卡，一律不得走这条兜底。
/// 判据只读探测事实，不做任何补偿性推断——报错方向永远偏诚实失败，绝不偏「有内容」。
fn facebook_present_unreportable_home(probe: &facebook::FacebookFeedProbe) -> bool {
    probe.surface == "home"
        && !probe.loading
        && probe.article_count > 0
        && probe.cards.is_empty()
        && probe.list_state == crate::model::FacebookListState::PresentUnreportable
}

async fn facebook_zero_card_terminal(
    session: &mut EngineSession,
    probe: &facebook::FacebookFeedProbe,
) -> Result<FacebookZeroCardTerminal, EngineError> {
    if facebook_present_unreportable_home(probe) {
        return Ok(FacebookZeroCardTerminal::PresentUnreportable);
    }
    if confirm_facebook_home_empty(session, probe).await? {
        return Ok(FacebookZeroCardTerminal::Empty);
    }
    Ok(FacebookZeroCardTerminal::None)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FacebookBottomConfirmationState {
    Waiting,
    Invalidated,
    ConfirmedEnd,
    WindowStable,
}

fn facebook_bottom_completion_reason(
    state: FacebookBottomConfirmationState,
    has_validated_card_witness: bool,
) -> Option<&'static str> {
    match state {
        FacebookBottomConfirmationState::ConfirmedEnd if has_validated_card_witness => {
            Some("feed_exhausted")
        }
        FacebookBottomConfirmationState::ConfirmedEnd
        | FacebookBottomConfirmationState::WindowStable => Some("feed_continuation_unconfirmed"),
        FacebookBottomConfirmationState::Waiting | FacebookBottomConfirmationState::Invalidated => {
            None
        }
    }
}

/// Feed 卡身份的唯一分档入口。
///
/// 缺省 / `Permalink` 保留历史行为，只接受可 canonicalize 的 Facebook 内容 URL；
/// `ContentRef` 必须显式分档且通过严格摘要格式校验，才可作为会话内身份。
fn facebook_feed_card_identity(card: &PageCard) -> Option<String> {
    let note_id = card.note_id.as_deref()?;
    match card.note_id_kind {
        Some(PostIdentityKind::ContentRef) if is_facebook_content_ref(note_id) => {
            Some(note_id.to_owned())
        }
        Some(PostIdentityKind::ContentRef) => None,
        Some(PostIdentityKind::Permalink) | None => canonical_facebook_post_id(note_id),
    }
}

fn facebook_feed_card_identities(probe: &facebook::FacebookFeedProbe) -> Vec<String> {
    probe
        .cards
        .iter()
        .filter_map(facebook_feed_card_identity)
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FacebookValidatedFeedCardWitness {
    surface: String,
    url: String,
    document_time_origin_ms: u64,
}

impl FacebookValidatedFeedCardWitness {
    fn from_probe(probe: &facebook::FacebookFeedProbe) -> Option<Self> {
        if probe.document_time_origin_ms == 0 || facebook_feed_card_identities(probe).is_empty() {
            return None;
        }
        Some(Self {
            surface: probe.surface.clone(),
            url: probe.url.clone(),
            document_time_origin_ms: probe.document_time_origin_ms,
        })
    }

    fn matches(&self, probe: &facebook::FacebookFeedProbe) -> bool {
        self.surface == probe.surface
            && self.url == probe.url
            && self.document_time_origin_ms == probe.document_time_origin_ms
    }
}

fn facebook_feed_settle_key(
    probe: &facebook::FacebookFeedProbe,
) -> (Vec<String>, u32, bool, bool, i64) {
    (
        facebook_feed_card_identities(probe),
        probe.article_count,
        probe.explicit_empty,
        probe.explicit_end,
        probe.scroll_height.round() as i64,
    )
}

/// 懒加载增高的抗噪阈值（像素）。低于它的高度变化是重排噪声、不算「页面还在长」。
/// 取值沿用退役实现的 100px：1px 会让任何一次重排都算增长 → 循环永远 continue，
/// 于是面别守卫放开了、证据链仍然走不到，到底确认在三个列表面上都拿不到。
/// 语义不变——只要页面还在长就继续下滚、绝不判到底。取值是否仍适用于 Native 版式见真机项 9.12。
const FACEBOOK_FEED_LAZYLOAD_GROWTH_PX: f64 = 100.0;
const FACEBOOK_FEED_BOTTOM_SAMPLE_OFFSETS: [Duration; 5] = [
    Duration::from_secs(0),
    Duration::from_secs(5),
    Duration::from_millis(7_500),
    Duration::from_secs(10),
    Duration::from_millis(12_500),
];
const FACEBOOK_FEED_BOTTOM_SAMPLE_COUNT: usize = FACEBOOK_FEED_BOTTOM_SAMPLE_OFFSETS.len();

fn facebook_feed_height_grew(
    before: &facebook::FacebookFeedProbe,
    after: &facebook::FacebookFeedProbe,
) -> bool {
    after.scroll_height > before.scroll_height + FACEBOOK_FEED_LAZYLOAD_GROWTH_PX
}

fn facebook_feed_same_document(
    expected: &facebook::FacebookFeedProbe,
    current: &facebook::FacebookFeedProbe,
) -> bool {
    expected.document_time_origin_ms > 0
        && expected.document_generation.is_some()
        && current.url == expected.url
        && current.surface == expected.surface
        && current.document_generation == expected.document_generation
        && current.document_time_origin_ms == expected.document_time_origin_ms
        && current.document_age_ms >= expected.document_age_ms
}

fn facebook_feed_ready_for_foreground_recovery(probe: &facebook::FacebookFeedProbe) -> bool {
    facebook_list_surface(&probe.surface)
        && probe.list_state == crate::model::FacebookListState::Ready
        && !probe.loading
        && !probe.explicit_empty
        && !probe.explicit_end
        && probe.scroll_height > probe.scroll_viewport_height + 1.0
        && !facebook_near_bottom(probe)
}

fn facebook_feed_no_movement_recovery_eligible(
    initial: &facebook::FacebookFeedProbe,
    before: &facebook::FacebookFeedProbe,
    after: &facebook::FacebookFeedProbe,
) -> bool {
    initial.scroll_y == before.scroll_y
        && before.scroll_y == after.scroll_y
        && facebook_feed_same_document(initial, before)
        && facebook_feed_same_document(before, after)
        && facebook_feed_ready_for_foreground_recovery(after)
}

fn facebook_feed_foreground_retry_context_matches(
    evidence: &facebook::FacebookFeedProbe,
    refreshed: &facebook::FacebookFeedProbe,
) -> bool {
    facebook_feed_same_document(evidence, refreshed)
        && facebook_feed_ready_for_foreground_recovery(refreshed)
        && evidence.scroll_y == refreshed.scroll_y
}

fn record_facebook_explicit_end_sample(samples: usize, explicit_end: bool) -> usize {
    if explicit_end { samples + 1 } else { 0 }
}

fn classify_facebook_bottom_confirmation_for_context(
    initial: &facebook::FacebookFeedProbe,
    current: &facebook::FacebookFeedProbe,
    allow_marker_free_home: bool,
    previous_document_age_ms: u64,
    samples_seen: usize,
    explicit_end_samples: usize,
) -> FacebookBottomConfirmationState {
    let same_document = initial.document_time_origin_ms > 0
        && current.url == initial.url
        && current.document_generation == initial.document_generation
        && current.document_time_origin_ms == initial.document_time_origin_ms
        && current.document_age_ms >= previous_document_age_ms;
    // 每个样本都必须留在同一个已声明列表面。确认函数会在任一样本失效时立即退出，
    // 因而这里逐样本与 initial 对比即可锁住完整五样本证据链。
    let invalidated = !facebook_list_surface(&initial.surface)
        || initial.surface != current.surface
        || !same_document
        || initial.loading
        || !facebook_near_bottom(initial)
        || current.loading
        || !facebook_near_bottom(current)
        || facebook_feed_height_grew(initial, current)
        || facebook_feed_card_identities(current) != facebook_feed_card_identities(initial);
    if invalidated {
        return FacebookBottomConfirmationState::Invalidated;
    }
    if samples_seen < FACEBOOK_FEED_BOTTOM_SAMPLE_COUNT {
        return FacebookBottomConfirmationState::Waiting;
    }
    // 普通首页 Feed 的结束文案在不同布局/语言下不存在或会抖动。首页已经完成五次结构判稳时，
    // 文案只作辅助观测；搜索/小组仍保留既有显式终止要求，避免 marker-free 近底把定向场景带去 Reels。
    if (allow_marker_free_home && initial.surface == "home")
        || explicit_end_samples == FACEBOOK_FEED_BOTTOM_SAMPLE_COUNT
    {
        return FacebookBottomConfirmationState::ConfirmedEnd;
    }
    FacebookBottomConfirmationState::WindowStable
}

#[cfg(test)]
fn classify_facebook_bottom_confirmation(
    initial: &facebook::FacebookFeedProbe,
    current: &facebook::FacebookFeedProbe,
    previous_document_age_ms: u64,
    samples_seen: usize,
    explicit_end_samples: usize,
) -> FacebookBottomConfirmationState {
    classify_facebook_bottom_confirmation_for_context(
        initial,
        current,
        true,
        previous_document_age_ms,
        samples_seen,
        explicit_end_samples,
    )
}

async fn confirm_facebook_feed_bottom(
    session: &mut EngineSession,
    initial: &facebook::FacebookFeedProbe,
    allow_marker_free_home: bool,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(FacebookBottomConfirmationState, facebook::FacebookFeedProbe), EngineError> {
    let started = tokio::time::Instant::now();
    let mut explicit_end_samples = usize::from(initial.explicit_end);
    let initial_state = classify_facebook_bottom_confirmation_for_context(
        initial,
        initial,
        allow_marker_free_home,
        initial.document_age_ms,
        1,
        explicit_end_samples,
    );
    if initial_state != FacebookBottomConfirmationState::Waiting {
        return Ok((initial_state, initial.clone()));
    }

    let mut current = initial.clone();
    let mut previous_document_age_ms = initial.document_age_ms;
    for (sample_index, offset) in FACEBOOK_FEED_BOTTOM_SAMPLE_OFFSETS
        .iter()
        .enumerate()
        .skip(1)
    {
        // 以 t=0 为锚点等待绝对偏移，避免探针本身的耗时逐轮累积到采样节奏里。
        wait_for_facebook_bottom_sample(started, *offset, cancellation, deadline_unix_ms).await?;
        let sample = probe_facebook_feed(session).await?;
        explicit_end_samples =
            record_facebook_explicit_end_sample(explicit_end_samples, sample.explicit_end);
        let state = classify_facebook_bottom_confirmation_for_context(
            initial,
            &sample,
            allow_marker_free_home,
            previous_document_age_ms,
            sample_index + 1,
            explicit_end_samples,
        );
        if state != FacebookBottomConfirmationState::Waiting {
            return Ok((state, sample));
        }
        previous_document_age_ms = sample.document_age_ms;
        current = sample;
    }

    // 固定计划的第五个样本必然会返回终态；若未来有人改坏计数关系，保守回非耗尽，
    // 不把内部不一致提升成切换 Reels 的授权。
    Ok((FacebookBottomConfirmationState::WindowStable, current))
}

async fn wait_for_facebook_bottom_sample(
    started: tokio::time::Instant,
    offset: Duration,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(), EngineError> {
    if facebook_command_cancelled(cancellation) {
        return Err(EngineError::new(
            ErrorCode::Cancelled,
            "native Facebook bottom confirmation cancelled",
        ));
    }
    let remaining_ms = deadline_unix_ms.saturating_sub(unix_time_ms());
    if remaining_ms == 0 {
        return Err(EngineError::new(
            ErrorCode::CdpTimeout,
            "native Facebook bottom confirmation exceeded its command deadline",
        ));
    }

    let sample_wait = tokio::time::sleep_until(started + offset);
    let deadline_wait = tokio::time::sleep(Duration::from_millis(remaining_ms));
    tokio::pin!(sample_wait);
    tokio::pin!(deadline_wait);

    if let Some(flag) = cancellation {
        let cancellation_wait = wait_for_cancellation(flag);
        tokio::pin!(cancellation_wait);
        tokio::select! {
            biased;
            _ = &mut cancellation_wait => Err(EngineError::new(
                ErrorCode::Cancelled,
                "native Facebook bottom confirmation cancelled",
            )),
            _ = &mut deadline_wait => Err(EngineError::new(
                ErrorCode::CdpTimeout,
                "native Facebook bottom confirmation exceeded its command deadline",
            )),
            _ = &mut sample_wait => Ok(()),
        }
    } else {
        tokio::select! {
            biased;
            _ = &mut deadline_wait => Err(EngineError::new(
                ErrorCode::CdpTimeout,
                "native Facebook bottom confirmation exceeded its command deadline",
            )),
            _ = &mut sample_wait => Ok(()),
        }
    }
}

fn facebook_unconfirmed_scroll_reason(
    saw_any_card: bool,
    current: &facebook::FacebookFeedProbe,
) -> &'static str {
    if current.loading {
        "feed_still_loading"
    } else if saw_any_card && facebook_list_surface(&current.surface) {
        // 任一列表面上见过卡、只是这条命令内没翻出新卡 —— 这是非终态「翻页未确认」。
        // 报「找不到目标」是把「本批看完」说成「这个面上根本没有东西」，
        // 云端拿不到任何可执行语义，账号就卡在那儿。
        "feed_continuation_unconfirmed"
    } else {
        "no_target"
    }
}

async fn confirm_facebook_home_empty(
    session: &mut EngineSession,
    initial: &facebook::FacebookFeedProbe,
) -> Result<bool, EngineError> {
    if initial.surface != "home" || initial.article_count > 0 || initial.loading {
        return Ok(false);
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let generation = (
        initial.url.clone(),
        initial.document_generation.clone().unwrap_or_default(),
    );
    let mut stable = 0usize;
    loop {
        let current = probe_facebook_feed(session).await?;
        let current_generation = (
            current.url.clone(),
            current.document_generation.clone().unwrap_or_default(),
        );
        if current.surface != "home"
            || !current.cards.is_empty()
            || current.article_count > 0
            || current.loading
            || !current.explicit_empty
            || current.document_age_ms < 8_000
            || current_generation != generation
        {
            stable = 0;
        } else {
            stable += 1;
            if stable >= 3 {
                let final_probe = probe_facebook_feed(session).await?;
                return Ok(final_probe.surface == "home"
                    && final_probe.cards.is_empty()
                    && final_probe.article_count == 0
                    && !final_probe.loading
                    && final_probe.explicit_empty
                    && final_probe.document_age_ms >= 8_000
                    && (
                        final_probe.url,
                        final_probe.document_generation.unwrap_or_default(),
                    ) == generation);
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn probe_facebook_identity_candidates(
    session: &mut EngineSession,
) -> Result<facebook::FacebookIdentityCandidates, EngineError> {
    let expression = facebook::identity_candidates_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::identity_candidates_from_cdp(&raw)
}

/// 身份采集回合（change acquire-facebook-feed-post-identity-by-hover）。
///
/// Facebook 不再把帖子地址放进 DOM：一张卡里几个指向站点根路径的链接中，只有**时间戳**那个在
/// **可信**指针落上去后才换出真地址（2026-07-29 越南语首页实测：可信指针 5/5、页面内合成事件 0/8、
/// `focus()` 3/25、视口外无效、换出后持久、全页 `pfbid` 出现 0 次即无免交互替代路径）。
/// 不做这一步，首页就永远读不出任何可操作目标。
///
/// 红线：**只移动、不按下**。任何 press/release 都会打开帖子或触发控件，那是平台可见的写操作。
/// 坐标每次现取——懒加载在上方插内容会让上一次探测的坐标几秒内失效（调查期实测命中率因此从 5/5 掉到 0/4）。
/// 采集失败一律无声降级：返回原探测，滚动的终态与不启用采集时逐位一致。
async fn acquire_facebook_feed_identities(
    session: &mut EngineSession,
    probe: facebook::FacebookFeedProbe,
    acquire_deadline: tokio::time::Instant,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<facebook::FacebookFeedProbe, EngineError> {
    if probe.surface != "home" || probe.loading {
        return Ok(probe);
    }
    // 本屏已经扫出带地址的卡 ⇒ 有东西可报，不必为剩下的花时间：采集是给「一张都读不出来」那种屏用的。
    // 这条同时保证顺利路径零额外开销（不多一次探测、不多一秒停留）。
    if !probe.cards.is_empty() {
        return Ok(probe);
    }
    let mut next_ordinal: std::collections::BTreeMap<u32, usize> =
        std::collections::BTreeMap::new();
    let mut finished: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    let mut touched_cards: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    let mut moved = false;

    loop {
        if tokio::time::Instant::now() >= acquire_deadline {
            break;
        }
        if cancellation.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire)) {
            break;
        }
        if crate::input::unix_time_ms() >= deadline_unix_ms {
            break;
        }
        if touched_cards.len() >= FACEBOOK_IDENTITY_MAX_CARDS_PER_ROUND {
            break;
        }
        let snapshot = probe_facebook_identity_candidates(session).await?;
        let Some(card) = snapshot
            .candidates
            .iter()
            .map(|candidate| candidate.card_index)
            .find(|index| !finished.contains(index))
        else {
            break;
        };
        let ordinal = *next_ordinal.entry(card).or_insert(0);
        if ordinal >= FACEBOOK_IDENTITY_MAX_CANDIDATES_PER_CARD {
            finished.insert(card);
            continue;
        }
        let Some(target) = snapshot
            .candidates
            .iter()
            .filter(|candidate| candidate.card_index == card)
            .nth(ordinal)
        else {
            finished.insert(card);
            continue;
        };
        touched_cards.insert(card);
        next_ordinal.insert(card, ordinal + 1);
        // 只移动，绝不按下。
        session
            .cdp
            .dispatch_mouse("mouseMoved", target.x, target.y, "none", 0)
            .await?;
        moved = true;
        tokio::time::sleep(FACEBOOK_IDENTITY_SETTLE).await;
        let after = probe_facebook_identity_candidates(session).await?;
        if after.resolved_count > snapshot.resolved_count {
            finished.insert(card);
        }
    }

    if !moved {
        return Ok(probe);
    }
    probe_facebook_feed(session).await
}

async fn probe_facebook_feed(
    session: &mut EngineSession,
) -> Result<facebook::FacebookFeedProbe, EngineError> {
    let expression = facebook::feed_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::feed_probe_from_cdp(&raw)
}

async fn probe_facebook_home_target(
    session: &mut EngineSession,
) -> Result<facebook::FacebookPointTarget, EngineError> {
    let expression = facebook::feed_home_target_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::point_target_from_cdp(&raw)
}

enum FacebookFeedRecovery {
    Continue(Box<facebook::FacebookFeedProbe>),
    Failure(EffectPhase, &'static str),
}

async fn recover_facebook_feed_prompt(
    session: &mut EngineSession,
    current: facebook::FacebookFeedProbe,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<FacebookFeedRecovery, EngineError> {
    let Some(observed) = current.feed_recovery_target.as_ref() else {
        return Ok(FacebookFeedRecovery::Continue(Box::new(current)));
    };
    if !observed.ok {
        return Ok(match observed.reason.as_deref() {
            None | Some("no_feed_recovery_target") => {
                FacebookFeedRecovery::Continue(Box::new(current))
            }
            Some("ambiguous_feed_recovery_target") => FacebookFeedRecovery::Failure(
                EffectPhase::NotStarted,
                "feed_recovery_target_ambiguous",
            ),
            Some("feed_recovery_target_out_of_view") => FacebookFeedRecovery::Failure(
                EffectPhase::NotStarted,
                "feed_recovery_target_out_of_view",
            ),
            Some(_) => FacebookFeedRecovery::Failure(
                EffectPhase::NotStarted,
                "feed_recovery_target_unavailable",
            ),
        });
    }

    if facebook_command_cancelled(cancellation) {
        return Err(cancelled_before_dispatch());
    }
    if unix_time_ms() >= deadline_unix_ms {
        return Ok(FacebookFeedRecovery::Failure(
            EffectPhase::NotStarted,
            "feed_recovery_deadline",
        ));
    }

    // feed_probe 的坐标只证明当时可见；可信点击前必须重新读取，不能使用可能已随布局变化的旧点位。
    // 是否允许前台化由 page_scroll 公共入口按 watchdog reason 单点决定，本恢复分支不得再抢焦点。
    let target = probe_facebook_feed_recovery_target(session).await?;
    if !target.ok {
        return Ok(match target.reason.as_deref() {
            None | Some("no_feed_recovery_target") => {
                FacebookFeedRecovery::Failure(EffectPhase::NotStarted, "feed_recovery_target_stale")
            }
            Some("ambiguous_feed_recovery_target") => FacebookFeedRecovery::Failure(
                EffectPhase::NotStarted,
                "feed_recovery_target_ambiguous",
            ),
            Some("feed_recovery_target_out_of_view") => FacebookFeedRecovery::Failure(
                EffectPhase::NotStarted,
                "feed_recovery_target_out_of_view",
            ),
            Some(_) => FacebookFeedRecovery::Failure(
                EffectPhase::NotStarted,
                "feed_recovery_target_unavailable",
            ),
        });
    }
    let (Some(x), Some(y)) = (target.cx, target.cy) else {
        return Ok(FacebookFeedRecovery::Failure(
            EffectPhase::NotStarted,
            "feed_recovery_target_invalid",
        ));
    };

    dispatch_facebook_click(session, x, y).await?;
    let remaining = deadline_unix_ms.saturating_sub(unix_time_ms());
    let wait_for = FACEBOOK_FEED_RECOVERY_TIMEOUT.min(
        Duration::from_millis(remaining).saturating_sub(FACEBOOK_FEED_RECOVERY_RECEIPT_MARGIN),
    );
    let deadline = tokio::time::Instant::now() + wait_for;
    loop {
        if facebook_command_cancelled(cancellation) {
            return Ok(FacebookFeedRecovery::Failure(
                EffectPhase::Ambiguous,
                "feed_recovery_navigation_unconfirmed",
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(FacebookFeedRecovery::Failure(
                EffectPhase::Ambiguous,
                "feed_recovery_navigation_unconfirmed",
            ));
        }
        let probe = probe_facebook_feed(session).await?;
        let recovery_gone = probe.feed_recovery_target.as_ref().is_none_or(|target| {
            !target.ok && target.reason.as_deref() == Some("no_feed_recovery_target")
        });
        if recovery_gone && probe.surface == "home" {
            session.facebook.active_list_url = FACEBOOK_HOME_URL.to_owned();
            return Ok(FacebookFeedRecovery::Continue(Box::new(probe)));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

async fn probe_facebook_feed_recovery_target(
    session: &mut EngineSession,
) -> Result<facebook::FacebookPointTarget, EngineError> {
    let expression = facebook::feed_recovery_target_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::point_target_from_cdp(&raw)
}

async fn dispatch_facebook_feed_wheel(
    session: &mut EngineSession,
    probe: &facebook::FacebookFeedProbe,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(), EngineError> {
    let x = (probe.inner_width / 2.0).max(1.0);
    let y = (probe.inner_height * 0.55).max(1.0);
    dispatch_wheel_humanized(
        &mut session.cdp,
        x,
        y,
        650.0,
        cancellation,
        deadline_unix_ms,
    )
    .await
    .map_err(|failure| match failure {
        WheelInputFailure::Cancelled => cancelled_before_dispatch(),
        WheelInputFailure::Deadline => EngineError::new(
            ErrorCode::CdpTimeout,
            "native Facebook wheel gesture exceeded its deadline",
        ),
        WheelInputFailure::Cdp(error) => error,
    })
}

fn facebook_page_cards(
    session: &mut EngineSession,
    probe: facebook::FacebookFeedProbe,
    only_new: bool,
    movement: Option<PageMovement>,
) -> PageCards {
    facebook_page_cards_with_seen_post_ids(
        &mut session.facebook.seen_post_ids,
        probe,
        only_new,
        movement,
    )
}

fn facebook_page_cards_with_seen_post_ids(
    seen_post_ids: &mut std::collections::HashSet<String>,
    probe: facebook::FacebookFeedProbe,
    only_new: bool,
    movement: Option<PageMovement>,
) -> PageCards {
    let mut cards = Vec::new();
    for mut card in probe.cards {
        let Some(identity) = facebook_feed_card_identity(&card) else {
            continue;
        };
        let is_new = seen_post_ids.insert(identity);
        if only_new && !is_new {
            continue;
        }
        card.index = cards.len() as u32;
        cards.push(card);
    }
    PageCards {
        cards,
        movement,
        document_generation: probe.document_generation,
        container_name: None,
        list_kind: Some(probe.list_kind),
        list_state: Some(
            if probe.list_state == crate::model::FacebookListState::Ready {
                crate::model::FacebookListState::Ready
            } else {
                probe.list_state
            },
        ),
        selection_reason: None,
    }
    .bounded()
}

fn facebook_near_bottom(probe: &facebook::FacebookFeedProbe) -> bool {
    probe.scroll_height > 0.0
        && probe.scroll_viewport_height > 0.0
        && probe.scroll_height - probe.scroll_y - probe.scroll_viewport_height
            <= probe.scroll_viewport_height.max(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FacebookListKind, FacebookListState};

    #[test]
    fn reels_entry_reason_accepts_only_configured_primary_and_feed_fallback() {
        assert!(facebook_reels_entry_reason(Some("facebook_reels_primary")));
        assert!(facebook_reels_entry_reason(Some(
            "empty_feed_reels_fallback"
        )));
        assert!(!facebook_reels_entry_reason(Some("feed_scroll")));
        assert!(!facebook_reels_entry_reason(None));
    }

    /// 内容派生的会话内引用**不是地址**：导航校验必须诚实拒绝它，绝不放行、也绝不猜一个地址
    /// （change generalize-facebook-content-derived-post-identity task 2.3）。
    /// 这条是导航兜底的最后一道保险——云端在统一出口已经不发这类命令，这里守的是「万一发了」。
    #[test]
    fn content_derived_references_are_never_navigable() {
        let content_ref = format!("aidcp:facebook-group-feed-post:v1:{}", "a1".repeat(32));
        assert!(is_facebook_content_ref(&content_ref));
        assert!(validated_facebook_content_url(&content_ref, None).is_err());
        assert!(validated_facebook_content_url(&content_ref, Some(&content_ref)).is_err());
        assert!(canonical_facebook_post_id(&content_ref).is_none());
        // 形似而不合格的值不算引用（走既有的诚实失败，不进本 change 的分档路径）。
        assert!(!is_facebook_content_ref(
            "aidcp:facebook-group-feed-post:v1:tooshort"
        ));
        assert!(!is_facebook_content_ref(&format!(
            "aidcp:facebook-group-feed-post:v1:{}",
            "A1".repeat(32)
        )));
        // 真地址照常放行，逐位等于今天。
        assert!(
            validated_facebook_content_url("https://www.facebook.com/Alice/posts/pfbid1", None)
                .is_ok()
        );
    }

    fn feed_probe(
        scroll_height: f64,
        scroll_y: f64,
        loading: bool,
        explicit_end: bool,
    ) -> facebook::FacebookFeedProbe {
        surfaced_feed_probe("home", scroll_height, scroll_y, loading, explicit_end)
    }

    fn surfaced_feed_probe(
        surface: &str,
        scroll_height: f64,
        scroll_y: f64,
        loading: bool,
        explicit_end: bool,
    ) -> facebook::FacebookFeedProbe {
        let mut probe = base_feed_probe(scroll_height, scroll_y, loading, explicit_end);
        probe.surface = surface.to_owned();
        probe
    }

    fn base_feed_probe(
        scroll_height: f64,
        scroll_y: f64,
        loading: bool,
        explicit_end: bool,
    ) -> facebook::FacebookFeedProbe {
        facebook::FacebookFeedProbe {
            cards: Vec::new(),
            document_generation: Some("doc-1".to_owned()),
            list_kind: FacebookListKind::Feed,
            list_state: FacebookListState::Ready,
            loading,
            article_count: 2,
            explicit_empty: false,
            explicit_end,
            url: FACEBOOK_HOME_URL.to_owned(),
            surface: "home".to_owned(),
            scroll_y,
            inner_width: 1440.0,
            inner_height: 900.0,
            scroll_height,
            scroll_viewport_height: 900.0,
            document_time_origin_ms: 1_780_000_000_000,
            document_age_ms: 10_000,
            feed_recovery_target: None,
        }
    }

    #[test]
    fn foreground_recovery_requires_a_first_same_document_nonterminal_miss() {
        let initial = feed_probe(4_000.0, 0.0, false, false);
        let before = initial.clone();
        let mut unchanged = before.clone();
        unchanged.document_age_ms += 500;
        assert!(facebook_feed_no_movement_recovery_eligible(
            &initial, &before, &unchanged
        ));

        let mut moved = unchanged.clone();
        moved.scroll_y = 650.0;
        assert!(!facebook_feed_no_movement_recovery_eligible(
            &initial, &before, &moved
        ));

        let mut loading = unchanged.clone();
        loading.loading = true;
        assert!(!facebook_feed_no_movement_recovery_eligible(
            &initial, &before, &loading
        ));

        let mut bottom = unchanged.clone();
        bottom.scroll_y = 3_100.0;
        let bottom_before = bottom.clone();
        assert!(!facebook_feed_no_movement_recovery_eligible(
            &bottom,
            &bottom_before,
            &bottom
        ));

        let mut changed_document = unchanged.clone();
        changed_document.document_generation = Some("doc-2".to_owned());
        assert!(!facebook_feed_no_movement_recovery_eligible(
            &initial,
            &before,
            &changed_document
        ));

        let mut changed_time_origin = unchanged.clone();
        changed_time_origin.document_time_origin_ms += 1;
        assert!(!facebook_feed_no_movement_recovery_eligible(
            &initial,
            &before,
            &changed_time_origin
        ));

        let mut changed_surface = unchanged.clone();
        changed_surface.surface = "search".to_owned();
        assert!(!facebook_feed_no_movement_recovery_eligible(
            &initial,
            &before,
            &changed_surface
        ));

        let mut prior_progress = before.clone();
        prior_progress.scroll_y = 400.0;
        let after_prior_progress = prior_progress.clone();
        assert!(!facebook_feed_no_movement_recovery_eligible(
            &initial,
            &prior_progress,
            &after_prior_progress
        ));
    }

    #[test]
    fn foreground_retry_context_requires_the_same_ready_scroll_position() {
        let evidence = feed_probe(4_000.0, 0.0, false, false);
        let mut refreshed = evidence.clone();
        refreshed.document_age_ms += 1;
        assert!(facebook_feed_foreground_retry_context_matches(
            &evidence, &refreshed
        ));

        refreshed.scroll_y = 10.0;
        assert!(!facebook_feed_foreground_retry_context_matches(
            &evidence, &refreshed
        ));
    }

    /// 「首页有物理卡但读不出可信身份」的探测样本：滚动兜底阶梯的唯一准入形态。
    fn unreportable_home_probe() -> facebook::FacebookFeedProbe {
        let mut probe = feed_probe(2_400.0, 1_500.0, false, false);
        probe.list_state = FacebookListState::PresentUnreportable;
        probe
    }

    fn probe_with_one_card(loading: bool) -> facebook::FacebookFeedProbe {
        let mut probe = feed_probe(2_400.0, 1_500.0, loading, false);
        probe.list_state = FacebookListState::Ready;
        probe.cards = vec![crate::model::PageCard {
            index: 0,
            title: "card".to_owned(),
            author: None,
            like_count: 0,
            collect_count: 0,
            cover_desc: None,
            note_id: Some("https://www.facebook.com/watch?v=1".to_owned()),
            note_id_kind: None,
            is_video: None,
        }];
        probe
    }

    fn valid_content_ref(hex_pair: &str) -> String {
        format!("{FACEBOOK_CONTENT_REF_PREFIX}{}", hex_pair.repeat(32))
    }

    fn probe_with_content_ref(hex_pair: &str) -> facebook::FacebookFeedProbe {
        let mut probe = probe_with_one_card(false);
        probe.cards[0].note_id = Some(valid_content_ref(hex_pair));
        probe.cards[0].note_id_kind = Some(PostIdentityKind::ContentRef);
        probe
    }

    #[test]
    fn unreportable_home_is_admitted_to_the_zero_card_ladder() {
        assert!(facebook_present_unreportable_home(
            &unreportable_home_probe()
        ));
    }

    #[test]
    fn zero_card_ladder_refuses_loading_blocked_and_non_home_pages() {
        // loading：下一批可能正在渲染，说成「有内容读不出来」就是替平台下结论。
        let mut loading = unreportable_home_probe();
        loading.loading = true;
        assert!(!facebook_present_unreportable_home(&loading));

        // 非首页（登录 / checkpoint / 群组 / Reels 都归此类）：兜底通道只对首页开放。
        for surface in ["login", "checkpoint", "group", "reels", "search", "unknown"] {
            let mut off_home = unreportable_home_probe();
            off_home.surface = surface.to_owned();
            assert!(
                !facebook_present_unreportable_home(&off_home),
                "surface {surface} must not be admitted"
            );
        }

        // 无物理卡：那是空态的判据，走空态确认那一级，不许借这一级。
        let mut cardless = unreportable_home_probe();
        cardless.article_count = 0;
        assert!(!facebook_present_unreportable_home(&cardless));

        // 探测自己没判「有卡读不出来」时，不许由上层补一个结论出来。
        let mut ready = unreportable_home_probe();
        ready.list_state = FacebookListState::Ready;
        assert!(!facebook_present_unreportable_home(&ready));

        // 已经有可上报卡：本来就该走正常上报路径，不是零卡终态。
        let mut with_cards = unreportable_home_probe();
        with_cards.cards = probe_with_one_card(false).cards;
        assert!(!facebook_present_unreportable_home(&with_cards));
    }

    #[test]
    fn zero_card_viewport_is_not_settled_by_stability_alone() {
        // 懒加载还没出批时两次探测当然一致——那不是「稳定」，是「还没长出来」。
        let zero_cards = feed_probe(2_400.0, 1_500.0, false, false);
        assert!(zero_cards.cards.is_empty());
        assert!(!facebook_feed_settled(true, &zero_cards));
    }

    #[test]
    fn settled_non_empty_card_set_still_returns_early() {
        // 正常路径不许变慢：扫到卡且稳定且不 loading，立刻早退。
        assert!(facebook_feed_settled(true, &probe_with_one_card(false)));
        // loading 期间即便有卡也不算判稳（保持既有口径）。
        assert!(!facebook_feed_settled(true, &probe_with_one_card(true)));
        // 未稳定就更不能早退。
        assert!(!facebook_feed_settled(false, &probe_with_one_card(false)));
    }

    #[test]
    fn settle_identity_changes_when_document_height_changes() {
        let before = feed_probe(2_400.0, 1_500.0, false, false);
        let after = feed_probe(2_900.0, 2_000.0, false, false);

        assert_ne!(
            facebook_feed_settle_key(&before),
            facebook_feed_settle_key(&after)
        );
    }

    #[test]
    fn delayed_height_growth_cancels_bottom_confirmation() {
        let initial = feed_probe(2_400.0, 1_500.0, false, false);
        let grown = feed_probe(2_900.0, 2_000.0, false, false);

        assert_eq!(
            classify_facebook_bottom_confirmation(&initial, &grown, initial.document_age_ms, 2, 0,),
            FacebookBottomConfirmationState::Invalidated
        );
    }

    #[test]
    fn any_structural_change_invalidates_bottom_confirmation() {
        let initial = feed_probe(2_400.0, 1_500.0, false, true);

        let mut loading = initial.clone();
        loading.loading = true;
        let mut left_bottom = initial.clone();
        left_bottom.scroll_y = 0.0;
        let mut changed_generation = initial.clone();
        changed_generation.document_generation = Some("doc-2".to_owned());
        let mut changed_url = initial.clone();
        changed_url.url = "https://www.facebook.com/?sk=h_chr".to_owned();
        let mut changed_time_origin = initial.clone();
        changed_time_origin.document_time_origin_ms += 1;
        let mut refreshed_document = initial.clone();
        refreshed_document.document_age_ms = 100;
        let mut new_card = initial.clone();
        new_card.cards = probe_with_one_card(false).cards;

        for (change, sample) in [
            ("loading", loading),
            ("left bottom", left_bottom),
            ("document generation", changed_generation),
            ("url", changed_url),
            ("document time origin", changed_time_origin),
            ("document refresh", refreshed_document),
            ("card identity set", new_card),
        ] {
            assert_eq!(
                classify_facebook_bottom_confirmation(
                    &initial,
                    &sample,
                    initial.document_age_ms,
                    2,
                    2,
                ),
                FacebookBottomConfirmationState::Invalidated,
                "{change} must invalidate the sequence"
            );
        }

        let mut age_regressed_after_a_later_sample = initial.clone();
        age_regressed_after_a_later_sample.document_age_ms = 15_000;
        assert_eq!(
            classify_facebook_bottom_confirmation(
                &initial,
                &age_regressed_after_a_later_sample,
                20_000,
                3,
                3,
            ),
            FacebookBottomConfirmationState::Invalidated,
            "document age must remain monotonic between consecutive samples"
        );

        let initial_loading = feed_probe(2_400.0, 1_500.0, true, true);
        assert_eq!(
            classify_facebook_bottom_confirmation(
                &initial_loading,
                &initial_loading,
                initial_loading.document_age_ms,
                1,
                1,
            ),
            FacebookBottomConfirmationState::Invalidated,
            "t=0 证据无效时不得由后续样本覆盖"
        );

        let mut ordered = probe_with_one_card(false);
        let mut second = ordered.cards[0].clone();
        second.index = 1;
        second.note_id = Some("https://www.facebook.com/watch?v=2".to_owned());
        ordered.cards.push(second);
        let mut reordered = ordered.clone();
        reordered.cards.reverse();
        assert_eq!(
            classify_facebook_bottom_confirmation(
                &ordered,
                &reordered,
                ordered.document_age_ms,
                2,
                2,
            ),
            FacebookBottomConfirmationState::Invalidated,
            "卡身份向量重排也必须使当前确认失效"
        );
    }

    #[test]
    fn bottom_confirmation_uses_the_exact_five_sample_schedule() {
        assert_eq!(
            FACEBOOK_FEED_BOTTOM_SAMPLE_OFFSETS,
            [
                Duration::from_secs(0),
                Duration::from_secs(5),
                Duration::from_millis(7_500),
                Duration::from_secs(10),
                Duration::from_millis(12_500),
            ]
        );
        assert_eq!(FACEBOOK_FEED_BOTTOM_SAMPLE_COUNT, 5);
    }

    #[tokio::test]
    async fn bottom_confirmation_wait_obeys_cancellation_and_command_deadline() {
        let cancellation = AtomicBool::new(false);
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancellation.store(true, std::sync::atomic::Ordering::Release);
        };
        let wait = wait_for_facebook_bottom_sample(
            tokio::time::Instant::now(),
            Duration::from_secs(5),
            Some(&cancellation),
            unix_time_ms() + 60_000,
        );
        let (_, cancelled) = tokio::time::timeout(Duration::from_millis(250), async {
            tokio::join!(cancel, wait)
        })
        .await
        .expect("cancellation must interrupt the five-second wait");
        assert_eq!(
            cancelled.expect_err("cancelled wait must fail").code,
            ErrorCode::Cancelled
        );

        let expired = wait_for_facebook_bottom_sample(
            tokio::time::Instant::now(),
            Duration::from_secs(5),
            None,
            unix_time_ms(),
        )
        .await
        .expect_err("expired command deadline must interrupt the wait");
        assert_eq!(expired.code, ErrorCode::CdpTimeout);
    }

    #[test]
    fn stable_home_near_bottom_without_a_marker_confirms_after_the_complete_window() {
        let initial = feed_probe(2_400.0, 1_500.0, false, false);
        let stable = initial.clone();

        assert_eq!(
            classify_facebook_bottom_confirmation(&initial, &stable, initial.document_age_ms, 4, 0,),
            FacebookBottomConfirmationState::Waiting
        );
        assert_eq!(
            classify_facebook_bottom_confirmation(&initial, &stable, initial.document_age_ms, 5, 0,),
            FacebookBottomConfirmationState::ConfirmedEnd
        );
        assert_eq!(
            facebook_bottom_completion_reason(FacebookBottomConfirmationState::ConfirmedEnd, true,),
            Some("feed_exhausted")
        );
        assert_eq!(
            facebook_bottom_completion_reason(FacebookBottomConfirmationState::ConfirmedEnd, false,),
            Some("feed_continuation_unconfirmed")
        );
    }

    #[test]
    fn structural_home_end_cannot_finish_before_the_fifth_sample() {
        let initial = feed_probe(2_400.0, 1_500.0, false, false);
        let terminal = initial.clone();

        for samples_seen in 1..FACEBOOK_FEED_BOTTOM_SAMPLE_COUNT {
            assert_eq!(
                classify_facebook_bottom_confirmation(
                    &initial,
                    &terminal,
                    initial.document_age_ms,
                    samples_seen,
                    0,
                ),
                FacebookBottomConfirmationState::Waiting,
                "第 {samples_seen} 次样本不得提前确认耗尽"
            );
        }
        assert_eq!(
            classify_facebook_bottom_confirmation(
                &initial,
                &terminal,
                initial.document_age_ms,
                5,
                0,
            ),
            FacebookBottomConfirmationState::ConfirmedEnd,
        );
        assert_eq!(
            facebook_bottom_completion_reason(FacebookBottomConfirmationState::ConfirmedEnd, true,),
            Some("feed_exhausted")
        );
    }

    #[test]
    fn any_missing_explicit_end_sample_still_confirms_a_structurally_stable_home() {
        for missing_index in 0..FACEBOOK_FEED_BOTTOM_SAMPLE_COUNT {
            let initial = feed_probe(2_400.0, 1_500.0, false, missing_index != 0);
            let mut explicit_end_samples = usize::from(initial.explicit_end);
            let mut state = classify_facebook_bottom_confirmation(
                &initial,
                &initial,
                initial.document_age_ms,
                1,
                explicit_end_samples,
            );

            for sample_index in 1..FACEBOOK_FEED_BOTTOM_SAMPLE_COUNT {
                let sample = feed_probe(2_400.0, 1_500.0, false, sample_index != missing_index);
                explicit_end_samples =
                    record_facebook_explicit_end_sample(explicit_end_samples, sample.explicit_end);
                state = classify_facebook_bottom_confirmation(
                    &initial,
                    &sample,
                    initial.document_age_ms,
                    sample_index + 1,
                    explicit_end_samples,
                );
            }

            assert_eq!(
                state,
                FacebookBottomConfirmationState::ConfirmedEnd,
                "第 {} 次缺少 explicit_end 不得阻断首页结构确认",
                missing_index + 1
            );
        }
    }

    #[test]
    fn a_non_home_command_redirected_to_home_does_not_gain_marker_free_exhaustion() {
        let redirected_home = feed_probe(2_400.0, 1_500.0, false, false);
        assert_eq!(
            classify_facebook_bottom_confirmation_for_context(
                &redirected_home,
                &redirected_home,
                false,
                redirected_home.document_age_ms,
                FACEBOOK_FEED_BOTTOM_SAMPLE_COUNT,
                0,
            ),
            FacebookBottomConfirmationState::WindowStable
        );
    }

    #[test]
    fn near_bottom_means_one_viewport_not_exact_mathematical_bottom() {
        let initial = feed_probe(2_400.0, 1_000.0, false, false);
        assert_eq!(
            initial.scroll_height - initial.scroll_y - initial.scroll_viewport_height,
            500.0
        );
        assert!(facebook_near_bottom(&initial));
        assert_eq!(
            classify_facebook_bottom_confirmation(
                &initial,
                &initial,
                initial.document_age_ms,
                5,
                0,
            ),
            FacebookBottomConfirmationState::ConfirmedEnd
        );

        let mut nested_scroller = feed_probe(2_400.0, 1_500.0, false, false);
        nested_scroller.scroll_viewport_height = 400.0;
        assert_eq!(
            nested_scroller.scroll_height
                - nested_scroller.scroll_y
                - nested_scroller.scroll_viewport_height,
            500.0
        );
        assert!(
            !facebook_near_bottom(&nested_scroller),
            "window height must not make a smaller nested scroller look near-bottom"
        );
        nested_scroller.scroll_y = 1_600.0;
        assert!(facebook_near_bottom(&nested_scroller));
    }

    #[test]
    fn validated_feed_card_witness_is_bound_to_the_confirmed_surface_and_document() {
        let home = probe_with_one_card(false);
        let witness = FacebookValidatedFeedCardWitness::from_probe(&home)
            .expect("validated home card witness");
        assert!(witness.matches(&home));

        let mut later_empty_home = home.clone();
        later_empty_home.cards.clear();
        later_empty_home.document_generation = Some("later-stable-empty-window".to_owned());
        assert!(
            witness.matches(&later_empty_home),
            "virtualization may replace the visible card vector without replacing the document"
        );
        assert_eq!(
            facebook_bottom_completion_reason(
                FacebookBottomConfirmationState::ConfirmedEnd,
                witness.matches(&later_empty_home),
            ),
            Some("feed_exhausted")
        );

        let mut group = home.clone();
        group.surface = "group".to_owned();
        assert!(
            !witness.matches(&group),
            "a card observed on home must not authorize another list surface"
        );

        let mut refreshed_home = home.clone();
        refreshed_home.document_time_origin_ms += 1;
        assert!(
            !witness.matches(&refreshed_home),
            "a card observed before refresh must not authorize the replacement document"
        );
    }

    #[test]
    fn content_ref_only_home_confirms_exhaustion_after_five_stable_samples() {
        let initial = probe_with_content_ref("a1");
        let expected_identity = valid_content_ref("a1");
        assert_eq!(
            facebook_feed_card_identities(&initial),
            vec![expected_identity]
        );
        let witness = FacebookValidatedFeedCardWitness::from_probe(&initial)
            .expect("valid content-ref witness");
        let mut other_surface = initial.clone();
        other_surface.surface = "group".to_owned();
        assert!(
            !witness.matches(&other_surface),
            "a content-ref witness must remain bound to its issuing list surface"
        );
        let mut other_url = initial.clone();
        other_url.url = "https://www.facebook.com/?sk=h_chr".to_owned();
        assert!(
            !witness.matches(&other_url),
            "a content-ref witness must remain bound to its issuing list URL"
        );
        let mut refreshed_document = initial.clone();
        refreshed_document.document_time_origin_ms += 1;
        assert!(
            !witness.matches(&refreshed_document),
            "a content-ref witness must not survive a document replacement"
        );

        let mut previous_document_age_ms = initial.document_age_ms;
        let mut state = FacebookBottomConfirmationState::Waiting;
        for samples_seen in 1..=FACEBOOK_FEED_BOTTOM_SAMPLE_COUNT {
            let mut sample = initial.clone();
            sample.document_age_ms += samples_seen as u64;
            state = classify_facebook_bottom_confirmation(
                &initial,
                &sample,
                previous_document_age_ms,
                samples_seen,
                0,
            );
            if samples_seen < FACEBOOK_FEED_BOTTOM_SAMPLE_COUNT {
                assert_eq!(state, FacebookBottomConfirmationState::Waiting);
            }
            previous_document_age_ms = sample.document_age_ms;
        }

        assert_eq!(state, FacebookBottomConfirmationState::ConfirmedEnd);
        assert_eq!(
            facebook_bottom_completion_reason(state, witness.matches(&initial)),
            Some("feed_exhausted")
        );
    }

    #[test]
    fn a_changed_content_ref_invalidates_the_structural_window() {
        let initial = probe_with_content_ref("a1");
        let changed = probe_with_content_ref("b2");

        assert_eq!(
            classify_facebook_bottom_confirmation(
                &initial,
                &changed,
                initial.document_age_ms,
                2,
                0,
            ),
            FacebookBottomConfirmationState::Invalidated
        );
    }

    #[test]
    fn malformed_or_misclassified_content_refs_never_become_witnesses() {
        let valid_ref = valid_content_ref("a1");
        let mut empty = probe_with_content_ref("a1");
        empty.cards[0].note_id = None;
        let mut malformed = probe_with_content_ref("a1");
        malformed.cards[0].note_id = Some(format!("{FACEBOOK_CONTENT_REF_PREFIX}tooshort"));
        let mut uppercase_digest = probe_with_content_ref("a1");
        uppercase_digest.cards[0].note_id =
            Some(format!("{FACEBOOK_CONTENT_REF_PREFIX}{}", "A1".repeat(32)));
        let mut missing_kind = probe_with_content_ref("a1");
        missing_kind.cards[0].note_id_kind = None;
        let mut mislabeled_permalink = probe_with_content_ref("a1");
        mislabeled_permalink.cards[0].note_id_kind = Some(PostIdentityKind::Permalink);
        let mut mislabeled_content_ref = probe_with_one_card(false);
        mislabeled_content_ref.cards[0].note_id_kind = Some(PostIdentityKind::ContentRef);

        for (case, probe) in [
            ("empty", empty),
            ("malformed", malformed),
            ("uppercase digest", uppercase_digest),
            ("missing kind", missing_kind),
            ("content ref labeled permalink", mislabeled_permalink),
            ("permalink labeled content ref", mislabeled_content_ref),
        ] {
            assert!(
                facebook_feed_card_identities(&probe).is_empty(),
                "{case} must not have a trusted identity"
            );
            assert!(
                FacebookValidatedFeedCardWitness::from_probe(&probe).is_none(),
                "{case} must not become an exhaustion witness"
            );
        }
        assert!(is_facebook_content_ref(&valid_ref));
    }

    #[test]
    fn content_ref_page_cards_are_reported_and_session_deduplicated() {
        let mut first_probe = probe_with_content_ref("a1");
        let first_ref = valid_content_ref("a1");
        let second_ref = valid_content_ref("b2");
        let mut second_card = first_probe.cards[0].clone();
        second_card.index = 1;
        second_card.note_id = Some(second_ref.clone());
        first_probe.cards.push(second_card);
        let mut seen_post_ids = std::collections::HashSet::new();

        let first = facebook_page_cards_with_seen_post_ids(
            &mut seen_post_ids,
            first_probe.clone(),
            true,
            None,
        );
        assert_eq!(first.cards.len(), 2);
        assert_eq!(first.cards[0].note_id.as_deref(), Some(first_ref.as_str()));
        assert_eq!(first.cards[1].note_id.as_deref(), Some(second_ref.as_str()));
        assert_eq!(
            first.cards[0].note_id_kind,
            Some(PostIdentityKind::ContentRef)
        );
        assert!(seen_post_ids.contains(&first_ref));
        assert!(seen_post_ids.contains(&second_ref));

        let duplicate =
            facebook_page_cards_with_seen_post_ids(&mut seen_post_ids, first_probe, true, None);
        assert!(
            duplicate.cards.is_empty(),
            "both full content refs are independent session dedupe keys"
        );
    }

    #[test]
    fn legacy_and_explicit_permalink_cards_keep_canonical_deduplication() {
        let legacy = probe_with_one_card(false);
        assert_eq!(facebook_feed_card_identities(&legacy), vec!["1"]);
        assert!(FacebookValidatedFeedCardWitness::from_probe(&legacy).is_some());

        let mut seen_post_ids = std::collections::HashSet::new();
        let first =
            facebook_page_cards_with_seen_post_ids(&mut seen_post_ids, legacy.clone(), true, None);
        assert_eq!(first.cards.len(), 1);
        assert!(seen_post_ids.contains("1"));
        let duplicate =
            facebook_page_cards_with_seen_post_ids(&mut seen_post_ids, legacy, true, None);
        assert!(duplicate.cards.is_empty());

        let mut explicit = probe_with_one_card(false);
        explicit.cards[0].note_id_kind = Some(PostIdentityKind::Permalink);
        assert_eq!(facebook_feed_card_identities(&explicit), vec!["1"]);
        assert!(FacebookValidatedFeedCardWitness::from_probe(&explicit).is_some());

        let content_ref = probe_with_content_ref("a1");
        let content_ref_key = valid_content_ref("a1");
        let content_ref_cards =
            facebook_page_cards_with_seen_post_ids(&mut seen_post_ids, content_ref, true, None);
        assert_eq!(content_ref_cards.cards.len(), 1);
        assert!(seen_post_ids.contains("1"));
        assert!(seen_post_ids.contains(&content_ref_key));
    }

    #[test]
    fn round_limit_with_recycled_cards_is_not_feed_exhausted() {
        let ready = feed_probe(2_400.0, 1_500.0, false, false);
        let loading = feed_probe(2_400.0, 1_500.0, true, false);
        assert_eq!(
            facebook_unconfirmed_scroll_reason(true, &ready),
            "feed_continuation_unconfirmed"
        );
        assert_eq!(
            facebook_unconfirmed_scroll_reason(false, &loading),
            "feed_still_loading"
        );
        assert_eq!(
            facebook_unconfirmed_scroll_reason(false, &ready),
            "no_target"
        );
    }

    #[test]
    fn every_declared_list_surface_can_reach_a_terminal_bottom_state() {
        for surface in ["home", "search", "group"] {
            let initial = surfaced_feed_probe(surface, 2_400.0, 1_500.0, false, true);
            let terminal = surfaced_feed_probe(surface, 2_400.0, 1_500.0, false, true);
            assert_eq!(
                classify_facebook_bottom_confirmation(
                    &initial,
                    &terminal,
                    initial.document_age_ms,
                    5,
                    5,
                ),
                FacebookBottomConfirmationState::ConfirmedEnd,
                "{surface} must retain its existing confirmed end"
            );

            let stable = surfaced_feed_probe(surface, 2_400.0, 1_500.0, false, false);
            let expected = if surface == "home" {
                FacebookBottomConfirmationState::ConfirmedEnd
            } else {
                FacebookBottomConfirmationState::WindowStable
            };
            assert_eq!(
                classify_facebook_bottom_confirmation(
                    &stable,
                    &stable,
                    stable.document_age_ms,
                    5,
                    0,
                ),
                expected,
                "{surface} must keep the intended marker-free boundary"
            );
        }
    }

    #[test]
    fn a_surface_change_inside_the_confirmation_window_still_invalidates_it() {
        let initial = surfaced_feed_probe("group", 2_400.0, 1_500.0, false, true);
        let moved = surfaced_feed_probe("home", 2_400.0, 1_500.0, false, true);
        assert_eq!(
            classify_facebook_bottom_confirmation(&initial, &moved, initial.document_age_ms, 2, 2,),
            FacebookBottomConfirmationState::Invalidated
        );

        let detail = surfaced_feed_probe("group_post", 2_400.0, 1_500.0, false, true);
        assert_eq!(
            classify_facebook_bottom_confirmation(
                &detail,
                &detail.clone(),
                detail.document_age_ms,
                1,
                1,
            ),
            FacebookBottomConfirmationState::Invalidated,
            "非列表面上根本不该做到底确认"
        );
    }

    #[test]
    fn a_seen_card_on_any_list_surface_is_continuation_not_a_missing_target() {
        for surface in ["home", "search", "group"] {
            let ready = surfaced_feed_probe(surface, 2_400.0, 1_500.0, false, false);
            assert_eq!(
                facebook_unconfirmed_scroll_reason(true, &ready),
                "feed_continuation_unconfirmed",
                "{surface} 上见过卡就不是「找不到目标」"
            );
            assert_eq!(
                facebook_unconfirmed_scroll_reason(false, &ready),
                "no_target",
                "{surface} 上一张卡都没见过才是「找不到目标」"
            );
        }

        let mut noncanonical = probe_with_one_card(false);
        noncanonical.cards[0].note_id = Some("content_ref:feed:0".to_owned());
        assert!(facebook_feed_card_identities(&noncanonical).is_empty());
        assert!(FacebookValidatedFeedCardWitness::from_probe(&noncanonical).is_none());
        assert_eq!(
            facebook_unconfirmed_scroll_reason(!noncanonical.cards.is_empty(), &noncanonical),
            "feed_continuation_unconfirmed",
            "已见物理卡仍是 continuation，但它不能成为 validated exhaustion witness"
        );
    }

    #[test]
    fn scroll_terminals_name_the_list_surface_they_came_from() {
        for (surface, reason) in [
            ("group", "feed_exhausted"),
            ("search", "feed_continuation_unconfirmed"),
            ("home", "no_target"),
        ] {
            let (_, output) =
                facebook_scroll_failure_on_surface(EffectPhase::Confirmed, reason, Some(surface));
            let CommandOutput::ActionReceipt(receipt) = output else {
                panic!("scroll failure must be an action receipt");
            };
            assert_eq!(receipt.reason.as_deref(), Some(reason));
            assert_eq!(
                receipt
                    .observation
                    .as_ref()
                    .and_then(|evidence| evidence.surface.as_deref()),
                Some(surface)
            );
        }

        let (_, output) = facebook_scroll_failure(EffectPhase::Confirmed, "no_target");
        let CommandOutput::ActionReceipt(receipt) = output else {
            panic!("scroll failure must be an action receipt");
        };
        assert!(receipt.observation.is_none(), "没有面别可报时不得臆造一个");
    }

    #[test]
    fn lazyload_growth_needs_to_clear_the_reflow_noise_floor() {
        let before = feed_probe(2_400.0, 1_500.0, false, false);
        for jitter in [1.0, 37.0, 99.0] {
            let after = feed_probe(2_400.0 + jitter, 1_500.0, false, false);
            assert!(
                !facebook_feed_height_grew(&before, &after),
                "{jitter}px 抖动不算「页面还在长」"
            );
        }
        for growth in [100.5, 420.0] {
            let after = feed_probe(2_400.0 + growth, 1_500.0, false, false);
            assert!(
                facebook_feed_height_grew(&before, &after),
                "{growth}px 懒加载增量必须算「页面还在长」"
            );
        }
    }

    #[test]
    fn small_reflow_never_blocks_a_group_or_search_bottom_confirmation() {
        for surface in ["group", "search"] {
            let initial = surfaced_feed_probe(surface, 2_400.0, 1_500.0, false, true);
            let reflowed = surfaced_feed_probe(surface, 2_460.0, 1_500.0, false, true);
            assert_eq!(
                classify_facebook_bottom_confirmation(
                    &initial,
                    &reflowed,
                    initial.document_age_ms,
                    5,
                    5,
                ),
                FacebookBottomConfirmationState::ConfirmedEnd,
                "{surface} 上 60px 重排不该把到底确认打掉"
            );
        }
    }
}
