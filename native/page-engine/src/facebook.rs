use crate::embedded_asset_key::EMBEDDED_ASSET_KEY;
use crate::error::{
    CdpExceptionClass, CdpExceptionReason, DecodeStage, EngineError, ErrorCode, ErrorDiagnostic,
    JsonValueType,
};
use crate::model::{
    ActionEvidence, ActionReceipt, FacebookGroupJoinObservation, FacebookIdentityReceipt,
    FacebookListKind, FacebookListState, NoteDetail, PageCard, PageCards, ProfileDetail,
    PublishReceipt,
};
use crate::probe::ProbeResult;
use crate::protocol::{EffectPhase, NativeCommand};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use serde_path_to_error::{Path, Segment};
use url::Url;

pub mod auth;
pub mod capability;
pub mod comment;
pub mod feed;
pub mod feed_like;
pub mod group_join;
pub mod publish;
pub mod reels;
pub mod runtime;
pub mod session;
pub mod shared;

include!(concat!(
    env!("OUT_DIR"),
    "/facebook_command_router_bytes.rs"
));
include!(concat!(
    env!("OUT_DIR"),
    "/facebook_file_input_selector_bytes.rs"
));

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
    pub video_rect: Option<FacebookReelRect>,
    #[serde(default)]
    pub input_safe: Option<bool>,
}

impl FacebookReelProbe {
    pub fn moved_from(&self, previous: &Self) -> bool {
        self.ok && previous.ok && self.note_id.is_some() && self.note_id != previous.note_id
    }

    pub fn is_reels_surface(&self) -> bool {
        self.reason.as_deref() != Some("not_reel")
    }

    pub fn is_explicitly_keyboard_input_safe(&self) -> bool {
        self.input_safe == Some(true)
    }
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
    pub explicit_end: bool,
    pub url: String,
    pub surface: String,
    #[serde(default)]
    pub feed_recovery_target: Option<FacebookPointTarget>,
    pub scroll_y: f64,
    pub inner_width: f64,
    pub inner_height: f64,
    pub scroll_height: f64,
    pub scroll_viewport_height: f64,
    pub document_time_origin_ms: u64,
    pub document_age_ms: u64,
}

/// 一个待采集的身份候选：某张卡内、形状像时间戳、且当前落在视口内的链接中心点。
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookIdentityCandidate {
    pub card_index: u32,
    pub x: f64,
    pub y: f64,
}

