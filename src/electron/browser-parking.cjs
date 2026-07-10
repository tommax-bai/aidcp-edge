const PARKING_MODES = new Set(['primary-screen', 'parking-display', 'edge-strip', 'offscreen']);
// 主屏停放：把窗口摆到主屏一个操作系统必然认账的可见位置（不试图移出屏幕）。
// 历史模式 edge-strip / offscreen 请求的坐标（贴右边缘只留 18px、或完全移出屏外）会被 macOS
// 窗口服务强行拽回屏内 → 「窗口停放没有生效」；主屏停放据此取代它们成为默认。
const DEFAULT_PARKING_MODE = 'primary-screen';
const PARKING_WINDOW_WIDTH = 1440;
const PARKING_WINDOW_HEIGHT = 980;
const EDGE_STRIP_VISIBLE_PX = 18;
const OFFSCREEN_GAP_PX = 80;

function normalizeParkingMode(value) {
  return PARKING_MODES.has(value) ? value : DEFAULT_PARKING_MODE;
}

function rectOf(display) {
  const r = (display && (display.workArea || display.bounds)) || {};
  return {
    x: Number.isFinite(r.x) ? r.x : 0,
    y: Number.isFinite(r.y) ? r.y : 0,
    width: Number.isFinite(r.width) && r.width > 0 ? r.width : 1440,
    height: Number.isFinite(r.height) && r.height > 0 ? r.height : 900,
  };
}

function sameDisplay(a, b) {
  if (!a || !b) return false;
  if (a.id != null && b.id != null) return a.id === b.id;
  const ar = rectOf(a);
  const br = rectOf(b);
  return ar.x === br.x && ar.y === br.y && ar.width === br.width && ar.height === br.height;
}

function edgeStripBounds(primary) {
  const r = rectOf(primary);
  return {
    left: r.x + r.width - EDGE_STRIP_VISIBLE_PX,
    top: r.y,
    width: PARKING_WINDOW_WIDTH,
    height: PARKING_WINDOW_HEIGHT,
  };
}

function offscreenBounds(primary) {
  const r = rectOf(primary);
  return {
    left: r.x + r.width + OFFSCREEN_GAP_PX,
    top: r.y,
    width: PARKING_WINDOW_WIDTH,
    height: PARKING_WINDOW_HEIGHT,
  };
}

// 窗口尺寸按显示器工作区夹取：绝不比屏幕大，否则越界部分被系统裁掉、又回到「看着没停放好」。
function fittedSize(r) {
  return {
    width: Math.max(1, Math.min(PARKING_WINDOW_WIDTH, r.width)),
    height: Math.max(1, Math.min(PARKING_WINDOW_HEIGHT, r.height)),
  };
}

// 主屏停放（默认）：完整渲染尺寸、右上贴主屏内侧的「背景位」——完全在屏内（系统必然认账），
// 靠右让出左侧给客户端窗口，且不抢焦点。与「抬前显示」用的居中位刻意不同，构成可见的停放↔显示切换。
function primaryScreenBounds(primary) {
  const r = rectOf(primary);
  const { width, height } = fittedSize(r);
  return {
    left: r.x + Math.max(0, r.width - width),
    top: r.y + Math.max(0, Math.min(40, r.height - height)),
    width,
    height,
  };
}

// 「显示浏览器」抬前的目标：居中于主屏工作区、完整渲染尺寸——前台且聚焦（core 侧再叠 bringToFront）。
// 也用作任一模式停放校验失败时的兜底位（永远可见，绝不藏成坏窗）。
function visibleBounds(primary) {
  const r = rectOf(primary);
  const { width, height } = fittedSize(r);
  return {
    left: r.x + Math.max(0, Math.floor((r.width - width) / 2)),
    top: r.y + Math.max(0, Math.floor((r.height - height) / 2)),
    width,
    height,
  };
}

function parkingDisplayBounds(display) {
  const r = rectOf(display);
  return {
    left: r.x,
    top: r.y,
    width: PARKING_WINDOW_WIDTH,
    height: PARKING_WINDOW_HEIGHT,
  };
}

function chooseSecondaryDisplay(displays, primary) {
  const list = Array.isArray(displays) ? displays : [];
  return list
    .filter((d) => !sameDisplay(d, primary))
    .sort((a, b) => {
      const ar = rectOf(a);
      const br = rectOf(b);
      return br.width * br.height - ar.width * ar.height;
    })[0] || null;
}

// 单一入口把模式解析成停放 bounds，让「无副屏降级到默认」与「默认模式本身」用同一处逻辑，
// 绝不出现 effectiveMode 与 bounds 各说各话（改默认模式时这里自动跟随）。
function boundsForMode(mode, primary) {
  if (mode === 'edge-strip') return edgeStripBounds(primary);
  if (mode === 'offscreen') return offscreenBounds(primary);
  return primaryScreenBounds(primary); // 'primary-screen'（默认）
}

function computeBrowserParkingPlan(requestedMode, displays, primaryDisplay) {
  const primary = primaryDisplay || (Array.isArray(displays) && displays[0]) || null;
  const mode = normalizeParkingMode(requestedMode);
  let effectiveMode = mode;
  let bounds;
  let reason = '';

  if (mode === 'parking-display') {
    const secondary = chooseSecondaryDisplay(displays, primary);
    if (secondary) {
      bounds = parkingDisplayBounds(secondary);
    } else {
      effectiveMode = DEFAULT_PARKING_MODE;
      bounds = boundsForMode(DEFAULT_PARKING_MODE, primary);
      reason = 'no_secondary_display';
    }
  } else {
    bounds = boundsForMode(mode, primary);
  }

  // 兜底位取「居中可见位」而非旧的贴边条：停放校验失败时窗口回到确定可见处，不再回到一个同样被系统
  // 夹回、看着仍没停好的坏位置。
  const fallbackBounds = visibleBounds(primary);
  const showBounds = visibleBounds(primary);
  return {
    requestedMode: mode,
    effectiveMode,
    reason,
    bounds,
    fallbackBounds,
    visibleBounds: showBounds,
    launchPosition: { left: bounds.left, top: bounds.top },
  };
}

function parkingEnv(plan) {
  return {
    AIDCP_BROWSER_PARKING_MODE: plan.requestedMode,
    AIDCP_BROWSER_PARKING_EFFECTIVE_MODE: plan.effectiveMode,
    AIDCP_BROWSER_PARKING_BOUNDS: JSON.stringify(plan.bounds),
    AIDCP_BROWSER_PARKING_FALLBACK_BOUNDS: JSON.stringify(plan.fallbackBounds),
    AIDCP_BROWSER_PARKING_VISIBLE_BOUNDS: JSON.stringify(plan.visibleBounds),
    AIDCP_BROWSER_PARKING_LAUNCH_POSITION: `${plan.launchPosition.left},${plan.launchPosition.top}`,
    AIDCP_BROWSER_CONTROL_STDIN: '1',
    ...(plan.reason ? { AIDCP_BROWSER_PARKING_FALLBACK_REASON: plan.reason } : {}),
  };
}

module.exports = {
  DEFAULT_PARKING_MODE,
  PARKING_WINDOW_WIDTH,
  PARKING_WINDOW_HEIGHT,
  normalizeParkingMode,
  computeBrowserParkingPlan,
  parkingEnv,
};
