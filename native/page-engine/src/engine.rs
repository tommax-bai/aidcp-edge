use crate::cdp::CdpSession;
use crate::endpoint;
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::model::{
    ActionReceipt, CaptchaSnapshot, FacebookIdentityReceipt, IdentityObservation,
    IdentityObservationSource, IdentityPageEffect, NoteDetail, NotificationHome, NotificationItems,
    PageCards, PlanResults, ProfileDetail, PublishReceipt,
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
use std::collections::{BTreeMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

const MAX_RECORDED_COMMANDS: usize = 128;
const MAX_CAPTCHA_SNAPSHOTS: usize = 8;
const FACEBOOK_HOME_URL: &str = "https://www.facebook.com/";
const FACEBOOK_DETAIL_HYDRATION_TIMEOUT: Duration = Duration::from_secs(15);

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
            _ => execute_platform_command(session, request, &cancellation).await,
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
) -> StoredCommandResult {
    let write = request.command.may_write();
    if cancellation.load(Ordering::Acquire) {
        return StoredCommandResult::failed(cancelled_before_dispatch());
    }
    let remaining = match remaining_budget(request.deadline_unix_ms, session.timeout_ms) {
        Ok(value) => value,
        Err(error) => return StoredCommandResult::failed(error),
    };
    let operation = execute_platform_command_once(session, &request.command);
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
                Ok(()) => match execute_platform_command_once(session, &request.command).await {
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
            if write {
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
        Platform::Facebook => execute_facebook_command_once(session, command).await,
    }
}

async fn execute_facebook_command_once(
    session: &mut EngineSession,
    command: &NativeCommand,
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
            session.cdp.navigate(FACEBOOK_HOME_URL).await?;
            wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
            evaluate_facebook_router_until_cards(session, command, Duration::from_secs(5)).await
        }
        SearchExecute(params) => {
            let Some(container) = params.container.as_deref() else {
                return evaluate_facebook_router(session, command).await;
            };
            let url = validated_facebook_search_url(container, &params.keyword)?;
            session.cdp.navigate(url.as_str()).await?;
            wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
            evaluate_facebook_router_until_cards(session, command, Duration::from_secs(5)).await
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
            session.cdp.navigate(url.as_str()).await?;
            wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
            evaluate_facebook_router(session, command).await
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
        FeedRefresh(_) => {
            session.cdp.reload().await?;
            wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
            evaluate_facebook_router_until_cards(session, command, Duration::from_secs(5)).await
        }
        PublishNavigateEntry(_) => {
            session.cdp.navigate("https://www.facebook.com/").await?;
            wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
            evaluate_facebook_router(session, command).await
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
        _ => evaluate_facebook_router(session, command).await,
    }
}

async fn execute_facebook_page_scroll(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let before = probe_facebook_reel(session).await?;
    if !before.is_reels_surface() {
        return evaluate_facebook_router(session, command).await;
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
