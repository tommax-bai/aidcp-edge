use super::capability::{self, FacebookCapability};
use super::shared::{
    cancelled_before_dispatch, canonical_facebook_post_id, dispatch_facebook_click,
    ensure_facebook_action_gate, evaluate_facebook_router,
    evaluate_facebook_router_until_requested_detail, facebook_action_result,
    facebook_command_cancelled, is_facebook_content_ref, probe_facebook_comment_action,
    probe_facebook_comment_editor, validate_facebook_origin, validated_facebook_group_url,
    wait_for_facebook_ready,
};
use super::{comment, feed, feed_like, group_join, publish, reels, session};
use crate::command::{
    FeedRefreshParams, NoteOpenParams, NoteOpenSelection, NotePurpose, NoteSurface, ReasonParams,
};
use crate::commit_window::CommitWindowRequester;
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::model::PageCards;
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use url::Url;

const FIRST_POST_SCROLL_ROUNDS: usize = 4;
// 首帖这两个窗口是本链的实测失败边界（change restore-facebook-post-join-comment-continuity）：
// 近两日全部首帖失败耗时 9.8–15.8s、全部成功 ≤7s，判别量是页面水合速度而非账号 / 版面 / 群。
// 绑定窗从「文档可交互」起算，而这类群页的内容水合发生在其后，4s 过紧；身份回读窗原为普通读
// 路径同一件事所给窗口（15s）的一半。放宽后外层原子上限必须同步抬（src/native-page-engine/
// browse-session.ts），否则外层先到点、产出的是信息量更低的合成失败。加群侧预算不在本次范围内。
// 2026-07-29 随整体 ×1.5 再放大一档（12→18 / 20→30），外层原子上限同步抬到 135s。
const FIRST_POST_EDITOR_TIMEOUT: Duration = Duration::from_secs(18);
const FIRST_POST_DETAIL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Eq, PartialEq)]
enum FirstPostTarget {
    Permalink(Url),
    BoundRef(String),
}

impl FirstPostTarget {
    fn note_id(&self) -> String {
        match self {
            Self::Permalink(url) => url.to_string(),
            Self::BoundRef(target_ref) => target_ref.clone(),
        }
    }
}

pub(crate) async fn execute(
    engine_session: &mut EngineSession,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    commit_windows: &CommitWindowRequester,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if matches!(
        command,
        NativeCommand::NoteOpen(NoteOpenParams {
            selection: Some(NoteOpenSelection::FirstCommentableGroupPost),
            ..
        })
    ) {
        return execute_first_commentable_group_post(engine_session, command, cancellation).await;
    }
    let owner = capability::owner(command).ok_or_else(|| {
        EngineError::new(
            ErrorCode::UnsupportedCommand,
            "native Facebook command has no capability owner",
        )
    })?;
    match owner {
        FacebookCapability::Session => {
            session::execute(engine_session, command, cancellation, deadline_unix_ms).await
        }
        FacebookCapability::Feed => {
            feed::execute(engine_session, command, cancellation, deadline_unix_ms).await
        }
        FacebookCapability::FeedLike => feed_like::execute(engine_session, command).await,
        FacebookCapability::Reels => reels::execute(engine_session, command).await,
        FacebookCapability::GroupJoin => {
            group_join::execute(
                engine_session,
                command,
                cancellation,
                commit_windows,
                deadline_unix_ms,
            )
            .await
        }
        FacebookCapability::Comment => {
            comment::execute(
                engine_session,
                command,
                cancellation,
                commit_windows,
                deadline_unix_ms,
            )
            .await
        }
        FacebookCapability::Publish => {
            publish::execute(
                engine_session,
                command,
                cancellation,
                commit_windows,
                deadline_unix_ms,
            )
            .await
        }
    }
}

