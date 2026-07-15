import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WECHAT_CHANNELS_API_BASE_URL,
  WechatChannelsApiClient,
  type WechatChannelsEndpoint,
} from '../../src/wechat-channels/api-client.js';
import { WechatChannelsError } from '../../src/wechat-channels/error-classifier.js';
import type { WechatSessionMaterial } from '../../src/wechat-channels/types.js';

const SESSION: WechatSessionMaterial = {
  cookies: [
    { name: 'finder_session', value: 'cookie-secret', domain: '.channels.weixin.qq.com', path: '/' },
    { name: 'unrelated', value: 'must-not-leak', domain: '.example.com', path: '/' },
  ],
  userAgent: 'Wechat-Test-UA',
  acquiredAt: 1,
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...init.headers },
    ...init,
  });
}

test('wechat api: fixed TLS endpoint, scoped cookie jar, and unknown response fields are tolerated', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const api = new WechatChannelsApiClient({
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return json({
        errCode: 0,
        data: {
          posts: [{ objectId: 'post-1', desc: 'title', createTime: 1_700_000_000, futureField: true }],
          hasMore: false,
          futurePageField: 'ignored',
        },
      });
    }) as typeof fetch,
  });

  const page = await api.listPosts(SESSION, null, 10);
  assert.equal(page.items[0].externalId, 'post-1');
  assert.equal(calls[0].url, `${WECHAT_CHANNELS_API_BASE_URL}/post/post_list`);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('cookie'), 'finder_session=cookie-secret');
  assert.equal(headers.get('cookie')?.includes('must-not-leak'), false);
});

test('wechat api: retries only bounded read calls and never retries writes', async () => {
  let readCalls = 0;
  const readApi = new WechatChannelsApiClient({
    maxRetries: 2,
    sleepImpl: async () => {},
    fetchImpl: (async () => {
      readCalls++;
      if (readCalls < 3) throw new Error('socket reset');
      return json({ errCode: 0, data: { posts: [], hasMore: false } });
    }) as typeof fetch,
  });
  await readApi.listPosts(SESSION, null);
  assert.equal(readCalls, 3);

  let writeCalls = 0;
  const writeApi = new WechatChannelsApiClient({
    maxRetries: 3,
    sleepImpl: async () => {},
    fetchImpl: (async () => {
      writeCalls++;
      throw new Error('response lost');
    }) as typeof fetch,
  });
  await assert.rejects(
    () => writeApi.sendDmText(SESSION, { threadExternalId: 'thread-1', text: 'hello' }),
    (error: unknown) => error instanceof WechatChannelsError && error.category === 'transient_network' && error.requestDispatched,
  );
  assert.equal(writeCalls, 1);
});

test('wechat api: one deadline covers response body reads and returns a redacted transient category', async () => {
  const api = new WechatChannelsApiClient({
    timeoutMs: 5,
    maxRetries: 0,
    fetchImpl: (async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const fallback = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('{"errCode":0,"data":{"posts":[],"hasMore":false}}'));
          controller.close();
        }, 30);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(fallback);
          controller.error(new DOMException('cookie-secret', 'AbortError'));
        }, { once: true });
      },
    }))) as typeof fetch,
  });
  await assert.rejects(
    () => api.listPosts(SESSION, null),
    (error: unknown) =>
      error instanceof WechatChannelsError &&
      error.category === 'transient_network' &&
      error.requestDispatched &&
      !error.message.includes('cookie-secret'),
  );
});

