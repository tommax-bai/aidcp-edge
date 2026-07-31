//! 会话期内可重复取值的**端点解析**通道（engine → host）。
//!
//! 为什么重连不能复用会话结构里存下来的 `host` / `port`：那是**开会话那一刻**的端点。
//! 浏览器被重开（冷待机唤醒即如此）之后端口会换，而旧端口不会闲着 —— 同机另一个环境
//! 的浏览器随时可能占上去。拿着旧端口重连，最好的结果是连不上，最坏的结果是
//! **连上了别人的浏览器**。所以重连的第一步是「向宿主重新问一次端点」，
//! 而不是「把上次那个再用一遍」。
//!
//! 形状与 `commit_window` 的请求通道一致（同一条 stdout 线路、同一套关联键），
//! 因为它们是同一类东西：命令执行期间由引擎发起、需要宿主当场回话的请求。

use crate::error::{EngineError, ErrorCode};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, oneshot};

/// 宿主此刻认为这个会话应该连到哪里。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedEndpoint {
    pub host: String,
    pub port: u16,
}

pub struct EndpointRequest {
    pub token: String,
    /// `None` = 宿主明说「现在解析不出端点」。**不是**「沿用旧值」。
    pub response: oneshot::Sender<Option<ResolvedEndpoint>>,
}

#[derive(Clone)]
pub struct EndpointResolver {
    command_id: u64,
    sequence: Arc<AtomicU64>,
    sender: Option<mpsc::UnboundedSender<EndpointRequest>>,
}

impl EndpointResolver {
    pub fn new(command_id: u64, sender: mpsc::UnboundedSender<EndpointRequest>) -> Self {
        Self {
            command_id,
            sequence: Arc::new(AtomicU64::new(1)),
            sender: Some(sender),
        }
    }

    /// 没有宿主通道的进程内形态（单测 / 库调用方）。此时重连只能沿用开会话时的端点。
    ///
    /// 这**不是**「静默假成功」：沿用的是宿主当初亲自交付的那个端点，且附着仍要过
    /// 实例身份复核那一关（`endpoint::select_target_for_instance`），端口被别的环境
    /// 复用时照样拒绝附着。缺的只是「换了端口还能自己找回去」这份恢复能力。
    /// 生产链路（`main.rs`）恒定走 `new()`。
    pub fn in_process(command_id: u64) -> Self {
        Self {
            command_id,
            sequence: Arc::new(AtomicU64::new(1)),
            sender: None,
        }
    }

    /// 向宿主要一次当前端点。
    ///
    /// - 无宿主通道 → `Ok(None)`，调用方按「沿用开会话端点」处理。
    /// - 宿主答不上来 / 通道断了 / 到点没回话 → `Err`，调用方**不得**退化成沿用旧端点：
    ///   连宿主都说不出这个会话该连哪里的时候，任何自作主张的端点都只是猜。
    pub async fn resolve(
        &self,
        deadline_unix_ms: u64,
        cancellation: Option<&AtomicBool>,
    ) -> Result<Option<ResolvedEndpoint>, EngineError> {
        if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
            return Err(EngineError::new(
                ErrorCode::Cancelled,
                "native page command cancelled before endpoint resolution",
            ));
        }
        let Some(sender) = &self.sender else {
            return Ok(None);
        };
        let now_ms = unix_time_ms();
        if deadline_unix_ms <= now_ms {
            return Err(EngineError::new(
                ErrorCode::DeadlineExpired,
                "native page engine command deadline expired before endpoint resolution",
            ));
        }
        let token = format!(
            "ep_{}_{}",
            self.command_id,
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let (response, receiver) = oneshot::channel();
        sender
            .send(EndpointRequest { token, response })
            .map_err(|_| endpoint_unresolved())?;
        match tokio::time::timeout(
            Duration::from_millis(deadline_unix_ms.saturating_sub(now_ms)),
            receiver,
        )
        .await
        {
            Ok(Ok(Some(endpoint))) => Ok(Some(endpoint)),
            _ => Err(endpoint_unresolved()),
        }
    }
}

fn endpoint_unresolved() -> EngineError {
    EngineError::new(
        ErrorCode::EndpointUnreachable,
        "host could not resolve a current DevTools endpoint for this session",
    )
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_resolved_endpoint_is_handed_back_to_the_caller() {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let resolver = EndpointResolver::new(5, sender);
        let worker =
            tokio::spawn(async move { resolver.resolve(unix_time_ms() + 1_000, None).await });
        let request = receiver.recv().await.expect("request");
        assert_eq!(request.token, "ep_5_1");
        request
            .response
            .send(Some(ResolvedEndpoint {
                host: "127.0.0.1".to_owned(),
                port: 61332,
            }))
            .expect("respond");
        assert_eq!(
            worker.await.expect("worker").expect("resolved"),
            Some(ResolvedEndpoint {
                host: "127.0.0.1".to_owned(),
                port: 61332,
            })
        );
    }

    /// 宿主说「解析不出来」时 MUST 报错，MUST NOT 静默回落到旧端点 ——
    /// 把这里的 `Err` 改成 `Ok(None)`，这条用例立刻红。
    #[tokio::test]
    async fn an_unresolvable_endpoint_is_an_error_never_a_silent_fallback() {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let resolver = EndpointResolver::new(6, sender);
        let worker =
            tokio::spawn(async move { resolver.resolve(unix_time_ms() + 1_000, None).await });
        let request = receiver.recv().await.expect("request");
        request.response.send(None).expect("respond");
        assert_eq!(
            worker
                .await
                .expect("worker")
                .expect_err("unresolved endpoint")
                .code,
            ErrorCode::EndpointUnreachable
        );
    }

    #[tokio::test]
    async fn without_a_host_channel_the_caller_keeps_the_admitted_endpoint() {
        assert_eq!(
            EndpointResolver::in_process(7)
                .resolve(unix_time_ms() + 1_000, None)
                .await
                .expect("in-process resolver"),
            None
        );
    }
}
