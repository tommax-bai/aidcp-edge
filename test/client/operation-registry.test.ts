import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_OPERATION_REGISTRY,
  CLOUD_OPERATION_REGISTRY,
  automationUiSnapshot,
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

test('operation registry keeps browser acquisition outside automation control and platform API operations', () => {
  assert.deepEqual(CLOUD_OPERATION_REGISTRY['pacing.update'], {
    category: 'automation_control', transport: 'automation_ws', identity: 'bound_account', browser: 'forbidden',
  });
  assert.deepEqual(CLOUD_OPERATION_REGISTRY['interaction.reply.send'], {
    category: 'platform_api_automation', transport: 'automation_ws', identity: 'bound_account', browser: 'forbidden',
  });
  assert.deepEqual(CLOUD_OPERATION_REGISTRY['interaction.auth.reopen'], {
    category: 'browser_lifecycle', transport: 'automation_ws', identity: 'bound_account', browser: 'on_demand',
  });
  assert.deepEqual(CLOUD_OPERATION_REGISTRY['publish.command'], {
    category: 'page_automation', transport: 'automation_ws', identity: 'page_account', browser: 'required',
  });
  assert.deepEqual(CLOUD_OPERATION_REGISTRY['edge.task.acquire'], {
    category: 'page_automation', transport: 'automation_ws', identity: 'page_account', browser: 'required',
  });
});

test('client operations declare transport, identity, and browser requirements explicitly', () => {
  assert.deepEqual(CLIENT_OPERATION_REGISTRY['persona.generate'], {
    category: 'cloud_data', transport: 'customer_auth_http', identity: 'customer_environment', browser: 'forbidden',
  });
  assert.deepEqual(CLIENT_OPERATION_REGISTRY['cloud.transport.rebind'], {
    category: 'automation_control', transport: 'electron_ipc', identity: 'bound_account', browser: 'forbidden',
  });
  assert.deepEqual(CLIENT_OPERATION_REGISTRY['browser.open'], {
    category: 'browser_lifecycle', transport: 'electron_ipc', identity: 'bound_account', browser: 'on_demand',
  });
  assert.deepEqual(CLIENT_OPERATION_REGISTRY['automation.start'], {
    category: 'page_automation', transport: 'electron_ipc', identity: 'page_account', browser: 'required',
  });
});

test('every client-owned data surface is request-scoped HTTP and browser-forbidden', () => {
  for (const type of [
    'client.session',
    'environment.roster',
    'environment.provision',
    'environment.operator_alias',
    'environment.offboard',
    'persona.read',
    'persona.generate',
    'persona.persist',
    'publish.approval.decision',
    'publish.draft.read',
    'publish.draft.image.remove',
    'delegated_task.workspace',
    'curated_content.workspace',
    'slow_start.read_write',
    'environment.risk.read_recover',
    'interaction.workspace',
    'interaction.auth.request',
  ]) {
    assert.deepEqual(clientOperationDescriptorFor(type), {
      category: 'cloud_data',
      transport: 'customer_auth_http',
      identity: 'customer_environment',
      browser: 'forbidden',
    }, type);
  }
});

test('unknown active messages have no implicit fallback classification', () => {
  assert.equal(operationDescriptorFor('future.command' as MessageType), null);
  assert.equal(clientOperationDescriptorFor('future.renderer.action'), null);
});

test('new client strips cloud_data fields from legacy ui.snapshot and keeps only automation projection', () => {
  const dailyUsage = { asOf: 1, totals: {}, quotas: {}, saturated: [], windows: {} } as never;
  const browserStandby = { eligible: true, reason: 'wait', waitMs: 10, wakeAt: 20, generatedAt: 10, source: 'risk', minWaitMs: 1, warmupMs: 1 } as never;
  assert.deepEqual(automationUiSnapshot({
    account: { id: 'acc-1', nickname: '昵称' },
    personaBound: true,
    personaWritingLanguage: 'vi',
    lastPublish: { title: '标题', at: 1 },
    publish: { state: 'pending', code: '#1' },
    publishPreview: {
      recordId: 1, code: '#1', kind: 'generated', title: '标题', content: '正文', topics: [],
      images: [], contentVersion: 1, updatedAt: 1,
    },
    dailyUsage,
    browserStandby,
  }), { dailyUsage, browserStandby });
});
