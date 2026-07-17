import {
  isUrlAllowedByTargetDescriptor,
  type InteractionPlatformDriver,
  type PlatformTargetDescriptor,
} from '../platform/driver.js';

export const WECHAT_CHANNELS_DEFAULT_START_URL = 'https://channels.weixin.qq.com/platform/post/list';

export const WECHAT_CHANNELS_TARGET: PlatformTargetDescriptor = {
  startUrl: WECHAT_CHANNELS_DEFAULT_START_URL,
  attachUrlIncludes: 'channels.weixin.qq.com',
  allowedHostSuffixes: ['channels.weixin.qq.com'],
};

/**
 * Registry descriptor only. The API-only runtime and its InteractionConnector are
 * assembled separately, so existing XHS/Facebook drivers do not inherit unrelated
 * inbox methods and WeChat Channels does not pretend to support browser browsing.
 */
export const wechatChannelsPlatformDriver: InteractionPlatformDriver = {
  platform: 'wechat_channels',
  runtimeKind: 'interaction',
  app: 'wechat_channels',
  capabilities: [
    'identity',
    'overlay',
    'auth.browser_sidecar',
    'interaction.comment.read',
    'interaction.comment.reply',
    'interaction.dm.read',
    'interaction.dm.send_text',
  ],
  edgeCapabilities: [
    'identity',
    'overlay',
    'auth.browser_sidecar',
    'interaction_inbox_v1',
    'interaction_reply_recovery_v1',
    'interaction_offboarding_v1',
    'interaction_runtime_controls_v1',
    'interaction_browser_control_v1',
    'interaction_test_data_reset_v1',
    'interaction.comment.read',
    'interaction.comment.reply',
    'interaction.dm.read',
    'interaction.dm.send_text',
  ],
  target: WECHAT_CHANNELS_TARGET,
  defaultStartUrl: WECHAT_CHANNELS_TARGET.startUrl,
  attachUrlIncludes: WECHAT_CHANNELS_TARGET.attachUrlIncludes,
  isAllowedTargetUrl: (url) => isUrlAllowedByTargetDescriptor(url, WECHAT_CHANNELS_TARGET),
};
