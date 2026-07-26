use crate::error::{EngineError, ErrorCode};
use crate::model::{
    ActionEvidence, ActionReceipt, FacebookGroupJoinObservation, FacebookIdentityReceipt,
    FacebookListKind, FacebookListState, NoteDetail, PageCard, PageCards, ProfileDetail,
    PublishReceipt,
};
use crate::probe::ProbeResult;
use crate::protocol::{EffectPhase, NativeCommand};
use serde::Deserialize;
use serde_json::{json, Value};
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

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookReelRect {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookReelProbe {
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub video_key: Option<String>,
    #[serde(default)]
    pub video_rect: Option<FacebookReelRect>,
}

impl FacebookReelProbe {
    pub fn moved_from(&self, previous: &Self) -> bool {
        self.ok
            && previous.ok
            && self.note_id.is_some()
            && self.video_key.is_some()
            && (self.note_id != previous.note_id || self.video_key != previous.video_key)
    }

    pub fn is_reels_surface(&self) -> bool {
        self.reason.as_deref() != Some("not_reel")
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookReelNextTarget {
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub video_key: Option<String>,
    #[serde(default)]
    pub video_rect: Option<FacebookReelRect>,
    #[serde(default)]
    pub found: bool,
    #[serde(default)]
    pub ambiguous: bool,
    #[serde(default)]
    pub cx: Option<f64>,
    #[serde(default)]
    pub cy: Option<f64>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookFeedProbe {
    pub cards: Vec<PageCard>,
    #[serde(default)]
    pub document_generation: Option<String>,
    pub list_kind: FacebookListKind,
    pub list_state: FacebookListState,
    pub loading: bool,
    pub article_count: u32,
    pub explicit_empty: bool,
    pub url: String,
    pub surface: String,
    pub scroll_y: f64,
    pub inner_width: f64,
    pub inner_height: f64,
    pub scroll_height: f64,
    pub document_age_ms: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookPointTarget {
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub cx: Option<f64>,
    #[serde(default)]
    pub cy: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookConsentPoint {
    pub cx: f64,
    pub cy: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookConsentProbe {
    pub present: bool,
    #[serde(default)]
    pub accept_all: Option<FacebookConsentPoint>,
    #[serde(default)]
    pub necessary_only: Option<FacebookConsentPoint>,
    pub accept_all_ambiguous: bool,
    pub necessary_only_ambiguous: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookLikeProbe {
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub already: bool,
    #[serde(default)]
    pub cx: Option<f64>,
    #[serde(default)]
    pub cy: Option<f64>,
    #[serde(default)]
    pub observation: Option<ActionEvidence>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookLikeCommit {
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub already: bool,
    #[serde(default)]
    pub clicked: bool,
    #[serde(default)]
    pub observation: Option<ActionEvidence>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookLikeVerify {
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub note_id: Option<String>,
    pub selected: bool,
    #[serde(default)]
    pub witness: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookFollowProbe {
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub video_key: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub already: bool,
    #[serde(default)]
    pub cx: Option<f64>,
    #[serde(default)]
    pub cy: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookTextTarget {
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub cx: Option<f64>,
    #[serde(default)]
    pub cy: Option<f64>,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookCommentAckProbe {
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    pub confirmed: bool,
    pub pending: bool,
    pub rejected: bool,
    #[serde(default)]
    pub in_flight: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookJoinProbe {
    pub observation: FacebookGroupJoinObservation,
    pub joined: bool,
    pub pending: bool,
    pub questionnaire: bool,
    pub found: bool,
    pub ambiguous: bool,
    #[serde(default)]
    pub cx: Option<f64>,
    #[serde(default)]
    pub cy: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookPublishSubmitProbe {
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    pub composer_open: bool,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub cx: Option<f64>,
    #[serde(default)]
    pub cy: Option<f64>,
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

pub fn feed_probe_expression() -> Result<String, EngineError> {
    router_expression(json!({ "kind": "feed_probe", "params": {} }))
}

pub fn feed_home_target_expression() -> Result<String, EngineError> {
    router_expression(json!({ "kind": "feed_home_target", "params": {} }))
}

pub fn consent_probe_expression() -> Result<String, EngineError> {
    router_expression(json!({ "kind": "consent_probe", "params": {} }))
}

pub fn like_probe_expression(note_id: &str) -> Result<String, EngineError> {
    internal_expression("like_probe", json!({ "noteId": note_id }))
}

pub fn like_primary_commit_expression(note_id: &str) -> Result<String, EngineError> {
    internal_expression("like_primary_commit", json!({ "noteId": note_id }))
}

pub fn like_verify_expression(note_id: &str) -> Result<String, EngineError> {
    internal_expression("like_verify", json!({ "noteId": note_id }))
}

pub fn like_picker_probe_expression(note_id: &str) -> Result<String, EngineError> {
    internal_expression("like_picker_probe", json!({ "noteId": note_id }))
}

pub fn follow_probe_expression(note_id: Option<&str>) -> Result<String, EngineError> {
    internal_expression(
        "follow_probe",
        json!({ "noteId": note_id.unwrap_or_default() }),
    )
}

pub fn comment_editor_probe_expression(note_id: &str) -> Result<String, EngineError> {
    internal_expression("comment_editor_probe", json!({ "noteId": note_id }))
}

pub fn comment_ack_probe_expression(
    note_id: &str,
    text: &str,
    account_id: &str,
) -> Result<String, EngineError> {
    internal_expression(
        "comment_ack_probe",
        json!({ "noteId": note_id, "text": text, "accountId": account_id }),
    )
}

pub fn join_probe_expression() -> Result<String, EngineError> {
    internal_expression("join_probe", json!({}))
}

pub fn publish_entry_probe_expression() -> Result<String, EngineError> {
    internal_expression("publish_entry_probe", json!({}))
}

pub fn publish_editor_probe_expression() -> Result<String, EngineError> {
    internal_expression("publish_editor_probe", json!({}))
}

pub fn publish_submit_probe_expression() -> Result<String, EngineError> {
    internal_expression("publish_submit_probe", json!({}))
}

fn internal_expression(kind: &str, params: Value) -> Result<String, EngineError> {
    router_expression(json!({ "kind": kind, "params": params }))
}

pub fn reel_probe_expression() -> Result<String, EngineError> {
    router_expression(json!({ "kind": "reel_probe", "params": {} }))
}

pub fn reel_next_target_expression() -> Result<String, EngineError> {
    router_expression(json!({ "kind": "reel_next_target", "params": {} }))
}

pub fn reel_cards_expression() -> Result<String, EngineError> {
    router_expression(json!({ "kind": "reel_cards", "params": {} }))
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

pub fn reel_probe_from_cdp(result: &Value) -> Result<FacebookReelProbe, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "reel_probe")
}

pub fn reel_next_target_from_cdp(result: &Value) -> Result<FacebookReelNextTarget, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "reel_next_target")
}

pub fn feed_probe_from_cdp(result: &Value) -> Result<FacebookFeedProbe, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "feed_probe")
}

pub fn point_target_from_cdp(result: &Value) -> Result<FacebookPointTarget, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "point_target")
}

pub fn consent_probe_from_cdp(result: &Value) -> Result<FacebookConsentProbe, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "consent_probe")
}

pub fn like_probe_from_cdp(result: &Value) -> Result<FacebookLikeProbe, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "like_probe")
}

pub fn like_commit_from_cdp(result: &Value) -> Result<FacebookLikeCommit, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "like_commit")
}

pub fn like_verify_from_cdp(result: &Value) -> Result<FacebookLikeVerify, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "like_verify")
}

pub fn follow_probe_from_cdp(result: &Value) -> Result<FacebookFollowProbe, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "follow_probe")
}

