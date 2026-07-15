import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const security = require(join(here, '../../src/electron/customer-auth-security.cjs')) as {
  readBoundedJsonResponse: (response: any, options?: { maxBytes?: number }) => Promise<any>;
  sealClientSession: (session: any, safeStorage: any) => any;
  unsealClientSession: (record: any, safeStorage: any) => any;
  writePrivateJsonAtomic: (file: string, value: any) => void;
};

test('customer-auth bounded reader：小 JSON 正常解析，chunked 超限立即结构化拒绝', async () => {
  const small = await security.readBoundedJsonResponse(new Response(JSON.stringify({ ok: true })), { maxBytes: 64 });
  assert.deepEqual(small, { ok: true });

  const oversized = new Response('x'.repeat(65), { headers: { 'content-length': '65' } });
  await assert.rejects(
    security.readBoundedJsonResponse(oversized, { maxBytes: 64 }),
    (error: any) => error?.code === 'CUSTOMER_AUTH_RESPONSE_TOO_LARGE' && error.details.limitBytes === 64,
  );

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"value":"'));
      controller.enqueue(new TextEncoder().encode('x'.repeat(80)));
      controller.close();
    },
  });
  await assert.rejects(
    security.readBoundedJsonResponse({ headers: { get: () => null }, body: stream }, { maxBytes: 64 }),
    (error: any) => error?.code === 'CUSTOMER_AUTH_RESPONSE_TOO_LARGE' && error.details.receivedBytes > 64,
  );
});

test('customer-auth bounded reader：限额内非 JSON 返回 schema error，不静默当成功', async () => {
  await assert.rejects(
    security.readBoundedJsonResponse(new Response('<html>bad gateway</html>'), { maxBytes: 128 }),
    (error: any) => error?.code === 'CUSTOMER_AUTH_RESPONSE_INVALID_JSON',
  );
});

test('customer JWT：safeStorage 可用时整包加密，磁盘记录不含 token 明文', () => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
    decryptString: (value: Buffer) => Buffer.from(value.toString().slice('sealed:'.length), 'base64').toString('utf8'),
  };
  const session = { token: 'jwt-super-secret', name: 'fixture-user', expiresAt: 123456 };
  const record = security.sealClientSession(session, safeStorage);
  assert.equal(record.protection, 'safeStorage');
  assert.doesNotMatch(JSON.stringify(record), /jwt-super-secret/);
  assert.deepEqual(security.unsealClientSession(record, safeStorage), session);
});

test('customer JWT：原子替换并显式保持 0600，不遗留临时文件', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'aidcp-customer-auth-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'client-session.json');
  security.writePrivateJsonAtomic(file, { version: 1, token: 'first' });
  security.writePrivateJsonAtomic(file, { version: 2, token: 'second' });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 2, token: 'second' });
  assert.deepEqual(readdirSync(directory), ['client-session.json']);
});
