use crate::cdp::CdpSession;
use crate::command::{NoteOpenParams, NoteOpenSelection};
use crate::commit_window::{CommitWindowRequester, xiaohongshu_commit_window};
use crate::effect::error_code_means_not_started;
use crate::endpoint;
use crate::endpoint_resolver::EndpointResolver;
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::input::{
    ContentNewline, ContentUnit, PointerClickOptions, PointerInputFailure, TextInputFailure,
    WheelInputFailure, bigram_similarity, build_content_units, dispatch_pointer_click,
    dispatch_wheel_humanized, hanzi_only, normalize_field_text, type_captcha_with_key_events,
    type_content_burst_humanized, type_text_humanized, typing_degradation_note,
};
use crate::model::{
    ActionEvidence, ActionReceipt, CaptchaSnapshot, CaptchaTypeReport, FacebookAuthActionReceipt,
    FacebookAuthProbeReceipt, FacebookIdentityReceipt, IdentityObservation,
    IdentityObservationSource, IdentityPageEffect, NoteDetail, NotificationHome, NotificationItems,
    ObservedActionReceipt, PageCards, PageMovement, PlanResults, ProfileDetail, PublishReceipt,
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
//
/// 命令的墙钟上限（宿主侧同一口径叫 `MAX_NATIVE_TIMEOUT_MS`）。
/// `pub` 是因为提交窗口的兜底预算**派生自它**（见 `commit_window.rs`）：这个数字是会被调的
/// （Facebook 时间预算整体 ×1.5 就调过一次，30_000 → 45_000），任何手抄一份的地方都会在
/// 下一次调整时静默失配——而窗口比命令短的后果是「已发出的写入被当成没发生 ⇒ 重复评论」。
pub const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 45_000;
const FACEBOOK_FEED_SCROLL_TIMEOUT_MS: u64 = 180_000;
const FACEBOOK_PUBLISH_SELECT_MODE_TIMEOUT_MS: u64 = 60_000;
const FACEBOOK_COMMENT_TIMEOUT_MS: u64 = 180_000;
const FACEBOOK_GROUP_JOIN_TIMEOUT_MS: u64 = 135_000;
const FACEBOOK_FIRST_POST_OPEN_TIMEOUT_MS: u64 = 135_000;
const FACEBOOK_PUBLISH_FILL_TIMEOUT_MS: u64 = 600_000;
/// 小红书评论：写完之后还要花掉的墙钟 —— 提交目标 probe + 拟人点击 + 800ms 落定 +
/// 结果扫描 + 失败清场 + CDP 抖动余量。**不照抄退役的 12s 停顿预算**：那是按
/// 「宿主一次性 insertText」的旧支出账定的。
const XHS_COMMENT_TAIL_RESERVE_MS: u64 = 6_000;
/// 小红书发布字段：写完之后还要花掉的墙钟 —— 有界回读 2s + 光标归尾 + 失败清场 + 余量。
const XHS_FILL_TAIL_RESERVE_MS: u64 = 3_500;
/// 单个换行的归尾确认上限（退役实测值）与下限。低于下限时「连续两轮 80ms 命中」
/// 结构上排不下，与其开写到一半超时，不如**开工前零派发**地诚实拒绝。
const XHS_NEWLINE_STABILIZE_CEILING_MS: u64 = 1_500;
const XHS_NEWLINE_STABILIZE_FLOOR_MS: u64 = 400;
/// 归尾确认总量最多吃掉「扣掉收尾余量后」的这一份额，剩下的留给正文本身。
const XHS_NEWLINE_STABILIZE_BUDGET_SHARE: u64 = 2;
/// 写后有界回读窗口与轮询间隔（编辑器常在下一帧才把内容规整完，写完立刻单次读会误判）。
const XHS_READBACK_BUDGET_MS: u64 = 2_000;
const XHS_READBACK_INTERVAL_MS: u64 = 80;
/// 评论到达确认的有界轮询：每轮间隔 × 轮数上限 = 2000ms 窗口（退役实现的量级）。
///
/// 迁移到原生引擎时这里退成了「固定睡 800ms 后单次采样」。单次采样有两个方向都会错：
/// 平台慢一点就读不到（错报失败），而采样点一旦落在渲染完成之后，剩下的判据就只有
/// 一条宽松子串扫描（分片侧已补回结构必要条件）。轮询按**迭代次数**限界，不按墙钟裸跑。
const XHS_COMMENT_ACK_INTERVAL_MS: u64 = 250;
const XHS_COMMENT_ACK_ROUNDS: u32 = 8;
/// 正文回读的语义相似度阈值：编辑器的空白规整 / 全半角替换是无害改写，严格等值会误杀。
const XHS_CONTENT_SIMILARITY_THRESHOLD: f64 = 0.9;
/// 与注入路由一致的字段级上限（按码点）。
const XHS_TEXT_CLIP_CHARS: usize = 32_000;
/// feed 单次翻页的基准位移 = 视口高度的这一份额，再裁进 [下限, 上限]。
///
/// 退役实现是 **500px 定值**，注释写明理由：约半屏可让相邻两次扫描的可见卡片**重叠**，
/// 整屏会让 borderline 卡只剩一次评估机会。迁移后的注入路由改成了 `innerHeight×0.78`
/// ≈ 0.78 屏，重叠因此被吃掉。这里改回半屏口径，但按**实测视口**取值而不是照抄 500 ——
/// 桌面端视口高度跨机器能差一倍，定值在小屏上就又是整屏。±20% 的随机由手势原语内部叠。
const XHS_FEED_SCROLL_VIEWPORT_SHARE: f64 = 0.5;
const XHS_FEED_SCROLL_MIN_PX: f64 = 360.0;
const XHS_FEED_SCROLL_MAX_PX: f64 = 700.0;
/// 详情页评论滚动的基准位移，与注入路由同口径（评论行比 feed 卡矮，半屏口径不适用）。
const XHS_COMMENT_SCROLL_PX: f64 = 500.0;
/// 位移落定的有界等待：按**迭代次数**限界（不按墙钟死循环）。
const XHS_SCROLL_SETTLE_INTERVAL_MS: u64 = 50;
const XHS_SCROLL_SETTLE_MAX_ROUNDS: usize = 14;
/// 落定判据 = 连续读到这么多次**同一个位置**（1 次重复即两次读数相同）。
/// 判据是「位置不再变化」，不是「出现了第一次变化」——后者恒在一个探针往返后就命中。
const XHS_SCROLL_SETTLE_REPEATS: u32 = 1;
/// 一次位移都还没读到时的最小耐心轮次。平滑滚动的起步可能比一次探针还慢，
/// 两轮之内就断言「到底了」等于把「还没开始动」错报成「不会动了」。
const XHS_SCROLL_SETTLE_MIN_ROUNDS_WITHOUT_MOVEMENT: usize = 6;
/// 评论滚动每一步之后的加载缓冲，与注入路由同口径。
const XHS_COMMENT_SCROLL_STEP_SETTLE_MS: u64 = 150;
/// 评论滚动的步数上限，与注入路由同口径。
const XHS_COMMENT_SCROLL_MAX_STEPS: u32 = 20;
/// 关闭详情浮层之后的落定等待。
const XHS_OVERLAY_CLOSE_SETTLE_MS: u64 = 250;

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
    FacebookAuthProbe(FacebookAuthProbeReceipt),
    FacebookAuthAction(FacebookAuthActionReceipt),
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
    /// 开会话那一刻宿主交付的端点。**重连时只作兜底**：宿主能重新解析就以宿主的答案为准
    /// （浏览器重开后端口会变，旧端口随时可能被同机另一个环境占上）。
    host: String,
    port: u16,
    /// 被准入的那一个浏览器实例的身份证据。`None` = 宿主没给（旧宿主），
    /// 后果是**重连一律诚实拒绝**，绝不退化成「端口对上就接管」。
    admitted_instance: Option<endpoint::BrowserInstanceIdentity>,
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
    pub(crate) consumed_auth_signal_ids: HashSet<String>,
    pub(crate) last_refresh_reload_at_ms: u64,
}

