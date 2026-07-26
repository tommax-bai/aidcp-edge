use crate::error::{EngineError, ErrorCode};
use crate::protocol::Platform;
use serde::{Deserialize, Serialize};

const MAX_REASON_BYTES: usize = 512;
const MAX_ID_BYTES: usize = 256;
const MAX_TEXT_BYTES: usize = 32 * 1024;
const MAX_URL_BYTES: usize = 8 * 1024;
const MAX_LIST_ITEMS: usize = 100;

pub const PRODUCTION_COMMAND_KINDS: &[&str] = &[
    "plan_execute",
    "session_stop",
    "browse_next",
    "browse_scroll",
    "page_scroll",
    "feed_refresh",
    "search_execute",
    "note_open",
    "note_close",
    "navigation_back",
    "note_browse_images",
    "note_scroll_comments",
    "profile_open",
    "notification_open",
    "notification_browse_comments",
    "notification_browse_likes",
    "notification_browse_follows",
    "notification_back_home",
    "interaction_like",
    "interaction_collect",
    "interaction_follow",
    "interaction_comment",
    "interaction_like_comment",
    "group_join",
    "wechat_capture_session",
    "identity_bootstrap",
    "identity_read_current",
    "identity_read_self_profile",
    "captcha_capture",
    "captcha_click",
    "publish_navigate_entry",
    "publish_select_mode",
    "publish_upload_image",
    "publish_set_cover",
    "publish_fill_field",
    "publish_add_with_candidate",
    "publish_set_option",
    "publish_set_schedule",
    "publish_submit",
    "publish_capture_post_id",
    "publish_capture_scheduled",
    "publish_reconcile_scheduled",
];

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EmptyParams {}

pub type PageProbeParams = EmptyParams;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReasonParams {
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TimingParams {
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub think_ms: Option<u64>,
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
    pub dwell_ms: Option<u64>,
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

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", content = "params", rename_all = "snake_case")]
pub enum NativeCommand {
    PageProbe(PageProbeParams),
    PlanExecute(PlanExecuteParams),
    SessionStop(ReasonParams),
    BrowseNext(ReasonParams),
    BrowseScroll(ReasonParams),
    PageScroll(PageScrollParams),
    FeedRefresh(FeedRefreshParams),
    SearchExecute(SearchExecuteParams),
    NoteOpen(NoteOpenParams),
    NoteClose(TimingParams),
    NavigationBack(NavigationBackParams),
    NoteBrowseImages(NoteTraverseParams),
    NoteScrollComments(NoteTraverseParams),
    ProfileOpen(ProfileOpenParams),
    NotificationOpen(NotificationParams),
    NotificationBrowseComments(NotificationParams),
    NotificationBrowseLikes(NotificationParams),
    NotificationBrowseFollows(NotificationParams),
    NotificationBackHome(NotificationParams),
    InteractionLike(NoteInteractionParams),
    InteractionCollect(NoteInteractionParams),
    InteractionFollow(FollowParams),
    InteractionComment(CommentParams),
    InteractionLikeComment(LikeCommentParams),
    GroupJoin(GroupJoinParams),
    WechatCaptureSession(EmptyParams),
    IdentityBootstrap(EmptyParams),
    IdentityReadCurrent(IdentityCaptureParams),
    IdentityReadSelfProfile(IdentityCaptureParams),
    CaptchaCapture(CaptchaCaptureParams),
    CaptchaClick(CaptchaClickParams),
    PublishNavigateEntry(PublishIdentity),
    PublishSelectMode(PublishSelectModeParams),
    PublishUploadImage(PublishFileParams),
    PublishSetCover(PublishCoverParams),
    PublishFillField(PublishFieldParams),
    PublishAddWithCandidate(PublishCandidateParams),
    PublishSetOption(PublishOptionParams),
    PublishSetSchedule(PublishScheduleParams),
    PublishSubmit(PublishIdentity),
    PublishCapturePostId(PublishCaptureParams),
    PublishCaptureScheduled(PublishCaptureParams),
    PublishReconcileScheduled(PublishCaptureParams),
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
            ),
            Platform::Facebook => crate::facebook::capability::owner(self).is_some(),
            Platform::WechatChannels => matches!(self, WechatCaptureSession(_)),
        }
    }

    pub fn may_write(&self) -> bool {
        !matches!(
            self,
            Self::PageProbe(_)
                | Self::PublishCapturePostId(_)
                | Self::PublishCaptureScheduled(_)
                | Self::PublishReconcileScheduled(_)
                | Self::CaptchaCapture(_)
                | Self::WechatCaptureSession(_)
                | Self::IdentityBootstrap(_)
                | Self::IdentityReadCurrent(_)
        )
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        match self {
            Self::PageProbe(_)
            | Self::PublishNavigateEntry(_)
            | Self::PublishSubmit(_)
            | Self::WechatCaptureSession(_) => Ok(()),
            Self::IdentityBootstrap(_) => Ok(()),
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
                )
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
                validate_optional(&params.text, 4_096, "captcha text exceeds protocol limit")?;
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

fn invalid(message: &'static str) -> EngineError {
    EngineError::new(ErrorCode::InvalidRequest, message)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn production_enum_matches_the_frozen_manifest_exactly() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../command-manifest.json"))
                .expect("command manifest");
        let mut manifest_kinds: Vec<&str> = manifest["commands"]
            .as_array()
            .expect("commands")
            .iter()
            .map(|command| command["nativeKind"].as_str().expect("native kind"))
            .collect();
        let mut enum_kinds = PRODUCTION_COMMAND_KINDS.to_vec();
        manifest_kinds.sort_unstable();
        enum_kinds.sort_unstable();
        assert_eq!(enum_kinds, manifest_kinds);
    }
}
