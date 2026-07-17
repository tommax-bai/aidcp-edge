import type { AuthSnapshot, WechatAuthCoordinator } from './auth-session.js';

export interface WechatIdentityUiEvent {
  kind: 'identity';
  type: 'identity';
  account: {
    id: string;
    name: string;
  };
}

/**
 * Only a current, verified WeChat Channels session may identify an account to the desktop shell.
 * Loading an encrypted record is not sufficient: identityMatches becomes true only after the
 * current session has passed identity verification and enabled-read probes.
 */
export function wechatIdentityUiEvent(snapshot: AuthSnapshot): WechatIdentityUiEvent | null {
  if (!snapshot.identityMatches || !snapshot.identity) return null;
  const id = snapshot.identity.externalId.trim();
  const name = snapshot.identity.displayName.trim();
  if (!id || !name) return null;
  return { kind: 'identity', type: 'identity', account: { id, name } };
}

/** Bridge verified local auth identity to Electron's existing stdout UI-event channel. */
export function wireWechatIdentityUiEvents(
  auth: Pick<WechatAuthCoordinator, 'onChange'>,
  log: (message: string) => void,
): () => void {
  return auth.onChange((snapshot) => {
    const event = wechatIdentityUiEvent(snapshot);
    if (event) log(`[ui-event] ${JSON.stringify(event)}`);
  });
}
