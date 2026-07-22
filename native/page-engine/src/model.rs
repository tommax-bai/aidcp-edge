use serde::{Deserialize, Serialize};

const MAX_CARDS: usize = 60;
const MAX_NOTIFICATION_ITEMS: usize = 100;
const MAX_COMMENT_CANDIDATES: usize = 50;
const MAX_IMAGES: usize = 20;
const MAX_TITLE_CHARS: usize = 200;
const MAX_BODY_CHARS: usize = 12_000;
const MAX_NAME_CHARS: usize = 200;
const MAX_REASON_CHARS: usize = 256;
const MAX_URL_CHARS: usize = 4_096;
const MAX_ID_CHARS: usize = 256;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PageCard {
    pub index: u32,
    pub title: String,
    #[serde(default)]
    pub author: Option<String>,
    pub like_count: u64,
    pub collect_count: u64,
    #[serde(default)]
    pub cover_desc: Option<String>,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub is_video: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PageCards {
    pub cards: Vec<PageCard>,
    #[serde(default)]
    pub movement: Option<PageMovement>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PageMovement {
    pub before: f64,
    pub after: f64,
    pub moved: bool,
    #[serde(default)]
    pub at_bottom: Option<bool>,
}

impl PageCards {
    pub fn bounded(mut self) -> Self {
        self.cards.truncate(MAX_CARDS);
        for card in &mut self.cards {
            truncate(&mut card.title, MAX_TITLE_CHARS);
            truncate_optional(&mut card.author, MAX_NAME_CHARS);
            truncate_optional(&mut card.cover_desc, MAX_TITLE_CHARS);
            truncate_optional(&mut card.note_id, MAX_ID_CHARS);
        }
        self
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NoteImage {
    pub index: u32,
    pub url: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub alt: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NoteDetail {
    pub note_id: String,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub media_type: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub author_id: Option<String>,
    pub like_count: u64,
    pub collect_count: u64,
    #[serde(default)]
    pub published_at_text: Option<String>,
    #[serde(default)]
    pub author_followed: Option<bool>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub images: Vec<NoteImage>,
    #[serde(default)]
    pub refresh_only: Option<bool>,
    #[serde(default)]
    pub comments: Vec<String>,
}

impl NoteDetail {
    pub fn bounded(mut self) -> Self {
        truncate(&mut self.note_id, MAX_ID_CHARS);
        truncate(&mut self.title, MAX_TITLE_CHARS);
        truncate(&mut self.content, MAX_BODY_CHARS);
        truncate_optional(&mut self.media_type, 32);
        truncate_optional(&mut self.author, MAX_NAME_CHARS);
        truncate_optional(&mut self.author_id, MAX_ID_CHARS);
        truncate_optional(&mut self.published_at_text, 128);
        truncate_optional(&mut self.url, MAX_URL_CHARS);
        self.images.truncate(MAX_IMAGES);
        for image in &mut self.images {
            truncate(&mut image.url, MAX_URL_CHARS);
            truncate_optional(&mut image.alt, MAX_TITLE_CHARS);
        }
        self.comments.truncate(MAX_COMMENT_CANDIDATES);
        for comment in &mut self.comments {
            truncate(comment, 1_000);
        }
        self
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProfileDetail {
    pub author_id: String,
    pub posts_count: u64,
    pub followers_count: u64,
    #[serde(default)]
    pub likes_collects: Option<u64>,
    #[serde(default)]
    pub extracted: Option<bool>,
    #[serde(default)]
    pub nickname: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

impl ProfileDetail {
    pub fn bounded(mut self) -> Self {
        truncate(&mut self.author_id, MAX_ID_CHARS);
        truncate_optional(&mut self.nickname, MAX_NAME_CHARS);
        truncate_optional(&mut self.url, MAX_URL_CHARS);
        self
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationKind {
    Comment,
    Mention,
    Like,
    Collect,
    Follow,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NotificationItem {
    pub kind: NotificationKind,
    pub from_user: String,
    #[serde(default)]
    pub from_user_id: Option<String>,
    pub content: String,
    #[serde(default)]
    pub note_title: Option<String>,
    #[serde(default)]
    pub item_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NotificationItems {
    pub items: Vec<NotificationItem>,
    #[serde(default)]
    pub epoch: Option<u64>,
}

impl NotificationItems {
    pub fn bounded(mut self) -> Self {
        self.items.truncate(MAX_NOTIFICATION_ITEMS);
        for item in &mut self.items {
            truncate(&mut item.from_user, MAX_NAME_CHARS);
            truncate_optional(&mut item.from_user_id, MAX_ID_CHARS);
            truncate(&mut item.content, 2_000);
            truncate_optional(&mut item.note_title, MAX_TITLE_CHARS);
            truncate_optional(&mut item.item_key, MAX_ID_CHARS);
        }
        self
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NotificationHome {
    pub comments: u32,
    pub likes: u32,
    pub follows: u32,
    #[serde(default)]
    pub epoch: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommentCandidate {
    pub anchor_id: String,
    #[serde(default)]
    pub author: Option<String>,
    pub text: String,
    #[serde(default)]
    pub already_liked: Option<bool>,
    #[serde(default)]
    pub like_count: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActionEvidence {
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default)]
    pub list_key: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub text_preview_head: Option<String>,
    #[serde(default)]
    pub reaction_text: Option<String>,
    #[serde(default)]
    pub article_index: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActionReceipt {
    pub action: String,
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub observation: Option<ActionEvidence>,
    #[serde(default)]
    pub candidates: Vec<CommentCandidate>,
}

impl ActionReceipt {
    pub fn bounded(mut self) -> Self {
        truncate(&mut self.action, 64);
        truncate_optional(&mut self.reason, MAX_REASON_CHARS);
        truncate_optional(&mut self.note_id, MAX_ID_CHARS);
        if let Some(observation) = &mut self.observation {
            truncate_optional(&mut observation.surface, 32);
            truncate_optional(&mut observation.list_key, MAX_ID_CHARS);
            truncate_optional(&mut observation.author, MAX_NAME_CHARS);
            truncate_optional(&mut observation.text_preview_head, 500);
            truncate_optional(&mut observation.reaction_text, 128);
        }
        self.candidates.truncate(MAX_COMMENT_CANDIDATES);
        for candidate in &mut self.candidates {
            truncate(&mut candidate.anchor_id, MAX_ID_CHARS);
            truncate_optional(&mut candidate.author, MAX_NAME_CHARS);
            truncate(&mut candidate.text, 1_000);
        }
        self
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PublishReceipt {
    pub record_id: u64,
    pub seq: u32,
    pub kind: String,
    pub ok: bool,
    #[serde(default)]
    pub submit_dispatched: Option<bool>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub post_url: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlanActionResult {
    pub action_id: String,
    pub ok: bool,
    pub outcome: String,
    pub attempts: u32,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlanResults {
    pub results: Vec<PlanActionResult>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CaptchaSnapshot {
    pub incident_id: String,
    pub snapshot_id: String,
    pub width: u32,
    pub height: u32,
    pub jpeg_base64: String,
}

impl CaptchaSnapshot {
    pub fn bounded(mut self) -> Self {
        truncate(&mut self.incident_id, MAX_ID_CHARS);
        truncate(&mut self.snapshot_id, MAX_ID_CHARS);
        if self.jpeg_base64.len() > 56 * 1024 {
            self.jpeg_base64.clear();
        }
        self
    }
}

impl PublishReceipt {
    pub fn bounded(mut self) -> Self {
        truncate(&mut self.kind, 64);
        truncate_optional(&mut self.value, MAX_ID_CHARS);
        truncate_optional(&mut self.post_url, MAX_URL_CHARS);
        truncate_optional(&mut self.error, MAX_REASON_CHARS);
        self
    }
}

impl PlanResults {
    pub fn bounded(mut self) -> Self {
        self.results.truncate(100);
        for result in &mut self.results {
            truncate(&mut result.action_id, 128);
            truncate(&mut result.outcome, 64);
            truncate(&mut result.reason, MAX_REASON_CHARS);
            result.attempts = result.attempts.min(10);
        }
        self
    }
}

fn truncate_optional(value: &mut Option<String>, max_chars: usize) {
    if let Some(value) = value {
        truncate(value, max_chars);
    }
}

fn truncate(value: &mut String, max_chars: usize) {
    if value.chars().count() <= max_chars {
        return;
    }
    *value = value.chars().take(max_chars).collect();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_text_and_list_outputs() {
        let cards = PageCards {
            cards: (0..100)
                .map(|index| PageCard {
                    index,
                    title: "a".repeat(500),
                    author: Some("b".repeat(500)),
                    like_count: 1,
                    collect_count: 2,
                    cover_desc: None,
                    note_id: Some("n".repeat(500)),
                    is_video: Some(false),
                })
                .collect(),
            movement: None,
        }
        .bounded();
        assert_eq!(cards.cards.len(), MAX_CARDS);
        assert_eq!(cards.cards[0].title.chars().count(), MAX_TITLE_CHARS);
        assert_eq!(
            cards.cards[0]
                .note_id
                .as_ref()
                .expect("note id")
                .chars()
                .count(),
            MAX_ID_CHARS
        );
    }

    #[test]
    fn rejects_unbounded_or_sensitive_extra_fields() {
        let error = serde_json::from_value::<PageCards>(serde_json::json!({
            "cards": [],
            "outerHTML": "sensitive"
        }))
        .expect_err("unknown sensitive field");
        assert!(error.to_string().contains("unknown field"));
    }
}