async fn execute_first_commentable_group_post(
    session: &mut EngineSession,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let NativeCommand::NoteOpen(params) = command else {
        unreachable!("first-post routing requires note.open");
    };
    if facebook_command_cancelled(cancellation) {
        return Err(cancelled_before_dispatch());
    }
    let group_url = validated_facebook_group_url(params.container.as_deref().unwrap_or_default())?;
    session.cdp.navigate(group_url.as_str()).await?;
    session.facebook.active_list_url = group_url.to_string();
    session.facebook.seen_post_ids.clear();
    wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    if let Some(output) = ensure_facebook_action_gate(session, command).await? {
        return Ok((EffectPhase::NotStarted, output));
    }

    let probe_command = NativeCommand::FeedRefresh(FeedRefreshParams {
        reason: Some("first_commentable_group_post_probe".to_owned()),
        think_ms: None,
    });
    let scroll_command = NativeCommand::BrowseScroll(ReasonParams {
        reason: Some("first_commentable_group_post_probe".to_owned()),
    });
    let mut latest = evaluate_facebook_router(session, &probe_command).await?;
    let mut candidate = first_same_group_post_target(&latest.1, &group_url);
    let mut probe_failure = first_post_probe_failure(&latest.1);

    for _ in 0..FIRST_POST_SCROLL_ROUNDS {
        if candidate.is_some()
            || probe_failure.is_some()
            || first_post_probe_is_exhausted(&latest.1)
        {
            break;
        }
        if facebook_command_cancelled(cancellation) {
            return Err(cancelled_before_dispatch());
        }
        latest = evaluate_facebook_router(session, &scroll_command).await?;
        candidate = first_same_group_post_target(&latest.1, &group_url);
        probe_failure = first_post_probe_failure(&latest.1);
    }

    let Some(candidate) = candidate else {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "open_note",
            false,
            probe_failure.unwrap_or("no_candidates"),
            None,
            None,
        ));
    };
    let candidate_id = candidate.note_id();
    if let FirstPostTarget::Permalink(candidate_url) = &candidate {
        session.cdp.navigate(candidate_url.as_str()).await?;
        wait_for_facebook_ready(session, Duration::from_secs(8)).await?;
    }

    let editor_reason = wait_for_first_post_editor(
        session,
        &candidate_id,
        FIRST_POST_EDITOR_TIMEOUT,
        cancellation,
    )
    .await?;
    if let Some(reason) = editor_reason {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "open_note",
            false,
            reason,
            Some(candidate_id),
            None,
        ));
    }

    let detail_command = NativeCommand::NoteOpen(NoteOpenParams {
        note_id: Some(candidate_id.clone()),
        url: match &candidate {
            FirstPostTarget::Permalink(url) => Some(url.to_string()),
            FirstPostTarget::BoundRef(_) => None,
        },
        surface: Some(match &candidate {
            FirstPostTarget::Permalink(_) => NoteSurface::Detail,
            FirstPostTarget::BoundRef(_) => NoteSurface::Feed,
        }),
        purpose: Some(NotePurpose::Read),
        ..NoteOpenParams::default()
    });
    let detail = match &candidate {
        FirstPostTarget::Permalink(candidate_url) => {
            let target_post_id = canonical_facebook_post_id(candidate_url.as_str())
                .expect("validated candidate has a post id");
            evaluate_facebook_router_until_requested_detail(
                session,
                &detail_command,
                &target_post_id,
                FIRST_POST_DETAIL_TIMEOUT,
            )
            .await
        }
        FirstPostTarget::BoundRef(target_ref) => {
            evaluate_facebook_router_until_bound_detail(
                session,
                &detail_command,
                target_ref,
                FIRST_POST_DETAIL_TIMEOUT,
            )
            .await
        }
    };
    match detail {
        Ok(result) => Ok(result),
        Err(error) if error.code == ErrorCode::ProbeFailed => Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "open_note",
            false,
            "target_context_mismatch",
            Some(candidate_id),
            None,
        )),
        Err(error) => Err(error),
    }
}

fn first_same_group_post_target(
    output: &CommandOutput,
    group_url: &Url,
) -> Option<FirstPostTarget> {
    let CommandOutput::PageCards(PageCards { cards, .. }) = output else {
        return None;
    };
    cards
        .iter()
        .filter_map(|card| card.note_id.as_deref())
        .find_map(|raw| {
            canonical_same_group_post_url(raw, group_url)
                .map(FirstPostTarget::Permalink)
                .or_else(|| {
                    is_first_post_target_ref(raw).then(|| FirstPostTarget::BoundRef(raw.to_owned()))
                })
        })
}

/// 首帖引用 = 内容派生的会话内引用（同一个东西，同一份判据）。
/// 泛化到整个信息流后判据被多处共用，故收口到 shared，这里只保留本模块的历史命名。
fn is_first_post_target_ref(value: &str) -> bool {
    is_facebook_content_ref(value)
}

