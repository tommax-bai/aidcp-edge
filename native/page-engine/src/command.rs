use crate::error::{EngineError, ErrorCode};
use crate::protocol::Platform;
use serde::{Deserialize, Serialize};

const MAX_REASON_BYTES: usize = 512;
const MAX_ID_BYTES: usize = 256;
const MAX_TEXT_BYTES: usize = 32 * 1024;
const MAX_URL_BYTES: usize = 8 * 1024;
const MAX_LIST_ITEMS: usize = 100;

/// 可执行但**不进命令清单**的变体：每条必须写明理由。
/// 这张表是词表一致性检查的唯一豁免通道——新增变体若既不进清单也不进这里，检查即失败。
pub const MANIFEST_EXCLUDED_COMMAND_KINDS: &[(&str, &str)] = &[
    (
        "page_probe",
        "engine-internal page classification: never dispatched from a Cloud envelope, \
         no route key and no Cloud-facing receipt",
    ),
    (
        "facebook_auth_probe",
        "startup-only Facebook authentication observation: never dispatched from Cloud",
    ),
    (
        "facebook_auth_submit_login",
        "startup-only Facebook login stage: never dispatched from Cloud",
    ),
    (
        "facebook_auth_enter_totp",
        "startup-only Facebook TOTP entry stage: never dispatched from Cloud",
    ),
    (
        "facebook_auth_submit_totp",
        "startup-only Facebook TOTP submit stage: never dispatched from Cloud",
    ),
    (
        "facebook_auth_clear_totp",
        "startup-only Facebook stale-TOTP clearing stage: never dispatched from Cloud",
    ),
    (
        "facebook_auth_dismiss_warning",
        "startup-only Facebook warning dismissal stage: never dispatched from Cloud",
    ),
    (
        "facebook_auth_close_push_blocker",
        "startup-only Facebook push-blocker stage: never dispatched from Cloud",
    ),
    (
        "facebook_auth_confirm_remember_password",
        "startup-only Facebook remember-password stage: never dispatched from Cloud",
    ),
    (
        "facebook_auth_start_ad_data_review",
        "startup-only Facebook ad-data review introduction stage: never dispatched from Cloud",
    ),
];

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EmptyParams {}

