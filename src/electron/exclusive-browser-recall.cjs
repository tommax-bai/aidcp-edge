'use strict';

function settledControlResult(result, fallbackError) {
  if (result && result.ok === true) return { ok: true };
  return {
    ok: false,
    error: String((result && result.error) || fallbackError || '浏览器窗口控制失败'),
  };
}

function createExclusiveBrowserRecallCoordinator({
  listHandles,
  isControllable,
  parkBrowser,
  showBrowser,
  idOf = (handle) => String(handle && handle.envId || ''),
  labelOf = (handle) => String(handle && (handle.name || handle.profileId || handle.envId) || '未知环境'),
} = {}) {
  if (typeof listHandles !== 'function' || typeof isControllable !== 'function'
    || typeof parkBrowser !== 'function' || typeof showBrowser !== 'function') {
    throw new TypeError('exclusive browser recall dependencies are required');
  }

  let latestGeneration = 0;
  let tail = Promise.resolve();

  const recall = (target) => {
    // 无效目标不应取消一个已经在途的有效召回；它也不会触碰任何其他窗口。
    if (!target || !isControllable(target)) {
      return Promise.resolve({ ok: false, error: '引擎未运行或浏览器尚未就绪，请先启动引擎再操作' });
    }
    const generation = ++latestGeneration;
    const run = async () => {
      if (generation !== latestGeneration) return { ok: false, superseded: true };
      if (!isControllable(target)) {
        return { ok: false, error: '引擎未运行或浏览器尚未就绪，请先启动引擎再操作' };
      }

      const targetId = idOf(target);
      const others = Array.from(listHandles() || [])
        .filter((handle) => handle && idOf(handle) !== targetId && isControllable(handle));
      const parkResults = await Promise.all(others.map(async (handle) => {
        try {
          const result = settledControlResult(await parkBrowser(handle), '浏览器窗口归位失败');
          return { handle, ...result };
        } catch (error) {
          return { handle, ok: false, error: error?.message || '浏览器窗口归位失败' };
        }
      }));

      // 新请求已到达时，不再把旧目标抬前；其已完成的非目标归位都是安全、可逆的。
      if (generation !== latestGeneration) return { ok: false, superseded: true };

      let shown;
      try {
        shown = settledControlResult(await showBrowser(target), '目标浏览器窗口移动失败');
      } catch (error) {
        shown = { ok: false, error: error?.message || '目标浏览器窗口移动失败' };
      }
      // show 已写出后无法可信取消，但串行尾部会让最新请求随后建立最终布局；旧回执不得更新 renderer。
      if (generation !== latestGeneration) return { ok: false, superseded: true };
      if (!shown.ok) return { ...shown, otherParkingAttempted: true };

      const failures = parkResults.filter((result) => !result.ok);
      return {
        ok: true,
        parkFailureCount: failures.length,
        parkFailures: failures.slice(0, 5).map((result) => ({
          envId: idOf(result.handle),
          name: labelOf(result.handle).trim().replace(/\s+/g, ' ').slice(0, 80) || idOf(result.handle),
          error: String(result.error || '浏览器窗口归位失败').slice(0, 240),
        })),
      };
    };

    const result = tail.then(run, run);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  return { recall };
}

module.exports = { createExclusiveBrowserRecallCoordinator };
