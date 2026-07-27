use super::capability::{self, FacebookCapability};
use super::{comment, feed, feed_like, group_join, publish, reels, session};
use crate::commit_window::CommitWindowRequester;
use crate::engine::{CommandOutput, EngineSession};
use crate::error::{EngineError, ErrorCode};
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::AtomicBool;

pub(crate) async fn execute(
    engine_session: &mut EngineSession,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    commit_windows: &CommitWindowRequester,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
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
        FacebookCapability::Feed => feed::execute(engine_session, command).await,
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