/// 身份采集回合的输入：尚无地址的卡有哪些候选，以及本屏已解析 / 总卡数（供命中率诊断）。
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookIdentityCandidates {
    pub candidates: Vec<FacebookIdentityCandidate>,
    pub card_count: u32,
    pub resolved_count: u32,
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
pub struct FacebookFeedLikeTarget {
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub cx: Option<f64>,
    #[serde(default)]
    pub cy: Option<f64>,
    #[serde(default)]
    pub top: Option<f64>,
    #[serde(default)]
    pub bottom: Option<f64>,
    #[serde(default)]
    pub viewport_height: Option<f64>,
    #[serde(default)]
    pub in_viewport: bool,
    #[serde(default)]
    pub observation: Option<ActionEvidence>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookFeedLikeCommit {
    pub started: bool,
    pub already: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub observation: Option<ActionEvidence>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookFeedLikeVerification {
    pub state: String,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub observation: Option<ActionEvidence>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookFeedLikePicker {
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub cx: Option<f64>,
    #[serde(default)]
    pub cy: Option<f64>,
    #[serde(default)]
    pub from_x: Option<f64>,
    #[serde(default)]
    pub from_y: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookFeedLikeClear {
    pub cleared: bool,
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
    #[serde(default)]
    pub focused: bool,
    #[serde(default)]
    pub selected: bool,
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
pub struct FacebookJoinClickResult {
    pub clicked: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookFirstPostGroupRootProbe {
    pub origin: String,
    pub path: String,
    pub search: String,
    pub hash: String,
    pub surface: String,
    pub ready_state: String,
    pub blocking_kind: String,
    pub visible_main_count: u32,
    pub visible_dialog_count: u32,
    pub target_group_id: Option<String>,
    pub scope_resolved: bool,
    pub scope_ambiguous: bool,
    pub feed_loading: bool,
    pub scroll_y: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookPublishHomeProbe {
    pub href: String,
    pub ready_state: String,
    pub main_visible: bool,
    pub editor_ready: bool,
    pub blocking_dialog: bool,
    pub credential_input: bool,
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

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookPublishSubmittedProbe {
    pub confirmed: bool,
    #[serde(default)]
    pub witness: Option<String>,
}

pub fn command_expression(command: &NativeCommand) -> Result<String, EngineError> {
    router_expression(serde_json::to_value(command).map_err(|_| invalid_result())?)
}

pub fn first_post_command_expression(
    command: &NativeCommand,
    container: &Url,
) -> Result<String, EngineError> {
    let is_first_post_command = match command {
        NativeCommand::FeedRefresh(params) => {
            params.reason.as_deref() == Some("first_commentable_group_post_probe")
        }
        NativeCommand::BrowseScroll(params) => {
            params.reason.as_deref() == Some("first_commentable_group_post_probe")
        }
        _ => false,
    };
    if !is_first_post_command {
        return Err(invalid_result());
    }
    let mut input = serde_json::to_value(command).map_err(|_| invalid_result())?;
    let params = input
        .get_mut("params")
        .and_then(Value::as_object_mut)
        .ok_or_else(invalid_result)?;
    params.insert(
        "container".to_owned(),
        Value::String(container.as_str().to_owned()),
    );
    router_expression(input)
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

pub fn auth_probe_expression(
    target_id: &str,
    authenticated: bool,
    allow_auth_actions: bool,
    entered_totp_window_start_unix_ms: Option<u64>,
    entered_totp_window_end_unix_ms: Option<u64>,
) -> Result<String, EngineError> {
    internal_expression(
        "auth_probe",
        json!({
            "targetId": target_id,
            "authenticated": authenticated,
            "allowAuthActions": allow_auth_actions,
            "enteredTotpWindowStartUnixMs": entered_totp_window_start_unix_ms,
            "enteredTotpWindowEndUnixMs": entered_totp_window_end_unix_ms,
        }),
    )
}

pub fn auth_focus_guard_expression(
    document_generation: &str,
    candidate_key: &str,
) -> Result<String, EngineError> {
    internal_expression(
        "auth_focus_guard",
        json!({
            "documentGeneration": document_generation,
            "candidateKey": candidate_key,
        }),
    )
}

pub fn auth_totp_readback_expression(
    document_generation: &str,
    candidate_key: &str,
    expected_code: Option<&str>,
) -> Result<String, EngineError> {
    internal_expression(
        "auth_totp_readback",
        json!({
            "documentGeneration": document_generation,
            "candidateKey": candidate_key,
            "expectedCode": expected_code,
        }),
    )
}

pub fn auth_postcondition_expression(
    document_generation: &str,
    expected_signal: &str,
    candidate_key: &str,
) -> Result<String, EngineError> {
    internal_expression(
        "auth_postcondition",
        json!({
            "documentGeneration": document_generation,
            "expectedSignal": expected_signal,
            "candidateKey": candidate_key,
        }),
    )
}

pub fn feed_probe_expression() -> Result<String, EngineError> {
    router_expression(json!({ "kind": "feed_probe", "params": {} }))
}

pub fn identity_candidates_expression() -> Result<String, EngineError> {
    router_expression(json!({ "kind": "identity_candidates", "params": {} }))
}

pub fn feed_home_target_expression() -> Result<String, EngineError> {
    router_expression(json!({ "kind": "feed_home_target", "params": {} }))
}

pub fn feed_recovery_target_expression() -> Result<String, EngineError> {
    router_expression(json!({ "kind": "feed_recovery_target", "params": {} }))
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

pub fn feed_like_target_expression(note_id: &str) -> Result<String, EngineError> {
    internal_expression("feed_like_target_probe", json!({ "noteId": note_id }))
}

pub fn feed_like_commit_expression(
    note_id: &str,
    operation_id: &str,
) -> Result<String, EngineError> {
    internal_expression(
        "feed_like_commit",
        json!({ "noteId": note_id, "operationId": operation_id }),
    )
}

pub fn feed_like_verify_expression(
    note_id: &str,
    operation_id: &str,
) -> Result<String, EngineError> {
    internal_expression(
        "feed_like_verify",
        json!({ "noteId": note_id, "operationId": operation_id }),
    )
}

pub fn feed_like_picker_expression(
    note_id: &str,
    operation_id: &str,
) -> Result<String, EngineError> {
    internal_expression(
        "feed_like_picker_probe",
        json!({ "noteId": note_id, "operationId": operation_id }),
    )
}

pub fn feed_like_clear_expression(operation_id: &str) -> Result<String, EngineError> {
    internal_expression("feed_like_clear", json!({ "operationId": operation_id }))
}

pub fn follow_probe_expression(note_id: Option<&str>) -> Result<String, EngineError> {
    internal_expression(
        "follow_probe",
        json!({ "noteId": note_id.unwrap_or_default() }),
    )
}

pub fn comment_action_probe_expression(note_id: &str) -> Result<String, EngineError> {
    internal_expression("comment_action_probe", json!({ "noteId": note_id }))
}

pub fn comment_editor_probe_expression(note_id: &str) -> Result<String, EngineError> {
    internal_expression("comment_editor_probe", json!({ "noteId": note_id }))
}

pub fn comment_editor_focus_expression(
    note_id: &str,
    select_contents: bool,
) -> Result<String, EngineError> {
    internal_expression(
        "comment_editor_probe",
        json!({
            "noteId": note_id,
            "focus": true,
            "selectContents": select_contents
        }),
    )
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

pub fn join_click_expression() -> Result<String, EngineError> {
    internal_expression("join_click", json!({}))
}

pub fn first_post_group_root_probe_expression() -> Result<String, EngineError> {
    internal_expression("first_post_group_root_probe", json!({}))
}

pub fn publish_home_probe_expression() -> Result<String, EngineError> {
    internal_expression("publish_home_probe", json!({}))
}

pub fn publish_entry_probe_expression() -> Result<String, EngineError> {
    internal_expression("publish_entry_probe", json!({}))
}

pub fn publish_editor_probe_expression() -> Result<String, EngineError> {
    internal_expression("publish_editor_probe", json!({}))
}

pub fn publish_editor_focus_expression(select_contents: bool) -> Result<String, EngineError> {
    internal_expression(
        "publish_editor_probe",
        json!({ "focus": true, "selectContents": select_contents }),
    )
}

pub fn publish_bound_editor_probe_expression(
    focus: bool,
    select_contents: bool,
) -> Result<String, EngineError> {
    internal_expression(
        "publish_bound_editor_probe",
        json!({ "focus": focus, "selectContents": select_contents }),
    )
}

pub fn publish_upload_target_probe_expression() -> Result<String, EngineError> {
    internal_expression("publish_upload_target_probe", json!({}))
}

pub fn publish_upload_preview_probe_expression(file_name: &str) -> Result<String, EngineError> {
    internal_expression(
        "publish_upload_preview_probe",
        json!({ "fileName": file_name }),
    )
}

pub fn publish_submit_probe_expression(bind_target: bool) -> Result<String, EngineError> {
    internal_expression("publish_submit_probe", json!({ "bindTarget": bind_target }))
}

pub fn publish_submitted_probe_expression() -> Result<String, EngineError> {
    internal_expression("publish_submitted_probe", json!({}))
}

fn internal_expression(kind: &str, params: Value) -> Result<String, EngineError> {
    router_expression(json!({ "kind": kind, "params": params }))
}

pub fn reel_probe_expression() -> Result<String, EngineError> {
    router_expression(json!({ "kind": "reel_probe", "params": {} }))
}

pub fn reel_cards_expression() -> Result<String, EngineError> {
    router_expression(json!({ "kind": "reel_cards", "params": {} }))
}

fn router_expression(input: Value) -> Result<String, EngineError> {
    let decoded: Vec<u8> = FACEBOOK_COMMAND_ROUTER_BYTES
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ EMBEDDED_ASSET_KEY[index % EMBEDDED_ASSET_KEY.len()])
        .collect();
    let source = String::from_utf8(decoded).map_err(|_| invalid_result())?;
    let input = serde_json::to_string(&input).map_err(|_| invalid_result())?;
    Ok(format!("({source})({input})"))
}

pub fn file_input_selector() -> Result<String, EngineError> {
    let decoded: Vec<u8> = FACEBOOK_FILE_INPUT_SELECTOR_BYTES
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ EMBEDDED_ASSET_KEY[index % EMBEDDED_ASSET_KEY.len()])
        .collect();
    String::from_utf8(decoded)
        .map(|value| value.trim().to_owned())
        .map_err(|_| invalid_result())
}

pub fn result_from_cdp(result: &Value) -> Result<BrowserCommandResult, EngineError> {
    if let Some(exception) = result.get("exceptionDetails") {
        return Err(invalid_result().with_decode_diagnostic(exception_diagnostic(exception)));
    }
    let value = result.pointer("/result/value").ok_or_else(|| {
        invalid_result_with_diagnostic(
            DecodeStage::CdpWrapper,
            None,
            Some("result.value".to_owned()),
            JsonValueType::Missing,
        )
    })?;
    deserialize_bounded(value, None, DecodeStage::CdpWrapper)
}

pub fn reel_probe_from_cdp(result: &Value) -> Result<FacebookReelProbe, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "reel_probe")
}

pub fn feed_probe_from_cdp(result: &Value) -> Result<FacebookFeedProbe, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "feed_probe")
}

pub fn identity_candidates_from_cdp(
    result: &Value,
) -> Result<FacebookIdentityCandidates, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "identity_candidates")
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

pub fn feed_like_target_from_cdp(result: &Value) -> Result<FacebookFeedLikeTarget, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "feed_like_target_probe")
}

pub fn feed_like_commit_from_cdp(result: &Value) -> Result<FacebookFeedLikeCommit, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "feed_like_commit")
}

pub fn feed_like_verify_from_cdp(
    result: &Value,
) -> Result<FacebookFeedLikeVerification, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "feed_like_verify")
}