pub fn text_target_from_cdp(result: &Value) -> Result<FacebookTextTarget, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "text_target")
}

pub fn comment_ack_probe_from_cdp(result: &Value) -> Result<FacebookCommentAckProbe, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "comment_ack_probe")
}

pub fn join_probe_from_cdp(result: &Value) -> Result<FacebookJoinProbe, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "join_probe")
}

pub fn publish_submit_probe_from_cdp(
    result: &Value,
) -> Result<FacebookPublishSubmitProbe, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "publish_submit_probe")
}

pub fn failure_output(
    command: &NativeCommand,
    action: &str,
    reason: &str,
    target_id: &str,
) -> Result<crate::engine::CommandOutput, EngineError> {
    typed_output(
        command,
        json!({
            "kind": "action_receipt",
            "value": {
                "action": action,
                "ok": false,
                "reason": reason
            }
        }),
        target_id,
    )
}

fn typed_internal_value<T: for<'de> Deserialize<'de>>(
    output: Value,
    expected_kind: &str,
) -> Result<T, EngineError> {
    if output.get("kind").and_then(Value::as_str) != Some(expected_kind) {
        return Err(invalid_result());
    }
    serde_json::from_value(output.get("value").cloned().ok_or_else(invalid_result)?)
        .map_err(|_| invalid_result())
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

    #[test]
    fn reel_probe_requires_the_stable_identity_pair_to_move() {
        let before = FacebookReelProbe {
            ok: true,
            reason: None,
            note_id: Some("https://www.facebook.com/reel/1".to_owned()),
            video_key: Some("video-1@element:1".to_owned()),
            video_rect: None,
        };
        assert!(!before.moved_from(&before));

        let video_moved = FacebookReelProbe {
            video_key: Some("video-2@element:2".to_owned()),
            ..before.clone()
        };
        assert!(video_moved.moved_from(&before));

        let missing_identity = FacebookReelProbe {
            note_id: None,
            ..video_moved
        };
        assert!(!missing_identity.moved_from(&before));
    }

    #[test]
    fn reel_probe_distinguishes_other_surfaces_from_unreadable_reels() {
        let feed = FacebookReelProbe {
            ok: false,
            reason: Some("not_reel".to_owned()),
            note_id: None,
            video_key: None,
            video_rect: None,
        };
        let ambiguous_reel = FacebookReelProbe {
            reason: Some("ambiguous_target".to_owned()),
            ..feed.clone()
        };
        assert!(!feed.is_reels_surface());
        assert!(ambiguous_reel.is_reels_surface());
    }

    #[test]
    fn feed_probe_decodes_only_the_declared_integer_document_age() {
        let cdp_result = json!({
            "result": {
                "value": {
                    "effectPhase": "confirmed",
                    "output": {
                        "kind": "feed_probe",
                        "value": {
                            "cards": [],
                            "documentGeneration": "/|0",
                            "listKind": "feed",
                            "listState": "present_unreportable",
                            "loading": false,
                            "articleCount": 2,
                            "explicitEmpty": false,
                            "url": "https://www.facebook.com/",
                            "surface": "home",
                            "scrollY": 0,
                            "innerWidth": 1440,
                            "innerHeight": 801,
                            "scrollHeight": 2400,
                            "documentAgeMs": 215964
                        }
                    }
                }
            }
        });

        let probe = feed_probe_from_cdp(&cdp_result).expect("bounded feed probe");
        assert_eq!(probe.document_age_ms, 215_964);

        let mut fractional = cdp_result;
        fractional["result"]["value"]["output"]["value"]["documentAgeMs"] =
            json!(215964.39990234375);
        assert!(feed_probe_from_cdp(&fractional).is_err());
    }
}
