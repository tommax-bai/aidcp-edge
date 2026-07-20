'use strict';

const PREFIX = '[command-diagnostic]';
const MAX_ITEMS = 50;
const RETENTION_MS = 30 * 60 * 1000;
const STAGES = new Set(['received', 'rejected', 'dispatched', 'completed', 'failed']);
const REASONS = new Set([
  'operation_unclassified',
  'capability_not_negotiated',
  'extension_not_negotiated',
  'payload_invalid',
  'handler_unavailable',
  'step_failed',
]);

function safeTime(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : fallback;
}

function normalizeEvent(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.key !== 'string' || !/^[a-f0-9]{8}$/.test(value.key)) return null;
  if (typeof value.type !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(value.type)) return null;
  if (!STAGES.has(value.stage)) return null;
  if (typeof value.summary !== 'string' || value.summary.length < 1 || value.summary.length > 160 || /[\r\n]/.test(value.summary)) return null;
  if (value.reason !== undefined && !REASONS.has(value.reason)) return null;
  return {
    key: value.key,
    type: value.type,
    stage: value.stage,
    summary: value.summary,
    ...(value.reason ? { reason: value.reason } : {}),
    receivedAt: safeTime(value.receivedAt, now),
    updatedAt: safeTime(value.updatedAt, now),
  };
}

function parseCommandDiagnosticLine(line, now = Date.now()) {
  if (typeof line !== 'string' || !line.startsWith(`${PREFIX} `)) return null;
  const json = line.slice(PREFIX.length + 1);
  if (!json || json.length > 1_024) return null;
  try {
    return normalizeEvent(JSON.parse(json), now);
  } catch {
    return null;
  }
}

function pruneCommandDiagnostics(entries, now = Date.now()) {
  const cutoff = now - RETENTION_MS;
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => normalizeEvent(entry, now))
    .filter((entry) => entry && entry.updatedAt >= cutoff && entry.updatedAt <= now + 60_000)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ITEMS);
}

function mergeCommandDiagnostic(entries, event, now = Date.now()) {
  const incoming = normalizeEvent({ ...event, receivedAt: now, updatedAt: now }, now);
  const current = pruneCommandDiagnostics(entries, now);
  if (!incoming) return current;
  const index = current.findIndex((entry) => entry.key === incoming.key && entry.type === incoming.type);
  if (index >= 0) {
    const previous = current[index];
    current[index] = {
      ...incoming,
      receivedAt: previous.receivedAt,
      updatedAt: now,
    };
  } else {
    current.push(incoming);
  }
  return current.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ITEMS);
}

function commandDiagnosticTraceLine(event) {
  const normalized = normalizeEvent(event, Date.now());
  return normalized ? `${PREFIX} ${normalized.type} ${normalized.stage}` : `${PREFIX} invalid event rejected`;
}

module.exports = {
  PREFIX,
  MAX_ITEMS,
  RETENTION_MS,
  parseCommandDiagnosticLine,
  pruneCommandDiagnostics,
  mergeCommandDiagnostic,
  commandDiagnosticTraceLine,
};
