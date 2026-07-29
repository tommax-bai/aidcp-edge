use crate::command::NativeCommand;
use crate::engine::CommandOutput;
use crate::error::{DecodeStage, EngineError, ErrorCode, JsonValueType};
use crate::model::{
    ActionReceipt, NoteDetail, NotificationHome, NotificationItems, ObservedActionReceipt,
    PageCards, PlanResults, ProfileDetail, PublishReceipt,
};
use crate::probe::{decode_diagnostic, deserialize_with_diagnostic, exception_diagnostic};
use crate::protocol::EffectPhase;
use serde::Deserialize;
use serde_json::Value;

include!(concat!(env!("OUT_DIR"), "/xhs_command_router_bytes.rs"));
include!(concat!(
    env!("OUT_DIR"),
    "/xhs_file_input_selector_bytes.rs"
));
include!(concat!(
    env!("OUT_DIR"),
    "/xhs_search_input_geometry_bytes.rs"
));
include!(concat!(env!("OUT_DIR"), "/xhs_input_targets_bytes.rs"));

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

pub fn search_input_expression(mode: &str) -> Result<String, EngineError> {
    let decoded: Vec<u8> = XHS_SEARCH_INPUT_GEOMETRY_BYTES
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ ROUTER_KEY[index % ROUTER_KEY.len()])
        .collect();
    let source = String::from_utf8(decoded).map_err(|_| invalid_result())?;
    let mode = serde_json::to_string(mode).map_err(|_| invalid_result())?;
    Ok(format!("({})({mode})", source.trim()))
}

/// 写动作特化分支的页面判据入口。选择器与 DOM 语义**只活在分片里**，Rust 侧不写选择器
/// ——与 `search_input_expression` 同构（那条已跑通），也与 Facebook 的 `*_expression()` 同一形。
///
/// 请求形状：`{ kind, op?, noteId?, fieldType?, text? }`；返回一律是有界的判定结构，
/// 不带页面正文全文与凭据。
pub fn input_targets_expression(request: &Value) -> Result<String, EngineError> {
    let decoded: Vec<u8> = XHS_INPUT_TARGETS_BYTES
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ ROUTER_KEY[index % ROUTER_KEY.len()])
        .collect();
    let source = String::from_utf8(decoded).map_err(|_| invalid_result())?;
    let request = serde_json::to_string(request).map_err(|_| invalid_result())?;
    Ok(format!("({})({request})", source.trim()))
}

/// 结果解码入口。诊断与 Facebook 侧同级（阶段 / 字段路径 / 异常位置），构造函数在
/// `crate::probe`、由各平台共用；诊断保持有界，不含页面正文与凭据。
/// 裸错误只留下一句「结果无效」，真机上无从分辨是规则改版、字段漂移，还是页面根本没跑起来。
pub fn result_from_cdp(result: &Value) -> Result<BrowserCommandResult, EngineError> {
    if let Some(exception) = result.get("exceptionDetails") {
        return Err(invalid_result().with_decode_diagnostic(exception_diagnostic(exception)));
    }
    let value = result.pointer("/result/value").ok_or_else(|| {
        invalid_result().with_decode_diagnostic(decode_diagnostic(
            DecodeStage::CdpWrapper,
            None,
            Some("result.value".to_owned()),
            JsonValueType::Missing,
        ))
    })?;
    deserialize_with_diagnostic(value, None, DecodeStage::CdpWrapper)
        .map_err(|diagnostic| invalid_result().with_decode_diagnostic(diagnostic))
}

pub fn typed_output(command: &NativeCommand, output: Value) -> Result<CommandOutput, EngineError> {
    let kind = output.get("kind").and_then(Value::as_str).ok_or_else(|| {
        invalid_result().with_decode_diagnostic(decode_diagnostic(
            DecodeStage::OutputKind,
            None,
            Some("output.kind".to_owned()),
            crate::probe::json_value_type(output.get("kind")),
        ))
    })?;
    let value = output.get("value").cloned().ok_or_else(|| {
        invalid_result().with_decode_diagnostic(decode_diagnostic(
            DecodeStage::OutputValue,
            None,
            Some("output.value".to_owned()),
            JsonValueType::Missing,
        ))
    })?;
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
        // 回执 + 随行观测：只给浏览侧命令用。发布命令 MUST NOT 用该 kind——落到 `_` 分支
        // 诚实报无效结果，绝不静默降级成发布回执（发布回执的 recordId / seq 无从填）。
        "action_receipt_with_observation" if publish_identity(command).is_none() => {
            Ok(CommandOutput::ActionReceiptWithObservation(Box::new(
                serde_json::from_value::<ObservedActionReceipt>(value)
                    .map_err(|_| invalid_result())?
                    .bounded(),
            )))
        }
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