impl Default for FacebookSessionState {
    fn default() -> Self {
        Self {
            active_list_url: facebook::shared::FACEBOOK_HOME_URL.to_owned(),
            seen_post_ids: HashSet::new(),
            consumed_auth_signal_ids: HashSet::new(),
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
            admitted_instance: None,
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

    /// 重新附着到**同一个**浏览器实例上。
    ///
    /// 三步，缺一不可：
    ///  1. **重新解析端点**（`resolver`）。会话结构里存的那对 host/port 是开会话那一刻的值；
    ///     浏览器重开后端口会变，而旧端口不会闲着 —— 同机另一个环境随时可能占上去。
    ///     宿主解析不出来就诚实失败，MUST NOT 拿旧端口去碰运气。
    ///  2. **复核实例身份**：读端点自报的浏览器实例标识，与准入时记下的比对。
    ///     任一侧证据缺失、或两者不一致 → 拒绝附着，**不返回任何目标**。
    ///     这一步排在列目标之前 —— 不是自己的浏览器，连它开了哪些页面都不该去看。
    ///  3. 证据对上之后，才走既有的平台 / 端口判据挑目标并连上去。
    async fn reconnect(
        &mut self,
        deadline_unix_ms: u64,
        cancellation: &AtomicBool,
        resolver: &EndpointResolver,
    ) -> Result<(), EngineError> {
        if cancellation.load(Ordering::Acquire) {
            return Err(cancelled_before_dispatch());
        }
        let remaining = remaining_budget(deadline_unix_ms, self.timeout_ms)?;
        let admitted = self.admitted_instance.clone();
        let fallback = (self.host.clone(), self.port);
        let platform = self.platform;
        let operation = async move {
            // 没有准入基线就没有任何东西可以拿来比对 —— 立刻诚实拒绝，连端点都不去碰
            // （去碰也只能碰出一个无从比对的读数，那不叫证据）。
            let admitted = admitted.ok_or_else(endpoint::unproven_instance_identity)?;
            let (host, port) = match resolver
                .resolve(deadline_unix_ms, Some(cancellation))
                .await?
            {
                Some(resolved) => (resolved.host, resolved.port),
                None => fallback,
            };
            endpoint::validate_loopback_host(&host)?;
            let observed = endpoint::read_browser_identity(&host, port).await?;
            // 身份复核排在列目标之前。
            endpoint::ensure_admitted_instance(Some(&admitted), Some(&observed))?;
            let targets = endpoint::list_targets(&host, port).await?;
            let target = endpoint::select_target_for_instance(
                &targets,
                platform,
                port,
                Some(&admitted),
                Some(&observed),
            )?;
            let cdp = CdpSession::connect(&target).await?;
            Ok::<_, EngineError>((host, port, target.id, cdp))
        };
        let cancellation_wait = wait_for_cancellation(cancellation);
        tokio::pin!(cancellation_wait);
        let reconnect = tokio::time::timeout(remaining, operation);
        tokio::pin!(reconnect);
        let (host, port, target_id, cdp) = tokio::select! {
            _ = &mut cancellation_wait => return Err(cancelled_before_dispatch()),
            result = &mut reconnect => result.map_err(|_| EngineError::new(
                ErrorCode::CdpTimeout,
                "native page engine reconnect exceeded its deadline",
            ))??,
        };
        self.cdp.close().await;
        self.host = host;
        self.port = port;
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
        // 准入时记下这一个浏览器实例的身份证据。**只记、不自读**：开会话这一刻宿主刚把
        // 浏览器交过来，它自己就是权威，引擎再去自读一次既没有第二个事实可比对
        // （自读自比恒等真），又要多一次端点往返。证据的用处在**重连**那一刻。
        let admitted_instance = request
            .params
            .browser_debugger_url
            .as_deref()
            .and_then(endpoint::BrowserInstanceIdentity::from_browser_debugger_url);
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
            admitted_instance,
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
            EndpointResolver::in_process(request.command_id),
        )
        .await
    }

    pub async fn execute_cancellable_with_commit_windows(
        &mut self,
        request: &CommandRecord,
        cancellation: Arc<AtomicBool>,
        commit_windows: CommitWindowRequester,
        endpoints: EndpointResolver,
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
                match execute_page_probe(
                    session,
                    request.deadline_unix_ms,
                    &cancellation,
                    &endpoints,
                )
                .await
                {
                    Ok(result) => StoredCommandResult::confirmed(CommandOutput::PageProbe(result)),
                    Err(error) => StoredCommandResult::failed(error),
                }
            }
            _ => {
                execute_platform_command(
                    session,
                    request,
                    &cancellation,
                    &commit_windows,
                    &endpoints,
                )
                .await
            }
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
    endpoints: &EndpointResolver,
) -> StoredCommandResult {
    let write = request.command.may_write();
    if cancellation.load(Ordering::Acquire) {
        return StoredCommandResult::failed(cancelled_before_dispatch());
    }
    let command_timeout = command_timeout_ms(session, &request.command);
    let remaining = match remaining_budget(request.deadline_unix_ms, command_timeout) {
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
                .reconnect(request.deadline_unix_ms, cancellation, endpoints)
                .await
            {
                // 重连之后的这一次重试 MUST 与首跑受同一条绝对截止线约束。
                // 没有这层包裹时它是**无界**的：首跑吃满预算 → 重连 → 重试再从零开始等，
                // 于是「一条命令最多占多久」不再有上界，而单命令槽位要等它返回才释放
                // ——下一条命令会被 `CommandInProgress` 顶回，且没有任何东西会把它救出来。
                Ok(()) => {
                    let retry_budget =
                        match remaining_budget(request.deadline_unix_ms, command_timeout) {
                            Ok(value) => value,
                            Err(error) => return StoredCommandResult::failed(error),
                        };
                    let retry = execute_platform_command_once(
                        session,
                        &request.command,
                        Some(cancellation),
                        commit_windows,
                        request.deadline_unix_ms,
                    );
                    match tokio::time::timeout(retry_budget, retry).await {
                        Ok(Ok((phase, output))) => StoredCommandResult {
                            effect_phase: phase,
                            output: Some(output),
                            error: None,
                        },
                        Ok(Err(error)) => StoredCommandResult::failed(error),
                        Err(_) => StoredCommandResult::failed(EngineError::new(
                            ErrorCode::CdpTimeout,
                            "native page read command exceeded its deadline",
                        )),
                    }
                }
                Err(error) => StoredCommandResult::failed(error),
            }
        }
        Ok(Err(error)) => StoredCommandResult::failed_at(
            if write && !error_code_means_not_started(error.code) {
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
            .enter(contract.label, deadline_unix_ms, cancellation)
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
        // 写动作特化：文本一律走硬件级逐字 / 分块输入原语，页面判据经混淆分片，
        // 指针落焦与提交走拟人轨迹。截走之后注入路由里的同名分支不可达，
        // 其删除归单写区属主 `restore-native-xiaohongshu-action-honesty`。
        InteractionComment(params) => {
            execute_xhs_comment(session, params, cancellation, deadline_unix_ms).await
        }
        PublishFillField(params) => {
            execute_xhs_publish_fill_field(session, params, cancellation, deadline_unix_ms).await
        }
        // 滚动特化：共享惯性滚轮手势（滚前把光标移到**实测**可滚区中心），位移按实测回报。
        // 只有 `browse_next` 需要先关详情浮层——注入路由也只在这一条上关，另两条是纯翻页。
        BrowseNext(params) => {
            execute_xhs_feed_scroll(
                session,
                command,
                params.reason.as_deref(),
                true,
                cancellation,
                deadline_unix_ms,
            )
            .await
        }
        BrowseScroll(params) => {
            execute_xhs_feed_scroll(
                session,
                command,
                params.reason.as_deref(),
                false,
                cancellation,
                deadline_unix_ms,
            )
            .await
        }
        PageScroll(params) => {
            execute_xhs_feed_scroll(
                session,
                command,
                params.reason.as_deref(),
                false,
                cancellation,
                deadline_unix_ms,
            )
            .await
        }
        NoteScrollComments(params) => {
            execute_xhs_comment_scroll(session, params, cancellation, deadline_unix_ms).await
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
        // 评论点赞与详情页点赞同属「在平台上留下该账号名下的新痕迹」那一类：同样扣配额、
        // 同样写风控事实，漏掉它就等于给高危写动作留了一条不复检的旁路。
        // 动作名取云端的关联键 `comment_like`（页面规则里那条归一同源）——名字对不上，
        // 云端既不记账也不结案，还会把它当未知失败动作在详情页上补发一次列表滚动。
        NativeCommand::InteractionLikeComment(_) => Some("comment_like"),
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
                // 搜索框走的是逐字原语、不含换行单元，这一态在这条路径上结构上不可达。
                TextInputFailure::NewlineUnstable => "search_input_failed",
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

// ───────────────────────────── 小红书写动作特化（§8 输入半边）─────────────────────────────

/// 页面判据入口：选择器与 DOM 语义只活在混淆分片里，Rust 侧不写选择器。
async fn probe_xhs_input_target(
    session: &mut EngineSession,
    request: serde_json::Value,
) -> Result<serde_json::Value, EngineError> {
    let expression = xhs::input_targets_expression(&request)?;
    session.cdp.evaluate(&expression, false).await
}

fn xhs_target_text(value: &serde_json::Value, name: &str) -> Option<String> {
    value
        .pointer(&format!("/result/value/{name}"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

/// 分片判定的**三态**读法：`Some(true)` / `Some(false)` = 分片给出了确定判定；
/// `None` = 这一轮**读不到**。
///
/// 写动作的每一道判据都必须走这一条，MUST NOT 折成 `unwrap_or(false)`：`evaluate` 带
/// `silent:true`，页内一抛异常返回体里就只有 `exceptionDetails`、没有 `/result/value`，
/// 于是**所有**布尔判定一律读成 false。失败方向确实是保守的（不会假成功），但**归因是错的** ——
/// 真机上会照着 `editor_not_clean` 去查「上一条评论的残文没清干净」，而编辑器其实是空的、
/// 真因是分片脚本报错。「读不到」与「读到了一个坏消息」压成一态，就是把不知道说成知道。
fn xhs_target_optional_bool(value: &serde_json::Value, name: &str) -> Option<bool> {
    value
        .pointer(&format!("/result/value/{name}"))
        .and_then(serde_json::Value::as_bool)
}

/// 「读不到」的两种成因，进诊断行（不进回执词表，回执只分「确定的坏消息 / 读不到」两态）。
fn xhs_unreadable_cause(value: &serde_json::Value) -> &'static str {
    if value.get("exceptionDetails").is_some() {
        "probe_threw"
    } else {
        "verdict_absent"
    }
}

/// 三态判据的统一处置：`Some(true)` 放行；`Some(false)` 回 `false_reason`；
/// `None` 回 `unreadable_reason` 并把成因写进诊断行。
fn xhs_target_gate(
    value: &serde_json::Value,
    name: &str,
    false_reason: &'static str,
    unreadable_reason: &'static str,
) -> Result<(), &'static str> {
    match xhs_target_optional_bool(value, name) {
        Some(true) => Ok(()),
        Some(false) => Err(false_reason),
        None => {
            eprintln!(
                "native_page_engine_xhs_target_unreadable:{name}:{}",
                xhs_unreadable_cause(value)
            );
            Err(unreadable_reason)
        }
    }
}

fn xhs_target_number(value: &serde_json::Value, name: &str) -> Option<f64> {
    value
        .pointer(&format!("/result/value/{name}"))
        .and_then(serde_json::Value::as_f64)
}

fn xhs_target_point(value: &serde_json::Value) -> Option<(f64, f64)> {
    Some((
        xhs_target_number(value, "x")?,
        xhs_target_number(value, "y")?,
    ))
}

/// 与注入路由同口径的字段归一：折叠空白 + 去首尾 + 按码点截断。
fn xhs_normalized_field(value: &str) -> String {
    let normalized = normalize_field_text(value);
    if normalized.chars().count() <= XHS_TEXT_CLIP_CHARS {
        return normalized;
    }
    normalized.chars().take(XHS_TEXT_CLIP_CHARS).collect()
}

/// 有界等待，取消即原样穿出（接管优先于死线）。
async fn xhs_wait_checked(
    delay_ms: u64,
    cancellation: Option<&AtomicBool>,
) -> Result<(), EngineError> {
    let delay = Duration::from_millis(delay_ms);
    if let Some(cancellation) = cancellation {
        tokio::select! {
            _ = wait_for_cancellation(cancellation) => return Err(cancelled_before_dispatch()),
            _ = tokio::time::sleep(delay) => {}
        }
    } else {
        tokio::time::sleep(delay).await;
    }
    if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
        return Err(cancelled_before_dispatch());
    }
    Ok(())
}

fn xhs_action_outcome(
    phase: EffectPhase,
    action: &str,
    ok: bool,
    reason: Option<&str>,
    note_id: &str,
) -> (EffectPhase, CommandOutput) {
    (
        phase,
        CommandOutput::ActionReceipt(Box::new(ActionReceipt {
            action: action.to_owned(),
            ok,
            reason: reason.map(str::to_owned),
            note_id: Some(note_id.to_owned()),
            observation: None,
            post_observation: None,
            group_observation: None,
            group_url: None,
            clicked: None,
            candidates: Vec::new(),
            // 验证码键入取证只由验证码回执产出；这里显式写 None，**不用 `..Default::default()` 绕过**
            // ——那一格带 `skip_serializing_if`，正是为了让普通动作完成回执里不要多出一个空字段。
            type_report: None,
        })),
    )
}

fn xhs_publish_outcome(
    phase: EffectPhase,
    record_id: u64,
    seq: u32,
    ok: bool,
    error: Option<&str>,
) -> (EffectPhase, CommandOutput) {
    (
        phase,
        CommandOutput::PublishReceipt(PublishReceipt {
            record_id,
            seq,
            kind: "fill_field".to_owned(),
            ok,
            submit_dispatched: None,
            value: None,
            post_url: None,
            error: error.map(str::to_owned),
        }),
    )
}

fn xhs_units_internal_error() -> EngineError {
    EngineError::new(
        ErrorCode::EngineInternal,
        "native Xiaohongshu content units carried a newline after normalisation",
    )
}

/// 逐字 / 分块输入的截止时刻：命令死线减去收尾必须留出的那一段。
/// 留不出来就是**结构上做不到**，此时零派发地诚实拒绝，而不是开写到一半超时。
fn xhs_typing_deadline(deadline_unix_ms: u64, tail_reserve_ms: u64) -> Option<u64> {
    let now = unix_time_ms();
    let available = deadline_unix_ms.saturating_sub(now);
    let usable = available.checked_sub(tail_reserve_ms)?;
    (usable > 0).then_some(now + usable)
}

/// 发布正文的预算推导：先扣收尾余量，再把归尾确认的总量限死在剩余的一半以内，
/// 均摊到每个换行；摊到低于下限即开工前诚实拒绝。
fn xhs_fill_budget(deadline_unix_ms: u64, newline_count: usize) -> Option<(u64, u64)> {
    let typing_deadline = xhs_typing_deadline(deadline_unix_ms, XHS_FILL_TAIL_RESERVE_MS)?;
    if newline_count == 0 {
        return Some((typing_deadline, XHS_NEWLINE_STABILIZE_CEILING_MS));
    }
    let usable = typing_deadline.saturating_sub(unix_time_ms());
    let allowance = (newline_count as u64 * XHS_NEWLINE_STABILIZE_CEILING_MS)
        .min(usable / XHS_NEWLINE_STABILIZE_BUDGET_SHARE);
    let per_newline_ms = allowance / newline_count as u64;
    (per_newline_ms >= XHS_NEWLINE_STABILIZE_FLOOR_MS).then_some((typing_deadline, per_newline_ms))
}

/// 失败清场：留着半截草稿会被下一次写入拼上，或被提交原样发出去。
async fn clear_xhs_editor_best_effort(session: &mut EngineSession, request: serde_json::Value) {
    let _ = probe_xhs_input_target(session, request).await;
}

/// 小红书评论：目标闸 → 定位 → 拟人点击落焦 → 清场 → focus → 逐字输入 → 回读 → 提交 → 有界确认。
///
/// 提交窗口在命令开头已开（见 `execute_xhs_command_once` ②），逐字输入整段落在窗口内 ——
/// 这正是把 `xhs_comment_submit` 预算从 4s 抬到命令上限的原因：窗口过期不会拒发写入，
/// 但会让抢占落在**提交那一刻**，把一条可能已发出去的评论当成没发生。
async fn execute_xhs_comment(
    session: &mut EngineSession,
    params: &crate::command::CommentParams,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let note_id = params.note_id.clone();
    let refusal = |reason: &str| {
        xhs_action_outcome(
            EffectPhase::NotStarted,
            "comment",
            false,
            Some(reason),
            &note_id,
        )
    };

    let guard = probe_xhs_input_target(
        session,
        serde_json::json!({"kind":"note_guard","noteId":note_id}),
    )
    .await?;
    if let Err(reason) = xhs_target_gate(
        &guard,
        "match",
        "note_page_mismatch",
        "note_guard_unreadable",
    ) {
        return Ok(refusal(reason));
    }
    let body = xhs_normalized_field(&params.text);
    if body.is_empty() {
        return Ok(refusal("comment_text_empty"));
    }
    let contact_code = params
        .group_chat_code
        .as_deref()
        .map(xhs_normalized_field)
        .filter(|value| !value.is_empty());
    // 审=发：人审看到的终稿是「正文 + 换行 + 联系方式串码」。
    let full_text = match &contact_code {
        Some(code) => format!("{body}\n{code}"),
        None => body.clone(),
    };
    let Some(typing_deadline) = xhs_typing_deadline(deadline_unix_ms, XHS_COMMENT_TAIL_RESERVE_MS)
    else {
        return Ok(refusal("comment_budget_exhausted"));
    };

    let editor = probe_xhs_input_target(
        session,
        serde_json::json!({"kind":"comment_editor","op":"probe"}),
    )
    .await?;
    if let Err(reason) = xhs_target_gate(
        &editor,
        "found",
        "comment_editor_not_found",
        "comment_editor_probe_unreadable",
    ) {
        return Ok(refusal(reason));
    }
    let Some((x, y)) = xhs_target_point(&editor) else {
        return Ok(refusal("comment_editor_not_found"));
    };
    // 编辑器形态（受控框 / 富文本）决定这条评论**结构上能不能带一条分隔换行**。
    // 三态：读不到时不猜 —— 猜错的两个方向都通向不可逆的错误提交。
    let editor_is_plain = xhs_target_optional_bool(&editor, "plainValue");
    // 联系方式串码要求终稿是「正文 + 换行 + 串码」（审=发）。换行在这里只有一条安全通道：
    // 受控框里的字面 `\n`。富文本框既走不通字面换行（`Input.insertText("\n")` 常常
    // 什么都不产生），也**不能**改走裸回车 —— 评论框上的回车是提交，会把只写了一半的评论
    // 原样发出去，那是比丢一条换行严重得多的不可逆后果。所以这里在**零派发**处结构性拒绝，
    // 而不是写下去再赌。没有串码时不需要分隔，富文本框照常可用。
    if contact_code.is_some() {
        match editor_is_plain {
            Some(true) => {}
            Some(false) => return Ok(refusal("comment_editor_cannot_carry_separator")),
            None => return Ok(refusal("comment_editor_form_unreadable")),
        }
    }
    if let Err(failure) = dispatch_pointer_click(
        &mut session.cdp,
        x,
        y,
        PointerClickOptions::default(),
        cancellation,
        deadline_unix_ms,
    )
    .await
    {
        return match failure {
            PointerInputFailure::CancelledBeforePress => Err(cancelled_before_dispatch()),
            PointerInputFailure::DeadlineBeforePress => {
                Ok(refusal("comment_editor_deadline_exceeded"))
            }
            // 落焦点击不是不可逆动作：这里报「未开始」说的是**这条评论**没开始，属实。
            PointerInputFailure::MoveFailed(_) | PointerInputFailure::SubmitDispatched(_) => {
                Ok(refusal("comment_editor_not_actuated"))
            }
        };
    }
    let cleared = probe_xhs_input_target(
        session,
        serde_json::json!({"kind":"comment_editor","op":"clear"}),
    )
    .await?;
    if let Err(reason) = xhs_target_gate(
        &cleared,
        "cleared",
        "editor_not_clean",
        "comment_editor_clear_unreadable",
    ) {
        return Ok(refusal(reason));
    }
    let focused = probe_xhs_input_target(
        session,
        serde_json::json!({"kind":"comment_editor","op":"focus"}),
    )
    .await?;
    if let Err(reason) = xhs_target_gate(
        &focused,
        "focused",
        "comment_editor_focus_failed",
        "comment_editor_focus_unreadable",
    ) {
        return Ok(refusal(reason));
    }
    if !xhs_target_text(&focused, "value")
        .unwrap_or_default()
        .is_empty()
    {
        return Ok(refusal("editor_not_clean"));
    }

    let units = build_content_units(&full_text).ok_or_else(xhs_units_internal_error)?;
    // 评论框是受控 textarea（上面那道形态闸已经把富文本 + 串码的组合零派发挡掉了），
    // 那里的 `\n` 是普通字符；走裸回车会把评论提交出去。
    match type_content_burst_humanized(
        &mut session.cdp,
        &units,
        &ContentNewline::LiteralCharacter,
        cancellation,
        typing_deadline,
    )
    .await
    {
        Ok(outcome) => {
            if let Some(note) = typing_degradation_note(&outcome) {
                eprintln!("native_page_engine_xhs_typing_degraded:comment:{note}");
            }
        }
        Err(failure) => {
            clear_xhs_editor_best_effort(
                session,
                serde_json::json!({"kind":"comment_editor","op":"clear"}),
            )
            .await;
            if matches!(failure, TextInputFailure::Cancelled) {
                return Err(cancelled_before_dispatch());
            }
            return Ok(refusal(match failure {
                TextInputFailure::Deadline => "comment_input_deadline_exceeded",
                TextInputFailure::TargetLost => "comment_editor_focus_lost",
                TextInputFailure::NewlineUnstable => "comment_newline_unstable",
                TextInputFailure::Engine | TextInputFailure::Cancelled => "comment_input_failed",
            }));
        }
    }

    // 打字已经完成 ⇒ 编辑器里躺着一条填好的评论。此后到「按下提交」之前的**每一个**出口
    // 都必须先清场，引擎错误与接管穿出也算 —— 否则人接手时，页面上正躺着一条填好、
    // 只差点一下发送的评论。
    let (submit_x, submit_y) = match xhs_comment_readback_and_submit_target(
        session,
        &body,
        contact_code.as_deref(),
        cancellation,
    )
    .await
    {
        Ok(Ok(point)) => point,
        Ok(Err(reason)) => {
            clear_xhs_editor_best_effort(
                session,
                serde_json::json!({"kind":"comment_editor","op":"clear"}),
            )
            .await;
            return Ok(refusal(reason));
        }
        Err(error) => {
            clear_xhs_editor_best_effort(
                session,
                serde_json::json!({"kind":"comment_editor","op":"clear"}),
            )
            .await;
            return Err(error);
        }
    };
    if let Err(failure) = dispatch_pointer_click(
        &mut session.cdp,
        submit_x,
        submit_y,
        PointerClickOptions::default(),
        cancellation,
        deadline_unix_ms,
    )
    .await
    {
        return match failure {
            PointerInputFailure::CancelledBeforePress => {
                clear_xhs_editor_best_effort(
                    session,
                    serde_json::json!({"kind":"comment_editor","op":"clear"}),
                )
                .await;
                Err(cancelled_before_dispatch())
            }
            PointerInputFailure::DeadlineBeforePress => {
                clear_xhs_editor_best_effort(
                    session,
                    serde_json::json!({"kind":"comment_editor","op":"clear"}),
                )
                .await;
                Ok(refusal("comment_submit_deadline_exceeded"))
            }
            PointerInputFailure::MoveFailed(_) => {
                clear_xhs_editor_best_effort(
                    session,
                    serde_json::json!({"kind":"comment_editor","op":"clear"}),
                )
                .await;
                Ok(refusal("comment_submit_not_actuated"))
            }
            // **按下已经派发**：这条评论可能已经发出去了。诚实红线 —— MUST NOT 回「未开始」，
            // 否则上游会当成压根没点而重投，结果是重复评论。
            PointerInputFailure::SubmitDispatched(_) => Ok(xhs_action_outcome(
                EffectPhase::Ambiguous,
                "comment",
                false,
                Some("submitted_unconfirmed"),
                &note_id,
            )),
        };
    }

    // 提交点已跨过：此后**不再**把取消当成「没提交」——那正是提交窗口存在的理由。
    // 确认要两条**独立**证据同时成立：正文出现在评论区（业务结果），且编辑器已被平台清空
    // （结构必要条件）。只留前者的话，判据退化成一条宽松子串扫描，而我们自己刚写进去的
    // 正文就在页面上 —— 那是自证，不是证据。
    let mut appeared = None;
    let mut cleared = None;
    for _ in 0..XHS_COMMENT_ACK_ROUNDS {
        tokio::time::sleep(Duration::from_millis(XHS_COMMENT_ACK_INTERVAL_MS)).await;
        let ack = probe_xhs_input_target(
            session,
            serde_json::json!({"kind":"comment_ack","text":body}),
        )
        .await;
        // 只在读到确定值时覆盖：这一轮读不到 MUST NOT 把上一轮读到的确定值抹回「读不到」。
        if let Ok(value) = &ack {
            appeared = xhs_target_optional_bool(value, "appeared").or(appeared);
            cleared = xhs_target_optional_bool(value, "editorCleared").or(cleared);
        }
        if appeared == Some(true) && cleared == Some(true) {
            break;
        }
    }
    // 三态，病因分开记：读到「没出现」说明提交很可能没生效；读到「出现了、但编辑器没被清空」
    // 说明两条证据互相矛盾（最可能是扫描读到了编辑器里那份还没发出去的正文）；
    // 「压根读不到」说明确认这一层本身瞎了。三者都不是确认，但真机上要查的东西完全不同。
    Ok(match (appeared, cleared) {
        (Some(true), Some(true)) => {
            xhs_action_outcome(EffectPhase::Confirmed, "comment", true, None, &note_id)
        }
        (Some(true), Some(false)) => xhs_action_outcome(
            EffectPhase::Ambiguous,
            "comment",
            false,
            Some("submitted_editor_not_cleared"),
            &note_id,
        ),
        (Some(false), _) => xhs_action_outcome(
            EffectPhase::Ambiguous,
            "comment",
            false,
            Some("submitted_unconfirmed"),
            &note_id,
        ),
        _ => xhs_action_outcome(
            EffectPhase::Ambiguous,
            "comment",
            false,
            Some("submitted_ack_unreadable"),
            &note_id,
        ),
    })
}

/// 评论的有界回读 + 提交目标定位：正文与串码都必须在，且串码在正文之后（不许丢、不许换序）。
///
/// 三种结局分开返回：`Ok(Ok(点))` = 已确认且提交点已定位；`Ok(Err(原因))` = 诚实拒绝；
/// `Err(..)` = 引擎错误 / 接管穿出。
///
/// 本函数自身**不清场**：它的每一次调用都发生在「编辑器里已经躺着一条填好的评论」之后，
/// 清场是调用方对这一整段的统一不变量 —— 写在这里就会漏掉 `?` 抛出去的那几条路径。
async fn xhs_comment_readback_and_submit_target(
    session: &mut EngineSession,
    body: &str,
    contact_code: Option<&str>,
    cancellation: Option<&AtomicBool>,
) -> Result<Result<(f64, f64), &'static str>, EngineError> {
    // 串码在场 ⇒ 终稿恰好两段（正文归一后不含换行、串码同理）。这是「审=发」里那条分隔换行的
    // **结构证据**，也是下面两道文本比对**看不见**的东西：`xhs_normalized_field` 把换行折成空格，
    // 于是「正文 串码」连成一行时 `find(body)` 与 `find(code)` 照样命中、顺序照样正确 ⇒ 确认 ⇒
    // 提交 ⇒ ok=true，而人审看到的终稿与真正发出去的不是同一份，任何一层都不会发现。
    let expected_paragraphs = if contact_code.is_some() { 2 } else { 1 };
    let mut readback_reason = "comment_readback_mismatch";
    let mut confirmed = false;
    for round in 0..XHS_READBACK_BUDGET_MS.div_ceil(XHS_READBACK_INTERVAL_MS) {
        if round > 0 {
            xhs_wait_checked(XHS_READBACK_INTERVAL_MS, cancellation).await?;
        }
        let read = probe_xhs_input_target(
            session,
            serde_json::json!({"kind":"comment_editor","op":"probe"}),
        )
        .await?;
        let value = xhs_normalized_field(&xhs_target_text(&read, "value").unwrap_or_default());
        let Some(body_at) = value.find(body) else {
            readback_reason = "comment_readback_mismatch";
            continue;
        };
        let code_at = match contact_code {
            Some(code) => match value.find(code) {
                Some(at) => at,
                None => {
                    readback_reason = "comment_contact_code_missing";
                    continue;
                }
            },
            None => body_at,
        };
        if code_at < body_at {
            readback_reason = "comment_readback_mismatch";
            continue;
        }
        if expected_paragraphs > 1 {
            match xhs_target_number(&read, "paragraphs") {
                Some(paragraphs) if (paragraphs as usize) < expected_paragraphs => {
                    readback_reason = "comment_separator_lost";
                    continue;
                }
                // 「读不到段落数」与「段落数不够」是两态；读不到时**也不放行** ——
                // 上面两道比对对换行免疫，此刻认定收敛就是静默假成功。
                None => {
                    readback_reason = "comment_paragraphs_unreadable";
                    continue;
                }
                Some(_) => {}
            }
        }
        confirmed = true;
        break;
    }
    if !confirmed {
        return Ok(Err(readback_reason));
    }

    let submit =
        probe_xhs_input_target(session, serde_json::json!({"kind":"comment_submit"})).await?;
    if let Err(reason) = xhs_target_gate(
        &submit,
        "found",
        "comment_submit_not_found",
        "comment_submit_probe_unreadable",
    ) {
        return Ok(Err(reason));
    }
    let Some(point) = xhs_target_point(&submit) else {
        return Ok(Err("comment_submit_not_found"));
    };
    Ok(Ok(point))
}

/// 小红书发布字段填写：正文换行走**裸回车 + 有界归尾确认**，文本写入结构上不携带回车符。
async fn execute_xhs_publish_fill_field(
    session: &mut EngineSession,
    params: &crate::command::PublishFieldParams,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let record_id = params.record_id;
    let seq = params.seq;
    let not_started = |error: &str| {
        xhs_publish_outcome(EffectPhase::NotStarted, record_id, seq, false, Some(error))
    };
    let field_request = serde_json::json!({
        "kind":"publish_field","op":"probe","fieldType":params.field_type,
    });
    let clear_request = serde_json::json!({
        "kind":"publish_field","op":"clear","fieldType":params.field_type,
    });

    let field = probe_xhs_input_target(session, field_request.clone()).await?;
    if let Err(reason) = xhs_target_gate(
        &field,
        "found",
        "publish_field_not_found",
        "publish_field_probe_unreadable",
    ) {
        return Ok(not_started(reason));
    }
    let Some((x, y)) = xhs_target_point(&field) else {
        return Ok(not_started("publish_field_not_found"));
    };
    // 编辑器形态决定换行走字面字符还是裸回车。读不到时**不猜**：猜成富文本会往受控框里打回车，
    // 猜成受控框会把段落写丢；两个方向都通向「写了但不是那份内容」。零派发拒绝才是诚实的。
    let Some(plain_value) = xhs_target_optional_bool(&field, "plainValue") else {
        eprintln!(
            "native_page_engine_xhs_target_unreadable:plainValue:{}",
            xhs_unreadable_cause(&field)
        );
        return Ok(not_started("publish_field_form_unreadable"));
    };

    let units = build_content_units(&params.value).ok_or_else(xhs_units_internal_error)?;
    let newline_count = units
        .iter()
        .filter(|unit| matches!(unit, ContentUnit::Newline))
        .count();
    // 结构性前置判据：换行多到归尾确认排不下时，**开工前**零派发地诚实拒绝。
    let Some((typing_deadline, per_newline_ms)) = xhs_fill_budget(
        deadline_unix_ms,
        if plain_value { 0 } else { newline_count },
    ) else {
        return Ok(not_started("publish_field_budget_exhausted"));
    };

    if let Err(failure) = dispatch_pointer_click(
        &mut session.cdp,
        x,
        y,
        PointerClickOptions::default(),
        cancellation,
        deadline_unix_ms,
    )
    .await
    {
        return match failure {
            PointerInputFailure::CancelledBeforePress => Err(cancelled_before_dispatch()),
            PointerInputFailure::DeadlineBeforePress => {
                Ok(not_started("publish_field_deadline_exceeded"))
            }
            PointerInputFailure::MoveFailed(_) | PointerInputFailure::SubmitDispatched(_) => {
                Ok(not_started("publish_field_not_actuated"))
            }
        };
    }
    let cleared = probe_xhs_input_target(session, clear_request.clone()).await?;
    if let Err(reason) = xhs_target_gate(
        &cleared,
        "cleared",
        "publish_field_not_clean",
        "publish_field_clear_unreadable",
    ) {
        return Ok(not_started(reason));
    }
    let focused = probe_xhs_input_target(
        session,
        serde_json::json!({"kind":"publish_field","op":"focus","fieldType":params.field_type}),
    )
    .await?;
    if let Err(reason) = xhs_target_gate(
        &focused,
        "focused",
        "publish_field_focus_failed",
        "publish_field_focus_unreadable",
    ) {
        return Ok(not_started(reason));
    }

    let caret_state_expression = xhs::input_targets_expression(&serde_json::json!({
        "kind":"content_caret_state","fieldType":params.field_type,
    }))?;
    // 受控框（`value` 语义）里 `\n` 是普通字符；富文本正文才需要裸回车让编辑器自己拆段。
    let newline = if plain_value {
        ContentNewline::LiteralCharacter
    } else {
        ContentNewline::BareEnterKey {
            caret_state_expression: caret_state_expression.as_str(),
            stabilize_budget_ms: per_newline_ms,
        }
    };
    match type_content_burst_humanized(
        &mut session.cdp,
        &units,
        &newline,
        cancellation,
        typing_deadline,
    )
    .await
    {
        Ok(outcome) => {
            if let Some(note) = typing_degradation_note(&outcome) {
                eprintln!("native_page_engine_xhs_typing_degraded:publish_field:{note}");
            }
        }
        Err(failure) => {
            clear_xhs_editor_best_effort(session, clear_request.clone()).await;
            if matches!(failure, TextInputFailure::Cancelled) {
                return Err(cancelled_before_dispatch());
            }
            return Ok(xhs_publish_outcome(
                EffectPhase::Ambiguous,
                record_id,
                seq,
                false,
                Some(match failure {
                    TextInputFailure::Deadline => "publish_field_deadline_exceeded",
                    TextInputFailure::TargetLost => "publish_field_focus_lost",
                    // 「没稳住」与「探针读不到」分开上报，真机上才分得清病因。
                    TextInputFailure::NewlineUnstable => "publish_content_newline_unstable",
                    TextInputFailure::Engine | TextInputFailure::Cancelled => {
                        "publish_field_failed"
                    }
                }),
            ));
        }
    }

    let wanted = xhs_normalized_field(&params.value);
    let expected_paragraphs = params
        .value
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .count();
    // 打字已经完成 ⇒ 编辑器里躺着一份填好的正文。此后**每一个**失败出口都必须先清场，
    // 引擎错误与接管穿出也算 —— 否则让位时页面上留着一份半截 / 未确认的草稿，
    // 下一次写入会拼在它后面，或被人 / 被下一条命令原样提交出去。
    match xhs_publish_field_readback(
        session,
        &field_request,
        &wanted,
        expected_paragraphs,
        cancellation,
    )
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(reason)) => {
            clear_xhs_editor_best_effort(session, clear_request).await;
            return Ok(xhs_publish_outcome(
                EffectPhase::Ambiguous,
                record_id,
                seq,
                false,
                Some(reason),
            ));
        }
        Err(error) => {
            clear_xhs_editor_best_effort(session, clear_request).await;
            return Err(error);
        }
    }
    // 光标归尾：后续的话题 / @ 候选都在光标处继续写，光标不在尾部会插到正文中间。
    let _ = probe_xhs_input_target(
        session,
        serde_json::json!({"kind":"publish_field","op":"cursor_to_end","fieldType":params.field_type}),
    )
    .await;
    Ok(xhs_publish_outcome(
        EffectPhase::Confirmed,
        record_id,
        seq,
        true,
        None,
    ))
}

/// 发布正文的有界回读。三种结局分开返回，绝不压成一态：
///  - `Ok(Ok(()))`  = 收敛，内容确实落在编辑器里；
///  - `Ok(Err(原因))` = 有界预算内始终没收敛，按**病因**分列上报；
///  - `Err(..)`     = 引擎错误 / 接管穿出，由调用方先清场再原样上抛。
///
/// 本函数自身**不清场**：清场是调用方对「打字之后的每一个出口」的统一不变量，
/// 放在这里就会漏掉 `?` 抛出去的那几条路径。
async fn xhs_publish_field_readback(
    session: &mut EngineSession,
    field_request: &serde_json::Value,
    wanted: &str,
    expected_paragraphs: usize,
    cancellation: Option<&AtomicBool>,
) -> Result<Result<(), &'static str>, EngineError> {
    let head: String = wanted.chars().take(20).collect();
    let wanted_hanzi = hanzi_only(wanted);
    let mut reason = "publish_field_readback_mismatch";
    for round in 0..XHS_READBACK_BUDGET_MS.div_ceil(XHS_READBACK_INTERVAL_MS) {
        if round > 0 {
            xhs_wait_checked(XHS_READBACK_INTERVAL_MS, cancellation).await?;
        }
        let read = probe_xhs_input_target(session, field_request.clone()).await?;
        let value = xhs_normalized_field(&xhs_target_text(&read, "value").unwrap_or_default());
        if value.is_empty() || (!head.is_empty() && !value.starts_with(head.as_str())) {
            reason = "publish_field_readback_mismatch";
            continue;
        }
        // 换行的结构证据。**富文本分支尤其必须比**：`[contenteditable]` 是正文的默认形态，
        // 也是唯一走裸回车的那条路 —— 回车被 #话题 / @ 候选浮层接走时段落会整段消失，
        // 而下面两道比对都对换行免疫（归一把空白折成单空格、汉字档只留汉字）。
        // 把这道闸限死在受控框上，等于让「段落全丢」以 Confirmed 回报。
        if expected_paragraphs > 1 {
            match xhs_target_number(&read, "paragraphs") {
                Some(paragraphs) if (paragraphs as usize) < expected_paragraphs => {
                    reason = "publish_content_paragraphs_lost";
                    continue;
                }
                // 「读不到段落数」与「段落数不够」是两态。读不到时**也不能**放行：
                // 下面两道比对对换行免疫，此刻认定收敛就是静默假成功。分开记病因，
                // 真机上才分得清是分片没给判定还是编辑器真吞了段。
                None => {
                    reason = "publish_content_paragraphs_unreadable";
                    continue;
                }
                Some(_) => {}
            }
        }
        if value == wanted || bigram_similarity(&value, wanted) >= XHS_CONTENT_SIMILARITY_THRESHOLD
        {
            return Ok(Ok(()));
        }
        // 汉字档退化比较：编辑器对标点 / 全半角的无害改写不该判成内容丢失。
        if !wanted_hanzi.is_empty() && hanzi_only(&value).contains(wanted_hanzi.as_str()) {
            return Ok(Ok(()));
        }
        reason = "publish_field_readback_mismatch";
    }
    Ok(Err(reason))
}

// ───────────────────────────── 小红书滚动特化（§8 滚动半边）─────────────────────────────

/// 注入路由里唯一**不带副作用**的分支：只扫卡片、不滚动。引擎自己滚完之后用它取卡片，
/// 卡片解析因此不必在引擎里再实现一份。
const XHS_INITIAL_SCAN_REASON: &str = "initial_scan";

/// 一处可滚区的**实测**几何与位置。坐标由页面判据分片解析——宽 / 窄两套布局的可滚元素不同
/// （可能是内层容器，也可能就是窗口），所以既不写死视口中心，也不照抄别的平台的落点常量。
#[derive(Clone, Copy, Debug)]
struct XhsScrollArea {
    x: f64,
    y: f64,
    position: f64,
    viewport_height: f64,
    /// `None` = 分片没给出这一判定（读不到），**不是** `false`（读到了、不在底部）。
    at_bottom: Option<bool>,
    /// 评论区才有的可见行数；feed 可滚区不带这一项。
    rows: Option<u32>,
}

/// 读一处可滚区。返回 `None` 的含义是**读不到**（解析不出可滚区，或数值字段缺失），
/// 与「读到了、但页面没动」是两态——调用方 MUST NOT 把前者当后者。
///
/// 这里 `found == Some(false)`（分片解析不出可滚区）与 `None`（读不到判定）确实同属
/// 「读不到一处可滚区」这一态，不是折叠：分片的 `found:false` 本来就是「我没解析出来」，
/// 与「这里确实没有可滚区」不是一回事，两者对调用方的处置也完全相同。
async fn probe_xhs_scroll_area(
    session: &mut EngineSession,
    request: serde_json::Value,
) -> Result<Option<XhsScrollArea>, EngineError> {
    let value = probe_xhs_input_target(session, request).await?;
    if xhs_target_optional_bool(&value, "found") != Some(true) {
        return Ok(None);
    }
    let (Some((x, y)), Some(position), Some(viewport_height)) = (
        xhs_target_point(&value),
        xhs_target_number(&value, "position"),
        xhs_target_number(&value, "viewportHeight"),
    ) else {
        return Ok(None);
    };
    Ok(Some(XhsScrollArea {
        x,
        y,
        position,
        viewport_height,
        at_bottom: xhs_target_optional_bool(&value, "atBottom"),
        rows: xhs_target_number(&value, "rows").map(|value| value.max(0.0) as u32),
    }))
}

/// 一次手势派发的结局。**「派发失败」与「页面没动」是两态**：前者是手势没能送出去，
/// 后者是送出去了、页面确实没动（到底 / 不可滚）。压成一态会让一次引擎侧的瞬时超时
/// 被读成「feed 到底了」。回执字段归并行 change，故两态经诊断通道分开记
/// （宿主保留 stderr 尾部，见 `src/native-page-engine/client.ts` 的 stderr 缓冲）。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum XhsWheelOutcome {
    Dispatched,
    Aborted,
}

