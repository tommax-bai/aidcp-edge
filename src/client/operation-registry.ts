import type { MessageType, UiSnapshotPayload } from '../comm/protocol.js';

export type OperationClass =
  | 'local'
  | 'cloud_data'
  | 'automation_control'
  | 'platform_api_automation'
  | 'browser_lifecycle'
  | 'page_automation';

export interface OperationDescriptor {
  category: OperationClass;
  transport: 'local' | 'electron_ipc' | 'customer_auth_http' | 'automation_ws';
  identity: 'none' | 'local_environment' | 'customer_environment' | 'bound_account' | 'page_account';
  browser: 'forbidden' | 'on_demand' | 'required';
}

const cloudData = (): OperationDescriptor => ({ category: 'cloud_data', transport: 'customer_auth_http', identity: 'customer_environment', browser: 'forbidden' });
const automationControl = (identity: OperationDescriptor['identity'] = 'bound_account'): OperationDescriptor => ({ category: 'automation_control', transport: 'automation_ws', identity, browser: 'forbidden' });
const platformApiAutomation = (): OperationDescriptor => ({ category: 'platform_api_automation', transport: 'automation_ws', identity: 'bound_account', browser: 'forbidden' });
const browserLifecycle = (): OperationDescriptor => ({ category: 'browser_lifecycle', transport: 'automation_ws', identity: 'bound_account', browser: 'on_demand' });
const pageAutomation = (): OperationDescriptor => ({ category: 'page_automation', transport: 'automation_ws', identity: 'page_account', browser: 'required' });

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
  'ui.snapshot': automationControl(),
  'pacing.update': automationControl(),
  'interaction.sync.ack': automationControl(),
  'interaction.reply.result.ack': automationControl(),
  'interaction.offboard.ack': automationControl(),
  'interaction.runtime.controls': automationControl(),
  ping: automationControl('none'),
  pong: automationControl('none'),

  'interaction.sync.request': platformApiAutomation(),
  'interaction.reply.send': platformApiAutomation(),
  'interaction.reply.reconcile': platformApiAutomation(),
  'interaction.offboard.command': platformApiAutomation(),

  'interaction.auth.reopen': browserLifecycle(),
  'interaction.browser.control': browserLifecycle(),

  'plan.response': pageAutomation(),
  'session.end': pageAutomation(),
  'browse.next': pageAutomation(),
  'browse.scroll': pageAutomation(),
  'note.open': pageAutomation(),
  'note.close': pageAutomation(),
  'search.execute': pageAutomation(),
  'page.scroll': pageAutomation(),
  'feed.refresh': pageAutomation(),
  'interaction.like': pageAutomation(),
  'interaction.collect': pageAutomation(),
  'interaction.follow': pageAutomation(),
  'interaction.comment': pageAutomation(),
  'interaction.like_comment': pageAutomation(),
  'group.join': pageAutomation(),
  'navigation.back': pageAutomation(),
  'note.browse_images': pageAutomation(),
  'note.scroll_comments': pageAutomation(),
  'profile.open': pageAutomation(),
  'notification.open': pageAutomation(),
  'notification.browse_comments': pageAutomation(),
  'notification.browse_likes': pageAutomation(),
  'notification.browse_follows': pageAutomation(),
  'notification.back_home': pageAutomation(),
  'publish.request': pageAutomation(),
  'publish.command': pageAutomation(),
  'edge.task.acquire': pageAutomation(),
  'edge.task.release': pageAutomation(),
  'captcha.assist.capture': pageAutomation(),
  'captcha.assist.click': pageAutomation(),
} as const satisfies Partial<Record<MessageType, OperationDescriptor>>;

export type RegisteredCloudOperation = keyof typeof CLOUD_OPERATION_REGISTRY;
export type RegisteredClientOperation = keyof typeof CLIENT_OPERATION_REGISTRY;

export function clientOperationDescriptorFor(type: string): OperationDescriptor | null {
  return (CLIENT_OPERATION_REGISTRY as Record<string, OperationDescriptor>)[type] ?? null;
}

export function operationDescriptorFor(type: MessageType): OperationDescriptor | null {
  return (CLOUD_OPERATION_REGISTRY as Partial<Record<MessageType, OperationDescriptor>>)[type] ?? null;
}

/** Legacy Clouds may still mix client-owned data into ui.snapshot. New clients consume only the
 * automation projection and refetch persona/publish/account data over customer-auth HTTP. */
export function automationUiSnapshot(payload: UiSnapshotPayload): UiSnapshotPayload {
  const safe: UiSnapshotPayload = {};
  if (payload.browserStandby) safe.browserStandby = payload.browserStandby;
  return safe;
}
