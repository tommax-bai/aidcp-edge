use crate::command::NativeCommand;
use crate::error::{EngineError, ErrorCode};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, oneshot};

/// 一条不可逆写入的提交窗口契约：**在协调器那边叫什么名字**。
///
/// 「开多久」不在这里 —— 预算的唯一事实源是宿主的 `NATIVE_COMMIT_WINDOW_BUDGETS`
/// （`src/native-page-engine/client.ts`），引擎按标签请求、宿主按标签发放。
///
/// 引擎侧曾镜像一份预算数字并随请求一起发出。那份数字运行期早已不作数（宿主只按自己的表授予），
/// 留着的唯一效果是给下一次调预算的人多一处会改漏的地方，而改漏**既无文本冲突、也无编译错误**。
/// 尤其是评论提交那一条：它的预算必须 ≥ 命令墙钟上限，低了不会报错，只会让窗口**静默过期**
/// ⇒ 抢占重新落回提交那一刻 ⇒ 一条可能已经发出去的评论被当成没发生 ⇒ 上游重投 ⇒ 重复评论。
/// 这条关系现在钉在宿主一侧（`runtime-contracts-commit-window.test.ts` 的
/// 「评论提交窗口的预算 ≥ 命令墙钟上限」），那里是它唯一的声明处，也就无从两侧漂移。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct XiaohongshuCommitWindow {
    pub label: &'static str,
}

const XHS_COMMENT_SUBMIT: XiaohongshuCommitWindow = XiaohongshuCommitWindow {
    label: "xhs_comment_submit",
};
const XHS_NOTIFICATION_COMMENTS: XiaohongshuCommitWindow = XiaohongshuCommitWindow {
    label: "xhs_notification_comments",
};
const XHS_NOTIFICATION_LIKES: XiaohongshuCommitWindow = XiaohongshuCommitWindow {
    label: "xhs_notification_likes",
};
const XHS_NOTIFICATION_FOLLOWS: XiaohongshuCommitWindow = XiaohongshuCommitWindow {
    label: "xhs_notification_follows",
};
const XHS_PUBLISH_SUBMIT: XiaohongshuCommitWindow = XiaohongshuCommitWindow {
    label: "xhs_publish_submit",
};

/// 小红书四处不可逆写入的提交窗口契约。
///
/// 判据是「这一步一旦点下去就没有回滚」：
///  - 评论提交：点下即进入「已提交、结果未知」区，此后取消 = 把一条**可能已经发出去**的评论
///    当成没发生 ⇒ 上游重试 ⇒ 重复评论；
///  - 三条通知分类栏：点击**消费未读、无回滚**，窗口 MUST 覆盖点击那一刻；
///  - 发布提交：同评论，且代价更大。
///
/// 其余命令回 `None`（读命令与可重放的导航不占窗口）——把整条命令包进窗口等于
/// 把「不可逆写入保护」偷换成「命令期间禁抢占」，抢占能力会事实上失效。
///
/// ⚠️ **宿主侧必须同批认识这五条标签**：预算的单一事实源在宿主
/// （`src/native-page-engine/client.ts` 的 `NativeCommitWindowLabel` 与
/// `NATIVE_COMMIT_WINDOW_BUDGETS`），引擎只发标签、不发数字。
/// 宿主那张表里没有的标签会被判成契约违规并否决窗口 —— 后果不是「没有保护」，
/// 而是这五处写入**全部拒发**。改这里就必须同时改那里。
pub fn xiaohongshu_commit_window(command: &NativeCommand) -> Option<XiaohongshuCommitWindow> {
    match command {
        NativeCommand::InteractionComment(_) => Some(XHS_COMMENT_SUBMIT),
        NativeCommand::NotificationBrowseComments(_) => Some(XHS_NOTIFICATION_COMMENTS),
        NativeCommand::NotificationBrowseLikes(_) => Some(XHS_NOTIFICATION_LIKES),
        NativeCommand::NotificationBrowseFollows(_) => Some(XHS_NOTIFICATION_FOLLOWS),
        NativeCommand::PublishSubmit(_) => Some(XHS_PUBLISH_SUBMIT),
        _ => None,
    }
}

/// 引擎→宿主的一次开窗请求：**只带标签**。宿主按标签查自己的事实源发放预算。
pub struct CommitWindowRequest {
    pub token: String,
    pub label: &'static str,
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
                .enter("fb_join_click", unix_time_ms() + 1_000, None)
                .await
        });
        let request = receiver.recv().await.expect("request");
        assert_eq!(request.token, "cw_7_1");
        assert_eq!(request.label, "fb_join_click");
        request.acknowledgement.send(true).expect("ack");
        worker.await.expect("worker").expect("allowed");
    }

    #[tokio::test]
    async fn missing_or_negative_acknowledgement_fails_before_commit() {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let requester = CommitWindowRequester::new(9, sender);
        let worker = tokio::spawn(async move {
            requester
                .enter("fb_comment_enter", unix_time_ms() + 1_000, None)
                .await
        });
        let request = receiver.recv().await.expect("request");
        request.acknowledgement.send(false).expect("reject");
        let error = worker.await.expect("worker").expect_err("rejected");
        assert_eq!(error.code, ErrorCode::CommitWindowUnavailable);
    }
}
