pub mod cdp;
pub mod command;
pub mod effect;
pub mod endpoint;
pub mod engine;
pub mod error;
pub mod facebook;
pub mod model;
pub mod probe;
pub mod protocol;
pub mod wechat;
pub mod xhs;

use crate::error::{EngineError, ErrorCode};
use crate::probe::ProbeResult;
use crate::protocol::SessionOpenParams;
use std::time::Duration;

pub async fn execute_probe(params: &SessionOpenParams) -> Result<ProbeResult, EngineError> {
    endpoint::validate_loopback_host(&params.host)?;
    let operation = async {
        let targets = endpoint::list_targets(&params.host, params.port).await?;
        let target = endpoint::select_target(&targets, params.platform, params.port)?;
        cdp::run_page_probe(&target.web_socket_debugger_url, target.id).await
    };
    tokio::time::timeout(Duration::from_millis(params.timeout_ms), operation)
        .await
        .map_err(|_| {
            EngineError::new(
                ErrorCode::CdpTimeout,
                "native page probe exceeded its deadline",
            )
        })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Platform;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn maps_silent_endpoint_to_bounded_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.expect("accept");
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let params = SessionOpenParams {
            host: "127.0.0.1".to_owned(),
            port,
            platform: Platform::Xiaohongshu,
            timeout_ms: 50,
        };
        let error = execute_probe(&params).await.expect_err("timeout");
        assert_eq!(error.code, ErrorCode::CdpTimeout);
        server.abort();
    }
}
