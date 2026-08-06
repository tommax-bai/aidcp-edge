import type { MessageType, UiSnapshotPayload } from '../comm/protocol.js';

export type OperationClass =
  | 'local'
  | 'cloud_data'
  | 'automation_control'
  | 'platform_api_automation'
  | 'browser_lifecycle'
  | 'page_automation'
  /**
   * 类别按「在编址什么」裁决，不按「怎么执行」（edge-command-grammar 规则一；判例四的根治，
   * change recategorize-nonpage-commands）。这两类都需要浏览器，但**不以页面账号名义动作**：
   *  - page_observation：翻译层观察——读页面得出「登着谁 / 在哪」，不产生账号动作。
   *  - environment_assist：环境层处置——验证码协助这类解阻断操作。
   * 不为「将来可能有」预留类别（防笛卡尔积）。
   */
  | 'page_observation'
  | 'environment_assist';

export interface OperationDescriptor {
  category: OperationClass;
  transport: 'local' | 'electron_ipc' | 'customer_auth_http' | 'automation_ws';
  identity: 'none' | 'local_environment' | 'customer_environment' | 'bound_account' | 'page_account';
  browser: 'forbidden' | 'on_demand' | 'required';
}

/**
 * 平台留痕维（platform footprint）——「判错了会不会在平台上留痕」这条尺子的机读形态。
 *
 * 判据：这条命令**执行成功后**，平台上是否**直接**出现一个可归因到该账号的新对象
 * （帖子 / 评论 / 点赞 / 关注关系 / 群成员资格 / 私信…）。三条边界裁定：
 *   - **按消息类型取最坏一档**：`publish.command` 一个类型下有填标题 / 选图 / 点提交多种原子，
 *     只有最后一个真留痕，但本表按消息类型编址 ⇒ 整条判 `account_visible`。
 *     错在保守侧只是少一次自动重试；错在激进侧就是重复对外写入（本仓代价最高的错误）。
 *   - **只算直接后果，不算间接触发**：`edge.task.acquire` 会让后续留痕动作成为可能，但它自己
 *     不产生任何对象 ⇒ `none`。算间接则一切操作最终都留痕，本维退化成恒真、失去全部区分力。
 *   - **本维 MUST NOT 单独决定放行**。反例常驻：`edge.task.acquire` 是 `none`，但身份未落定时
 *     照拦——认领租约＝马上要以该账号名义动作，拦它的理由是**准入**，不是留痕。
 *
 * 当前消费方只有测试断言（身份救援清单成员资格 ⊆ 声明为 `none` 的命令）；将来消费方是
 * 云端重放决策（可重放 / 绝不重放）。**不参与任何运行时放行 / 拒绝判断。**
 */
export type PlatformFootprint = 'account_visible' | 'none';

/**
 * Cloud→Edge 描述符 = 基础四维 + 平台留痕维。
 *
 * 为什么 `platformFootprint` 只加在 Cloud→Edge 这份、`CLIENT_OPERATION_REGISTRY` 那 29 条不加：
 * 客户端本地 / IPC 操作不经过身份闸、不参与重放决策——本维的两个消费方一个都不沾。
 * 没有消费方的标注必然漂移，而漂移的标注比没有标注更坏（它看起来像事实源）。
 */
export interface CloudOperationDescriptor extends OperationDescriptor {
  platformFootprint: PlatformFootprint;
}

