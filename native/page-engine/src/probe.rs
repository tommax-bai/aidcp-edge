use crate::error::{
    CdpExceptionClass, CdpExceptionReason, DecodeStage, EngineError, ErrorCode, ErrorDiagnostic,
    JsonValueType,
};
use serde::{Deserialize, Serialize};
use url::Url;

include!(concat!(env!("OUT_DIR"), "/xhs_page_probe_bytes.rs"));

const PROBE_KEY: &[u8] = &[
    0x91, 0x2f, 0xc4, 0x6a, 0x5d, 0xe3, 0x18, 0xb7, 0x42, 0x0d, 0xfa,
];

pub fn xhs_page_probe_expression() -> Result<String, EngineError> {
    let decoded: Vec<u8> = XHS_PAGE_PROBE_BYTES
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ PROBE_KEY[index % PROBE_KEY.len()])
        .collect();
    String::from_utf8(decoded).map_err(|_| invalid_probe_result())
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PageKind {
    Home,
    Explore,
    Search,
    NoteDetail,
    Profile,
    Notification,
    Publish,
    Login,
    Captcha,
    Error,
    Unknown,
}

/// 通知未读读数的三态。
///
/// 「读不到」（`Unreadable`）与「没有未读」（`Clear`）必须可区分：下游把「没有未读」
/// 当成已清零直接跳过，一次读取失败若静默变成「已清零」，真通知就永远不会被处理。
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationUnreadState {
    Unread,
    Clear,
    #[default]
    Unreadable,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NotificationUnreadSignal {
    pub state: NotificationUnreadState,
    /// 附带计数（红点无数字时为 0），不参与「有没有未读」的判定。
    pub count: u32,
}

impl NotificationUnreadSignal {
    /// 「读不到」是缺省态：线上不带该字段与带一个 unreadable 读数等价，
    /// 宿主两种情况都解析成 unreadable。故序列化时省略这一态，既有探针契约无需随之变形。
    fn is_unreadable(&self) -> bool {
        matches!(self.state, NotificationUnreadState::Unreadable)
    }
}

/// 页面规则侧的宽松读数（与 `RawPageSignals` 一样不拒绝未知字段）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RawNotificationUnread {
    pub state: String,
    #[serde(default)]
    pub count: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RawPageSignals {
    pub href: String,
    pub ready_state: String,
    pub feed_card_count: u32,
    pub note_detail_count: u32,
    pub login_wall_count: u32,
    #[serde(default)]
    pub captcha_signal_count: u32,
    pub dialog_count: u32,
    pub profile_signal_count: u32,
    #[serde(default)]
    pub notification_signal_count: u32,
    #[serde(default)]
    pub publish_signal_count: u32,
    #[serde(default)]
    pub error_signal_count: u32,
    pub main_count: u32,
    #[serde(default)]
    pub notification_unread: Option<RawNotificationUnread>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSignals {
    pub feed_card_count: u32,
    pub note_detail_count: u32,
    pub login_wall_count: u32,
    pub captcha_signal_count: u32,
    pub dialog_count: u32,
    pub profile_signal_count: u32,
    pub notification_signal_count: u32,
    pub publish_signal_count: u32,
    pub error_signal_count: u32,
    pub main_count: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub target_id: String,
    pub origin: String,
    pub path: String,
    pub ready_state: String,
    pub page_kind: PageKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocking_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocking_text: Option<String>,
    pub signals: StructuralSignals,
    /// 通知未读读数。刻意**不**并进 `signals` —— 那组字段全是页型分类用的计数（u32），
    /// 塞进去要么污染分类输入，要么把三态压扁成计数、丢掉「读不到」这一态。
    #[serde(
        default,
        skip_serializing_if = "NotificationUnreadSignal::is_unreadable"
    )]
    pub notification_unread: NotificationUnreadSignal,
}

