pub mod cdp;
pub mod command;
pub mod commit_window;
pub mod effect;
/// 嵌入资产编码密钥的单一定义；编码端 `build.rs` 用 `include!` 取的是同一份文件。
/// 保持 crate 私有：解码是各平台模块的内部实现，外部只用 `*_expression()` 那批入口。
mod embedded_asset_key;
pub mod endpoint;
pub mod endpoint_resolver;
pub mod engine;
pub mod error;
pub mod facebook;
mod input;
pub mod locating;
pub mod model;
pub mod probe;
pub mod protocol;
pub mod wechat;
pub mod xhs;

use crate::error::{EngineError, ErrorCode};
use crate::probe::ProbeResult;
use crate::protocol::SessionOpenParams;
use std::time::Duration;

/// 一次性探针（无会话、无重连）。生产链路不走这里 —— 现役调用方只有本模块的单测。
///
/// 附着判据与会话路径同源：**给了身份证据就必须复核**。没给证据时沿用平台 / 端口判据，
/// 因为这条路径没有「当初被准入的那一个实例」可供比对 —— 它的端点就是调用方此刻直接指定的。
pub async fn execute_probe(params: &SessionOpenParams) -> Result<ProbeResult, EngineError> {
    endpoint::validate_loopback_host(&params.host)?;
    let admitted = params
        .browser_debugger_url
        .as_deref()
        .and_then(endpoint::BrowserInstanceIdentity::from_browser_debugger_url);
    let operation = async {
        let target = if admitted.is_some() {
            let observed = endpoint::read_browser_identity(&params.host, params.port).await?;
            let targets = endpoint::list_targets(&params.host, params.port).await?;
            endpoint::select_target_for_instance(
                &targets,
                params.platform,
                params.port,
                admitted.as_ref(),
                Some(&observed),
            )?
        } else {
            let targets = endpoint::list_targets(&params.host, params.port).await?;
            endpoint::select_target(&targets, params.platform, params.port)?
        };
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
            browser_debugger_url: None,
        };
        let error = execute_probe(&params).await.expect_err("timeout");
        assert_eq!(error.code, ErrorCode::CdpTimeout);
        server.abort();
    }
}
