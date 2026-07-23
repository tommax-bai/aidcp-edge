'use strict';

function validCredentials(value) {
  return Boolean(value
    && typeof value.name === 'string'
    && value.name.trim()
    && typeof value.key === 'string'
    && value.key);
}

/**
 * Resolve customer auth exactly once during Electron startup.
 *
 * Dependencies keep this coordinator free of Electron and filesystem side
 * effects, while the main process remains the only owner of decrypted keys.
 */
async function restoreClientAuthAtStartup({
  enabled,
  hasValidSession,
  validateExistingSession,
  loadSavedCredentials,
  clearSessionPreservingCredentials,
  clearSessionAndCredentials,
  loginWithCredentials,
}) {
  if (!enabled) return { ready: true, source: 'disabled' };

  if (hasValidSession()) {
    const accepted = await validateExistingSession();
    if (accepted) return { ready: true, source: 'session' };
  }

  const credentials = loadSavedCredentials();
  clearSessionPreservingCredentials();
  if (!validCredentials(credentials)) {
    return { ready: false, reason: 'credentials_unavailable' };
  }

  // Deliberately one call: no timer, recursion, page-submit, or retry branch.
  const login = await loginWithCredentials(credentials);
  if (login && login.ok) return { ready: true, source: 'credentials' };

  if (login && login.reason === 'invalid_credentials') {
    clearSessionAndCredentials();
  }
  return {
    ready: false,
    reason: login && typeof login.reason === 'string' ? login.reason : 'network',
  };
}

module.exports = {
  restoreClientAuthAtStartup,
  validCredentials,
};
