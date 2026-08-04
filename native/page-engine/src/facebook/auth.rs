use crate::command::{
    FacebookAuthProbeParams, FacebookAuthSignalParams, FacebookAuthTotpEntryParams,
    FacebookAuthTotpWindowParams,
};
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::input::{
    GuardedTextInputFailure, PointerClickOptions, PointerInputFailure, TextInputFailure,
    dispatch_pointer_click, insert_text_guarded,
};
use crate::model::{FacebookAuthActionReceipt, FacebookAuthProbeReceipt, FacebookAuthSignal};
use crate::protocol::{EffectPhase, NativeCommand};
use serde::Deserialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const AUTH_SIGNAL_PREFIX: &str = "aidcp:facebook-auth:v1:";
const AUTH_SIGNAL_DIGEST_LEN: usize = 64;
const AUTH_REASON_MAX_BYTES: usize = 256;
const AUTH_DOCUMENT_MAX_BYTES: usize = 512;
const MAX_CONSUMED_AUTH_SIGNALS: usize = 64;
const TOTP_VALIDITY_FLOOR_MS: u64 = 10_000;
const POSTCONDITION_POLL_MS: u64 = 200;
const POSTCONDITION_MAX_POLLS: usize = 35;
const SUCCESSOR_POSTCONDITION_MAX_POLLS: usize = 150;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FacebookAuthCandidate {
    candidate_key: String,
    cx: f64,
    cy: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FacebookAuthObservation {
    signal: FacebookAuthSignal,
    #[serde(default)]
    signal_id: Option<String>,
    document_generation: String,
    #[serde(default)]
    candidate: Option<FacebookAuthCandidate>,
    #[serde(default)]
    server_epoch_ms: Option<u64>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FacebookAuthTotpReadback {
    bound: bool,
    empty: bool,
    length: usize,
    matches: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FacebookAuthPostcondition {
    satisfied: bool,
    document_changed: bool,
    signal_gone: bool,
    #[serde(default)]
    successor_observed: bool,
    #[serde(default)]
    loading_observed: bool,
    #[serde(default)]
    button_state_changed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FacebookAuthPostconditionVerification {
    confirmed: bool,
    transition_observed: bool,
}

pub(crate) async fn execute(
    session: &mut EngineSession,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    match command {
        NativeCommand::FacebookAuthProbe(params) => {
            let observation = probe(session, params).await?;
            Ok((
                EffectPhase::Confirmed,
                CommandOutput::FacebookAuthProbe(
                    FacebookAuthProbeReceipt {
                        signal: observation.signal,
                        signal_id: observation.signal_id,
                        server_epoch_ms: observation.server_epoch_ms,
                        reason: observation.reason,
                    }
                    .bounded(),
                ),
            ))
        }
        NativeCommand::FacebookAuthSubmitLogin(params) => {
            execute_click(
                session,
                command,
                params,
                FacebookAuthSignal::LoginSubmitReady,
                action_probe_params(),
                cancellation,
                deadline_unix_ms,
            )
            .await
        }
        NativeCommand::FacebookAuthEnterTotp(params) => {
            execute_totp_entry(session, command, params, cancellation, deadline_unix_ms).await
        }
        NativeCommand::FacebookAuthSubmitTotp(params) => {
            execute_totp_submit(session, command, params, cancellation, deadline_unix_ms).await
        }
        NativeCommand::FacebookAuthClearTotp(params) => {
            execute_totp_clear(session, command, params, cancellation, deadline_unix_ms).await
        }
        NativeCommand::FacebookAuthDismissWarning(params) => {
            execute_click(
                session,
                command,
                params,
                FacebookAuthSignal::AutomationWarningDismiss,
                action_probe_params(),
                cancellation,
                deadline_unix_ms,
            )
            .await
        }
        NativeCommand::FacebookAuthClosePushBlocker(params) => {
            execute_click(
                session,
                command,
                params,
                FacebookAuthSignal::PushBlockerClose,
                action_probe_params(),
                cancellation,
                deadline_unix_ms,
            )
            .await
        }
        NativeCommand::FacebookAuthConfirmRememberPassword(params) => {
            execute_click(
                session,
                command,
                params,
                FacebookAuthSignal::RememberPasswordConfirm,
                action_probe_params(),
                cancellation,
                deadline_unix_ms,
            )
            .await
        }
        NativeCommand::FacebookAuthStartAdDataReview(params) => {
            execute_click(
                session,
                command,
                params,
                FacebookAuthSignal::AdDataReviewGetStarted,
                action_probe_params(),
                cancellation,
                deadline_unix_ms,
            )
            .await
        }
        NativeCommand::FacebookAuthStartSuspensionAppeal(params) => {
            execute_click(
                session,
                command,
                params,
                FacebookAuthSignal::SuspensionAppealStart,
                action_probe_params(),
                cancellation,
                deadline_unix_ms,
            )
            .await
        }
        _ => Err(EngineError::new(
            ErrorCode::EngineInternal,
            "native Facebook auth capability received another owner's command",
        )),
    }
}

async fn execute_click(
    session: &mut EngineSession,
    command: &NativeCommand,
    params: &FacebookAuthSignalParams,
    expected_signal: FacebookAuthSignal,
    probe_params: FacebookAuthProbeParams,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let observation = match fresh_action_observation(
        session,
        command,
        &params.signal_id,
        expected_signal,
        &probe_params,
        cancellation,
        deadline_unix_ms,
    )
    .await?
    {
        FreshObservation::Ready(observation) => observation,
        FreshObservation::Refused(reason) => {
            return Ok(action_result(
                command,
                &params.signal_id,
                EffectPhase::NotStarted,
                false,
                reason,
            ));
        }
    };
    let candidate = observation
        .candidate
        .as_ref()
        .expect("validated actionable auth signal must carry a candidate");
    reserve_signal(session, &params.signal_id);
    if let Err(failure) = dispatch_pointer_click(
        &mut session.cdp,
        candidate.cx,
        candidate.cy,
        PointerClickOptions::default(),
        cancellation,
        deadline_unix_ms,
    )
    .await
    {
        return Ok(pointer_failure_result(command, &params.signal_id, failure));
    }
    match verify_postcondition(
        session,
        &observation.document_generation,
        expected_signal,
        &candidate.candidate_key,
        cancellation,
        deadline_unix_ms,
    )
    .await
    {
        Ok(FacebookAuthPostconditionVerification {
            confirmed: true, ..
        }) => Ok(action_result(
            command,
            &params.signal_id,
            EffectPhase::Confirmed,
            true,
            None,
        )),
        Ok(verification) => {
            let reason = postcondition_failure_reason(expected_signal, verification);
            Ok(action_result(
                command,
                &params.signal_id,
                EffectPhase::Ambiguous,
                false,
                Some(reason),
            ))
        }
        Err(_) => Ok(action_result(
            command,
            &params.signal_id,
            EffectPhase::Ambiguous,
            false,
            Some("auth_postcondition_unreadable"),
        )),
    }
}

fn postcondition_failure_reason(
    expected_signal: FacebookAuthSignal,
    verification: FacebookAuthPostconditionVerification,
) -> &'static str {
    let successor_action = matches!(
        expected_signal,
        FacebookAuthSignal::AdDataReviewGetStarted | FacebookAuthSignal::SuspensionAppealStart
    );
    if successor_action && verification.transition_observed {
        "auth_successor_unconfirmed"
    } else {
        "auth_postcondition_unconfirmed"
    }
}

async fn execute_totp_entry(
    session: &mut EngineSession,
    command: &NativeCommand,
    params: &FacebookAuthTotpEntryParams,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let observation = match fresh_action_observation(
        session,
        command,
        &params.signal_id,
        FacebookAuthSignal::TotpEntryReady,
        &action_probe_params(),
        cancellation,
        deadline_unix_ms,
    )
    .await?
    {
        FreshObservation::Ready(observation) => observation,
        FreshObservation::Refused(reason) => {
            return Ok(action_result(
                command,
                &params.signal_id,
                EffectPhase::NotStarted,
                false,
                reason,
            ));
        }
    };
    if !totp_window_is_fresh(
        observation.server_epoch_ms,
        params.totp_window_start_unix_ms,
        params.totp_window_end_unix_ms,
    ) {
        return Ok(action_result(
            command,
            &params.signal_id,
            EffectPhase::NotStarted,
            false,
            Some("totp_window_too_short_or_changed"),
        ));
    }
    let candidate = observation
        .candidate
        .as_ref()
        .expect("validated TOTP entry signal must carry a candidate");
    reserve_signal(session, &params.signal_id);
    if let Err(failure) = dispatch_pointer_click(
        &mut session.cdp,
        candidate.cx,
        candidate.cy,
        PointerClickOptions::default(),
        cancellation,
        deadline_unix_ms,
    )
    .await
    {
        return Ok(pointer_failure_result(command, &params.signal_id, failure));
    }
    let guard = facebook::auth_focus_guard_expression(
        &observation.document_generation,
        &candidate.candidate_key,
    )?;
    if let Err(failure) = insert_text_guarded(
        &mut session.cdp,
        &params.totp_code,
        cancellation,
        deadline_unix_ms,
        &guard,
    )
    .await
    {
        return Ok(text_failure_result(command, &params.signal_id, failure));
    }
    let readback = read_totp(
        session,
        &observation.document_generation,
        &candidate.candidate_key,
        Some(&params.totp_code),
    )
    .await;
    match readback {
        Ok(value) if value.bound && value.matches && value.length == 6 && !value.empty => {
            Ok(action_result(
                command,
                &params.signal_id,
                EffectPhase::Confirmed,
                true,
                None,
            ))
        }
        Ok(_) => Ok(action_result(
            command,
            &params.signal_id,
            EffectPhase::Ambiguous,
            false,
            Some("totp_entry_readback_mismatch"),
        )),
        Err(_) => Ok(action_result(
            command,
            &params.signal_id,
            EffectPhase::Ambiguous,
            false,
            Some("totp_entry_readback_unavailable"),
        )),
    }
}

async fn execute_totp_submit(
    session: &mut EngineSession,
    command: &NativeCommand,
    params: &FacebookAuthTotpWindowParams,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let probe_params = FacebookAuthProbeParams {
        allow_auth_actions: true,
        entered_totp_window_start_unix_ms: Some(params.totp_window_start_unix_ms),
        entered_totp_window_end_unix_ms: Some(params.totp_window_end_unix_ms),
    };
    let observation = match fresh_action_observation(
        session,
        command,
        &params.signal_id,
        FacebookAuthSignal::TotpSubmitReady,
        &probe_params,
        cancellation,
        deadline_unix_ms,
    )
    .await?
    {
        FreshObservation::Ready(observation) => observation,
        FreshObservation::Refused(reason) => {
            return Ok(action_result(
                command,
                &params.signal_id,
                EffectPhase::NotStarted,
                false,
                reason,
            ));
        }
    };
    if !totp_window_is_fresh(
        observation.server_epoch_ms,
        params.totp_window_start_unix_ms,
        params.totp_window_end_unix_ms,
    ) {
        return Ok(action_result(
            command,
            &params.signal_id,
            EffectPhase::NotStarted,
            false,
            Some("totp_window_too_short_or_changed"),
        ));
    }
    execute_click_with_observation(
        session,
        command,
        &params.signal_id,
        FacebookAuthSignal::TotpSubmitReady,
        observation,
        cancellation,
        deadline_unix_ms,
    )
    .await
}

async fn execute_totp_clear(
    session: &mut EngineSession,
    command: &NativeCommand,
    params: &FacebookAuthTotpWindowParams,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    // Clearing must fresh-probe the unchanged field as clear-only evidence. Supplying an entered
    // window here would turn an arbitrary complete orphan value into submit-ready evidence.
    let probe_params = action_probe_params();
    let observation = match fresh_action_observation(
        session,
        command,
        &params.signal_id,
        FacebookAuthSignal::TotpRefreshRequired,
        &probe_params,
        cancellation,
        deadline_unix_ms,
    )
    .await?
    {
        FreshObservation::Ready(observation) => observation,
        FreshObservation::Refused(reason) => {
            return Ok(action_result(
                command,
                &params.signal_id,
                EffectPhase::NotStarted,
                false,
                reason,
            ));
        }
    };
    let candidate = observation
        .candidate
        .as_ref()
        .expect("validated TOTP refresh signal must carry a candidate");
    reserve_signal(session, &params.signal_id);
    if let Err(failure) = dispatch_pointer_click(
        &mut session.cdp,
        candidate.cx,
        candidate.cy,
        PointerClickOptions::default(),
        cancellation,
        deadline_unix_ms,
    )
    .await
    {
        return Ok(pointer_failure_result(command, &params.signal_id, failure));
    }
    for (event_type, key, code, virtual_key) in [
        ("rawKeyDown", "End", "End", 35),
        ("keyUp", "End", "End", 35),
    ] {
        if action_cancelled_or_expired(cancellation, deadline_unix_ms) {
            return Ok(action_result(
                command,
                &params.signal_id,
                EffectPhase::Ambiguous,
                false,
                Some("totp_clear_interrupted_after_input"),
            ));
        }
        if session
            .cdp
            .dispatch_key(event_type, key, code, virtual_key)
            .await
            .is_err()
        {
            return Ok(action_result(
                command,
                &params.signal_id,
                EffectPhase::Ambiguous,
                false,
                Some("totp_clear_key_dispatch_failed"),
            ));
        }
    }
    for _ in 0..12 {
        if action_cancelled_or_expired(cancellation, deadline_unix_ms) {
            return Ok(action_result(
                command,
                &params.signal_id,
                EffectPhase::Ambiguous,
                false,
                Some("totp_clear_interrupted_after_input"),
            ));
        }
        for event_type in ["rawKeyDown", "keyUp"] {
            if session
                .cdp
                .dispatch_key(event_type, "Backspace", "Backspace", 8)
                .await
                .is_err()
            {
                return Ok(action_result(
                    command,
                    &params.signal_id,
                    EffectPhase::Ambiguous,
                    false,
                    Some("totp_clear_key_dispatch_failed"),
                ));
            }
        }
    }
    match read_totp(
        session,
        &observation.document_generation,
        &candidate.candidate_key,
        None,
    )
    .await
    {
        Ok(value) if value.bound && value.empty && value.length == 0 => Ok(action_result(
            command,
            &params.signal_id,
            EffectPhase::Confirmed,
            true,
            None,
        )),
        Ok(_) => Ok(action_result(
            command,
            &params.signal_id,
            EffectPhase::Ambiguous,
            false,
            Some("totp_clear_readback_mismatch"),
        )),
        Err(_) => Ok(action_result(
            command,
            &params.signal_id,
            EffectPhase::Ambiguous,
            false,
            Some("totp_clear_readback_unavailable"),
        )),
    }
}

async fn execute_click_with_observation(
    session: &mut EngineSession,
    command: &NativeCommand,
    signal_id: &str,
    expected_signal: FacebookAuthSignal,
    observation: FacebookAuthObservation,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let candidate = observation
        .candidate
        .as_ref()
        .expect("validated actionable auth signal must carry a candidate");
    reserve_signal(session, signal_id);
    if let Err(failure) = dispatch_pointer_click(
        &mut session.cdp,
        candidate.cx,
        candidate.cy,
        PointerClickOptions::default(),
        cancellation,
        deadline_unix_ms,
    )
    .await
    {
        return Ok(pointer_failure_result(command, signal_id, failure));
    }
    match verify_postcondition(
        session,
        &observation.document_generation,
        expected_signal,
        &candidate.candidate_key,
        cancellation,
        deadline_unix_ms,
    )
    .await
    {
        Ok(FacebookAuthPostconditionVerification {
            confirmed: true, ..
        }) => Ok(action_result(
            command,
            signal_id,
            EffectPhase::Confirmed,
            true,
            None,
        )),
        Ok(verification) => Ok(action_result(
            command,
            signal_id,
            EffectPhase::Ambiguous,
            false,
            Some(if verification.transition_observed {
                "auth_successor_unconfirmed"
            } else {
                "auth_postcondition_unconfirmed"
            }),
        )),
        Err(_) => Ok(action_result(
            command,
            signal_id,
            EffectPhase::Ambiguous,
            false,
            Some("auth_postcondition_unreadable"),
        )),
    }
}

enum FreshObservation {
    Ready(FacebookAuthObservation),
    Refused(Option<&'static str>),
}

async fn fresh_action_observation(
    session: &mut EngineSession,
    _command: &NativeCommand,
    signal_id: &str,
    expected_signal: FacebookAuthSignal,
    probe_params: &FacebookAuthProbeParams,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<FreshObservation, EngineError> {
    if session
        .facebook
        .consumed_auth_signal_ids
        .contains(signal_id)
    {
        return Ok(FreshObservation::Refused(Some(
            "auth_signal_already_consumed",
        )));
    }
    if session.facebook.consumed_auth_signal_ids.len() >= MAX_CONSUMED_AUTH_SIGNALS {
        return Ok(FreshObservation::Refused(Some(
            "auth_signal_budget_exhausted",
        )));
    }
    if action_cancelled_or_expired(cancellation, deadline_unix_ms) {
        return Ok(FreshObservation::Refused(Some(
            "auth_action_cancelled_or_expired",
        )));
    }
    let observation = probe(session, probe_params).await?;
    if observation.signal != expected_signal || observation.signal_id.as_deref() != Some(signal_id)
    {
        return Ok(FreshObservation::Refused(Some("stale_auth_signal")));
    }
    Ok(FreshObservation::Ready(observation))
}

async fn probe(
    session: &mut EngineSession,
    params: &FacebookAuthProbeParams,
) -> Result<FacebookAuthObservation, EngineError> {
    let authenticated = has_facebook_auth_cookies(session).await?;
    let expression = facebook::auth_probe_expression(
        session.cdp.target_id(),
        authenticated,
        params.allow_auth_actions,
        params.entered_totp_window_start_unix_ms,
        params.entered_totp_window_end_unix_ms,
    )?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = facebook::result_from_cdp(&raw)?;
    if result.effect_phase != EffectPhase::Confirmed
        || result.output.get("kind").and_then(Value::as_str) != Some("facebook_auth_observation")
    {
        return Err(invalid_auth_result());
    }
    let observation = serde_json::from_value::<FacebookAuthObservation>(
        result
            .output
            .get("value")
            .cloned()
            .ok_or_else(invalid_auth_result)?,
    )
    .map_err(|_| invalid_auth_result())?;
    validate_observation(&observation)?;
    Ok(observation)
}

async fn has_facebook_auth_cookies(session: &mut EngineSession) -> Result<bool, EngineError> {
    session.cdp.enable_network().await?;
    let cookies = session.cdp.all_cookies().await?;
    Ok(facebook::session::facebook_auth_cookie_pair_is_valid(
        &cookies,
    ))
}

fn action_probe_params() -> FacebookAuthProbeParams {
    FacebookAuthProbeParams {
        allow_auth_actions: true,
        ..FacebookAuthProbeParams::default()
    }
}

fn validate_observation(observation: &FacebookAuthObservation) -> Result<(), EngineError> {
    if observation.document_generation.is_empty()
        || observation.document_generation.len() > AUTH_DOCUMENT_MAX_BYTES
        || observation
            .reason
            .as_ref()
            .is_some_and(|reason| reason.len() > AUTH_REASON_MAX_BYTES)
    {
        return Err(invalid_auth_result());
    }
    let actionable = is_actionable(observation.signal);
    if actionable {
        let signal_id = observation
            .signal_id
            .as_deref()
            .ok_or_else(invalid_auth_result)?;
        let candidate = observation
            .candidate
            .as_ref()
            .ok_or_else(invalid_auth_result)?;
        if !valid_signal_id(signal_id)
            || candidate.candidate_key.len() != AUTH_SIGNAL_DIGEST_LEN
            || !lower_hex(&candidate.candidate_key)
            || !candidate.cx.is_finite()
            || !candidate.cy.is_finite()
            || candidate.cx < 0.0
            || candidate.cy < 0.0
            || candidate.cx > 100_000.0
            || candidate.cy > 100_000.0
        {
            return Err(invalid_auth_result());
        }
    } else if observation.signal_id.is_some() || observation.candidate.is_some() {
        return Err(invalid_auth_result());
    }
    if is_totp_signal(observation.signal) && observation.server_epoch_ms.is_none() {
        return Err(invalid_auth_result());
    }
    Ok(())
}

fn is_actionable(signal: FacebookAuthSignal) -> bool {
    matches!(
        signal,
        FacebookAuthSignal::LoginSubmitReady
            | FacebookAuthSignal::TotpEntryReady
            | FacebookAuthSignal::TotpSubmitReady
            | FacebookAuthSignal::TotpRefreshRequired
            | FacebookAuthSignal::AutomationWarningDismiss
            | FacebookAuthSignal::PushBlockerClose
            | FacebookAuthSignal::RememberPasswordConfirm
            | FacebookAuthSignal::AdDataReviewGetStarted
            | FacebookAuthSignal::SuspensionAppealStart
    )
}

fn is_totp_signal(signal: FacebookAuthSignal) -> bool {
    matches!(
        signal,
        FacebookAuthSignal::TotpEntryReady
            | FacebookAuthSignal::TotpSubmitReady
            | FacebookAuthSignal::TotpRefreshRequired
    )
}

fn valid_signal_id(value: &str) -> bool {
    value
        .strip_prefix(AUTH_SIGNAL_PREFIX)
        .is_some_and(|digest| digest.len() == AUTH_SIGNAL_DIGEST_LEN && lower_hex(digest))
}

fn lower_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}

fn reserve_signal(session: &mut EngineSession, signal_id: &str) {
    session
        .facebook
        .consumed_auth_signal_ids
        .insert(signal_id.to_owned());
}

fn totp_window_is_fresh(server_epoch_ms: Option<u64>, start: u64, end: u64) -> bool {
    server_epoch_ms.is_some_and(|server| {
        server >= start && server < end && end.saturating_sub(server) >= TOTP_VALIDITY_FLOOR_MS
    })
}

async fn read_totp(
    session: &mut EngineSession,
    document_generation: &str,
    candidate_key: &str,
    expected_code: Option<&str>,
) -> Result<FacebookAuthTotpReadback, EngineError> {
    let expression =
        facebook::auth_totp_readback_expression(document_generation, candidate_key, expected_code)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = facebook::result_from_cdp(&raw)?;
    if result.output.get("kind").and_then(Value::as_str) != Some("auth_totp_readback") {
        return Err(invalid_auth_result());
    }
    serde_json::from_value(
        result
            .output
            .get("value")
            .cloned()
            .ok_or_else(invalid_auth_result)?,
    )
    .map_err(|_| invalid_auth_result())
}

async fn verify_postcondition(
    session: &mut EngineSession,
    document_generation: &str,
    expected_signal: FacebookAuthSignal,
    candidate_key: &str,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<FacebookAuthPostconditionVerification, EngineError> {
    let long_successor_transition = matches!(
        expected_signal,
        FacebookAuthSignal::AdDataReviewGetStarted | FacebookAuthSignal::SuspensionAppealStart
    );
    let expected_signal = signal_name(expected_signal);
    let max_polls = if long_successor_transition {
        SUCCESSOR_POSTCONDITION_MAX_POLLS
    } else {
        POSTCONDITION_MAX_POLLS
    };
    let mut transition_observed = false;
    for _ in 0..max_polls {
        if action_cancelled_or_expired(cancellation, deadline_unix_ms) {
            return Ok(FacebookAuthPostconditionVerification {
                confirmed: false,
                transition_observed,
            });
        }
        let expression = facebook::auth_postcondition_expression(
            document_generation,
            expected_signal,
            candidate_key,
        )?;
        let raw = session.cdp.evaluate(&expression, true).await?;
        let result = facebook::result_from_cdp(&raw)?;
        if result.output.get("kind").and_then(Value::as_str) != Some("facebook_auth_postcondition")
        {
            return Err(invalid_auth_result());
        }
        let postcondition = serde_json::from_value::<FacebookAuthPostcondition>(
            result
                .output
                .get("value")
                .cloned()
                .ok_or_else(invalid_auth_result)?,
        )
        .map_err(|_| invalid_auth_result())?;
        transition_observed |= postcondition.successor_observed
            || postcondition.loading_observed
            || postcondition.button_state_changed;
        if postcondition.satisfied && (postcondition.document_changed || postcondition.signal_gone)
        {
            return Ok(FacebookAuthPostconditionVerification {
                confirmed: true,
                transition_observed,
            });
        }
        tokio::time::sleep(Duration::from_millis(POSTCONDITION_POLL_MS)).await;
    }
    Ok(FacebookAuthPostconditionVerification {
        confirmed: false,
        transition_observed,
    })
}

fn signal_name(signal: FacebookAuthSignal) -> &'static str {
    match signal {
        FacebookAuthSignal::Authenticated => "authenticated",
        FacebookAuthSignal::LoginSubmitReady => "login_submit_ready",
        FacebookAuthSignal::TotpEntryReady => "totp_entry_ready",
        FacebookAuthSignal::TotpSubmitReady => "totp_submit_ready",
        FacebookAuthSignal::TotpRefreshRequired => "totp_refresh_required",
        FacebookAuthSignal::AutomationWarningDismiss => "automation_warning_dismiss",
        FacebookAuthSignal::PushBlockerClose => "push_blocker_close",
        FacebookAuthSignal::RememberPasswordConfirm => "remember_password_confirm",
        FacebookAuthSignal::AdDataReviewGetStarted => "ad_data_review_get_started",
        FacebookAuthSignal::SuspensionAppealStart => "suspension_appeal_start",
        FacebookAuthSignal::ManualLoginRequired => "manual_login_required",
        FacebookAuthSignal::BlockedHumanVerification => "blocked_human_verification",
        FacebookAuthSignal::BlockedUnknown => "blocked_unknown",
        FacebookAuthSignal::None => "none",
    }
}

fn action_result(
    command: &NativeCommand,
    signal_id: &str,
    phase: EffectPhase,
    ok: bool,
    reason: Option<&'static str>,
) -> (EffectPhase, CommandOutput) {
    (
        phase,
        CommandOutput::FacebookAuthAction(
            FacebookAuthActionReceipt {
                action: command.kind().to_owned(),
                signal_id: signal_id.to_owned(),
                ok,
                reason: reason.map(str::to_owned),
            }
            .bounded(),
        ),
    )
}

fn pointer_failure_result(
    command: &NativeCommand,
    signal_id: &str,
    failure: PointerInputFailure,
) -> (EffectPhase, CommandOutput) {
    match failure {
        PointerInputFailure::CancelledBeforePress => action_result(
            command,
            signal_id,
            EffectPhase::NotStarted,
            false,
            Some("auth_action_cancelled_before_commit"),
        ),
        PointerInputFailure::DeadlineBeforePress => action_result(
            command,
            signal_id,
            EffectPhase::NotStarted,
            false,
            Some("auth_action_deadline_before_commit"),
        ),
        PointerInputFailure::MoveFailed(_) => action_result(
            command,
            signal_id,
            EffectPhase::Ambiguous,
            false,
            Some("auth_pointer_move_failed"),
        ),
        PointerInputFailure::SubmitDispatched(_) => action_result(
            command,
            signal_id,
            EffectPhase::Ambiguous,
            false,
            Some("auth_pointer_commit_failed"),
        ),
    }
}

fn text_failure_result(
    command: &NativeCommand,
    signal_id: &str,
    failure: GuardedTextInputFailure,
) -> (EffectPhase, CommandOutput) {
    let reason = match failure {
        // 焦点守卫这一次读不出焦点状态：与「守卫读到了目标丢失」（totp_entry_target_lost）
        // 和「通道 / 写入失败」（totp_entry_input_failed）都分开。六位码这条路径上
        // 把三者混成一条，等于让人拿着一个错误的方向去看真机。
        GuardedTextInputFailure::GuardUnreadable => "totp_entry_focus_unreadable",
        GuardedTextInputFailure::Input(TextInputFailure::Cancelled) => {
            "totp_entry_cancelled_after_focus"
        }
        GuardedTextInputFailure::Input(TextInputFailure::Deadline) => {
            "totp_entry_deadline_after_focus"
        }
        GuardedTextInputFailure::Input(TextInputFailure::TargetLost) => "totp_entry_target_lost",
        GuardedTextInputFailure::Input(TextInputFailure::Engine) => "totp_entry_input_failed",
        GuardedTextInputFailure::Input(TextInputFailure::NewlineUnstable) => {
            "totp_entry_input_failed"
        }
    };
    action_result(
        command,
        signal_id,
        EffectPhase::Ambiguous,
        false,
        Some(reason),
    )
}

fn action_cancelled_or_expired(cancellation: Option<&AtomicBool>, deadline_unix_ms: u64) -> bool {
    cancellation.is_some_and(|value| value.load(Ordering::Acquire))
        || deadline_unix_ms <= unix_time_ms()
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn invalid_auth_result() -> EngineError {
    EngineError::new(
        ErrorCode::CdpError,
        "native Facebook auth command returned an invalid bounded result",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signal_ids_and_totp_windows_are_strictly_bounded() {
        let signal_id = format!("{AUTH_SIGNAL_PREFIX}{}", "a".repeat(64));
        assert!(valid_signal_id(&signal_id));
        assert!(!valid_signal_id(&format!(
            "{AUTH_SIGNAL_PREFIX}{}",
            "A".repeat(64)
        )));
        assert!(totp_window_is_fresh(Some(50_000), 30_000, 60_000));
        assert!(!totp_window_is_fresh(Some(50_001), 30_000, 60_000));
        assert!(!totp_window_is_fresh(None, 30_000, 60_000));
    }

    #[test]
    fn auth_postcondition_receipt_window_is_seven_seconds() {
        assert_eq!(POSTCONDITION_POLL_MS, 200);
        assert_eq!(POSTCONDITION_MAX_POLLS, 35);
        assert_eq!(
            POSTCONDITION_POLL_MS * POSTCONDITION_MAX_POLLS as u64,
            7_000
        );
    }

    #[test]
    fn bounded_successor_window_is_thirty_seconds() {
        assert_eq!(
            POSTCONDITION_POLL_MS * SUCCESSOR_POSTCONDITION_MAX_POLLS as u64,
            30_000
        );
    }

    #[test]
    fn suspension_appeal_cancellation_deadline_and_ambiguous_successor_stay_distinct() {
        let command = NativeCommand::FacebookAuthStartSuspensionAppeal(FacebookAuthSignalParams {
            signal_id: format!("{AUTH_SIGNAL_PREFIX}{}", "b".repeat(64)),
        });
        for (failure, phase, reason) in [
            (
                PointerInputFailure::CancelledBeforePress,
                EffectPhase::NotStarted,
                "auth_action_cancelled_before_commit",
            ),
            (
                PointerInputFailure::DeadlineBeforePress,
                EffectPhase::NotStarted,
                "auth_action_deadline_before_commit",
            ),
        ] {
            let (actual_phase, output) = pointer_failure_result(&command, "signal", failure);
            assert_eq!(actual_phase, phase);
            let CommandOutput::FacebookAuthAction(receipt) = output else {
                panic!("expected Facebook auth action receipt")
            };
            assert!(!receipt.ok);
            assert_eq!(receipt.reason.as_deref(), Some(reason));
        }
        assert_eq!(
            postcondition_failure_reason(
                FacebookAuthSignal::SuspensionAppealStart,
                FacebookAuthPostconditionVerification {
                    confirmed: false,
                    transition_observed: true,
                },
            ),
            "auth_successor_unconfirmed"
        );
    }
}
