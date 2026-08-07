use crate::protocol::NativeCommand;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FacebookCapability {
    Session,
    Auth,
    Feed,
    FeedLike,
    Reels,
    GroupJoin,
    Comment,
    Publish,
}

/// 一条不可逆写入的提交窗口契约。**只有标签，没有预算数字。**
///
/// 预算的事实源在宿主（`src/native-page-engine/client.ts` 的 `NATIVE_COMMIT_WINDOW_BUDGETS`），
/// 引擎按标签请求、宿主按标签发放。引擎侧曾镜像一份数字并随请求发出，靠一条机械对账防漂——
/// 那份数字运行期已经不作数，留着只是给下一次调预算的人多一处可以改漏的地方，
/// 而改漏的后果既没有文本冲突也没有编译错误。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommitWindowContract {
    pub label: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FacebookParityEntry {
    pub command_kind: &'static str,
    pub owner: FacebookCapability,
    /// Facebook 上到底实现没实现这条命令。没实现的必须在动作之前就显式拒绝——
    /// 跑到页面规则里才报，等于白起一次导航 / 输入 / 提交窗口，还占着写截止时间。
    pub supported: bool,
    /// 不支持的理由。`supported=false` 时必填，`true` 时必须为空。
    pub unsupported_reason: &'static str,
    /// 文本接受谓词：把文本打进页面之后凭什么判「进去了」。
    /// 不涉及文本输入的命令记 `none`；跨写动作若谓词不同，理由必须写在这一维里。
    pub text_acceptance: &'static str,
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

/// 评论与发布共用同一条文本接受谓词：规范化（折叠空白 + 剥零宽字符）后**包含**期望正文，
/// 且多出来的字符数不超过同一个容差常量。
/// 评论侧另记一条代价：正文与联系方式拼成一串一次打完、不再分两段各自验收——
/// 红线仍守住（编辑器值不包含整串就拒绝并清场，绝不裸发缺联系方式的正文），
/// 丢掉的是诊断粒度：退役实现对「正文进去了、联系方式没进去」有独立失败面，
/// 本实现只会给出一个笼统的「文本未被接受」。要把它做成可区分的原因码，
/// MUST 先确认云端对它有归宿，MUST NOT 新增无归宿的原因码。
const TEXT_CONTAINS_WITH_TOLERANCE: &str =
    "normalized containment within the shared extra-character tolerance";

/// 三条提交窗口的**标签**。预算不在这里，也不在引擎任何地方：
/// 引擎按标签请求，宿主按标签发放（`src/native-page-engine/client.ts` 的
/// `NATIVE_COMMIT_WINDOW_BUDGETS` 是唯一事实源，同时也是**准入白名单**）。
///
/// ⚠️ 宿主那张表里没有的标签会被判成契约违规并否决这一次窗口 —— 后果不是「少一层保护」，
/// 而是这三处写入**全部拒发**（回执诚实，但功能停摆）。新增 / 改名标签必须同批改宿主那张表；
/// `test/native-page-engine/runtime-contracts-commit-window.test.ts` 双向对账，漏改当场失败。
const JOIN_WINDOW: Option<CommitWindowContract> = Some(CommitWindowContract {
    label: "fb_join_click",
});
const COMMENT_WINDOW: Option<CommitWindowContract> = Some(CommitWindowContract {
    label: "fb_comment_enter",
});
const PUBLISH_WINDOW: Option<CommitWindowContract> = Some(CommitWindowContract {
    label: "fb_publish_submit",
});

macro_rules! entry {
    ($kind:literal, $owner:ident, $oracle:literal, $witness:literal, $gates:literal, $commit:literal, $count:literal, $verify:literal, $terminal:literal, $deadline:literal, $window:expr) => {
        entry!(
            $kind, $owner, $oracle, $witness, $gates, $commit, $count, $verify, $terminal,
            $deadline, $window, "none"
        )
    };
    ($kind:literal, $owner:ident, $oracle:literal, $witness:literal, $gates:literal, $commit:literal, $count:literal, $verify:literal, $terminal:literal, $deadline:literal, $window:expr, $text:expr) => {
        FacebookParityEntry {
            command_kind: $kind,
            owner: FacebookCapability::$owner,
            supported: true,
            unsupported_reason: "",
            text_acceptance: $text,
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

/// 未实现命令的台账条目：不带 oracle / 目标见证 / 提交原语 / 校验见证 / 终态语义——
/// 它们都是「这条命令会怎么动页面」的承诺，而这条命令根本不动页面。
const fn unsupported(
    command_kind: &'static str,
    owner: FacebookCapability,
    unsupported_reason: &'static str,
) -> FacebookParityEntry {
    FacebookParityEntry {
        command_kind,
        owner,
        supported: false,
        unsupported_reason,
        text_acceptance: "none",
        behavior_oracle: "",
        focused_behavior_suite: focused_suite(owner),
        target_witness: "",
        pre_commit_gates: "",
        commit_primitive: "",
        max_dispatch_count: 0,
        verification_witness: "",
        terminal_semantics: "",
        deadline_ms: 30_000,
        commit_window: None,
    }
}

const fn focused_suite(owner: FacebookCapability) -> &'static str {
    match owner {
        FacebookCapability::Auth => "test/native-page-engine/facebook-auth-router.test.ts",
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
        "facebook_auth_probe",
        Auth,
        "bounded first-login signal observer",
        "bound target, document generation, and exact candidate",
        "read-only structural classification",
        "read",
        0,
        "exclusive typed authentication signal",
        "confirmed read or typed failure",
        30_000,
        None
    ),
    entry!(
        "facebook_auth_submit_login",
        Auth,
        "first-login submit stage",
        "exact login form with AdsPower-filled fields",
        "fresh signal id, uniqueness, visibility, and top hit",
        "one trusted pointer stage",
        1,
        "login signal gone or bound document changed",
        "confirmed, ambiguous after input, or not-started",
        30_000,
        None
    ),
    entry!(
        "facebook_auth_enter_totp",
        Auth,
        "first-login TOTP entry stage",
        "exact empty two-factor input",
        "fresh signal id, server window, focus, and top hit",
        "trusted pointer plus six-digit Native text input",
        1,
        "exact input readback without returning the code",
        "confirmed, ambiguous after input, or not-started",
        30_000,
        None,
        "exact six-digit input readback without returning the value"
    ),
    entry!(
        "facebook_auth_submit_totp",
        Auth,
        "first-login TOTP submit stage",
        "exact populated two-factor form and Continue control",
        "fresh signal id, same TOTP window, validity floor, and top hit",
        "one trusted pointer stage",
        1,
        "submit signal gone or bound document changed",
        "confirmed, ambiguous after input, or not-started",
        30_000,
        None
    ),
    entry!(
        "facebook_auth_clear_totp",
        Auth,
        "stale TOTP clear stage",
        "exact stale populated two-factor input",
        "fresh refresh-required signal id and top hit",
        "trusted pointer plus bounded keyboard clearing",
        1,
        "empty input readback without returning the prior code",
        "confirmed, ambiguous after input, or not-started",
        30_000,
        None
    ),
    entry!(
        "facebook_auth_dismiss_warning",
        Auth,
        "observed automation-warning dismissal",
        "exact checkpoint warning and unique Dismiss control",
        "fresh signal id, visibility, uniqueness, and top hit",
        "one trusted pointer stage",
        1,
        "warning signal gone or bound document changed",
        "confirmed, ambiguous after input, or not-started",
        30_000,
        None
    ),
    entry!(
        "facebook_auth_close_push_blocker",
        Auth,
        "Facebook page push-blocker close",
        "exact push alertdialog and unique Close control",
        "fresh signal id, visibility, uniqueness, and top hit",
        "one trusted pointer stage",
        1,
        "push signal gone",
        "confirmed, ambiguous after input, or not-started",
        30_000,
        None
    ),
    entry!(
        "facebook_auth_confirm_remember_password",
        Auth,
        "Facebook Remember Password confirmation",
        "exact page modal and unique OK control",
        "fresh signal id, visibility, uniqueness, and top hit",
        "one trusted pointer stage",
        1,
        "remember-password signal gone",
        "confirmed, ambiguous after input, or not-started",
        30_000,
        None
    ),
    entry!(
        "facebook_auth_start_ad_data_review",
        Auth,
        "Facebook first-time ad-data review introduction",
        "exact review route, content, and unique Get started control",
        "fresh signal id, visibility, uniqueness, enabled state, and top hit",
        "one trusted pointer stage",
        1,
        "exact subscription-versus-free-with-ads successor",
        "confirmed, ambiguous after input, or not-started",
        30_000,
        None
    ),
    entry!(
        "facebook_auth_start_suspension_appeal",
        Auth,
        "Facebook suspension appeal entry",
        "exact suspension checkpoint, content, and unique Appeal control",
        "fresh signal id, visibility, uniqueness, enabled state, and top hit",
        "one trusted pointer stage",
        1,
        "distinct loaded Facebook checkpoint successor",
        "confirmed, ambiguous after input, or not-started",
        30_000,
        None
    ),
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
        COMMENT_WINDOW,
        TEXT_CONTAINS_WITH_TOLERANCE
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
    unsupported(
        "publish_set_cover",
        FacebookCapability::Publish,
        "Facebook composer has no cover-selection step in this engine",
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
        None,
        TEXT_CONTAINS_WITH_TOLERANCE
    ),
    unsupported(
        "publish_add_with_candidate",
        FacebookCapability::Publish,
        "Facebook composer exposes no candidate picker in this engine",
    ),
    unsupported(
        "publish_set_option",
        FacebookCapability::Publish,
        "Facebook composer exposes no option control in this engine",
    ),
    unsupported(
        "publish_set_schedule",
        FacebookCapability::Publish,
        "Facebook native scheduling is not implemented in this engine",
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
    unsupported(
        "publish_capture_scheduled",
        FacebookCapability::Publish,
        "Facebook native scheduling is not implemented, so there is nothing to capture",
    ),
    unsupported(
        "publish_reconcile_scheduled",
        FacebookCapability::Publish,
        "Facebook native scheduling is not implemented, so there is nothing to reconcile",
    ),
];

pub fn parity(command: &NativeCommand) -> Option<&'static FacebookParityEntry> {
    use NativeCommand::*;
    let kind = match command {
        FacebookAuthProbe(_) => "facebook_auth_probe",
        FacebookAuthSubmitLogin(_) => "facebook_auth_submit_login",
        FacebookAuthEnterTotp(_) => "facebook_auth_enter_totp",
        FacebookAuthSubmitTotp(_) => "facebook_auth_submit_totp",
        FacebookAuthClearTotp(_) => "facebook_auth_clear_totp",
        FacebookAuthDismissWarning(_) => "facebook_auth_dismiss_warning",
        FacebookAuthClosePushBlocker(_) => "facebook_auth_close_push_blocker",
        FacebookAuthConfirmRememberPassword(_) => "facebook_auth_confirm_remember_password",
        FacebookAuthStartAdDataReview(_) => "facebook_auth_start_ad_data_review",
        FacebookAuthStartSuspensionAppeal(_) => "facebook_auth_start_suspension_appeal",
        PageProbe(_) => "page_probe",
        SessionStop(_) => "session_stop",
        IdentityBootstrap(_) => "identity_bootstrap",
        IdentityReadCurrent(_) => "identity_read_current",
        CaptchaCapture(_) => "captcha_capture",
        CaptchaClick(_) => "captcha_click",
        BrowseScroll(_) => "browse_scroll",
        PageScroll(_) => "page_scroll",
        FeedRefresh(_) => "feed_refresh",
        SearchExecute(_) => "search_execute",
        NoteOpen(_) => "note_open",
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

    /// 会把文本打进页面的写动作。它们的「文本接受谓词」不许缺，
    /// 谓词不同还不写理由的话，两条链路就会在同一个编辑器上给出两种「进去了」的判据。
    const TEXT_BEARING_WRITE_KINDS: &[&str] = &["interaction_comment", "publish_fill_field"];
    const SENSITIVE_TEXT_BEARING_WRITE_KINDS: &[&str] = &["facebook_auth_enter_totp"];

    #[test]
    fn ledger_has_one_complete_entry_per_supported_kind() {
        let mut kinds = BTreeSet::new();
        for entry in FACEBOOK_PARITY_LEDGER {
            assert!(
                kinds.insert(entry.command_kind),
                "duplicate {}",
                entry.command_kind
            );
            assert!(!entry.focused_behavior_suite.is_empty());
            assert!(!entry.text_acceptance.is_empty(), "{}", entry.command_kind);
            if entry.supported {
                assert!(
                    entry.unsupported_reason.is_empty(),
                    "{}",
                    entry.command_kind
                );
                assert!(!entry.behavior_oracle.is_empty());
                assert!(!entry.target_witness.is_empty());
                assert!(!entry.pre_commit_gates.is_empty());
                assert!(!entry.commit_primitive.is_empty());
                assert!(!entry.verification_witness.is_empty());
                assert!(!entry.terminal_semantics.is_empty());
            } else {
                // 不支持的命令若仍声明行为证据，就是在承诺一件它根本不会做的事。
                assert!(
                    !entry.unsupported_reason.is_empty(),
                    "{} must name why it is unsupported",
                    entry.command_kind
                );
                assert_eq!(entry.behavior_oracle, "", "{}", entry.command_kind);
                assert_eq!(entry.target_witness, "", "{}", entry.command_kind);
                assert_eq!(entry.pre_commit_gates, "", "{}", entry.command_kind);
                assert_eq!(entry.commit_primitive, "", "{}", entry.command_kind);
                assert_eq!(entry.verification_witness, "", "{}", entry.command_kind);
                assert_eq!(entry.terminal_semantics, "", "{}", entry.command_kind);
                assert_eq!(entry.max_dispatch_count, 0, "{}", entry.command_kind);
                assert!(entry.commit_window.is_none(), "{}", entry.command_kind);
            }
            assert!(
                entry.deadline_ms == 30_000
                    || entry.deadline_ms == 40_000
                    || entry.deadline_ms == 90_000
                    || entry.deadline_ms == 400_000
            );
            // 窗口只声明标签：预算的事实源在宿主，引擎这边没有数字可校。
            // 标签空掉 = 宿主认不出 = 这条写入全部拒发，所以这一条必须响亮。
            if let Some(window) = entry.commit_window {
                assert!(!window.label.is_empty(), "{}", entry.command_kind);
            }
        }
        assert_eq!(kinds.len(), FACEBOOK_PARITY_LEDGER.len());
    }

    #[test]
    fn every_text_bearing_write_declares_one_shared_acceptance_predicate() {
        let mut declared = BTreeSet::new();
        for kind in TEXT_BEARING_WRITE_KINDS {
            let entry = entry_for_kind(kind).unwrap_or_else(|| panic!("{kind} must be in ledger"));
            assert!(entry.supported, "{kind}");
            assert_ne!(
                entry.text_acceptance, "none",
                "{kind} 会把文本打进页面，文本接受谓词不许缺"
            );
            declared.insert(entry.text_acceptance);
        }
        assert_eq!(
            declared.len(),
            1,
            "跨写动作的文本接受谓词不同却没写理由：{declared:?}"
        );

        for entry in FACEBOOK_PARITY_LEDGER {
            if !TEXT_BEARING_WRITE_KINDS.contains(&entry.command_kind)
                && !SENSITIVE_TEXT_BEARING_WRITE_KINDS.contains(&entry.command_kind)
            {
                assert_eq!(
                    entry.text_acceptance, "none",
                    "{} 不打文本，不该声明文本接受谓词",
                    entry.command_kind
                );
            }
        }
        for kind in SENSITIVE_TEXT_BEARING_WRITE_KINDS {
            let entry = entry_for_kind(kind).unwrap_or_else(|| panic!("{kind} must be in ledger"));
            assert_eq!(
                entry.text_acceptance,
                "exact six-digit input readback without returning the value"
            );
        }
    }

    #[test]
    fn facebook_publish_declares_six_supported_and_six_unsupported_entries() {
        let publish: Vec<_> = FACEBOOK_PARITY_LEDGER
            .iter()
            .filter(|entry| entry.command_kind.starts_with("publish_"))
            .collect();
        assert_eq!(publish.len(), 12);
        assert_eq!(publish.iter().filter(|entry| entry.supported).count(), 6);

        let unsupported: BTreeSet<_> = publish
            .iter()
            .filter(|entry| !entry.supported)
            .map(|entry| entry.command_kind)
            .collect();
        assert_eq!(
            unsupported,
            BTreeSet::from([
                "publish_add_with_candidate",
                "publish_capture_scheduled",
                "publish_reconcile_scheduled",
                "publish_set_cover",
                "publish_set_option",
                "publish_set_schedule",
            ])
        );
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
