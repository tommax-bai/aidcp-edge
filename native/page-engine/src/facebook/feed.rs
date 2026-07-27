use super::reels::execute_facebook_page_scroll;
use super::shared::*;
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::input::{WheelInputFailure, dispatch_wheel_humanized};
use crate::model::{PageCards, PageMovement};
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

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

    if last.article_count > 0 {
        let cards = facebook_page_cards(session, last, false, None);
        return Ok((EffectPhase::Confirmed, CommandOutput::PageCards(cards)));
    }
    if confirm_facebook_home_empty(session, &last).await? {
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
        if grew || !facebook_near_bottom(&after) || after.surface != "home" {
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
            return Ok(facebook_scroll_failure(EffectPhase::Confirmed, reason));
        }
        current = confirmed;
    }

    Ok(facebook_scroll_failure(
        EffectPhase::Confirmed,
        facebook_unconfirmed_scroll_reason(saw_any_card, &current),
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

async fn ensure_facebook_active_list(session: &mut EngineSession) -> Result<(), EngineError> {
    let probe = probe_facebook_feed(session).await?;
    let on_list = matches!(probe.surface.as_str(), "home" | "search" | "group");
    if !on_list || probe.url != session.facebook.active_list_url {
        let target = session.facebook.active_list_url.clone();
        session.cdp.navigate(&target).await?;
        wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    }
    Ok(())
}

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
        if stable && !current.loading {
            return Ok(current);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(current);
        }
        previous = Some(key);
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
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

fn facebook_feed_height_grew(
    before: &facebook::FacebookFeedProbe,
    after: &facebook::FacebookFeedProbe,
) -> bool {
    after.scroll_height > before.scroll_height + 1.0
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
    let invalidated = initial.surface != "home"
        || current.surface != "home"
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
    } else if saw_any_card && current.surface == "home" {
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
        }
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
}
