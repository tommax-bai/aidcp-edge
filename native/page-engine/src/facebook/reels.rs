use super::feed::execute_facebook_feed_scroll;
use super::shared::*;
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::input::unix_time_ms;
use crate::model::{FacebookListKind, FacebookListState, PostIdentityKind};
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

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
    if fresh.note_id != before.note_id || fresh.author != before.author {
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
        if after.note_id != fresh.note_id || after.author != fresh.author {
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
    if !before.ok || !before.is_keyboard_input_safe() {
        return Ok(facebook_scroll_failure(
            EffectPhase::NotStarted,
            "reels_target_unavailable",
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
        FACEBOOK_REEL_IDENTITY_HYDRATION_TIMEOUT,
    )
    .await?
    {
        return Ok((EffectPhase::Confirmed, output));
    }

    let fresh = probe_facebook_reel(session).await?;
    if !fresh.is_reels_surface() {
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            "reels_entry_unconfirmed",
        ));
    }
    if !fresh.ok || !fresh.is_explicitly_keyboard_input_safe() {
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            "reels_target_unavailable",
        ));
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

async fn execute_facebook_reel_navigation(
    session: &mut EngineSession,
    command: &NativeCommand,
    before: facebook::FacebookReelProbe,
    mode: ReelNavigationMode,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let navigation = probe_facebook_reel_next_target(session).await?;
    let Some(axis) = navigation.axis else {
        return Ok(facebook_scroll_failure(
            navigation_failure_phase(mode, false),
            "reels_target_unavailable",
        ));
    };
    if !reel_navigation_probe_matches_active(&navigation, &before)
        || (mode == ReelNavigationMode::AnonymousEntry
            && !navigation.is_explicitly_keyboard_input_safe())
    {
        return Ok(facebook_scroll_failure(
            navigation_failure_phase(mode, false),
            "reels_target_unavailable",
        ));
    }
    if let Some(result) = reel_write_gate(cancellation, deadline_unix_ms, mode)? {
        return Ok(result);
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

    if let Some(output) = wait_for_canonical_facebook_reel_card(
        session,
        command,
        &before,
        true,
        FACEBOOK_REEL_IDENTITY_HYDRATION_TIMEOUT,
    )
    .await?
    {
        return Ok((EffectPhase::Confirmed, output));
    }

    let current = probe_facebook_reel(session).await?;
    let reason = if canonical_reel_id(current.note_id.as_deref()).is_none() {
        "reels_identity_unresolved"
    } else {
        "reels_navigation_unconfirmed"
    };
    Ok(facebook_scroll_failure(EffectPhase::Ambiguous, reason))
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

async fn wait_for_canonical_facebook_reel_card(
    session: &mut EngineSession,
    command: &NativeCommand,
    previous: &facebook::FacebookReelProbe,
    require_movement: bool,
    timeout: Duration,
) -> Result<Option<CommandOutput>, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(output) =
            read_canonical_facebook_reel_card(session, command, previous, require_movement).await?
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
) -> Result<Option<CommandOutput>, EngineError> {
    let (output, current) = read_facebook_reel_card_snapshot(session, command).await?;
    Ok(
        canonical_facebook_reel_card_matches(&output, &current, previous, require_movement)
            .then_some(output),
    )
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
) -> bool {
    let CommandOutput::PageCards(cards) = output else {
        return false;
    };
    if cards.list_kind != Some(FacebookListKind::Reels)
        || cards.list_state != Some(FacebookListState::Ready)
        || cards.cards.len() != 1
        || !current.ok
    {
        return false;
    }
    let card = &cards.cards[0];
    if card.is_video != Some(true)
        || !matches!(card.note_id_kind, Some(PostIdentityKind::Permalink) | None)
    {
        return false;
    }
    let (Some(current_id), Some(card_id)) = (
        canonical_reel_id(current.note_id.as_deref()),
        canonical_reel_id(card.note_id.as_deref()),
    ) else {
        return false;
    };
    if current_id != card_id {
        return false;
    }
    if !require_movement {
        return true;
    }
    canonical_reel_id(previous.note_id.as_deref()).as_ref() != Some(&current_id)
}

fn canonical_reel_id(note_id: Option<&str>) -> Option<String> {
    note_id
        .filter(|value| is_facebook_reel_url(value))
        .and_then(canonical_facebook_post_id)
}

fn reel_write_gate(
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
    mode: ReelNavigationMode,
) -> Result<Option<(EffectPhase, CommandOutput)>, EngineError> {
    if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
        return Ok(Some(facebook_scroll_failure(
            navigation_failure_phase(mode, false),
            "reels_navigation_cancelled",
        )));
    }
    if mode == ReelNavigationMode::AnonymousEntry
        && deadline_unix_ms.saturating_sub(unix_time_ms())
            < FACEBOOK_REEL_ENTRY_POST_INPUT_RESERVE_MS
    {
        return Ok(Some(facebook_scroll_failure(
            navigation_failure_phase(mode, false),
            "reels_navigation_deadline_insufficient",
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

fn reel_navigation_probe_matches_active(
    target: &facebook::FacebookReelNextTarget,
    previous: &facebook::FacebookReelProbe,
) -> bool {
    target.ok
        && target.is_keyboard_input_safe()
        && !target.ambiguous
        && canonical_reel_id(target.note_id.as_deref())
            == canonical_reel_id(previous.note_id.as_deref())
}

pub(crate) fn reel_forward_key(axis: facebook::FacebookReelAxis) -> (&'static str, u32) {
    match axis {
        facebook::FacebookReelAxis::Vertical => ("ArrowDown", 40),
        facebook::FacebookReelAxis::Horizontal => ("ArrowRight", 39),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FacebookListState, PageCard, PageCards};

    fn reel_probe(note_id: Option<&str>) -> facebook::FacebookReelProbe {
        facebook::FacebookReelProbe {
            ok: true,
            reason: None,
            note_id: note_id.map(str::to_owned),
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
    fn canonical_reel_completion_uses_only_note_identity() {
        let anonymous = reel_probe(None);
        let first = reel_probe(Some("https://www.facebook.com/reel/1"));
        let second = reel_probe(Some("https://www.facebook.com/reel/2"));
        let first_card = reel_cards("https://www.facebook.com/reel/1", None, 1);
        let second_card = reel_cards("https://www.facebook.com/reel/2", None, 1);

        assert!(canonical_facebook_reel_card_matches(
            &first_card,
            &first,
            &anonymous,
            false,
        ));
        assert!(canonical_facebook_reel_card_matches(
            &first_card,
            &first,
            &anonymous,
            true,
        ));
        assert!(!canonical_facebook_reel_card_matches(
            &first_card,
            &first,
            &first,
            true,
        ));
        assert!(canonical_facebook_reel_card_matches(
            &second_card,
            &second,
            &first,
            true,
        ));
    }

    #[test]
    fn canonical_reel_completion_rejects_malformed_or_mismatched_cards() {
        let before = reel_probe(Some("https://www.facebook.com/reel/1"));
        let current = reel_probe(Some("https://www.facebook.com/reel/2"));

        let multiple = reel_cards("https://www.facebook.com/reel/2", None, 2);
        assert!(!canonical_facebook_reel_card_matches(
            &multiple, &current, &before, true,
        ));

        let mismatched = reel_cards("https://www.facebook.com/reel/3", None, 1);
        assert!(!canonical_facebook_reel_card_matches(
            &mismatched,
            &current,
            &before,
            true,
        ));

        let content_ref = reel_cards(
            "facebook-content-ref:session:2",
            Some(PostIdentityKind::ContentRef),
            1,
        );
        let content_ref_probe = reel_probe(Some("facebook-content-ref:session:2"));
        assert!(!canonical_facebook_reel_card_matches(
            &content_ref,
            &content_ref_probe,
            &before,
            true,
        ));
    }

    #[test]
    fn cancelled_navigation_terminates_without_input_state() {
        let cancelled = AtomicBool::new(true);
        let (phase, output) =
            reel_write_gate(Some(&cancelled), u64::MAX, ReelNavigationMode::Standard)
                .expect("navigation gate")
                .expect("cancelled receipt");
        assert_eq!(phase, EffectPhase::NotStarted);
        let CommandOutput::ActionReceipt(receipt) = output else {
            panic!("expected cancellation receipt")
        };
        assert_eq!(
            receipt.reason.as_deref(),
            Some("reels_navigation_cancelled")
        );
    }
}