const cloudData = (): OperationDescriptor => ({ category: 'cloud_data', transport: 'customer_auth_http', identity: 'customer_environment', browser: 'forbidden' });
// 以下四个构造器只服务 Cloud→Edge 登记表。platformFootprint 默认一律落在 'account_visible'
// （保守侧）：留痕为默认、不留痕需显式声明——漏判的新命令因此天然进「绝不重放」一侧。
const automationControl = (
  identity: OperationDescriptor['identity'] = 'bound_account',
  platformFootprint: PlatformFootprint = 'account_visible',
): CloudOperationDescriptor => ({ category: 'automation_control', transport: 'automation_ws', identity, browser: 'forbidden', platformFootprint });
const platformApiAutomation = (
  platformFootprint: PlatformFootprint = 'account_visible',
): CloudOperationDescriptor => ({ category: 'platform_api_automation', transport: 'automation_ws', identity: 'bound_account', browser: 'forbidden', platformFootprint });
const browserLifecycle = (
  platformFootprint: PlatformFootprint = 'account_visible',
): CloudOperationDescriptor => ({ category: 'browser_lifecycle', transport: 'automation_ws', identity: 'bound_account', browser: 'on_demand', platformFootprint });
const pageAutomation = (
  platformFootprint: PlatformFootprint = 'account_visible',
): CloudOperationDescriptor => ({ category: 'page_automation', transport: 'automation_ws', identity: 'page_account', browser: 'required', platformFootprint });
// 观察与处置：需要浏览器（browser: required 与页面动作同档），但 identity 是 local_environment——
// 它们不代表账号做任何事，身份未落定时也 MUST 可用（正是解开该终局的探针 / 通道）。
const pageObservation = (): CloudOperationDescriptor => ({ category: 'page_observation', transport: 'automation_ws', identity: 'local_environment', browser: 'required', platformFootprint: 'none' });
const environmentAssist = (): CloudOperationDescriptor => ({ category: 'environment_assist', transport: 'automation_ws', identity: 'local_environment', browser: 'required', platformFootprint: 'none' });

/** Electron/renderer operations share the same classification vocabulary and never infer browser needs from child state. */
export const CLIENT_OPERATION_REGISTRY = {
  'settings.read': { category: 'local', transport: 'electron_ipc', identity: 'local_environment', browser: 'forbidden' },
  'settings.save': { category: 'local', transport: 'electron_ipc', identity: 'local_environment', browser: 'forbidden' },
  'environment.nickname.save': { category: 'local', transport: 'electron_ipc', identity: 'local_environment', browser: 'forbidden' },
  'notification.surface': { category: 'local', transport: 'local', identity: 'local_environment', browser: 'forbidden' },
  'client.session': cloudData(),
  'environment.roster': cloudData(),
  'environment.provision': cloudData(),
  'environment.operator_alias': cloudData(),
  'environment.offboard': cloudData(),
  'environment.delete.adspower': { category: 'local', transport: 'local', identity: 'local_environment', browser: 'forbidden' },
  'persona.read': cloudData(),
  'persona.generate': cloudData(),
  'persona.persist': cloudData(),
  'publish.approval.decision': cloudData(),
  'publish.draft.read': cloudData(),
  'publish.draft.image.remove': cloudData(),
  'delegated_task.workspace': cloudData(),
  'curated_content.workspace': cloudData(),
  'slow_start.read_write': cloudData(),
  'environment.risk.read_recover': cloudData(),
  'interaction.workspace': cloudData(),
  'interaction.auth.request': cloudData(),
  'automation.transport.rebind': { category: 'automation_control', transport: 'electron_ipc', identity: 'bound_account', browser: 'forbidden' },
  // Wire-name compatibility for the shipped renderer; semantically this is the automation transport.
  'cloud.transport.rebind': { category: 'automation_control', transport: 'electron_ipc', identity: 'bound_account', browser: 'forbidden' },
  'browser.open': { category: 'browser_lifecycle', transport: 'electron_ipc', identity: 'bound_account', browser: 'on_demand' },
  'browser.close': { category: 'browser_lifecycle', transport: 'electron_ipc', identity: 'local_environment', browser: 'on_demand' },
  'automation.start': { category: 'page_automation', transport: 'electron_ipc', identity: 'page_account', browser: 'required' },
  'automation.pause': { category: 'page_automation', transport: 'electron_ipc', identity: 'local_environment', browser: 'on_demand' },
} as const satisfies Record<string, OperationDescriptor>;

/**
 * Cloud → Edge active-operation registry.
 * Correlated request responses are resolved before this table. Missing active operations fail closed.
 */
