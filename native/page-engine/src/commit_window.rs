use crate::error::{EngineError, ErrorCode};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, oneshot};

pub struct CommitWindowRequest {
    pub token: String,
    pub label: &'static str,
    pub budget_ms: u64,
    pub acknowledgement: oneshot::Sender<bool>,
}

#[derive(Clone)]
pub struct CommitWindowRequester {
    command_id: u64,
    sequence: Arc<AtomicU64>,
    sender: Option<mpsc::UnboundedSender<CommitWindowRequest>>,
}

impl CommitWindowRequester {
    pub fn new(command_id: u64, sender: mpsc::UnboundedSender<CommitWindowRequest>) -> Self {
        Self {
            command_id,
            sequence: Arc::new(AtomicU64::new(1)),
            sender: Some(sender),
        }
    }

    pub fn in_process(command_id: u64) -> Self {
        Self {
            command_id,
            sequence: Arc::new(AtomicU64::new(1)),
            sender: None,
        }
    }

    pub async fn enter(
        &self,
        label: &'static str,
        budget_ms: u64,
        deadline_unix_ms: u64,
        cancellation: Option<&AtomicBool>,
    ) -> Result<(), EngineError> {
        if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
            return Err(cancelled_before_commit());
        }
        let now_ms = unix_time_ms();
        if deadline_unix_ms <= now_ms {
            return Err(commit_window_unavailable());
        }
        let Some(sender) = &self.sender else {
            return Ok(());
        };
        let token = format!(
            "cw_{}_{}",
            self.command_id,
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let (acknowledgement, receiver) = oneshot::channel();
        sender
            .send(CommitWindowRequest {
                token,
                label,
                budget_ms,
                acknowledgement,
            })
            .map_err(|_| commit_window_unavailable())?;

        let wait = tokio::time::timeout(
            Duration::from_millis(deadline_unix_ms.saturating_sub(now_ms)),
            receiver,
        );
        tokio::pin!(wait);
        loop {
            tokio::select! {
                result = &mut wait => {
                    return match result {
                        Ok(Ok(true)) => Ok(()),
                        _ => Err(commit_window_unavailable()),
                    };
                }
                _ = tokio::time::sleep(Duration::from_millis(10)) => {
                    if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
                        return Err(cancelled_before_commit());
                    }
                }
            }
        }
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn cancelled_before_commit() -> EngineError {
    EngineError::new(
        ErrorCode::Cancelled,
        "native page command cancelled before irreversible commit",
    )
}

fn commit_window_unavailable() -> EngineError {
    EngineError::new(
        ErrorCode::CommitWindowUnavailable,
        "native commit window was not acknowledged before actuation",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn matching_acknowledgement_allows_commit() {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let requester = CommitWindowRequester::new(7, sender);
        let worker = tokio::spawn(async move {
            requester
                .enter("fb_join_click", 18_500, unix_time_ms() + 1_000, None)
                .await
        });
        let request = receiver.recv().await.expect("request");
        assert_eq!(request.token, "cw_7_1");
        assert_eq!(request.label, "fb_join_click");
        assert_eq!(request.budget_ms, 18_500);
        request.acknowledgement.send(true).expect("ack");
        worker.await.expect("worker").expect("allowed");
    }

    #[tokio::test]
    async fn missing_or_negative_acknowledgement_fails_before_commit() {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let requester = CommitWindowRequester::new(9, sender);
        let worker = tokio::spawn(async move {
            requester
                .enter("fb_comment_enter", 20_000, unix_time_ms() + 1_000, None)
                .await
        });
        let request = receiver.recv().await.expect("request");
        request.acknowledgement.send(false).expect("reject");
        let error = worker.await.expect("worker").expect_err("rejected");
        assert_eq!(error.code, ErrorCode::CommitWindowUnavailable);
    }
}
