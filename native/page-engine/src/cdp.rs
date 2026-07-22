use crate::error::{EngineError, ErrorCode};
use crate::probe::{ProbeResult, result_from_cdp, xhs_page_probe_expression};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CdpOperation {
    RuntimeEnable,
    RuntimeEvaluatePageProbe,
}

impl CdpOperation {
    pub const fn method(self) -> &'static str {
        match self {
            Self::RuntimeEnable => "Runtime.enable",
            Self::RuntimeEvaluatePageProbe => "Runtime.evaluate",
        }
    }

    fn params(self) -> Result<Value, EngineError> {
        match self {
            Self::RuntimeEnable => Ok(json!({})),
            Self::RuntimeEvaluatePageProbe => Ok(json!({
                "expression": xhs_page_probe_expression()?,
                "returnByValue": true,
                "silent": true,
                "userGesture": false,
                "awaitPromise": false
            })),
        }
    }
}

pub fn allowlisted_operation(method: &str) -> Result<CdpOperation, EngineError> {
    match method {
        "Runtime.enable" => Ok(CdpOperation::RuntimeEnable),
        "Runtime.evaluate" => Ok(CdpOperation::RuntimeEvaluatePageProbe),
        _ => Err(EngineError::new(
            ErrorCode::CdpError,
            "CDP operation is not allowed by the native probe",
        )),
    }
}

pub async fn run_page_probe(
    websocket_url: &str,
    target_id: String,
) -> Result<ProbeResult, EngineError> {
    let (mut websocket, _) = connect_async(websocket_url).await.map_err(|_| {
        EngineError::new(
            ErrorCode::CdpConnectFailed,
            "native page engine could not connect to CDP",
        )
    })?;
    call(&mut websocket, 1, CdpOperation::RuntimeEnable).await?;
    let result = call(&mut websocket, 2, CdpOperation::RuntimeEvaluatePageProbe).await?;
    let _ = websocket.close(None).await;
    result_from_cdp(target_id, &result)
}

async fn call(
    websocket: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
    id: u64,
    operation: CdpOperation,
) -> Result<Value, EngineError> {
    let method = operation.method();
    let operation = allowlisted_operation(method)?;
    let payload = json!({
        "id": id,
        "method": operation.method(),
        "params": operation.params()?
    });
    websocket
        .send(Message::Text(payload.to_string().into()))
        .await
        .map_err(|_| cdp_transport_error())?;

    while let Some(message) = websocket.next().await {
        let message = message.map_err(|_| cdp_transport_error())?;
        let parsed = match message {
            Message::Text(text) => parse_correlated_response(text.as_bytes(), id)?,
            Message::Binary(bytes) => parse_correlated_response(bytes.as_ref(), id)?,
            Message::Close(_) => return Err(cdp_transport_error()),
            _ => None,
        };
        if let Some(result) = parsed {
            return Ok(result);
        }
    }
    Err(cdp_transport_error())
}

pub fn parse_correlated_response(
    payload: &[u8],
    expected_id: u64,
) -> Result<Option<Value>, EngineError> {
    let message = serde_json::from_slice::<Value>(payload).map_err(|_| cdp_transport_error())?;
    let Some(id) = message.get("id").and_then(Value::as_u64) else {
        return Ok(None);
    };
    if id != expected_id {
        return Ok(None);
    }
    if message.get("error").is_some() {
        return Err(EngineError::new(
            ErrorCode::CdpError,
            "CDP returned an error for the native page probe",
        ));
    }
    message.get("result").cloned().map(Some).ok_or_else(|| {
        EngineError::new(ErrorCode::CdpError, "CDP response did not include a result")
    })
}

fn cdp_transport_error() -> EngineError {
    EngineError::new(
        ErrorCode::CdpError,
        "CDP transport failed during the native page probe",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_read_only_cdp_operations() {
        for method in [
            "Input.dispatchMouseEvent",
            "Page.navigate",
            "DOM.setFileInputFiles",
            "Network.getAllCookies",
        ] {
            assert_eq!(
                allowlisted_operation(method)
                    .expect_err("operation must be rejected")
                    .code,
                ErrorCode::CdpError
            );
        }
    }

    #[test]
    fn correlates_responses_and_ignores_events() {
        assert!(
            parse_correlated_response(br#"{"method":"Runtime.executionContextCreated"}"#, 2)
                .expect("event")
                .is_none()
        );
        assert!(
            parse_correlated_response(br#"{"id":1,"result":{}}"#, 2)
                .expect("other response")
                .is_none()
        );
        let result = parse_correlated_response(br#"{"id":2,"result":{"value":true}}"#, 2)
            .expect("response")
            .expect("correlated result");
        assert_eq!(result["value"], true);
    }

    #[test]
    fn maps_cdp_error_without_returning_remote_detail() {
        let error = parse_correlated_response(
            br#"{"id":2,"error":{"code":-1,"message":"sensitive remote detail"}}"#,
            2,
        )
        .expect_err("CDP error");
        assert_eq!(error.code, ErrorCode::CdpError);
        assert!(!error.message.contains("sensitive"));
    }
}
