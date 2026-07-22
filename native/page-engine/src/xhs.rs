use crate::command::NativeCommand;
use crate::engine::CommandOutput;
use crate::error::{EngineError, ErrorCode};
use crate::model::{
    ActionReceipt, NoteDetail, NotificationHome, NotificationItems, PageCards, PlanResults,
    ProfileDetail, PublishReceipt,
};
use crate::protocol::EffectPhase;
use serde::Deserialize;
use serde_json::Value;

include!(concat!(env!("OUT_DIR"), "/xhs_command_router_bytes.rs"));
include!(concat!(
    env!("OUT_DIR"),
    "/xhs_file_input_selector_bytes.rs"
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
    let decoded: Vec<u8> = XHS_COMMAND_ROUTER_BYTES
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ ROUTER_KEY[index % ROUTER_KEY.len()])
        .collect();
    let source = String::from_utf8(decoded).map_err(|_| invalid_result())?;
    let command = serde_json::to_string(command).map_err(|_| invalid_result())?;
    Ok(format!("({source})({command})"))
}

pub fn file_input_selector() -> Result<String, EngineError> {
    let decoded: Vec<u8> = XHS_FILE_INPUT_SELECTOR_BYTES
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

pub fn typed_output(command: &NativeCommand, output: Value) -> Result<CommandOutput, EngineError> {
    let kind = output
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(invalid_result)?;
    let value = output.get("value").cloned().ok_or_else(invalid_result)?;
    match kind {
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
        "notification_items" => Ok(CommandOutput::NotificationItems(
            serde_json::from_value::<NotificationItems>(value)
                .map_err(|_| invalid_result())?
                .bounded(),
        )),
        "notification_home" => Ok(CommandOutput::NotificationHome(
            serde_json::from_value::<NotificationHome>(value).map_err(|_| invalid_result())?,
        )),
        "plan_results" => Ok(CommandOutput::PlanResults(
            serde_json::from_value::<PlanResults>(value)
                .map_err(|_| invalid_result())?
                .bounded(),
        )),
        "action_receipt" if publish_identity(command).is_none() => {
            Ok(CommandOutput::ActionReceipt(
                serde_json::from_value::<ActionReceipt>(value)
                    .map_err(|_| invalid_result())?
                    .bounded(),
            ))
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
        "native Xiaohongshu command returned an invalid bounded result",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeds_only_typed_command_json_into_the_encoded_router() {
        let command: NativeCommand =
            serde_json::from_str(r#"{"kind":"search_execute","params":{"keyword":"coffee"}}"#)
                .expect("command");
        let expression = command_expression(&command).expect("expression");
        assert!(expression.contains("search_execute"));
        assert!(expression.contains("coffee"));
        assert!(!expression.contains("runtime_evaluate"));
    }
}