pub fn feed_like_picker_from_cdp(result: &Value) -> Result<FacebookFeedLikePicker, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "feed_like_picker_probe")
}

pub fn feed_like_clear_from_cdp(result: &Value) -> Result<FacebookFeedLikeClear, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "feed_like_clear")
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

pub fn join_click_from_cdp(result: &Value) -> Result<FacebookJoinClickResult, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "join_click")
}

pub fn first_post_group_root_probe_from_cdp(
    result: &Value,
) -> Result<FacebookFirstPostGroupRootProbe, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "first_post_group_root_probe")
}

pub fn publish_home_probe_from_cdp(
    result: &Value,
) -> Result<FacebookPublishHomeProbe, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "publish_home_probe")
}

pub fn publish_submit_probe_from_cdp(
    result: &Value,
) -> Result<FacebookPublishSubmitProbe, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "publish_submit_probe")
}

pub fn publish_submitted_probe_from_cdp(
    result: &Value,
) -> Result<FacebookPublishSubmittedProbe, EngineError> {
    let result = result_from_cdp(result)?;
    typed_internal_value(result.output, "publish_submitted_probe")
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
    expected_kind: &'static str,
) -> Result<T, EngineError> {
    if output.get("kind").and_then(Value::as_str) != Some(expected_kind) {
        return Err(invalid_result_with_diagnostic(
            DecodeStage::OutputKind,
            Some(expected_kind),
            Some("output.kind".to_owned()),
            json_value_type(output.get("kind")),
        ));
    }
    let value = output.get("value").ok_or_else(|| {
        invalid_result_with_diagnostic(
            DecodeStage::OutputValue,
            Some(expected_kind),
            Some("output.value".to_owned()),
            JsonValueType::Missing,
        )
    })?;
    deserialize_bounded(value, Some(expected_kind), DecodeStage::TypedValue)
}

