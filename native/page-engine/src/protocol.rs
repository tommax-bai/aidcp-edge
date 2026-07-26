pub use crate::command::{NativeCommand, PageProbeParams};
use crate::error::{EngineError, ErrorCode};
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 2;
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PLATFORM_ADAPTER_VERSION: &str = "multi-platform-v1";
pub const CAPABILITY_DIGEST: &str = env!("AIDCP_PAGE_ENGINE_CAPABILITY_DIGEST");
pub const MAX_RECORD_BYTES: usize = 64 * 1024;
const MIN_TIMEOUT_MS: u64 = 50;
const MAX_TIMEOUT_MS: u64 = 30_000;
const MAX_FACEBOOK_TIMEOUT_MS: u64 = 90_000;
const MAX_IDENTIFIER_BYTES: usize = 128;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Xiaohongshu,
    Facebook,
    WechatChannels,
}

impl Platform {
    pub const fn adapter_version(self) -> &'static str {
        match self {
            Self::Xiaohongshu => "xiaohongshu-v1",
            Self::Facebook => "facebook-v1",
            Self::WechatChannels => "wechat-channels-v1",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SessionOpenParams {
    pub host: String,
    pub port: u16,
    pub platform: Platform,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SessionOpenRecord {
    pub protocol_version: u32,
    pub id: String,
    pub session_id: String,
    pub task_id: String,
    pub params: SessionOpenParams,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SessionStatusRecord {
    pub protocol_version: u32,
    pub id: String,
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SessionCloseRecord {
    pub protocol_version: u32,
    pub id: String,
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommandRecord {
    pub protocol_version: u32,
    pub id: String,
    pub session_id: String,
    pub task_id: String,
    pub command_id: u64,
    pub deadline_unix_ms: u64,
    pub command: NativeCommand,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CancelRecord {
    pub protocol_version: u32,
    pub id: String,
    pub session_id: String,
    pub task_id: String,
    pub command_id: u64,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShutdownRecord {
    pub protocol_version: u32,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InputRecord {
    SessionOpen(SessionOpenRecord),
    SessionStatus(SessionStatusRecord),
    SessionClose(SessionCloseRecord),
    Command(CommandRecord),
    Cancel(CancelRecord),
    Shutdown(ShutdownRecord),
}

impl InputRecord {
    pub fn id(&self) -> &str {
        match self {
            Self::SessionOpen(record) => &record.id,
            Self::SessionStatus(record) => &record.id,
            Self::SessionClose(record) => &record.id,
            Self::Command(record) => &record.id,
            Self::Cancel(record) => &record.id,
            Self::Shutdown(record) => &record.id,
        }
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        let protocol_version = match self {
            Self::SessionOpen(record) => record.protocol_version,
            Self::SessionStatus(record) => record.protocol_version,
            Self::SessionClose(record) => record.protocol_version,
            Self::Command(record) => record.protocol_version,
            Self::Cancel(record) => record.protocol_version,
            Self::Shutdown(record) => record.protocol_version,
        };
        if protocol_version != PROTOCOL_VERSION {
            return Err(EngineError::new(
                ErrorCode::UnsupportedProtocol,
                "unsupported native page engine protocol",
            ));
        }
        validate_identifier(self.id(), "invalid request id")?;
        match self {
            Self::SessionOpen(record) => {
                validate_identifier(&record.session_id, "invalid session id")?;
                validate_identifier(&record.task_id, "invalid task id")?;
                if record.params.host.is_empty() || record.params.host.len() > 255 {
                    return Err(invalid_request("invalid DevTools host"));
                }
                let max_timeout_ms = if record.params.platform == Platform::Facebook {
                    MAX_FACEBOOK_TIMEOUT_MS
                } else {
                    MAX_TIMEOUT_MS
                };
                if !(MIN_TIMEOUT_MS..=max_timeout_ms).contains(&record.params.timeout_ms) {
                    return Err(invalid_request("invalid session timeout"));
                }
            }
            Self::SessionStatus(record) => {
                validate_identifier(&record.session_id, "invalid session id")?;
            }
            Self::SessionClose(record) => {
                validate_identifier(&record.session_id, "invalid session id")?;
            }
            Self::Command(record) => {
                validate_identifier(&record.session_id, "invalid session id")?;
                validate_identifier(&record.task_id, "invalid task id")?;
                if record.command_id == 0 {
                    return Err(invalid_request("invalid command id"));
                }
                if record.deadline_unix_ms == 0 {
                    return Err(invalid_request("invalid command deadline"));
                }
                record.command.validate()?;
            }
            Self::Cancel(record) => {
                validate_identifier(&record.session_id, "invalid session id")?;
                validate_identifier(&record.task_id, "invalid task id")?;
                if record.command_id == 0 {
                    return Err(invalid_request("invalid command id"));
                }
                if record
                    .reason
                    .as_ref()
                    .is_some_and(|reason| reason.len() > 256)
                {
                    return Err(invalid_request(
                        "cancellation reason exceeds protocol limit",
                    ));
                }
            }
            Self::Shutdown(_) => {}
        }
        Ok(())
    }
}

pub fn parse_input(line: &str) -> Result<InputRecord, EngineError> {
    if line.len() > MAX_RECORD_BYTES {
        return Err(invalid_request("request exceeds protocol limit"));
    }
    let record = serde_json::from_str::<InputRecord>(line)
        .map_err(|_| invalid_request("invalid request record"))?;
    record.validate()?;
    Ok(record)
}

pub fn recover_request_id(line: &str) -> String {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| value.get("id")?.as_str().map(str::to_owned))
        .filter(|id| is_safe_identifier(id))
        .unwrap_or_default()
}

fn validate_identifier(value: &str, message: &'static str) -> Result<(), EngineError> {
    if is_safe_identifier(value) {
        Ok(())
    } else {
        Err(invalid_request(message))
    }
}

fn is_safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
}

fn invalid_request(message: &'static str) -> EngineError {
    EngineError::new(ErrorCode::InvalidRequest, message)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineManifestRecord<'a> {
    pub engine_version: &'a str,
    pub platform_adapter_version: &'a str,
    pub platform_adapters: [PlatformAdapterRecord<'a>; 3],
    pub capability_digest: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformAdapterRecord<'a> {
    pub platform: Platform,
    pub adapter_version: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyRecord<'a> {
    #[serde(rename = "type")]
    pub record_type: &'static str,
    pub protocol_version: u32,
    pub manifest: EngineManifestRecord<'a>,
}

impl Default for ReadyRecord<'static> {
    fn default() -> Self {
        Self {
            record_type: "ready",
            protocol_version: PROTOCOL_VERSION,
            manifest: EngineManifestRecord {
                engine_version: ENGINE_VERSION,
                platform_adapter_version: PLATFORM_ADAPTER_VERSION,
                platform_adapters: [
                    PlatformAdapterRecord {
                        platform: Platform::Xiaohongshu,
                        adapter_version: Platform::Xiaohongshu.adapter_version(),
                    },
                    PlatformAdapterRecord {
                        platform: Platform::Facebook,
                        adapter_version: Platform::Facebook.adapter_version(),
                    },
                    PlatformAdapterRecord {
                        platform: Platform::WechatChannels,
                        adapter_version: Platform::WechatChannels.adapter_version(),
                    },
                ],
                capability_digest: CAPABILITY_DIGEST,
            },
        }
    }
}

#[derive(Clone, Debug, Serialize)]
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectPhase {
    NotStarted,
    Dispatched,
    Confirmed,
    Ambiguous,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleResponse<'a, T: Serialize> {
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

impl<'a, T: Serialize> LifecycleResponse<'a, T> {
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResultRecord<'a, T: Serialize> {
    #[serde(rename = "type")]
    pub record_type: &'static str,
    pub protocol_version: u32,
    pub id: &'a str,
    pub session_id: &'a str,
    pub task_id: &'a str,
    pub command_id: u64,
    pub ok: bool,
    pub effect_phase: EffectPhase,
    pub reason_code: ErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<&'a T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorRecord>,
}

impl<'a, T: Serialize> CommandResultRecord<'a, T> {
    pub fn success(request: &'a CommandRecord, effect_phase: EffectPhase, result: &'a T) -> Self {
        Self {
            record_type: "command_result",
            protocol_version: PROTOCOL_VERSION,
            id: &request.id,
            session_id: &request.session_id,
            task_id: &request.task_id,
            command_id: request.command_id,
            ok: effect_phase == EffectPhase::Confirmed,
            effect_phase,
            reason_code: ErrorCode::Confirmed,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(
        request: &'a CommandRecord,
        effect_phase: EffectPhase,
        error: EngineError,
    ) -> Self {
        Self {
            record_type: "command_result",
            protocol_version: PROTOCOL_VERSION,
            id: &request.id,
            session_id: &request.session_id,
            task_id: &request.task_id,
            command_id: request.command_id,
            ok: false,
            effect_phase,
            reason_code: error.code,
            result: None,
            error: Some(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_session_open() -> String {
        r#"{"type":"session_open","protocolVersion":2,"id":"open_1","sessionId":"session-1","taskId":"browse-1","params":{"host":"127.0.0.1","port":9222,"platform":"xiaohongshu","timeoutMs":5000}}"#.to_owned()
    }

    fn valid_command() -> String {
        r#"{"type":"command","protocolVersion":2,"id":"request-2","sessionId":"session-1","taskId":"browse-1","commandId":1,"deadlineUnixMs":4102444800000,"command":{"kind":"page_probe","params":{}}}"#.to_owned()
    }

    #[test]
    fn parses_valid_session_and_command_records() {
        let open = parse_input(&valid_session_open()).expect("session open");
        assert!(matches!(open, InputRecord::SessionOpen(_)));
        let command = parse_input(&valid_command()).expect("command");
        let InputRecord::Command(command) = command else {
            panic!("expected command");
        };
        assert_eq!(command.command_id, 1);
        assert_eq!(command.task_id, "browse-1");
    }

    #[test]
    fn permits_the_long_session_ceiling_only_for_facebook() {
        let facebook = valid_session_open()
            .replace("\"platform\":\"xiaohongshu\"", "\"platform\":\"facebook\"")
            .replace("\"timeoutMs\":5000", "\"timeoutMs\":90000");
        assert!(matches!(
            parse_input(&facebook).expect("Facebook long join session"),
            InputRecord::SessionOpen(_)
        ));

        let xiaohongshu = valid_session_open().replace("\"timeoutMs\":5000", "\"timeoutMs\":90000");
        assert_eq!(
            parse_input(&xiaohongshu)
                .expect_err("non-Facebook long session")
                .code,
            ErrorCode::InvalidRequest
        );
    }

    #[test]
    fn rejects_protocol_drift() {
        let line = valid_session_open().replace("\"protocolVersion\":2", "\"protocolVersion\":1");
        let error = parse_input(&line).expect_err("protocol drift");
        assert_eq!(error.code, ErrorCode::UnsupportedProtocol);
    }

    #[test]
    fn rejects_generic_browser_surface_and_unknown_fields() {
        for command in [
            r#"{"kind":"runtime_evaluate","params":{"script":"document.body"}}"#,
            r#"{"kind":"page_probe","params":{"selector":"body"}}"#,
        ] {
            let line = valid_command().replace(r#"{"kind":"page_probe","params":{}}"#, command);
            let error = parse_input(&line).expect_err("generic browser surface");
            assert_eq!(error.code, ErrorCode::InvalidRequest);
        }
    }

    #[test]
    fn rejects_invalid_identity_and_deadline() {
        let unsafe_id = valid_command().replace("browse-1", "unsafe task");
        assert_eq!(
            parse_input(&unsafe_id).expect_err("unsafe task").code,
            ErrorCode::InvalidRequest
        );
        let missing_deadline = valid_command().replace("4102444800000", "0");
        assert_eq!(
            parse_input(&missing_deadline)
                .expect_err("missing deadline")
                .code,
            ErrorCode::InvalidRequest
        );
    }

    #[test]
    fn recovers_only_safe_request_ids() {
        assert_eq!(recover_request_id(r#"{"id":"command:2"}"#), "command:2");
        assert_eq!(recover_request_id(r#"{"id":"unsafe id"}"#), "");
    }

    #[test]
    fn serializes_all_effect_phases_stably() {
        assert_eq!(
            serde_json::to_string(&[
                EffectPhase::NotStarted,
                EffectPhase::Dispatched,
                EffectPhase::Confirmed,
                EffectPhase::Ambiguous,
            ])
            .expect("effect phases"),
            r#"["not_started","dispatched","confirmed","ambiguous"]"#
        );
    }
}