pub type PageProbeParams = EmptyParams;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookAuthProbeParams {
    #[serde(default)]
    pub allow_auth_actions: bool,
    #[serde(default)]
    pub entered_totp_window_start_unix_ms: Option<u64>,
    #[serde(default)]
    pub entered_totp_window_end_unix_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookAuthSignalParams {
    pub signal_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookAuthTotpEntryParams {
    pub signal_id: String,
    pub totp_code: String,
    pub totp_window_start_unix_ms: u64,
    pub totp_window_end_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FacebookAuthTotpWindowParams {
    pub signal_id: String,
    pub totp_window_start_unix_ms: u64,
    pub totp_window_end_unix_ms: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReasonParams {
    #[serde(default)]
    pub reason: Option<String>,
}

/// `note_close` 的参数。**只有离页停留、没有动作前犹豫**：转发面（宿主 command-mapper）
/// 从来只投影 `reason` / `dwellMs`，曾经多声明的 `thinkMs` 是一个云端永远不会下发、
/// 引擎也永远读不到的**死字段**——它的唯一作用是把任何按「声明面」计数的检查喂绿。
/// 声明面与转发面的相等性由 `native_timing_declarations_match_the_declared_contract` 钉死。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TimingParams {
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub dwell_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanOperation {
    Click,
    Input,
    Scroll,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlanStep {
    pub action_id: String,
    pub op: PlanOperation,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlanExecuteParams {
    pub steps: Vec<PlanStep>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PageScrollParams {
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub target_surface: Option<FacebookBrowseSurface>,
    #[serde(default)]
    pub dwell_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FacebookBrowseSurface {
    Feed,
    Reels,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FeedRefreshParams {
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub think_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchSource {
    ExtractFromLiked,
    RandomFromInterests,
    NewConcept,
    Manager,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchSort {
    Comprehensive,
    Latest,
    MostLiked,
    MostCollected,
    MostCommented,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchTimeWindow {
    All,
    OneDay,
    OneWeek,
    HalfYear,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SearchExecuteParams {
    pub keyword: String,
    #[serde(default)]
    pub container: Option<String>,
    #[serde(default)]
    pub source: Option<SearchSource>,
    #[serde(default)]
    pub max_results: Option<u32>,
    #[serde(default)]
    pub sort: Option<SearchSort>,
    #[serde(default)]
    pub time_window: Option<SearchTimeWindow>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteSurface {
    Feed,
    Detail,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotePurpose {
    Read,
    Navigate,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteOpenSelection {
    FirstCommentableGroupPost,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NoteOpenParams {
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub index: Option<u32>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub surface: Option<NoteSurface>,
    #[serde(default)]
    pub purpose: Option<NotePurpose>,
    #[serde(default)]
    pub think_ms: Option<u64>,
    #[serde(default)]
    pub selection: Option<NoteOpenSelection>,
    #[serde(default)]
    pub container: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NavigationTarget {
    Feed,
    Search,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NavigationBackParams {
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub target_page: Option<NavigationTarget>,
    #[serde(default)]
    pub dwell_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NoteTraverseParams {
    pub note_id: String,
    #[serde(default)]
    pub count: Option<u32>,
    #[serde(default)]
    pub think_ms: Option<u64>,
    #[serde(default)]
    pub dwell_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProfileOpenParams {
    #[serde(default)]
    pub author_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub think_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IdentityCaptureParams {
    pub capture_id: String,
    pub account_id: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NotificationParams {
    #[serde(default)]
    pub think_ms: Option<u64>,
    #[serde(default)]
    pub scroll_max: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NoteInteractionParams {
    pub note_id: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub think_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FollowParams {
    #[serde(default)]
    pub author_id: Option<String>,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub think_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommentParams {
    pub note_id: String,
    pub text: String,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub group_chat_code: Option<String>,
    #[serde(default)]
    pub fast_return_to_feed: Option<bool>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub think_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LikeCommentParams {
    pub comment_anchor_id: String,
    pub note_id: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub think_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GroupJoinParams {
    pub group_url: String,
    #[serde(default)]
    pub click: Option<bool>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub think_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CaptchaCaptureParams {
    pub incident_id: String,
    #[serde(default)]
    pub max_image_width: Option<u32>,
    #[serde(default)]
    pub max_image_height: Option<u32>,
    #[serde(default)]
    pub quality: Option<u8>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CaptchaPoint {
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CaptchaClickParams {
    pub incident_id: String,
    pub snapshot_id: String,
    pub points: Vec<CaptchaPoint>,
    #[serde(default)]
    pub settle_ms: Option<u64>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub submit: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PublishIdentity {
    pub record_id: u64,
    pub seq: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PublishSelectModeParams {
    pub record_id: u64,
    pub seq: u32,
    #[serde(default)]
    pub option_kind: Option<String>,
    #[serde(default)]
    pub option_value: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PublishFieldParams {
    pub record_id: u64,
    pub seq: u32,
    pub field_type: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PublishCandidateParams {
    pub record_id: u64,
    pub seq: u32,
    pub candidate_kind: String,
    pub value: String,
    pub candidates: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PublishFileParams {
    pub record_id: u64,
    pub seq: u32,
    pub path: String,
    pub image_index: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PublishCoverParams {
    pub record_id: u64,
    pub seq: u32,
    pub image_index: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PublishOptionParams {
    pub record_id: u64,
    pub seq: u32,
    pub option_kind: String,
    pub option_value: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PublishScheduleParams {
    pub record_id: u64,
    pub seq: u32,
    pub publish_time: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PublishCaptureParams {
    pub record_id: u64,
    pub seq: u32,
    #[serde(default)]
    pub scheduled_title: Option<String>,
    #[serde(default)]
    pub scheduled_platform_id: Option<String>,
    #[serde(default)]
    pub publish_time: Option<u64>,
}

/// 命令枚举与词表的**唯一**定义处。词表从这里穷举导出，MUST NOT 再在别处手抄一份数组——
/// 手抄的那份只会跟自己比对，新增变体照样能只加枚举、检查照样绿（`page_probe` 漂了半年就是这么来的）。
/// 每个变体只写一次 kind 字面量；`kind_matches_serde_naming` 断言它与 serde 的 snake_case 改名一致，
/// `kind()` 由同一张表生成，穷举缺一条编译就不过。
macro_rules! native_commands {
    ($($variant:ident($params:ty) => $kind:literal,)+) => {
        #[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
        #[serde(tag = "kind", content = "params", rename_all = "snake_case")]
        pub enum NativeCommand {
            $($variant($params),)+
        }

        /// 引擎能执行的全部命令 kind（含不进命令清单的那些，见 `MANIFEST_EXCLUDED_COMMAND_KINDS`）。
        pub const NATIVE_COMMAND_KINDS: &[&str] = &[$($kind,)+];

        /// 变体名，仅供词表一致性检查校验 kind 字面量用。
        #[cfg(test)]
        const NATIVE_COMMAND_VARIANTS: &[&str] = &[$(stringify!($variant),)+];

        impl NativeCommand {
            pub fn kind(&self) -> &'static str {
                match self {
                    $(Self::$variant(_) => $kind,)+
                }
            }
        }
    };
}

native_commands! {
    PageProbe(PageProbeParams) => "page_probe",
    FacebookAuthProbe(FacebookAuthProbeParams) => "facebook_auth_probe",
    FacebookAuthSubmitLogin(FacebookAuthSignalParams) => "facebook_auth_submit_login",
    FacebookAuthEnterTotp(FacebookAuthTotpEntryParams) => "facebook_auth_enter_totp",
    FacebookAuthSubmitTotp(FacebookAuthTotpWindowParams) => "facebook_auth_submit_totp",
    FacebookAuthClearTotp(FacebookAuthTotpWindowParams) => "facebook_auth_clear_totp",
    FacebookAuthDismissWarning(FacebookAuthSignalParams) => "facebook_auth_dismiss_warning",
    FacebookAuthClosePushBlocker(FacebookAuthSignalParams) => "facebook_auth_close_push_blocker",
    FacebookAuthConfirmRememberPassword(FacebookAuthSignalParams) => "facebook_auth_confirm_remember_password",
    FacebookAuthStartAdDataReview(FacebookAuthSignalParams) => "facebook_auth_start_ad_data_review",
    PlanExecute(PlanExecuteParams) => "plan_execute",
    SessionStop(ReasonParams) => "session_stop",
    BrowseNext(ReasonParams) => "browse_next",
    BrowseScroll(ReasonParams) => "browse_scroll",
    PageScroll(PageScrollParams) => "page_scroll",
    FeedRefresh(FeedRefreshParams) => "feed_refresh",
    SearchExecute(SearchExecuteParams) => "search_execute",
    NoteOpen(NoteOpenParams) => "note_open",
    NoteClose(TimingParams) => "note_close",
    NavigationBack(NavigationBackParams) => "navigation_back",
    NoteBrowseImages(NoteTraverseParams) => "note_browse_images",
    NoteScrollComments(NoteTraverseParams) => "note_scroll_comments",
    ProfileOpen(ProfileOpenParams) => "profile_open",
    NotificationOpen(NotificationParams) => "notification_open",
    NotificationBrowseComments(NotificationParams) => "notification_browse_comments",
    NotificationBrowseLikes(NotificationParams) => "notification_browse_likes",
    NotificationBrowseFollows(NotificationParams) => "notification_browse_follows",
    NotificationBackHome(NotificationParams) => "notification_back_home",
    InteractionLike(NoteInteractionParams) => "interaction_like",
    InteractionCollect(NoteInteractionParams) => "interaction_collect",
    InteractionFollow(FollowParams) => "interaction_follow",
    InteractionComment(CommentParams) => "interaction_comment",
    InteractionLikeComment(LikeCommentParams) => "interaction_like_comment",
    GroupJoin(GroupJoinParams) => "group_join",
    WechatCaptureSession(EmptyParams) => "wechat_capture_session",
    IdentityBootstrap(EmptyParams) => "identity_bootstrap",
    IdentityReadCurrent(IdentityCaptureParams) => "identity_read_current",
    IdentityReadSelfProfile(IdentityCaptureParams) => "identity_read_self_profile",
    CaptchaCapture(CaptchaCaptureParams) => "captcha_capture",
    CaptchaClick(CaptchaClickParams) => "captcha_click",
    PublishNavigateEntry(PublishIdentity) => "publish_navigate_entry",
    PublishSelectMode(PublishSelectModeParams) => "publish_select_mode",
    PublishUploadImage(PublishFileParams) => "publish_upload_image",
    PublishSetCover(PublishCoverParams) => "publish_set_cover",
    PublishFillField(PublishFieldParams) => "publish_fill_field",
    PublishAddWithCandidate(PublishCandidateParams) => "publish_add_with_candidate",
    PublishSetOption(PublishOptionParams) => "publish_set_option",
    PublishSetSchedule(PublishScheduleParams) => "publish_set_schedule",
    PublishSubmit(PublishIdentity) => "publish_submit",
    PublishCapturePostId(PublishCaptureParams) => "publish_capture_post_id",
    PublishCaptureScheduled(PublishCaptureParams) => "publish_capture_scheduled",
    PublishReconcileScheduled(PublishCaptureParams) => "publish_reconcile_scheduled",
}

impl NativeCommand {
    pub fn supports_platform(&self, platform: Platform) -> bool {
        use NativeCommand::*;
        match platform {
            Platform::Xiaohongshu => !matches!(
                self,
                GroupJoin(_)
                    | WechatCaptureSession(_)
                    | IdentityBootstrap(_)
                    | IdentityReadCurrent(_)
                    | FacebookAuthProbe(_)
                    | FacebookAuthSubmitLogin(_)
                    | FacebookAuthEnterTotp(_)
                    | FacebookAuthSubmitTotp(_)
                    | FacebookAuthClearTotp(_)
                    | FacebookAuthDismissWarning(_)
                    | FacebookAuthClosePushBlocker(_)
                    | FacebookAuthConfirmRememberPassword(_)
                    | FacebookAuthStartAdDataReview(_)
            ),
            Platform::Facebook => crate::facebook::capability::owner(self).is_some(),
            Platform::WechatChannels => matches!(self, WechatCaptureSession(_)),
        }
    }

    pub fn may_write(&self) -> bool {
        match self {
            Self::GroupJoin(params) => params.click == Some(true),
            command => !matches!(
                command,
                Self::PageProbe(_)
                    | Self::FacebookAuthProbe(_)
                    | Self::PublishCapturePostId(_)
                    | Self::PublishCaptureScheduled(_)
                    | Self::PublishReconcileScheduled(_)
                    | Self::CaptchaCapture(_)
                    | Self::WechatCaptureSession(_)
                    | Self::IdentityBootstrap(_)
                    | Self::IdentityReadCurrent(_)
            ),
        }
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        match self {
            Self::PageProbe(_)
            | Self::PublishNavigateEntry(_)
            | Self::PublishSubmit(_)
            | Self::WechatCaptureSession(_) => Ok(()),
            Self::IdentityBootstrap(_) => Ok(()),
            Self::FacebookAuthProbe(params) => match (
                params.entered_totp_window_start_unix_ms,
                params.entered_totp_window_end_unix_ms,
            ) {
                (None, None) => Ok(()),
                (Some(start), Some(end)) => validate_totp_window(start, end),
                _ => Err(invalid(
                    "Facebook entered TOTP window requires both start and end",
                )),
            },
            Self::FacebookAuthSubmitLogin(params)
            | Self::FacebookAuthDismissWarning(params)
            | Self::FacebookAuthClosePushBlocker(params)
            | Self::FacebookAuthConfirmRememberPassword(params)
            | Self::FacebookAuthStartAdDataReview(params) => {
                validate_facebook_auth_signal_id(&params.signal_id)
            }
            Self::FacebookAuthEnterTotp(params) => {
                validate_facebook_auth_signal_id(&params.signal_id)?;
                if params.totp_code.len() != 6
                    || !params
                        .totp_code
                        .bytes()
                        .all(|character| character.is_ascii_digit())
                {
                    return Err(invalid("invalid Facebook TOTP code"));
                }
                validate_totp_window(
                    params.totp_window_start_unix_ms,
                    params.totp_window_end_unix_ms,
                )
            }
            Self::FacebookAuthSubmitTotp(params) | Self::FacebookAuthClearTotp(params) => {
                validate_facebook_auth_signal_id(&params.signal_id)?;
                validate_totp_window(
                    params.totp_window_start_unix_ms,
                    params.totp_window_end_unix_ms,
                )
            }
            Self::IdentityReadCurrent(params) | Self::IdentityReadSelfProfile(params) => {
                validate_required(
                    &params.capture_id,
                    MAX_ID_BYTES,
                    "invalid identity capture id",
                )?;
                validate_required(
                    &params.account_id,
                    MAX_ID_BYTES,
                    "invalid identity account id",
                )
            }
            Self::PlanExecute(params) => {
                validate_list(&params.steps)?;
                for step in &params.steps {
                    validate_plan_action(&step.action_id)?;
                    validate_optional(
                        &step.value,
                        MAX_TEXT_BYTES,
                        "plan value exceeds protocol limit",
                    )?;
                }
                Ok(())
            }
            Self::SessionStop(params) | Self::BrowseNext(params) | Self::BrowseScroll(params) => {
                validate_optional(
                    &params.reason,
                    MAX_REASON_BYTES,
                    "reason exceeds protocol limit",
                )
            }
            Self::PageScroll(params) => validate_optional(
                &params.reason,
                MAX_REASON_BYTES,
                "reason exceeds protocol limit",
            ),
            Self::FeedRefresh(params) => validate_optional(
                &params.reason,
                MAX_REASON_BYTES,
                "reason exceeds protocol limit",
            ),
            Self::SearchExecute(params) => {
                validate_required(&params.keyword, 512, "invalid search keyword")?;
                validate_optional(
                    &params.container,
                    MAX_URL_BYTES,
                    "search container exceeds protocol limit",
                )?;
                if params
                    .max_results
                    .is_some_and(|value| value == 0 || value > 100)
                {
                    return Err(invalid("invalid search result bound"));
                }
                Ok(())
            }
            Self::NoteOpen(params) => {
                validate_optional(
                    &params.note_id,
                    MAX_ID_BYTES,
                    "note id exceeds protocol limit",
                )?;
                validate_optional(
                    &params.url,
                    MAX_URL_BYTES,
                    "note URL exceeds protocol limit",
                )?;
                validate_optional(
                    &params.reason,
                    MAX_REASON_BYTES,
                    "reason exceeds protocol limit",
                )?;
                validate_optional(
                    &params.container,
                    MAX_URL_BYTES,
                    "note container exceeds protocol limit",
                )?;
                if params.selection.is_some()
                    && params
                        .container
                        .as_ref()
                        .is_none_or(|value| value.is_empty())
                {
                    return Err(invalid("first-post selection requires a group container"));
                }
                Ok(())
            }
            Self::NoteClose(params) => validate_optional(
                &params.reason,
                MAX_REASON_BYTES,
                "reason exceeds protocol limit",
            ),
            Self::NavigationBack(params) => validate_optional(
                &params.reason,
                MAX_REASON_BYTES,
                "reason exceeds protocol limit",
            ),
            Self::NoteBrowseImages(params) | Self::NoteScrollComments(params) => {
                validate_required(&params.note_id, MAX_ID_BYTES, "invalid note id")?;
                if params.count.is_some_and(|count| count == 0 || count > 100) {
                    return Err(invalid("invalid traversal count"));
                }
                Ok(())
            }
            Self::ProfileOpen(params) => {
                validate_optional(
                    &params.author_id,
                    MAX_ID_BYTES,
                    "author id exceeds protocol limit",
                )?;
                validate_optional(
                    &params.reason,
                    MAX_REASON_BYTES,
                    "reason exceeds protocol limit",
                )
            }
            Self::NotificationOpen(params)
            | Self::NotificationBrowseComments(params)
            | Self::NotificationBrowseLikes(params)
            | Self::NotificationBrowseFollows(params)
            | Self::NotificationBackHome(params) => {
                if params
                    .scroll_max
                    .is_some_and(|count| count == 0 || count > 100)
                {
                    return Err(invalid("invalid notification scroll bound"));
                }
                Ok(())
            }
            Self::InteractionLike(params) | Self::InteractionCollect(params) => {
                validate_required(&params.note_id, MAX_ID_BYTES, "invalid note id")?;
                validate_optional(
                    &params.reason,
                    MAX_REASON_BYTES,
                    "reason exceeds protocol limit",
                )
            }
            Self::InteractionFollow(params) => {
                validate_optional(
                    &params.author_id,
                    MAX_ID_BYTES,
                    "author id exceeds protocol limit",
                )?;
                validate_optional(
                    &params.note_id,
                    MAX_ID_BYTES,
                    "note id exceeds protocol limit",
                )?;
                validate_optional(
                    &params.reason,
                    MAX_REASON_BYTES,
                    "reason exceeds protocol limit",
                )
            }
            Self::InteractionComment(params) => {
                validate_required(&params.note_id, MAX_ID_BYTES, "invalid note id")?;
                validate_required(&params.text, MAX_TEXT_BYTES, "invalid comment text")?;
                validate_optional(
                    &params.account_id,
                    MAX_ID_BYTES,
                    "comment account id exceeds protocol limit",
                )?;
                validate_optional(
                    &params.group_chat_code,
                    1_024,
                    "group code exceeds protocol limit",
                )
            }
            Self::InteractionLikeComment(params) => {
                validate_required(&params.note_id, MAX_ID_BYTES, "invalid note id")?;
                validate_required(
                    &params.comment_anchor_id,
                    MAX_ID_BYTES,
                    "invalid comment anchor id",
                )
            }
            Self::GroupJoin(params) => {
                validate_required(
                    &params.group_url,
                    MAX_URL_BYTES,
                    "invalid Facebook group URL",
                )?;
                validate_optional(
                    &params.reason,
                    MAX_REASON_BYTES,
                    "reason exceeds protocol limit",
                )
            }
            Self::CaptchaCapture(params) => {
                validate_required(&params.incident_id, MAX_ID_BYTES, "invalid incident id")
            }
            Self::CaptchaClick(params) => {
                validate_required(&params.incident_id, MAX_ID_BYTES, "invalid incident id")?;
                validate_required(&params.snapshot_id, MAX_ID_BYTES, "invalid snapshot id")?;
                if params.points.is_empty() || params.points.len() > 20 {
                    return Err(invalid("invalid captcha point count"));
                }
                if params.points.iter().any(|point| {
                    !point.x.is_finite()
                        || !point.y.is_finite()
                        || !(0.0..=1.0).contains(&point.x)
                        || !(0.0..=1.0).contains(&point.y)
                }) {
                    return Err(invalid("invalid captcha point"));
                }
                if params
                    .text
                    .as_deref()
                    .is_some_and(|text| !crate::input::valid_captcha_text(text))
                {
                    return Err(invalid("invalid captcha text"));
                }
                if params
                    .submit
                    .as_deref()
                    .is_some_and(|submit| submit != "enter")
                {
                    return Err(invalid("invalid captcha submit gesture"));
                }
                Ok(())
            }
            Self::PublishUploadImage(params) => {
                validate_required(&params.path, MAX_URL_BYTES, "invalid authorized file path")?;
                if params.image_index > 99 {
                    return Err(invalid("invalid publish image index"));
                }
                Ok(())
            }
            Self::PublishSetCover(params) => {
                if params.image_index > 99 {
                    return Err(invalid("invalid publish cover image index"));
                }
                Ok(())
            }
            Self::PublishFillField(params) => {
                if !matches!(params.field_type.as_str(), "title" | "content") {
                    return Err(invalid("invalid publish field type"));
                }
                validate_required(&params.value, MAX_TEXT_BYTES, "invalid publish field value")
            }
            Self::PublishAddWithCandidate(params) => {
                validate_required(&params.candidate_kind, 64, "invalid publish candidate kind")?;
                validate_required(&params.value, 2_000, "invalid publish candidate value")?;
                validate_string_list(&params.candidates, 50, 2_000, "invalid publish candidates")
            }
            Self::PublishSelectMode(params) => {
                validate_optional(
                    &params.option_kind,
                    128,
                    "invalid publish select-mode option kind",
                )?;
                validate_optional(
                    &params.option_value,
                    512,
                    "invalid publish select-mode option value",
                )
            }
            Self::PublishSetOption(params) => {
                validate_required(&params.option_kind, 128, "invalid publish option kind")?;
                validate_required(&params.option_value, 512, "invalid publish option value")
            }
            Self::PublishSetSchedule(params) => {
                if params.publish_time == 0 {
                    return Err(invalid("invalid publish schedule time"));
                }
                Ok(())
            }
            Self::PublishCapturePostId(params)
            | Self::PublishCaptureScheduled(params)
            | Self::PublishReconcileScheduled(params) => {
                validate_optional(
                    &params.scheduled_title,
                    2_000,
                    "scheduled title exceeds protocol limit",
                )?;
                validate_optional(
                    &params.scheduled_platform_id,
                    MAX_ID_BYTES,
                    "scheduled platform id exceeds protocol limit",
                )
            }
        }
    }
}

fn validate_plan_action(action_id: &str) -> Result<(), EngineError> {
    const ALLOWLIST: &[&str] = &[
        "note.like_button",
        "note.collect_button",
        "note.follow_button",
        "note.comment_input",
        "page.scroll",
    ];
    if ALLOWLIST.contains(&action_id) {
        Ok(())
    } else {
        Err(invalid("legacy plan action is not allowlisted"))
    }
}

fn validate_string_list(
    values: &[String],
    max_items: usize,
    max_bytes: usize,
    message: &'static str,
) -> Result<(), EngineError> {
    if values.len() > max_items || values.iter().any(|value| value.len() > max_bytes) {
        return Err(invalid(message));
    }
    Ok(())
}

fn validate_list<T>(values: &[T]) -> Result<(), EngineError> {
    if values.len() > MAX_LIST_ITEMS {
        Err(invalid("command list exceeds protocol limit"))
    } else {
        Ok(())
    }
}

fn validate_required(
    value: &str,
    max_bytes: usize,
    message: &'static str,
) -> Result<(), EngineError> {
    if value.is_empty() || value.len() > max_bytes {
        Err(invalid(message))
    } else {
        Ok(())
    }
}

fn validate_optional(
    value: &Option<String>,
    max_bytes: usize,
    message: &'static str,
) -> Result<(), EngineError> {
    if value.as_ref().is_some_and(|value| value.len() > max_bytes) {
        Err(invalid(message))
    } else {
        Ok(())
    }
}

fn validate_facebook_auth_signal_id(value: &str) -> Result<(), EngineError> {
    const PREFIX: &str = "aidcp:facebook-auth:v1:";
    let Some(digest) = value.strip_prefix(PREFIX) else {
        return Err(invalid("invalid Facebook auth signal id"));
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
    {
        return Err(invalid("invalid Facebook auth signal id"));
    }
    Ok(())
}

fn validate_totp_window(start: u64, end: u64) -> Result<(), EngineError> {
    if !start.is_multiple_of(30_000) || end != start.saturating_add(30_000) {
        return Err(invalid("invalid Facebook TOTP window"));
    }
    Ok(())
}

fn invalid(message: &'static str) -> EngineError {
    EngineError::new(ErrorCode::InvalidRequest, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn parses_representative_high_level_commands() {
        let search: NativeCommand = serde_json::from_str(
            r#"{"kind":"search_execute","params":{"keyword":"coffee","sort":"most_collected","timeWindow":"one_week"}}"#,
        )
        .expect("search command");
        search.validate().expect("valid search");

        let publish: NativeCommand = serde_json::from_str(
            r#"{"kind":"publish_fill_field","params":{"recordId":1,"seq":2,"fieldType":"content","value":"bounded content"}}"#,
        )
        .expect("publish command");
        publish.validate().expect("valid publish command");
    }

    #[test]
    fn parses_and_validates_first_commentable_group_post_selection() {
        let command: NativeCommand = serde_json::from_str(
            r#"{"kind":"note_open","params":{"selection":"first_commentable_group_post","container":"https://www.facebook.com/groups/945390701793119"}}"#,
        )
        .expect("first-post command");
        command.validate().expect("valid first-post command");
        assert!(matches!(
            command,
            NativeCommand::NoteOpen(NoteOpenParams {
                selection: Some(NoteOpenSelection::FirstCommentableGroupPost),
                ..
            })
        ));

        let missing_container: NativeCommand = serde_json::from_str(
            r#"{"kind":"note_open","params":{"selection":"first_commentable_group_post"}}"#,
        )
        .expect("typed command");
        assert_eq!(
            missing_container
                .validate()
                .expect_err("container is required")
                .code,
            ErrorCode::InvalidRequest
        );
    }

    #[test]
    fn group_join_write_intent_follows_the_explicit_click_flag() {
        for (click, expected) in [(Some(false), false), (None, false), (Some(true), true)] {
            let command = NativeCommand::GroupJoin(GroupJoinParams {
                group_url: "https://www.facebook.com/groups/42".to_owned(),
                click,
                reason: None,
                think_ms: None,
            });
            assert_eq!(command.may_write(), expected);
        }
    }

    #[test]
    fn rejects_unknown_surface_and_free_form_plan_actions() {
        assert!(
            serde_json::from_str::<NativeCommand>(
                r#"{"kind":"runtime_evaluate","params":{"script":"document.body"}}"#,
            )
            .is_err()
        );
        let plan: NativeCommand = serde_json::from_str(
            r#"{"kind":"plan_execute","params":{"steps":[{"actionId":"arbitrary.selector","op":"click"}]}}"#,
        )
        .expect("typed plan");
        assert_eq!(
            plan.validate().expect_err("plan allowlist").code,
            ErrorCode::InvalidRequest
        );
    }

    #[test]
    fn rejects_out_of_bounds_sensitive_payloads() {
        let captcha: NativeCommand = serde_json::from_str(
            r#"{"kind":"captcha_click","params":{"incidentId":"i","snapshotId":"s","points":[{"x":1.5,"y":0.5}],"text":"secret"}}"#,
        )
        .expect("typed captcha");
        assert_eq!(
            captcha.validate().expect_err("point bounds").code,
            ErrorCode::InvalidRequest
        );

        for text in ["", "验证码", "ab\ncd"] {
            let captcha: NativeCommand = serde_json::from_value(serde_json::json!({
                "kind": "captcha_click",
                "params": {
                    "incidentId": "i",
                    "snapshotId": "s",
                    "points": [{"x": 0.5, "y": 0.5}],
                    "text": text
                }
            }))
            .expect("typed captcha");
            assert_eq!(
                captcha.validate().expect_err("captcha text boundary").code,
                ErrorCode::InvalidRequest
            );
        }
        let too_long = "x".repeat(25);
        let captcha: NativeCommand = serde_json::from_value(serde_json::json!({
            "kind": "captcha_click",
            "params": {
                "incidentId": "i",
                "snapshotId": "s",
                "points": [{"x": 0.5, "y": 0.5}],
                "text": too_long
            }
        }))
        .expect("typed captcha");
        assert_eq!(
            captcha.validate().expect_err("captcha text length").code,
            ErrorCode::InvalidRequest
        );
    }

    #[test]
    fn identity_commands_are_platform_specific_and_legacy_direct_is_rejected() {
        let current: NativeCommand = serde_json::from_str(
            r#"{"kind":"identity_read_current","params":{"captureId":"c1","accountId":"61591824155856"}}"#,
        )
        .expect("current identity command");
        assert!(current.supports_platform(Platform::Facebook));
        assert!(!current.supports_platform(Platform::Xiaohongshu));

        let self_profile: NativeCommand = serde_json::from_str(
            r#"{"kind":"identity_read_self_profile","params":{"captureId":"c2","accountId":"author_123"}}"#,
        )
        .expect("self profile identity command");
        assert!(self_profile.supports_platform(Platform::Xiaohongshu));
        assert!(!self_profile.supports_platform(Platform::Facebook));

        assert!(
            serde_json::from_str::<NativeCommand>(
                r#"{"kind":"profile_open","params":{"authorId":"author_123","direct":true}}"#,
            )
            .is_err()
        );
        let ordinary_profile: NativeCommand =
            serde_json::from_str(r#"{"kind":"profile_open","params":{"authorId":"author_123"}}"#)
                .expect("ordinary profile command");
        assert!(ordinary_profile.supports_platform(Platform::Xiaohongshu));
        assert!(!ordinary_profile.supports_platform(Platform::Facebook));
    }

    fn manifest_kinds() -> Vec<String> {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../command-manifest.json"))
                .expect("command manifest");
        let mut kinds: Vec<String> = manifest["commands"]
            .as_array()
            .expect("commands")
            .iter()
            .map(|command| {
                command["nativeKind"]
                    .as_str()
                    .expect("native kind")
                    .to_owned()
            })
            .collect();
        kinds.sort();
        kinds
    }

    fn snake_case(variant: &str) -> String {
        let mut out = String::with_capacity(variant.len() + 8);
        for (index, character) in variant.char_indices() {
            if character.is_ascii_uppercase() {
                if index > 0 {
                    out.push('_');
                }
                out.push(character.to_ascii_lowercase());
            } else {
                out.push(character);
            }
        }
        out
    }

    /// 词表漂移判据（两个方向）：枚举里有而清单与排除表都没有 → `unaccounted`；
    /// 清单里有而枚举里没有 → `orphan`。返回空 vec 才算对上。
    fn vocabulary_drift(
        enum_kinds: &[&str],
        manifest: &[String],
        excluded: &BTreeSet<&str>,
    ) -> Vec<String> {
        let enum_set: BTreeSet<&str> = enum_kinds.iter().copied().collect();
        let manifest_set: BTreeSet<&str> = manifest.iter().map(String::as_str).collect();
        let mut drift: Vec<String> = enum_kinds
            .iter()
            .filter(|kind| !manifest_set.contains(*kind) && !excluded.contains(*kind))
            .map(|kind| format!("unaccounted:{kind}"))
            .collect();
        drift.extend(
            manifest
                .iter()
                .filter(|kind| !enum_set.contains(kind.as_str()))
                .map(|kind| format!("orphan:{kind}")),
        );
        drift.sort();
        drift
    }

    /// 词表的两侧现在是：**枚举穷举导出的 kind** 与命令清单。
    /// 差集必须恰好等于显式排除表——新增变体而不动清单与排除表，这条就会失败。
    #[test]
    fn every_enum_kind_is_either_in_the_manifest_or_in_the_declared_exclusion_table() {
        let manifest = manifest_kinds();
        let excluded: BTreeSet<&str> = MANIFEST_EXCLUDED_COMMAND_KINDS
            .iter()
            .map(|(kind, _)| *kind)
            .collect();

        assert_eq!(
            vocabulary_drift(NATIVE_COMMAND_KINDS, &manifest, &excluded),
            Vec::<String>::new(),
            "enum-derived vocabulary vs manifest"
        );

        // 反向：排除表不许冻结一条其实已经进了清单的 kind，也不许冻结不存在的 kind。
        let manifest_set: BTreeSet<&str> = manifest.iter().map(String::as_str).collect();
        let all: BTreeSet<&str> = NATIVE_COMMAND_KINDS.iter().copied().collect();
        for (kind, reason) in MANIFEST_EXCLUDED_COMMAND_KINDS {
            assert!(all.contains(kind), "{kind} is not an executable command");
            assert!(
                !manifest_set.contains(kind),
                "{kind} is in the manifest and must not be excluded"
            );
            assert!(!reason.is_empty(), "{kind} must record why it is excluded");
        }
        assert_eq!(
            excluded,
            BTreeSet::from([
                "page_probe",
                "facebook_auth_probe",
                "facebook_auth_submit_login",
                "facebook_auth_enter_totp",
                "facebook_auth_submit_totp",
                "facebook_auth_clear_totp",
                "facebook_auth_dismiss_warning",
                "facebook_auth_close_push_blocker",
                "facebook_auth_confirm_remember_password",
                "facebook_auth_start_ad_data_review",
            ]),
            "the exclusion table changed; record the reason and update this assertion"
        );
        assert_eq!(NATIVE_COMMAND_KINDS.len(), manifest.len() + excluded.len());
    }

    /// 失败优先：在枚举里新增一个变体、既不进清单也不进排除表时，词表检查必须失败。
    /// 反向也一样——清单里留下一条枚举已经删掉的命令，同样必须失败。
    #[test]
    fn vocabulary_check_fails_when_a_new_variant_skips_the_manifest_and_the_exclusion_table() {
        let manifest = manifest_kinds();
        let excluded: BTreeSet<&str> = MANIFEST_EXCLUDED_COMMAND_KINDS
            .iter()
            .map(|(kind, _)| *kind)
            .collect();

        let mut with_new_variant = NATIVE_COMMAND_KINDS.to_vec();
        with_new_variant.push("hypothetical_new_command");
        assert_eq!(
            vocabulary_drift(&with_new_variant, &manifest, &excluded),
            vec!["unaccounted:hypothetical_new_command".to_owned()],
        );

        let mut manifest_with_ghost = manifest.clone();
        manifest_with_ghost.push("retired_command".to_owned());
        assert_eq!(
            vocabulary_drift(NATIVE_COMMAND_KINDS, &manifest_with_ghost, &excluded),
            vec!["orphan:retired_command".to_owned()],
        );

        // 排除表放行的那条，必须真的被放行（否则这条检查只是恒失败）。
        assert_eq!(
            vocabulary_drift(NATIVE_COMMAND_KINDS, &manifest, &excluded),
            Vec::<String>::new(),
        );
    }

    /// kind 字面量必须与 serde 的 `rename_all = "snake_case"` 改名一致——
    /// 写错一个字面量，线路上认的名字和 `kind()` 回的名字就会分叉，而两边各自都编译得过。
    #[test]
    fn kind_matches_serde_naming() {
        assert_eq!(NATIVE_COMMAND_VARIANTS.len(), NATIVE_COMMAND_KINDS.len());
        for (variant, kind) in NATIVE_COMMAND_VARIANTS
            .iter()
            .zip(NATIVE_COMMAND_KINDS.iter())
        {
            assert_eq!(&snake_case(variant), kind, "{variant}");
        }
        let typed: NativeCommand =
            serde_json::from_str(r#"{"kind":"note_browse_images","params":{"noteId":"n1"}}"#)
                .expect("typed command");
        assert_eq!(typed.kind(), "note_browse_images");
        assert_eq!(
            serde_json::to_value(&typed).expect("serialized")["kind"],
            serde_json::Value::String("note_browse_images".to_owned())
        );
    }

    /// 清单的 `effect` / `cancellation` 必须落在封闭取值集里，且与引擎侧的写判定一致：
    /// 声明为写的命令，引擎必须也当写处理（否则不可逆动作会绕开提交窗口与写保护）；
    /// 声明为读的命令，引擎必须确实只读。
    #[test]
    fn manifest_effect_and_cancellation_agree_with_the_engine_write_judgement() {
        const EFFECTS: [&str; 6] = [
            "read",
            "navigation",
            "coordination",
            "mixed",
            "draft_write",
            "platform_write",
        ];
        const CANCELLATIONS: [&str; 4] = [
            "safe_points",
            "immediate_before_next_dispatch",
            "atomic_input_then_safe_point",
            "atomic_dispatch_then_verify",
        ];
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../command-manifest.json"))
                .expect("command manifest");
        for command in manifest["commands"].as_array().expect("commands") {
            let kind = command["nativeKind"].as_str().expect("native kind");
            let effect = command["effect"].as_str().expect("effect");
            let cancellation = command["cancellation"].as_str().expect("cancellation");
            assert!(EFFECTS.contains(&effect), "{kind} declares effect {effect}");
            assert!(
                CANCELLATIONS.contains(&cancellation),
                "{kind} declares cancellation {cancellation}"
            );
            if effect == "platform_write" {
                assert_eq!(
                    cancellation, "atomic_dispatch_then_verify",
                    "{kind} writes to the platform and must not claim a later safe point"
                );
            }
            if effect == "draft_write" {
                assert_eq!(
                    cancellation, "atomic_input_then_safe_point",
                    "{kind} writes into a draft and must name its atomic input"
                );
            }
            let Some(sample) = sample_command(kind) else {
                continue;
            };
            if matches!(effect, "platform_write" | "draft_write") {
                assert!(sample.may_write(), "{kind} declares a write effect");
            }
            if effect == "read" {
                assert!(!sample.may_write(), "{kind} declares a read-only effect");
            }
        }
    }

    /// 供上面那条检查用的最小合法命令样本。带参数校验的命令给一份能过 `validate()` 的最小参数；
    /// 造不出样本的返回 `None`（该 kind 只做取值集与取消语义检查）。
    fn sample_command(kind: &str) -> Option<NativeCommand> {
        let command: NativeCommand = serde_json::from_value(
            serde_json::json!({"kind": kind, "params": sample_params(kind)}),
        )
        .ok()?;
        command.validate().ok()?;
        Some(command)
    }

    /// 每个 kind 的最小合法参数。时间指令门禁把它当**基线**：在基线之上注入 `thinkMs` /
    /// `dwellMs` 再反序列化，能过就说明该参数结构体真的声明了这个字段（所有结构体都带
    /// `deny_unknown_fields`，所以这是一条恒真判据，不需要任何文本匹配或手抄名单）。
    fn sample_params(kind: &str) -> serde_json::Value {
        match kind {
            "facebook_auth_submit_login"
            | "facebook_auth_dismiss_warning"
            | "facebook_auth_close_push_blocker"
            | "facebook_auth_confirm_remember_password"
            | "facebook_auth_start_ad_data_review" => serde_json::json!({
                "signalId": format!("aidcp:facebook-auth:v1:{}", "a".repeat(64))
            }),
            "facebook_auth_enter_totp" => serde_json::json!({
                "signalId": format!("aidcp:facebook-auth:v1:{}", "a".repeat(64)),
                "totpCode": "123456",
                "totpWindowStartUnixMs": 1_800_000_000_000_u64,
                "totpWindowEndUnixMs": 1_800_000_030_000_u64
            }),
            "facebook_auth_submit_totp" | "facebook_auth_clear_totp" => serde_json::json!({
                "signalId": format!("aidcp:facebook-auth:v1:{}", "a".repeat(64)),
                "totpWindowStartUnixMs": 1_800_000_000_000_u64,
                "totpWindowEndUnixMs": 1_800_000_030_000_u64
            }),
            "plan_execute" => serde_json::json!({"steps": []}),
            "note_browse_images" | "note_scroll_comments" => serde_json::json!({"noteId": "n1"}),
            "interaction_like" | "interaction_collect" => serde_json::json!({"noteId": "n1"}),
            "group_join" => serde_json::json!({
                "groupUrl": "https://www.facebook.com/groups/42",
                "click": true
            }),
            "identity_read_current" | "identity_read_self_profile" => {
                serde_json::json!({"captureId": "c1", "accountId": "a1"})
            }
            "interaction_comment" => {
                serde_json::json!({"noteId": "n1", "text": "hi", "accountId": "a1"})
            }
            "interaction_like_comment" => {
                serde_json::json!({"commentAnchorId": "c1", "noteId": "n1"})
            }
            "interaction_follow" => serde_json::json!({"authorId": "a1"}),
            "profile_open" => serde_json::json!({"authorId": "a1"}),
            "search_execute" => serde_json::json!({"keyword": "coffee"}),
            "captcha_capture" => serde_json::json!({"incidentId": "i1"}),
            "captcha_click" => serde_json::json!({
                "incidentId": "i1",
                "snapshotId": "s1",
                "points": [{"x": 0.5, "y": 0.5}]
            }),
            "publish_select_mode" => serde_json::json!({"recordId": 1, "seq": 1}),
            "publish_upload_image" => {
                serde_json::json!({"recordId": 1, "seq": 1, "path": "/tmp/a.png", "imageIndex": 0})
            }
            "publish_set_cover" => {
                serde_json::json!({"recordId": 1, "seq": 1, "imageIndex": 0})
            }
            "publish_fill_field" => {
                serde_json::json!({"recordId": 1, "seq": 1, "fieldType": "title", "value": "t"})
            }
            "publish_add_with_candidate" => serde_json::json!({
                "recordId": 1,
                "seq": 1,
                "candidateKind": "topic",
                "value": "v",
                "candidates": []
            }),
            "publish_set_option" => serde_json::json!({
                "recordId": 1,
                "seq": 1,
                "optionKind": "visibility",
                "optionValue": "public"
            }),
            "publish_set_schedule" => {
                serde_json::json!({"recordId": 1, "seq": 1, "publishTime": 1})
            }
            "publish_navigate_entry" | "publish_submit" => {
                serde_json::json!({"recordId": 1, "seq": 1})
            }
            "publish_capture_post_id"
            | "publish_capture_scheduled"
            | "publish_reconcile_scheduled" => serde_json::json!({"recordId": 1, "seq": 1}),
            _ => serde_json::json!({}),
        }
    }

    // ───────────────── 云端时间指令的跨语言登记表（change restore-native-actuation-humanization-and-locating §4.5）─────────────────

    /// 登记表里某条命令声明了哪些时间字段。
    fn declared_timing_fields() -> BTreeSet<(String, String)> {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../command-timing.json")).expect("command timing");
        let mut declared = BTreeSet::new();
        for command in contract["commands"].as_array().expect("commands") {
            let kind = command["nativeKind"].as_str().expect("native kind");
            for field in command["declares"].as_array().expect("declares") {
                declared.insert((
                    kind.to_owned(),
                    field.as_str().expect("declared field").to_owned(),
                ));
            }
        }
        declared
    }

    /// 引擎**真实**接受哪些时间字段：在最小合法参数上注入该字段再反序列化，成功即接受。
    /// 不做任何源码文本匹配——注释、错误文案、以及构造时写 `None` 的死写都会把文本计数喂绿。
    fn accepted_timing_fields(kinds: &[&str]) -> BTreeSet<(String, String)> {
        let mut accepted = BTreeSet::new();
        for kind in kinds {
            // 基线本身必须能反序列化，否则「注入后失败」会被误读成「该字段未声明」。
            assert!(
                serde_json::from_value::<NativeCommand>(
                    serde_json::json!({"kind": kind, "params": sample_params(kind)}),
                )
                .is_ok(),
                "{kind} has no deserializable baseline params; extend sample_params"
            );
            for field in ["thinkMs", "dwellMs"] {
                let mut params = sample_params(kind);
                let Some(object) = params.as_object_mut() else {
                    continue;
                };
                object.insert(field.to_owned(), serde_json::json!(1234u64));
                if serde_json::from_value::<NativeCommand>(
                    serde_json::json!({"kind": kind, "params": params}),
                )
                .is_ok()
                {
                    accepted.insert(((*kind).to_owned(), field.to_owned()));
                }
            }
        }
        accepted
    }

    fn timing_drift(
        accepted: &BTreeSet<(String, String)>,
        declared: &BTreeSet<(String, String)>,
    ) -> Vec<String> {
        let mut drift: Vec<String> = accepted
            .difference(declared)
            .map(|(kind, field)| format!("undeclared:{kind}:{field}"))
            .collect();
        drift.extend(
            declared
                .difference(accepted)
                .map(|(kind, field)| format!("not_accepted:{kind}:{field}")),
        );
        drift.sort();
        drift
    }

    /// 引擎的时间字段声明面必须与跨语言登记表逐条相等。
    ///
    /// 两个方向都是真缺陷、且都不报错只静默走偏：引擎接受一个宿主从不转发的字段＝**死字段**
    /// （会把任何按声明面计数的检查喂绿）；引擎不接受一个宿主会转发的字段＝该命令每次都被
    /// `deny_unknown_fields` 判成 `invalid_request`、**根本不下发**。
    #[test]
    fn native_timing_declarations_match_the_declared_contract() {
        let accepted = accepted_timing_fields(NATIVE_COMMAND_KINDS);
        assert_eq!(
            timing_drift(&accepted, &declared_timing_fields()),
            Vec::<String>::new()
        );
    }

    /// 失败优先 / 植入验证：给登记表塞一条引擎并不接受的声明、或让引擎多接受一个未登记字段时，
    /// 上面那条检查必须报出来**并点名**。少了这条，门禁自己可能是恒真的。
    #[test]
    fn timing_declaration_check_names_the_offender_when_either_side_drifts() {
        let accepted = accepted_timing_fields(NATIVE_COMMAND_KINDS);
        let declared = declared_timing_fields();

        let mut ghost = declared.clone();
        ghost.insert(("interaction_like".to_owned(), "dwellMs".to_owned()));
        assert_eq!(
            timing_drift(&accepted, &ghost),
            vec!["not_accepted:interaction_like:dwellMs".to_owned()],
        );

        let mut extra = accepted.clone();
        extra.insert(("note_close".to_owned(), "thinkMs".to_owned()));
        assert_eq!(
            timing_drift(&extra, &declared),
            vec!["undeclared:note_close:thinkMs".to_owned()],
        );

        // 未被改动的那一对必须仍然对得上，否则上面两条只是「反正都红」。
        assert_eq!(timing_drift(&accepted, &declared), Vec::<String>::new());
    }
}
