use super::capability::{self, FacebookCapability};
use super::shared::{
    cancelled_before_dispatch, canonical_facebook_post_id, ensure_facebook_action_gate,
    evaluate_facebook_router, evaluate_facebook_router_until_requested_detail,
    facebook_action_result, facebook_command_cancelled, probe_facebook_comment_editor,
    validate_facebook_origin, validated_facebook_group_url, wait_for_facebook_ready,
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
const FIRST_POST_EDITOR_TIMEOUT: Duration = Duration::from_secs(4);
const FIRST_POST_DETAIL_TIMEOUT: Duration = Duration::from_secs(8);

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
    let mut candidate = first_same_group_post_url(&latest.1, &group_url);

    for _ in 0..FIRST_POST_SCROLL_ROUNDS {
        if candidate.is_some() || first_post_probe_is_exhausted(&latest.1) {
            break;
        }
        if facebook_command_cancelled(cancellation) {
            return Err(cancelled_before_dispatch());
        }
        latest = evaluate_facebook_router(session, &scroll_command).await?;
        candidate = first_same_group_post_url(&latest.1, &group_url);
    }

    let Some(candidate) = candidate else {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "open_note",
            false,
            "no_candidates",
            None,
            None,
        ));
    };
    let candidate_url = candidate.to_string();
    session.cdp.navigate(candidate.as_str()).await?;
    wait_for_facebook_ready(session, Duration::from_secs(8)).await?;

    let editor_reason =
        wait_for_first_post_editor(session, &candidate_url, FIRST_POST_EDITOR_TIMEOUT).await?;
    if let Some(reason) = editor_reason {
        return Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "open_note",
            false,
            reason,
            Some(candidate_url),
            None,
        ));
    }

    let detail_command = NativeCommand::NoteOpen(NoteOpenParams {
        note_id: Some(candidate_url.clone()),
        url: Some(candidate_url),
        surface: Some(NoteSurface::Detail),
        purpose: Some(NotePurpose::Read),
        ..NoteOpenParams::default()
    });
    let target_post_id =
        canonical_facebook_post_id(candidate.as_str()).expect("validated candidate has a post id");
    match evaluate_facebook_router_until_requested_detail(
        session,
        &detail_command,
        &target_post_id,
        FIRST_POST_DETAIL_TIMEOUT,
    )
    .await
    {
        Ok(result) => Ok(result),
        Err(error) if error.code == ErrorCode::ProbeFailed => Ok(facebook_action_result(
            EffectPhase::NotStarted,
            "open_note",
            false,
            "target_context_mismatch",
            Some(candidate.to_string()),
            None,
        )),
        Err(error) => Err(error),
    }
}

fn first_same_group_post_url(output: &CommandOutput, group_url: &Url) -> Option<Url> {
    let CommandOutput::PageCards(PageCards { cards, .. }) = output else {
        return None;
    };
    cards
        .iter()
        .filter_map(|card| card.note_id.as_deref())
        .find_map(|raw| canonical_same_group_post_url(raw, group_url))
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
) -> Result<Option<&'static str>, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut target_mismatch = false;
    loop {
        let editor = probe_facebook_comment_editor(session, note_id).await?;
        if editor.ok {
            return Ok(None);
        }
        target_mismatch |= editor.reason.as_deref() == Some("target_context_mismatch");
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
                    is_video: None,
                })
                .collect(),
            movement,
            document_generation: None,
            container_name: None,
            list_kind: None,
            list_state: None,
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
        assert_eq!(
            first_same_group_post_url(&output, &group)
                .expect("same-group post")
                .as_str(),
            "https://www.facebook.com/groups/945390701793119/posts/111"
        );
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
