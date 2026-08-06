use super::feed::execute_facebook_feed_scroll;
use super::shared::*;
use crate::engine::{CommandOutput, EngineSession, FacebookReelProbeKey};
use crate::error::{EngineError, ErrorCode};
use crate::facebook;
use crate::input::unix_time_ms;
use crate::model::FacebookListKind;
use crate::protocol::{EffectPhase, NativeCommand};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Reels 已到达或活动视频已切换后，等待规范身份与卡片完成水合的有界窗口。
const FACEBOOK_REEL_IDENTITY_HYDRATION_TIMEOUT: Duration = Duration::from_secs(15);
/// Leave enough absolute command budget for the two-event trusted key gesture itself.
const FACEBOOK_REEL_KEY_DISPATCH_RESERVE_MS: u64 = 1_000;
const FACEBOOK_REEL_ENTRY_POST_INPUT_RESERVE_MS: u64 = 18_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReelNavigationMode {
    Standard,
    AnonymousEntry,
}

pub(crate) async fn execute(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let NativeCommand::InteractionFollow(params) = command else {
        return Err(EngineError::new(
            ErrorCode::EngineInternal,
            "native Facebook Reels capability received another owner's command",
        ));
    };
    execute_facebook_follow(session, params, command).await
}

pub(crate) async fn execute_facebook_follow(
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
    if fresh.note_id != before.note_id || fresh.author != before.author {
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
    let expected_post_id = fresh
        .note_id
        .as_deref()
        .and_then(canonical_facebook_post_id);
    let expected_author = fresh.author.clone();
    loop {
        let after = probe_facebook_follow(session, Some(expected_note_id)).await?;
        let observed_post_id = after
            .note_id
            .as_deref()
            .and_then(canonical_facebook_post_id);
        let observed_another_reel = observed_post_id
            .as_deref()
            .is_some_and(|observed| expected_post_id.as_deref() != Some(observed));
        let observed_another_author = after
            .author
            .as_deref()
            .filter(|author| !author.is_empty())
            .is_some_and(|author| expected_author.as_deref() != Some(author));
        // Re-render gaps may recover inside the existing window, but an observed different Reel
        // or author is conclusive target movement and must stop verification immediately.
        if observed_another_reel || observed_another_author {
            return Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "follow",
                false,
                "verify_indeterminate",
                fresh.note_id,
                None,
            ));
        }
        let probe_readable = after.ok
            && observed_post_id.is_some()
            && observed_post_id == expected_post_id
            && after.author == expected_author;
        if probe_readable && after.already {
            return Ok(facebook_action_result(
                EffectPhase::Confirmed,
                "follow",
                true,
                "",
                after.note_id,
                None,
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(facebook_action_result(
                EffectPhase::Ambiguous,
                "follow",
                false,
                if probe_readable {
                    "follow_unconfirmed"
                } else {
                    "verify_indeterminate"
                },
                fresh.note_id,
                None,
            ));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

pub(crate) async fn execute_facebook_page_scroll(
    session: &mut EngineSession,
    command: &NativeCommand,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    let (declared_surface, foreground_activated) = match command {
        NativeCommand::PageScroll(params) => (
            params.surface,
            params.reason.as_deref() == Some("idle_recover_nudge"),
        ),
        _ => (None, false),
    };
    if foreground_activated {
        session.cdp.bring_to_front().await?;
    }
    let before = probe_facebook_reel(session).await?;
    let observed_reels = before.is_reels_surface();
    // 词汇批 4：面由命令名声明。声明与观测不符 ⇒ 诚实失败（确认到不符，回报观测面），
    // MUST NOT 静默改跑另一面的执行器（facebook-reels-native-scroll spec）。
    match declared_surface {
        Some(crate::command::BrowseSurface::Reels) if !observed_reels => {
            return Ok(facebook_scroll_failure(
                EffectPhase::NotStarted,
                "surface_mismatch_observed_list",
            ));
        }
        Some(crate::command::BrowseSurface::Feed | crate::command::BrowseSurface::Search)
            if observed_reels =>
        {
            return Ok(facebook_scroll_failure(
                EffectPhase::NotStarted,
                "surface_mismatch_observed_reels",
            ));
        }
        _ => {}
    }
    if !observed_reels {
        return execute_facebook_feed_scroll(
            session,
            cancellation,
            deadline_unix_ms,
            foreground_activated,
        )
        .await;
    }
    execute_facebook_reel_navigation(
        session,
        command,
        ReelNavigationMode::Standard,
        cancellation,
        deadline_unix_ms,
    )
    .await
}

pub(crate) async fn finish_facebook_reels_entry(
    session: &mut EngineSession,
    command: &NativeCommand,
    initial: &facebook::FacebookReelProbe,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if let Some(output) = wait_for_canonical_facebook_reel_card(
        session,
        command,
        initial,
        false,
        FACEBOOK_REEL_IDENTITY_HYDRATION_TIMEOUT,
    )
    .await?
    {
        return Ok((EffectPhase::Confirmed, output));
    }

    let fresh = probe_facebook_reel(session).await?;
    if !fresh.is_reels_surface() {
        return Ok(facebook_scroll_failure(
            EffectPhase::Ambiguous,
            "reels_entry_unconfirmed",
        ));
    }
    execute_facebook_reel_navigation(
        session,
        command,
        ReelNavigationMode::AnonymousEntry,
        cancellation,
        deadline_unix_ms,
    )
    .await
}

async fn execute_facebook_reel_navigation(
    session: &mut EngineSession,
    command: &NativeCommand,
    mode: ReelNavigationMode,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(EffectPhase, CommandOutput), EngineError> {
    if let Some(result) = reel_write_gate(cancellation, deadline_unix_ms, mode)? {
        return Ok(result);
    }

    let before = probe_facebook_reel(session).await?;
    if !before.is_reels_surface() || !before.is_explicitly_keyboard_input_safe() {
        return Ok(facebook_scroll_failure(
            navigation_predispatch_failure_phase(mode),
            "reels_target_unavailable",
        ));
    }
    if let Some(result) = reel_write_gate(cancellation, deadline_unix_ms, mode)? {
        return Ok(result);
    }

    let probe_key = session.facebook.reel_probe_key();
    let (key, key_code) = reel_probe_key_params(probe_key);
    session
        .cdp
        .dispatch_key("rawKeyDown", key, key, key_code)
        .await?;
    session.facebook.remember_reel_probe_delivery(probe_key);
    session
        .cdp
        .dispatch_key("keyUp", key, key, key_code)
        .await?;

    if let Some(output) = wait_for_canonical_facebook_reel_card(
        session,
        command,
        &before,
        true,
        FACEBOOK_REEL_IDENTITY_HYDRATION_TIMEOUT,
    )
    .await?
    {
        session.facebook.remember_reel_probe_confirmation(probe_key);
        return Ok((EffectPhase::Confirmed, output));
    }

    // 有界观测结束仍未确认。这里已经为了选原因码再读了一次页面，读到的身份 MUST NOT 再丢掉：
    // 它是「此刻站在哪条 Reel 上」这个事实的唯一现成证据，消费方靠它把「没往前走」（身份与前态
    // 相同）与「读不出身份」分开。
    let current = probe_facebook_reel(session).await?;
    Ok(unconfirmed_navigation_receipt(current.note_id.as_deref()))
}

/// 未确认回执：原因码与所带身份出自**同一次解析**，因此二者不可能不一致——解析得到 canonical
/// Reel 身份即 `reels_navigation_unconfirmed` 并带上该 Reel，解析不到即 `reels_identity_unresolved`
/// 且不带身份。MUST NOT 拆成两处分别判断：一旦出现「报了 unconfirmed 却不带身份」，消费方就又回到
/// 分不清「没往前走」和「读不出来」的状态，而这正是本 change 要消除的那个二义。
///
/// 回传的是**观测到的原始 note_id**（完整 Reel 链接），不是 `canonical_reel_id` 规范化后的裸 id：
/// 卡片侧 `note_id` 用的就是完整链接，消费方要拿这两者比对。回传规范化裸 id 会让它跟自己手上的
/// 上一条 Reel 身份比不上——格式不同，比对恒不相等，「没往前走」会被读成「换了一条」。
/// 规范化只用于**判定**身份是否可用，不用于回传。
///
/// 带身份不产出卡片、不记 view——既有的「未确认不产卡」规则不变。
fn unconfirmed_navigation_receipt(observed_note_id: Option<&str>) -> (EffectPhase, CommandOutput) {
    let (reason, identity) = if canonical_reel_id(observed_note_id).is_some() {
        (
            "reels_navigation_unconfirmed",
            observed_note_id.map(str::to_owned),
        )
    } else {
        ("reels_identity_unresolved", None)
    };
    facebook_scroll_failure_with_identity(EffectPhase::Ambiguous, reason, identity)
}

pub(crate) async fn probe_facebook_reel(
    session: &mut EngineSession,
) -> Result<facebook::FacebookReelProbe, EngineError> {
    let expression = facebook::reel_probe_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    facebook::reel_probe_from_cdp(&raw)
}

async fn wait_for_canonical_facebook_reel_card(
    session: &mut EngineSession,
    command: &NativeCommand,
    previous: &facebook::FacebookReelProbe,
    require_movement: bool,
    timeout: Duration,
) -> Result<Option<CommandOutput>, EngineError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(output) =
            read_canonical_facebook_reel_card(session, command, previous, require_movement).await?
        {
            return Ok(Some(output));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(None);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn read_canonical_facebook_reel_card(
    session: &mut EngineSession,
    command: &NativeCommand,
    previous: &facebook::FacebookReelProbe,
    require_movement: bool,
) -> Result<Option<CommandOutput>, EngineError> {
    let (output, current) = read_facebook_reel_card_snapshot(session, command).await?;
    Ok(
        canonical_facebook_reel_card_matches(&output, &current, previous, require_movement)
            .then_some(output),
    )
}

async fn read_facebook_reel_card_snapshot(
    session: &mut EngineSession,
    command: &NativeCommand,
) -> Result<(CommandOutput, facebook::FacebookReelProbe), EngineError> {
    let expression = facebook::reel_cards_expression()?;
    let raw = session.cdp.evaluate(&expression, true).await?;
    let result = facebook::result_from_cdp(&raw)?;
    let output = facebook::typed_output(command, result.output, session.cdp.target_id())?;
    let current = probe_facebook_reel(session).await?;
    Ok((output, current))
}

/// 翻页后的确认判据，只由四件事组成：观测是卡片批次、面别是 Reels、卡片侧与探针侧身份**各自**
/// 都能解析成 canonical Reel 身份、以及（需要位移时）探针侧身份不同于前态身份。
///
/// **MUST NOT 再加回「两侧身份必须相等」那一条。** 它看着像交叉验证，实际两侧同源：卡片侧走
/// `feedCards()`，而它在 Reels 面上第一行就调 `safeActiveReel()`、并只用该调用返回的那个节点产卡
/// （`facebook-router/20-feed.js:122-124`）；探针侧直接调同一个函数。两者只可能因「两次 CDP 往返
/// 之间页面推进了」而不等 —— 而刚投递完翻页键正是最容易推进的时刻。所以那条判据抓不到任何来源
/// 分歧（根本没有第二个来源），只会把真实的翻页判成未确认。
///
/// 卡片侧身份仍要求可解析,但理由与位移无关:云端后续按卡片身份定位这条 Reel 去点赞,身份不可用
/// 的卡片报上去会把一次「未确认翻页」换成一次「点赞找不到目标」。
///
/// 同理 MUST NOT 加回 list_state / 卡片计数 / 探针 ok 标志 / is_video / 身份种类白名单:前两者在
/// Reels 面上互为同义（该面读取器只产 0 或 1 张卡,ready 的定义即非空）,探针 ok 被「身份可解析」
/// 蕴含（探针失败时结构里没有身份字段）,后两者是在收窄一个已经是 canonical `/reel/` 的链接。
fn canonical_facebook_reel_card_matches(
    output: &CommandOutput,
    current: &facebook::FacebookReelProbe,
    previous: &facebook::FacebookReelProbe,
    require_movement: bool,
) -> bool {
    let CommandOutput::PageCards(cards) = output else {
        return false;
    };
    if cards.list_kind != Some(FacebookListKind::Reels) {
        return false;
    }
    // checked 取值：卡片计数判断已删除，这里 MUST NOT 退回定长索引——空批次会越界 panic。
    // 取不到卡片即判不确认，与删除计数判断前的行为一致。
    let Some(card) = cards.cards.first() else {
        return false;
    };
    let (Some(current_id), Some(_card_id)) = (
        canonical_reel_id(current.note_id.as_deref()),
        canonical_reel_id(card.note_id.as_deref()),
    ) else {
        return false;
    };
    if !require_movement {
        return true;
    }
    canonical_reel_id(previous.note_id.as_deref()).as_ref() != Some(&current_id)
}

fn canonical_reel_id(note_id: Option<&str>) -> Option<String> {
    note_id
        .filter(|value| is_facebook_reel_url(value))
        .and_then(canonical_facebook_post_id)
}

fn reel_write_gate(
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
    mode: ReelNavigationMode,
) -> Result<Option<(EffectPhase, CommandOutput)>, EngineError> {
    if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
        return Ok(Some(facebook_scroll_failure(
            navigation_predispatch_failure_phase(mode),
            "reels_navigation_cancelled",
        )));
    }
    let remaining_ms = deadline_unix_ms.saturating_sub(unix_time_ms());
    let required_ms = if mode == ReelNavigationMode::AnonymousEntry {
        FACEBOOK_REEL_ENTRY_POST_INPUT_RESERVE_MS
    } else {
        FACEBOOK_REEL_KEY_DISPATCH_RESERVE_MS
    };
    if remaining_ms < required_ms {
        return Ok(Some(facebook_scroll_failure(
            navigation_predispatch_failure_phase(mode),
            "reels_navigation_deadline_insufficient",
        )));
    }
    Ok(None)
}

fn navigation_predispatch_failure_phase(mode: ReelNavigationMode) -> EffectPhase {
    if mode == ReelNavigationMode::AnonymousEntry {
        EffectPhase::Ambiguous
    } else {
        EffectPhase::NotStarted
    }
}

pub(crate) fn reel_probe_key_params(key: FacebookReelProbeKey) -> (&'static str, u32) {
    match key {
        FacebookReelProbeKey::ArrowRight => ("ArrowRight", 39),
        FacebookReelProbeKey::ArrowDown => ("ArrowDown", 40),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FacebookListState, PageCard, PageCards, PostIdentityKind};

    fn reel_probe(note_id: Option<&str>) -> facebook::FacebookReelProbe {
        facebook::FacebookReelProbe {
            ok: true,
            reason: None,
            note_id: note_id.map(str::to_owned),
            video_rect: None,
            input_safe: Some(true),
        }
    }

    fn reel_cards(note_id: &str, kind: Option<PostIdentityKind>, count: usize) -> CommandOutput {
        CommandOutput::PageCards(PageCards {
            cards: (0..count)
                .map(|index| PageCard {
                    index: index as u32,
                    title: "Reel".to_owned(),
                    author: None,
                    like_count: 0,
                    collect_count: 0,
                    cover_desc: None,
                    note_id: Some(note_id.to_owned()),
                    note_id_kind: kind,
                    is_video: Some(true),
                })
                .collect(),
            movement: None,
            document_generation: None,
            container_name: None,
            list_kind: Some(FacebookListKind::Reels),
            list_state: Some(FacebookListState::Ready),
            selection_reason: None,
        })
    }

    #[test]
    fn reel_identity_hydration_window_is_fifteen_seconds() {
        assert_eq!(
            FACEBOOK_REEL_IDENTITY_HYDRATION_TIMEOUT,
            Duration::from_secs(15)
        );
    }

    #[test]
    fn canonical_reel_completion_uses_only_note_identity() {
        let anonymous = reel_probe(None);
        let first = reel_probe(Some("https://www.facebook.com/reel/1"));
        let second = reel_probe(Some("https://www.facebook.com/reel/2"));
        let first_card = reel_cards("https://www.facebook.com/reel/1", None, 1);
        let second_card = reel_cards("https://www.facebook.com/reel/2", None, 1);

        assert!(canonical_facebook_reel_card_matches(
            &first_card,
            &first,
            &anonymous,
            false,
        ));
        assert!(canonical_facebook_reel_card_matches(
            &first_card,
            &first,
            &anonymous,
            true,
        ));
        assert!(!canonical_facebook_reel_card_matches(
            &first_card,
            &first,
            &first,
            true,
        ));
        assert!(canonical_facebook_reel_card_matches(
            &second_card,
            &second,
            &first,
            true,
        ));
    }

    #[test]
    fn canonical_reel_completion_rejects_uncanonical_card_identity() {
        let before = reel_probe(Some("https://www.facebook.com/reel/1"));

        // 卡片身份解析不出 canonical Reel 身份 ⇒ 不确认。这一条与位移无关：云端后续按卡片身份
        // 定位该 Reel 去点赞，放行一张身份不可用的卡片，只是把「未确认翻页」换成后面一次
        // 「点赞找不到目标」。
        let content_ref = reel_cards(
            "facebook-content-ref:session:2",
            Some(PostIdentityKind::ContentRef),
            1,
        );
        let content_ref_probe = reel_probe(Some("facebook-content-ref:session:2"));
        assert!(!canonical_facebook_reel_card_matches(
            &content_ref,
            &content_ref_probe,
            &before,
            true,
        ));

        // 探针身份解析不出 ⇒ 同样不确认（位移无从判起）。
        let good_card = reel_cards("https://www.facebook.com/reel/2", None, 1);
        assert!(!canonical_facebook_reel_card_matches(
            &good_card,
            &content_ref_probe,
            &before,
            true,
        ));
    }

    /// 判据收敛（change converge-facebook-reel-navigation-confirmation）：结构性观测 MUST NOT
    /// 否决一次已经由身份位移证明了的翻页。这些条件此前各自都能把真实翻页判成未确认。
    #[test]
    fn structural_observations_do_not_veto_confirmed_transition() {
        let before = reel_probe(Some("https://www.facebook.com/reel/1"));
        let current = reel_probe(Some("https://www.facebook.com/reel/2"));

        // list_state 非 Ready、卡片非视频、身份种类非 Permalink —— 三者同时不满足。
        let mut cards = reel_cards(
            "https://www.facebook.com/reel/2",
            Some(PostIdentityKind::ContentRef),
            1,
        );
        if let CommandOutput::PageCards(ref mut value) = cards {
            value.list_state = Some(FacebookListState::PresentUnreportable);
            value.cards[0].is_video = Some(false);
        }
        assert!(canonical_facebook_reel_card_matches(
            &cards, &current, &before, true,
        ));

        // 探针 ok 标志为假，但身份仍解析得到 —— ok 标志被「身份可解析」蕴含，不再单独判。
        let mut not_ok = current.clone();
        not_ok.ok = false;
        assert!(canonical_facebook_reel_card_matches(
            &cards, &not_ok, &before, true,
        ));

        // 多卡批次：取第一张判定，不再因计数否决。真实 Reels 面上该分支不可达——该面读取器
        // 只产 0 或 1 张卡（facebook-router/20-feed.js:122-124），此处仅锁住取值行为。
        let multiple = reel_cards("https://www.facebook.com/reel/2", None, 2);
        assert!(canonical_facebook_reel_card_matches(
            &multiple, &current, &before, true,
        ));
    }

    /// 卡片侧与探针侧同源（`feedCards()` 内部就调 `safeActiveReel()`），两者只可能因一次 CDP
    /// 往返间的推进而不等。要求相等抓不到任何来源分歧，只会把真实翻页判成未确认。
    #[test]
    fn settling_surface_does_not_defeat_real_transition() {
        let before = reel_probe(Some("https://www.facebook.com/reel/1"));
        let current = reel_probe(Some("https://www.facebook.com/reel/2"));
        let later_card = reel_cards("https://www.facebook.com/reel/3", None, 1);

        assert!(canonical_facebook_reel_card_matches(
            &later_card,
            &current,
            &before,
            true,
        ));
    }

    /// 删掉卡片计数判断后，取值 MUST 是 checked 的：空批次判不确认，绝不越界 panic。
    #[test]
    fn empty_card_batch_is_unconfirmed_not_fatal() {
        let before = reel_probe(Some("https://www.facebook.com/reel/1"));
        let current = reel_probe(Some("https://www.facebook.com/reel/2"));
        let empty = reel_cards("https://www.facebook.com/reel/2", None, 0);

        assert!(!canonical_facebook_reel_card_matches(
            &empty, &current, &before, true,
        ));
        assert!(!canonical_facebook_reel_card_matches(
            &empty, &current, &before, false,
        ));
    }

    /// 未确认回执：原因码与所带身份出自同一次解析，二者不可能不一致；且回传的是完整链接、
    /// 不是规范化裸 id——消费方要拿它跟卡片侧的 `note_id` 比对，格式必须同源。
    #[test]
    fn unconfirmed_receipt_carries_the_identity_it_named() {
        let (phase, output) =
            unconfirmed_navigation_receipt(Some("https://www.facebook.com/reel/2"));
        assert_eq!(phase, EffectPhase::Ambiguous);
        let CommandOutput::ActionReceipt(receipt) = output else {
            panic!("expected unconfirmed receipt")
        };
        assert_eq!(
            receipt.reason.as_deref(),
            Some("reels_navigation_unconfirmed")
        );
        assert_eq!(
            receipt.note_id.as_deref(),
            Some("https://www.facebook.com/reel/2"),
            "identity must round-trip in the same shape the card side uses"
        );
        assert!(!receipt.ok);

        // 读不到任何身份。
        let (_, output) = unconfirmed_navigation_receipt(None);
        let CommandOutput::ActionReceipt(receipt) = output else {
            panic!("expected unresolved receipt")
        };
        assert_eq!(receipt.reason.as_deref(), Some("reels_identity_unresolved"));
        assert_eq!(receipt.note_id, None);

        // 读到了某个身份，但它不是 canonical Reel 链接 ⇒ 与「读不到」同档，且 MUST NOT 把这个
        // 不可用的值当身份传下去。
        let (_, output) = unconfirmed_navigation_receipt(Some("facebook-content-ref:session:2"));
        let CommandOutput::ActionReceipt(receipt) = output else {
            panic!("expected unresolved receipt")
        };
        assert_eq!(receipt.reason.as_deref(), Some("reels_identity_unresolved"));
        assert_eq!(receipt.note_id, None);
    }

    #[test]
    fn cancelled_navigation_terminates_without_input_state() {
        let cancelled = AtomicBool::new(true);
        let (phase, output) =
            reel_write_gate(Some(&cancelled), u64::MAX, ReelNavigationMode::Standard)
                .expect("navigation gate")
                .expect("cancelled receipt");
        assert_eq!(phase, EffectPhase::NotStarted);
        let CommandOutput::ActionReceipt(receipt) = output else {
            panic!("expected cancellation receipt")
        };
        assert_eq!(
            receipt.reason.as_deref(),
            Some("reels_navigation_cancelled")
        );
    }
}
