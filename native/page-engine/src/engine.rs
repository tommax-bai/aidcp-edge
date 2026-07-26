use crate::cdp::CdpSession;
use crate::commit_window::CommitWindowRequester;
use crate::endpoint;
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::model::{
    ActionReceipt, CaptchaSnapshot, FacebookIdentityReceipt, IdentityObservation,
    IdentityObservationSource, IdentityPageEffect, NoteDetail, NotificationHome, NotificationItems,
    PageCards, PageMovement, PlanResults, ProfileDetail, PublishReceipt,
};
use crate::probe::PageKind;
use crate::probe::ProbeResult;
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

const MAX_RECORDED_COMMANDS: usize = 128;
const MAX_CAPTCHA_SNAPSHOTS: usize = 8;
const FACEBOOK_HOME_URL: &str = "https://www.facebook.com/";
const FACEBOOK_DETAIL_HYDRATION_TIMEOUT: Duration = Duration::from_secs(15);
const FACEBOOK_FEED_SETTLE_NAV: Duration = Duration::from_secs(6);
const FACEBOOK_FEED_SETTLE_IN_PLACE: Duration = Duration::from_millis(3_500);
const FACEBOOK_FEED_SCROLL_ROUNDS: usize = 8;
const FACEBOOK_REFRESH_RELOAD_FLOOR_MS: u64 = 180_000;
const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 30_000;
const FACEBOOK_GROUP_JOIN_TIMEOUT_MS: u64 = 90_000;
const FACEBOOK_JOIN_READY_TIMEOUT: Duration = Duration::from_secs(30);
const FACEBOOK_JOIN_HYDRATION_SETTLE: Duration = Duration::from_secs(2);
const FACEBOOK_JOIN_POST_CLICK_SETTLE: Duration = Duration::from_millis(1_500);
const FACEBOOK_JOIN_VERIFY_TIMEOUT: Duration = Duration::from_secs(45);
static FACEBOOK_FEED_LIKE_OPERATION: AtomicU64 = AtomicU64::new(1);

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

struct EngineSession {
    id: String,
    task_id: String,
    host: String,
    port: u16,
    platform: Platform,
    timeout_ms: u64,
    target_id: String,
    cdp: CdpSession,
    last_command_id: u64,
    active_command_id: Option<u64>,
    completed: BTreeMap<u64, StoredCommandResult>,
    captcha_snapshots: VecDeque<CaptchaSnapshotState>,
    wechat_capture_initialized: bool,
    wechat_request_context: Option<wechat::WechatRequestContext>,
    facebook: FacebookSessionState,
}

struct FacebookSessionState {
    active_list_url: String,
    seen_post_ids: HashSet<String>,
    last_refresh_reload_at_ms: u64,
}

impl Default for FacebookSessionState {
    fn default() -> Self {
        Self {
            active_list_url: FACEBOOK_HOME_URL.to_owned(),
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
        Platform::Xiaohongshu => execute_xhs_command_once(session, command).await,
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
            facebook::capability::owner(command).ok_or_else(|| {
                EngineError::new(
                    ErrorCode::UnsupportedCommand,
                    "native Facebook command has no capability owner",
                )
            })?;
            execute_facebook_command_once(
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

async fn execute_facebook_command_once(
    session: &mut EngineSession,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    commit_windows: &CommitWindowRequester,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    use NativeCommand::*;
    match command {
        CaptchaCapture(params) => capture_captcha(session, params).await,
        CaptchaClick(params) => click_captcha(session, params).await,
        IdentityBootstrap(_) => execute_facebook_identity(session, true).await,
        IdentityReadCurrent(params) => {
            let (phase, output) = execute_facebook_identity(session, false).await?;
            let CommandOutput::FacebookIdentity(receipt) = output else {
                return Err(invalid_facebook_identity_output());
            };
            let account_id = receipt
                .account_id
                .unwrap_or_else(|| params.account_id.clone());
            let nickname = if receipt.ok {
                receipt.display_name
            } else {
                None
            };
            Ok((
                phase,
                CommandOutput::IdentityObservation(
                    IdentityObservation {
                        capture_id: params.capture_id.clone(),
                        account_id,
                        nickname,
                        source: IdentityObservationSource::CurrentPage,
                        page_effect: IdentityPageEffect::None,
                    }
                    .bounded(),
                ),
            ))
        }
        BrowseScroll(params) if params.reason.as_deref() == Some("initial_scan") => {
            execute_facebook_initial_feed(session).await
        }
        SearchExecute(params) if params.container.is_some() => {
            execute_facebook_search(session, params, command).await
        }
        NoteOpen(params) if params.url.is_some() => {
            let url = validated_facebook_content_url(
                params.url.as_deref().unwrap_or_default(),
                params.note_id.as_deref(),
            )?;
            let target_post_id = canonical_facebook_post_id(url.as_str())
                .ok_or_else(invalid_facebook_navigation_target)?;
            session.cdp.navigate(url.as_str()).await?;
            wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
            evaluate_facebook_router_until_requested_detail(
                session,
                command,
                &target_post_id,
                FACEBOOK_DETAIL_HYDRATION_TIMEOUT,
            )
            .await
        }
        GroupJoin(params) => {
            let url = validated_facebook_group_url(&params.group_url)?;
            let reuse_current_page = if params.click == Some(true) {
                probe_facebook_join(session)
                    .await
                    .ok()
                    .and_then(|probe| probe.observation.group_url)
                    .is_some_and(|current| current == url.as_str())
            } else {
                false
            };
            if !reuse_current_page {
                session.cdp.navigate(url.as_str()).await?;
            }
            execute_facebook_group_join(
                session,
                params,
                command,
                cancellation,
                commit_windows,
                deadline_unix_ms,
            )
            .await
        }
        PageScroll(params) if params.reason.as_deref() == Some("empty_feed_reels_fallback") => {
            session
                .cdp
                .navigate("https://www.facebook.com/reels/")
                .await?;
            wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
            evaluate_facebook_router_until_cards(session, command, Duration::from_secs(5)).await
        }
        PageScroll(_) => execute_facebook_page_scroll(session, command).await,
        FeedRefresh(_) => execute_facebook_feed_refresh(session).await,
        NoteClose(_) | NavigationBack(_) => execute_facebook_back_to_list(session).await,
        PublishNavigateEntry(_) => {
            session.cdp.navigate("https://www.facebook.com/").await?;
            wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
            execute_facebook_publish_entry(session, command).await
        }
        PublishUploadImage(params) => {
            validate_publish_file(&params.path)?;
            let selector = facebook::file_input_selector()?;
            let node_id = session.cdp.query_selector_node(&selector).await?;
            session
                .cdp
                .set_file_input_files(node_id, std::slice::from_ref(&params.path))
                .await?;
            verify_facebook_uploaded_preview(session, command).await
        }
        InteractionLike(params) => execute_facebook_like(session, params, command).await,
        InteractionFollow(params) => execute_facebook_follow(session, params, command).await,
        InteractionComment(params) => {
            execute_facebook_comment(
                session,
                params,
                command,
                cancellation,
                commit_windows,
                deadline_unix_ms,
            )
            .await
        }
        PublishFillField(params) => execute_facebook_publish_fill(session, params, command).await,
        PublishSubmit(params) => {
            execute_facebook_publish_submit(
                session,
                params,
                command,
                cancellation,
                commit_windows,
                deadline_unix_ms,
            )
            .await
        }
        _ => evaluate_facebook_router(session, command).await,
    }
}

async fn execute_facebook_like(
    session: &mut EngineSession,
    params: &crate::command::NoteInteractionParams,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    if !probe_facebook_reel(session).await?.is_reels_surface() {
        return execute_facebook_feed_like(session, params).await;
    }
    execute_facebook_reel_like(session, params).await
}

async fn execute_facebook_reel_like(
    session: &mut EngineSession,
    params: &crate::command::NoteInteractionParams,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let before = probe_facebook_like(session, &params.note_id).await?;
    if !before.ok {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "like",
            false,
            before.reason.as_deref().unwrap_or("target_not_found"),
            Some(params.note_id.clone()),
            before.observation,
        ));
    }
    if before.already {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "like",
            true,
            "already_liked",
            before.note_id,
            before.observation,
        ));
    }
    if is_facebook_reel_url(&params.note_id) {
        let commit = commit_facebook_reel_like(session, &params.note_id).await?;
        if !commit.ok {
            return Ok(facebook_action_result(
                EffectPhase::NotStarted,
                "like",
                false,
                commit.reason.as_deref().unwrap_or("like_button_not_found"),
                commit.note_id,
                commit.observation.or(before.observation),
            ));
        }
        if commit.already {
            return Ok(facebook_action_result(
                EffectPhase::Confirmed,
                "like",
                true,
                "already_liked",
                commit.note_id,
                commit.observation.or(before.observation),
            ));
        }
        if !commit.clicked {
            return Ok(facebook_action_result(
                EffectPhase::NotStarted,
                "like",
                false,
                commit.reason.as_deref().unwrap_or("like_dispatch_failed"),
                commit.note_id,
                commit.observation.or(before.observation),
            ));
        }
        let note_id = commit.note_id.or(before.note_id);
        let observation = commit.observation.or(before.observation);
        match wait_for_facebook_reel_like(session, &params.note_id, Duration::from_secs(2)).await? {
            FacebookReelLikeVerification::Selected => {
                return Ok(facebook_action_result(
                    EffectPhase::Confirmed,
                    "like",
                    true,
                    "",
                    note_id,
                    observation,
                ));
            }
            FacebookReelLikeVerification::Indeterminate => {
                return Ok(facebook_action_result(
                    EffectPhase::Ambiguous,
                    "like",
                    false,
                    "verify_indeterminate",
                    note_id,
                    observation,
                ));
            }
            FacebookReelLikeVerification::Unchanged => {}
        }

        let picker = probe_facebook_like_picker(session, &params.note_id).await?;
        if picker.ok {
            if let (Some(x), Some(y)) = (picker.cx, picker.cy) {
                dispatch_facebook_click(session, x, y).await?;
            }
        } else if matches!(
            picker.reason.as_deref(),
            Some("target_not_found" | "ambiguous_target" | "like_primary_target_lost")
        ) {
            return Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "like",
                false,
                "verify_indeterminate",
                note_id,
                observation,
            ));
        }
        return match wait_for_facebook_reel_like(session, &params.note_id, Duration::from_secs(3))
            .await?
        {
            FacebookReelLikeVerification::Selected => Ok(facebook_action_result(
                EffectPhase::Confirmed,
                "like",
                true,
                "",
                note_id,
                observation,
            )),
            FacebookReelLikeVerification::Indeterminate => Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "like",
                false,
                "verify_indeterminate",
                note_id,
                observation,
            )),
            FacebookReelLikeVerification::Unchanged => Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "like",
                false,
                "like_unconfirmed",
                note_id,
                observation,
            )),
        };
    }
    let (Some(x), Some(y)) = (before.cx, before.cy) else {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "like",
            false,
            "like_button_not_found",
            before.note_id,
            before.observation,
        ));
    };
    dispatch_facebook_click(session, x, y).await?;
    if wait_for_facebook_like(session, &params.note_id, Duration::from_secs(2)).await? {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "like",
            true,
            "",
            before.note_id,
            before.observation,
        ));
    }

    let picker = probe_facebook_like_picker(session, &params.note_id).await?;
    if picker.ok {
        if let (Some(x), Some(y)) = (picker.cx, picker.cy) {
            dispatch_facebook_click(session, x, y).await?;
        }
    }
    if wait_for_facebook_like(session, &params.note_id, Duration::from_secs(3)).await? {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "like",
            true,
            "",
            before.note_id,
            before.observation,
        ));
    }
    Ok(facebook_action_result(
        EffectPhase::Ambiguous,
        "like",
        false,
        "like_unconfirmed",
        before.note_id,
        before.observation,
    ))
}

