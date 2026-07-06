const PARKING_MODES = new Set(['parking-display', 'edge-strip', 'offscreen']);
const DEFAULT_PARKING_MODE = 'edge-strip';
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

function visibleBounds(primary) {
  const r = rectOf(primary);
  return {
    left: r.x + Math.max(0, Math.min(80, Math.floor(r.width / 10))),
    top: r.y + Math.max(0, Math.min(60, Math.floor(r.height / 10))),
    width: PARKING_WINDOW_WIDTH,
    height: PARKING_WINDOW_HEIGHT,
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
      bounds = edgeStripBounds(primary);
      reason = 'no_secondary_display';
    }
  } else if (mode === 'offscreen') {
    bounds = offscreenBounds(primary);
  } else {
    bounds = edgeStripBounds(primary);
  }

  const fallbackBounds = edgeStripBounds(primary);
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
