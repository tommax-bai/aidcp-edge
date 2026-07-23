use crate::cdp::CdpSession;
use crate::error::{EngineError, ErrorCode};
use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

const CAPTURE_POLL_TIMEOUT: Duration = Duration::from_millis(1_000);
const MAX_COOKIES: usize = 128;
const MAX_SESSION_BYTES: usize = 56 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WechatCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<f64>,
    pub http_only: bool,
    pub secure: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WechatRequestCommonBody {
    pub log_finder_id: String,
    pub log_finder_uin: String,
    pub raw_key_buff: String,
    pub plugin_session_id: Option<String>,
    pub req_scene: i64,
    pub scene: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WechatRequestHeaders {
    pub fingerprint_device_id: String,
    pub wechat_uin: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WechatRequestContext {
    pub version: u8,
    pub aid: String,
    pub page_url: String,
    pub common_body: WechatRequestCommonBody,
    pub headers: WechatRequestHeaders,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WechatSessionCandidate {
    pub cookies: Vec<WechatCookie>,
    pub user_agent: String,
    pub acquired_at: u64,
    pub request_context: WechatRequestContext,
}

pub async fn capture_session(
    cdp: &mut CdpSession,
    initialized: &mut bool,
    captured_context: &mut Option<WechatRequestContext>,
) -> Result<Option<WechatSessionCandidate>, EngineError> {
    if !*initialized {
        cdp.enable_network().await?;
        cdp.bring_to_front().await?;
        cdp.reload().await?;
        *initialized = true;
    }

    if captured_context.is_none() {
        let deadline = tokio::time::Instant::now() + CAPTURE_POLL_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            let Some(event) = cdp.next_network_request(remaining).await? else {
                return Ok(None);
            };
            if let Some(context) = capture_request_context(&event) {
                *captured_context = Some(context);
                break;
            }
        }
    }
    let request_context = captured_context.clone().ok_or_else(invalid_capture)?;

    let cookies = collect_cookies(&cdp.all_cookies().await?)?;
    if cookies.is_empty() {
        return Ok(None);
    }
    let user_agent_result = cdp.evaluate("navigator.userAgent", false).await?;
    let user_agent = user_agent_result
        .pointer("/result/value")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 1_024)
        .map(str::to_owned);
    let Some(user_agent) = user_agent else {
        return Ok(None);
    };
    let candidate = WechatSessionCandidate {
        cookies,
        user_agent,
        acquired_at: unix_time_ms(),
        request_context,
    };
    if serde_json::to_vec(&candidate)
        .map_err(|_| invalid_capture())?
        .len()
        > MAX_SESSION_BYTES
    {
        return Err(invalid_capture());
    }
    Ok(Some(candidate))
}

pub fn capture_request_context(event: &Value) -> Option<WechatRequestContext> {
    let request = event.get("request")?;
    let raw_url = request.get("url")?.as_str()?;
    let post_data = request.get("postData")?.as_str()?;
    if raw_url.len() > 8 * 1024 || post_data.len() > 32 * 1024 {
        return None;
    }
    let url = Url::parse(raw_url).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("channels.weixin.qq.com")
        || !url.path().ends_with("/auth/auth_data")
    {
        return None;
    }
    let aid = url
        .query_pairs()
        .find_map(|(key, value)| (key == "_aid").then(|| value.into_owned()))
        .filter(|value| valid_nonempty(value, 1_024))?;
    let page_url = url
        .query_pairs()
        .find_map(|(key, value)| (key == "_pageUrl").then(|| value.into_owned()))
        .filter(|value| valid_nonempty(value, 8 * 1024))?;
    let body = serde_json::from_str::<Value>(post_data).ok()?;
    let log_finder_id = bounded_required(&body, "_log_finder_id", 1_024)?;
    let log_finder_uin = bounded_string(&body, "_log_finder_uin", 1_024)?;
    let raw_key_buff = bounded_string(&body, "rawKeyBuff", 16 * 1024)?;
    let plugin_session_id = match body.get("pluginSessionId") {
        Some(Value::Null) | None => None,
        Some(Value::String(value)) if value.len() <= 4 * 1024 => Some(value.clone()),
        _ => return None,
    };
    let req_scene = body.get("reqScene")?.as_i64()?;
    let scene = body.get("scene")?.as_i64()?;
    let headers = request.get("headers")?.as_object()?;
    let fingerprint_device_id = header(headers, "finger-print-device-id", 1_024)?;
    let wechat_uin = header(headers, "x-wechat-uin", 1_024)?;
    Some(WechatRequestContext {
        version: 1,
        aid,
        page_url,
        common_body: WechatRequestCommonBody {
            log_finder_id,
            log_finder_uin,
            raw_key_buff,
            plugin_session_id,
            req_scene,
            scene,
        },
        headers: WechatRequestHeaders {
            fingerprint_device_id,
            wechat_uin,
        },
    })
}

fn collect_cookies(result: &Value) -> Result<Vec<WechatCookie>, EngineError> {
    let Some(raw_cookies) = result.get("cookies").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut cookies = Vec::new();
    for raw in raw_cookies {
        let domain = raw
            .get("domain")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let normalized = domain.trim_start_matches('.').to_ascii_lowercase();
        if normalized != "weixin.qq.com" && !normalized.ends_with(".weixin.qq.com") {
            continue;
        }
        if cookies.len() >= MAX_COOKIES {
            return Err(invalid_capture());
        }
        let Some(name) = required_cookie_field(raw, "name", 256) else {
            return Err(invalid_capture());
        };
        let Some(value) = required_cookie_field(raw, "value", 8 * 1024) else {
            return Err(invalid_capture());
        };
        if domain.len() > 255 {
            return Err(invalid_capture());
        }
        let path = raw
            .get("path")
            .and_then(Value::as_str)
            .filter(|value| value.len() <= 1_024)
            .unwrap_or("/")
            .to_owned();
        let same_site = raw
            .get("sameSite")
            .and_then(Value::as_str)
            .filter(|value| value.len() <= 32)
            .map(str::to_owned);
        cookies.push(WechatCookie {
            name,
            value,
            domain: domain.to_owned(),
            path,
            expires: raw.get("expires").and_then(Value::as_f64),
            http_only: raw
                .get("httpOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            secure: raw.get("secure").and_then(Value::as_bool).unwrap_or(false),
            same_site,
        });
    }
    Ok(cookies)
}

fn bounded_required(value: &Value, key: &str, max: usize) -> Option<String> {
    bounded_string(value, key, max).filter(|value| !value.is_empty())
}

fn bounded_string(value: &Value, key: &str, max: usize) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .filter(|value| value.len() <= max)
        .map(str::to_owned)
}

fn header(headers: &serde_json::Map<String, Value>, expected: &str, max: usize) -> Option<String> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(expected))
        .and_then(|(_, value)| value.as_str())
        .filter(|value| valid_nonempty(value, max))
        .map(str::to_owned)
}

