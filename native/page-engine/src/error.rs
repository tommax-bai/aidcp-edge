use serde::Serialize;
use std::fmt::{Display, Formatter};

const MAX_DIAGNOSTIC_FIELD_PATH_CHARS: usize = 160;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Confirmed,
    InvalidRequest,
    UnsupportedProtocol,
    SessionAlreadyOpen,
    SessionNotOpen,
    SessionMismatch,
    TaskMismatch,
    DuplicateCommand,
    CommandInProgress,
    DeadlineExpired,
    Cancelled,
    CommitWindowUnavailable,
    UnsupportedCommand,
    EndpointNotLoopback,
    EndpointUnreachable,
    NoMatchingTarget,
    CdpConnectFailed,
    CdpTimeout,
    CdpError,
    ProbeFailed,
    EngineInternal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DecodeStage {
    CdpException,
    CdpWrapper,
    OutputKind,
    OutputValue,
    TypedValue,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JsonValueType {
    Missing,
    Null,
    Boolean,
    Number,
    String,
    Array,
    Object,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CdpExceptionClass {
    Error,
    TypeError,
    ReferenceError,
    RangeError,
    SyntaxError,
    EvalError,
    UriError,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CdpExceptionReason {
    CannotReadProperty,
    ReferenceNotDefined,
    NotAFunction,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDiagnostic {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_stage: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decode_stage: Option<DecodeStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_type: Option<JsonValueType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exception_class: Option<CdpExceptionClass>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exception_reason: Option<CdpExceptionReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exception_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_number: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column_number: Option<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineError {
    pub code: ErrorCode,
    pub message: &'static str,
    pub diagnostic: Option<Box<ErrorDiagnostic>>,
}

impl EngineError {
    pub const fn new(code: ErrorCode, message: &'static str) -> Self {
        Self {
            code,
            message,
            diagnostic: None,
        }
    }

    pub fn with_decode_diagnostic(mut self, mut diagnostic: ErrorDiagnostic) -> Self {
        if let Some(path) = diagnostic.field_path.take() {
            diagnostic.field_path = Some(bound_diagnostic_path(&path));
        }
        if let Some(token) = diagnostic.exception_token.take() {
            diagnostic.exception_token = bound_identifier(&token);
        }
        self.diagnostic = Some(Box::new(diagnostic));
        self
    }

    pub fn with_operation_stage(mut self, operation_stage: &'static str) -> Self {
        if let Some(diagnostic) = &mut self.diagnostic {
            diagnostic.operation_stage = Some(operation_stage);
        }
        self
    }

    pub fn bounded_diagnostic_json(&self) -> Option<String> {
        self.diagnostic
            .as_ref()
            .and_then(|diagnostic| serde_json::to_string(diagnostic).ok())
    }
}

fn bound_diagnostic_path(path: &str) -> String {
    path.chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '[' | ']' | '-')
        })
        .take(MAX_DIAGNOSTIC_FIELD_PATH_CHARS)
        .collect()
}

fn bound_identifier(identifier: &str) -> Option<String> {
    (identifier.len() <= 64
        && identifier
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '$'))
        && identifier.chars().next().is_some_and(|character| {
            character.is_ascii_alphabetic() || character == '_' || character == '$'
        }))
    .then(|| identifier.to_owned())
}

impl Display for EngineError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for EngineError {}
