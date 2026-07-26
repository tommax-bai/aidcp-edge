use crate::protocol::NativeCommand;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FacebookCapability {
    Session,
    Feed,
    FeedLike,
    Reels,
    GroupJoin,
    Comment,
    Publish,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommitWindowContract {
    pub label: &'static str,
    pub budget_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FacebookParityEntry {
    pub command_kind: &'static str,
    pub owner: FacebookCapability,
    pub behavior_oracle: &'static str,
    pub focused_behavior_suite: &'static str,
    pub target_witness: &'static str,
    pub pre_commit_gates: &'static str,
    pub commit_primitive: &'static str,
    pub max_dispatch_count: u8,
    pub verification_witness: &'static str,
    pub terminal_semantics: &'static str,
    pub deadline_ms: u64,
    pub commit_window: Option<CommitWindowContract>,
}

const JOIN_WINDOW: Option<CommitWindowContract> = Some(CommitWindowContract {
    label: "fb_join_click",
    budget_ms: 18_500,
});
const COMMENT_WINDOW: Option<CommitWindowContract> = Some(CommitWindowContract {
    label: "fb_comment_enter",
    budget_ms: 20_000,
});
const PUBLISH_WINDOW: Option<CommitWindowContract> = Some(CommitWindowContract {
    label: "fb_publish_submit",
    budget_ms: 20_000,
});

macro_rules! entry {
    ($kind:literal, $owner:ident, $oracle:literal, $witness:literal, $gates:literal, $commit:literal, $count:literal, $verify:literal, $terminal:literal, $deadline:literal, $window:expr) => {
        FacebookParityEntry {
            command_kind: $kind,
            owner: FacebookCapability::$owner,
            behavior_oracle: $oracle,
            focused_behavior_suite: focused_suite(FacebookCapability::$owner),
            target_witness: $witness,
            pre_commit_gates: $gates,
            commit_primitive: $commit,
            max_dispatch_count: $count,
            verification_witness: $verify,
            terminal_semantics: $terminal,
            deadline_ms: $deadline,
            commit_window: $window,
        }
    };
}

const fn focused_suite(owner: FacebookCapability) -> &'static str {
    match owner {
        FacebookCapability::Session
        | FacebookCapability::Feed
        | FacebookCapability::Reels
        | FacebookCapability::GroupJoin
        | FacebookCapability::Comment
        | FacebookCapability::Publish => "test/native-page-engine/facebook-router-contract.test.ts",
        FacebookCapability::FeedLike => "test/native-page-engine/facebook-feed-like-parity.test.ts",
    }
}

pub const FACEBOOK_PARITY_LEDGER: &[FacebookParityEntry] = &[
    entry!(
        "page_probe",
        Session,
        "native page probe",
        "bound Facebook target",
        "session identity",
        "read",
        0,
        "bounded page classification",
        "confirmed or typed read failure",
        30_000,
        None
    ),
    entry!(
        "session_stop",
        Session,
        "native session lifecycle",
        "bound session",
        "session identity",
        "none",
        0,
        "session stopped",
        "confirmed or typed lifecycle failure",
        30_000,
        None
    ),
    entry!(
        "identity_bootstrap",
        Session,
        "retired Facebook identity reader",
        "c_user or unique own profile link",
        "bound origin",
        "read",
        0,
        "stable numeric account id",
        "confirmed or not-started",
        30_000,
        None
    ),
    entry!(
        "identity_read_current",
        Session,
        "retired Facebook identity reader",
        "c_user or unique own profile link",
        "bound account",
        "read",
        0,
        "correlated identity observation",
        "confirmed or not-started",
        30_000,
        None
    ),
    entry!(
        "captcha_capture",
        Session,
        "native captcha assist",
        "current blocker generation",
        "incident correlation",
        "screenshot",
        0,
        "bounded snapshot",
        "confirmed or not-started",
        30_000,
        None
    ),
    entry!(
        "captcha_click",
        Session,
        "native captcha assist",
        "snapshot-relative points",
        "incident and snapshot correlation",
        "trusted pointer and optional keyboard",
        20,
        "fresh blocker probe",
        "confirmed, ambiguous, or not-started",
        30_000,
        None
    ),
    entry!(
        "browse_next",
        Feed,
        "retired Facebook browse session",
        "active list surface",
        "blocker and list identity",
        "bounded scroll or Reel next",
        1,
        "list movement and cards",
        "confirmed or honest no-movement",
        30_000,
        None
    ),
    entry!(
        "browse_scroll",
        Feed,
        "retired Facebook browse session",
        "home Feed generation",
        "blocker and list identity",
        "navigation plus bounded wheel",
        8,
        "reportable Feed cards",
        "confirmed or honest empty/unreportable",
        30_000,
        None
    ),
    entry!(
        "page_scroll",
        Feed,
        "retired Facebook browse/Reels readers",
        "active Feed or Reel identity",
        "blocker and movement identity",
        "bounded wheel or trusted Reel target",
        2,
        "same-list movement and cards",
        "confirmed or honest no-movement",
        30_000,
        None
    ),
    entry!(
        "feed_refresh",
        Feed,
        "retired Facebook browse session",
        "home Feed generation",
        "blocker and refresh floor",
        "home target or reload",
        1,
        "new Feed generation/cards",
        "confirmed or honest refresh failure",
        30_000,
        None
    ),
    entry!(
        "search_execute",
        Feed,
        "retired Facebook search path",
        "canonical search container",
        "container and keyword binding",
        "navigation",
        1,
        "search-scoped cards",
        "confirmed, no-results, or not-started",
        30_000,
        None
    ),
    entry!(
        "note_open",
        Feed,
        "retired Facebook open path",
        "canonical post permalink",
        "exact post identity",
        "navigation",
        1,
        "requested post detail",
        "confirmed or exact-target failure",
        30_000,
        None
    ),
    entry!(
        "note_close",
        Feed,
        "retired Facebook browse session",
        "current list provenance",
        "active list identity",
        "history or home navigation",
        1,
        "Feed/Reels cards",
        "confirmed or navigation failure",
        30_000,
        None
    ),
    entry!(
        "navigation_back",
        Feed,
        "retired Facebook browse session",
        "current list provenance",
        "active list identity",
        "history or home navigation",
        1,
        "Feed/Reels cards",
        "confirmed or navigation failure",
        30_000,
        None
    ),
    entry!(
        "interaction_like",
        FeedLike,
        "retired Like executor and Reels reader",
        "exact tagged Feed card or active Reel/video",
        "blocker, consent, identity, selected state",
        "fresh DOM primary then optional scoped pointer picker",
        2,
        "same card/Reel selected state",
        "confirmed, already, ambiguous, or not-started",
        30_000,
        None
    ),
    entry!(
        "interaction_follow",
        Reels,
        "retired Reels reader",
        "active Reel/video plus unique author",
        "blocker, consent, movement, author association",
        "one trusted pointer click",
        1,
        "same Reel author following state",
        "confirmed, already, ambiguous, or not-started",
        30_000,
        None
    ),
    entry!(
        "interaction_comment",
        Comment,
        "retired Comment executor",
        "exact post editor and bound account",
        "blocker, consent, editor clean/readback",
        "keyboard text plus Enter",
        1,
        "same-account server acknowledgement",
        "confirmed, pending/rejected, ambiguous, or not-started",
        30_000,
        COMMENT_WINDOW
    ),
    entry!(
        "group_join",
        GroupJoin,
        "retired Join executor",
        "current group heading/action scope",
        "blocker, consent, readiness, hydration, unique enabled Join",
        "fresh in-page DOM activation",
        1,
        "member, pending, questionnaire, or structural transition",
        "confirmed observation, ambiguous after click, or not-started",
        90_000,
        JOIN_WINDOW
    ),
    entry!(
        "publish_navigate_entry",
        Publish,
        "retired Publish executor",
        "Facebook home surface",
        "blocker, consent, and bounded home readiness",
        "allowlisted home navigation",
        1,
        "interactive home with main or existing composer",
        "confirmed or not-started",
        30_000,
        None
    ),
    entry!(
        "publish_select_mode",
        Publish,
        "retired Publish executor",
        "fresh localized home composer entry",
        "canonical target, home surface, and absolute deadline",
        "one trusted pointer after bounded late-entry polling",
        1,
        "unique composer editor present",
        "confirmed, not-started before click, or ambiguous after click",
        30_000,
        None
    ),
    entry!(
        "publish_upload_image",
        Publish,
        "retired Publish executor",
        "authorized file input",
        "path and composer generation",
        "CDP file input",
        1,
        "uploaded preview",
        "confirmed or ambiguous",
        30_000,
        None
    ),
    entry!(
        "publish_set_cover",
        Publish,
        "retired Publish executor",
        "active composer media",
        "composer generation",
        "trusted pointer",
        1,
        "cover state readback",
        "confirmed or not-started",
        30_000,
        None
    ),
    entry!(
        "publish_fill_field",
        Publish,
        "retired Publish executor",
        "exact composer field",
        "composer generation and empty/readback gates",
        "keyboard text",
        1,
        "field readback",
        "confirmed or not-started",
        400_000,
        None
    ),
    entry!(
        "publish_add_with_candidate",
        Publish,
        "retired Publish executor",
        "composer candidate control",
        "composer generation and unique candidate",
        "trusted pointer and keyboard",
        2,
        "candidate readback",
        "confirmed or not-started",
        30_000,
        None
    ),
    entry!(
        "publish_set_option",
        Publish,
        "retired Publish executor",
        "composer option control",
        "composer generation and unique option",
        "trusted pointer",
        1,
        "option readback",
        "confirmed or not-started",
        30_000,
        None
    ),
    entry!(
        "publish_set_schedule",
        Publish,
        "retired Publish executor",
        "composer schedule control",
        "composer generation and requested time",
        "trusted pointer and keyboard",
        2,
        "schedule readback",
        "confirmed or not-started",
        30_000,
        None
    ),
    entry!(
        "publish_submit",
        Publish,
        "retired Publish executor",
        "active composer submit",
        "blocker, consent, field readback, unique submit",
        "trusted pointer submit",
        1,
        "composer close or localized submitted-state witness, then post capture",
        "confirmed, ambiguous, or not-started",
        30_000,
        PUBLISH_WINDOW
    ),
    entry!(
        "publish_capture_post_id",
        Publish,
        "retired Publish executor",
        "submitted composer generation",
        "record and sequence correlation",
        "read",
        0,
        "canonical post id",
        "confirmed or honest absent",
        30_000,
        None
    ),
    entry!(
        "publish_capture_scheduled",
        Publish,
        "retired Publish executor",
        "scheduled post identity",
        "record and sequence correlation",
        "read",
        0,
        "scheduled post witness",
        "confirmed or honest absent",
        30_000,
        None
    ),
    entry!(
        "publish_reconcile_scheduled",
        Publish,
        "retired Publish executor",
        "scheduled post identity",
        "record and sequence correlation",
        "read",
        0,
        "scheduled post witness",
        "confirmed or ambiguous",
        30_000,
        None
    ),
];

pub fn parity(command: &NativeCommand) -> Option<&'static FacebookParityEntry> {
    use NativeCommand::*;
    let kind = match command {
        PageProbe(_) => "page_probe",
        SessionStop(_) => "session_stop",
        IdentityBootstrap(_) => "identity_bootstrap",
        IdentityReadCurrent(_) => "identity_read_current",
        CaptchaCapture(_) => "captcha_capture",
        CaptchaClick(_) => "captcha_click",
        BrowseNext(_) => "browse_next",
        BrowseScroll(_) => "browse_scroll",
        PageScroll(_) => "page_scroll",
        FeedRefresh(_) => "feed_refresh",
        SearchExecute(_) => "search_execute",
        NoteOpen(_) => "note_open",
        NoteClose(_) => "note_close",
        NavigationBack(_) => "navigation_back",
        InteractionLike(_) => "interaction_like",
        InteractionFollow(_) => "interaction_follow",
        InteractionComment(_) => "interaction_comment",
        GroupJoin(_) => "group_join",
        PublishNavigateEntry(_) => "publish_navigate_entry",
        PublishSelectMode(_) => "publish_select_mode",
        PublishUploadImage(_) => "publish_upload_image",
        PublishSetCover(_) => "publish_set_cover",
        PublishFillField(_) => "publish_fill_field",
        PublishAddWithCandidate(_) => "publish_add_with_candidate",
        PublishSetOption(_) => "publish_set_option",
        PublishSetSchedule(_) => "publish_set_schedule",
        PublishSubmit(_) => "publish_submit",
        PublishCapturePostId(_) => "publish_capture_post_id",
        PublishCaptureScheduled(_) => "publish_capture_scheduled",
        PublishReconcileScheduled(_) => "publish_reconcile_scheduled",
        _ => return None,
    };
    entry_for_kind(kind)
}