pub fn typed_output(
    command: &NativeCommand,
    output: Value,
    target_id: &str,
) -> Result<crate::engine::CommandOutput, EngineError> {
    use crate::engine::CommandOutput;
    let kind = output.get("kind").and_then(Value::as_str).ok_or_else(|| {
        invalid_result_with_diagnostic(
            DecodeStage::OutputKind,
            None,
            Some("output.kind".to_owned()),
            json_value_type(output.get("kind")),
        )
    })?;
    let value = output.get("value").ok_or_else(|| {
        invalid_result_with_diagnostic(
            DecodeStage::OutputValue,
            None,
            Some("output.value".to_owned()),
            JsonValueType::Missing,
        )
    })?;
    match kind {
        "page_probe" => {
            let mut probe = deserialize_bounded::<ProbeResult>(
                value,
                Some("page_probe"),
                DecodeStage::TypedValue,
            )?;
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
            deserialize_bounded::<PageCards>(value, Some("page_cards"), DecodeStage::TypedValue)?
                .bounded(),
        )),
        "note_detail" => Ok(CommandOutput::NoteDetail(
            deserialize_bounded::<NoteDetail>(value, Some("note_detail"), DecodeStage::TypedValue)?
                .bounded(),
        )),
        "profile_detail" => Ok(CommandOutput::ProfileDetail(
            deserialize_bounded::<ProfileDetail>(
                value,
                Some("profile_detail"),
                DecodeStage::TypedValue,
            )?
            .bounded(),
        )),
        "identity_receipt" => Ok(CommandOutput::FacebookIdentity(
            deserialize_bounded::<FacebookIdentityReceipt>(
                value,
                Some("identity_receipt"),
                DecodeStage::TypedValue,
            )?
            .bounded(),
        )),
        "action_receipt" if publish_identity(command).is_none() => {
            Ok(CommandOutput::ActionReceipt(Box::new(
                deserialize_bounded::<ActionReceipt>(
                    value,
                    Some("action_receipt"),
                    DecodeStage::TypedValue,
                )?
                .bounded(),
            )))
        }
        "action_receipt" => {
            let action = deserialize_bounded::<ActionReceipt>(
                value,
                Some("action_receipt"),
                DecodeStage::TypedValue,
            )?
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
            deserialize_bounded::<PublishReceipt>(
                value,
                Some("publish_receipt"),
                DecodeStage::TypedValue,
            )?
            .bounded(),
        )),
        _ => Err(invalid_result_with_diagnostic(
            DecodeStage::OutputKind,
            None,
            Some("output.kind".to_owned()),
            JsonValueType::String,
        )),
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