async fn execute_facebook_feed_like(
    session: &mut EngineSession,
    params: &crate::command::NoteInteractionParams,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let operation_id = format!(
        "feed-like-{}-{}",
        unix_time_ms(),
        FACEBOOK_FEED_LIKE_OPERATION.fetch_add(1, Ordering::Relaxed)
    );
    let outcome = execute_facebook_feed_like_inner(session, params, &operation_id).await;
    if let Ok(expression) = facebook::feed_like_clear_expression(&operation_id) {
        if let Ok(raw) = session.cdp.evaluate(&expression, true).await {
            let _ = facebook::feed_like_clear_from_cdp(&raw);
        }
    }
    outcome
}

async fn execute_facebook_feed_like_inner(
    session: &mut EngineSession,
    params: &crate::command::NoteInteractionParams,
    operation_id: &str,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let mut target = probe_facebook_feed_like_target(session, &params.note_id).await?;
    for round in 0..FACEBOOK_FEED_SCROLL_ROUNDS {
        if !target.ok {
            return Ok(facebook_action_result(
                EffectPhase::NotStarted,
                "like",
                false,
                target.reason.as_deref().unwrap_or("target_not_found"),
                target.note_id.or_else(|| Some(params.note_id.clone())),
                target.observation,
            ));
        }
        if target.in_viewport {
            break;
        }
        if round + 1 >= FACEBOOK_FEED_SCROLL_ROUNDS {
            return Ok(facebook_action_result(
                EffectPhase::NotStarted,
                "like",
                false,
                "target_not_visible",
                target.note_id.or_else(|| Some(params.note_id.clone())),
                target.observation,
            ));
        }
        let viewport_height = target.viewport_height.unwrap_or(800.0).max(1.0);
        let control_top = target.top.unwrap_or(viewport_height);
        let delta_y = (control_top - viewport_height * 0.55).clamp(-620.0, 620.0);
        session
            .cdp
            .dispatch_wheel(
                target.cx.unwrap_or(720.0).max(1.0),
                (viewport_height * 0.55).max(1.0),
                delta_y,
            )
            .await?;
        tokio::time::sleep(Duration::from_millis(250)).await;
        target = probe_facebook_feed_like_target(session, &params.note_id).await?;
    }

    let commit = commit_facebook_feed_like(session, &params.note_id, operation_id).await?;
    if commit.already {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "like",
            true,
            "already_liked",
            commit.note_id,
            commit.observation,
        ));
    }
    if !commit.started {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "like",
            false,
            commit.reason.as_deref().unwrap_or("like_dispatch_failed"),
            commit.note_id.or_else(|| Some(params.note_id.clone())),
            commit.observation,
        ));
    }

    let first = wait_for_facebook_feed_like(
        session,
        &params.note_id,
        operation_id,
        Duration::from_secs(2),
    )
    .await?;
    if first.state == "confirmed" {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "like",
            true,
            "",
            first.note_id.or(commit.note_id),
            first.observation.or(commit.observation),
        ));
    }
    if matches!(first.state.as_str(), "target_lost" | "identity_mismatch") {
        return Ok(facebook_action_result(
            EffectPhase::Ambiguous,
            "like",
            false,
            "verify_indeterminate",
            commit.note_id,
            commit.observation,
        ));
    }

    let picker = probe_facebook_feed_like_picker(session, &params.note_id, operation_id).await?;
    if picker.ok {
        if let (Some(from_x), Some(from_y), Some(x), Some(y)) =
            (picker.from_x, picker.from_y, picker.cx, picker.cy)
        {
            dispatch_facebook_picker_click(session, from_x, from_y, x, y).await?;
        }
    }

    let final_verification = wait_for_facebook_feed_like(
        session,
        &params.note_id,
        operation_id,
        Duration::from_secs(3),
    )
    .await?;
    if final_verification.state == "confirmed" {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "like",
            true,
            "",
            final_verification.note_id.or(commit.note_id),
            final_verification.observation.or(commit.observation),
        ));
    }
    let reason = if matches!(
        final_verification.state.as_str(),
        "target_lost" | "identity_mismatch"
    ) {
        "verify_indeterminate"
    } else {
        "state_unchanged"
    };
    Ok(facebook_action_result(
        EffectPhase::Ambiguous,
        "like",
        false,
        reason,
        commit.note_id,
        commit.observation,
    ))
}

async fn probe_facebook_feed_like_target(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookFeedLikeTarget, EngineError> {
    let expression = facebook::feed_like_target_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::feed_like_target_from_cdp(&raw)
}

async fn commit_facebook_feed_like(
    session: &mut EngineSession,
    note_id: &str,
    operation_id: &str,
) -> Result<facebook::FacebookFeedLikeCommit, EngineError> {
    let expression = facebook::feed_like_commit_expression(note_id, operation_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::feed_like_commit_from_cdp(&raw)
}

async fn wait_for_facebook_feed_like(
    session: &mut EngineSession,
    note_id: &str,
    operation_id: &str,
    timeout: Duration,
) -> Result<facebook::FacebookFeedLikeVerification, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let expression = facebook::feed_like_verify_expression(note_id, operation_id)?;
        let raw = session.cdp.evaluate(&expression, true).await?;
        let verification = facebook::feed_like_verify_from_cdp(&raw)?;
        if verification.state != "pending" && verification.state != "control_missing" {
            return Ok(verification);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(verification);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn probe_facebook_feed_like_picker(
    session: &mut EngineSession,
    note_id: &str,
    operation_id: &str,
) -> Result<facebook::FacebookFeedLikePicker, EngineError> {
    let expression = facebook::feed_like_picker_expression(note_id, operation_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::feed_like_picker_from_cdp(&raw)
}

async fn dispatch_facebook_picker_click(
    session: &mut EngineSession,
    from_x: f64,
    from_y: f64,
    x: f64,
    y: f64,
) -> Result<(), EngineError> {
    for step in 0..=4 {
        let progress = step as f64 / 4.0;
        let eased = progress * progress * (3.0 - 2.0 * progress);
        let current_x = from_x + (x - from_x) * eased;
        let current_y = from_y + (y - from_y) * eased;
        session
            .cdp
            .dispatch_mouse("mouseMoved", current_x, current_y, "none", 0)
            .await?;
        if step < 4 {
            tokio::time::sleep(Duration::from_millis(18)).await;
        }
    }
    session
        .cdp
        .dispatch_mouse("mousePressed", x, y, "left", 1)
        .await?;
    session
        .cdp
        .dispatch_mouse("mouseReleased", x, y, "left", 1)
        .await
        .map(|_| ())
}

async fn execute_facebook_follow(
    session: &mut EngineSession,
    params: &crate::command::FollowParams,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    if !probe_facebook_reel(session).await?.is_reels_surface() {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "follow",
            false,
            "capability_unsupported",
            params.note_id.clone(),
            None,
        ));
    }
    let Some(expected_note_id) = params.note_id.as_deref() else {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "follow",
            false,
            "target_not_found",
            None,
            None,
        ));
    };
    let before = probe_facebook_follow(session, Some(expected_note_id)).await?;
    if !before.ok || before.author.as_deref().is_none_or(str::is_empty) {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "follow",
            false,
            before
                .reason
                .as_deref()
                .unwrap_or("follow_author_not_found"),
            before.note_id,
            None,
        ));
    }
    if before.already {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "follow",
            true,
            "already_following",
            before.note_id,
            None,
        ));
    }
    let fresh = probe_facebook_follow(session, Some(expected_note_id)).await?;
    if !fresh.ok || fresh.author.as_deref().is_none_or(str::is_empty) {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "follow",
            false,
            fresh.reason.as_deref().unwrap_or("follow_author_not_found"),
            fresh.note_id.or(before.note_id),
            None,
        ));
    }
    if fresh.note_id != before.note_id
        || fresh.video_key != before.video_key
        || fresh.author != before.author
    {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "follow",
            false,
            "target_moved_before_dispatch",
            before.note_id,
            None,
        ));
    }
    if fresh.already {
        return Ok(facebook_action_result(
            EffectPhase::Confirmed,
            "follow",
            true,
            "already_following",
            fresh.note_id,
            None,
        ));
    }
    let (Some(x), Some(y)) = (fresh.cx, fresh.cy) else {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "follow",
            false,
            "follow_button_not_found",
            fresh.note_id,
            None,
        ));
    };
    dispatch_facebook_click(session, x, y).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    loop {
        let after = probe_facebook_follow(session, Some(expected_note_id)).await?;
        if after.note_id != fresh.note_id
            || after.video_key != fresh.video_key
            || after.author != fresh.author
        {
            return Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "follow",
                false,
                "verify_indeterminate",
                fresh.note_id,
                None,
            ));
        }
        if after.ok && after.already {
            return Ok(facebook_action_result(
                EffectPhase::Confirmed,
                "follow",
                true,
                "",
                after.note_id,
                None,
            ));
        }
        if !after.ok
            && matches!(
                after.reason.as_deref(),
                Some("target_not_found" | "ambiguous_target")
            )
        {
            return Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "follow",
                false,
                "verify_indeterminate",
                fresh.note_id,
                None,
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "follow",
                false,
                "follow_unconfirmed",
                fresh.note_id,
                None,
            ));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

