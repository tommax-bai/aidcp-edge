'use strict';

// Pure approval-page helpers. Browser uses window.publishReviewLogic; node:test uses CommonJS export.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.publishReviewLogic = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
  const SCHEDULE_MIN_AHEAD_MS = 60 * 60 * 1000;
  const SCHEDULE_MAX_AHEAD_MS = 14 * 24 * 60 * 60 * 1000;
  const PEAK_HOURS = Object.freeze([8, 12, 18]);

  function toShanghaiInput(timestamp) {
    if (!Number.isFinite(timestamp)) return '';
    return new Date(timestamp + SHANGHAI_OFFSET_MS).toISOString().slice(0, 16);
  }

  function fromShanghaiInput(value) {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return null;
    const timestamp = Date.parse(`${text}:00+08:00`);
    if (!Number.isFinite(timestamp) || toShanghaiInput(timestamp) !== text) return null;
    return timestamp;
  }

  function defaultScheduledInput(now) {
    const earliest = now + SCHEDULE_MIN_AHEAD_MS;
    return toShanghaiInput(Math.ceil(earliest / 60_000) * 60_000);
  }

  function shanghaiHourKey(timestamp) {
    const input = toShanghaiInput(timestamp);
    return input ? input.slice(0, 13) : '';
  }

  function nextPeakScheduledInput(currentInput, occupiedTimes, now) {
    if (!Number.isFinite(now)) return null;
    const current = fromShanghaiInput(currentInput);
    const earliest = now + SCHEDULE_MIN_AHEAD_MS;
    const latest = now + SCHEDULE_MAX_AHEAD_MS;
    const cursor = current !== null && current > earliest ? current : earliest;
    const occupied = new Set(
      (Array.isArray(occupiedTimes) ? occupiedTimes : [])
        .map(shanghaiHourKey)
        .filter(Boolean),
    );
    const shanghaiDate = toShanghaiInput(cursor).slice(0, 10);
    const startDay = Date.parse(`${shanghaiDate}T00:00:00Z`);
    for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
      const date = new Date(startDay + dayOffset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      for (const hour of PEAK_HOURS) {
        const input = `${date}T${String(hour).padStart(2, '0')}:00`;
        const timestamp = fromShanghaiInput(input);
        if (timestamp === null || timestamp < earliest || timestamp > latest) continue;
        if (current !== null && timestamp <= current) continue;
        if (occupied.has(shanghaiHourKey(timestamp))) continue;
        return input;
      }
    }
    return null;
  }

  function validatePlan(platform, mode, inputValue, now) {
    if (mode === 'immediate') return { ok: true, publishMode: 'immediate', publishTime: null };
    if (mode !== 'scheduled') return { ok: false, reason: 'invalid_publish_plan' };
    if (platform !== 'xiaohongshu') return { ok: false, reason: 'schedule_platform_unsupported' };
    const publishTime = fromShanghaiInput(inputValue);
    if (publishTime === null) return { ok: false, reason: 'schedule_time_required' };
    const ahead = publishTime - now;
    if (ahead < SCHEDULE_MIN_AHEAD_MS || ahead > SCHEDULE_MAX_AHEAD_MS) {
      return { ok: false, reason: 'schedule_time_out_of_range' };
    }
    return { ok: true, publishMode: 'scheduled', publishTime };
  }

  function normalizeDraft(raw) {
    const row = raw && typeof raw === 'object' ? raw : {};
    const recordId = Number(row.recordId ?? row.id);
    return {
      ...row,
      recordId: Number.isInteger(recordId) && recordId > 0 ? recordId : 0,
      platform: String(row.platform || 'xiaohongshu'),
      kind: row.kind === 'rewrite' ? 'rewrite' : 'generated',
      title: typeof row.title === 'string' ? row.title : null,
      content: typeof row.content === 'string' ? row.content : '',
      topics: Array.isArray(row.topics) ? row.topics : [],
      images: Array.isArray(row.images) ? row.images : [],
      contentVersion: Number.isInteger(row.contentVersion) ? row.contentVersion : 0,
      updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
      publishMode: row.publishMode === 'scheduled' ? 'scheduled' : 'immediate',
      publishTime: row.publishMode === 'scheduled' && Number.isFinite(row.publishTime) ? row.publishTime : null,
    };
  }

  return {
    SHANGHAI_OFFSET_MS,
    SCHEDULE_MIN_AHEAD_MS,
    SCHEDULE_MAX_AHEAD_MS,
    PEAK_HOURS,
    toShanghaiInput,
    fromShanghaiInput,
    defaultScheduledInput,
    shanghaiHourKey,
    nextPeakScheduledInput,
    validatePlan,
    normalizeDraft,
  };
});
