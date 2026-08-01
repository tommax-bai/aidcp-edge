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
/// 引擎侧对 Facebook `session.open` / 命令 timeout 的准入上限。
///
/// ⚠️ 这是「四处同步」之外**第五处**、也是最容易被整组遗忘的一处：它在引擎入口就把超参拒掉。
/// 漏改的后果不是某条命令变慢，而是 `session.open` 直接被拒、**整个 Facebook 平台一条命令都发不出**。
/// 必须 ≥ 边缘 `src/native-page-engine/runtime.ts` 下发的 FACEBOOK_NATIVE_SESSION_TIMEOUT_MS。
const MAX_FACEBOOK_TIMEOUT_MS: u64 = 180_000;
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
    /// 被准入的那一个浏览器实例的**身份证据**：浏览器级调试地址
    /// （`ws://127.0.0.1:<port>/devtools/browser/<uuid>`）。
    ///
    /// 端口不是身份 —— 同机多环境并行时，指纹浏览器释放的调试端口会被另一个环境复用。
    /// 引擎在**重连**时按它复核「这一次连上的浏览器」是否还是「当初被准入的那一个」，
    /// 对不上就诚实拒绝、不附着任何目标（否则后续一切动作都落在别人的账号里）。
    ///
    /// 用 `Option` + `#[serde(default)]` 而非必填：`deny_unknown_fields` 下新增必填字段会让
    /// **旧宿主 + 新引擎**在 `session.open` 当场解析失败、整条链路开不起来。缺席的代价是
    /// 「重连一律诚实拒绝」（见 `EngineSession::reconnect`），不是「退化成端口对上就接管」。
    ///
    /// ⚠️ 身份**只在开会话时由宿主交付、引擎侧只记下来**。MUST NOT 改成引擎在开会话时
    /// 自读一次 —— 那是一次额外的端点往返，且此刻还没有任何独立事实可以拿来比对（自读自比恒等真）。
    #[serde(default)]
    pub browser_debugger_url: Option<String>,
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
pub struct CommitWindowAckRecord {
    pub protocol_version: u32,
    pub id: String,
    pub session_id: String,
    pub task_id: String,
    pub command_id: u64,
    pub token: String,
    pub label: String,
    pub accepted: bool,
}

