use serde::Serialize;
use std::fmt::{Display, Formatter};

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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineError {
    pub code: ErrorCode,
    pub message: &'static str,
}

impl EngineError {
    pub const fn new(code: ErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }
}

impl Display for EngineError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for EngineError {}
