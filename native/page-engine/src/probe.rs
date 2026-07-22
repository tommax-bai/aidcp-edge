use crate::error::{EngineError, ErrorCode};
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
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
    Error,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RawPageSignals {
    pub href: String,
    pub ready_state: String,
    pub feed_card_count: u32,
    pub note_detail_count: u32,
    pub login_wall_count: u32,
    pub dialog_count: u32,
    pub profile_signal_count: u32,
    #[serde(default)]
    pub notification_signal_count: u32,
    #[serde(default)]
    pub publish_signal_count: u32,
    #[serde(default)]
    pub error_signal_count: u32,
    pub main_count: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSignals {
    pub feed_card_count: u32,
    pub note_detail_count: u32,
    pub login_wall_count: u32,
    pub dialog_count: u32,
    pub profile_signal_count: u32,
    pub notification_signal_count: u32,
    pub publish_signal_count: u32,
    pub error_signal_count: u32,
    pub main_count: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub target_id: String,
    pub origin: String,
    pub path: String,
    pub ready_state: String,
    pub page_kind: PageKind,
    pub signals: StructuralSignals,
}

pub fn result_from_cdp(
    target_id: String,
    cdp_result: &serde_json::Value,
) -> Result<ProbeResult, EngineError> {
    if cdp_result.get("exceptionDetails").is_some() {
        return Err(EngineError::new(
            ErrorCode::ProbeFailed,
            "native page probe raised an exception",
        ));
    }
    let value = cdp_result
        .pointer("/result/value")
        .ok_or_else(invalid_probe_result)?;
    let raw = serde_json::from_value::<RawPageSignals>(value.clone())
        .map_err(|_| invalid_probe_result())?;
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
        dialog_count: raw.dialog_count.min(999),
        profile_signal_count: raw.profile_signal_count.min(999),
        notification_signal_count: raw.notification_signal_count.min(999),
        publish_signal_count: raw.publish_signal_count.min(999),
        error_signal_count: raw.error_signal_count.min(999),
        main_count: raw.main_count.min(999),
    };
    let page_kind = classify_page(host, &path, &signals);
    Ok(ProbeResult {
        target_id,
        origin,
        path,
        ready_state: normalize_ready_state(&raw.ready_state),
        page_kind,
        signals,
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
            dialog_count: 0,
            profile_signal_count: 0,
            notification_signal_count: 0,
            publish_signal_count: 0,
            error_signal_count: 0,
            main_count: 1,
        }
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
