import type { MessageType } from '../comm/protocol.js';

export type OperationClass = 'local' | 'cloud' | 'platform_api' | 'browser_lifecycle' | 'page_automation';

export interface OperationDescriptor {
  category: OperationClass;
  transport: 'local' | 'electron_ipc' | 'customer_auth_http' | 'cloud_ws';
  identity: 'none' | 'local_environment' | 'customer_environment' | 'bound_account' | 'page_account';
  browser: 'forbidden' | 'on_demand' | 'required';
}

const cloud = (): OperationDescriptor => ({ category: 'cloud', transport: 'cloud_ws', identity: 'bound_account', browser: 'forbidden' });
const platformApi = (): OperationDescriptor => ({ category: 'platform_api', transport: 'cloud_ws', identity: 'bound_account', browser: 'forbidden' });
const browserLifecycle = (): OperationDescriptor => ({ category: 'browser_lifecycle', transport: 'cloud_ws', identity: 'bound_account', browser: 'on_demand' });
const pageAutomation = (): OperationDescriptor => ({ category: 'page_automation', transport: 'cloud_ws', identity: 'page_account', browser: 'required' });

/** Electron/renderer operations share the same classification vocabulary and never infer browser needs from child state. */
export const CLIENT_OPERATION_REGISTRY = {
  'settings.read': { category: 'local', transport: 'electron_ipc', identity: 'local_environment', browser: 'forbidden' },
  'settings.save': { category: 'local', transport: 'electron_ipc', identity: 'local_environment', browser: 'forbidden' },
  'environment.nickname.save': { category: 'local', transport: 'electron_ipc', identity: 'local_environment', browser: 'forbidden' },
  'notification.surface': { category: 'local', transport: 'local', identity: 'local_environment', browser: 'forbidden' },
  'persona.read': { category: 'cloud', transport: 'customer_auth_http', identity: 'customer_environment', browser: 'forbidden' },
  'persona.generate': { category: 'cloud', transport: 'customer_auth_http', identity: 'customer_environment', browser: 'forbidden' },
  'persona.persist': { category: 'cloud', transport: 'customer_auth_http', identity: 'customer_environment', browser: 'forbidden' },
  'publish.approval.decision': { category: 'cloud', transport: 'customer_auth_http', identity: 'customer_environment', browser: 'forbidden' },
  'publish.draft.image.remove': { category: 'cloud', transport: 'customer_auth_http', identity: 'customer_environment', browser: 'forbidden' },
  'interaction.workspace': { category: 'cloud', transport: 'customer_auth_http', identity: 'customer_environment', browser: 'forbidden' },
  'cloud.transport.rebind': { category: 'cloud', transport: 'electron_ipc', identity: 'bound_account', browser: 'forbidden' },
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
  'ui.snapshot': cloud(),
  'pacing.update': cloud(),
  'interaction.sync.ack': cloud(),
  'interaction.reply.result.ack': cloud(),
  'interaction.offboard.ack': cloud(),
  'interaction.runtime.controls': cloud(),
  ping: { category: 'cloud', transport: 'cloud_ws', identity: 'none', browser: 'forbidden' },
  pong: { category: 'cloud', transport: 'cloud_ws', identity: 'none', browser: 'forbidden' },

  'interaction.sync.request': platformApi(),
  'interaction.reply.send': platformApi(),
  'interaction.reply.reconcile': platformApi(),
  'interaction.offboard.command': platformApi(),

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
