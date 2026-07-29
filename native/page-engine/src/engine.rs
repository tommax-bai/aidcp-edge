use crate::cdp::CdpSession;
use crate::command::{NoteOpenParams, NoteOpenSelection};
use crate::commit_window::{CommitWindowRequester, xiaohongshu_commit_window};
use crate::endpoint;
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::input::{TextInputFailure, type_captcha_with_key_events, type_text_humanized};
use crate::model::{
    ActionReceipt, CaptchaSnapshot, CaptchaTypeReport, FacebookIdentityReceipt,
    IdentityObservation, IdentityObservationSource, IdentityPageEffect, NoteDetail,
    NotificationHome, NotificationItems, ObservedActionReceipt, PageCards, PlanResults,
    ProfileDetail, PublishReceipt,
};
use crate::probe::PageKind;
use crate::probe::ProbeResult;
use crate::probe::exception_diagnostic;
use crate::protocol::{
    CancelRecord, CommandRecord, EffectPhase, NativeCommand, Platform, SessionCloseRecord,
    SessionOpenRecord, SessionStatusRecord,
};
use crate::wechat;
use crate::xhs;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

const MAX_RECORDED_COMMANDS: usize = 128;
const MAX_CAPTCHA_SNAPSHOTS: usize = 8;
// ⚠️ 本组是**四处同步**的第 ④ 层（引擎天花板）。另外三层都在边缘 TS：
//   ① 请求值   src/native-page-engine/browse-session.ts
//   ② 准入校验 src/native-page-engine/client.ts（超上限 ⇒ invalid_request，命令根本不下发）
//   ③ 会话超时 src/native-page-engine/runtime.ts（此处取 session.min(ceiling)，会话值小就静默夹回）
// 四层任缺其一都不会有编译错误，失败形态却各不相同（被拒 / 静默失效）。
const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 45_000;
const FACEBOOK_FEED_SCROLL_TIMEOUT_MS: u64 = 180_000;
const FACEBOOK_PUBLISH_SELECT_MODE_TIMEOUT_MS: u64 = 60_000;
const FACEBOOK_COMMENT_TIMEOUT_MS: u64 = 180_000;
const FACEBOOK_GROUP_JOIN_TIMEOUT_MS: u64 = 135_000;
const FACEBOOK_FIRST_POST_OPEN_TIMEOUT_MS: u64 = 135_000;
const FACEBOOK_PUBLISH_FILL_TIMEOUT_MS: u64 = 600_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub task_id: String,
    pub state: &'static str,
    pub target_id: String,
    pub last_command_id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_command_id: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum CommandOutput {
    PageProbe(ProbeResult),
    PageCards(PageCards),
    NoteDetail(NoteDetail),
    ProfileDetail(ProfileDetail),
    NotificationItems(NotificationItems),
    NotificationHome(NotificationHome),
    ActionReceipt(Box<ActionReceipt>),
    /// 回执 + 随行观测（线上 kind = `action_receipt_with_observation`）。
    ActionReceiptWithObservation(Box<ObservedActionReceipt>),
    PlanResults(PlanResults),
    PublishReceipt(PublishReceipt),
    CaptchaSnapshot(CaptchaSnapshot),
    WechatSessionCandidate(Option<wechat::WechatSessionCandidate>),
    FacebookIdentity(FacebookIdentityReceipt),
    IdentityObservation(IdentityObservation),
}

#[derive(Clone, Debug)]
pub struct StoredCommandResult {
    pub effect_phase: EffectPhase,
    pub output: Option<CommandOutput>,
    pub error: Option<EngineError>,
}

impl StoredCommandResult {
    fn confirmed(output: CommandOutput) -> Self {
        Self {
            effect_phase: EffectPhase::Confirmed,
            output: Some(output),
            error: None,
        }
    }

    fn failed(error: EngineError) -> Self {
        Self {
            effect_phase: EffectPhase::NotStarted,
            output: None,
            error: Some(error),
        }
    }