async fn execute_facebook_comment(
    session: &mut EngineSession,
    params: &crate::command::CommentParams,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    commit_windows: &CommitWindowRequester,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let account_id = params.account_id.as_deref().unwrap_or_default();
    if account_id.len() < 5 || !account_id.chars().all(|value| value.is_ascii_digit()) {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            "identity_unknown",
            Some(params.note_id.clone()),
            None,
        ));
    }
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    let body = params.text.trim();
    if body.is_empty() {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            "comment_text_empty",
            Some(params.note_id.clone()),
            None,
        ));
    }
    let full_text = match params
        .group_chat_code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(code) => format!("{body}\n{code}"),
        None => body.to_owned(),
    };

    let mut editor = probe_facebook_comment_editor(session, &params.note_id).await?;
    for _ in 0..6 {
        if editor.ok {
            break;
        }
        if editor.reason.as_deref() == Some("target_not_found") {
            break;
        }
        session.cdp.dispatch_wheel(720.0, 440.0, 560.0).await?;
        tokio::time::sleep(Duration::from_millis(500)).await;
        editor = probe_facebook_comment_editor(session, &params.note_id).await?;
    }
    if !editor.ok {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            editor.reason.as_deref().unwrap_or("editor_not_found"),
            Some(params.note_id.clone()),
            None,
        ));
    }
    let (Some(x), Some(y)) = (editor.cx, editor.cy) else {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            "editor_not_found",
            Some(params.note_id.clone()),
            None,
        ));
    };
    dispatch_facebook_click(session, x, y).await?;
    replace_focused_text(session, &full_text).await?;
    let readback = probe_facebook_comment_editor(session, &params.note_id).await?;
    if readback
        .value
        .as_deref()
        .is_none_or(|value| normalize_facebook_text(value) != normalize_facebook_text(&full_text))
    {
        replace_focused_text(session, "").await?;
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            "marker_not_accepted",
            Some(params.note_id.clone()),
            None,
        ));
    }
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        replace_focused_text(session, "").await?;
        return Ok((EffectPhase::NotStarted, output));
    }
    enter_facebook_commit_window(command, commit_windows, deadline_unix_ms, cancellation).await?;
    let protected_editor = probe_facebook_comment_editor(session, &params.note_id).await?;
    if !protected_editor.ok
        || protected_editor.value.as_deref().is_none_or(|value| {
            normalize_facebook_text(value) != normalize_facebook_text(&full_text)
        })
    {
        replace_focused_text(session, "").await?;
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "comment",
            false,
            "target_moved_before_commit",
            Some(params.note_id.clone()),
            None,
        ));
    }
    session
        .cdp
        .dispatch_key("rawKeyDown", "Enter", "Enter", 13)
        .await?;
    session
        .cdp
        .dispatch_key("keyUp", "Enter", "Enter", 13)
        .await?;

    if params.fast_return_to_feed == Some(true) {
        tokio::time::sleep(Duration::from_millis(500)).await;
        session.cdp.navigate(FACEBOOK_HOME_URL).await?;
        session.facebook.active_list_url = FACEBOOK_HOME_URL.to_owned();
        return Ok(facebook_action_result(
            EffectPhase::Ambiguous,
            "comment",
            false,
            "verification_ambiguous",
            Some(params.note_id.clone()),
            None,
        ));
    }

    let deadline = tokio::time::Instant::now() + Duration::from_secs(9);
    loop {
        let ack =
            probe_facebook_comment_ack(session, &params.note_id, &full_text, account_id).await?;
        if ack.confirmed {
            return Ok(facebook_action_result(
                EffectPhase::Confirmed,
                "comment",
                true,
                "",
                Some(params.note_id.clone()),
                None,
            ));
        }
        if ack.rejected {
            return Ok(facebook_action_result(
                EffectPhase::Confirmed,
                "comment",
                false,
                "comment_rejected",
                Some(params.note_id.clone()),
                None,
            ));
        }
        if ack.pending {
            return Ok(facebook_action_result(
                EffectPhase::Confirmed,
                "comment",
                false,
                "pending_group_approval",
                Some(params.note_id.clone()),
                None,
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "comment",
                false,
                "verification_ambiguous",
                Some(params.note_id.clone()),
                None,
            ));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn execute_facebook_group_join(
    session: &mut EngineSession,
    params: &crate::command::GroupJoinParams,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    commit_windows: &CommitWindowRequester,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    if facebook_join_cancelled(cancellation) {
        return Err(cancelled_before_dispatch());
    }
    let readiness_deadline = tokio::time::Instant::now() + FACEBOOK_JOIN_READY_TIMEOUT;
    let before = loop {
        if facebook_join_cancelled(cancellation) {
            return Err(cancelled_before_dispatch());
        }
        let probe = probe_facebook_join(session).await?;
        if facebook_join_readiness_decisive(
            &probe,
            tokio::time::Instant::now() >= readiness_deadline,
        ) {
            break probe;
        }
        if facebook_join_sleep_or_cancel(Duration::from_millis(500), cancellation).await {
            return Err(cancelled_before_dispatch());
        }
    };
    if before.observation.login_required == Some(true) {
        return Ok(facebook_join_result(
            EffectPhase::NotStarted,
            false,
            "login_required",
            false,
            before.observation,
            None,
        ));
    }
    if before.observation.captcha_detected == Some(true) {
        return Ok(facebook_join_result(
            EffectPhase::NotStarted,
            false,
            "blocked_by_captcha",
            false,
            before.observation,
            None,
        ));
    }
    if before.joined && !before.found {
        return Ok(facebook_join_result(
            EffectPhase::Confirmed,
            false,
            "already_member",
            false,
            before.observation,
            None,
        ));
    }
    if before.pending {
        return Ok(facebook_join_result(
            EffectPhase::Confirmed,
            false,
            "pending",
            false,
            before.observation,
            None,
        ));
    }
    if before.questionnaire {
        return Ok(facebook_join_result(
            EffectPhase::NotStarted,
            false,
            "questionnaire_required",
            false,
            before.observation,
            None,
        ));
    }
    if params.click != Some(true) {
        return Ok(facebook_join_result(
            EffectPhase::Confirmed,
            false,
            "observation_only",
            false,
            before.observation,
            None,
        ));
    }
    if before.ambiguous || !before.found {
        return Ok(facebook_join_result(
            EffectPhase::NotStarted,
            false,
            "not_ready",
            false,
            before.observation,
            None,
        ));
    }
    let (Some(x), Some(y)) = (before.cx, before.cy) else {
        return Ok(facebook_join_result(
            EffectPhase::NotStarted,
            false,
            "no_button",
            false,
            before.observation,
            None,
        ));
    };
    if facebook_join_sleep_or_cancel(FACEBOOK_JOIN_HYDRATION_SETTLE, cancellation).await {
        return Err(cancelled_before_dispatch());
    }
    let _ = session
        .cdp
        .dispatch_mouse("mouseMoved", x, y, "none", 0)
        .await;
    if facebook_join_cancelled(cancellation) {
        return Err(cancelled_before_dispatch());
    }
    enter_facebook_commit_window(command, commit_windows, deadline_unix_ms, cancellation).await?;
    let click = execute_facebook_join_click(session).await?;
    if !click.clicked {
        let reason = click.reason.as_deref().unwrap_or("no_button");
        if matches!(
            reason,
            "login_required" | "blocked_by_captcha" | "blocked_by_unknown"
        ) {
            return Ok(facebook_join_result(
                EffectPhase::NotStarted,
                false,
                reason,
                false,
                before.observation,
                None,
            ));
        }
        let retryable = matches!(
            reason,
            "scope_unresolved" | "no_target_in_scope" | "ambiguous_target"
        );
        return Ok(facebook_join_result(
            EffectPhase::NotStarted,
            false,
            if retryable { "not_ready" } else { "no_button" },
            false,
            before.observation,
            None,
        ));
    }
    let initial_observation = before.observation;
    if facebook_join_sleep_or_cancel(FACEBOOK_JOIN_POST_CLICK_SETTLE, cancellation).await {
        return Ok(facebook_join_result(
            EffectPhase::Ambiguous,
            false,
            "preempted_by_task",
            true,
            initial_observation,
            None,
        ));
    }
    let verify_deadline = tokio::time::Instant::now() + FACEBOOK_JOIN_VERIFY_TIMEOUT;
    loop {
        let after = probe_facebook_join(session).await?;
        let structural_transition = initial_observation.composer_present != Some(true)
            && after.observation.composer_present == Some(true)
            && after.observation.join_cta_present != Some(true)
            && after.observation.document_ready.as_deref() != Some("loading");
        match facebook_join_post_decision(
            &after,
            structural_transition,
            facebook_join_cancelled(cancellation),
        ) {
            FacebookJoinPostDecision::Login => {
                return Ok(facebook_join_result(
                    EffectPhase::Ambiguous,
                    false,
                    "login_required",
                    true,
                    initial_observation,
                    Some(after.observation),
                ));
            }
            FacebookJoinPostDecision::Captcha => {
                return Ok(facebook_join_result(
                    EffectPhase::Ambiguous,
                    false,
                    "blocked_by_captcha",
                    true,
                    initial_observation,
                    Some(after.observation),
                ));
            }
            FacebookJoinPostDecision::Pending => {
                return Ok(facebook_join_result(
                    EffectPhase::Confirmed,
                    false,
                    "pending",
                    true,
                    initial_observation,
                    Some(after.observation),
                ));
            }
            FacebookJoinPostDecision::Questionnaire => {
                return Ok(facebook_join_result(
                    EffectPhase::Confirmed,
                    false,
                    "questionnaire_required",
                    true,
                    initial_observation,
                    Some(after.observation),
                ));
            }
            FacebookJoinPostDecision::Joined => {
                return Ok(facebook_join_result(
                    EffectPhase::Confirmed,
                    true,
                    "",
                    true,
                    initial_observation,
                    Some(after.observation),
                ));
            }
            FacebookJoinPostDecision::Preempted => {
                return Ok(facebook_join_result(
                    EffectPhase::Ambiguous,
                    false,
                    "preempted_by_task",
                    true,
                    initial_observation,
                    Some(after.observation),
                ));
            }
            FacebookJoinPostDecision::Continue => {}
        }
        if tokio::time::Instant::now() >= verify_deadline {
            return Ok(facebook_join_result(
                EffectPhase::Ambiguous,
                false,
                "join_verification_ambiguous",
                true,
                initial_observation,
                Some(after.observation),
            ));
        }
        if facebook_join_sleep_or_cancel(Duration::from_millis(500), cancellation).await {
            return Ok(facebook_join_result(
                EffectPhase::Ambiguous,
                false,
                "preempted_by_task",
                true,
                initial_observation,
                Some(after.observation),
            ));
        }
    }
}

fn facebook_join_readiness_decisive(
    probe: &facebook::FacebookJoinProbe,
    deadline_reached: bool,
) -> bool {
    probe.observation.login_required == Some(true)
        || probe.observation.captcha_detected == Some(true)
        || probe.joined
        || probe.pending
        || probe.questionnaire
        || probe.ambiguous
        || (probe.found && probe.observation.document_ready.as_deref() != Some("loading"))
        || deadline_reached
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FacebookJoinPostDecision {
    Login,
    Captcha,
    Pending,
    Questionnaire,
    Joined,
    Preempted,
    Continue,
}

fn facebook_join_post_decision(
    probe: &facebook::FacebookJoinProbe,
    structural_transition: bool,
    cancelled: bool,
) -> FacebookJoinPostDecision {
    if probe.observation.login_required == Some(true) {
        FacebookJoinPostDecision::Login
    } else if probe.observation.captcha_detected == Some(true) {
        FacebookJoinPostDecision::Captcha
    } else if probe.pending {
        FacebookJoinPostDecision::Pending
    } else if probe.questionnaire {
        FacebookJoinPostDecision::Questionnaire
    } else if probe.joined || structural_transition {
        FacebookJoinPostDecision::Joined
    } else if cancelled {
        FacebookJoinPostDecision::Preempted
    } else {
        FacebookJoinPostDecision::Continue
    }
}

fn facebook_join_cancelled(cancellation: Option<&AtomicBool>) -> bool {
    cancellation.is_some_and(|value| value.load(Ordering::Acquire))
}

async fn facebook_join_sleep_or_cancel(
    duration: Duration,
    cancellation: Option<&AtomicBool>,
) -> bool {
    let Some(cancellation) = cancellation else {
        tokio::time::sleep(duration).await;
        return false;
    };
    if cancellation.load(Ordering::Acquire) {
        return true;
    }
    tokio::select! {
        _ = tokio::time::sleep(duration) => false,
        _ = wait_for_cancellation(cancellation) => true,
    }
}

async fn execute_facebook_publish_entry(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let NativeCommand::PublishNavigateEntry(params) = command else {
        unreachable!("publish entry handler requires publish navigate command");
    };
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    let target = probe_facebook_publish_entry(session).await?;
    if !target.ok {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "navigate_entry",
            false,
            false,
            target
                .reason
                .as_deref()
                .unwrap_or("composer_entry_not_found"),
        ));
    }
    let (Some(x), Some(y)) = (target.cx, target.cy) else {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "navigate_entry",
            false,
            false,
            "composer_entry_not_found",
        ));
    };
    dispatch_facebook_click(session, x, y).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        let editor = probe_facebook_publish_editor(session).await?;
        if editor.ok {
            return Ok(facebook_publish_result(
                EffectPhase::Confirmed,
                params.record_id,
                params.seq,
                "navigate_entry",
                true,
                true,
                "",
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(facebook_publish_result(
                EffectPhase::Ambiguous,
                params.record_id,
                params.seq,
                "navigate_entry",
                false,
                true,
                "composer_unconfirmed",
            ));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

async fn execute_facebook_publish_fill(
    session: &mut EngineSession,
    params: &crate::command::PublishFieldParams,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if params.field_type == "title" {
        return Ok(facebook_publish_result(
            EffectPhase::Confirmed,
            params.record_id,
            params.seq,
            "fill_field",
            true,
            false,
            "",
        ));
    }
    let value = params.value.trim();
    if value.is_empty() {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "fill_field",
            false,
            false,
            "empty_content",
        ));
    }
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    let editor = probe_facebook_publish_editor(session).await?;
    if !editor.ok {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "fill_field",
            false,
            false,
            editor
                .reason
                .as_deref()
                .unwrap_or("composer_editor_not_found"),
        ));
    }
    let (Some(x), Some(y)) = (editor.cx, editor.cy) else {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "fill_field",
            false,
            false,
            "composer_editor_not_found",
        ));
    };
    dispatch_facebook_click(session, x, y).await?;
    replace_focused_text(session, value).await?;
    let readback = probe_facebook_publish_editor(session).await?;
    if readback
        .value
        .as_deref()
        .is_none_or(|readback| normalize_facebook_text(readback) != normalize_facebook_text(value))
    {
        replace_focused_text(session, "").await?;
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "fill_field",
            false,
            false,
            "composer_readback_mismatch",
        ));
    }
    Ok(facebook_publish_result(
        EffectPhase::Confirmed,
        params.record_id,
        params.seq,
        "fill_field",
        true,
        true,
        "",
    ))
}

