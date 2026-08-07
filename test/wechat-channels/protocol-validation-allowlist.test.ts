/**
 * 收件箱协议验证名单的逐名穷举断言。
 *
 * `INTERACTION_TYPES` 是 `Set<MessageType>`——成员是联集子集即可编译，删一条不报错，
 * 后果是该消息在 `validateInteractionEnvelope` 入口被当「非本族消息」静默拒收。
 * 批 6a 集成变异验证实测删条存活（2026-08-07），补本测试钉死全员。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isInteractionMessageType } from '../../src/wechat-channels/protocol-validation.js';

const ALL_INBOX_MESSAGE_TYPES = [
  'wechat_channels.inbox.auth.status',
  'wechat_channels.inbox.sync.batch',
  'wechat_channels.inbox.sync.ack',
  'wechat_channels.inbox.sync.request',
  'wechat_channels.inbox.reply.send',
  'wechat_channels.inbox.reply.result',
  'wechat_channels.inbox.reply.result.ack',
  'wechat_channels.inbox.reply.reconcile',
  'wechat_channels.inbox.reply.reconcile.result',
  'wechat_channels.inbox.auth.reopen',
  'wechat_channels.inbox.browser.control',
  'wechat_channels.inbox.runtime.controls',
  'wechat_channels.inbox.offboard.command',
  'wechat_channels.inbox.offboard.result',
  'wechat_channels.inbox.offboard.ack',
] as const;

test('全部 15 条收件箱消息名都在验证名单内（删条＝入口静默拒族）', () => {
  for (const type of ALL_INBOX_MESSAGE_TYPES) {
    assert.equal(isInteractionMessageType(type), true, type);
  }
});

test('族外与旧名不进验证名单', () => {
  for (const type of ['interaction.reply.send', 'wechat_channels.inbox.unknown', 'ping']) {
    assert.equal(isInteractionMessageType(type), false, type);
  }
});