fn invalid_result_with_diagnostic(
    decode_stage: DecodeStage,
    expected_kind: Option<&'static str>,
    field_path: Option<String>,
    actual_type: JsonValueType,
) -> EngineError {
    invalid_result().with_decode_diagnostic(ErrorDiagnostic {
        operation_stage: None,
        decode_stage: Some(decode_stage),
        expected_kind,
        field_path,
        actual_type: Some(actual_type),
        exception_class: None,
        exception_reason: None,
        exception_token: None,
        line_number: None,
        column_number: None,
    })
}

fn exception_diagnostic(exception: &Value) -> ErrorDiagnostic {
    let class_name = exception
        .pointer("/exception/className")
        .and_then(Value::as_str);
    let exception_class = match class_name {
        Some("Error") => Some(CdpExceptionClass::Error),
        Some("TypeError") => Some(CdpExceptionClass::TypeError),
        Some("ReferenceError") => Some(CdpExceptionClass::ReferenceError),
        Some("RangeError") => Some(CdpExceptionClass::RangeError),
        Some("SyntaxError") => Some(CdpExceptionClass::SyntaxError),
        Some("EvalError") => Some(CdpExceptionClass::EvalError),
        Some("URIError") => Some(CdpExceptionClass::UriError),
        _ => None,
    };
    let description = exception
        .pointer("/exception/description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .lines()
        .next()
        .unwrap_or_default();
    let (exception_reason, exception_token) = classify_exception_description(description);
    ErrorDiagnostic {
        operation_stage: None,
        decode_stage: Some(DecodeStage::CdpException),
        expected_kind: None,
        field_path: None,
        actual_type: Some(json_value_type(Some(exception))),
        exception_class,
        exception_reason: Some(exception_reason),
        exception_token,
        line_number: exception
            .get("lineNumber")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
        column_number: exception
            .get("columnNumber")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
    }
}

fn classify_exception_description(description: &str) -> (CdpExceptionReason, Option<String>) {
    for quote in ['\'', '"', '`'] {
        let marker = format!("(reading {quote}");
        if let Some(rest) = description.split_once(&marker).map(|(_, rest)| rest)
            && let Some(identifier) = rest.split(quote).next()
        {
            return (
                CdpExceptionReason::CannotReadProperty,
                Some(identifier.to_owned()),
            );
        }
    }
    if let Some(identifier) = description
        .strip_prefix("ReferenceError: ")
        .and_then(|value| value.strip_suffix(" is not defined"))
    {
        return (
            CdpExceptionReason::ReferenceNotDefined,
            Some(identifier.to_owned()),
        );
    }
    if description.ends_with(" is not a function") {
        return (CdpExceptionReason::NotAFunction, None);
    }
    (CdpExceptionReason::Other, None)
}

fn deserialize_bounded<T: DeserializeOwned>(
    value: &Value,
    expected_kind: Option<&'static str>,
    decode_stage: DecodeStage,
) -> Result<T, EngineError> {
    serde_path_to_error::deserialize(value.clone()).map_err(|error| {
        let path = error.path();
        let missing_field = missing_field_name(&error.inner().to_string());
        let field_path = diagnostic_field_path(path, missing_field.as_deref());
        let actual_type = if missing_field.is_some() {
            JsonValueType::Missing
        } else {
            json_value_type(value_at_path(value, path))
        };
        invalid_result_with_diagnostic(decode_stage, expected_kind, field_path, actual_type)
    })
}

fn diagnostic_field_path(path: &Path, missing_field: Option<&str>) -> Option<String> {
    let base = path.to_string();
    let base = (base != ".").then_some(base);
    match (base, missing_field) {
        (Some(base), Some(field)) => Some(format!("{base}.{field}")),
        (Some(base), None) => Some(base),
        (None, Some(field)) => Some(field.to_owned()),
        (None, None) => None,
    }
}

fn missing_field_name(message: &str) -> Option<String> {
    let rest = message.strip_prefix("missing field `")?;
    let field = rest.split('`').next()?;
    (!field.is_empty()
        && field.len() <= 64
        && field
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_'))
    .then(|| field.to_owned())
}

fn value_at_path<'a>(value: &'a Value, path: &Path) -> Option<&'a Value> {
    let mut current = value;
    for segment in path {
        current = match segment {
            Segment::Seq { index } => current.get(*index)?,
            Segment::Map { key } => current.get(key)?,
            Segment::Enum { variant } => current.get(variant)?,
            Segment::Unknown => return None,
        };
    }
    Some(current)
}