export const CLOUD_OPERATION_REGISTRY = {
  // —— 控制与心跳：只动本地投影 / 节奏 / outbox 确认，不触任何平台对象 ——
  'ui.snapshot': automationControl('bound_account', 'none'),
  'pacing.update': automationControl('bound_account', 'none'),
  'interaction.sync.ack': automationControl('bound_account', 'none'),
  'interaction.reply.result.ack': automationControl('bound_account', 'none'),
  'interaction.offboard.ack': automationControl('bound_account', 'none'),
  'interaction.runtime.controls': automationControl('bound_account', 'none'),
  ping: automationControl('none', 'none'),
  pong: automationControl('none', 'none'),

  // 拉取同步：全部端点为 observed_read_only（request-descriptors.ts），纯读不写平台。
  'interaction.sync.request': platformApiAutomation('none'),
  // 真发出私信——唯一的 API 直写留痕命令（且不经页面身份闸，缺口已在 change 里登记待议）。
  'interaction.reply.send': platformApiAutomation(),
  // 协议注释：只核验既有 attempt，绝不发起新平台写。
  'interaction.reply.reconcile': platformApiAutomation('none'),
  // 撤权后清理本地加密会话；协议注释：结果可重放。
  'interaction.offboard.command': platformApiAutomation('none'),

  'interaction.auth.reopen': browserLifecycle('none'),
  'interaction.browser.control': browserLifecycle('none'),

  // v1 兼容路径：PlanStep 的 op 含 click / input，可承载点赞 / 评论等写手势 ⇒ 按最坏一档。
  'plan.response': pageAutomation(),
  // 编排收尾：拆会话不是页面动作；身份未落定时也必须能收尾（否则终局无法解开）。
  'session.end': automationControl('local_environment', 'none'),
  'note.open': pageAutomation('none'),
  'note.close': pageAutomation('none'),
  // 搜索只产生账号自见的隐式行为记录，不产生平台上可归因的新对象。
  'search.execute': pageAutomation('none'),
  'page.scroll': pageAutomation('none'),
  'feed.refresh': pageAutomation('none'),
  // —— 互动写：每条直接产生可归因到该账号的新对象 ——
  'interaction.like': pageAutomation(),
  'interaction.collect': pageAutomation(),
  'interaction.follow': pageAutomation(),
  'interaction.comment': pageAutomation(),
  'interaction.like_comment': pageAutomation(),
  'group.join': pageAutomation(),
  'navigation.back': pageAutomation('none'),
  'note.browse_images': pageAutomation('none'),
  'note.scroll_comments': pageAutomation('none'),
  'profile.open': pageAutomation('none'),
  'identity.read_current': pageObservation(),
  'identity.read_self_profile': pageObservation(),
  // 观察命令「问现状」（change add-state-observation-command）：纯读探针，一次带回当前面 + 登录身份。
  'state.read': pageObservation(),
  'notification.open': pageAutomation('none'),
  'notification.browse_comments': pageAutomation('none'),
  'notification.browse_likes': pageAutomation('none'),
  'notification.browse_follows': pageAutomation('none'),
  'notification.back_home': pageAutomation('none'),
  // 按最坏一档：多种原子里只有「点提交」真留痕，但本表按消息类型编址。
  'publish.command': pageAutomation(),
  // 租约属准入不属留痕：acquire 不产生对象，但 identity 保持 page_account——认领＝即将以该账号
  // 名义动作的准入，身份未落定时 MUST 仍被身份闸拦（留痕 none 与身份 page_account 并存，各答各的问题）。
  'edge.task.acquire': pageAutomation('none'),
  // 释放租约永远安全：不代表账号动作，身份未落定时放行（旧救援清单第一条的机械化）。
  'edge.task.release': automationControl('local_environment', 'none'),
  'captcha.assist.capture': environmentAssist(),
  // 人工点位只作用于验证码浮层，解开阻断不产生该账号名下的新对象。
  'captcha.assist.click': environmentAssist(),
} as const satisfies Partial<Record<MessageType, CloudOperationDescriptor>>;

export type RegisteredCloudOperation = keyof typeof CLOUD_OPERATION_REGISTRY;
export type RegisteredClientOperation = keyof typeof CLIENT_OPERATION_REGISTRY;

export function clientOperationDescriptorFor(type: string): OperationDescriptor | null {
  return (CLIENT_OPERATION_REGISTRY as Record<string, OperationDescriptor>)[type] ?? null;
}

export function operationDescriptorFor(type: MessageType): CloudOperationDescriptor | null {
  return (CLOUD_OPERATION_REGISTRY as Partial<Record<MessageType, CloudOperationDescriptor>>)[type] ?? null;
}

/** Legacy Clouds may still mix client-owned data into ui.snapshot. New clients consume only the
 * automation projection and refetch persona/publish/account data over customer-auth HTTP. */
export function automationUiSnapshot(payload: UiSnapshotPayload): UiSnapshotPayload {
  const safe: UiSnapshotPayload = {};
  if (payload.browserStandby) safe.browserStandby = payload.browserStandby;
  return safe;
}