/// 宿主对「请把这个会话的端点重新解析一次」的应答。
///
/// 解析不出来（浏览器已不在 / 提供方拿不到端口）时 MUST 省略 `host` / `port`，
/// **MUST NOT 把上一次的值原样回填**：那正是「端口被别的环境复用」这条危害的入口。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EndpointResultRecord {
    pub protocol_version: u32,
    pub id: String,
    pub session_id: String,
    pub task_id: String,
    pub command_id: u64,
    pub token: String,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
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
    CommitWindowAck(CommitWindowAckRecord),
    EndpointResult(EndpointResultRecord),
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
            Self::CommitWindowAck(record) => &record.id,
            Self::EndpointResult(record) => &record.id,
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
            Self::CommitWindowAck(record) => record.protocol_version,
            Self::EndpointResult(record) => record.protocol_version,
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
                // 给了身份证据就必须是**能解析出实例标识**的浏览器级调试地址。
                // 解析不出来时在门口拒掉，绝不接受成「等于没给」——后者会让一条本该
                // 被复核的重连悄悄退回到「无证据」那一档。
                if record
                    .params
                    .browser_debugger_url
                    .as_deref()
                    .is_some_and(|raw| {
                        crate::endpoint::BrowserInstanceIdentity::from_browser_debugger_url(raw)
                            .is_none()
                    })
                {
                    return Err(invalid_request("invalid browser instance identity"));
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
            Self::CommitWindowAck(record) => {
                validate_identifier(&record.session_id, "invalid session id")?;
                validate_identifier(&record.task_id, "invalid task id")?;
                validate_identifier(&record.token, "invalid commit window token")?;
                validate_identifier(&record.label, "invalid commit window label")?;
                if record.command_id == 0 {
                    return Err(invalid_request("invalid command id"));
                }
            }
            Self::EndpointResult(record) => {
                validate_identifier(&record.session_id, "invalid session id")?;
                validate_identifier(&record.task_id, "invalid task id")?;
                validate_identifier(&record.token, "invalid endpoint request token")?;
                if record.command_id == 0 {
                    return Err(invalid_request("invalid command id"));
                }
                // 端点是「要么给全、要么明说给不出」。半份端点（只有 host / 只有 port）
                // 若被接受，另一半就只能拿旧值补，而旧端口正是危害的入口。
                match (record.host.as_deref(), record.port) {
                    (None, None) => {}
                    (Some(host), Some(port)) => {
                        if host.is_empty() || host.len() > 255 || port == 0 {
                            return Err(invalid_request("invalid resolved endpoint"));
                        }
                    }
                    _ => return Err(invalid_request("incomplete resolved endpoint")),
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<crate::error::ErrorDiagnostic>,
}

impl From<EngineError> for ErrorRecord {
    fn from(error: EngineError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            diagnostic: error.diagnostic.map(|diagnostic| *diagnostic),
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

/// 引擎在不可逆写入之前向宿主要一次提交窗口。**线路上只带标签，不带预算数字。**
///
/// 预算的单一事实源在宿主（`NATIVE_COMMIT_WINDOW_BUDGETS`），它同时也是准入白名单：
/// 标签认识就按表授予，不认识就否决这一次窗口并把结论绑到当前命令上。
/// 引擎自报的预算曾经在线路上跑过一段（宿主取 `min(请求, 事实源)`），那时它已经不作数了；
/// 现在连字段一起去掉，免得下一个人以为改引擎那个数字能改到实际窗口。
///
/// 兼容性：旧宿主收到不带该字段的请求会按事实源发放，新宿主收到旧引擎带的该字段会忽略它 ——
/// 两个方向都不破，故不动协议版本。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitWindowRequestRecord<'a> {
    #[serde(rename = "type")]
    pub record_type: &'static str,
    pub protocol_version: u32,
    pub id: &'a str,
    pub session_id: &'a str,
    pub task_id: &'a str,
    pub command_id: u64,
    pub token: &'a str,
    pub label: &'a str,
}

/// 引擎在**重连**时主动向宿主要一次当前端点。与提交窗口请求同一形状：
/// 不占 `id` 空间（沿用当前命令的请求 id 作关联键），宿主经 `endpoint_result` 应答。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointRequestRecord<'a> {
    #[serde(rename = "type")]
    pub record_type: &'static str,
    pub protocol_version: u32,
    pub id: &'a str,
    pub session_id: &'a str,
    pub task_id: &'a str,
    pub command_id: u64,
    pub token: &'a str,
}

impl<'a> EndpointRequestRecord<'a> {
    pub fn new(request: &'a CommandRecord, token: &'a str) -> Self {
        Self {
            record_type: "endpoint_request",
            protocol_version: PROTOCOL_VERSION,
            id: &request.id,
            session_id: &request.session_id,
            task_id: &request.task_id,
            command_id: request.command_id,
            token,
        }
    }
}

impl<'a> CommitWindowRequestRecord<'a> {
    pub fn new(request: &'a CommandRecord, token: &'a str, label: &'a str) -> Self {
        Self {
            record_type: "commit_window_request",
            protocol_version: PROTOCOL_VERSION,
            id: &request.id,
            session_id: &request.session_id,
            task_id: &request.task_id,
            command_id: request.command_id,
            token,
            label,
        }
    }
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
            reason_code: if effect_phase == EffectPhase::Confirmed {
                ErrorCode::Confirmed
            } else {
                ErrorCode::ProbeFailed
            },
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
    fn commit_window_acknowledgement_carries_an_explicit_host_decision() {
        let accepted = r#"{"type":"commit_window_ack","protocolVersion":2,"id":"ack-1","sessionId":"session-1","taskId":"browse-1","commandId":1,"token":"cw_1_1","label":"fb_join_click","accepted":true}"#;
        let InputRecord::CommitWindowAck(record) =
            parse_input(accepted).expect("commit window acknowledgement")
        else {
            panic!("expected commit window acknowledgement");
        };
        assert!(record.accepted);

        let missing = accepted.replace(",\"accepted\":true", "");
        assert_eq!(
            parse_input(&missing)
                .expect_err("host decision is required")
                .code,
            ErrorCode::InvalidRequest
        );
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

    #[test]
    fn structured_non_confirmed_result_never_uses_confirmed_reason_code() {
        let InputRecord::Command(request) = parse_input(&valid_command()).expect("valid command")
        else {
            panic!("expected command");
        };
        let output = serde_json::json!({"ok": false});
        let result = CommandResultRecord::success(&request, EffectPhase::NotStarted, &output);
        let encoded = serde_json::to_value(result).expect("command result");
        assert_eq!(encoded["ok"], false);
        assert_eq!(encoded["effectPhase"], "not_started");
        assert_eq!(encoded["reasonCode"], "probe_failed");
    }

    #[test]
    fn failure_serializes_optional_bounded_diagnostic() {
        let InputRecord::Command(request) = parse_input(&valid_command()).expect("valid command")
        else {
            panic!("expected command");
        };
        let error = EngineError::new(
            ErrorCode::CdpError,
            "native Facebook command returned an invalid bounded result",
        )
        .with_decode_diagnostic(crate::error::ErrorDiagnostic {
            operation_stage: Some("readiness_probe"),
            decode_stage: Some(crate::error::DecodeStage::TypedValue),
            expected_kind: Some("join_probe"),
            field_path: Some("observation.actionNodeCount".to_owned()),
            actual_type: Some(crate::error::JsonValueType::Number),
            exception_class: None,
            exception_reason: None,
            exception_token: None,
            line_number: None,
            column_number: None,
        });
        let encoded = serde_json::to_value(CommandResultRecord::<serde_json::Value>::failure(
            &request,
            EffectPhase::NotStarted,
            error,
        ))
        .expect("failure record");
        assert_eq!(encoded["error"]["code"], "cdp_error");
        assert_eq!(
            encoded["error"]["diagnostic"]["operationStage"],
            "readiness_probe"
        );
        assert_eq!(encoded["error"]["diagnostic"]["decodeStage"], "typed_value");
        assert_eq!(
            encoded["error"]["diagnostic"]["fieldPath"],
            "observation.actionNodeCount"
        );

        let without = serde_json::to_value(CommandResultRecord::<serde_json::Value>::failure(
            &request,
            EffectPhase::NotStarted,
            EngineError::new(ErrorCode::CdpError, "bounded failure"),
        ))
        .expect("failure without diagnostic");
        assert!(without["error"].get("diagnostic").is_none());
    }
}