pub fn result_from_cdp(
    target_id: String,
    cdp_result: &serde_json::Value,
) -> Result<ProbeResult, EngineError> {
    // 解码失败必须说得出「在哪一步、哪个字段、页面抛的是什么」。裸错误只留下一句
    // 「结果无效」，真机上无从判断是规则改版、字段漂移，还是页面根本没跑起来。
    if let Some(exception) = cdp_result.get("exceptionDetails") {
        return Err(EngineError::new(
            ErrorCode::ProbeFailed,
            "native page probe raised an exception",
        )
        .with_decode_diagnostic(exception_diagnostic(exception)));
    }
    let value = cdp_result.pointer("/result/value").ok_or_else(|| {
        invalid_probe_result().with_decode_diagnostic(decode_diagnostic(
            DecodeStage::CdpWrapper,
            None,
            Some("result.value".to_owned()),
            JsonValueType::Missing,
        ))
    })?;
    let raw = deserialize_with_diagnostic::<RawPageSignals>(
        value,
        Some("page_probe"),
        DecodeStage::TypedValue,
    )
    .map_err(|diagnostic| invalid_probe_result().with_decode_diagnostic(diagnostic))?;
    build_result(target_id, raw)
}

pub fn build_result(target_id: String, raw: RawPageSignals) -> Result<ProbeResult, EngineError> {
    let url = Url::parse(&raw.href).map_err(|_| invalid_probe_result())?;
    let host = url.host_str().ok_or_else(invalid_probe_result)?;
    if !(host == "xiaohongshu.com" || host.ends_with(".xiaohongshu.com")) {
        return Err(invalid_probe_result());
    }
    let origin = match url.port() {
        Some(port) => format!("{}://{}:{port}", url.scheme(), host),
        None => format!("{}://{}", url.scheme(), host),
    };
    let path = url.path().to_owned();
    let signals = StructuralSignals {
        feed_card_count: raw.feed_card_count.min(999),
        note_detail_count: raw.note_detail_count.min(999),
        login_wall_count: raw.login_wall_count.min(1),
        captcha_signal_count: raw.captcha_signal_count.min(1),
        dialog_count: raw.dialog_count.min(999),
        profile_signal_count: raw.profile_signal_count.min(999),
        notification_signal_count: raw.notification_signal_count.min(999),
        publish_signal_count: raw.publish_signal_count.min(999),
        error_signal_count: raw.error_signal_count.min(999),
        main_count: raw.main_count.min(999),
    };
    // 只有恰为这两个已知取值才认；其余（页面规则抛错 / 取值漂移 / 字段缺失）一律「读不到」。
    // MUST NOT 回落成「无未读」。
    let notification_unread = match raw.notification_unread {
        Some(value) => {
            let state = match value.state.as_str() {
                "unread" => NotificationUnreadState::Unread,
                "clear" => NotificationUnreadState::Clear,
                _ => NotificationUnreadState::Unreadable,
            };
            NotificationUnreadSignal {
                state,
                count: if matches!(state, NotificationUnreadState::Unread) {
                    value.count.min(999)
                } else {
                    0
                },
            }
        }
        None => NotificationUnreadSignal::default(),
    };
    let page_kind = classify_page(host, &path, &signals);
    Ok(ProbeResult {
        target_id,
        origin,
        path,
        ready_state: normalize_ready_state(&raw.ready_state),
        page_kind,
        blocking_kind: None,
        blocking_text: None,
        signals,
        notification_unread,
    })
}

fn normalize_ready_state(value: &str) -> String {
    match value {
        "loading" | "interactive" | "complete" => value.to_owned(),
        _ => "unknown".to_owned(),
    }
}

pub fn classify_page(host: &str, path: &str, signals: &StructuralSignals) -> PageKind {
    if signals.login_wall_count > 0 {
        return PageKind::Login;
    }
    if signals.captcha_signal_count > 0 {
        return PageKind::Captcha;
    }
    if path == "/404" || path.starts_with("/404/") || signals.error_signal_count > 0 {
        return PageKind::Error;
    }
    if host == "creator.xiaohongshu.com"
        && (path.starts_with("/publish/") || signals.publish_signal_count > 0)
    {
        return PageKind::Publish;
    }
    if (path.starts_with("/notification") || path.starts_with("/notice"))
        && (signals.notification_signal_count > 0 || signals.main_count > 0)
    {
        return PageKind::Notification;
    }
    let segments: Vec<_> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let detail_path = (segments.first() == Some(&"explore") && segments.len() >= 2)
        || (segments.first() == Some(&"discovery")
            && segments.get(1) == Some(&"item")
            && segments.len() >= 3);
    if detail_path && signals.note_detail_count > 0 {
        return PageKind::NoteDetail;
    }
    if path.starts_with("/user/profile/") && signals.profile_signal_count > 0 {
        return PageKind::Profile;
    }
    if path.starts_with("/search") && signals.main_count > 0 {
        return PageKind::Search;
    }
    if matches!(path, "/explore" | "/explore/")
        && (signals.feed_card_count > 0 || signals.main_count > 0)
    {
        return PageKind::Explore;
    }
    if path == "/" && signals.main_count > 0 {
        return PageKind::Home;
    }
    PageKind::Unknown
}

