import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_OPERATION_REGISTRY,
  CLOUD_OPERATION_REGISTRY,
  automationUiSnapshot,
  clientOperationDescriptorFor,
  operationDescriptorFor,
} from '../../src/client/operation-registry.js';
import { IDENTITY_RESCUE_OPERATIONS } from '../../src/client/identity-command-gate.js';
import type { MessageType } from '../../src/comm/protocol.js';

/**
 * 这里曾有一张 46 条的手抄清单 `routedActiveCommands` 及断言「清单里每条都在登记表里」。
 * 2026-08-06（change close-account-layer-operation-manual）经两次变异验证坐实其两个方向
 * 均已被覆盖后删除：
 *
 *   - 方向一「登记表有、源码漏路由」：由下面的反向结构断言守着（以登记表为事实源、逐条去
 *     edge-client.ts 找分派点）。变异坐实：摘掉 `env.type === 'profile.open'` 那条路由分支，
 *     它当场红并点名 profile.open。
 *   - 方向二「源码路由了一条未登记命令」：结构上不可能——入口 fail-closed 闸
 *     （edge-client.ts 的 operation_unclassified 判定）位于全部路由分支之前。变异坐实：
 *     把 `note.open` 从登记表摘掉后向 onMessage 投递 note.open（它在源码里仍有路由分支），
 *     被入口闸拒为 operation_unclassified、browseHandler 一次都没被调用；
 *     「unclassified active message fails closed before any handler」用例常驻守着同一入口。
 *
 * 手抄清单唯一多守的场景是「登记表里被删了一条、源码还路由着」——那个场景在运行时是
 * **响亮的 fail-closed 拒绝**（有诊断、有日志），不是静默错执行；且跨仓对表闸
 * （scripts/operation-registry-parity）会在两仓键集合上抓住单侧删除。为它保留一份
 * 46 条、无人守的手抄副本，正是本 change 要消除的形态。
 */

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

  // page_observation（change add-state-observation-command）与 page_automation 同走 browseHandler
  // 主动命令路由：观察命令漏放行同样是「云端 sent=1、边缘静默丢弃、按信封 id 等应答只等到超时」。
  const pageCommands = (Object.entries(CLOUD_OPERATION_REGISTRY) as [MessageType, { category: string }][])
    .filter(([, descriptor]) => descriptor.category === 'page_automation' || descriptor.category === 'page_observation')
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
    platformFootprint: 'none',
  });
  assert.deepEqual(CLOUD_OPERATION_REGISTRY['interaction.reply.send'], {
    category: 'platform_api_automation', transport: 'automation_ws', identity: 'bound_account', browser: 'forbidden',
    platformFootprint: 'account_visible',
  });
  assert.deepEqual(CLOUD_OPERATION_REGISTRY['interaction.auth.reopen'], {
    category: 'browser_lifecycle', transport: 'automation_ws', identity: 'bound_account', browser: 'on_demand',
    platformFootprint: 'none',
  });
  assert.deepEqual(CLOUD_OPERATION_REGISTRY['publish.command'], {
    category: 'page_automation', transport: 'automation_ws', identity: 'page_account', browser: 'required',
    platformFootprint: 'account_visible',
  });
  assert.deepEqual(CLOUD_OPERATION_REGISTRY['edge.task.acquire'], {
    category: 'page_automation', transport: 'automation_ws', identity: 'page_account', browser: 'required',
    platformFootprint: 'none',
  });
});

/**
 * 身份救援清单的成员资格闸（change close-account-layer-operation-manual）：
 *
 *   救援清单 ⊆ { 登记表里 platformFootprint === 'none' 的命令 }
 *
 * 这是这张清单**唯一的危险方向**——少放行一条只是更难救，多放行一条会在未知身份下
 * 真发内容、记错账。误把一条会留痕的命令加进救援清单，本断言当场红并点名它。
 *
 * ⚠️ MUST NOT 把它「补全」成双向断言（「所有 'none' 命令都该在救援清单里」）。反例现成：
 * `edge.task.acquire` 是 'none'，但身份未落定时照拦——认领租约＝马上要以该账号名义动作，
 * 拦它的理由是**准入**，不是留痕。「不留痕」不蕴含「该放行」；清单的另一半判据
 * （拦掉它会让节点更难救）是闸相对特定终局的策略，推导不出来，只能人判。
 */
test('identity rescue allowlist members must all be declared platformFootprint none in the registry', () => {
  const violations = [...IDENTITY_RESCUE_OPERATIONS].filter((type) => {
    const descriptor = operationDescriptorFor(type as MessageType);
    return !descriptor || descriptor.platformFootprint !== 'none';
  });
  assert.deepEqual(
    violations,
    [],
    `救援清单里这些命令未在登记表声明为不留痕（platformFootprint 'none'）——身份未落定时放行它们`
      + `会在未知身份下于平台留下真实痕迹：${violations.join(', ')}`,
  );
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
