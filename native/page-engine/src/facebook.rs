use crate::error::{EngineError, ErrorCode};
use crate::model::{
    ActionReceipt, FacebookIdentityReceipt, NoteDetail, PageCards, ProfileDetail, PublishReceipt,
};
use crate::probe::ProbeResult;
use crate::protocol::{EffectPhase, NativeCommand};
use serde::Deserialize;
use serde_json::{Value, json};
use url::Url;

include!(concat!(
    env!("OUT_DIR"),
    "/facebook_command_router_bytes.rs"
));
include!(concat!(
    env!("OUT_DIR"),
    "/facebook_file_input_selector_bytes.rs"
));

const ROUTER_KEY: &[u8] = &[
    0x91, 0x2f, 0xc4, 0x6a, 0x5d, 0xe3, 0x18, 0xb7, 0x42, 0x0d, 0xfa,
];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BrowserCommandResult {
    pub effect_phase: EffectPhase,
    pub output: Value,
}

pub fn command_expression(command: &NativeCommand) -> Result<String, EngineError> {
    router_expression(serde_json::to_value(command).map_err(|_| invalid_result())?)
}

pub fn identity_expression(cookie_user_id: Option<&str>) -> Result<String, EngineError> {
    router_expression(json!({
        "kind": "identity_read",
        "params": {
            "cookieUserId": cookie_user_id.unwrap_or_default()
        }
    }))
}

pub fn page_probe_expression() -> Result<String, EngineError> {
    router_expression(json!({ "kind": "page_probe", "params": {} }))
}

fn router_expression(input: Value) -> Result<String, EngineError> {
    let decoded: Vec<u8> = FACEBOOK_COMMAND_ROUTER_BYTES
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ ROUTER_KEY[index % ROUTER_KEY.len()])
        .collect();
    let source = String::from_utf8(decoded).map_err(|_| invalid_result())?;
    let input = serde_json::to_string(&input).map_err(|_| invalid_result())?;
    Ok(format!("({source})({input})"))
}

pub fn file_input_selector() -> Result<String, EngineError> {
    let decoded: Vec<u8> = FACEBOOK_FILE_INPUT_SELECTOR_BYTES
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ ROUTER_KEY[index % ROUTER_KEY.len()])
        .collect();
    String::from_utf8(decoded)
        .map(|value| value.trim().to_owned())
        .map_err(|_| invalid_result())
}

pub fn result_from_cdp(result: &Value) -> Result<BrowserCommandResult, EngineError> {
    if result.get("exceptionDetails").is_some() {
        return Err(invalid_result());
    }
    let value = result.pointer("/result/value").ok_or_else(invalid_result)?;
    serde_json::from_value(value.clone()).map_err(|_| invalid_result())
}

pub fn typed_output(
    command: &NativeCommand,
    output: Value,
    target_id: &str,
) -> Result<crate::engine::CommandOutput, EngineError> {
    use crate::engine::CommandOutput;
    let kind = output
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(invalid_result)?;
    let value = output.get("value").cloned().ok_or_else(invalid_result)?;
    match kind {
        "page_probe" => {
            let mut probe =
                serde_json::from_value::<ProbeResult>(value).map_err(|_| invalid_result())?;
            let origin = Url::parse(&probe.origin).map_err(|_| invalid_result())?;
            let host = origin.host_str().ok_or_else(invalid_result)?;
            if origin.scheme() != "https"
                || !(host == "facebook.com" || host.ends_with(".facebook.com"))
            {
                return Err(invalid_result());
            }
            probe.target_id = target_id.to_owned();
            Ok(CommandOutput::PageProbe(probe))
        }
        "page_cards" => Ok(CommandOutput::PageCards(
            serde_json::from_value::<PageCards>(value)
                .map_err(|_| invalid_result())?
                .bounded(),
        )),
        "note_detail" => Ok(CommandOutput::NoteDetail(
            serde_json::from_value::<NoteDetail>(value)
                .map_err(|_| invalid_result())?
                .bounded(),
        )),
        "profile_detail" => Ok(CommandOutput::ProfileDetail(
            serde_json::from_value::<ProfileDetail>(value)
                .map_err(|_| invalid_result())?
                .bounded(),
        )),
        "identity_receipt" => Ok(CommandOutput::FacebookIdentity(
            serde_json::from_value::<FacebookIdentityReceipt>(value)
                .map_err(|_| invalid_result())?
                .bounded(),
        )),
        "action_receipt" if publish_identity(command).is_none() => {
            Ok(CommandOutput::ActionReceipt(Box::new(
                serde_json::from_value::<ActionReceipt>(value)
                    .map_err(|_| invalid_result())?
                    .bounded(),
            )))
        }
        "action_receipt" => {
            let action = serde_json::from_value::<ActionReceipt>(value)
                .map_err(|_| invalid_result())?
                .bounded();
            let (record_id, seq, publish_kind) =
                publish_identity(command).ok_or_else(invalid_result)?;
            Ok(CommandOutput::PublishReceipt(
                PublishReceipt {
                    record_id,
                    seq,
                    kind: publish_kind,
                    ok: action.ok,
                    submit_dispatched: None,
                    value: None,
                    post_url: None,
                    error: action.reason,
                }
                .bounded(),
            ))
        }
        "publish_receipt" => Ok(CommandOutput::PublishReceipt(
            serde_json::from_value::<PublishReceipt>(value)
                .map_err(|_| invalid_result())?
                .bounded(),
        )),
        _ => Err(invalid_result()),
    }
}

fn publish_identity(command: &NativeCommand) -> Option<(u64, u32, String)> {
    use NativeCommand::*;
    let (record_id, seq, kind) = match command {
        PublishNavigateEntry(value) => (value.record_id, value.seq, "navigate_entry"),
        PublishSelectMode(value) => (value.record_id, value.seq, "select_mode"),
        PublishUploadImage(value) => (value.record_id, value.seq, "upload_image"),
        PublishSetCover(value) => (value.record_id, value.seq, "set_cover"),
        PublishFillField(value) => (value.record_id, value.seq, "fill_field"),
        PublishAddWithCandidate(value) => (value.record_id, value.seq, "add_with_candidate"),
        PublishSetOption(value) => (value.record_id, value.seq, "set_option"),
        PublishSetSchedule(value) => (value.record_id, value.seq, "set_schedule"),
        PublishSubmit(value) => (value.record_id, value.seq, "submit"),
        PublishCapturePostId(value) => (value.record_id, value.seq, "capture_post_id"),
        PublishCaptureScheduled(value) => (value.record_id, value.seq, "capture_scheduled"),
        PublishReconcileScheduled(value) => (value.record_id, value.seq, "reconcile_scheduled"),
        _ => return None,
    };
    Some((record_id, seq, kind.to_owned()))
}

fn invalid_result() -> EngineError {
    EngineError::new(
        ErrorCode::CdpError,
        "native Facebook command returned an invalid bounded result",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeds_only_typed_inputs_into_the_encoded_router() {
        let command: NativeCommand = serde_json::from_str(
            r#"{"kind":"group_join","params":{"groupUrl":"https://www.facebook.com/groups/123","click":false}}"#,
        )
        .expect("command");
        let expression = command_expression(&command).expect("expression");
        assert!(expression.contains("group_join"));
        assert!(expression.contains("groups/123"));
        assert!(!expression.contains("runtime_evaluate"));
    }

    #[test]
    fn identity_cookie_is_internal_to_native_expression() {
        let expression = identity_expression(Some("123456789")).expect("expression");
        assert!(expression.contains("identity_read"));
        assert!(expression.contains("123456789"));
    }
}