fn invalid_probe_result() -> EngineError {
    EngineError::new(
        ErrorCode::ProbeFailed,
        "native page probe returned an invalid result",
    )
}

// ---------------------------------------------------------------------------
// 跨平台共用的**有界**解码诊断
//
// 这一段是平台中立的：解码在哪一阶段失败、哪个字段路径、页面抛的是哪一类异常、在第几行，
// 与是小红书还是页面探测无关。放在这里是因为它必须被小红书结果解码与页面探测解码共用。
// Facebook 侧另有一份等价实现（`facebook.rs` 的私有函数，本 change 不可编辑该文件），
// 三处应在能同时编辑时收口到 `error.rs`。
//
// 边界纪律：诊断只带**结构**信息与受限标识符，MUST NOT 带页面正文、地址或任何凭据——
// 异常描述只用于分类，落进诊断的仅是被 `EngineError::with_decode_diagnostic` 收窄过的标识符。
// ---------------------------------------------------------------------------

pub(crate) fn json_value_type(value: Option<&serde_json::Value>) -> JsonValueType {
    match value {
        None => JsonValueType::Missing,
        Some(serde_json::Value::Null) => JsonValueType::Null,
        Some(serde_json::Value::Bool(_)) => JsonValueType::Boolean,
        Some(serde_json::Value::Number(_)) => JsonValueType::Number,
        Some(serde_json::Value::String(_)) => JsonValueType::String,
        Some(serde_json::Value::Array(_)) => JsonValueType::Array,
        Some(serde_json::Value::Object(_)) => JsonValueType::Object,
    }
}

pub(crate) fn decode_diagnostic(
    decode_stage: DecodeStage,
    expected_kind: Option<&'static str>,
    field_path: Option<String>,
    actual_type: JsonValueType,
) -> ErrorDiagnostic {
    ErrorDiagnostic {
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
    }
}