pub fn owner(command: &NativeCommand) -> Option<FacebookCapability> {
    parity(command).map(|entry| entry.owner)
}

pub fn entry_for_kind(kind: &str) -> Option<&'static FacebookParityEntry> {
    FACEBOOK_PARITY_LEDGER
        .iter()
        .find(|entry| entry.command_kind == kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn ledger_has_one_complete_entry_per_supported_kind() {
        let mut kinds = BTreeSet::new();
        for entry in FACEBOOK_PARITY_LEDGER {
            assert!(
                kinds.insert(entry.command_kind),
                "duplicate {}",
                entry.command_kind
            );
            assert!(!entry.behavior_oracle.is_empty());
            assert!(!entry.focused_behavior_suite.is_empty());
            assert!(!entry.target_witness.is_empty());
            assert!(!entry.pre_commit_gates.is_empty());
            assert!(!entry.commit_primitive.is_empty());
            assert!(!entry.verification_witness.is_empty());
            assert!(!entry.terminal_semantics.is_empty());
            assert!(
                entry.deadline_ms == 30_000
                    || entry.deadline_ms == 40_000
                    || entry.deadline_ms == 90_000
                    || entry.deadline_ms == 400_000
            );
            if let Some(window) = entry.commit_window {
                assert!(window.budget_ms > 0 && window.budget_ms <= entry.deadline_ms);
            }
        }
        assert_eq!(kinds.len(), FACEBOOK_PARITY_LEDGER.len());
    }

    #[test]
    fn irreversible_submit_windows_match_the_retired_executors() {
        assert_eq!(
            entry_for_kind("group_join").and_then(|entry| entry.commit_window),
            JOIN_WINDOW
        );
        assert_eq!(
            entry_for_kind("interaction_comment").and_then(|entry| entry.commit_window),
            COMMENT_WINDOW
        );
        assert_eq!(
            entry_for_kind("publish_submit").and_then(|entry| entry.commit_window),
            PUBLISH_WINDOW
        );
        assert!(
            entry_for_kind("interaction_like")
                .unwrap()
                .commit_window
                .is_none()
        );
    }
}
