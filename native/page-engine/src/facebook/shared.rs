use crate::commit_window::CommitWindowRequester;
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::model::{ActionReceipt, PublishReceipt};
use crate::probe::ProbeResult;
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

pub(crate) const FACEBOOK_HOME_URL: &str = "https://www.facebook.com/";
pub(crate) const FACEBOOK_DETAIL_HYDRATION_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const FACEBOOK_FEED_SETTLE_NAV: Duration = Duration::from_secs(6);
pub(crate) const FACEBOOK_FEED_SETTLE_IN_PLACE: Duration = Duration::from_millis(3_500);
pub(crate) const FACEBOOK_FEED_SCROLL_ROUNDS: usize = 8;
pub(crate) const FACEBOOK_REFRESH_RELOAD_FLOOR_MS: u64 = 180_000;
pub(crate) const FACEBOOK_JOIN_READY_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const FACEBOOK_JOIN_HYDRATION_SETTLE: Duration = Duration::from_secs(2);
pub(crate) const FACEBOOK_JOIN_POST_CLICK_SETTLE: Duration = Duration::from_millis(1_500);
pub(crate) const FACEBOOK_JOIN_VERIFY_TIMEOUT: Duration = Duration::from_secs(45);
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
    loop {
        let expression = facebook::like_verify_expression(note_id)?;
        let raw = session.cdp.evaluate(&expression, true).await?;
        let probe = facebook::like_verify_from_cdp(&raw)?;
        if !probe.ok {
            return Ok(FacebookReelLikeVerification::Indeterminate);
        }
        if probe.selected {
            return Ok(FacebookReelLikeVerification::Selected);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(FacebookReelLikeVerification::Unchanged);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

pub(crate) async fn wait_for_facebook_like(
    session: &mut EngineSession,
    note_id: &str,
    timeout: Duration,
) -> Result<bool, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let probe = probe_facebook_like(session, note_id).await?;
        if probe.ok && probe.already {
            return Ok(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

pub(crate) async fn probe_facebook_follow(
    session: &mut EngineSession,
    note_id: Option<&str>,
) -> Result<facebook::FacebookFollowProbe, EngineError> {
    let expression = facebook::follow_probe_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::follow_probe_from_cdp(&raw)
}

pub(crate) async fn probe_facebook_comment_editor(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookTextTarget, EngineError> {
    let expression = facebook::comment_editor_probe_expression(note_id)?;
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

pub(crate) async fn probe_facebook_publish_submit(
    session: &mut EngineSession,
) -> Result<facebook::FacebookPublishSubmitProbe, EngineError> {
    let expression = facebook::publish_submit_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::publish_submit_probe_from_cdp(&raw)
}

pub(crate) async fn replace_focused_text(
    session: &mut EngineSession,
    value: &str,
) -> Result<(), EngineError> {
    let modifier = if cfg!(target_os = "macos") { 4 } else { 2 };
    session
        .cdp
        .dispatch_key_with_modifiers("keyDown", "a", "KeyA", 65, modifier)
        .await?;
    session
        .cdp
        .dispatch_key_with_modifiers("keyUp", "a", "KeyA", 65, modifier)
        .await?;
    session
        .cdp
        .dispatch_key("keyDown", "Backspace", "Backspace", 8)
        .await?;
    session
        .cdp
        .dispatch_key("keyUp", "Backspace", "Backspace", 8)
        .await?;
    if !value.is_empty() {
        session.cdp.insert_text(value).await?;
    }
    Ok(())
}

pub(crate) fn normalize_facebook_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

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
        .enter(
            contract.label,
            contract.budget_ms,
            deadline_unix_ms,
            cancellation,
        )
        .await
}

pub(crate) async fn ensure_facebook_action_gate(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<Option<CommandOutput>, EngineError> {
    let probe = probe_facebook_page(session).await?;
    let reason = match probe.blocking_kind.as_deref() {
        Some("login") => Some("login_required"),
        Some("captcha") => Some("blocked_by_captcha"),
        Some("unknown") => Some("blocked_by_unknown"),
        _ => None,
    };
    if let Some(reason) = reason {
        return facebook_gate_failure(session, command, reason).map(Some);
    }

    for _ in 0..3 {
        let consent = probe_facebook_consent(session).await?;
        if !consent.present {
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
            return facebook_gate_failure(session, command, "blocked_by_consent").map(Some);
        };
        dispatch_facebook_click(session, point.cx, point.cy).await?;
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
    if probe_facebook_consent(session).await?.present {
        return facebook_gate_failure(session, command, "blocked_by_consent").map(Some);
    }
    Ok(None)
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

pub(crate) async fn evaluate_facebook_router_until_cards(
    session: &mut EngineSession,
    command: &NativeCommand,
    timeout: Duration,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let latest = evaluate_facebook_router(session, command).await?;
        if matches!(&latest.1, CommandOutput::PageCards(cards) if !cards.cards.is_empty())
            || tokio::time::Instant::now() >= deadline
        {
            return Ok(latest);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
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

pub(crate) async fn verify_facebook_uploaded_preview(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let output = evaluate_facebook_router(session, command).await?;
        let confirmed = matches!(&output.1, CommandOutput::PublishReceipt(receipt) if receipt.ok);
        if confirmed {
            return Ok(output);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok((EffectPhase::Ambiguous, output.1));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
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
        .await
        .map(|_| ())
}

pub(crate) fn facebook_scroll_failure(
    phase: EffectPhase,
    reason: &str,
) -> (EffectPhase, CommandOutput) {
    (
        phase,
        CommandOutput::ActionReceipt(Box::new(ActionReceipt {
            action: "scroll".to_owned(),
            ok: false,
            reason: Some(reason.to_owned()),
            note_id: None,
            observation: None,
            post_observation: None,
            group_observation: None,
            group_url: None,
            clicked: None,
            candidates: Vec::new(),
        })),
    )
}