/// 派发一次惯性滚轮手势。原语自带「滚前把光标移到目标点」，故调用方只给坐标。
///
/// 失败处置的顺序是 8.4 的顺序：**接管优先于死线**——取消原样穿出，死线 / CDP 瞬时失败
/// 只中止本轮，**MUST NOT `return Err`**（一次瞬时超时不得终结整个浏览循环）。
async fn dispatch_xhs_wheel(
    session: &mut EngineSession,
    area: XhsScrollArea,
    baseline_distance_px: f64,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
    stage: &str,
) -> Result<XhsWheelOutcome, EngineError> {
    match dispatch_wheel_humanized(
        &mut session.cdp,
        area.x,
        area.y,
        baseline_distance_px,
        cancellation,
        deadline_unix_ms,
    )
    .await
    {
        Ok(()) => Ok(XhsWheelOutcome::Dispatched),
        Err(WheelInputFailure::Cancelled) => Err(cancelled_before_dispatch()),
        Err(failure) => {
            let cause = match failure {
                WheelInputFailure::Deadline => "deadline",
                WheelInputFailure::Cdp(_) => "cdp",
                WheelInputFailure::Cancelled => "cancelled",
            };
            eprintln!("native_page_engine_xhs_wheel_aborted:{stage}:{cause}");
            Ok(XhsWheelOutcome::Aborted)
        }
    }
}