test('wechat api: response size and schema failures are stable and open only the observed endpoint', async () => {
  const changed: WechatChannelsEndpoint[] = [];
  const oversized = new WechatChannelsApiClient({
    maxRetries: 0,
    maxResponseBytes: 16,
    onSchemaChanged: (endpoint) => changed.push(endpoint),
    fetchImpl: (async () => new Response('{"data":{"posts":[]}}', {
      status: 200,
      headers: { 'content-length': '4096' },
    })) as typeof fetch,
  });
  await assert.rejects(
    () => oversized.listPosts(SESSION, null),
    (error: unknown) => error instanceof WechatChannelsError && error.code === 'WECHAT_SCHEMA_CHANGED',
  );
  assert.deepEqual(changed, ['postList']);

  const missingField = new WechatChannelsApiClient({
    maxRetries: 0,
    onSchemaChanged: (endpoint) => changed.push(endpoint),
    fetchImpl: (async () => json({ errCode: 0, data: { posts: [{ desc: 'missing id', createTime: 1 }] } })) as typeof fetch,
  });
  await assert.rejects(
    () => missingField.listPosts(SESSION, null),
    (error: unknown) =>
      error instanceof WechatChannelsError &&
      error.category === 'schema_changed' &&
      !error.message.includes('cookie-secret'),
  );
  assert.deepEqual(changed, ['postList', 'postList']);
});

test('wechat api: auth, rate limit, and DM unknown message types are classified honestly', async () => {
  const authApi = new WechatChannelsApiClient({
    maxRetries: 0,
    fetchImpl: (async () => json({ errCode: 40101, errMsg: 'login expired' })) as typeof fetch,
  });
  await assert.rejects(
    () => authApi.getIdentity(SESSION),
    (error: unknown) => error instanceof WechatChannelsError && error.category === 'auth_expired',
  );

  const rateApi = new WechatChannelsApiClient({
    maxRetries: 0,
    nowImpl: () => 1_000,
    fetchImpl: (async () => json({ errCode: 429, errMsg: 'rate limit' }, {
      status: 429,
      headers: { 'retry-after': '2' },
    })) as typeof fetch,
  });
  await assert.rejects(
    () => rateApi.listPosts(SESSION, null),
    (error: unknown) => error instanceof WechatChannelsError && error.category === 'rate_limited' && error.retryAfterMs === 2_000,
  );

  const dmApi = new WechatChannelsApiClient({
    fetchImpl: (async () => json({
      errCode: 0,
      data: {
        messages: [
          { msgId: 'm-1', type: 'voice_card_v9', direction: 'inbound', content: 'opaque', createTime: 1_700_000_000 },
        ],
        hasMore: false,
      },
    })) as typeof fetch,
  });
  const page = await dmApi.listDmHistory(SESSION, 'thread-1', null);
  assert.equal(page.items[0].messageType, 'unknown');
  assert.equal(page.items[0].contentText, null);
  assert.equal(page.items[0].platformType, 'voice_card_v9');
});

test('wechat api: missing pagination/direction fields trip schema circuit and explicit negative writes are not schema drift', async () => {
  const changed: WechatChannelsEndpoint[] = [];
  const missingPaging = new WechatChannelsApiClient({
    maxRetries: 0,
    onSchemaChanged: (endpoint) => changed.push(endpoint),
    fetchImpl: (async () => json({ errCode: 0, data: { posts: [] } })) as typeof fetch,
  });
  await assert.rejects(
    () => missingPaging.listPosts(SESSION, null),
    (error: unknown) => error instanceof WechatChannelsError && error.category === 'schema_changed',
  );

  const missingDirection = new WechatChannelsApiClient({
    maxRetries: 0,
    onSchemaChanged: (endpoint) => changed.push(endpoint),
    fetchImpl: (async () => json({
      errCode: 0,
      data: { messages: [{ msgId: 'm-1', type: 'text', content: 'hello', createTime: 1 }], hasMore: false },
    })) as typeof fetch,
  });
  await assert.rejects(
    () => missingDirection.listDmHistory(SESSION, 'thread-1', null),
    (error: unknown) => error instanceof WechatChannelsError && error.category === 'schema_changed',
  );
  assert.deepEqual(changed, ['postList', 'dmHistory']);

  const rejectedWrite = new WechatChannelsApiClient({
    onSchemaChanged: (endpoint) => changed.push(endpoint),
    fetchImpl: (async () => json({ errCode: 0, data: { accepted: false } })) as typeof fetch,
  });
  await assert.rejects(
    () => rejectedWrite.sendDmText(SESSION, { threadExternalId: 'thread-1', text: 'hello' }),
    (error: unknown) => error instanceof WechatChannelsError && error.category === 'platform_rejected',
  );
  assert.deepEqual(changed, ['postList', 'dmHistory']);
});