fn first_post_probe_failure(output: &CommandOutput) -> Option<&'static str> {
    let CommandOutput::PageCards(PageCards {
        selection_reason: Some(reason),
        ..
    }) = output
    else {
        return None;
    };
    match reason.as_str() {
        "ambiguous_target" => Some("ambiguous_target"),
        "editor_not_found" => Some("editor_not_found"),
        "target_context_mismatch" => Some("target_context_mismatch"),
        _ => Some("target_context_mismatch"),
    }
}

fn first_post_probe_is_exhausted(output: &CommandOutput) -> bool {
    matches!(
        output,
        CommandOutput::PageCards(PageCards {
            movement: Some(movement),
            ..
        }) if movement.at_bottom == Some(true) && !movement.moved
    )
}

fn canonical_same_group_post_url(raw: &str, group_url: &Url) -> Option<Url> {
    let candidate = Url::parse(raw).ok()?;
    validate_facebook_origin(&candidate).ok()?;
    let group_parts = path_parts(group_url);
    let candidate_parts = path_parts(&candidate);
    let group_id = *group_parts.get(1)?;
    if group_parts.first() != Some(&"groups")
        || candidate_parts.first() != Some(&"groups")
        || candidate_parts.get(1) != Some(&group_id)
    {
        return None;
    }

    if matches!(candidate_parts.get(2), Some(&"posts") | Some(&"permalink")) {
        let post_id = *candidate_parts.get(3)?;
        if post_id.is_empty() {
            return None;
        }
        return Url::parse(&format!(
            "https://www.facebook.com/groups/{group_id}/{}/{post_id}",
            candidate_parts[2]
        ))
        .ok();
    }

    if candidate_parts.len() == 2 {
        let pairs: Vec<_> = candidate.query_pairs().collect();
        if pairs.len() != 1 || pairs[0].0 != "multi_permalinks" || pairs[0].1.is_empty() {
            return None;
        }
        let post_id = pairs[0].1.as_ref();
        let mut normalized =
            Url::parse(&format!("https://www.facebook.com/groups/{group_id}")).ok()?;
        normalized
            .query_pairs_mut()
            .append_pair("multi_permalinks", post_id);
        return Some(normalized);
    }
    None
}

fn path_parts(url: &Url) -> Vec<&str> {
    url.path_segments()
        .map(|parts| parts.filter(|part| !part.is_empty()).collect())
        .unwrap_or_default()
}

