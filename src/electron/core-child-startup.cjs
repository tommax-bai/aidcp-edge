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
 *
 * 这里是 `handle.child` 赋值的**唯一入口**，所有会拉起核心的路径（手动启动 / 崩溃重起 / 待机唤醒 /
 * 排期任务 / 无浏览器控制面 bootstrap / 受限离场清理 / 临时浏览器通道）都必经此处。准入闸因此长在这里
 * （change cancel-in-flight-environment-launch）：不变量从「每条启动路径都要记得复核取消意图」变成
 * 「不管从哪来，进门必查」。`admit` 是**必填**——新增启动路径不给判据会当场抛错，而不是默默放行。
 */
function initializeOwnedCoreChild({
  handle,
  child,
  admit,
  onAdmissionDenied,
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
  if (typeof admit !== 'function' || typeof onAdmissionDenied !== 'function') {
    throw new TypeError('initializeOwnedCoreChild requires an admission gate (admit + onAdmissionDenied)');
  }

  // 准入判定 MUST 早于所有权赋值：赋值之后再判，「已有子进程」这一条恒真、判据自己就废了；
  // 而在已有活着的兄弟子进程时覆盖 `handle.child`，会把那个仍在跑的进程变成没人认领的孤儿。
  const denial = admit();
  if (denial) {
    // 崩溃隔离（与 observers.spawnError 同一条红线）：'error' 无监听会被 EventEmitter 重抛为未捕获异常、
    // 连累全部兄弟环境。这个子进程不登记为本环境所有，故只装最小安全网，终止由调用方负责。
    child.on('error', () => {});
    runBestEffort('release start reservation', releaseStartReservation, onCleanupError);
    runBestEffort('terminate unadopted child', () => onAdmissionDenied(denial), onCleanupError);
    return { ok: false, admissionDenied: denial, launchReady: null };
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
