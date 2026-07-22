use crate::endpoint::CdpTarget;
use crate::error::{EngineError, ErrorCode};
use crate::probe::{ProbeResult, result_from_cdp, xhs_page_probe_expression};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CdpMethod {
    RuntimeEnable,
    RuntimeEvaluate,
    PageEnable,
    PageNavigate,
    PageReload,
    PageCaptureScreenshot,
    PageGetLayoutMetrics,
    DomEnable,
    DomGetDocument,
    DomQuerySelector,
    DomSetFileInputFiles,
    InputDispatchMouseEvent,
    InputDispatchKeyEvent,
    InputInsertText,
}

impl CdpMethod {
    fn name(self) -> String {
        let (domain, operation) = match self {
            Self::RuntimeEnable => ("Runtime", "enable"),
            Self::RuntimeEvaluate => ("Runtime", "evaluate"),
            Self::PageEnable => ("Page", "enable"),
            Self::PageNavigate => ("Page", "navigate"),
            Self::PageReload => ("Page", "reload"),
            Self::PageCaptureScreenshot => ("Page", "captureScreenshot"),
            Self::PageGetLayoutMetrics => ("Page", "getLayoutMetrics"),
            Self::DomEnable => ("DOM", "enable"),
            Self::DomGetDocument => ("DOM", "getDocument"),
            Self::DomQuerySelector => ("DOM", "querySelector"),
            Self::DomSetFileInputFiles => ("DOM", "setFileInputFiles"),
            Self::InputDispatchMouseEvent => ("Input", "dispatchMouseEvent"),
            Self::InputDispatchKeyEvent => ("Input", "dispatchKeyEvent"),
            Self::InputInsertText => ("Input", "insertText"),
        };
        [domain, operation].join(".")
    }
}

pub fn allowlisted_method(method: &str) -> Result<CdpMethod, EngineError> {
    let allowed = [
        CdpMethod::RuntimeEnable,
        CdpMethod::RuntimeEvaluate,
        CdpMethod::PageEnable,
        CdpMethod::PageNavigate,
        CdpMethod::PageReload,
        CdpMethod::PageCaptureScreenshot,
        CdpMethod::PageGetLayoutMetrics,
        CdpMethod::DomEnable,
        CdpMethod::DomGetDocument,
        CdpMethod::DomQuerySelector,
        CdpMethod::DomSetFileInputFiles,
        CdpMethod::InputDispatchMouseEvent,
        CdpMethod::InputDispatchKeyEvent,
        CdpMethod::InputInsertText,
    ];
    allowed
        .into_iter()
        .find(|candidate| candidate.name() == method)
        .ok_or_else(|| {
            EngineError::new(
                ErrorCode::CdpError,
                "CDP operation is not allowed by the native page engine",
            )
        })
}

pub struct CdpSession {
    websocket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    target_id: String,
    next_call_id: u64,
}

impl CdpSession {
    pub async fn connect(target: &CdpTarget) -> Result<Self, EngineError> {
        let (websocket, _) = connect_async(&target.web_socket_debugger_url)
            .await
            .map_err(|_| {
                EngineError::new(
                    ErrorCode::CdpConnectFailed,
                    "native page engine could not connect to CDP",
                )
            })?;
        let mut session = Self {
            websocket,
            target_id: target.id.clone(),
            next_call_id: 1,
        };
        for method in [
            CdpMethod::RuntimeEnable,
            CdpMethod::PageEnable,
            CdpMethod::DomEnable,
        ] {
            session.call(method, json!({})).await?;
        }
        Ok(session)
    }

    pub fn target_id(&self) -> &str {
        &self.target_id
    }

    pub async fn probe_page(&mut self) -> Result<ProbeResult, EngineError> {
        let result = self.evaluate(&xhs_page_probe_expression()?, false).await?;
        result_from_cdp(self.target_id.clone(), &result)
    }

    pub async fn evaluate(
        &mut self,
        expression: &str,
        await_promise: bool,
    ) -> Result<Value, EngineError> {
        self.call(
            CdpMethod::RuntimeEvaluate,
            json!({
                "expression": expression,
                "returnByValue": true,
                "silent": true,
                "userGesture": true,
                "awaitPromise": await_promise,
            }),
        )
        .await
    }

    pub async fn navigate(&mut self, url: &str) -> Result<Value, EngineError> {
        self.call(CdpMethod::PageNavigate, json!({ "url": url }))
            .await
    }

    pub async fn reload(&mut self) -> Result<Value, EngineError> {
        self.call(CdpMethod::PageReload, json!({ "ignoreCache": false }))
            .await
    }

    pub async fn capture_screenshot(
        &mut self,
        quality: u8,
        scale: f64,
    ) -> Result<Value, EngineError> {
        let metrics = self.layout_metrics().await?;
        let width = metrics
            .pointer("/cssVisualViewport/clientWidth")
            .and_then(Value::as_f64)
            .unwrap_or(1280.0);
        let height = metrics
            .pointer("/cssVisualViewport/clientHeight")
            .and_then(Value::as_f64)
            .unwrap_or(720.0);
        self.call(
            CdpMethod::PageCaptureScreenshot,
            json!({
                "format": "jpeg",
                "quality": quality,
                "fromSurface": true,
                "captureBeyondViewport": false,
                "clip": { "x": 0, "y": 0, "width": width, "height": height, "scale": scale },
            }),
        )
        .await
    }