/// 页面里抛出的异常：记类别 / 原因 / 触发标识符 / 行列，不记描述原文。
pub(crate) fn exception_diagnostic(exception: &serde_json::Value) -> ErrorDiagnostic {
    let exception_class = match exception
        .pointer("/exception/className")
        .and_then(serde_json::Value::as_str)
    {
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
        .and_then(serde_json::Value::as_str)
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
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
        column_number: exception
            .get("columnNumber")
            .and_then(serde_json::Value::as_u64)
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

/// 带字段路径的反序列化。失败时给出诊断，错误码由调用方按自己的域决定。
pub(crate) fn deserialize_with_diagnostic<T: serde::de::DeserializeOwned>(
    value: &serde_json::Value,
    expected_kind: Option<&'static str>,
    decode_stage: DecodeStage,
) -> Result<T, ErrorDiagnostic> {
    serde_path_to_error::deserialize(value.clone()).map_err(|error| {
        let path = error.path().to_string();
        let missing_field = missing_field_name(&error.inner().to_string());
        let field_path = match ((path != ".").then_some(path), missing_field.as_deref()) {
            (Some(base), Some(field)) => Some(format!("{base}.{field}")),
            (Some(base), None) => Some(base),
            (None, Some(field)) => Some(field.to_owned()),
            (None, None) => None,
        };
        let actual_type = if missing_field.is_some() {
            JsonValueType::Missing
        } else {
            json_value_type(Some(value))
        };
        decode_diagnostic(decode_stage, expected_kind, field_path, actual_type)
    })
}

fn missing_field_name(message: &str) -> Option<String> {
    let rest = message.strip_prefix("missing field `")?;
    let field = rest.split('`').next()?;
    (!field.is_empty() && field.len() <= 64).then(|| field.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(href: &str) -> RawPageSignals {
        RawPageSignals {
            href: href.to_owned(),
            ready_state: "complete".to_owned(),
            feed_card_count: 0,
            note_detail_count: 0,
            login_wall_count: 0,
            captcha_signal_count: 0,
            dialog_count: 0,
            profile_signal_count: 0,
            notification_signal_count: 0,
            publish_signal_count: 0,
            error_signal_count: 0,
            main_count: 1,
            notification_unread: None,
        }
    }

    #[test]
    fn keeps_unread_read_failures_distinguishable_from_no_unread() {
        let mut signals = raw("https://www.xiaohongshu.com/explore");
        signals.notification_unread = Some(RawNotificationUnread {
            state: "unread".to_owned(),
            count: 3,
        });
        assert_eq!(
            build_result("target".to_owned(), signals)
                .expect("unread")
                .notification_unread,
            NotificationUnreadSignal {
                state: NotificationUnreadState::Unread,
                count: 3
            }
        );

        let mut clear = raw("https://www.xiaohongshu.com/explore");
        clear.notification_unread = Some(RawNotificationUnread {
            state: "clear".to_owned(),
            // 非未读态不带计数：避免「已清零但计数残留」被下游读成还有未读。
            count: 7,
        });
        assert_eq!(
            build_result("target".to_owned(), clear)
                .expect("clear")
                .notification_unread,
            NotificationUnreadSignal {
                state: NotificationUnreadState::Clear,
                count: 0
            }
        );

        // 取值漂移与字段缺失都是「读不到」，绝不静默变成「无未读」。
        let mut drifted = raw("https://www.xiaohongshu.com/explore");
        drifted.notification_unread = Some(RawNotificationUnread {
            state: "none".to_owned(),
            count: 0,
        });
        assert_eq!(
            build_result("target".to_owned(), drifted)
                .expect("drifted")
                .notification_unread
                .state,
            NotificationUnreadState::Unreadable
        );
        assert_eq!(
            build_result(
                "target".to_owned(),
                raw("https://www.xiaohongshu.com/explore")
            )
            .expect("missing")
            .notification_unread
            .state,
            NotificationUnreadState::Unreadable
        );
    }

    #[test]
    fn classifies_positive_page_evidence() {
        let mut detail = raw("https://www.xiaohongshu.com/explore/abc?xsec_token=secret");
        detail.note_detail_count = 1;
        let result = build_result("target".to_owned(), detail).expect("detail");
        assert_eq!(result.page_kind, PageKind::NoteDetail);
        assert_eq!(result.path, "/explore/abc");
        assert!(
            !serde_json::to_string(&result)
                .expect("json")
                .contains("secret")
        );

        let mut profile = raw("https://www.xiaohongshu.com/user/profile/abc");
        profile.profile_signal_count = 2;
        assert_eq!(
            build_result("target".to_owned(), profile)
                .expect("profile")
                .page_kind,
            PageKind::Profile
        );
    }

    #[test]
    fn login_wins_over_other_signals() {
        let mut signals = raw("https://www.xiaohongshu.com/explore");
        signals.feed_card_count = 20;
        signals.login_wall_count = 1;
        assert_eq!(
            build_result("target".to_owned(), signals)
                .expect("login")
                .page_kind,
            PageKind::Login
        );
    }

    #[test]
    fn classifies_notification_publish_and_error_states() {
        let mut notification = raw("https://www.xiaohongshu.com/notification");
        notification.notification_signal_count = 2;
        assert_eq!(
            build_result("notification".to_owned(), notification)
                .expect("notification")
                .page_kind,
            PageKind::Notification
        );

        let mut publish = raw("https://creator.xiaohongshu.com/publish/publish?source=official");
        publish.publish_signal_count = 3;
        assert_eq!(
            build_result("publish".to_owned(), publish)
                .expect("publish")
                .page_kind,
            PageKind::Publish
        );

        let mut error = raw("https://www.xiaohongshu.com/404");
        error.error_signal_count = 1;
        assert_eq!(
            build_result("error".to_owned(), error)
                .expect("error")
                .page_kind,
            PageKind::Error
        );
    }

    #[test]
    fn ambiguous_detail_is_unknown() {
        let signals = raw("https://www.xiaohongshu.com/explore/abc");
        assert_eq!(
            build_result("target".to_owned(), signals)
                .expect("unknown")
                .page_kind,
            PageKind::Unknown
        );
    }

    #[test]
    fn rejects_non_xiaohongshu_probe_result() {
        let error = build_result("target".to_owned(), raw("https://example.com/explore"))
            .expect_err("foreign page");
        assert_eq!(error.code, ErrorCode::ProbeFailed);
    }

    #[test]
    fn restores_build_encoded_probe_only_inside_native_runtime() {
        let expression = xhs_page_probe_expression().expect("decoded probe");
        assert!(expression.contains("document.querySelectorAll"));
        assert!(expression.contains(".note-detail-mask"));
    }
}
