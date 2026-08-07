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
 * 而漏抄一条时它恰好什么都不说。2026-08-05 实测：`identity.read_current_page` 同时缺席于
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

  // 改类根治（recategorize-nonpage-commands）后，经主动白名单路由的不止 page_automation：
  // 观察与环境处置同样由 EdgeClient 主动命令路由分派，漏路由同样是静默丢弃。
  const ROUTED_CATEGORIES = new Set(['page_automation', 'page_observation', 'environment_assist']);
  const pageCommands = (Object.entries(CLOUD_OPERATION_REGISTRY) as [MessageType, { category: string }][])
    .filter(([, descriptor]) => ROUTED_CATEGORIES.has(descriptor.category))
    .map(([type]) => type);

  // 防空转：登记表解析不出东西时，上面的循环会「零条全过」，与真的全覆盖同形。
  assert.ok(
    pageCommands.length >= 25,
    `路由类命令只解析出 ${pageCommands.length} 条，登记表结构大概率已变——本断言 MUST 响亮失败，绝不退化成空集恒真`,
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
  assert.deepEqual(CLOUD_OPERATION_REGISTRY['wechat_channels.inbox.reply.send'], {
    category: 'platform_api_automation', transport: 'automation_ws', identity: 'bound_account', browser: 'forbidden',
    platformFootprint: 'account_visible',
  });
  assert.deepEqual(CLOUD_OPERATION_REGISTRY['wechat_channels.inbox.auth.reopen'], {
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
 * 身份闸被拦集合的结构断言（change recategorize-nonpage-commands，取代救援清单成员资格闸）：
 *
 * 救援清单已随判例四根治退役——类别按「在编址什么」重归后，判据收敛为一句话：
 * **身份未落定时，拒绝一切 identity === 'page_account' 的命令，零例外清单。**
 *
 * 本断言按引用从登记表推导被拦集合（零手抄），并锁两条硬性质：
 *   ① 全部会留痕的命令（platformFootprint === 'account_visible'）MUST 在被拦集合内——
 *      身份未落定时绝不允许任何可能在平台留痕的动作；
 *   ② `edge.task.acquire` MUST 在被拦集合内——它不留痕，但认领租约＝即将以该账号名义
 *      动作的准入（「留痕维 MUST NOT 单独决定放行」的常驻反例，机械化在此）。
 * 变异校准：把 acquire 或任一留痕命令的 identity 改为非 page_account ⇒ 本断言当场红并点名。
 */
test('identity gate blocked set is derived from the registry and covers every footprinted command plus acquire', () => {
  const blocked = (Object.entries(CLOUD_OPERATION_REGISTRY) as [MessageType, { identity: string; platformFootprint: string }][])
    .filter(([, d]) => d.identity === 'page_account')
    .map(([type]) => type);
  const blockedSet = new Set<string>(blocked);

  const footprintedOutsideGate = (Object.entries(CLOUD_OPERATION_REGISTRY) as [MessageType, { platformFootprint: string }][])
    .filter(([type, d]) => d.platformFootprint === 'account_visible' && !blockedSet.has(type))
    .map(([type]) => type)
    .sort();
  // 棘轮：留痕却不受页面身份闸约束的，恰好只许是这一条**已登记的已知缺口**——
  // wechat_channels.inbox.reply.send 走视频号 API、identity 是 bound_account（令牌鉴权，与页面登录态无关），
  // 页面身份未落定不构成其身份失效。该缺口登记于 close-account-layer-operation-manual tasks 9.1，
  // 是否给 API 写路径设独立身份闸属产品裁决。新增任何「留痕且不被拦」的命令 ⇒ 本断言当场红。
  assert.deepEqual(
    footprintedOutsideGate,
    ['wechat_channels.inbox.reply.send'],
    `留痕且不受身份闸约束的集合变了（只许恰好等于已登记的唯一例外）：${footprintedOutsideGate.join(', ')}`,
  );

  assert.ok(
    blockedSet.has('edge.task.acquire'),
    'edge.task.acquire 必须在被拦集合内：不留痕但属账号动作准入（身份都不知道是谁，谈不上以谁的名义认领）',
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

test('new client strips cloud_data fields from legacy ui.push_snapshot and keeps only automation projection', () => {
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