    pub async fn layout_metrics(&mut self) -> Result<Value, EngineError> {
        self.call(CdpMethod::PageGetLayoutMetrics, json!({})).await
    }

    pub async fn query_selector_node(&mut self, selector: &str) -> Result<u64, EngineError> {
        let document = self
            .call(CdpMethod::DomGetDocument, json!({ "depth": 0 }))
            .await?;
        let root = document
            .pointer("/root/nodeId")
            .and_then(Value::as_u64)
            .ok_or_else(cdp_result_error)?;
        let result = self
            .call(
                CdpMethod::DomQuerySelector,
                json!({
                    "nodeId": root,
                    "selector": selector,
                }),
            )
            .await?;
        result
            .get("nodeId")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .ok_or_else(cdp_result_error)
    }

    pub async fn set_file_input_files(
        &mut self,
        node_id: u64,
        files: &[String],
    ) -> Result<Value, EngineError> {
        self.call(
            CdpMethod::DomSetFileInputFiles,
            json!({
                "nodeId": node_id,
                "files": files,
            }),
        )
        .await
    }

    pub async fn dispatch_mouse(
        &mut self,
        event_type: &str,
        x: f64,
        y: f64,
        button: &str,
        click_count: u32,
    ) -> Result<Value, EngineError> {
        self.call(
            CdpMethod::InputDispatchMouseEvent,
            json!({
                "type": event_type,
                "x": x,
                "y": y,
                "button": button,
                "clickCount": click_count,
            }),
        )
        .await
    }

    pub async fn insert_text(&mut self, text: &str) -> Result<Value, EngineError> {
        self.call(CdpMethod::InputInsertText, json!({ "text": text }))
            .await
    }

    pub async fn dispatch_key(
        &mut self,
        event_type: &str,
        key: &str,
        code: &str,
        windows_virtual_key_code: u32,
    ) -> Result<Value, EngineError> {
        self.dispatch_key_with_modifiers(event_type, key, code, windows_virtual_key_code, 0)
            .await
    }

    pub async fn dispatch_key_with_modifiers(
        &mut self,
        event_type: &str,
        key: &str,
        code: &str,
        windows_virtual_key_code: u32,
        modifiers: u8,
    ) -> Result<Value, EngineError> {
        self.call(
            CdpMethod::InputDispatchKeyEvent,
            json!({
                "type": event_type,
                "key": key,
                "code": code,
                "windowsVirtualKeyCode": windows_virtual_key_code,
                "nativeVirtualKeyCode": windows_virtual_key_code,
                "modifiers": modifiers,
            }),
        )
        .await
    }

    pub async fn close(&mut self) {
        let _ = self.websocket.close(None).await;
    }

    async fn call(&mut self, method: CdpMethod, params: Value) -> Result<Value, EngineError> {
        let id = self.next_call_id;
        self.next_call_id = self.next_call_id.checked_add(1).unwrap_or(1);
        let method_name = method.name();
        allowlisted_method(&method_name)?;
        let payload = json!({ "id": id, "method": method_name, "params": params });
        self.websocket
            .send(Message::Text(payload.to_string().into()))
            .await
            .map_err(|_| cdp_transport_error())?;

        while let Some(message) = self.websocket.next().await {
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
}

pub async fn run_page_probe(
    websocket_url: &str,
    target_id: String,
) -> Result<ProbeResult, EngineError> {
    let target = CdpTarget {
        id: target_id,
        target_type: "page".to_owned(),
        url: "https://www.xiaohongshu.com/".to_owned(),
        web_socket_debugger_url: websocket_url.to_owned(),
    };
    let mut session = CdpSession::connect(&target).await?;
    let result = session.probe_page().await;
    session.close().await;
    result
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
            "CDP returned an error for the native page engine",
        ));
    }
    message
        .get("result")
        .cloned()
        .map(Some)
        .ok_or_else(cdp_result_error)
}

fn cdp_result_error() -> EngineError {
    EngineError::new(
        ErrorCode::CdpError,
        "CDP response did not include a usable result",
    )
}

fn cdp_transport_error() -> EngineError {
    EngineError::new(
        ErrorCode::CdpError,
        "CDP transport failed during the native page command",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_operations_outside_the_explicit_allowlist() {
        for method in [
            "Network.getAllCookies",
            "Browser.close",
            "Runtime.compileScript",
        ] {
            assert_eq!(
                allowlisted_method(method)
                    .expect_err("operation must be rejected")
                    .code,
                ErrorCode::CdpError
            );
        }
        for method in [
            CdpMethod::RuntimeEvaluate,
            CdpMethod::PageNavigate,
            CdpMethod::DomSetFileInputFiles,
            CdpMethod::InputDispatchMouseEvent,
        ] {
            assert_eq!(
                allowlisted_method(&method.name()).expect("allowlisted"),
                method
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