fn required_cookie_field(value: &Value, key: &str, max: usize) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .filter(|value| valid_nonempty(value, max))
        .map(str::to_owned)
}

fn valid_nonempty(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn invalid_capture() -> EngineError {
    EngineError::new(
        ErrorCode::CdpError,
        "native WeChat session capture returned invalid or unbounded data",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_only_the_exact_bounded_auth_request_shape() {
        let event = json!({
            "request": {
                "url": "https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data?_aid=aid-test&_pageUrl=https%3A%2F%2Fchannels.weixin.qq.com%2Fplatform%2Fpost%2Flist",
                "postData": r#"{"_log_finder_id":"finder-test","_log_finder_uin":"","rawKeyBuff":"","pluginSessionId":null,"reqScene":7,"scene":7}"#,
                "headers": {
                    "finger-print-device-id": "device-test",
                    "X-WECHAT-UIN": "uin-test"
                }
            }
        });
        let captured = capture_request_context(&event).expect("captured");
        assert_eq!(captured.aid, "aid-test");
        assert_eq!(captured.common_body.log_finder_uin, "");
        assert_eq!(captured.headers.wechat_uin, "uin-test");
    }

    #[test]
    fn rejects_lookalike_hosts_and_arbitrary_requests() {
        for url in [
            "https://channels.weixin.qq.com.evil.test/auth/auth_data?_aid=a&_pageUrl=p",
            "https://channels.weixin.qq.com/other?_aid=a&_pageUrl=p",
        ] {
            let event = json!({
                "request": {
                    "url": url,
                    "postData": "{}",
                    "headers": {}
                }
            });
            assert!(capture_request_context(&event).is_none());
        }
    }

    #[test]
    fn filters_cookie_domains_and_preserves_required_fields() {
        let cookies = collect_cookies(&json!({
            "cookies": [
                {"name":"session","value":"secret","domain":".weixin.qq.com","path":"/","httpOnly":true,"secure":true},
                {"name":"other","value":"ignored","domain":".example.com","path":"/"}
            ]
        }))
        .expect("cookies");
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].name, "session");
        assert!(cookies[0].http_only);
    }
}