async fn execute_facebook_publish_submit(
    session: &mut EngineSession,
    params: &crate::command::PublishIdentity,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    commit_windows: &CommitWindowRequester,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    let target = probe_facebook_publish_submit(session).await?;
    if !target.ok {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "submit",
            false,
            false,
            target.reason.as_deref().unwrap_or("submit_not_found"),
        ));
    }
    if target.cx.is_none() || target.cy.is_none() {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "submit",
            false,
            false,
            "submit_not_found",
        ));
    }
    enter_facebook_commit_window(command, commit_windows, deadline_unix_ms, cancellation).await?;
    let protected_target = probe_facebook_publish_submit(session).await?;
    let (Some(x), Some(y)) = (protected_target.cx, protected_target.cy) else {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "submit",
            false,
            false,
            "target_moved_before_commit",
        ));
    };
    if !protected_target.ok {
        return Ok(facebook_publish_result(
            EffectPhase::NotStarted,
            params.record_id,
            params.seq,
            "submit",
            false,
            false,
            protected_target
                .reason
                .as_deref()
                .unwrap_or("target_moved_before_commit"),
        ));
    }
    dispatch_facebook_click(session, x, y).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        let after = probe_facebook_publish_submit(session).await?;
        if !after.composer_open {
            return Ok(facebook_publish_result(
                EffectPhase::Confirmed,
                params.record_id,
                params.seq,
                "submit",
                true,
                true,
                "",
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(facebook_publish_result(
                EffectPhase::Ambiguous,
                params.record_id,
                params.seq,
                "submit",
                false,
                true,
                "submit_verification_ambiguous",
            ));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

async fn execute_facebook_initial_feed(
    session: &mut EngineSession,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    session.cdp.navigate(FACEBOOK_HOME_URL).await?;
    session.facebook.active_list_url = FACEBOOK_HOME_URL.to_owned();
    session.facebook.seen_post_ids.clear();
    wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    let command = NativeCommand::BrowseScroll(crate::command::ReasonParams {
        reason: Some("initial_scan".to_owned()),
    });
    if let Some(output) = ensure_facebook_action_gate(session, &command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }

    let mut last = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_NAV).await?;
    for round in 0..FACEBOOK_FEED_SCROLL_ROUNDS {
        if !last.cards.is_empty() {
            let cards = facebook_page_cards(session, last, false, None);
            return Ok((EffectPhase::Confirmed, CommandOutput::PageCards(cards)));
        }
        if round + 1 >= FACEBOOK_FEED_SCROLL_ROUNDS || last.explicit_empty {
            break;
        }
        dispatch_facebook_feed_wheel(session, &last).await?;
        last = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_IN_PLACE).await?;
    }

    if last.article_count > 0 {
        let cards = facebook_page_cards(session, last, false, None);
        return Ok((EffectPhase::Confirmed, CommandOutput::PageCards(cards)));
    }
    if confirm_facebook_home_empty(session, &last).await? {
        let cards = facebook_page_cards(session, last, false, None);
        return Ok((EffectPhase::Confirmed, CommandOutput::PageCards(cards)));
    }
    let reason = if last.loading {
        "feed_still_loading"
    } else {
        "no_target"
    };
    Ok(facebook_scroll_failure(EffectPhase::NotStarted, reason))
}

async fn execute_facebook_search(
    session: &mut EngineSession,
    params: &crate::command::SearchExecuteParams,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let container = params
        .container
        .as_deref()
        .expect("search handler requires a validated container");
    let url = validated_facebook_search_url(container, &params.keyword)?;
    session.cdp.navigate(url.as_str()).await?;
    session.facebook.active_list_url = url.to_string();
    session.facebook.seen_post_ids.clear();
    wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }

    let mut last = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_NAV).await?;
    for round in 0..FACEBOOK_FEED_SCROLL_ROUNDS {
        if !last.cards.is_empty() {
            let mut cards = facebook_page_cards(session, last, false, None);
            if let Some(max_results) = params.max_results.filter(|value| *value > 0) {
                cards.cards.truncate(max_results as usize);
            }
            return Ok((EffectPhase::Confirmed, CommandOutput::PageCards(cards)));
        }
        if last.article_count == 0 && !last.loading {
            let cards = facebook_page_cards(session, last, false, None);
            return Ok((EffectPhase::Confirmed, CommandOutput::PageCards(cards)));
        }
        if round + 1 >= FACEBOOK_FEED_SCROLL_ROUNDS {
            break;
        }
        dispatch_facebook_feed_wheel(session, &last).await?;
        last = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_IN_PLACE).await?;
    }

    Ok(facebook_action_result(
        EffectPhase::Confirmed,
        "search",
        false,
        if last.loading {
            "feed_still_loading"
        } else {
            "search_unavailable"
        },
        None,
        None,
    ))
}

