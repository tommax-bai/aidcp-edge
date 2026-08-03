'use strict';

function runBestEffort(label, action, onCleanupError) {
  try {
    action();
  } catch (error) {
    try { onCleanupError(label, error); } catch { /* cleanup reporting must not interrupt cleanup */ }
  }
}

function spawnedProcessExists(child) {
  return Number.isInteger(child && child.pid) && child.pid > 0;
}

function setupTerminalExitDisposition(terminal, code, signal) {
  if (!terminal) return null;
  const retry = terminal.retry === true;
  const summary = String(terminal.summary || '核心进程启动后初始化失败').trim();
  return {
    retry,
    exitedAbnormally: retry,
    // A core may handle the cleanup SIGTERM and exit 0. The respawn policy
    // still needs a non-zero semantic input for the setup failure itself.
    respawnExitCode: retry ? 1 : null,
    message: retry ? `${summary}。` : null,
    failureSummary: summary,
    observedExitCode: code ?? null,
    observedSignal: signal ?? null,
  };
}

function finalizeNonRetryableSetupTerminal({
  terminal,
  explicitOverride,
  childStillOwned,
  projectFailure,
  broadcast,
}) {
  if (!terminal || terminal.retry === true || explicitOverride || childStillOwned) return false;
  projectFailure(terminal);
  broadcast();
  return true;
}

/**
 * Own a newly returned ChildProcess before running any fallible setup.
 *
 * ChildProcess `error` is not always terminal: Node also emits it when an
 * already-spawned process cannot be killed or sent an IPC message. Keep those
 * errors separate so callers never release ownership of a process that may
 * still be alive.
 */
function initializeOwnedCoreChild({
  handle,
  child,
  createLaunchReady,
  observers,
  prepare,
  onSetupFailure,
  settleLaunchFailure,
  releaseStartReservation,
  requestTermination,
  onCleanupError = () => {},
}) {
  if (!handle || !child || typeof child.on !== 'function') {
    throw new TypeError('initializeOwnedCoreChild requires a handle and ChildProcess-like child');
  }

  handle.child = child;
  const launchReady = createLaunchReady();
  let spawnConfirmed = spawnedProcessExists(child);

  child.once('spawn', () => { spawnConfirmed = true; });
  child.on('error', (error) => {
    if (spawnConfirmed) observers.runtimeError(error);
    else observers.spawnError(error);
  });
  child.on('exit', observers.exit);
  child.on('close', observers.close);
  child.on('message', observers.message);
  // A failed spawn may expose null stdout/stderr. Terminal observers above
  // must still remain installed so the failure is classified and released.
  child.stdout?.on?.('data', observers.stdout);
  child.stderr?.on?.('data', observers.stderr);

  try {
    return { ok: prepare() !== false, launchReady };
  } catch (error) {
    runBestEffort('report setup failure', () => onSetupFailure(error), onCleanupError);
    runBestEffort('settle launch failure', settleLaunchFailure, onCleanupError);
    runBestEffort('release start reservation', releaseStartReservation, onCleanupError);
    runBestEffort('request child termination', requestTermination, onCleanupError);
    return { ok: false, launchReady, error };
  }
}

module.exports = {
  finalizeNonRetryableSetupTerminal,
  initializeOwnedCoreChild,
  setupTerminalExitDisposition,
  spawnedProcessExists,
};
