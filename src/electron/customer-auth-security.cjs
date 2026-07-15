'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const MAX_CUSTOMER_AUTH_RESPONSE_BYTES = 1024 * 1024;

class CustomerAuthResponseError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CustomerAuthResponseError';
    this.code = code;
    this.details = details;
  }
}

async function readBoundedJsonResponse(response, { maxBytes = MAX_CUSTOMER_AUTH_RESPONSE_BYTES } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer');
  const lengthText = response && response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-length')
    : null;
  const contentLength = lengthText == null || lengthText === '' ? null : Number(lengthText);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    try { await response.body?.cancel('customer-auth response too large'); } catch { /* best-effort */ }
    throw new CustomerAuthResponseError(
      'CUSTOMER_AUTH_RESPONSE_TOO_LARGE',
      'customer-auth response exceeds the local safety limit',
      { limitBytes: maxBytes, receivedBytes: contentLength },
    );
  }

  const body = response && response.body;
  if (!body) return null;
  if (typeof body.getReader !== 'function') {
    throw new CustomerAuthResponseError(
      'CUSTOMER_AUTH_RESPONSE_STREAM_INVALID',
      'customer-auth response body is not a readable byte stream',
      { limitBytes: maxBytes },
    );
  }

  const reader = body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value || []);
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maxBytes) {
        const error = new CustomerAuthResponseError(
          'CUSTOMER_AUTH_RESPONSE_TOO_LARGE',
          'customer-auth response exceeds the local safety limit',
          { limitBytes: maxBytes, receivedBytes },
        );
        try { await reader.cancel(error.message); } catch { /* best-effort */ }
        throw error;
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  if (receivedBytes === 0) return null;
  const text = Buffer.concat(chunks, receivedBytes).toString('utf8');
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new CustomerAuthResponseError(
      'CUSTOMER_AUTH_RESPONSE_INVALID_JSON',
      'customer-auth response is not valid JSON',
      { limitBytes: maxBytes, receivedBytes },
    );
  }
}

function safeStorageAvailable(safeStorage) {
  try { return Boolean(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
}

function sealClientSession(session, safeStorage) {
  if (safeStorageAvailable(safeStorage)) {
    try {
      const ciphertext = safeStorage.encryptString(JSON.stringify(session));
      return { version: 2, protection: 'safeStorage', ciphertext: ciphertext.toString('base64') };
    } catch {
      // 系统加密瞬时不可用时仍走 0600 原子文件，绝不回到普通 writeFile。
    }
  }
  return { version: 1, protection: 'mode-0600', session };
}

function unsealClientSession(record, safeStorage) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (record.version === 2 && record.protection === 'safeStorage') {
    if (!safeStorageAvailable(safeStorage) || typeof record.ciphertext !== 'string' || !record.ciphertext) return null;
    const plaintext = safeStorage.decryptString(Buffer.from(record.ciphertext, 'base64'));
    return JSON.parse(plaintext);
  }
  if (record.version === 1 && record.protection === 'mode-0600') return record.session || null;
  if (typeof record.token === 'string') return record; // 旧版明文格式：load 后由 main 立即迁移。
  return null;
}

function isEncryptedClientSessionRecord(record) {
  return Boolean(record && record.version === 2 && record.protection === 'safeStorage' && record.ciphertext);
}

function writePrivateJsonAtomic(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value), { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch { /* best-effort */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* already moved/absent */ }
    throw error;
  }
}

module.exports = {
  MAX_CUSTOMER_AUTH_RESPONSE_BYTES,
  CustomerAuthResponseError,
  readBoundedJsonResponse,
  safeStorageAvailable,
  sealClientSession,
  unsealClientSession,
  isEncryptedClientSessionRecord,
  writePrivateJsonAtomic,
};