async fn execute_facebook_feed_scroll(
    session: &mut EngineSession,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    ensure_facebook_active_list(session).await?;
    let command = NativeCommand::PageScroll(crate::command::PageScrollParams {
        reason: None,
        dwell_ms: None,
    });
    if let Some(output) = ensure_facebook_action_gate(session, &command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    let mut current = probe_facebook_feed(session).await?;
    let start_y = current.scroll_y;
    let mut saw_any_card = !current.cards.is_empty();
    let mut bottom_dry_rounds = 0usize;

    for _ in 0..FACEBOOK_FEED_SCROLL_ROUNDS {
        let before = current;
        dispatch_facebook_feed_wheel(session, &before).await?;
        let after = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_IN_PLACE).await?;
        saw_any_card |= !after.cards.is_empty();
        let movement = PageMovement {
            before: start_y,
            after: after.scroll_y,
            moved: after.scroll_y != start_y,
            at_bottom: Some(facebook_near_bottom(&after)),
        };
        let fresh = facebook_page_cards(session, after.clone(), true, Some(movement));
        if !fresh.cards.is_empty() {
            return Ok((EffectPhase::Confirmed, CommandOutput::PageCards(fresh)));
        }

        let grew = after.scroll_height > before.scroll_height + 1.0;
        if !grew && facebook_near_bottom(&after) {
            bottom_dry_rounds += 1;
            if bottom_dry_rounds >= 2 {
                return Ok(facebook_scroll_failure(
                    EffectPhase::Confirmed,
                    "feed_exhausted",
                ));
            }
        } else {
            bottom_dry_rounds = 0;
        }
        current = after;
    }

    Ok(facebook_scroll_failure(
        EffectPhase::Confirmed,
        if saw_any_card {
            "feed_exhausted"
        } else if current.loading {
            "feed_still_loading"
        } else {
            "no_target"
        },
    ))
}

async fn execute_facebook_back_to_list(
    session: &mut EngineSession,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let target = session.facebook.active_list_url.clone();
    let current = probe_facebook_feed(session).await?;
    if current.url != target || !matches!(current.surface.as_str(), "home" | "search" | "group") {
        session.cdp.navigate(&target).await?;
        wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    }
    let command = NativeCommand::NavigationBack(crate::command::NavigationBackParams {
        reason: None,
        target_page: None,
        dwell_ms: None,
    });
    if let Some(output) = ensure_facebook_action_gate(session, &command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    let probe = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_NAV).await?;
    if probe.cards.is_empty() {
        return Ok(facebook_scroll_failure(
            EffectPhase::NotStarted,
            if probe.loading {
                "feed_still_loading"
            } else {
                "no_feed"
            },
        ));
    }
    let cards = facebook_page_cards(session, probe, false, None);
    Ok((EffectPhase::Confirmed, CommandOutput::PageCards(cards)))
}

async fn execute_facebook_feed_refresh(
    session: &mut EngineSession,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if session.facebook.active_list_url != FACEBOOK_HOME_URL {
        session.cdp.navigate(FACEBOOK_HOME_URL).await?;
        session.facebook.active_list_url = FACEBOOK_HOME_URL.to_owned();
        wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    }
    let command = NativeCommand::FeedRefresh(crate::command::FeedRefreshParams {
        reason: None,
        think_ms: None,
    });
    if let Some(output) = ensure_facebook_action_gate(session, &command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }
    let before = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_IN_PLACE).await?;
    let before_top = before
        .cards
        .first()
        .and_then(|card| card.note_id.as_deref())
        .and_then(canonical_facebook_post_id);

    let target = probe_facebook_home_target(session).await?;
    let clicked = if target.ok {
        if let (Some(x), Some(y)) = (target.cx, target.cy) {
            dispatch_facebook_click(session, x, y).await?;
            true
        } else {
            false
        }
    } else {
        false
    };
    if !clicked {
        let now = unix_time_ms();
        if session.facebook.last_refresh_reload_at_ms != 0
            && now.saturating_sub(session.facebook.last_refresh_reload_at_ms)
                < FACEBOOK_REFRESH_RELOAD_FLOOR_MS
        {
            return Ok(facebook_scroll_failure(
                EffectPhase::NotStarted,
                target.reason.as_deref().unwrap_or("no_home_link"),
            ));
        }
        session.facebook.last_refresh_reload_at_ms = now;
        session.cdp.reload().await?;
    }
    wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    let after = settle_facebook_feed(session, FACEBOOK_FEED_SETTLE_IN_PLACE).await?;
    let after_top = after
        .cards
        .first()
        .and_then(|card| card.note_id.as_deref())
        .and_then(canonical_facebook_post_id);
    if after.cards.is_empty() || after_top.is_none() || after_top == before_top {
        return Ok(facebook_scroll_failure(
            if clicked {
                EffectPhase::Confirmed
            } else {
                EffectPhase::Ambiguous
            },
            if after.loading {
                "feed_still_loading"
            } else {
                "not_refreshed"
            },
        ));
    }
    session.facebook.seen_post_ids.clear();
    let cards = facebook_page_cards(session, after, false, None);
    Ok((EffectPhase::Confirmed, CommandOutput::PageCards(cards)))
}

async fn ensure_facebook_active_list(session: &mut EngineSession) -> Result<(), EngineError> {
    let probe = probe_facebook_feed(session).await?;
    let on_list = matches!(probe.surface.as_str(), "home" | "search" | "group");
    if !on_list || probe.url != session.facebook.active_list_url {
        let target = session.facebook.active_list_url.clone();
        session.cdp.navigate(&target).await?;
        wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    }
    Ok(())
}

