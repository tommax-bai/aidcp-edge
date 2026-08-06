use crate::embedded_asset_key::EMBEDDED_ASSET_KEY;
use crate::error::{
    CdpExceptionClass, CdpExceptionReason, DecodeStage, EngineError, ErrorCode, ErrorDiagnostic,
    JsonValueType,
};
use serde::{Deserialize, Serialize};
use url::Url;

include!(concat!(env!("OUT_DIR"), "/xhs_page_probe_bytes.rs"));

pub fn xhs_page_probe_expression() -> Result<String, EngineError> {
    let decoded: Vec<u8> = XHS_PAGE_PROBE_BYTES
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ EMBEDDED_ASSET_KEY[index % EMBEDDED_ASSET_KEY.len()])
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
    /// 阻断现场结构化采集（change blocking-overlay-dom-capture）。与 `notification_unread` 同理挂
    /// **顶层**、不并进 `signals`：那组是页型分类用的 u32 计数，塞进去要么污染分类输入、要么把结构压扁。
    ///
    /// 本结构体带 `deny_unknown_fields`，故页面规则新增 `overlayCapture` 时**必须**在此同步声明——
    /// 否则整条 `page_probe` 解码失败 → 探针失败 → sticky 保持上一状态 → **阻断监测失明**。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlay_capture: Option<OverlayCapture>,
}

/// 采集到的一个容器 / 可点击子元素的位置尺寸（相对视口，已取整）。
/// 取整是 `Eq` 的前提，也是刻意的：亚像素精度对写点击动作没有意义。
/// 可为负——容器可能部分位于视口外。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayViewport {
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub z_index: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<String>,
}

/// 容器内的一个可点击子元素。**位置尺寸是硬要求**：同一平台上不同部位所需的点击方式不同
/// （部分部位只有元素点击有效，部分只有坐标点击有效），事先无法判断新形态属于哪一类，
/// 故两种方式所需的信息都必须留全。只留文字的记录，后续写动作时会当场卡住。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayClickable {
    pub tag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_id: Option<String>,
    #[serde(default)]
    pub rect: OverlayRect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayContainer {
    pub tag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aria_modal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aria_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub rect: OverlayRect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<OverlayStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default)]
    pub has_iframe: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iframe_srcs: Option<Vec<String>>,
    #[serde(default)]
    pub clickables: Vec<OverlayClickable>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clickables_truncated: Option<bool>,
    /// 容器 HTML 原文（按上限截断）。信息量最大的一层，作用正是覆盖字段设计未预料到的后续需求
    /// ——缺失它，每一次字段遗漏都必须等待下一次真机复现。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html_truncated: Option<bool>,
}

