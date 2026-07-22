use crate::error::{EngineError, ErrorCode};
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
const MIN_TIMEOUT_MS: u64 = 50;
const MAX_TIMEOUT_MS: u64 = 30_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Xiaohongshu,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeParams {
    pub host: String,
    pub port: u16,
    pub platform: Platform,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub protocol_version: u32,
    pub id: String,
    pub method: String,
    pub params: ProbeParams,
}

impl Request {
    pub fn validate(&self) -> Result<(), EngineError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(EngineError::new(
                ErrorCode::UnsupportedProtocol,
                "unsupported native page engine protocol",
            ));
        }
        if self.method != "probe_page" {
            return Err(EngineError::new(
                ErrorCode::InvalidRequest,
                "unsupported native page engine method",
            ));
        }
        if self.id.is_empty()
            || self.id.len() > 128
            || !self.id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            return Err(EngineError::new(
                ErrorCode::InvalidRequest,
                "invalid request id",
            ));
        }
        if self.params.host.is_empty() || self.params.host.len() > 255 {
            return Err(EngineError::new(
                ErrorCode::InvalidRequest,
                "invalid DevTools host",
            ));
        }
        if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&self.params.timeout_ms) {
            return Err(EngineError::new(
                ErrorCode::InvalidRequest,
                "invalid probe timeout",
            ));
        }
        Ok(())
    }
}

pub fn parse_request(line: &str) -> Result<Request, EngineError> {
    if line.len() > 64 * 1024 {
        return Err(EngineError::new(
            ErrorCode::InvalidRequest,
            "request exceeds protocol limit",
        ));
    }
    let request = serde_json::from_str::<Request>(line)
        .map_err(|_| EngineError::new(ErrorCode::InvalidRequest, "invalid request record"))?;
    request.validate()?;
    Ok(request)
}

pub fn recover_request_id(line: &str) -> String {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| value.get("id")?.as_str().map(str::to_owned))
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                })
        })
        .unwrap_or_default()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyRecord<'a> {
    #[serde(rename = "type")]
    pub record_type: &'static str,
    pub protocol_version: u32,
    pub engine_version: &'a str,
}

impl Default for ReadyRecord<'static> {
    fn default() -> Self {
        Self {
            record_type: "ready",
            protocol_version: PROTOCOL_VERSION,
            engine_version: ENGINE_VERSION,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorRecord {
    pub code: ErrorCode,
    pub message: &'static str,
}

impl From<EngineError> for ErrorRecord {
    fn from(error: EngineError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseRecord<'a, T: Serialize> {
    #[serde(rename = "type")]
    pub record_type: &'static str,
    pub protocol_version: u32,
    pub id: &'a str,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<&'a T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorRecord>,
}

impl<'a, T: Serialize> ResponseRecord<'a, T> {
    pub fn success(id: &'a str, result: &'a T) -> Self {
        Self {
            record_type: "response",
            protocol_version: PROTOCOL_VERSION,
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(id: &'a str, error: EngineError) -> Self {
        Self {
            record_type: "response",
            protocol_version: PROTOCOL_VERSION,
            id,
            ok: false,
            result: None,
            error: Some(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_request() -> String {
        r#"{"protocolVersion":1,"id":"probe_1","method":"probe_page","params":{"host":"127.0.0.1","port":9222,"platform":"xiaohongshu","timeoutMs":5000}}"#.to_owned()
    }

    #[test]
    fn parses_valid_request() {
        let request = parse_request(&valid_request()).expect("valid request");
        assert_eq!(request.id, "probe_1");
        assert_eq!(request.params.platform, Platform::Xiaohongshu);
    }

    #[test]
    fn rejects_protocol_drift() {
        let line = valid_request().replace("\"protocolVersion\":1", "\"protocolVersion\":2");
        let error = parse_request(&line).expect_err("protocol drift");
        assert_eq!(error.code, ErrorCode::UnsupportedProtocol);
    }

    #[test]
    fn rejects_raw_method_surface() {
        let line = valid_request().replace("probe_page", "Runtime.evaluate");
        let error = parse_request(&line).expect_err("raw CDP must be rejected");
        assert_eq!(error.code, ErrorCode::InvalidRequest);
    }

    #[test]
    fn recovers_only_safe_request_ids() {
        assert_eq!(recover_request_id(r#"{"id":"probe-2"}"#), "probe-2");
        assert_eq!(recover_request_id(r#"{"id":"unsafe id"}"#), "");
    }
}