async fn settle_facebook_feed(
    session: &mut EngineSession,
    timeout: Duration,
) -> Result<facebook::FacebookFeedProbe, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut previous: Option<(Vec<String>, u32, bool)> = None;
    loop {
        let current = probe_facebook_feed(session).await?;
        let key = (
            current
                .cards
                .iter()
                .filter_map(|card| card.note_id.clone())
                .collect::<Vec<_>>(),
            current.article_count,
            current.explicit_empty,
        );
        let stable = previous.as_ref() == Some(&key);
        if stable && !current.loading {
            return Ok(current);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(current);
        }
        previous = Some(key);
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn confirm_facebook_home_empty(
    session: &mut EngineSession,
    initial: &facebook::FacebookFeedProbe,
) -> Result<bool, EngineError> {
    if initial.surface != "home" || initial.article_count > 0 || initial.loading {
        return Ok(false);
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let generation = (
        initial.url.clone(),
        initial.document_generation.clone().unwrap_or_default(),
    );
    let mut stable = 0usize;
    loop {
        let current = probe_facebook_feed(session).await?;
        let current_generation = (
            current.url.clone(),
            current.document_generation.clone().unwrap_or_default(),
        );
        if current.surface != "home"
            || !current.cards.is_empty()
            || current.article_count > 0
            || current.loading
            || !current.explicit_empty
            || current.document_age_ms < 8_000
            || current_generation != generation
        {
            stable = 0;
        } else {
            stable += 1;
            if stable >= 3 {
                let final_probe = probe_facebook_feed(session).await?;
                return Ok(final_probe.surface == "home"
                    && final_probe.cards.is_empty()
                    && final_probe.article_count == 0
                    && !final_probe.loading
                    && final_probe.explicit_empty
                    && final_probe.document_age_ms >= 8_000
                    && (
                        final_probe.url,
                        final_probe.document_generation.unwrap_or_default(),
                    ) == generation);
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn probe_facebook_feed(
    session: &mut EngineSession,
) -> Result<facebook::FacebookFeedProbe, EngineError> {
    let expression = facebook::feed_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::feed_probe_from_cdp(&raw)
}

async fn probe_facebook_home_target(
    session: &mut EngineSession,
) -> Result<facebook::FacebookPointTarget, EngineError> {
    let expression = facebook::feed_home_target_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::point_target_from_cdp(&raw)
}

async fn dispatch_facebook_feed_wheel(
    session: &mut EngineSession,
    probe: &facebook::FacebookFeedProbe,
) -> Result<(), EngineError> {
    let x = (probe.inner_width / 2.0).max(1.0);
    let y = (probe.inner_height * 0.55).max(1.0);
    let delta_y = 560.0 + (unix_time_ms() % 151) as f64;
    session.cdp.dispatch_wheel(x, y, delta_y).await.map(|_| ())
}

async fn dispatch_facebook_click(
    session: &mut EngineSession,
    x: f64,
    y: f64,
) -> Result<(), EngineError> {
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
        .await
        .map(|_| ())
}

fn facebook_page_cards(
    session: &mut EngineSession,
    probe: facebook::FacebookFeedProbe,
    only_new: bool,
    movement: Option<PageMovement>,
) -> PageCards {
    let mut cards = Vec::new();
    for mut card in probe.cards {
        let Some(identity) = card.note_id.as_deref().and_then(canonical_facebook_post_id) else {
            continue;
        };
        let is_new = session.facebook.seen_post_ids.insert(identity);
        if only_new && !is_new {
            continue;
        }
        card.index = cards.len() as u32;
        cards.push(card);
    }
    PageCards {
        cards,
        movement,
        document_generation: probe.document_generation,
        container_name: None,
        list_kind: Some(probe.list_kind),
        list_state: Some(
            if probe.list_state == crate::model::FacebookListState::Ready {
                crate::model::FacebookListState::Ready
            } else {
                probe.list_state
            },
        ),
    }
    .bounded()
}

fn facebook_near_bottom(probe: &facebook::FacebookFeedProbe) -> bool {
    probe.scroll_height > 0.0
        && probe.inner_height > 0.0
        && probe.scroll_height - probe.scroll_y - probe.inner_height <= probe.inner_height.max(1.0)
}

async fn probe_facebook_like(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookLikeProbe, EngineError> {
    let expression = facebook::like_probe_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::like_probe_from_cdp(&raw)
}

async fn commit_facebook_reel_like(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookLikeCommit, EngineError> {
    let expression = facebook::like_primary_commit_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::like_commit_from_cdp(&raw)
}

async fn probe_facebook_like_picker(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookPointTarget, EngineError> {
    let expression = facebook::like_picker_probe_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::point_target_from_cdp(&raw)
}

enum FacebookReelLikeVerification {
    Selected,
    Unchanged,
    Indeterminate,
}

async fn wait_for_facebook_reel_like(
    session: &mut EngineSession,
    note_id: &str,
    timeout: Duration,
) -> Result<FacebookReelLikeVerification, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let expression = facebook::like_verify_expression(note_id)?;
        let raw = session.cdp.evaluate(&expression, true).await?;
        let probe = facebook::like_verify_from_cdp(&raw)?;
        if !probe.ok {
            return Ok(FacebookReelLikeVerification::Indeterminate);
        }
        if probe.selected {
            return Ok(FacebookReelLikeVerification::Selected);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(FacebookReelLikeVerification::Unchanged);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn wait_for_facebook_like(
    session: &mut EngineSession,
    note_id: &str,
    timeout: Duration,
) -> Result<bool, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let probe = probe_facebook_like(session, note_id).await?;
        if probe.ok && probe.already {
            return Ok(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn probe_facebook_follow(
    session: &mut EngineSession,
    note_id: Option<&str>,
) -> Result<facebook::FacebookFollowProbe, EngineError> {
    let expression = facebook::follow_probe_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::follow_probe_from_cdp(&raw)
}

async fn probe_facebook_comment_editor(
    session: &mut EngineSession,
    note_id: &str,
) -> Result<facebook::FacebookTextTarget, EngineError> {
    let expression = facebook::comment_editor_probe_expression(note_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::text_target_from_cdp(&raw)
}

async fn probe_facebook_comment_ack(
    session: &mut EngineSession,
    note_id: &str,
    text: &str,
    account_id: &str,
) -> Result<facebook::FacebookCommentAckProbe, EngineError> {
    let expression = facebook::comment_ack_probe_expression(note_id, text, account_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::comment_ack_probe_from_cdp(&raw)
}

async fn probe_facebook_join(
    session: &mut EngineSession,
) -> Result<facebook::FacebookJoinProbe, EngineError> {
    let expression = facebook::join_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::join_probe_from_cdp(&raw)
}

async fn execute_facebook_join_click(
    session: &mut EngineSession,
) -> Result<facebook::FacebookJoinClickResult, EngineError> {
    let expression = facebook::join_click_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::join_click_from_cdp(&raw)
}

async fn probe_facebook_publish_entry(
    session: &mut EngineSession,
) -> Result<facebook::FacebookPointTarget, EngineError> {
    let expression = facebook::publish_entry_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::point_target_from_cdp(&raw)
}

async fn probe_facebook_publish_editor(
    session: &mut EngineSession,
) -> Result<facebook::FacebookTextTarget, EngineError> {
    let expression = facebook::publish_editor_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::text_target_from_cdp(&raw)
}

async fn probe_facebook_publish_submit(
    session: &mut EngineSession,
) -> Result<facebook::FacebookPublishSubmitProbe, EngineError> {
    let expression = facebook::publish_submit_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::publish_submit_probe_from_cdp(&raw)
}

async fn replace_focused_text(session: &mut EngineSession, value: &str) -> Result<(), EngineError> {
    let modifier = if cfg!(target_os = "macos") { 4 } else { 2 };
    session
        .cdp
        .dispatch_key_with_modifiers("keyDown", "a", "KeyA", 65, modifier)
        .await?;
    session
        .cdp
        .dispatch_key_with_modifiers("keyUp", "a", "KeyA", 65, modifier)
        .await?;
    session
        .cdp
        .dispatch_key("keyDown", "Backspace", "Backspace", 8)
        .await?;
    session
        .cdp
        .dispatch_key("keyUp", "Backspace", "Backspace", 8)
        .await?;
    if !value.is_empty() {
        session.cdp.insert_text(value).await?;
    }
    Ok(())
}

fn normalize_facebook_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn facebook_action_result(
    phase: EffectPhase,
    action: &str,
    ok: bool,
    reason: &str,
    note_id: Option<String>,
    observation: Option<crate::model::ActionEvidence>,
) -> (EffectPhase, CommandOutput) {
    (
        phase,
        CommandOutput::ActionReceipt(Box::new(ActionReceipt {
            action: action.to_owned(),
            ok,
            reason: (!reason.is_empty()).then(|| reason.to_owned()),
            note_id,
            observation,
            post_observation: None,
            group_observation: None,
            group_url: None,
            clicked: None,
            candidates: Vec::new(),
        })),
    )
}

fn facebook_join_result(
    phase: EffectPhase,
    ok: bool,
    reason: &str,
    clicked: bool,
    observation: crate::model::FacebookGroupJoinObservation,
    post_observation: Option<crate::model::FacebookGroupJoinObservation>,
) -> (EffectPhase, CommandOutput) {
    let group_url = observation.group_url.clone();
    (
        phase,
        CommandOutput::ActionReceipt(Box::new(ActionReceipt {
            action: "join_group".to_owned(),
            ok,
            reason: (!reason.is_empty()).then(|| reason.to_owned()),
            note_id: None,
            observation: None,
            post_observation,
            group_observation: Some(observation),
            group_url,
            clicked: Some(clicked),
            candidates: Vec::new(),
        })),
    )
}

fn facebook_publish_result(
    phase: EffectPhase,
    record_id: u64,
    seq: u32,
    kind: &str,
    ok: bool,
    dispatched: bool,
    error: &str,
) -> (EffectPhase, CommandOutput) {
    (
        phase,
        CommandOutput::PublishReceipt(
            PublishReceipt {
                record_id,
                seq,
                kind: kind.to_owned(),
                ok,
                submit_dispatched: (kind == "submit").then_some(dispatched),
                value: None,
                post_url: None,
                error: (!error.is_empty()).then(|| error.to_owned()),
            }
            .bounded(),
        ),
    )
}

async fn enter_facebook_commit_window(
    command: &NativeCommand,
    requester: &CommitWindowRequester,
    deadline_unix_ms: u64,
    cancellation: Option<&AtomicBool>,
) -> Result<(), EngineError> {
    let contract = facebook::capability::parity(command)
        .and_then(|entry| entry.commit_window)
        .ok_or_else(|| {
            EngineError::new(
                ErrorCode::EngineInternal,
                "native Facebook irreversible write has no commit window contract",
            )
        })?;
    requester
        .enter(
            contract.label,
            contract.budget_ms,
            deadline_unix_ms,
            cancellation,
        )
        .await
}

async fn ensure_facebook_action_gate(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<Option<CommandOutput>, EngineError> {
    let probe = probe_facebook_page(session).await?;
    let reason = match probe.blocking_kind.as_deref() {
        Some("login") => Some("login_required"),
        Some("captcha") => Some("blocked_by_captcha"),
        Some("unknown") => Some("blocked_by_unknown"),
        _ => None,
    };
    if let Some(reason) = reason {
        return facebook_gate_failure(session, command, reason).map(Some);
    }

    for _ in 0..3 {
        let consent = probe_facebook_consent(session).await?;
        if !consent.present {
            return Ok(None);
        }
        let necessary_only = matches!(
            std::env::var("AIDCP_FB_COOKIE_CONSENT")
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
                .as_str(),
            "necessary_only" | "necessary" | "essential"
        );
        let point = if necessary_only {
            if consent.necessary_only_ambiguous {
                None
            } else {
                consent.necessary_only
            }
        } else if consent.accept_all_ambiguous {
            None
        } else {
            consent.accept_all
        };
        let Some(point) = point else {
            return facebook_gate_failure(session, command, "blocked_by_consent").map(Some);
        };
        dispatch_facebook_click(session, point.cx, point.cy).await?;
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
    if probe_facebook_consent(session).await?.present {
        return facebook_gate_failure(session, command, "blocked_by_consent").map(Some);
    }
    Ok(None)
}

async fn probe_facebook_page(session: &mut EngineSession) -> Result<ProbeResult, EngineError> {
    let expression = facebook::page_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = facebook::result_from_cdp(&raw)?;
    let command = NativeCommand::PageProbe(crate::command::EmptyParams::default());
    let output = facebook::typed_output(&command, result.output, session.cdp.target_id())?;
    let CommandOutput::PageProbe(probe) = output else {
        return Err(EngineError::new(
            ErrorCode::ProbeFailed,
            "native Facebook blocker probe returned an invalid output",
        ));
    };
    Ok(probe)
}

async fn probe_facebook_consent(
    session: &mut EngineSession,
) -> Result<facebook::FacebookConsentProbe, EngineError> {
    let expression = facebook::consent_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::consent_probe_from_cdp(&raw)
}

fn facebook_gate_failure(
    session: &EngineSession,
    command: &NativeCommand,
    reason: &str,
) -> Result<CommandOutput, EngineError> {
    facebook::failure_output(
        command,
        facebook_action_name(command),
        reason,
        session.cdp.target_id(),
    )
}

fn facebook_command_requires_gate(command: &NativeCommand) -> bool {
    !matches!(
        command,
        NativeCommand::PageProbe(_)
            | NativeCommand::SessionStop(_)
            | NativeCommand::IdentityBootstrap(_)
            | NativeCommand::IdentityReadCurrent(_)
            | NativeCommand::CaptchaCapture(_)
            | NativeCommand::CaptchaClick(_)
    )
}

fn facebook_action_name(command: &NativeCommand) -> &'static str {
    match command {
        NativeCommand::BrowseNext(_)
        | NativeCommand::BrowseScroll(_)
        | NativeCommand::PageScroll(_) => "scroll",
        NativeCommand::FeedRefresh(_) => "refresh",
        NativeCommand::SearchExecute(_) => "search",
        NativeCommand::NoteOpen(_) => "open_note",
        NativeCommand::NoteClose(_) => "close",
        NativeCommand::NavigationBack(_) => "back",
        NativeCommand::InteractionLike(_) => "like",
        NativeCommand::InteractionFollow(_) => "follow",
        NativeCommand::InteractionComment(_) => "comment",
        NativeCommand::GroupJoin(_) => "join_group",
        NativeCommand::PublishNavigateEntry(_) => "navigate_entry",
        NativeCommand::PublishSelectMode(_) => "select_mode",
        NativeCommand::PublishUploadImage(_) => "upload_image",
        NativeCommand::PublishSetCover(_) => "set_cover",
        NativeCommand::PublishFillField(_) => "fill_field",
        NativeCommand::PublishAddWithCandidate(_) => "add_with_candidate",
        NativeCommand::PublishSetOption(_) => "set_option",
        NativeCommand::PublishSetSchedule(_) => "set_schedule",
        NativeCommand::PublishSubmit(_) => "submit",
        NativeCommand::PublishCapturePostId(_) => "capture_post_id",
        NativeCommand::PublishCaptureScheduled(_) => "capture_scheduled",
        NativeCommand::PublishReconcileScheduled(_) => "reconcile_scheduled",
        _ => "page",
    }
}

async fn execute_facebook_page_scroll(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let before = probe_facebook_reel(session).await?;
    if !before.is_reels_surface() {
        return execute_facebook_feed_scroll(session).await;
    }
    if !before.ok || before.note_id.is_none() || before.video_key.is_none() {
        return Ok(facebook_scroll_failure(
            EffectPhase::NotStarted,
            "no_target",
        ));
    }

    session
        .cdp
        .dispatch_key("rawKeyDown", "ArrowDown", "ArrowDown", 40)
        .await?;
    session
        .cdp
        .dispatch_key("keyUp", "ArrowDown", "ArrowDown", 40)
        .await?;
    if wait_for_facebook_reel_movement(session, &before)
        .await?
        .is_some()
    {
        return read_facebook_reel_cards(session, command).await;
    }

    let before_wheel = probe_facebook_reel(session).await?;
    if before_wheel.moved_from(&before) {
        return read_facebook_reel_cards(session, command).await;
    }
    let Some(rect) = before_wheel.video_rect.as_ref().filter(|_| before_wheel.ok) else {
        return Ok(facebook_scroll_failure(EffectPhase::Confirmed, "no_target"));
    };
    let delta_y = 70.0 + (unix_time_ms() % 31) as f64;
    session
        .cdp
        .dispatch_wheel(
            (rect.left + rect.right) / 2.0,
            (rect.top + rect.bottom) / 2.0,
            delta_y,
        )
        .await?;
    if wait_for_facebook_reel_movement(session, &before)
        .await?
        .is_some()
    {
        return read_facebook_reel_cards(session, command).await;
    }

    let target = probe_facebook_reel_next_target(session).await?;
    if reel_identity_moved(
        target.note_id.as_deref(),
        target.video_key.as_deref(),
        &before,
    ) {
        return read_facebook_reel_cards(session, command).await;
    }
    if !target.ok || !target.found || target.ambiguous {
        return Ok(facebook_scroll_failure(EffectPhase::Confirmed, "no_target"));
    }
    if target.note_id != before.note_id || target.video_key != before.video_key {
        return Ok(facebook_scroll_failure(EffectPhase::Confirmed, "no_target"));
    }
    let (Some(x), Some(y)) = (target.cx, target.cy) else {
        return Ok(facebook_scroll_failure(EffectPhase::Confirmed, "no_target"));
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
    if wait_for_facebook_reel_movement(session, &before)
        .await?
        .is_some()
    {
        return read_facebook_reel_cards(session, command).await;
    }

    Ok(facebook_scroll_failure(EffectPhase::Confirmed, "no_target"))
}

async fn probe_facebook_reel(
    session: &mut EngineSession,
) -> Result<facebook::FacebookReelProbe, EngineError> {
    let expression = facebook::reel_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::reel_probe_from_cdp(&raw)
}

async fn probe_facebook_reel_next_target(
    session: &mut EngineSession,
) -> Result<facebook::FacebookReelNextTarget, EngineError> {
    let expression = facebook::reel_next_target_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::reel_next_target_from_cdp(&raw)
}

async fn wait_for_facebook_reel_movement(
    session: &mut EngineSession,
    previous: &facebook::FacebookReelProbe,
) -> Result<Option<facebook::FacebookReelProbe>, EngineError> {
    let mut video_moved = None;
    for round in 0..6 {
        let current = probe_facebook_reel(session).await?;
        if current.moved_from(previous) {
            if current.note_id != previous.note_id {
                return Ok(Some(current));
            }
            video_moved = Some(current);
        }
        if round < 5 {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
    Ok(video_moved)
}

async fn read_facebook_reel_cards(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let expression = facebook::reel_cards_expression()?;
        let raw = session.cdp.evaluate(&expression, true).await?;
        let result = facebook::result_from_cdp(&raw)?;
        let output = facebook::typed_output(command, result.output, session.cdp.target_id())?;
        if matches!(&output, CommandOutput::PageCards(cards) if !cards.cards.is_empty()) {
            return Ok((EffectPhase::Confirmed, output));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(facebook_scroll_failure(EffectPhase::Confirmed, "no_target"));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn reel_identity_moved(
    note_id: Option<&str>,
    video_key: Option<&str>,
    previous: &facebook::FacebookReelProbe,
) -> bool {
    note_id.is_some()
        && video_key.is_some()
        && (note_id != previous.note_id.as_deref() || video_key != previous.video_key.as_deref())
}

fn facebook_scroll_failure(phase: EffectPhase, reason: &str) -> (EffectPhase, CommandOutput) {
    (
        phase,
        CommandOutput::ActionReceipt(Box::new(ActionReceipt {
            action: "scroll".to_owned(),
            ok: false,
            reason: Some(reason.to_owned()),
            note_id: None,
            observation: None,
            post_observation: None,
            group_observation: None,
            group_url: None,
            clicked: None,
            candidates: Vec::new(),
        })),
    )
}

async fn execute_facebook_identity(
    session: &mut EngineSession,
    allow_navigate: bool,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let location = session
        .cdp
        .evaluate("location.href", true)
        .await?
        .pointer("/result/value")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if allow_navigate
        && !location.starts_with("https://www.facebook.com/")
        && !location.starts_with("https://facebook.com/")
    {
        session.cdp.navigate("https://www.facebook.com/").await?;
        wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    }
    session.cdp.enable_network().await?;
    let cookies = session.cdp.all_cookies().await?;
    let cookie_user_id = cookies
        .get("cookies")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|cookie| cookie.get("name").and_then(serde_json::Value::as_str) == Some("c_user"))
        .filter(|cookie| {
            cookie
                .get("domain")
                .and_then(serde_json::Value::as_str)
                .map(|domain| {
                    let host = domain.trim_start_matches('.').to_ascii_lowercase();
                    host == "facebook.com" || host.ends_with(".facebook.com")
                })
                .unwrap_or(false)
        })
        .filter_map(|cookie| cookie.get("value").and_then(serde_json::Value::as_str))
        .find(|value| {
            value.len() >= 5 && value.chars().all(|character| character.is_ascii_digit())
        });
    let expression = facebook::identity_expression(cookie_user_id)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = facebook::result_from_cdp(&raw)?;
    let command = NativeCommand::IdentityBootstrap(crate::command::EmptyParams::default());
    let output = facebook::typed_output(&command, result.output, session.cdp.target_id())?;
    Ok((result.effect_phase, output))
}

fn invalid_facebook_identity_output() -> EngineError {
    EngineError::new(
        ErrorCode::CdpError,
        "native Facebook identity command returned an invalid output",
    )
}

async fn evaluate_facebook_router(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if facebook_command_requires_gate(command) {
        if let Some(output) = ensure_facebook_action_gate(session, command).await? {
            return Ok((EffectPhase::NotStarted, output));
        }
    }
    let expression = facebook::command_expression(command)?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = facebook::result_from_cdp(&raw)?;
    let output = facebook::typed_output(command, result.output, session.cdp.target_id())?;
    Ok((result.effect_phase, output))
}

async fn evaluate_facebook_router_until_cards(
    session: &mut EngineSession,
    command: &NativeCommand,
    timeout: Duration,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let latest = evaluate_facebook_router(session, command).await?;
        if matches!(&latest.1, CommandOutput::PageCards(cards) if !cards.cards.is_empty())
            || tokio::time::Instant::now() >= deadline
        {
            return Ok(latest);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn evaluate_facebook_router_until_requested_detail(
    session: &mut EngineSession,
    command: &NativeCommand,
    target_post_id: &str,
    timeout: Duration,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let latest = evaluate_facebook_router(session, command).await?;
        if matches!(
            &latest.1,
            CommandOutput::NoteDetail(detail)
                if canonical_facebook_post_id(&detail.note_id).as_deref() == Some(target_post_id)
        ) {
            return Ok(latest);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(EngineError::new(
                ErrorCode::ProbeFailed,
                "native Facebook target detail identity was not confirmed",
            ));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn wait_for_facebook_ready(
    session: &mut EngineSession,
    timeout: Duration,
) -> Result<(), EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let expression = facebook::page_probe_expression()?;
        let raw = session.cdp.evaluate(&expression, true).await?;
        let result = facebook::result_from_cdp(&raw)?;
        let ready = result
            .output
            .pointer("/value/readyState")
            .and_then(serde_json::Value::as_str);
        if matches!(ready, Some("interactive" | "complete")) {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(EngineError::new(
                ErrorCode::ProbeFailed,
                "native Facebook navigation did not reach a ready document",
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn verify_facebook_uploaded_preview(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let output = evaluate_facebook_router(session, command).await?;
        let confirmed = matches!(&output.1, CommandOutput::PublishReceipt(receipt) if receipt.ok);
        if confirmed {
            return Ok(output);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok((EffectPhase::Ambiguous, output.1));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn validated_facebook_content_url(raw: &str, expected: Option<&str>) -> Result<Url, EngineError> {
    let url = Url::parse(raw).map_err(|_| invalid_facebook_navigation_target())?;
    validate_facebook_origin(&url)?;
    let path = url.path().to_ascii_lowercase();
    let is_content = path.contains("/posts/")
        || path.contains("/videos/")
        || path.starts_with("/reel/")
        || path.contains("/permalink.php")
        || path.starts_with("/groups/")
        || url
            .query_pairs()
            .any(|(key, _)| matches!(key.as_ref(), "story_fbid" | "multi_permalinks" | "v"));
    if !is_content || expected.is_some_and(|value| value != raw && !raw.contains(value)) {
        return Err(invalid_facebook_navigation_target());
    }
    Ok(url)
}

fn canonical_facebook_post_id(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    validate_facebook_origin(&url).ok()?;
    let path = url.path().to_ascii_lowercase();
    let query_id = url
        .query_pairs()
        .find_map(|(key, value)| match key.as_ref() {
            "multi_permalinks" | "story_fbid" => Some(value.into_owned()),
            "v" if path == "/watch" || path == "/watch/" => Some(value.into_owned()),
            _ => None,
        })
        .filter(|value| !value.is_empty());
    if query_id.is_some() {
        return query_id;
    }
    let segments: Vec<_> = url
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect();
    for (index, segment) in segments.iter().enumerate() {
        if matches!(
            segment.to_ascii_lowercase().as_str(),
            "posts" | "videos" | "reel" | "permalink"
        ) {
            return segments
                .get(index + 1)
                .filter(|value| !value.is_empty())
                .map(|value| (*value).to_owned());
        }
    }
    None
}

fn is_facebook_reel_url(raw: &str) -> bool {
    Url::parse(raw)
        .ok()
        .filter(|url| validate_facebook_origin(url).is_ok())
        .is_some_and(|url| url.path().to_ascii_lowercase().starts_with("/reel/"))
}

fn validated_facebook_group_url(raw: &str) -> Result<Url, EngineError> {
    let url = Url::parse(raw).map_err(|_| invalid_facebook_navigation_target())?;
    validate_facebook_origin(&url)?;
    let parts: Vec<_> = url
        .path_segments()
        .map(|segments| segments.filter(|segment| !segment.is_empty()).collect())
        .unwrap_or_default();
    if parts.first() != Some(&"groups") || parts.get(1).is_none_or(|value| value.is_empty()) {
        return Err(invalid_facebook_navigation_target());
    }
    Url::parse(&format!("https://www.facebook.com/groups/{}", parts[1]))
        .map_err(|_| invalid_facebook_navigation_target())
}

fn validated_facebook_search_url(raw: &str, keyword: &str) -> Result<Url, EngineError> {
    let url = Url::parse(raw).map_err(|_| invalid_facebook_navigation_target())?;
    validate_facebook_origin(&url)?;
    let parts: Vec<_> = url
        .path_segments()
        .map(|segments| segments.filter(|segment| !segment.is_empty()).collect())
        .unwrap_or_default();
    let path = if parts.first() == Some(&"groups") {
        let group = parts
            .get(1)
            .filter(|value| !value.is_empty())
            .ok_or_else(invalid_facebook_navigation_target)?;
        format!("/groups/{group}/search/")
    } else if parts.len() == 1 {
        format!("/{}/search/", parts[0])
    } else {
        return Err(invalid_facebook_navigation_target());
    };
    let mut target =
        Url::parse("https://www.facebook.com").map_err(|_| invalid_facebook_navigation_target())?;
    target.set_path(&path);
    target.query_pairs_mut().append_pair("q", keyword);
    Ok(target)
}

fn validate_facebook_origin(url: &Url) -> Result<(), EngineError> {
    let host = url
        .host_str()
        .ok_or_else(invalid_facebook_navigation_target)?;
    if url.scheme() != "https"
        || !(host == "facebook.com" || host.ends_with(".facebook.com"))
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid_facebook_navigation_target());
    }
    Ok(())
}

fn invalid_facebook_navigation_target() -> EngineError {
    EngineError::new(
        ErrorCode::InvalidRequest,
        "native navigation target is not an allowlisted Facebook page",
    )
}

async fn execute_xhs_command_once(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    use NativeCommand::*;
    match command {
        CaptchaCapture(params) => capture_captcha(session, params).await,
        CaptchaClick(params) => click_captcha(session, params).await,
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
        SearchExecute(params) => execute_search(session, params, command).await,
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

async fn execute_search(
    session: &mut EngineSession,
    params: &crate::command::SearchExecuteParams,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let search_input_geometry = xhs::search_input_geometry_expression()?;
    let geometry = session.cdp.evaluate(&search_input_geometry, false).await?;
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
    let modifier = if cfg!(target_os = "macos") { 4 } else { 2 };
    session
        .cdp
        .dispatch_key_with_modifiers("keyDown", "a", "KeyA", 65, modifier)
        .await?;
    session
        .cdp
        .dispatch_key_with_modifiers("keyUp", "a", "KeyA", 65, modifier)
        .await?;
    session
        .cdp
        .dispatch_key("keyDown", "Backspace", "Backspace", 8)
        .await?;
    session
        .cdp
        .dispatch_key("keyUp", "Backspace", "Backspace", 8)
        .await?;
    session.cdp.insert_text(&params.keyword).await?;
    let readback = session.cdp.evaluate(
        "(()=>{const e=document.activeElement;if(!e)return '';return String('value' in e?e.value:e.textContent||'')})()",
        false,
    ).await?;
    if readback
        .pointer("/result/value")
        .and_then(serde_json::Value::as_str)
        != Some(params.keyword.as_str())
    {
        return Ok(search_receipt(
            EffectPhase::NotStarted,
            "search_input_readback_mismatch",
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
        }
    }
    Ok(search_receipt(
        EffectPhase::Ambiguous,
        "search_navigation_unconfirmed",
    ))
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

async fn capture_captcha(
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

async fn click_captcha(
    session: &mut EngineSession,
    params: &crate::command::CaptchaClickParams,
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
    for point in &params.points {
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
    if let Some(text) = &params.text {
        let modifier = if cfg!(target_os = "macos") { 4 } else { 2 };
        session
            .cdp
            .dispatch_key_with_modifiers("keyDown", "a", "KeyA", 65, modifier)
            .await?;
        session
            .cdp
            .dispatch_key_with_modifiers("keyUp", "a", "KeyA", 65, modifier)
            .await?;
        session
            .cdp
            .dispatch_key("keyDown", "Backspace", "Backspace", 8)
            .await?;
        session
            .cdp
            .dispatch_key("keyUp", "Backspace", "Backspace", 8)
            .await?;
        session.cdp.insert_text(text).await?;
        let readback = session
            .cdp
            .evaluate(
                "(()=>{const e=document.activeElement;if(!e)return '';return String('value' in e?e.value:e.textContent||'')})()",
                false,
            )
            .await?;
        if readback
            .pointer("/result/value")
            .and_then(serde_json::Value::as_str)
            != Some(text)
        {
            return Ok((
                EffectPhase::Ambiguous,
                CommandOutput::ActionReceipt(Box::new(ActionReceipt {
                    action: "captcha_click".to_owned(),
                    ok: false,
                    reason: Some("text_readback_mismatch".to_owned()),
                    note_id: None,
                    observation: None,
                    post_observation: None,
                    group_observation: None,
                    group_url: None,
                    clicked: None,
                    candidates: Vec::new(),
                })),
            ));
        }
    }
    if params.submit.as_deref() == Some("enter") {
        session
            .cdp
            .dispatch_key("keyDown", "Enter", "Enter", 13)
            .await?;
        session
            .cdp
            .dispatch_key("keyUp", "Enter", "Enter", 13)
            .await?;
    }
    tokio::time::sleep(Duration::from_millis(
        params.settle_ms.unwrap_or(350).min(3_000),
    ))
    .await;
    let page = session.cdp.probe_page().await?;
    let blocked = matches!(
        page.page_kind,
        PageKind::Captcha | PageKind::Unknown | PageKind::Login
    );
    Ok((
        EffectPhase::Confirmed,
        CommandOutput::ActionReceipt(Box::new(ActionReceipt {
            action: "captcha_click".to_owned(),
            ok: !blocked,
            reason: Some(if blocked { "still_blocked" } else { "cleared" }.to_owned()),
            note_id: None,
            observation: None,
            post_observation: None,
            group_observation: None,
            group_url: None,
            clicked: None,
            candidates: Vec::new(),
        })),
    ))
}

fn validate_publish_file(path: &str) -> Result<(), EngineError> {
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
    session
        .timeout_ms
        .min(command_timeout_ceiling(session.platform, command))
}

fn command_timeout_ceiling(platform: Platform, command: &NativeCommand) -> u64 {
    if platform == Platform::Facebook && matches!(command, NativeCommand::GroupJoin(_)) {
        FACEBOOK_GROUP_JOIN_TIMEOUT_MS
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
    fn long_command_ceiling_is_facebook_group_join_only() {
        let join = NativeCommand::GroupJoin(crate::command::GroupJoinParams {
            group_url: "https://www.facebook.com/groups/42".to_owned(),
            click: Some(true),
            reason: None,
            think_ms: None,
        });
        let probe = NativeCommand::PageProbe(crate::command::EmptyParams::default());
        assert_eq!(
            command_timeout_ceiling(Platform::Facebook, &join),
            FACEBOOK_GROUP_JOIN_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ceiling(Platform::Facebook, &probe),
            DEFAULT_COMMAND_TIMEOUT_MS
        );
        assert_eq!(
            command_timeout_ceiling(Platform::Xiaohongshu, &join),
            DEFAULT_COMMAND_TIMEOUT_MS
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
    fn unchanged_reel_returns_one_honest_scroll_terminal() {
        let (phase, output) = facebook_scroll_failure(EffectPhase::Confirmed, "no_target");
        assert_eq!(phase, EffectPhase::Confirmed);
        let CommandOutput::ActionReceipt(receipt) = output else {
            panic!("scroll failure must be an action receipt");
        };
        assert_eq!(receipt.action, "scroll");
        assert!(!receipt.ok);
        assert_eq!(receipt.reason.as_deref(), Some("no_target"));
    }
}
