//! 「动作回执 + 随行观测」这个输出载体的线上形状契约。
//!
//! 一条命令只能回一个输出，而看图翻页与分类通知栏这两类终局既要让云端的动作角色结案（回执），
//! 又必须把本次真看到的东西一并送到云端（翻页中新加载的图片是参考图刷新的唯一来源，
//! 通知条目是联系人名册的唯一来源）。这组用例锁三件事：
//! ① 线上 kind 与两段载荷的字段名不漂；② 没有观测时不凭空造出空壳字段；
//! ③ 发布命令用不了这个 kind（用了就诚实报无效结果，绝不静默降级成发布回执）。

use aidcp_page_engine::command::{
    NativeCommand, PublishCaptureParams, PublishCoverParams, PublishIdentity,
};
use aidcp_page_engine::engine::CommandOutput;
use aidcp_page_engine::xhs::typed_output;
use serde_json::{Value, json};

fn browse_images_command() -> NativeCommand {
    serde_json::from_str(r#"{"kind":"note_browse_images","params":{"noteId":"n1","count":2}}"#)
        .expect("command")
}

fn receipt(reason: &str) -> Value {
    json!({ "action": "browse_images", "ok": true, "reason": reason, "noteId": "n1" })
}

#[test]
fn carries_the_receipt_and_the_trailing_snapshot_through_one_output() {
    let output = typed_output(
        &browse_images_command(),
        json!({
            "kind": "action_receipt_with_observation",
            "value": {
                "receipt": receipt("browsed=2"),
                "noteDetail": {
                    "noteId": "n1",
                    "title": "一篇有图的笔记",
                    "content": "正文",
                    "likeCount": 3,
                    "collectCount": 1,
                    "refreshOnly": true,
                    "images": [{ "index": 0, "url": "https://ci.xiaohongshu.com/img3.jpg" }],
                },
            },
        }),
    )
    .expect("typed output");

    let CommandOutput::ActionReceiptWithObservation(observed) = &output else {
        panic!("expected the observed-receipt output arm");
    };
    assert_eq!(observed.receipt.action, "browse_images");
    assert_eq!(observed.receipt.reason.as_deref(), Some("browsed=2"));
    let detail = observed.note_detail.as_ref().expect("trailing snapshot");
    assert_eq!(detail.refresh_only, Some(true));
    assert_eq!(detail.images.len(), 1);
    assert!(observed.notification_items.is_none());

    // 线上形状：kind 与两段载荷的字段名是宿主与云端都读的契约，漂了就静默丢一半。
    let wire = serde_json::to_value(&output).expect("serialize");
    assert_eq!(wire["kind"], "action_receipt_with_observation");
    assert_eq!(wire["value"]["receipt"]["action"], "browse_images");
    assert_eq!(wire["value"]["noteDetail"]["refreshOnly"], true);
    // 没有观测的那一段不得以 null 出现，否则宿主会把它当成「有一段空观测」。
    assert!(wire["value"].get("notificationItems").is_none());
}

#[test]
fn keeps_a_bare_receipt_bare_when_nothing_was_observed() {
    let output = typed_output(
        &browse_images_command(),
        json!({
            "kind": "action_receipt_with_observation",
            "value": { "receipt": { "action": "browse_images", "ok": false, "reason": "no_target" } },
        }),
    )
    .expect("typed output");

    let wire = serde_json::to_value(&output).expect("serialize");
    assert_eq!(wire["value"]["receipt"]["ok"], false);
    assert_eq!(wire["value"]["receipt"]["reason"], "no_target");
    assert!(wire["value"].get("noteDetail").is_none());
}

#[test]
fn refuses_the_observed_receipt_for_publish_commands() {
    // 发布命令没有可填的 recordId / seq 语义，把这个 kind 降级成发布回执就是伪造发布结果。
    let command = NativeCommand::PublishSubmit(PublishIdentity {
        record_id: 7,
        seq: 3,
    });
    let result = typed_output(
        &command,
        json!({
            "kind": "action_receipt_with_observation",
            "value": { "receipt": { "action": "submit", "ok": true } },
        }),
    );
    assert!(result.is_err(), "publish commands must not use this kind");
}

#[test]
fn refuses_generic_receipts_for_typed_publish_terminals() {
    let capture = PublishCaptureParams {
        record_id: 7,
        seq: 3,
        scheduled_title: Some("scheduled title".to_owned()),
        scheduled_platform_id: Some("note-7".to_owned()),
        publish_time: Some(1_785_729_240_000),
    };
    let commands = [
        NativeCommand::PublishSubmit(PublishIdentity {
            record_id: 7,
            seq: 3,
        }),
        NativeCommand::PublishCapturePostId(capture.clone()),
        NativeCommand::PublishCaptureScheduled(capture.clone()),
        NativeCommand::PublishReconcileScheduled(capture),
    ];

    let accepted = commands
        .iter()
        .filter_map(|command| {
            typed_output(
                command,
                json!({
                    "kind": "action_receipt",
                    "value": { "action": command.kind(), "ok": true },
                }),
            )
            .is_ok()
            .then_some(command.kind())
        })
        .collect::<Vec<_>>();

    assert!(
        accepted.is_empty(),
        "typed publish terminals accepted generic receipts: {accepted:?}"
    );
}

#[test]
fn still_adapts_generic_receipts_for_draft_writes() {
    let command = NativeCommand::PublishSetCover(PublishCoverParams {
        record_id: 7,
        seq: 3,
        image_index: 1,
    });

    let output = typed_output(
        &command,
        json!({
            "kind": "action_receipt",
            "value": { "action": "set_cover", "ok": true },
        }),
    )
    .expect("draft writes may use generic action receipts");

    let CommandOutput::PublishReceipt(receipt) = output else {
        panic!("expected a publish receipt");
    };
    assert_eq!(receipt.record_id, 7);
    assert_eq!(receipt.seq, 3);
    assert_eq!(receipt.kind, "set_cover");
    assert!(receipt.ok);
    assert_eq!(receipt.submit_dispatched, None);
    assert_eq!(receipt.value, None);
    assert_eq!(receipt.post_url, None);
}
