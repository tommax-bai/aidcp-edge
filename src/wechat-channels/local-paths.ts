import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface WechatLocalScope {
  envKey: string;
  browserProfileId: string;
}

export interface WechatRuntimeScope extends WechatLocalScope {
  accountId: string;
}

export function resolveWechatStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AIDCP_WECHAT_STATE_DIR?.trim();
  return explicit ? resolve(explicit) : join(homedir(), '.aidcp-edge', 'wechat-channels');
}

export function scopeNamespace(scope: WechatLocalScope): string {
  return createHash('sha256')
    .update(`wechat_channels|${scope.envKey}|${scope.browserProfileId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export function sessionPath(root: string, scope: WechatLocalScope): string {
  return join(root, scopeNamespace(scope), 'session.enc.json');
}

export function runtimeStatePath(root: string, scope: WechatRuntimeScope): string {
  const accountNamespace = createHash('sha256')
    .update(`wechat_channels|${scope.envKey}|${scope.accountId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return join(root, scopeNamespace(scope), 'accounts', accountNamespace, 'runtime-state.json');
}

export function masterKeyPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AIDCP_WECHAT_MASTER_KEY_PATH?.trim();
  return explicit ? resolve(explicit) : join(root, 'master.key');
}