fn json_value_type(value: Option<&Value>) -> JsonValueType {
    match value {
        None => JsonValueType::Missing,
        Some(Value::Null) => JsonValueType::Null,
        Some(Value::Bool(_)) => JsonValueType::Boolean,
        Some(Value::Number(_)) => JsonValueType::Number,
        Some(Value::String(_)) => JsonValueType::String,
        Some(Value::Array(_)) => JsonValueType::Array,
        Some(Value::Object(_)) => JsonValueType::Object,
    }
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
    fn first_post_expression_injects_container_only_for_internal_probe_commands() {
        let command: NativeCommand = serde_json::from_str(
            r#"{"kind":"feed_refresh","params":{"reason":"first_commentable_group_post_probe"}}"#,
        )
        .expect("first-post command");
        let container =
            Url::parse("https://www.facebook.com/groups/123").expect("canonical group URL");
        let ordinary = command_expression(&command).expect("ordinary expression");
        let first_post =
            first_post_command_expression(&command, &container).expect("first-post expression");
        let ordinary_input = ordinary.rsplit_once(")(").expect("ordinary router input").1;
        let first_post_input = first_post
            .rsplit_once(")(")
            .expect("first-post router input")
            .1;
        assert!(!ordinary_input.contains(r#""container":"#));
        assert!(first_post_input.contains(r#""container":"https://www.facebook.com/groups/123""#));

        let unrelated: NativeCommand =
            serde_json::from_str(r#"{"kind":"feed_refresh","params":{"reason":"manual"}}"#)
                .expect("unrelated command");
        assert!(first_post_command_expression(&unrelated, &container).is_err());
    }

    #[test]
    fn first_post_group_root_probe_has_a_strict_typed_shape() {
        let cdp_result = json!({
            "result": {
                "value": {
                    "effectPhase": "confirmed",
                    "output": {
                        "kind": "first_post_group_root_probe",
                        "value": {
                            "origin": "https://www.facebook.com",
                            "path": "/groups/123",
                            "search": "",
                            "hash": "",
                            "surface": "group",
                            "readyState": "complete",
                            "blockingKind": "none",
                            "visibleMainCount": 1,
                            "visibleDialogCount": 0,
                            "targetGroupId": "123",
                            "scopeResolved": true,
                            "scopeAmbiguous": false,
                            "feedLoading": false,
                            "scrollY": 0
                        }
                    }
                }
            }
        });
        let probe =
            first_post_group_root_probe_from_cdp(&cdp_result).expect("strict group-root probe");
        assert_eq!(probe.target_group_id.as_deref(), Some("123"));
        assert_eq!(probe.visible_main_count, 1);
        assert_eq!(probe.scroll_y, 0.0);

        let mut unexpected = cdp_result;
        unexpected["result"]["value"]["output"]["value"]["candidate"] = json!("must-not-leak");
        assert!(first_post_group_root_probe_from_cdp(&unexpected).is_err());
    }

    #[test]
    fn reel_probe_uses_only_canonical_note_identity_for_progress() {
        let before = FacebookReelProbe {
            ok: true,
            reason: None,
            note_id: Some("https://www.facebook.com/reel/1".to_owned()),
            video_rect: None,
            input_safe: None,
        };
        assert!(!before.moved_from(&before));

        let moved = FacebookReelProbe {
            note_id: Some("https://www.facebook.com/reel/2".to_owned()),
            ..before.clone()
        };
        assert!(moved.moved_from(&before));

        let missing_identity = FacebookReelProbe {
            note_id: None,
            ..moved
        };
        assert!(!missing_identity.moved_from(&before));

        let anonymous_before = FacebookReelProbe {
            note_id: None,
            ..before.clone()
        };
        let hydrated = FacebookReelProbe {
            note_id: Some("https://www.facebook.com/reel/2".to_owned()),
            ..anonymous_before.clone()
        };
        assert!(hydrated.moved_from(&anonymous_before));
    }

    #[test]
    fn reel_probe_distinguishes_other_surfaces_from_unreadable_reels() {
        let feed = FacebookReelProbe {
            ok: false,
            reason: Some("not_reel".to_owned()),
            note_id: None,
            video_rect: None,
            input_safe: None,
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
                            "explicitEnd": true,
                            "url": "https://www.facebook.com/",
                            "surface": "home",
                            "scrollY": 0,
                            "innerWidth": 1440,
                            "innerHeight": 801,
                            "scrollHeight": 2400,
                            "scrollViewportHeight": 801,
                            "documentTimeOriginMs": 1780000000000_u64,
                            "documentAgeMs": 215964
                        }
                    }
                }
            }
        });

        let probe = feed_probe_from_cdp(&cdp_result).expect("bounded feed probe");
        assert_eq!(probe.document_time_origin_ms, 1_780_000_000_000);
        assert_eq!(probe.document_age_ms, 215_964);
        assert!(probe.explicit_end);

        let mut fractional = cdp_result;
        fractional["result"]["value"]["output"]["value"]["documentAgeMs"] =
            json!(215964.39990234375);
        assert!(feed_probe_from_cdp(&fractional).is_err());
    }

    #[test]
    fn bounded_result_diagnostics_distinguish_wrapper_kind_and_typed_path() {
        let missing_wrapper =
            result_from_cdp(&json!({ "result": {} })).expect_err("missing result value");
        let wrapper_diagnostic = missing_wrapper.diagnostic.expect("wrapper diagnostic");
        assert_eq!(
            wrapper_diagnostic.decode_stage,
            Some(crate::error::DecodeStage::CdpWrapper)
        );
        assert_eq!(
            wrapper_diagnostic.actual_type,
            Some(crate::error::JsonValueType::Missing)
        );

        let wrong_kind = join_probe_from_cdp(&json!({
            "result": {
                "value": {
                    "effectPhase": "confirmed",
                    "output": {
                        "kind": "consent_probe",
                        "value": {}
                    }
                }
            }
        }))
        .expect_err("unexpected result kind");
        let kind_diagnostic = wrong_kind.diagnostic.expect("kind diagnostic");
        assert_eq!(
            kind_diagnostic.decode_stage,
            Some(crate::error::DecodeStage::OutputKind)
        );
        assert_eq!(kind_diagnostic.expected_kind, Some("join_probe"));
        assert_eq!(
            kind_diagnostic.actual_type,
            Some(crate::error::JsonValueType::String)
        );

        let secret = "raw-page-secret-must-not-escape";
        let typed = join_probe_from_cdp(&json!({
            "result": {
                "value": {
                    "effectPhase": "confirmed",
                    "output": {
                        "kind": "join_probe",
                        "value": {
                            "observation": {
                                "membershipSignals": [],
                                "ctaCandidates": [{
                                    "text": secret,
                                    "kind": "joined",
                                    "inTargetScope": secret
                                }]
                            },
                            "joined": false,
                            "pending": false,
                            "questionnaire": false,
                            "found": false,
                            "ambiguous": false
                        }
                    }
                }
            }
        }))
        .expect_err("nested typed mismatch");
        let typed_diagnostic = typed.diagnostic.expect("typed diagnostic");
        assert_eq!(
            typed_diagnostic.decode_stage,
            Some(crate::error::DecodeStage::TypedValue)
        );
        assert_eq!(typed_diagnostic.expected_kind, Some("join_probe"));
        assert_eq!(
            typed_diagnostic.field_path.as_deref(),
            Some("observation.ctaCandidates[0].inTargetScope")
        );
        assert_eq!(
            typed_diagnostic.actual_type,
            Some(crate::error::JsonValueType::String)
        );
        let encoded = serde_json::to_string(&typed_diagnostic).expect("bounded diagnostic");
        assert!(!encoded.contains(secret));
        assert!(!encoded.contains("invalid type"));

        let exception = result_from_cdp(&json!({
            "exceptionDetails": {
                "lineNumber": 13,
                "columnNumber": 55,
                "exception": {
                    "className": "TypeError",
                    "description": "TypeError: Cannot read properties of null (reading 'querySelectorAll')\nraw stack must not escape"
                }
            }
        }))
        .expect_err("evaluated exception");
        let exception_diagnostic = exception.diagnostic.expect("exception diagnostic");
        assert_eq!(
            exception_diagnostic.exception_class,
            Some(crate::error::CdpExceptionClass::TypeError)
        );
        assert_eq!(
            exception_diagnostic.exception_reason,
            Some(crate::error::CdpExceptionReason::CannotReadProperty)
        );
        assert_eq!(
            exception_diagnostic.exception_token.as_deref(),
            Some("querySelectorAll")
        );
        assert_eq!(exception_diagnostic.line_number, Some(13));
        assert_eq!(exception_diagnostic.column_number, Some(55));
        let encoded = serde_json::to_string(&exception_diagnostic).expect("exception diagnostic");
        assert!(!encoded.contains("raw stack"));
        assert!(!encoded.contains("Cannot read properties"));
    }
}
