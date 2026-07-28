use super::reels::execute_facebook_page_scroll;
use super::shared::*;
use crate::command::{NoteOpenParams, NotePurpose, NoteSurface};
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::input::{WheelInputFailure, dispatch_wheel_humanized};
use crate::model::{PageCards, PageMovement};
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

const FACEBOOK_FEED_RECOVERY_TIMEOUT: Duration = Duration::from_secs(8);
/// 恢复等待必须给「把诚实回执交出去」留出的余量。
///
/// 这一层是本 change 的核心命题在小尺度上的复现：**外层原子上限先到点，会把一个具名回执
/// （feed_recovery_navigation_unconfirmed）改判成信息量更低的合成 CdpTimeout。**
/// 250ms 只够无争用时的一次返回；机器有负载时（并发跑测试、生产上多环境并行）光调度抖动
/// 就能吃掉它，于是「偶发」退化成合成失败。取 1s：相对 8s 恢复窗仍是小头，却扛得住抖动。
const FACEBOOK_FEED_RECOVERY_RECEIPT_MARGIN: Duration = Duration::from_millis(1_000);

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
            if params.reason.as_deref() == Some("empty_feed_reels_fallback") =>
        {
            session
                .cdp
                .navigate("https://www.facebook.com/reels/")
                .await?;
            wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
            evaluate_facebook_router_until_cards(session, command, Duration::from_secs(5)).await
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

    let mut last = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_NAV).await?;
    last = match recover_facebook_feed_prompt(session, last, cancellation, deadline_unix_ms).await?
    {
        FacebookFeedRecovery::Continue(probe) => probe,
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
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    ensure_facebook_active_list(session).await?;
    let command = NativeCommand::PageScroll(crate::command::PageScrollParams {
        reason: None,
        dwell_ms: None,
    });
    if let Some(output) = ensure_facebook_action_gate(session, &command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    let mut current = probe_facebook_feed(session).await?;
    current = match recover_facebook_feed_prompt(session, current, cancellation, deadline_unix_ms)
        .await?
    {
        FacebookFeedRecovery::Continue(probe) => probe,
        FacebookFeedRecovery::Failure(phase, reason) => {
            return Ok(facebook_scroll_failure(phase, reason));
        }
    };
    let start_y = current.scroll_y;
    let mut saw_any_card = !current.cards.is_empty();

    for _ in 0..FACEBOOK_FEED_SCROLL_ROUNDS {
        let before = current;
        dispatch_facebook_feed_wheel(session, &before, cancellation, deadline_unix_ms).await?;
        let after = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_IN_PLACE).await?;
        saw_any_card |= !after.cards.is_empty();
        let movement = PageMovement {
            before: start_y,
            after: after.scroll_y,
            moved: after.scroll_y != start_y,
            at_bottom: Some(facebook_near_bottom(&after)),
        };
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

        let (confirmation, confirmed) = confirm_facebook_feed_bottom(session, &after).await?;
        saw_any_card |= !confirmed.cards.is_empty();
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
        if let Some(reason) = facebook_bottom_completion_reason(confirmation) {
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
    ExplicitEnd,
    WindowStable,
}

fn facebook_bottom_completion_reason(
    state: FacebookBottomConfirmationState,
) -> Option<&'static str> {
    match state {
        FacebookBottomConfirmationState::ExplicitEnd => Some("feed_exhausted"),
        FacebookBottomConfirmationState::WindowStable => Some("feed_continuation_unconfirmed"),
        FacebookBottomConfirmationState::Waiting | FacebookBottomConfirmationState::Invalidated => {
            None
        }
    }
}

fn facebook_feed_card_identities(probe: &facebook::FacebookFeedProbe) -> Vec<String> {
    probe
        .cards
        .iter()
        .filter_map(|card| card.note_id.as_deref().and_then(canonical_facebook_post_id))
        .collect()
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

fn facebook_feed_height_grew(
    before: &facebook::FacebookFeedProbe,
    after: &facebook::FacebookFeedProbe,
) -> bool {
    after.scroll_height > before.scroll_height + FACEBOOK_FEED_LAZYLOAD_GROWTH_PX
}

fn classify_facebook_bottom_confirmation(
    initial: &facebook::FacebookFeedProbe,
    current: &facebook::FacebookFeedProbe,
    explicit_end_samples: usize,
    elapsed: Duration,
    confirmation_window: Duration,
) -> FacebookBottomConfirmationState {
    let same_generation =
        current.url == initial.url && current.document_generation == initial.document_generation;
    // 面别条件：两次探测都在**已声明的列表面**上，且确认窗内不许换面。
    // 只放开循环里的守卫而不动这里，确认会照样判无效 → 到底状态依然不可达。
    let invalidated = !facebook_list_surface(&initial.surface)
        || initial.surface != current.surface
        || !same_generation
        || current.loading
        || !facebook_near_bottom(current)
        || facebook_feed_height_grew(initial, current)
        || facebook_feed_card_identities(current) != facebook_feed_card_identities(initial);
    if invalidated {
        return FacebookBottomConfirmationState::Invalidated;
    }
    if current.explicit_end && explicit_end_samples >= 2 {
        return FacebookBottomConfirmationState::ExplicitEnd;
    }
    if elapsed >= confirmation_window {
        return FacebookBottomConfirmationState::WindowStable;
    }
    FacebookBottomConfirmationState::Waiting
}

async fn confirm_facebook_feed_bottom(
    session: &mut EngineSession,
    initial: &facebook::FacebookFeedProbe,
) -> Result<(FacebookBottomConfirmationState, facebook::FacebookFeedProbe), EngineError> {
    let started = tokio::time::Instant::now();
    let deadline = started + FACEBOOK_FEED_SETTLE_IN_PLACE;
    let mut explicit_end_samples = usize::from(initial.explicit_end);
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let current = probe_facebook_feed(session).await?;
        explicit_end_samples = if current.explicit_end {
            explicit_end_samples + 1
        } else {
            0
        };
        let state = classify_facebook_bottom_confirmation(
            initial,
            &current,
            explicit_end_samples,
            started.elapsed(),
            FACEBOOK_FEED_SETTLE_IN_PLACE,
        );
        if state != FacebookBottomConfirmationState::Waiting {
            return Ok((state, current));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok((FacebookBottomConfirmationState::WindowStable, current));
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
    Continue(facebook::FacebookFeedProbe),
    Failure(EffectPhase, &'static str),
}

async fn recover_facebook_feed_prompt(
    session: &mut EngineSession,
    current: facebook::FacebookFeedProbe,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<FacebookFeedRecovery, EngineError> {
    let Some(observed) = current.feed_recovery_target.as_ref() else {
        return Ok(FacebookFeedRecovery::Continue(current));
    };
    if !observed.ok {
        return Ok(match observed.reason.as_deref() {
            None | Some("no_feed_recovery_target") => FacebookFeedRecovery::Continue(current),
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

    // 前台化可能引发布局重排，因此坐标必须在 bringToFront 之后重新读取，不能使用 feed_probe 的旧点位。
    session.cdp.bring_to_front().await?;
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
            return Ok(FacebookFeedRecovery::Continue(probe));
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
    let mut cards = Vec::new();
    for mut card in probe.cards {
        let Some(identity) = card.note_id.as_deref().and_then(canonical_facebook_post_id) else {
            continue;
        };
        let is_new = session.facebook.seen_post_ids.insert(identity);
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
        && probe.inner_height > 0.0
        && probe.scroll_height - probe.scroll_y - probe.inner_height <= probe.inner_height.max(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FacebookListKind, FacebookListState};

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
            document_age_ms: 10_000,
            feed_recovery_target: None,
        }
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
            is_video: None,
        }];
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
            classify_facebook_bottom_confirmation(
                &initial,
                &grown,
                0,
                FACEBOOK_FEED_SETTLE_IN_PLACE,
                FACEBOOK_FEED_SETTLE_IN_PLACE,
            ),
            FacebookBottomConfirmationState::Invalidated
        );
    }

    #[test]
    fn stable_bottom_without_a_marker_is_non_terminal_after_the_complete_window() {
        let initial = feed_probe(2_400.0, 1_500.0, false, false);
        let stable = initial.clone();

        assert_eq!(
            classify_facebook_bottom_confirmation(
                &initial,
                &stable,
                0,
                FACEBOOK_FEED_SETTLE_IN_PLACE - Duration::from_millis(1),
                FACEBOOK_FEED_SETTLE_IN_PLACE,
            ),
            FacebookBottomConfirmationState::Waiting
        );
        assert_eq!(
            classify_facebook_bottom_confirmation(
                &initial,
                &stable,
                0,
                FACEBOOK_FEED_SETTLE_IN_PLACE,
                FACEBOOK_FEED_SETTLE_IN_PLACE,
            ),
            FacebookBottomConfirmationState::WindowStable
        );
        assert_eq!(
            facebook_bottom_completion_reason(FacebookBottomConfirmationState::WindowStable),
            Some("feed_continuation_unconfirmed")
        );
    }

    #[test]
    fn stable_explicit_end_marker_is_terminal_on_home_bottom() {
        let initial = feed_probe(2_400.0, 1_500.0, false, false);
        let terminal = feed_probe(2_400.0, 1_500.0, false, true);

        assert_eq!(
            classify_facebook_bottom_confirmation(
                &initial,
                &terminal,
                2,
                Duration::from_millis(500),
                FACEBOOK_FEED_SETTLE_IN_PLACE,
            ),
            FacebookBottomConfirmationState::ExplicitEnd
        );
        assert_eq!(
            facebook_bottom_completion_reason(FacebookBottomConfirmationState::ExplicitEnd),
            Some("feed_exhausted")
        );
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
            let initial = surfaced_feed_probe(surface, 2_400.0, 1_500.0, false, false);
            let terminal = surfaced_feed_probe(surface, 2_400.0, 1_500.0, false, true);
            assert_eq!(
                classify_facebook_bottom_confirmation(
                    &initial,
                    &terminal,
                    2,
                    Duration::from_millis(500),
                    FACEBOOK_FEED_SETTLE_IN_PLACE,
                ),
                FacebookBottomConfirmationState::ExplicitEnd,
                "{surface} must be able to reach an explicit end"
            );

            let stable = initial.clone();
            assert_eq!(
                classify_facebook_bottom_confirmation(
                    &initial,
                    &stable,
                    0,
                    FACEBOOK_FEED_SETTLE_IN_PLACE,
                    FACEBOOK_FEED_SETTLE_IN_PLACE,
                ),
                FacebookBottomConfirmationState::WindowStable,
                "{surface} must be able to reach a stable window"
            );
        }
    }

    #[test]
    fn a_surface_change_inside_the_confirmation_window_still_invalidates_it() {
        let initial = surfaced_feed_probe("group", 2_400.0, 1_500.0, false, true);
        let moved = surfaced_feed_probe("home", 2_400.0, 1_500.0, false, true);
        assert_eq!(
            classify_facebook_bottom_confirmation(
                &initial,
                &moved,
                2,
                Duration::from_millis(500),
                FACEBOOK_FEED_SETTLE_IN_PLACE,
            ),
            FacebookBottomConfirmationState::Invalidated
        );

        let detail = surfaced_feed_probe("group_post", 2_400.0, 1_500.0, false, true);
        assert_eq!(
            classify_facebook_bottom_confirmation(
                &detail,
                &detail.clone(),
                2,
                Duration::from_millis(500),
                FACEBOOK_FEED_SETTLE_IN_PLACE,
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
                    2,
                    Duration::from_millis(500),
                    FACEBOOK_FEED_SETTLE_IN_PLACE,
                ),
                FacebookBottomConfirmationState::ExplicitEnd,
                "{surface} 上 60px 重排不该把到底确认打掉"
            );
        }
    }
}
