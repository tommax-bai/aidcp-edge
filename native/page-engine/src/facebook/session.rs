use super::shared::{evaluate_facebook_router, wait_for_facebook_ready};
use crate::engine::{CommandOutput, EngineSession, capture_captcha, click_captcha};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::model::{IdentityObservation, IdentityObservationSource, IdentityPageEffect};
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
        NativeCommand::CaptchaCapture(params) => capture_captcha(session, params).await,
        NativeCommand::CaptchaClick(params) => {
            click_captcha(session, params, cancellation, deadline_unix_ms).await
        }
        NativeCommand::IdentityBootstrap(_) => execute_facebook_identity(session, true).await,
        NativeCommand::IdentityReadCurrent(params) => {
            let (phase, output) = execute_facebook_identity(session, false).await?;
            let CommandOutput::FacebookIdentity(receipt) = output else {
                return Err(invalid_facebook_identity_output());
            };
            let account_id = receipt
                .account_id
                .unwrap_or_else(|| params.account_id.clone());
            let nickname = receipt.ok.then_some(receipt.display_name).flatten();
            Ok((
                phase,
                CommandOutput::IdentityObservation(
                    IdentityObservation {
                        capture_id: params.capture_id.clone(),
                        account_id,
                        nickname,
                        source: IdentityObservationSource::CurrentPage,
                        page_effect: IdentityPageEffect::None,
                    }
                    .bounded(),
                ),
            ))
        }
        NativeCommand::PageProbe(_) | NativeCommand::SessionStop(_) => {
            evaluate_facebook_router(session, command).await
        }
        _ => Err(owner_mismatch()),
    }
}

fn owner_mismatch() -> EngineError {
    EngineError::new(
        ErrorCode::EngineInternal,
        "native Facebook session capability received another owner's command",
    )
}

pub(crate) async fn execute_facebook_identity(
    session: &mut EngineSession,
    allow_navigate: bool,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let location = session
        .cdp
        .evaluate("location.href", true)
        .await?
        .pointer("/result/value")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if allow_navigate
        && !location.starts_with("https://www.facebook.com/")
        && !location.starts_with("https://facebook.com/")
    {
        session.cdp.navigate("https://www.facebook.com/").await?;
        wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    }
    session.cdp.enable_network().await?;
    let cookies = session.cdp.all_cookies().await?;
    let cookie_user_id = cookies
        .get("cookies")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|cookie| cookie.get("name").and_then(serde_json::Value::as_str) == Some("c_user"))
        .filter(|cookie| {
            cookie
                .get("domain")
                .and_then(serde_json::Value::as_str)
                .map(|domain| {
                    let host = domain.trim_start_matches('.').to_ascii_lowercase();
                    host == "facebook.com" || host.ends_with(".facebook.com")
                })
                .unwrap_or(false)
        })
        .filter_map(|cookie| cookie.get("value").and_then(serde_json::Value::as_str))
        .find(|value| {
            value.len() >= 5 && value.chars().all(|character| character.is_ascii_digit())
        });
    let expression = facebook::identity_expression(cookie_user_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = facebook::result_from_cdp(&raw)?;
    let command = NativeCommand::IdentityBootstrap(crate::command::EmptyParams::default());
    let output = facebook::typed_output(&command, result.output, session.cdp.target_id())?;
    Ok((result.effect_phase, output))
}

pub(crate) fn invalid_facebook_identity_output() -> EngineError {
    EngineError::new(
        ErrorCode::CdpError,
        "native Facebook identity command returned an invalid output",
    )
}