async fn wait_for_first_post_editor(
    session: &mut EngineSession,
    note_id: &str,
    timeout: Duration,
    cancellation: Option<&AtomicBool>,
) -> Result<Option<&'static str>, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut target_mismatch = false;
    let mut action_probed = false;
    loop {
        if facebook_command_cancelled(cancellation) {
            return Err(cancelled_before_dispatch());
        }
        let editor = probe_facebook_comment_editor(session, note_id).await?;
        if editor.ok {
            return Ok(None);
        }
        target_mismatch |= matches!(
            editor.reason.as_deref(),
            Some("target_context_mismatch" | "target_not_found")
        );
        if !action_probed && editor.reason.as_deref() == Some("editor_not_found") {
            action_probed = true;
            let action = probe_facebook_comment_action(session, note_id).await?;
            match action.reason.as_deref() {
                Some("ambiguous_target") => return Ok(Some("ambiguous_target")),
                Some("pending_group_approval") => return Ok(Some("pending_group_approval")),
                Some("target_context_mismatch" | "target_not_found") => target_mismatch = true,
                _ => {}
            }
            if action.ok {
                let (Some(x), Some(y)) = (action.cx, action.cy) else {
                    return Ok(Some("editor_not_found"));
                };
                if facebook_command_cancelled(cancellation) {
                    return Err(cancelled_before_dispatch());
                }
                dispatch_facebook_click(session, x, y).await?;
                continue;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(Some(if target_mismatch {
                "target_context_mismatch"
            } else {
                "editor_not_found"
            }));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn evaluate_facebook_router_until_bound_detail(
    session: &mut EngineSession,
    command: &NativeCommand,
    target_ref: &str,
    timeout: Duration,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let latest = evaluate_facebook_router(session, command).await?;
        if matches!(&latest.1, CommandOutput::NoteDetail(detail) if detail.note_id == target_ref) {
            return Ok(latest);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(EngineError::new(
                ErrorCode::ProbeFailed,
                "native Facebook bound first-post detail was not confirmed",
            ));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{PageCard, PageMovement};

    fn cards(note_ids: &[&str], movement: Option<PageMovement>) -> CommandOutput {
        CommandOutput::PageCards(PageCards {
            cards: note_ids
                .iter()
                .enumerate()
                .map(|(index, note_id)| PageCard {
                    index: index as u32,
                    title: String::new(),
                    author: None,
                    like_count: 0,
                    collect_count: 0,
                    cover_desc: None,
                    note_id: Some((*note_id).to_owned()),
                    note_id_kind: None,
                    is_video: None,
                })
                .collect(),
            movement,
            document_generation: None,
            container_name: None,
            list_kind: None,
            list_state: None,
            selection_reason: None,
        })
    }

    #[test]
    fn selects_only_the_first_canonical_post_from_the_exact_group() {
        let group = validated_facebook_group_url(
            "https://www.facebook.com/groups/945390701793119?sorting_setting=CHRONOLOGICAL",
        )
        .expect("group");
        let output = cards(
            &[
                "https://www.facebook.com/groups/42/posts/900",
                "https://www.facebook.com/groups/945390701793119/posts/111?tracking=ignored",
                "https://www.facebook.com/groups/945390701793119/posts/222",
            ],
            None,
        );
        let selected = first_same_group_post_target(&output, &group).expect("same-group post");
        assert_eq!(
            selected,
            FirstPostTarget::Permalink(
                Url::parse("https://www.facebook.com/groups/945390701793119/posts/111")
                    .expect("url")
            )
        );
    }

    #[test]
    fn accepts_only_strict_bound_first_post_references() {
        // 前缀的单一事实源在 shared（泛化后由整个信息流共用）。
        use super::super::shared::FACEBOOK_CONTENT_REF_PREFIX as FIRST_POST_TARGET_PREFIX;
        let group = validated_facebook_group_url("https://www.facebook.com/groups/945390701793119")
            .expect("group");
        let valid = format!("{FIRST_POST_TARGET_PREFIX}{}", "a1".repeat(32));
        let output = cards(&[&valid], None);
        assert_eq!(
            first_same_group_post_target(&output, &group),
            Some(FirstPostTarget::BoundRef(valid.clone()))
        );
        assert!(is_first_post_target_ref(&valid));
        assert!(!is_first_post_target_ref(&format!(
            "{FIRST_POST_TARGET_PREFIX}{}",
            "A1".repeat(32)
        )));
        assert!(!is_first_post_target_ref(&format!(
            "{FIRST_POST_TARGET_PREFIX}{}",
            "a1".repeat(31)
        )));
        assert!(!is_first_post_target_ref(
            "https://www.facebook.com/groups/945390701793119#opaque"
        ));
    }

    #[test]
    fn accepts_explicit_multi_permalink_and_rejects_group_root_or_opaque_fragment() {
        let group = validated_facebook_group_url("https://www.facebook.com/groups/945390701793119")
            .expect("group");
        assert_eq!(
            canonical_same_group_post_url(
                "https://www.facebook.com/groups/945390701793119?multi_permalinks=333",
                &group,
            )
            .expect("multi permalink")
            .as_str(),
            "https://www.facebook.com/groups/945390701793119?multi_permalinks=333"
        );
        assert!(
            canonical_same_group_post_url(
                "https://www.facebook.com/groups/945390701793119",
                &group
            )
            .is_none()
        );
        assert!(
            canonical_same_group_post_url(
                "https://www.facebook.com/groups/945390701793119#opaque",
                &group
            )
            .is_none()
        );
        assert!(
            canonical_same_group_post_url(
                "https://www.facebook.com/groups/945390701793119?multi_permalinks=333&tracking=1",
                &group
            )
            .is_none()
        );
    }

    #[test]
    fn stops_bounded_hydration_only_on_confirmed_bottom_without_movement() {
        assert!(first_post_probe_is_exhausted(&cards(
            &[],
            Some(PageMovement {
                before: 100.0,
                after: 100.0,
                moved: false,
                at_bottom: Some(true),
            }),
        )));
        assert!(!first_post_probe_is_exhausted(&cards(
            &[],
            Some(PageMovement {
                before: 100.0,
                after: 100.0,
                moved: false,
                at_bottom: Some(false),
            }),
        )));
    }
}
