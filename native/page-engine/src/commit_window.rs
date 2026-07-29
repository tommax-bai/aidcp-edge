use crate::command::NativeCommand;
use crate::error::{EngineError, ErrorCode};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, oneshot};

/// 一条不可逆写入的提交窗口契约：开多久、在协调器那边叫什么名字。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct XiaohongshuCommitWindow {
    pub label: &'static str,
    pub budget_ms: u64,
}

/// 评论提交窗口的预算 = 命令墙钟上限。
///
/// 迁移后这里是 4s，那是「写入瞬时、窗口只覆盖点提交 + 校验」时代的值。接上硬件级逐字输入后，
/// 打字整段落在窗口内，4s 必被打穿。**实测确认过打穿的后果**：窗口只是静默过期
/// （`src/execution/commit-window.ts` 的 `isOpen()` 按 `now < openUntil` 判定，过期即 false），
/// 引擎侧 `enter` 之后**再无任何复检**，宿主也只在命令结束时 dispose ——
/// 所以打穿**不会**让写入被拒发（拒发只发生在「标签不在宿主白名单里」那一种），
/// 它的真实后果是**抢占会落在提交那一刻**：一条可能已经发出去的评论被当成没发生 ⇒ 上游重投 ⇒ 重复评论。
///
/// 因此预算抬到命令上限。这不等于「整条命令禁抢占」：宿主在命令结束时就 dispose，
/// 预算只是**兜底上限**，防一个卡死的窗口永久挡住抢占。
///
/// ⚠️ 这个数字 MUST **派生**自命令墙钟上限，MUST NOT 手抄一份字面量。上限是会被调的
/// （Facebook 时间预算整体 ×1.5 就把它从 30s 调到 45s），而窗口预算低于上限的后果不是报错，
/// 是**窗口静默过期** ⇒ 抢占重新落回提交那一刻 ⇒ 一条可能已发出去的评论被当成没发生
/// ⇒ 上游重投 ⇒ 重复评论。手抄的那一份既不会有文本冲突、也不会有任何门禁提醒。
const XHS_COMMENT_SUBMIT: XiaohongshuCommitWindow = XiaohongshuCommitWindow {
    label: "xhs_comment_submit",
    budget_ms: crate::engine::DEFAULT_COMMAND_TIMEOUT_MS,
};
/// S2 那颗雷的机械形态，**编译期**恒等式：钉的是关系，不是某个具体毫秒数。
/// 有人把上面的派生改回字面量、而命令墙钟上限随后又被调大时，这里**编译不过** ——
/// 比任何用例都早、也比任何用例都响。
const _: () = assert!(
    XHS_COMMENT_SUBMIT.budget_ms >= crate::engine::DEFAULT_COMMAND_TIMEOUT_MS,
    "xhs_comment_submit commit window budget must not expire before the command wall-clock ceiling",
);

const XHS_NOTIFICATION_COMMENTS: XiaohongshuCommitWindow = XiaohongshuCommitWindow {
    label: "xhs_notification_comments",
    budget_ms: 20_000,
};
const XHS_NOTIFICATION_LIKES: XiaohongshuCommitWindow = XiaohongshuCommitWindow {
    label: "xhs_notification_likes",
    budget_ms: 20_000,
};
const XHS_NOTIFICATION_FOLLOWS: XiaohongshuCommitWindow = XiaohongshuCommitWindow {
    label: "xhs_notification_follows",
    budget_ms: 20_000,
};
/// 发布提交是 **15s**，不是 20s —— 20s 是 Facebook 的 `fb_publish_submit`。
/// 两个平台的预算各自按各自的真实提交时长定，混用一个值等于把另一个平台的窗口拉长或截短。
const XHS_PUBLISH_SUBMIT: XiaohongshuCommitWindow = XiaohongshuCommitWindow {
    label: "xhs_publish_submit",
    budget_ms: 15_000,
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
/// `NATIVE_COMMIT_WINDOW_BUDGETS`），引擎自报的数字只作为「不超过事实源上限」的请求值。
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