/// 有界等位移落定：按**迭代次数**限界（不按墙钟死循环），命令死线到了也停。
/// 落定判据是**位置不再变化**（连续两次读数相同），不是「出现了第一次变化」。
///
/// 为什么不能「见到第一次变化就返回」：手势原语是把 8–15 帧**全部派完**才返回的，
/// 所以派完之后的第一次探针必然已经读到变化 —— 那条判据恒在一个探针往返后 break，
/// 随后立刻只读重扫。小红书 feed 是滚动触发懒渲染的，这一刻读到的卡片大概率还是滚动前那一屏，
/// 云端于是反复选中已访问过的笔记、或判定无新候选继续下发翻页 ——「只刷不点」活锁。
/// 而回执本身是诚实的（位移确实是实测的），所以现场没有任何错误码指向这里。
///
/// 「还没开始动」与「不会动了」同样是两态：位置一直等于 `before` 时不得在两轮之内就断言到底，
/// 故未观察到位移时另有一条最小耐心轮次。返回 `None` 仍然只表示**读不到**。
async fn wait_for_xhs_scroll_settled(
    session: &mut EngineSession,
    request: serde_json::Value,
    before: f64,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<Option<XhsScrollArea>, EngineError> {
    let mut latest: Option<XhsScrollArea> = None;
    let mut previous: Option<f64> = None;
    let mut repeats = 0_u32;
    let mut moved = false;
    for round in 0..XHS_SCROLL_SETTLE_MAX_ROUNDS {
        if unix_time_ms() >= deadline_unix_ms {
            break;
        }
        xhs_wait_checked(XHS_SCROLL_SETTLE_INTERVAL_MS, cancellation).await?;
        let Some(area) = probe_xhs_scroll_area(session, request.clone()).await? else {
            // 这一轮**读不到**：既不算「还在动」也不算「已停」。连续计数清零后继续有界重试，
            // 绝不拿一次读不到冒充落定。
            previous = None;
            repeats = 0;
            continue;
        };
        latest = Some(area);
        moved |= area.position != before;
        repeats = if previous == Some(area.position) {
            repeats + 1
        } else {
            0
        };
        previous = Some(area.position);
        if repeats < XHS_SCROLL_SETTLE_REPEATS {
            continue;
        }
        if moved || round + 1 >= XHS_SCROLL_SETTLE_MIN_ROUNDS_WITHOUT_MOVEMENT {
            break;
        }
    }
    // 一轮都没能读到（预算已尽 / 每轮都读不到）时就地再读一次：读到什么报什么。
    if latest.is_none() {
        latest = probe_xhs_scroll_area(session, request).await?;
    }
    Ok(latest)
}

/// `browse_next` 滚前先关详情浮层，否则手势落在浮层上（浮层自己也可滚）——
/// 位移读到了、feed 却一步没动。
///
/// 「浮层不在」与「浮层在但关闭控件没认出来」是两态：前者无需关，后者是关不掉。
/// 后者仍照常去滚，位移按实测回报，所以不会退化成静默假成功。
async fn close_xhs_detail_overlay(
    session: &mut EngineSession,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(), EngineError> {
    let probe =
        probe_xhs_input_target(session, serde_json::json!({ "kind": "detail_close" })).await?;
    // 三态：读到「没有浮层」才跳过。读不到时**不当作没有浮层** —— 那会让手势落在浮层上、
    // feed 一步不动却读到位移。读不到就照「浮层可能在、关闭控件没认出来」那条走（照常去滚，
    // 位移按实测回报），并留一行成因。
    match xhs_target_optional_bool(&probe, "overlay") {
        Some(false) => return Ok(()),
        Some(true) => {}
        None => eprintln!(
            "native_page_engine_xhs_target_unreadable:overlay:{}",
            xhs_unreadable_cause(&probe)
        ),
    }
    let Some((x, y)) = xhs_target_point(&probe)
        .filter(|_| xhs_target_optional_bool(&probe, "found") == Some(true))
    else {
        eprintln!("native_page_engine_xhs_detail_close_control_missing");
        return Ok(());
    };
    match dispatch_pointer_click(
        &mut session.cdp,
        x,
        y,
        PointerClickOptions::default(),
        cancellation,
        deadline_unix_ms,
    )
    .await
    {
        Ok(_) => xhs_wait_checked(XHS_OVERLAY_CLOSE_SETTLE_MS, cancellation).await?,
        // 接管原样穿出，不吞成普通失败。
        Err(PointerInputFailure::CancelledBeforePress) => return Err(cancelled_before_dispatch()),
        Err(_) => eprintln!("native_page_engine_xhs_detail_close_not_actuated"),
    }
    Ok(())
}

/// 小红书 feed 翻页 / 页面滚动。
///
/// 形状：读 before → 惯性滚轮手势 → 有界等位移落定 → 读 after → 用只读扫描取卡片 →
/// 把**自测**的位移回填进卡片结果。回执形状与注入路由逐字段一致。
async fn execute_xhs_feed_scroll(
    session: &mut EngineSession,
    command: &NativeCommand,
    reason: Option<&str>,
    close_detail_overlay: bool,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    // 只读扫描：不滚动、不触碰页面，原样交给注入路由。
    if reason == Some(XHS_INITIAL_SCAN_REASON) {
        return evaluate_router(session, command).await;
    }
    if close_detail_overlay {
        close_xhs_detail_overlay(session, cancellation, deadline_unix_ms).await?;
    }
    let request = serde_json::json!({ "kind": "feed_scroll_area" });
    let Some(before) = probe_xhs_scroll_area(session, request.clone()).await? else {
        return Err(xhs_scroll_area_unresolved());
    };
    let baseline = (before.viewport_height * XHS_FEED_SCROLL_VIEWPORT_SHARE)
        .clamp(XHS_FEED_SCROLL_MIN_PX, XHS_FEED_SCROLL_MAX_PX);
    // 中止的是这一轮手势，不是这条命令的诚实回报：随后照常读一次位置、按实测位移回报。
    dispatch_xhs_wheel(
        session,
        before,
        baseline,
        cancellation,
        deadline_unix_ms,
        "feed",
    )
    .await?;
    let Some(after) = wait_for_xhs_scroll_settled(
        session,
        request,
        before.position,
        cancellation,
        deadline_unix_ms,
    )
    .await?
    else {
        return Err(xhs_scroll_area_unresolved());
    };
    let (phase, output) = evaluate_router(session, &xhs_initial_scan_command(command)?).await?;
    let CommandOutput::PageCards(mut cards) = output else {
        return Err(xhs_scroll_scan_invalid());
    };
    // 两处语义都容易被「看起来合理」的改动悄悄拧掉，故就地写死判据：
    //
    // ① `moved` 的判据是「位置**变了**」，不是「位置**变大了**」。位置回退在真机上可达 ——
    //    懒渲染换掉滚动容器 / feed 刷新回顶 ⇒ 位置从 p 跳回 0，而页面**确实动了**（卡片还整批
    //    换了）。此时报 `moved=false` 就是把一次真实位移谎报成静止，再配上消费面
    //    「到底了且没动就收工」，直接变成提前收工。注入路由自己是 `window.scrollY!==before`
    //    （`xhs-command-router.js`），同引擎的 Facebook feed 也是 `!=`（`facebook/feed.rs`）；
    //    退役 TS 路径的 `after > before`（`src/browse/browse-session.ts`）**不是**本流要对齐的
    //    口径 —— 照它「订正」成 `>` 是本处最像修 bug 的一次改坏。
    //
    // ② `at_bottom` 取的必须是**滚动之后**那次读数：这一项的全部意义就是它会因为这一滚而翻转。
    //    取滚前读数 ⇒ 恰好在「这一滚真的到底了」那一次回执说「没到底」，云端的到底检测被系统性
    //    推迟一条命令；反方向（刷新回顶、判定 true→false）则是替云端提前收工。
    cards.movement = Some(PageMovement {
        before: before.position,
        after: after.position,
        moved: after.position != before.position,
        at_bottom: after.at_bottom,
    });
    Ok((phase, CommandOutput::PageCards(cards)))
}

/// 同一条命令的只读扫描形态：只把 `reason` 换成 `initial_scan`，其余参数原样带过去。
fn xhs_initial_scan_command(command: &NativeCommand) -> Result<NativeCommand, EngineError> {
    let reason = Some(XHS_INITIAL_SCAN_REASON.to_owned());
    Ok(match command {
        NativeCommand::BrowseNext(_) => {
            NativeCommand::BrowseNext(crate::command::ReasonParams { reason })
        }
        NativeCommand::BrowseScroll(_) => {
            NativeCommand::BrowseScroll(crate::command::ReasonParams { reason })
        }
        NativeCommand::PageScroll(params) => {
            NativeCommand::PageScroll(crate::command::PageScrollParams {
                reason,
                dwell_ms: params.dwell_ms,
            })
        }
        _ => return Err(xhs_scroll_scan_invalid()),
    })
}

/// 详情页评论区滚动。每一步一次手势，位置不再变化即停手（到底 / 不可滚），
/// 「滚了几条」按页面上真实可见的评论行数回报，不是按下发了几步。
async fn execute_xhs_comment_scroll(
    session: &mut EngineSession,
    params: &crate::command::NoteTraverseParams,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let note_id = params.note_id.clone();
    let guard = probe_xhs_input_target(
        session,
        serde_json::json!({"kind":"note_guard","noteId":note_id}),
    )
    .await?;
    if let Err(reason) = xhs_target_gate(
        &guard,
        "match",
        "note_page_mismatch",
        "note_guard_unreadable",
    ) {
        return Ok(xhs_action_outcome(
            EffectPhase::NotStarted,
            "scroll_comments",
            false,
            Some(reason),
            &note_id,
        ));
    }
    let request = serde_json::json!({ "kind": "comment_scroll_area" });
    // 步数是**请求值**（云端下发几步），不是实测量：缺省即 1 步，与注入路由同口径。
    // 真正回报出去的「滚了几条」在下面按实测行数取，绝不拿这个数字充数。
    let steps = params
        .count
        .unwrap_or(1)
        .clamp(1, XHS_COMMENT_SCROLL_MAX_STEPS);
    let mut moved = false;
    for _ in 0..steps {
        let Some(before) = probe_xhs_scroll_area(session, request.clone()).await? else {
            return Err(xhs_scroll_area_unresolved());
        };
        let outcome = dispatch_xhs_wheel(
            session,
            before,
            XHS_COMMENT_SCROLL_PX,
            cancellation,
            deadline_unix_ms,
            "comments",
        )
        .await?;
        let Some(after) = wait_for_xhs_scroll_settled(
            session,
            request.clone(),
            before.position,
            cancellation,
            deadline_unix_ms,
        )
        .await?
        else {
            return Err(xhs_scroll_area_unresolved());
        };
        let advanced = after.position != before.position;
        if advanced {
            moved = true;
        }
        // 两个 break 条件分列，不合并：上面那条是「手势没派完」，下面那条是「页面到底了」。
        // 合成一条就等于在代码里把两态压成一态，日后没人分得清停手的真实原因。
        if outcome == XhsWheelOutcome::Aborted {
            break;
        }
        if !advanced {
            break;
        }
        xhs_wait_checked(XHS_COMMENT_SCROLL_STEP_SETTLE_MS, cancellation).await?;
    }
    if !moved {
        return Ok(xhs_action_outcome(
            EffectPhase::Ambiguous,
            "scroll_comments",
            false,
            Some("no_scroll"),
            &note_id,
        ));
    }
    // 数不出来时回 `None`（读不到），MUST NOT 拿步数或 0 顶上。
    let rows = probe_xhs_scroll_area(session, request)
        .await?
        .and_then(|area| area.rows);
    Ok((
        EffectPhase::Confirmed,
        CommandOutput::ActionReceipt(Box::new(ActionReceipt {
            action: "scroll_comments".to_owned(),
            ok: true,
            reason: rows.map(|rows| format!("scrolled={rows}")),
            note_id: Some(note_id),
            observation: Some(ActionEvidence {
                surface: None,
                list_key: None,
                author: None,
                text_preview_head: None,
                reaction_text: None,
                article_index: rows,
            }),
            post_observation: None,
            group_observation: None,
            group_url: None,
            clicked: None,
            candidates: Vec::new(),
            // 同上：验证码取证只由验证码回执产出，这里显式 None、不用默认值展开绕过。
            type_report: None,
        })),
    ))
}

fn xhs_scroll_area_unresolved() -> EngineError {
    EngineError::new(
        ErrorCode::CdpError,
        "native Xiaohongshu scroll area could not be resolved",
    )
}

fn xhs_scroll_scan_invalid() -> EngineError {
    EngineError::new(
        ErrorCode::CdpError,
        "native Xiaohongshu scroll scan returned an invalid output",
    )
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
                        // 验证码走逐字原语、不含换行单元，这一态结构上不可达。
                        TextInputFailure::NewlineUnstable => "captcha_type_failed",
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
    endpoints: &EndpointResolver,
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
            session
                .reconnect(deadline_unix_ms, cancellation, endpoints)
                .await?;
            // `probe_once` 自带 `remaining_budget` 包裹，重试因此与首跑同受绝对截止线约束。
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
