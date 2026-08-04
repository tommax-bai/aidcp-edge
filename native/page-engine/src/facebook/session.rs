use super::shared::{evaluate_facebook_router, wait_for_facebook_ready};
use crate::engine::{CommandOutput, EngineSession, capture_captcha, click_captcha};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::model::{IdentityObservation, IdentityObservationSource, IdentityPageEffect};
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::AtomicBool;

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
        wait_for_facebook_ready(session).await?;
    }
    session.cdp.enable_network().await?;
    let cookies = session.cdp.all_cookies().await?;
    let cookie_user_id = facebook_cookie_values(&cookies, "c_user")
        .find(|value| valid_facebook_cookie_user_id(value));
    let expression = facebook::identity_expression(cookie_user_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = facebook::result_from_cdp(&raw)?;
    let command = NativeCommand::IdentityBootstrap(crate::command::EmptyParams::default());
    let output = facebook::typed_output(&command, result.output, session.cdp.target_id())?;
    Ok((result.effect_phase, output))
}

pub(crate) fn facebook_auth_cookie_pair_is_valid(cookies: &serde_json::Value) -> bool {
    facebook_cookie_values(cookies, "c_user").any(valid_facebook_cookie_user_id)
        && facebook_cookie_values(cookies, "xs").any(|value| !value.is_empty())
}

fn facebook_cookie_values<'a>(
    cookies: &'a serde_json::Value,
    expected_name: &'a str,
) -> impl Iterator<Item = &'a str> + 'a {
    cookies
        .get("cookies")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(move |cookie| {
            cookie.get("name").and_then(serde_json::Value::as_str) == Some(expected_name)
        })
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
}

fn valid_facebook_cookie_user_id(value: &str) -> bool {
    value.len() >= 5 && value.chars().all(|character| character.is_ascii_digit())
}

pub(crate) fn invalid_facebook_identity_output() -> EngineError {
    EngineError::new(
        ErrorCode::CdpError,
        "native Facebook identity command returned an invalid output",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn auth_cookie_pair_requires_the_same_numeric_user_id_as_identity() {
        for cookies in [
            json!({"cookies":[
                {"name":"c_user","value":"","domain":".facebook.com"},
                {"name":"xs","value":"session-token","domain":".facebook.com"}
            ]}),
            json!({"cookies":[
                {"name":"c_user","value":"not-numeric","domain":".facebook.com"},
                {"name":"xs","value":"session-token","domain":".facebook.com"}
            ]}),
            json!({"cookies":[
                {"name":"c_user","value":"12345","domain":".facebook.example"},
                {"name":"xs","value":"session-token","domain":".facebook.example"}
            ]}),
            json!({"cookies":[
                {"name":"c_user","value":"12345","domain":".facebook.com"},
                {"name":"xs","value":"","domain":".facebook.com"}
            ]}),
        ] {
            assert!(!facebook_auth_cookie_pair_is_valid(&cookies));
        }

        assert!(facebook_auth_cookie_pair_is_valid(&json!({"cookies":[
            {"name":"c_user","value":"","domain":".facebook.com"},
            {"name":"c_user","value":"12345","domain":"www.facebook.com"},
            {"name":"xs","value":"session-token","domain":".facebook.com"}
        ]})));
    }
}
