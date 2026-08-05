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
  'identity.read_current',
  'identity.read_self_profile',
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

/**
 * 反向结构断言：登记表说「这条可下发」，EdgeClient 入口就必须真能路由到它。
 *
 * 上面那张 `routedActiveCommands` 是**手抄的**——它只证明「我抄进来的这些登记表里有」，
 * 而漏抄一条时它恰好什么都不说。2026-08-05 实测：`identity.read_current` 同时缺席于
 * 云端登记表、EdgeClient 白名单、以及这张手抄清单，三处一起漏、全部闸门绿。
 *
 * 所以这条改成**读真源码**：以登记表为事实源，逐条去 edge-client.ts 里找它的分派点。
 * 漏放行的后果是命令落到「其他主动消息暂忽略」被静默丢弃——云端 sent=1、边缘无动作无回执，
 * 与「边缘没装到」「页面读不出来」三者同形（根 CLAUDE.md §2 第 4 处同步点）。
 *
 * 判据是「出现在某个 env.type === '<x>' 比较里」，不限定必须落在哪一段：
 * publish / edge.task / captcha.assist / plan.response 各有自己的独立分支，
 * 强行要求它们进同一张白名单会把这条断言变成一张需要维护的例外清单，
 * 而例外清单正是下一个 bug 的藏身处。
 */
test('every dispatchable page command is actually routed by EdgeClient (no silent drop)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../src/client/edge-client.ts', import.meta.url), 'utf8');

  const pageCommands = (Object.entries(CLOUD_OPERATION_REGISTRY) as [MessageType, { category: string }][])
    .filter(([, descriptor]) => descriptor.category === 'page_automation')
    .map(([type]) => type);

  // 防空转：登记表解析不出东西时，上面的循环会「零条全过」，与真的全覆盖同形。
  assert.ok(
    pageCommands.length >= 25,
    `page_automation 只解析出 ${pageCommands.length} 条，登记表结构大概率已变——本断言 MUST 响亮失败，绝不退化成空集恒真`,
  );

  const unrouted = pageCommands.filter((type) => !source.includes(`env.type === '${type}'`));
  assert.deepEqual(
    unrouted,
    [],
    `这些命令已登记为可下发，但 EdgeClient 入口没有任何分派点会接住它们 —— 云端会 sent=1 而边缘静默丢弃：${unrouted.join(', ')}`,
  );
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
  assert.deepEqual(CLIENT_OPERATION_REGISTRY['environment.delete.adspower'], {
    category: 'local', transport: 'local', identity: 'local_environment', browser: 'forbidden',
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
  }), { browserStandby });
});