    fn failed_at(effect_phase: EffectPhase, error: EngineError) -> Self {
        Self {
            effect_phase,
            output: None,
            error: Some(error),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelResult {
    pub accepted: bool,
    pub state: &'static str,
    pub command_id: u64,
}

pub(crate) struct EngineSession {
    id: String,
    task_id: String,
    host: String,
    port: u16,
    platform: Platform,
    timeout_ms: u64,
    target_id: String,
    pub(crate) cdp: CdpSession,
    last_command_id: u64,
    active_command_id: Option<u64>,
    completed: BTreeMap<u64, StoredCommandResult>,
    captcha_snapshots: VecDeque<CaptchaSnapshotState>,
    wechat_capture_initialized: bool,
    wechat_request_context: Option<wechat::WechatRequestContext>,
    pub(crate) facebook: FacebookSessionState,
}

pub(crate) struct FacebookSessionState {
    pub(crate) active_list_url: String,
    pub(crate) seen_post_ids: HashSet<String>,
    pub(crate) last_refresh_reload_at_ms: u64,
}

impl Default for FacebookSessionState {
    fn default() -> Self {
        Self {
            active_list_url: facebook::shared::FACEBOOK_HOME_URL.to_owned(),
            seen_post_ids: HashSet::new(),
            last_refresh_reload_at_ms: 0,
        }
    }
}

#[derive(Clone)]
struct CaptchaSnapshotState {
    incident_id: String,
    snapshot_id: String,
    width: u32,
    height: u32,
    fingerprint: u64,
}

impl EngineSession {
    #[cfg(test)]
    pub(crate) fn for_test(cdp: CdpSession, platform: Platform) -> Self {
        let target_id = cdp.target_id().to_owned();
        Self {
            id: "test-session".to_owned(),
            task_id: "test-task".to_owned(),
            host: "127.0.0.1".to_owned(),
            port: 0,
            platform,
            timeout_ms: DEFAULT_COMMAND_TIMEOUT_MS,
            target_id,
            cdp,
            last_command_id: 0,
            active_command_id: None,
            completed: BTreeMap::new(),
            captcha_snapshots: VecDeque::new(),
            wechat_capture_initialized: false,
            wechat_request_context: None,
            facebook: FacebookSessionState::default(),
        }
    }

    fn info(&self) -> SessionInfo {
        SessionInfo {
            session_id: self.id.clone(),
            task_id: self.task_id.clone(),
            state: "ready",
            target_id: self.target_id.clone(),
            last_command_id: self.last_command_id,
            active_command_id: self.active_command_id,
        }
    }

    fn remember(&mut self, command_id: u64, result: StoredCommandResult) {
        self.last_command_id = self.last_command_id.max(command_id);
        self.completed.insert(command_id, result);
        while self.completed.len() > MAX_RECORDED_COMMANDS {
            let Some(oldest) = self.completed.keys().next().copied() else {
                break;
            };
            self.completed.remove(&oldest);
        }
    }

    async fn reconnect(
        &mut self,
        deadline_unix_ms: u64,
        cancellation: &AtomicBool,
    ) -> Result<(), EngineError> {
        if cancellation.load(Ordering::Acquire) {
            return Err(cancelled_before_dispatch());
        }
        let remaining = remaining_budget(deadline_unix_ms, self.timeout_ms)?;
        let operation = async {
            let targets = endpoint::list_targets(&self.host, self.port).await?;
            let target = endpoint::select_target(&targets, self.platform, self.port)?;
            let cdp = CdpSession::connect(&target).await?;
            Ok::<_, EngineError>((target.id, cdp))
        };
        let cancellation_wait = wait_for_cancellation(cancellation);
        tokio::pin!(cancellation_wait);
        let reconnect = tokio::time::timeout(remaining, operation);
        tokio::pin!(reconnect);
        let (target_id, cdp) = tokio::select! {
            _ = &mut cancellation_wait => return Err(cancelled_before_dispatch()),
            result = &mut reconnect => result.map_err(|_| EngineError::new(
                ErrorCode::CdpTimeout,
                "native page engine reconnect exceeded its deadline",
            ))??,
        };
        self.cdp.close().await;
        self.target_id = target_id;
        self.cdp = cdp;
        Ok(())
    }
}

#[derive(Default)]
pub struct Engine {
    session: Option<EngineSession>,
}

impl Engine {
    pub async fn open(&mut self, request: &SessionOpenRecord) -> Result<SessionInfo, EngineError> {
        if self.session.is_some() {
            return Err(EngineError::new(
                ErrorCode::SessionAlreadyOpen,
                "native page engine session is already open",
            ));
        }
        endpoint::validate_loopback_host(&request.params.host)?;
        let operation = async {
            let targets = endpoint::list_targets(&request.params.host, request.params.port).await?;
            let target =
                endpoint::select_target(&targets, request.params.platform, request.params.port)?;
            let cdp = CdpSession::connect(&target).await?;
            Ok::<_, EngineError>((target.id, cdp))
        };
        let (target_id, cdp) =
            tokio::time::timeout(Duration::from_millis(request.params.timeout_ms), operation)
                .await
                .map_err(|_| {
                    EngineError::new(
                        ErrorCode::CdpTimeout,
                        "native page engine session open exceeded its deadline",
                    )
                })??;
        let session = EngineSession {
            id: request.session_id.clone(),
            task_id: request.task_id.clone(),
            host: request.params.host.clone(),
            port: request.params.port,
            platform: request.params.platform,
            timeout_ms: request.params.timeout_ms,
            target_id,
            cdp,
            last_command_id: 0,
            active_command_id: None,
            completed: BTreeMap::new(),
            captcha_snapshots: VecDeque::new(),
            wechat_capture_initialized: false,
            wechat_request_context: None,
            facebook: FacebookSessionState::default(),
        };
        let info = session.info();
        self.session = Some(session);
        Ok(info)
    }

    pub fn status(&self, request: &SessionStatusRecord) -> Result<SessionInfo, EngineError> {
        let session = self.require_session(&request.session_id)?;
        Ok(session.info())
    }

    pub async fn close(
        &mut self,
        request: &SessionCloseRecord,
    ) -> Result<SessionInfo, EngineError> {
        let session = self.require_session(&request.session_id)?;
        let mut info = session.info();
        let mut session = self.session.take().expect("session checked above");
        session.cdp.close().await;
        info.state = "closed";
        info.active_command_id = None;
        Ok(info)
    }

    pub async fn shutdown(&mut self) {
        if let Some(mut session) = self.session.take() {
            session.cdp.close().await;
        }
    }

    pub async fn execute(
        &mut self,
        request: &CommandRecord,
    ) -> Result<StoredCommandResult, EngineError> {
        self.execute_cancellable(request, Arc::new(AtomicBool::new(false)))
            .await
    }

    pub async fn execute_cancellable(
        &mut self,
        request: &CommandRecord,
        cancellation: Arc<AtomicBool>,
    ) -> Result<StoredCommandResult, EngineError> {
        self.execute_cancellable_with_commit_windows(
            request,
            cancellation,
            CommitWindowRequester::in_process(request.command_id),
        )
        .await
    }

    pub async fn execute_cancellable_with_commit_windows(
        &mut self,
        request: &CommandRecord,
        cancellation: Arc<AtomicBool>,
        commit_windows: CommitWindowRequester,
    ) -> Result<StoredCommandResult, EngineError> {
        let session = self.require_session_mut(&request.session_id)?;
        if session.task_id != request.task_id {
            return Err(EngineError::new(
                ErrorCode::TaskMismatch,
                "native page engine task identity does not own the session",
            ));
        }
        if let Some(recorded) = session.completed.get(&request.command_id) {
            return Ok(recorded.clone());
        }
        if request.command_id <= session.last_command_id {
            return Err(EngineError::new(
                ErrorCode::DuplicateCommand,
                "native page engine command identity is stale",
            ));
        }
        if session.active_command_id.is_some() {
            return Err(EngineError::new(
                ErrorCode::CommandInProgress,
                "native page engine already has an active command",
            ));
        }

        let now_ms = unix_time_ms();
        if request.deadline_unix_ms <= now_ms {
            let result = StoredCommandResult::failed(EngineError::new(
                ErrorCode::DeadlineExpired,
                "native page engine command deadline expired before dispatch",
            ));
            session.remember(request.command_id, result.clone());
            return Ok(result);
        }
        if cancellation.load(Ordering::Acquire) {
            let result = StoredCommandResult::failed(cancelled_before_dispatch());
            session.remember(request.command_id, result.clone());
            return Ok(result);
        }
        if !request.command.supports_platform(session.platform) {
            let result = StoredCommandResult::failed(EngineError::new(
                ErrorCode::UnsupportedCommand,
                "native page command is not supported by the bound platform adapter",
            ));
            session.remember(request.command_id, result.clone());
            return Ok(result);
        }
        session.active_command_id = Some(request.command_id);
        let outcome = match &request.command {
            NativeCommand::PageProbe(_) if session.platform == Platform::Xiaohongshu => {
                match execute_page_probe(session, request.deadline_unix_ms, &cancellation).await {
                    Ok(result) => StoredCommandResult::confirmed(CommandOutput::PageProbe(result)),
                    Err(error) => StoredCommandResult::failed(error),
                }
            }
            _ => execute_platform_command(session, request, &cancellation, &commit_windows).await,
        };
        session.active_command_id = None;
        session.remember(request.command_id, outcome.clone());
        Ok(outcome)
    }

    pub fn cancel(&self, request: &CancelRecord) -> Result<CancelResult, EngineError> {
        let session = self.require_session(&request.session_id)?;
        if session.task_id != request.task_id {
            return Err(EngineError::new(
                ErrorCode::TaskMismatch,
                "native page engine task identity does not own the session",
            ));
        }
        if session.completed.contains_key(&request.command_id) {
            return Ok(CancelResult {
                accepted: false,
                state: "terminal",
                command_id: request.command_id,
            });
        }
        Ok(CancelResult {
            accepted: session.active_command_id == Some(request.command_id),
            state: if session.active_command_id == Some(request.command_id) {
                "cancellation_requested"
            } else {
                "not_found"
            },
            command_id: request.command_id,
        })
    }

    fn require_session(&self, session_id: &str) -> Result<&EngineSession, EngineError> {
        let session = self.session.as_ref().ok_or_else(|| {
            EngineError::new(
                ErrorCode::SessionNotOpen,
                "native page engine session is not open",
            )
        })?;
        if session.id != session_id {
            return Err(EngineError::new(
                ErrorCode::SessionMismatch,
                "native page engine session identity does not match",
            ));
        }
        Ok(session)
    }

    fn require_session_mut(&mut self, session_id: &str) -> Result<&mut EngineSession, EngineError> {
        let session = self.session.as_mut().ok_or_else(|| {
            EngineError::new(
                ErrorCode::SessionNotOpen,
                "native page engine session is not open",
            )
        })?;
        if session.id != session_id {
            return Err(EngineError::new(
                ErrorCode::SessionMismatch,
                "native page engine session identity does not match",
            ));
        }
        Ok(session)
    }
}

async fn execute_platform_command(
    session: &mut EngineSession,
    request: &CommandRecord,
    cancellation: &AtomicBool,
    commit_windows: &CommitWindowRequester,
) -> StoredCommandResult {
    let write = request.command.may_write();
    if cancellation.load(Ordering::Acquire) {
        return StoredCommandResult::failed(cancelled_before_dispatch());
    }
    let remaining = match remaining_budget(
        request.deadline_unix_ms,
        command_timeout_ms(session, &request.command),
    ) {
        Ok(value) => value,
        Err(error) => return StoredCommandResult::failed(error),
    };
    let operation = execute_platform_command_once(
        session,
        &request.command,
        Some(cancellation),
        commit_windows,
        request.deadline_unix_ms,
    );
    let result = if write {
        tokio::time::timeout(remaining, operation)
            .await
            .map_err(|_| {
                EngineError::new(
                    ErrorCode::CdpTimeout,
                    "native page write command exceeded its atomic deadline",
                )
            })
    } else {
        let cancellation_wait = wait_for_cancellation(cancellation);
        tokio::pin!(cancellation_wait);
        let timed = tokio::time::timeout(remaining, operation);
        tokio::pin!(timed);
        tokio::select! {
            _ = &mut cancellation_wait => return StoredCommandResult::failed(cancelled_before_dispatch()),
            result = &mut timed => result.map_err(|_| EngineError::new(
                ErrorCode::CdpTimeout,
                "native page read command exceeded its deadline",
            )),
        }
    };
    match result {
        Ok(Ok((phase, output))) => StoredCommandResult {
            effect_phase: phase,
            output: Some(output),
            error: None,
        },
        Ok(Err(error))
            if !write
                && matches!(
                    error.code,
                    ErrorCode::CdpError | ErrorCode::CdpConnectFailed
                ) =>
        {
            match session
                .reconnect(request.deadline_unix_ms, cancellation)
                .await
            {
                Ok(()) => match execute_platform_command_once(
                    session,
                    &request.command,
                    Some(cancellation),
                    commit_windows,
                    request.deadline_unix_ms,
                )
                .await
                {
                    Ok((phase, output)) => StoredCommandResult {
                        effect_phase: phase,
                        output: Some(output),
                        error: None,
                    },
                    Err(error) => StoredCommandResult::failed(error),
                },
                Err(error) => StoredCommandResult::failed(error),
            }
        }
        Ok(Err(error)) => StoredCommandResult::failed_at(
            if write
                && !matches!(
                    error.code,
                    ErrorCode::Cancelled | ErrorCode::CommitWindowUnavailable
                )
            {
                EffectPhase::Ambiguous
            } else {
                EffectPhase::NotStarted
            },
            error,
        ),
        Err(error) => StoredCommandResult::failed_at(
            if write {
                EffectPhase::Ambiguous
            } else {
                EffectPhase::NotStarted
            },
            error,
        ),
    }
}

async fn execute_platform_command_once(
    session: &mut EngineSession,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    commit_windows: &CommitWindowRequester,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    match session.platform {
        Platform::Xiaohongshu => {
            execute_xhs_command_once(
                session,
                command,
                cancellation,
                commit_windows,
                deadline_unix_ms,
            )
            .await
        }
        Platform::WechatChannels => match command {
            NativeCommand::WechatCaptureSession(_) => {
                let candidate = wechat::capture_session(
                    &mut session.cdp,
                    &mut session.wechat_capture_initialized,
                    &mut session.wechat_request_context,
                )
                .await?;
                Ok((
                    EffectPhase::Confirmed,
                    CommandOutput::WechatSessionCandidate(candidate),
                ))
            }
            _ => Err(EngineError::new(
                ErrorCode::UnsupportedCommand,
                "native WeChat adapter does not support this command",
            )),
        },
        Platform::Facebook => {
            facebook::runtime::execute(
                session,
                command,
                cancellation,
                commit_windows,
                deadline_unix_ms,
            )
            .await
        }
    }
}

async fn execute_xhs_command_once(
    session: &mut EngineSession,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    commit_windows: &CommitWindowRequester,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    // ① 高危写动作的提交前即席复检。命中即**零派发**、诚实回执。
    if let Some(refusal) = ensure_xhs_action_gate(session, command).await {
        return Ok(refusal);
    }
    // ② 不可逆写入的提交窗口。开窗只能落在调用页面规则**之前**：真正的点击发生在页面规则内部，
    //    引擎无从插进那一刻，故粒度是「整条 router 调用」，预算必须覆盖规则内部的后置校验停顿。
    //    拿不到窗口时 `enter` 返回 `CommitWindowUnavailable`，整条命令按**未开始**终结——
    //    MUST NOT 先写了再说。
    if let Some(contract) = xiaohongshu_commit_window(command) {
        commit_windows
            .enter(
                contract.label,
                contract.budget_ms,
                deadline_unix_ms,
                cancellation,
            )
            .await?;
    }
    use NativeCommand::*;
    match command {
        CaptchaCapture(params) => capture_captcha(session, params).await,
        CaptchaClick(params) => {
            click_captcha(session, params, cancellation, deadline_unix_ms).await
        }
        NoteOpen(params) if params.url.is_some() => {
            let url = validated_note_url(
                params.url.as_deref().unwrap_or_default(),
                params.note_id.as_deref(),
            )?;
            session.cdp.navigate(url.as_str()).await?;
            if !wait_for_page_kind(session, PageKind::NoteDetail, Duration::from_secs(5)).await? {
                return Err(navigation_postcondition_failed());
            }
            evaluate_router(session, command).await
        }
        IdentityReadSelfProfile(params) => {
            let url = direct_profile_url(&params.account_id)?;
            session.cdp.navigate(url.as_str()).await?;
            if !wait_for_page_kind(session, PageKind::Profile, Duration::from_secs(5)).await? {
                return Err(navigation_postcondition_failed());
            }
            let profile_command = NativeCommand::ProfileOpen(crate::command::ProfileOpenParams {
                author_id: Some(params.account_id.clone()),
                reason: None,
                think_ms: None,
            });
            let (phase, output) = evaluate_router(session, &profile_command).await?;
            let CommandOutput::ProfileDetail(profile) = output else {
                return Err(EngineError::new(
                    ErrorCode::CdpError,
                    "native Xiaohongshu identity command returned an invalid output",
                ));
            };
            Ok((
                phase,
                CommandOutput::IdentityObservation(
                    IdentityObservation {
                        capture_id: params.capture_id.clone(),
                        account_id: profile.author_id,
                        nickname: profile.nickname,
                        source: IdentityObservationSource::SelfProfile,
                        page_effect: IdentityPageEffect::NavigatedSelfProfile,
                    }
                    .bounded(),
                ),
            ))
        }
        SearchExecute(params) => {
            execute_search(session, params, command, cancellation, deadline_unix_ms).await
        }
        PublishUploadImage(params) => {
            validate_publish_file(&params.path)?;
            let selector = xhs::file_input_selector()?;
            let node_id = session.cdp.query_selector_node(&selector).await?;
            session
                .cdp
                .set_file_input_files(node_id, std::slice::from_ref(&params.path))
                .await?;
            verify_uploaded_preview(session, command).await
        }
        PublishNavigateEntry(params) => {
            session
                .cdp
                .navigate("https://creator.xiaohongshu.com/publish/publish")
                .await?;
            if !wait_for_page_kind(session, PageKind::Publish, Duration::from_secs(6)).await? {
                return Ok((
                    EffectPhase::Ambiguous,
                    CommandOutput::PublishReceipt(PublishReceipt {
                        record_id: params.record_id,
                        seq: params.seq,
                        kind: "navigate_entry".to_owned(),
                        ok: false,
                        submit_dispatched: None,
                        value: None,
                        post_url: None,
                        error: Some("publish_entry_unconfirmed".to_owned()),
                    }),
                ));
            }
            Ok((
                EffectPhase::Confirmed,
                CommandOutput::PublishReceipt(PublishReceipt {
                    record_id: params.record_id,
                    seq: params.seq,
                    kind: "navigate_entry".to_owned(),
                    ok: true,
                    submit_dispatched: None,
                    value: None,
                    post_url: None,
                    error: None,
                }),
            ))
        }
        PublishCaptureScheduled(_) | PublishReconcileScheduled(_) => {
            session
                .cdp
                .navigate("https://creator.xiaohongshu.com/new/note-manager?source=official")
                .await?;
            wait_for_document_ready(session, Duration::from_secs(6)).await?;
            evaluate_router(session, command).await
        }
        _ => evaluate_router(session, command).await,
    }
}

/// 小红书高危写动作在派发之前的即席新鲜复检（fail-closed）。
///
/// 为什么不能只读周期观测的缓存：缓存可能过期约一个节拍，而闸门放行到真正点击之间还隔着
/// 一段拟人停顿——那段窗口里弹出的验证码只靠缓存必漏。故在派发之前就地再探一次。
///
/// 只认验证码与登录墙两桶。`PageKind::Unknown` 的含义是「这个页面我没认出来」，不是
/// 「我看见一堵归不了类的阻断墙」；小红书的看图态 / AI 搜索结果页 / 详情弹层都会落进它，
/// 把它算作拒绝等于把「没认出来」变成「所有互动都不做了」——MUST NOT 拒绝。
///
/// 探测**本身**拿不到判定时保守当成有挑战：错过一次点赞很便宜，点进风控墙很贵。
/// 这一档同样是零派发 + 诚实回执，绝不升级成整条命令的引擎错误（方向反了就成了「命令失败」而非「保守停手」）。
async fn ensure_xhs_action_gate(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Option<(EffectPhase, CommandOutput)> {
    let action = xhs_gated_action_name(command)?;
    let reason = match session.cdp.probe_page().await {
        Ok(probe) => match probe.page_kind {
            PageKind::Captcha => "blocked_by_captcha",
            PageKind::Login => "login_required",
            _ => return None,
        },
        Err(_) => "blocked_by_captcha",
    };
    Some(xhs_gate_refusal(action, reason))
}

/// 走提交前闸的小红书动作与它们的规范动作名（云端按这些名字结案与记账）。
fn xhs_gated_action_name(command: &NativeCommand) -> Option<&'static str> {
    match command {
        NativeCommand::InteractionLike(_) => Some("like"),
        NativeCommand::InteractionCollect(_) => Some("collect"),
        NativeCommand::InteractionFollow(_) => Some("follow"),
        NativeCommand::InteractionComment(_) => Some("comment"),
        _ => None,
    }
}

fn xhs_gate_refusal(action: &'static str, reason: &'static str) -> (EffectPhase, CommandOutput) {
    (
        // 一个字节都没写过页面：相位必须是「未开始」，绝不含糊成 ambiguous。
        EffectPhase::NotStarted,
        CommandOutput::ActionReceipt(Box::new(ActionReceipt {
            action: action.to_owned(),
            ok: false,
            reason: Some(reason.to_owned()),
            note_id: None,
            observation: None,
            post_observation: None,
            group_observation: None,
            group_url: None,
            clicked: None,
            candidates: Vec::new(),
            type_report: None,
        })),
    )
}

async fn execute_search(
    session: &mut EngineSession,
    params: &crate::command::SearchExecuteParams,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let search_input_geometry = xhs::search_input_expression("geometry")?;
    let geometry = session.cdp.evaluate(&search_input_geometry, false).await?;
    // 页内异常 ⇒ 这一次没读到几何量，**不是**「页面上没有搜索框」。放行下去两个
    // `let Some(..) else` 会把探针自炸原样说成结构确定的 `search_input_not_found`。
    evaluated_value(&geometry)?;
    let Some(x) = geometry
        .pointer("/result/value/x")
        .and_then(serde_json::Value::as_f64)
    else {
        return Ok(search_receipt(
            EffectPhase::NotStarted,
            "search_input_not_found",
        ));
    };
    let Some(y) = geometry
        .pointer("/result/value/y")
        .and_then(serde_json::Value::as_f64)
    else {
        return Ok(search_receipt(
            EffectPhase::NotStarted,
            "search_input_not_found",
        ));
    };
    session
        .cdp
        .dispatch_mouse("mouseMoved", x, y, "none", 0)
        .await?;
    session
        .cdp
        .dispatch_mouse("mousePressed", x, y, "left", 1)
        .await?;
    session
        .cdp
        .dispatch_mouse("mouseReleased", x, y, "left", 1)
        .await?;
    let focused = probe_xhs_search_input(session, "focus-clear").await?;
    if !xhs_search_input_flag(&focused, "found") {
        return Ok(search_receipt(
            EffectPhase::NotStarted,
            "search_input_not_found",
        ));
    }
    if !xhs_search_input_flag(&focused, "focused") {
        return Ok(search_receipt(
            EffectPhase::NotStarted,
            "search_input_focus_failed",
        ));
    }
    if xhs_search_input_value(&focused) != Some("") {
        clear_xhs_search_input_best_effort(session).await;
        return Ok(search_receipt(
            EffectPhase::NotStarted,
            "search_input_not_clean",
        ));
    }
    if let Err(failure) = type_text_humanized(
        &mut session.cdp,
        &params.keyword,
        cancellation,
        deadline_unix_ms.saturating_sub(7_000),
    )
    .await
    {
        clear_xhs_search_input_best_effort(session).await;
        if matches!(failure, TextInputFailure::Cancelled) {
            return Err(cancelled_before_dispatch());
        }
        return Ok(search_receipt(
            EffectPhase::NotStarted,
            match failure {
                TextInputFailure::Deadline => "search_input_deadline_exceeded",
                TextInputFailure::Engine => "search_input_failed",
                TextInputFailure::TargetLost => "search_input_focus_lost",
                TextInputFailure::Cancelled => unreachable!(),
            },
        ));
    }
    let focused = match probe_xhs_search_input(session, "focus").await {
        Ok(value) => value,
        Err(_) => {
            clear_xhs_search_input_best_effort(session).await;
            return Ok(search_receipt(
                EffectPhase::NotStarted,
                "search_input_readback_failed",
            ));
        }
    };
    if !xhs_search_input_flag(&focused, "focused") {
        clear_xhs_search_input_best_effort(session).await;
        return Ok(search_receipt(
            EffectPhase::NotStarted,
            "search_input_focus_lost",
        ));
    }
    if xhs_search_input_value(&focused) != Some(params.keyword.as_str()) {
        clear_xhs_search_input_best_effort(session).await;
        return Ok(search_receipt(
            EffectPhase::NotStarted,
            "search_input_readback_mismatch",
        ));
    }
    if let Some(cancellation) = cancellation {
        tokio::select! {
            _ = wait_for_cancellation(cancellation) => {
                clear_xhs_search_input_best_effort(session).await;
                return Err(cancelled_before_dispatch());
            }
            _ = tokio::time::sleep(Duration::from_millis(700)) => {}
        }
    } else {
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
    if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
        clear_xhs_search_input_best_effort(session).await;
        return Err(cancelled_before_dispatch());
    }
    if unix_time_ms() >= deadline_unix_ms {
        clear_xhs_search_input_best_effort(session).await;
        return Ok(search_receipt(
            EffectPhase::NotStarted,
            "search_input_deadline_exceeded",
        ));
    }
    let focused = probe_xhs_search_input(session, "focus").await?;
    if !xhs_search_input_flag(&focused, "focused")
        || xhs_search_input_value(&focused) != Some(params.keyword.as_str())
    {
        clear_xhs_search_input_best_effort(session).await;
        return Ok(search_receipt(
            EffectPhase::NotStarted,
            "search_input_focus_lost",
        ));
    }
    for attempt in 0..2 {
        session
            .cdp
            .dispatch_key_with_text("keyDown", "Enter", "Enter", 13, "\r")
            .await?;
        session
            .cdp
            .dispatch_key("keyUp", "Enter", "Enter", 13)
            .await?;
        if wait_for_page_kind(session, PageKind::Search, Duration::from_secs(3)).await? {
            let mut latest = evaluate_router(session, command).await?;
            for _ in 0..12 {
                if matches!(&latest.1, CommandOutput::PageCards(cards) if !cards.cards.is_empty()) {
                    return Ok(latest);
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
                latest = evaluate_router(session, command).await?;
            }
            return Ok(latest);
        }
        if attempt == 0 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
                return Ok(search_receipt(EffectPhase::Ambiguous, "preempted_by_task"));
            }
            if unix_time_ms() >= deadline_unix_ms {
                return Ok(search_receipt(
                    EffectPhase::Ambiguous,
                    "search_navigation_unconfirmed",
                ));
            }
        }
    }
    Ok(search_receipt(
        EffectPhase::Ambiguous,
        "search_navigation_unconfirmed",
    ))
}

/// 从一次 `Runtime.evaluate` 的回包里取值，**把「页内抛了异常」与「页面确实回了这个值」分成两态**。
///
/// 这一层非有不可，是因为求值固定带 `silent: true`（见 `cdp.rs` 的 `evaluate`）：**页内异常
/// 不会让这次调用失败，也不会出现在 `error` 字段里**，回来的是一个格式完好的成功响应 +
/// `exceptionDetails`，而 `/result/value` 恰好缺席。于是任何
/// `pointer("/result/value").…unwrap_or(默认值)` 的读法都会把「探针自己炸了」悄悄读成
/// 「页面确实是那个默认值」——反爬页面改一改 `document.activeElement` 就能触发，
/// 而操作员看到的是一个结构确定的结论。这是「静默假成功」红线在求值层的形态，MUST NOT 复现。
///
/// `Err` = 页内抛了异常（**这一次没读到**）；`Ok(None)` = 回包里根本没有 `/result/value` 这一格；
/// `Ok(Some(v))` = 页面确实回了 `v`（含 JSON `null`）。
fn evaluated_value(result: &serde_json::Value) -> Result<Option<&serde_json::Value>, EngineError> {
    if let Some(exception) = result.get("exceptionDetails") {
        return Err(EngineError::new(
            ErrorCode::ProbeFailed,
            "native page evaluation raised an exception",
        )
        .with_decode_diagnostic(exception_diagnostic(exception)));
    }
    Ok(result.pointer("/result/value"))
}

async fn probe_xhs_search_input(
    session: &mut EngineSession,
    mode: &str,
) -> Result<serde_json::Value, EngineError> {
    let expression = xhs::search_input_expression(mode)?;
    let result = session.cdp.evaluate(&expression, false).await?;
    // 页内异常 ⇒ 这一次**没读到**搜索框状态。放行下去会被 `xhs_search_input_flag` 的
    // `unwrap_or(false)` 读成「页面上没有搜索框」，把探针自炸说成结构确定的找不到目标。
    evaluated_value(&result)?;
    Ok(result)
}

fn xhs_search_input_flag(value: &serde_json::Value, name: &str) -> bool {
    value
        .pointer(&format!("/result/value/{name}"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn xhs_search_input_value(value: &serde_json::Value) -> Option<&str> {
    value
        .pointer("/result/value/value")
        .and_then(serde_json::Value::as_str)
}

async fn clear_xhs_search_input_best_effort(session: &mut EngineSession) {
    let _ = probe_xhs_search_input(session, "focus-clear").await;
}

/// 回读焦点元素的文本，**把「读不到」与「读到了」分成两态**。
///
/// `Err` = 回读**本身**失败：求值发不出去，**或页内表达式抛了异常**（后者靠 `evaluated_value`
/// 认出来——`silent: true` 下它不会变成一个 `Err`，只会让 `/result/value` 悄悄缺席）；
/// `Ok(None)` = 通道通了、表达式跑完了，页面回的是 null（此刻没有可读的焦点元素）；
/// `Ok(Some(v))` = 真读到了 `v`。
/// 三者压成一个布尔会让「没读到」和「读到了不一样的东西」变成同一个结论——
/// 那正是退役实现把 null 记成「不匹配」的那处失真，MUST NOT 照抄。
async fn focused_text_readback(session: &mut EngineSession) -> Result<Option<String>, EngineError> {
    let readback = session
        .cdp
        .evaluate(
            "(()=>{const e=document.activeElement;if(!e)return null;return String('value' in e?e.value:e.textContent||'')})()",
            false,
        )
        .await?;
    Ok(evaluated_value(&readback)?
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FocusTier {
    Editable,
    Opaque,
    None,
}

/// 探焦点档，并**顺带把焦点元素标签带回来**（取证用，MUST NOT 据它分支）。
///
/// 结果编码成 `"<档>"` 或 `"<档>:<标签>"` 一个字符串而不是一个对象：档位是判据、标签只是取证，
/// 放同一格能让「只认档位」的既有读法原样成立，也让页面侧表达式保持单值返回。
///
/// **「没探到」是第四态，不是第三档**：`Err` = 这一次没探到（通道失败 / 页内抛异常 / 回了个
/// 认不出的档位串）；`Ok((FocusTier::None, _))` = 页面确凿地说「焦点不在可编辑元素上」。
/// 两者压成一态就会让「探针自己炸了」
/// 一路升级成宿主的 `no_target`（「结构确定的找不到目标」），操作员照着一个从未被观测到的
/// 事实去排查。`silent: true` 让页内异常不产生 `Err`，所以这里必须由 `evaluated_value` 认。
async fn probe_active_focus_tier(
    session: &mut EngineSession,
) -> Result<(FocusTier, Option<String>), EngineError> {
    let result = session
        .cdp
        .evaluate(
            "(()=>{const e=document.activeElement;if(!e)return 'none';const tag=String(e.tagName||'');if(e===document.body||e===document.documentElement)return 'none:'+tag;const editable=(tag==='INPUT'&&!e.disabled&&!e.readOnly)||(tag==='TEXTAREA'&&!e.disabled&&!e.readOnly)||e.isContentEditable===true;return (editable?'editable':'opaque')+':'+tag})()",
            false,
        )
        .await?;
    let raw = evaluated_value(&result)?
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            EngineError::new(
                ErrorCode::ProbeFailed,
                "native focus probe returned no tier",
            )
        })?;
    let (tier, tag) = match raw.split_once(':') {
        Some((tier, tag)) => (tier, (!tag.is_empty()).then(|| tag.to_owned())),
        None => (raw, None),
    };
    let tier = match tier {
        "editable" => FocusTier::Editable,
        "opaque" => FocusTier::Opaque,
        "none" => FocusTier::None,
        // 探针回了一个没见过的档位串 ⇒ 页面侧规则漂了，**我们不知道**焦点在哪。
        // 归成 `none` 等于把「读不到」说成「页面上确实没有可编辑焦点」。
        _ => {
            return Err(EngineError::new(
                ErrorCode::ProbeFailed,
                "native focus probe returned an unknown tier",
            ));
        }
    };
    Ok((tier, tag))
}

/// 清空焦点目标失败的**三态**。
///
/// `NotClean` 是一个关于已观测事实的断言（全选没成 / 回读到了残留），`Unverifiable` 则相反：
/// 清空动作发出去了，但回读通道或页内求值本身失败，**残留与否从未被观测**。
/// 压成一态就会把「不知道清没清掉」上报成「确认没清掉」，运营侧照着一个没发生过的现象排查。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClearFailure {
    /// 焦点档里根本没有可清的目标。
    NoTarget,
    /// **读到了**：清空确实没生效。
    NotClean,
    /// 清空动作已派发，但结果验不了。
    Unverifiable,
}

async fn clear_focused_target(
    session: &mut EngineSession,
    focus_tier: FocusTier,
) -> Result<(), ClearFailure> {
    if focus_tier == FocusTier::None {
        return Err(ClearFailure::NoTarget);
    }
    if focus_tier == FocusTier::Editable {
        let selection = session
            .cdp
            .evaluate(
                "(()=>{const e=document.activeElement;if(!e)return false;try{if(typeof e.select==='function'){e.select();return true}const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);return true}catch{return false}})()",
                false,
            )
            .await
            .map_err(|_| ClearFailure::Unverifiable)?;
        // 页内异常 ⇒ 全选到底成没成**不知道**，MUST NOT 归成「确认没选中」。
        match evaluated_value(&selection) {
            Err(_) => return Err(ClearFailure::Unverifiable),
            Ok(value) => {
                if value.and_then(serde_json::Value::as_bool) != Some(true) {
                    return Err(ClearFailure::NotClean);
                }
            }
        }
    } else {
        let modifier = if cfg!(target_os = "macos") { 4 } else { 2 };
        session
            .cdp
            .dispatch_key_with_modifiers("rawKeyDown", "a", "KeyA", 65, modifier)
            .await
            .map_err(|_| ClearFailure::Unverifiable)?;
        session
            .cdp
            .dispatch_key_with_modifiers("keyUp", "a", "KeyA", 65, modifier)
            .await
            .map_err(|_| ClearFailure::Unverifiable)?;
    }
    session
        .cdp
        .dispatch_key("keyDown", "Backspace", "Backspace", 8)
        .await
        .map_err(|_| ClearFailure::Unverifiable)?;
    session
        .cdp
        .dispatch_key("keyUp", "Backspace", "Backspace", 8)
        .await
        .map_err(|_| ClearFailure::Unverifiable)?;
    if focus_tier == FocusTier::Editable {
        match focused_text_readback(session).await {
            Ok(Some(text)) if text.is_empty() => {}
            // 读到了残留：结构确定的「没清干净」。
            Ok(Some(_)) => return Err(ClearFailure::NotClean),
            // 「页面此刻没有可读焦点元素」与「回读炸了」都属于**验不了**：
            // 清空动作已发出，残留与否未观测，绝不冒充「确认没清掉」。
            Ok(None) | Err(_) => return Err(ClearFailure::Unverifiable),
        }
    }
    Ok(())
}

async fn clear_focused_target_best_effort(session: &mut EngineSession, focus_tier: FocusTier) {
    let _ = clear_focused_target(session, focus_tier).await;
}

fn search_receipt(phase: EffectPhase, reason: &str) -> (EffectPhase, CommandOutput) {
    (
        phase,
        CommandOutput::ActionReceipt(Box::new(ActionReceipt {
            action: "search".to_owned(),
            ok: false,
            reason: Some(reason.to_owned()),
            note_id: None,
            observation: None,
            post_observation: None,
            group_observation: None,
            group_url: None,
            clicked: None,
            candidates: Vec::new(),
            type_report: None,
        })),
    )
}

async fn wait_for_document_ready(
    session: &mut EngineSession,
    timeout: Duration,
) -> Result<(), EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let probe = session.cdp.probe_page().await?;
        if matches!(probe.ready_state.as_str(), "interactive" | "complete") {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(navigation_postcondition_failed());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn wait_for_page_kind(
    session: &mut EngineSession,
    expected: PageKind,
    timeout: Duration,
) -> Result<bool, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let probe = session.cdp.probe_page().await?;
        if probe.page_kind == expected {
            return Ok(true);
        }
        if matches!(
            probe.page_kind,
            PageKind::Login | PageKind::Captcha | PageKind::Error
        ) || tokio::time::Instant::now() >= deadline
        {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn verify_uploaded_preview(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let (_, output) = evaluate_router(session, command).await?;
        let confirmed = matches!(&output, CommandOutput::PublishReceipt(receipt) if receipt.ok);
        if confirmed {
            return Ok((EffectPhase::Confirmed, output));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok((EffectPhase::Ambiguous, output));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn validated_note_url(raw: &str, expected_note_id: Option<&str>) -> Result<Url, EngineError> {
    let url = Url::parse(raw).map_err(|_| invalid_navigation_target())?;
    let host = url.host_str().ok_or_else(invalid_navigation_target)?;
    let segments = url
        .path_segments()
        .map(|segments| segments.collect::<Vec<_>>())
        .unwrap_or_default();
    let note_id = match segments.as_slice() {
        ["explore", note_id, ..] => *note_id,
        ["discovery", "item", note_id, ..] => *note_id,
        _ => return Err(invalid_navigation_target()),
    };
    if url.scheme() != "https"
        || !(host == "xiaohongshu.com" || host.ends_with(".xiaohongshu.com"))
        || url.port().is_some()
        || url.username() != ""
        || url.password().is_some()
        || note_id.is_empty()
        || expected_note_id.is_some_and(|expected| expected != note_id)
    {
        return Err(invalid_navigation_target());
    }
    Ok(url)
}

fn direct_profile_url(author_id: &str) -> Result<Url, EngineError> {
    if author_id.is_empty()
        || !author_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err(invalid_navigation_target());
    }
    Url::parse(&format!(
        "https://www.xiaohongshu.com/user/profile/{author_id}"
    ))
    .map_err(|_| invalid_navigation_target())
}

fn invalid_navigation_target() -> EngineError {
    EngineError::new(
        ErrorCode::InvalidRequest,
        "native navigation target is not an allowlisted Xiaohongshu page",
    )
}

fn navigation_postcondition_failed() -> EngineError {
    EngineError::new(
        ErrorCode::ProbeFailed,
        "native navigation postcondition was not confirmed",
    )
}

async fn evaluate_router(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let expression = xhs::command_expression(command)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = xhs::result_from_cdp(&raw)?;
    let output = xhs::typed_output(command, result.output)?;
    Ok((result.effect_phase, output))
}

pub(crate) async fn capture_captcha(
    session: &mut EngineSession,
    params: &crate::command::CaptchaCaptureParams,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let metrics = session.cdp.layout_metrics().await?;
    let width = metrics
        .pointer("/cssVisualViewport/clientWidth")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(1280.0)
        .round()
        .clamp(1.0, 8192.0) as u32;
    let height = metrics
        .pointer("/cssVisualViewport/clientHeight")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(720.0)
        .round()
        .clamp(1.0, 8192.0) as u32;
    let max_width = params.max_image_width.unwrap_or(960).clamp(320, 1920);
    let max_height = params.max_image_height.unwrap_or(720).clamp(240, 1440);
    let scale = (max_width as f64 / width as f64)
        .min(max_height as f64 / height as f64)
        .min(1.0);
    let mut jpeg_base64 = String::new();
    for quality in [params.quality.unwrap_or(45).clamp(20, 70), 30, 20] {
        let shot = session.cdp.capture_screenshot(quality, scale).await?;
        jpeg_base64 = shot
            .get("data")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if !jpeg_base64.is_empty() && jpeg_base64.len() <= 56 * 1024 {
            break;
        }
    }
    if jpeg_base64.is_empty() || jpeg_base64.len() > 56 * 1024 {
        return Err(EngineError::new(
            ErrorCode::CdpError,
            "captcha snapshot exceeded the bounded native response",
        ));
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    jpeg_base64.hash(&mut hasher);
    let fingerprint = hasher.finish();
    let snapshot_id = session
        .captcha_snapshots
        .back()
        .filter(|snapshot| {
            snapshot.incident_id == params.incident_id && snapshot.fingerprint == fingerprint
        })
        .map(|snapshot| snapshot.snapshot_id.clone())
        .unwrap_or_else(|| {
            let snapshot_id = format!(
                "snap-{}-{}",
                unix_time_ms(),
                session.last_command_id.saturating_add(1)
            );
            session.captcha_snapshots.push_back(CaptchaSnapshotState {
                incident_id: params.incident_id.clone(),
                snapshot_id: snapshot_id.clone(),
                width,
                height,
                fingerprint,
            });
            while session.captcha_snapshots.len() > MAX_CAPTCHA_SNAPSHOTS {
                session.captcha_snapshots.pop_front();
            }
            snapshot_id
        });
    Ok((
        EffectPhase::Confirmed,
        CommandOutput::CaptchaSnapshot(
            CaptchaSnapshot {
                incident_id: params.incident_id.clone(),
                snapshot_id,
                width,
                height,
                jpeg_base64,
            }
            .bounded(),
        ),
    ))
}

pub(crate) async fn click_captcha(
    session: &mut EngineSession,
    params: &crate::command::CaptchaClickParams,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let snapshot = session
        .captcha_snapshots
        .iter()
        .rev()
        .find(|snapshot| {
            snapshot.incident_id == params.incident_id && snapshot.snapshot_id == params.snapshot_id
        })
        .cloned()
        .ok_or_else(|| {
            EngineError::new(
                ErrorCode::InvalidRequest,
                "captcha snapshot identity is stale",
            )
        })?;
    // 全程只有这一份取证累加器：每个返回点都从它取**那一刻真实**的快照。
    // 点击段尚未探过焦点，所以此处两个返回点的快照必然整份缺席（见 `CaptchaTypeForensics::snapshot`）——
    // 而它们恰恰是「下发了文本、一个字符都没打」的典型形态，缺席正是要让云端探测器响的那一声。
    let mut forensics = CaptchaTypeForensics::default();
    for (clicked, point) in params.points.iter().enumerate() {
        if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
            if clicked == 0 {
                return Err(cancelled_before_dispatch());
            }
            return Ok(captcha_click_result(
                EffectPhase::Dispatched,
                false,
                "preempted_by_task",
                &forensics,
            ));
        }
        if unix_time_ms() >= deadline_unix_ms {
            if clicked == 0 {
                return Err(EngineError::new(
                    ErrorCode::DeadlineExpired,
                    "native captcha command deadline expired before dispatch",
                ));
            }
            return Ok(captcha_click_result(
                EffectPhase::Dispatched,
                false,
                "captcha_deadline_exceeded",
                &forensics,
            ));
        }
        let x = point.x * snapshot.width as f64;
        let y = point.y * snapshot.height as f64;
        session
            .cdp
            .dispatch_mouse("mouseMoved", x, y, "none", 0)
            .await?;
        session
            .cdp
            .dispatch_mouse("mousePressed", x, y, "left", 1)
            .await?;
        session
            .cdp
            .dispatch_mouse("mouseReleased", x, y, "left", 1)
            .await?;
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
    let mut text_focus_tier = None;
    if let Some(text) = &params.text {
        let focus_tier = match probe_active_focus_tier(session).await {
            Ok((FocusTier::None, tag)) => {
                // 焦点没落定是**结构确定**的失败：知道档位、知道零派发、知道没提交，取证齐备。
                forensics.observe_focus(FocusTier::None, tag);
                return Ok(captcha_click_result(
                    EffectPhase::Dispatched,
                    false,
                    "captcha_input_not_focused",
                    &forensics,
                ));
            }
            Ok((tier, tag)) => {
                forensics.observe_focus(tier, tag);
                tier
            }
            Err(_) => {
                // 探测**本身**失败：焦点档读不到。取证整份缺席——「读不到」不得冒充 `none`。
                return Ok(captcha_click_result(
                    EffectPhase::Dispatched,
                    false,
                    "captcha_input_focus_probe_failed",
                    &forensics,
                ));
            }
        };
        text_focus_tier = Some(focus_tier);
        if let Err(failure) = clear_focused_target(session, focus_tier).await {
            // 清空失败 ⇒ `cleared` 留空（既不是 verified 也不是 attempted），零派发、未提交。
            // 「确认没清干净」与「清了但验不了」是两态，原因码不合并——后者是**未观测**，
            // 冒充前者就等于把一个没被看见的现象写成结论。
            return Ok(captcha_click_result(
                EffectPhase::Dispatched,
                false,
                match failure {
                    ClearFailure::NotClean => "captcha_input_not_clean",
                    ClearFailure::Unverifiable => "captcha_input_clear_unverifiable",
                    ClearFailure::NoTarget => "captcha_input_clear_failed",
                },
                &forensics,
            ));
        }
        // 可编辑档的清空自带「回读确认为空」那一步，故为 verified；不可回读档只能算尽力清过。
        forensics.cleared = Some(if focus_tier == FocusTier::Editable {
            "verified"
        } else {
            "attempted"
        });
        let typing_deadline = deadline_unix_ms.saturating_sub(
            params
                .settle_ms
                .unwrap_or(350)
                .min(3_000)
                .saturating_add(2_000),
        );
        match type_captcha_with_key_events(&mut session.cdp, text, cancellation, typing_deadline)
            .await
        {
            // 成功路径的字符数同样要接住：丢掉它就只剩「请求了几个」可回报。
            Ok(typed) => forensics.typed = typed,
            Err(error) => {
                // 被抢占 / 超预算 / 通道失败：已派发的部分留在页面上 ⇒ 清场 + **如实回报实际派发数**，
                // MUST NOT 回退成 `text.chars().count()`，且绝不继续提交。
                forensics.typed = error.typed;
                clear_focused_target_best_effort(session, focus_tier).await;
                return Ok(captcha_click_result(
                    EffectPhase::Dispatched,
                    false,
                    match error.failure {
                        TextInputFailure::Cancelled => "preempted_by_task",
                        TextInputFailure::Deadline => "captcha_type_deadline_exceeded",
                        TextInputFailure::Engine => "captcha_type_failed",
                        TextInputFailure::TargetLost => "captcha_input_focus_lost",
                    },
                    &forensics,
                ));
            }
        }
        if focus_tier == FocusTier::Editable {
            // 回读是三态，不是布尔：读到且一致 / 读到但不一致 / 根本没读到。
            // 退役实现把「没读到」压成「不一致」，那是把不知道说成知道，此处**有意不照抄**。
            match focused_text_readback(session).await {
                Ok(Some(actual)) if actual == *text => forensics.verified = Some("match"),
                Ok(Some(_)) => {
                    forensics.verified = Some("mismatch");
                    clear_focused_target_best_effort(session, focus_tier).await;
                    return Ok(captcha_click_result(
                        EffectPhase::Dispatched,
                        false,
                        "text_readback_mismatch",
                        &forensics,
                    ));
                }
                Ok(None) => {
                    // 通道通了、页面说「此刻没有可读的焦点元素」⇒ 结构上验不了，如实标 unverifiable。
                    forensics.verified = Some("unverifiable");
                    clear_focused_target_best_effort(session, focus_tier).await;
                    return Ok(captcha_click_result(
                        EffectPhase::Dispatched,
                        false,
                        "text_readback_unreadable",
                        &forensics,
                    ));
                }
                Err(_) => {
                    // 回读**通道**失败 ⇒ 连「验不了」都说不出口，`verified` 整格留空。
                    clear_focused_target_best_effort(session, focus_tier).await;
                    return Ok(captcha_click_result(
                        EffectPhase::Dispatched,
                        false,
                        "text_readback_failed",
                        &forensics,
                    ));
                }
            }
        } else {
            // 不可回读的焦点档：结构上就验不了，如实标记，绝不当成 match。
            forensics.verified = Some("unverifiable");
        }
    }
    if params.submit.as_deref() == Some("enter") {
        if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
            if let Some(focus_tier) = text_focus_tier {
                clear_focused_target_best_effort(session, focus_tier).await;
            }
            return Ok(captcha_click_result(
                EffectPhase::Dispatched,
                false,
                "preempted_by_task",
                &forensics,
            ));
        }
        if unix_time_ms() >= deadline_unix_ms {
            if let Some(focus_tier) = text_focus_tier {
                clear_focused_target_best_effort(session, focus_tier).await;
            }
            return Ok(captcha_click_result(
                EffectPhase::Dispatched,
                false,
                "captcha_deadline_exceeded",
                &forensics,
            ));
        }
        if let Some(expected_tier) = text_focus_tier {
            // 提交前重探一次：Enter 跟随焦点，焦点转移就会从错的上下文提交。
            // 探测**本身**失败与「焦点确实变了」是两态，原因码不合并。
            let Ok((current_tier, _)) = probe_active_focus_tier(session).await else {
                clear_focused_target_best_effort(session, expected_tier).await;
                return Ok(captcha_click_result(
                    EffectPhase::Dispatched,
                    false,
                    "captcha_input_focus_probe_failed",
                    &forensics,
                ));
            };
            if current_tier != expected_tier {
                clear_focused_target_best_effort(session, current_tier).await;
                return Ok(captcha_click_result(
                    EffectPhase::Dispatched,
                    false,
                    "captcha_input_focus_lost",
                    &forensics,
                ));
            }
        }
        // 提交按键的两次派发**分开判**：按下失败 ⇒ 提交按键从未到过页面（submitted=false）；
        // 按下成功而抬起失败 ⇒ 提交**真的发生过**，此时回报 submitted=false 就是把既成事实说没有。
        if session
            .cdp
            .dispatch_key_with_text("keyDown", "Enter", "Enter", 13, "\r")
            .await
            .is_err()
        {
            return Ok(captcha_click_result(
                EffectPhase::Dispatched,
                false,
                "captcha_submit_failed",
                &forensics,
            ));
        }
        forensics.submitted = true;
        if session
            .cdp
            .dispatch_key("keyUp", "Enter", "Enter", 13)
            .await
            .is_err()
        {
            return Ok(captcha_click_result(
                EffectPhase::Dispatched,
                false,
                "captcha_submit_key_release_failed",
                &forensics,
            ));
        }
    }
    tokio::time::sleep(Duration::from_millis(
        params.settle_ms.unwrap_or(350).min(3_000),
    ))
    .await;
    // 复检读不到 ⇒ 判定不可得，**不是**「没清掉」。回车常触发导航，此处失败是常态而非事故；
    // 关键是取证（打进去几个 / 有没有提交）不能跟着这次读不到一起蒸发。
    let Ok(page) = session.cdp.probe_page().await else {
        return Ok(captcha_click_result(
            EffectPhase::Dispatched,
            false,
            "captcha_verdict_unavailable",
            &forensics,
        ));
    };
    let blocked = matches!(
        page.page_kind,
        PageKind::Captcha | PageKind::Unknown | PageKind::Login
    );
    Ok(captcha_click_result(
        EffectPhase::Confirmed,
        !blocked,
        if blocked { "still_blocked" } else { "cleared" },
        &forensics,
    ))
}

/// 验证码协助键入的取证累加器：每个回执返回点都从它取一份**那一刻真实**的快照。
///
/// 之所以是累加器而不是逐点手搓：`click_captcha` 有十几个返回点，手搓必然漏，
/// 而漏掉的那一份不会报错，只会变成一条「看着完整、其实空着」的回执。
#[derive(Clone, Debug, Default)]
struct CaptchaTypeForensics {
    focus: Option<FocusTier>,
    focus_tag: Option<String>,
    cleared: Option<&'static str>,
    typed: usize,
    verified: Option<&'static str>,
    submitted: bool,
}

impl CaptchaTypeForensics {
    fn observe_focus(&mut self, tier: FocusTier, tag: Option<String>) {
        self.focus = Some(tier);
        self.focus_tag = tag;
    }

    /// 焦点档还没探到（或探测本身失败）时**整份缺席**。
    ///
    /// 云端契约里 `focus` 是必填且只有三个确定值，硬填一个等于把「不知道」说成「知道」；
    /// 缺席则让云端的「下发了文本却未键入」探测器如实响。
    fn snapshot(&self) -> Option<CaptchaTypeReport> {
        let focus = self.focus?;
        Some(CaptchaTypeReport {
            focus: match focus {
                FocusTier::Editable => "editable",
                FocusTier::Opaque => "opaque",
                FocusTier::None => "none",
            }
            .to_owned(),
            focus_tag: self.focus_tag.clone(),
            cleared: self.cleared.map(str::to_owned),
            typed: self.typed,
            verified: self.verified.map(str::to_owned),
            submitted: self.submitted,
        })
    }
}

fn captcha_click_result(
    phase: EffectPhase,
    ok: bool,
    reason: &str,
    forensics: &CaptchaTypeForensics,
) -> (EffectPhase, CommandOutput) {
    (
        phase,
        CommandOutput::ActionReceipt(Box::new(
            ActionReceipt {
                action: "captcha_click".to_owned(),
                ok,
                reason: Some(reason.to_owned()),
                note_id: None,
                observation: None,
                post_observation: None,
                group_observation: None,
                group_url: None,
                clicked: None,
                candidates: Vec::new(),
                type_report: forensics.snapshot(),
            }
            .bounded(),
        )),
    )
}

pub(crate) fn validate_publish_file(path: &str) -> Result<(), EngineError> {
    let path = std::path::Path::new(path);
    let allowed = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png" | "webp"
            )
        });
    let metadata = std::fs::metadata(path).map_err(|_| {
        EngineError::new(
            ErrorCode::InvalidRequest,
            "authorized publish image is unavailable",
        )
    })?;
    if !path.is_absolute()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > 30 * 1024 * 1024
        || !allowed
    {
        return Err(EngineError::new(
            ErrorCode::InvalidRequest,
            "authorized publish image is invalid",
        ));
    }
    Ok(())
}

async fn execute_page_probe(
    session: &mut EngineSession,
    deadline_unix_ms: u64,
    cancellation: &AtomicBool,
) -> Result<ProbeResult, EngineError> {
    let first = probe_once(session, deadline_unix_ms, cancellation).await;
    match first {
        Ok(result) => Ok(result),
        Err(error)
            if matches!(
                error.code,
                ErrorCode::CdpError | ErrorCode::CdpConnectFailed
            ) =>
        {
            session.reconnect(deadline_unix_ms, cancellation).await?;
            probe_once(session, deadline_unix_ms, cancellation).await
        }
        Err(error) => Err(error),
    }
}

async fn probe_once(
    session: &mut EngineSession,
    deadline_unix_ms: u64,
    cancellation: &AtomicBool,
) -> Result<ProbeResult, EngineError> {
    if cancellation.load(Ordering::Acquire) {
        return Err(cancelled_before_dispatch());
    }
    let remaining = remaining_budget(deadline_unix_ms, session.timeout_ms)?;
    let cancellation_wait = wait_for_cancellation(cancellation);
    tokio::pin!(cancellation_wait);
    let probe = tokio::time::timeout(remaining, session.cdp.probe_page());
    tokio::pin!(probe);
    tokio::select! {
        _ = &mut cancellation_wait => Err(cancelled_before_dispatch()),
        result = &mut probe => result.map_err(|_| EngineError::new(
            ErrorCode::CdpTimeout,
            "native page command exceeded its deadline",
        ))?,
    }
}

async fn wait_for_cancellation(cancellation: &AtomicBool) {
    while !cancellation.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn remaining_budget(
    deadline_unix_ms: u64,
    session_timeout_ms: u64,
) -> Result<Duration, EngineError> {
    let remaining_ms = deadline_unix_ms.saturating_sub(unix_time_ms());
    if remaining_ms == 0 {
        return Err(EngineError::new(
            ErrorCode::DeadlineExpired,
            "native page engine command deadline expired before dispatch",
        ));
    }
    Ok(Duration::from_millis(remaining_ms.min(session_timeout_ms)))
}

fn command_timeout_ms(session: &EngineSession, command: &NativeCommand) -> u64 {
    command_timeout_ms_for(session.platform, session.timeout_ms, command)
}

fn command_timeout_ms_for(
    platform: Platform,
    session_timeout_ms: u64,
    command: &NativeCommand,
) -> u64 {
    let ceiling = command_timeout_ceiling(platform, command);
    if platform == Platform::Facebook && matches!(command, NativeCommand::PublishFillField(_)) {
        ceiling
    } else {
        session_timeout_ms.min(ceiling)
    }
}

fn command_timeout_ceiling(platform: Platform, command: &NativeCommand) -> u64 {
    if platform == Platform::Facebook && matches!(command, NativeCommand::PublishFillField(_)) {
        FACEBOOK_PUBLISH_FILL_TIMEOUT_MS
    } else if platform == Platform::Facebook
        && matches!(
            command,
            NativeCommand::BrowseScroll(_) | NativeCommand::PageScroll(_)
        )
    {
        FACEBOOK_FEED_SCROLL_TIMEOUT_MS
    } else if platform == Platform::Facebook
        && matches!(command, NativeCommand::InteractionComment(_))
    {
        FACEBOOK_COMMENT_TIMEOUT_MS
    } else if platform == Platform::Facebook && matches!(command, NativeCommand::GroupJoin(_)) {
        FACEBOOK_GROUP_JOIN_TIMEOUT_MS
    } else if platform == Platform::Facebook
        && matches!(command, NativeCommand::PublishSelectMode(_))
    {
        FACEBOOK_PUBLISH_SELECT_MODE_TIMEOUT_MS
    } else if platform == Platform::Facebook
        && matches!(
            command,
            NativeCommand::NoteOpen(NoteOpenParams {
                selection: Some(NoteOpenSelection::FirstCommentableGroupPost),
                ..
            })
        )
    {
        // 空关键词首帖开帖是一串串行有界窗（就绪 8s + 四轮下滚 + 可选二次导航就绪 8s +
        // 评论框绑定 12s + 身份回读 20s ≈ 62s），沿用默认 30s 会在内层跑完前先到点。
        // 该值是三处同步之一，另两处：边缘 src/native-page-engine/browse-session.ts（请求值）
        // 与 src/native-page-engine/client.ts（准入校验，超上限直接 invalid_request、命令不下发）。
        FACEBOOK_FIRST_POST_OPEN_TIMEOUT_MS
    } else {
        DEFAULT_COMMAND_TIMEOUT_MS
    }
}

fn cancelled_before_dispatch() -> EngineError {
    EngineError::new(
        ErrorCode::Cancelled,
        "native page engine command cancelled before dispatch",
    )
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facebook::group_join::{
        FacebookJoinPostDecision, facebook_join_post_decision, facebook_join_readiness_decisive,
    };
    use crate::facebook::reels::{reel_forward_key, reel_identity_moved};
    use crate::facebook::shared::{canonical_facebook_post_id, facebook_scroll_failure};

    #[test]
    fn stored_failures_never_upgrade_effect_truth() {
        let result = StoredCommandResult::failed(EngineError::new(
            ErrorCode::DeadlineExpired,
            "deadline expired",
        ));
        assert_eq!(result.effect_phase, EffectPhase::NotStarted);
        assert!(result.output.is_none());
        assert_eq!(
            result.error.expect("error").code,
            ErrorCode::DeadlineExpired
        );
    }

    #[test]
    fn long_command_ceilings_are_capability_specific() {
        let join = NativeCommand::GroupJoin(crate::command::GroupJoinParams {
            group_url: "https://www.facebook.com/groups/42".to_owned(),
            click: Some(true),
            reason: None,
            think_ms: None,
        });
        let select_mode =
            NativeCommand::PublishSelectMode(crate::command::PublishSelectModeParams {
                record_id: 7,
                seq: 2,
                option_kind: Some("target".to_owned()),
                option_value: Some("facebook_personal_timeline".to_owned()),
            });
        let fill = NativeCommand::PublishFillField(crate::command::PublishFieldParams {
            record_id: 7,
            seq: 3,
            field_type: "content".to_owned(),
            value: "Vietnamese body".to_owned(),
        });
        let comment = NativeCommand::InteractionComment(crate::command::CommentParams {
            note_id: "https://www.facebook.com/groups/42/posts/7".to_owned(),
            text: "Vietnamese comment".to_owned(),
            account_id: Some("61591824155856".to_owned()),
            group_chat_code: None,
            fast_return_to_feed: None,
            reason: None,
            think_ms: None,
        });
        let browse_scroll = NativeCommand::BrowseScroll(crate::command::ReasonParams::default());
        let page_scroll = NativeCommand::PageScroll(crate::command::PageScrollParams::default());
        let probe = NativeCommand::PageProbe(crate::command::EmptyParams::default());
        assert_eq!(
            command_timeout_ceiling(Platform::Facebook, &join),
            FACEBOOK_GROUP_JOIN_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ceiling(Platform::Facebook, &select_mode),
            FACEBOOK_PUBLISH_SELECT_MODE_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ceiling(Platform::Facebook, &fill),
            FACEBOOK_PUBLISH_FILL_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ceiling(Platform::Facebook, &comment),
            FACEBOOK_COMMENT_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ceiling(Platform::Facebook, &browse_scroll),
            FACEBOOK_FEED_SCROLL_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ceiling(Platform::Facebook, &page_scroll),
            FACEBOOK_FEED_SCROLL_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ceiling(Platform::Facebook, &probe),
            DEFAULT_COMMAND_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ceiling(Platform::Xiaohongshu, &join),
            DEFAULT_COMMAND_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ceiling(Platform::Xiaohongshu, &select_mode),
            DEFAULT_COMMAND_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ceiling(Platform::Xiaohongshu, &fill),
            DEFAULT_COMMAND_TIMEOUT_MS
        );
        // 边缘 `src/native-page-engine/runtime.ts` 对 Facebook 会话下发的 timeout_ms。
        // 它必须 ≥ 所有天花板，否则下面的 min() 会把天花板**静默夹回**（不报错、不打日志）。
        // 跨语言那半由边缘 `test/native-page-engine/timeout-chain-contract.test.ts` 守。
        const FACEBOOK_SESSION_TIMEOUT_MS: u64 = 180_000;
        assert_eq!(
            command_timeout_ms_for(Platform::Facebook, FACEBOOK_SESSION_TIMEOUT_MS, &fill),
            FACEBOOK_PUBLISH_FILL_TIMEOUT_MS,
            "发布填正文显式绕过 min()，不受会话超时约束"
        );
        assert_eq!(
            command_timeout_ms_for(Platform::Facebook, FACEBOOK_SESSION_TIMEOUT_MS, &join),
            FACEBOOK_GROUP_JOIN_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ms_for(Platform::Facebook, FACEBOOK_SESSION_TIMEOUT_MS, &comment),
            FACEBOOK_COMMENT_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ms_for(
                Platform::Facebook,
                FACEBOOK_SESSION_TIMEOUT_MS,
                &browse_scroll,
            ),
            FACEBOOK_FEED_SCROLL_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ms_for(
                Platform::Facebook,
                FACEBOOK_SESSION_TIMEOUT_MS,
                &page_scroll,
            ),
            FACEBOOK_FEED_SCROLL_TIMEOUT_MS
        );
        // 会话超时偏小时天花板**被静默夹回**——这正是 2026-07-29 那类漏改的失败形态：
        // 看着改了天花板，实际跑的还是旧值，且没有任何错误可看。
        assert_eq!(
            command_timeout_ms_for(Platform::Facebook, 60_000, &comment),
            60_000,
            "会话超时小于天花板时必须夹回会话值——本断言存在的意义是把这个陷阱写死在案"
        );

        // 空关键词首帖开帖有自己的天花板；按 URL 开帖不得跟着放开。
        // 这一层是三处同步之一（另两处在边缘 browse-session.ts 的请求值与 client.ts 的准入校验），
        // 少改任何一处，首帖开帖不是"没生效"而是**毫秒级被拒**（2026-07-29 真机实证）。
        let first_post = NativeCommand::NoteOpen(NoteOpenParams {
            selection: Some(NoteOpenSelection::FirstCommentableGroupPost),
            container: Some("https://www.facebook.com/groups/42".to_owned()),
            ..NoteOpenParams::default()
        });
        let open_by_url = NativeCommand::NoteOpen(NoteOpenParams {
            url: Some("https://www.facebook.com/groups/42/posts/7".to_owned()),
            ..NoteOpenParams::default()
        });
        assert_eq!(
            command_timeout_ceiling(Platform::Facebook, &first_post),
            FACEBOOK_FIRST_POST_OPEN_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ceiling(Platform::Facebook, &open_by_url),
            DEFAULT_COMMAND_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ceiling(Platform::Xiaohongshu, &first_post),
            DEFAULT_COMMAND_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ms_for(Platform::Facebook, FACEBOOK_SESSION_TIMEOUT_MS, &first_post),
            FACEBOOK_FIRST_POST_OPEN_TIMEOUT_MS
        );
    }

    #[test]
    fn facebook_join_loading_control_is_not_ready_without_a_higher_priority_state() {
        let mut probe = facebook::FacebookJoinProbe {
            observation: crate::model::FacebookGroupJoinObservation {
                document_ready: Some("loading".to_owned()),
                ..Default::default()
            },
            joined: false,
            pending: false,
            questionnaire: false,
            found: true,
            ambiguous: false,
            cx: Some(50.0),
            cy: Some(20.0),
        };
        assert!(!facebook_join_readiness_decisive(&probe, false));

        probe.observation.document_ready = Some("interactive".to_owned());
        assert!(facebook_join_readiness_decisive(&probe, false));

        probe.observation.document_ready = Some("loading".to_owned());
        probe.pending = true;
        assert!(facebook_join_readiness_decisive(&probe, false));
    }

    #[test]
    fn facebook_join_post_facts_win_over_simultaneous_cancellation() {
        let mut probe = facebook::FacebookJoinProbe {
            observation: crate::model::FacebookGroupJoinObservation::default(),
            joined: true,
            pending: false,
            questionnaire: false,
            found: false,
            ambiguous: false,
            cx: None,
            cy: None,
        };
        assert_eq!(
            facebook_join_post_decision(&probe, false, true),
            FacebookJoinPostDecision::Joined
        );

        probe.joined = false;
        probe.observation.captcha_detected = Some(true);
        assert_eq!(
            facebook_join_post_decision(&probe, false, true),
            FacebookJoinPostDecision::Captcha
        );

        probe.observation.captcha_detected = Some(false);
        assert_eq!(
            facebook_join_post_decision(&probe, false, true),
            FacebookJoinPostDecision::Preempted
        );
    }

    #[test]
    fn direct_navigation_accepts_only_bound_xiaohongshu_targets() {
        let accepted = validated_note_url(
            "https://www.xiaohongshu.com/explore/note_123?xsec_token=opaque",
            Some("note_123"),
        )
        .expect("allowlisted note URL");
        assert_eq!(accepted.path(), "/explore/note_123");
        assert!(validated_note_url("https://example.com/explore/note_123", None).is_err());
        assert!(
            validated_note_url(
                "https://www.xiaohongshu.com/explore/another",
                Some("note_123")
            )
            .is_err()
        );
        assert!(
            validated_note_url(
                "https://www.xiaohongshu.com.evil.test/explore/note_123",
                None
            )
            .is_err()
        );
    }

    #[test]
    fn direct_profile_path_cannot_be_injected() {
        assert_eq!(
            direct_profile_url("author_123")
                .expect("profile URL")
                .path(),
            "/user/profile/author_123"
        );
        assert!(direct_profile_url("../notification").is_err());
        assert!(direct_profile_url("author?redirect=evil").is_err());
    }

    #[test]
    fn reel_target_movement_uses_note_and_video_identity() {
        let before = facebook::FacebookReelProbe {
            ok: true,
            reason: None,
            note_id: Some("https://www.facebook.com/reel/1".to_owned()),
            video_key: Some("video-1@element:1".to_owned()),
            video_rect: None,
        };
        assert!(!reel_identity_moved(
            Some("https://www.facebook.com/reel/1"),
            Some("video-1@element:1"),
            &before
        ));
        assert!(reel_identity_moved(
            Some("https://www.facebook.com/reel/2"),
            Some("video-2@element:2"),
            &before
        ));
        assert!(!reel_identity_moved(
            None,
            Some("video-2@element:2"),
            &before
        ));

        let anonymous_before = facebook::FacebookReelProbe {
            note_id: None,
            ..before
        };
        assert!(!reel_identity_moved(
            Some("https://www.facebook.com/reel/2"),
            Some("video-1@element:1"),
            &anonymous_before
        ));
        assert!(reel_identity_moved(
            Some("https://www.facebook.com/reel/2"),
            Some("video-2@element:2"),
            &anonymous_before
        ));
    }

    #[test]
    fn reel_axis_maps_to_one_forward_key() {
        assert_eq!(
            reel_forward_key(facebook::FacebookReelAxis::Vertical),
            ("ArrowDown", 40)
        );
        assert_eq!(
            reel_forward_key(facebook::FacebookReelAxis::Horizontal),
            ("ArrowRight", 39)
        );
    }

    #[test]
    fn facebook_post_identity_matches_equivalent_forms_without_accepting_profiles() {
        let group = canonical_facebook_post_id(
            "https://www.facebook.com/groups/100/posts/2579243155868042",
        );
        let permalink = canonical_facebook_post_id(
            "https://www.facebook.com/permalink.php?story_fbid=2579243155868042&id=99",
        );
        assert_eq!(group.as_deref(), Some("2579243155868042"));
        assert_eq!(group, permalink);
        assert_eq!(
            canonical_facebook_post_id("https://www.facebook.com/watch?v=1632570071375207")
                .as_deref(),
            Some("1632570071375207")
        );
        assert_eq!(
            canonical_facebook_post_id("https://www.facebook.com/reel/1234567890").as_deref(),
            Some("1234567890")
        );
        assert_eq!(
            canonical_facebook_post_id("https://www.facebook.com/profile.php?id=61591824155856"),
            None
        );
        assert_eq!(
            canonical_facebook_post_id("https://facebook.com.evil.test/groups/1/posts/2"),
            None
        );
    }

    #[test]
    fn dispatched_unchanged_reel_returns_one_ambiguous_scroll_terminal() {
        let (phase, output) =
            facebook_scroll_failure(EffectPhase::Ambiguous, "reels_navigation_unconfirmed");
        assert_eq!(phase, EffectPhase::Ambiguous);
        let CommandOutput::ActionReceipt(receipt) = output else {
            panic!("scroll failure must be an action receipt");
        };
        assert_eq!(receipt.action, "scroll");
        assert!(!receipt.ok);
        assert_eq!(
            receipt.reason.as_deref(),
            Some("reels_navigation_unconfirmed")
        );
    }
}
