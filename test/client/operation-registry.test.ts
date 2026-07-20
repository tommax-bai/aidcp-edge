import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_OPERATION_REGISTRY,
  CLOUD_OPERATION_REGISTRY,
  clientOperationDescriptorFor,
  operationDescriptorFor,
} from '../../src/client/operation-registry.js';
import type { MessageType } from '../../src/comm/protocol.js';

const routedActiveCommands = [
  'ui.snapshot',
  'pacing.update',
  'interaction.sync.ack',
  'interaction.sync.request',
  'interaction.reply.send',
  'interaction.auth.reopen',
  'interaction.browser.control',
  'interaction.runtime.controls',
  'interaction.reply.result.ack',
  'interaction.reply.reconcile',
  'interaction.offboard.command',
  'interaction.offboard.ack',
  'plan.response',
  'session.end',
  'browse.next',
  'browse.scroll',
  'note.open',
  'note.close',
  'search.execute',
  'page.scroll',
  'feed.refresh',
  'interaction.like',
  'interaction.collect',
  'interaction.follow',
  'interaction.comment',
  'interaction.like_comment',
  'group.join',
  'navigation.back',
  'note.browse_images',
  'note.scroll_comments',
  'profile.open',
  'notification.open',
  'notification.browse_comments',
  'notification.browse_likes',
  'notification.browse_follows',
  'notification.back_home',
  'publish.request',
  'publish.command',
  'edge.task.acquire',
  'edge.task.release',
  'captcha.assist.capture',
  'captcha.assist.click',
] as const satisfies readonly MessageType[];

test('operation registry covers every Cloud active command routed by EdgeClient', () => {
  for (const type of routedActiveCommands) {
    assert.ok(operationDescriptorFor(type), `${type} must have an explicit operation classification`);
  }
});

test('operation registry keeps browser acquisition outside core and platform API operations', () => {
  assert.deepEqual(CLOUD_OPERATION_REGISTRY['pacing.update'], {
    category: 'cloud', transport: 'cloud_ws', identity: 'bound_account', browser: 'forbidden',
  });
  assert.deepEqual(CLOUD_OPERATION_REGISTRY['interaction.reply.send'], {
    category: 'platform_api', transport: 'cloud_ws', identity: 'bound_account', browser: 'forbidden',
  });
  assert.deepEqual(CLOUD_OPERATION_REGISTRY['interaction.auth.reopen'], {
    category: 'browser_lifecycle', transport: 'cloud_ws', identity: 'bound_account', browser: 'on_demand',
  });
  assert.deepEqual(CLOUD_OPERATION_REGISTRY['publish.command'], {
    category: 'page_automation', transport: 'cloud_ws', identity: 'page_account', browser: 'required',
  });
  assert.deepEqual(CLOUD_OPERATION_REGISTRY['edge.task.acquire'], {
    category: 'page_automation', transport: 'cloud_ws', identity: 'page_account', browser: 'required',
  });
});

test('client operations declare transport, identity, and browser requirements explicitly', () => {
  assert.deepEqual(CLIENT_OPERATION_REGISTRY['persona.generate'], {
    category: 'cloud', transport: 'customer_auth_http', identity: 'customer_environment', browser: 'forbidden',
  });
  assert.deepEqual(CLIENT_OPERATION_REGISTRY['cloud.transport.rebind'], {
    category: 'cloud', transport: 'electron_ipc', identity: 'bound_account', browser: 'forbidden',
  });
  assert.deepEqual(CLIENT_OPERATION_REGISTRY['browser.open'], {
    category: 'browser_lifecycle', transport: 'electron_ipc', identity: 'bound_account', browser: 'on_demand',
  });
  assert.deepEqual(CLIENT_OPERATION_REGISTRY['automation.start'], {
    category: 'page_automation', transport: 'electron_ipc', identity: 'page_account', browser: 'required',
  });
});

test('unknown active messages have no implicit fallback classification', () => {
  assert.equal(operationDescriptorFor('future.command' as MessageType), null);
  assert.equal(clientOperationDescriptorFor('future.renderer.action'), null);
});