/// 一次阻断现场采集。
///
/// **刻意不带 `deny_unknown_fields`**：这是留证数据，不是控制信号。若页面规则先行新增一个字段
/// 而 Rust 尚未声明，正确的降级是「那个字段丢了、样本仍然到手」，而不是整条探针解码失败把阻断
/// 监测打瞎。字段漂移由 `page_rule_capture_fields_are_declared` 那条测试拦，使其停在「测试失败」
/// 而非「真机失明」。这与外层 `ProbeResult` 的严格口径是刻意相反的取舍。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayCapture {
    /// 由边缘生成、贯穿「边缘诊断行 → 上报载荷 → 云端样本行 → 告警正文」四处的采集标识。
    /// MUST NOT 由页面内容派生：同一形态的弹窗会反复出现，内容派生的标识会把多次独立采集
    /// 折叠成一条。
    pub capture_id: String,
    #[serde(default)]
    pub kind: String,
    /// 三态诚实：`captured` / `none_visible` / `failed`。
    /// MUST NOT 用同一个空结果同时表示「确实没有」与「没能采到」。
    #[serde(default)]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub captured_at: i64,
    #[serde(default)]
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<OverlayViewport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_frame: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen_count: Option<u32>,
    #[serde(default)]
    pub containers: Vec<OverlayContainer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_exhausted: Option<bool>,
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
        // 小红书页面规则尚未产出阻断现场（其阻断分类本身只认验证码 / 登录墙两桶，
        // 见宿主侧 XIAOHONGSHU_BLOCKING_POLICY）。这是**已声明的缺席**，不是遗漏。
        overlay_capture: None,
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

    /// `ProbeResult` 带 `deny_unknown_fields`：页面规则新增 `overlayCapture` 而这里不声明，
    /// **整条 page_probe 解码失败** → 探针失败 → sticky 保持上一状态 → 阻断监测失明。
    /// 这条用例把那个陷阱钉死在编译 + 测试层，不留给真机。
    fn probe_json_with_capture() -> serde_json::Value {
        serde_json::json!({
            "targetId": "fb-1",
            "origin": "https://www.facebook.com",
            "path": "/reel/2815335378830397",
            "readyState": "complete",
            "pageKind": "unknown",
            "blockingKind": "unknown",
            "blockingText": "Sorry, this feature isn't available right now",
            "signals": {
                "feedCardCount": 0, "noteDetailCount": 0, "loginWallCount": 0,
                "captchaSignalCount": 0, "dialogCount": 1, "profileSignalCount": 0,
                "notificationSignalCount": 0, "publishSignalCount": 0,
                "errorSignalCount": 1, "mainCount": 1
            },
            "overlayCapture": {
                "captureId": "ovc_abc_123",
                "kind": "unknown",
                "status": "captured",
                "capturedAt": 1_760_000_000_000i64,
                "url": "https://www.facebook.com/reel/2815335378830397",
                "viewport": { "width": 1440, "height": 900 },
                "seenCount": 1,
                "containers": [{
                    "tag": "div",
                    "role": "dialog",
                    "ariaModal": "true",
                    "testId": "fb-block-dialog",
                    "path": "div#layer > div[role=dialog]",
                    "rect": { "x": 420, "y": 250, "width": 600, "height": 380 },
                    "style": { "position": "fixed", "zIndex": "10", "opacity": "1" },
                    "hasIframe": false,
                    "clickables": [{
                        "tag": "div", "role": "button", "text": "OK", "label": "OK",
                        "testId": "dlg-ok",
                        "rect": { "x": 880, "y": 560, "width": 96, "height": 36 }
                    }],
                    "html": "<div role=\"dialog\">…</div>",
                    "htmlTruncated": true
                }],
                "truncated": true
            }
        })
    }

    #[test]
    fn probe_result_accepts_overlay_capture() {
        let probe: ProbeResult =
            serde_json::from_value(probe_json_with_capture()).expect("probe with capture decodes");
        let capture = probe.overlay_capture.expect("capture present");
        assert_eq!(capture.capture_id, "ovc_abc_123");
        assert_eq!(capture.status, "captured");
        assert_eq!(capture.containers.len(), 1);

        let container = &capture.containers[0];
        assert_eq!(container.test_id.as_deref(), Some("fb-block-dialog"));
        assert_eq!(container.rect.width, 600);
        // 可点击子元素的坐标必须完整穿过解码：写坐标点击那条路全靠它。
        assert_eq!(container.clickables.len(), 1);
        assert_eq!(container.clickables[0].rect.x, 880);
        assert_eq!(container.clickables[0].label.as_deref(), Some("OK"));
        assert!(container.html.is_some());
        assert_eq!(container.html_truncated, Some(true));
        assert_eq!(capture.truncated, Some(true));
    }

    #[test]
    fn probe_result_without_capture_still_decodes() {
        // 旧客户端 / 小红书路径不带这一格。缺席 MUST 解码成功并回落为「未采集」，
        // MUST NOT 报错——否则一次向后兼容的缺省就把阻断监测打瞎。
        let mut value = probe_json_with_capture();
        value
            .as_object_mut()
            .expect("object")
            .remove("overlayCapture");
        let probe: ProbeResult = serde_json::from_value(value).expect("probe without capture");
        assert!(probe.overlay_capture.is_none());
    }

    #[test]
    fn overlay_capture_three_states_survive_round_trip() {
        // 「确实没有」与「没能采到」端到端必须是两态，MUST NOT 压成同一个空结果。
        for (status, reason) in [
            ("none_visible", None),
            ("failed", Some("capture query exploded")),
        ] {
            let mut value = probe_json_with_capture();
            let capture = value["overlayCapture"]
                .as_object_mut()
                .expect("capture object");
            capture.insert("status".into(), serde_json::json!(status));
            capture.insert("containers".into(), serde_json::json!([]));
            if let Some(reason) = reason {
                capture.insert("reason".into(), serde_json::json!(reason));
            }

            let probe: ProbeResult = serde_json::from_value(value).expect("decodes");
            let capture = probe.overlay_capture.expect("capture present");
            assert_eq!(capture.status, status);
            assert!(capture.containers.is_empty());
            assert_eq!(capture.reason.as_deref(), reason);
        }
    }

    #[test]
    fn overlay_capture_tolerates_undeclared_page_rule_fields() {
        // 与外层 `ProbeResult` 刻意相反的取舍：留证结构不带 `deny_unknown_fields`。
        // 页面规则先行新增字段时，正确的降级是「那一格丢了、样本仍到手」，而不是整条探针失败。
        // 漂移由 edge 侧 `facebook-blocking-overlay-capture.test.ts` 的字段闸拦。
        let mut value = probe_json_with_capture();
        value["overlayCapture"]
            .as_object_mut()
            .expect("capture object")
            .insert("fieldFromNewerPageRule".into(), serde_json::json!(1));
        let probe: ProbeResult = serde_json::from_value(value).expect("unknown field tolerated");
        assert!(probe.overlay_capture.is_some());
    }
}
