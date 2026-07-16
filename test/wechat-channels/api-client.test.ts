import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  WECHAT_CHANNELS_API_BASE_URL,
  WechatChannelsApiClient,
  type WechatChannelsEndpoint,
} from '../../src/wechat-channels/api-client.js';
import { WechatChannelsError } from '../../src/wechat-channels/error-classifier.js';
import { serializeWechatRequest, structuralRequestShape } from '../../src/wechat-channels/request-descriptors.js';
import type { WechatSessionMaterial } from '../../src/wechat-channels/types.js';

const SESSION: WechatSessionMaterial = {
  cookies: [
    { name: 'finder_session', value: 'cookie-secret', domain: '.channels.weixin.qq.com', path: '/' },
    { name: 'unrelated', value: 'must-not-leak', domain: '.example.com', path: '/' },
  ],
  userAgent: 'Wechat-Test-UA',
  acquiredAt: 1,
  requestContext: { version: 1, aid: 'aid-test', pageUrl: 'https://channels.weixin.qq.com/platform/post/list', commonBody: { logFinderId: 'finder-test', logFinderUin: 'uin-test', rawKeyBuff: 'raw-key-test', pluginSessionId: null, reqScene: 7, scene: 7 }, headers: { fingerprintDeviceId: 'device-test', wechatUin: 'uin-test' } },
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...init.headers },
    ...init,
  });
}

test('wechat api: golden serializers match the secret-free authorized-session manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../fixtures/wechat-channels/real-session-request-shapes.json', import.meta.url), 'utf8')) as {
    common: { queryKeys: string[]; bodyShape: Record<string, string>; requiredHeaderNames: string[] };
    requests: Record<string, { path?: string; businessBody?: Record<string, string>; descriptorEnabled?: boolean }>;
  };
  const valueFor = (type: string): unknown => type === 'number' ? 1 : type === 'boolean' ? false : type === 'array' ? [] : '';
  for (const [name, evidence] of Object.entries(manifest.requests)) {
    if (!evidence.path || evidence.descriptorEnabled === false) continue;
    const businessBody = Object.fromEntries(Object.entries(evidence.businessBody ?? {}).map(([key, type]) => [key, valueFor(type)]));
    const request = serializeWechatRequest(name as WechatChannelsEndpoint, businessBody, SESSION, {
      now: () => 123, requestId: () => 'rid-redacted',
    });
    const shape = structuralRequestShape(request);
    assert.equal(shape.path, evidence.path, name);
    assert.deepEqual(shape.queryKeys, [...manifest.common.queryKeys].sort(), name);
    assert.deepEqual(shape.bodyShape, { ...manifest.common.bodyShape, ...(evidence.businessBody ?? {}) }, name);
    for (const header of manifest.common.requiredHeaderNames) {
      assert.ok(shape.headerNames.includes(header.toLowerCase()), `${name}:${header}`);
    }
  }
  const persisted = JSON.stringify(manifest);
  assert.doesNotMatch(persisted, /cookie-secret|raw-key-test|finder-test|device-test|uin-test/);
});

test('wechat api: fixed TLS endpoint, scoped cookie jar, and unknown response fields are tolerated', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const api = new WechatChannelsApiClient({
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return json({
        errCode: 0,
        data: {
          list: [{ objectId: 'post-1', desc: { description: 'title' }, createTime: 1_700_000_000, futureField: true }],
          continueFlag: false,
          lastBuff: '',
          totalCount: 1,
          futurePageField: 'ignored',
        },
      });
    }) as typeof fetch,
  });

  const page = await api.listPosts(SESSION, null, 10);
  assert.equal(page.items[0].externalId, 'post-1');
  assert.equal(calls[0].url.startsWith(`${WECHAT_CHANNELS_API_BASE_URL}/micro/content/cgi-bin/mmfinderassistant-bin/post/post_list?`), true);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('cookie'), 'finder_session=cookie-secret');
  assert.equal(headers.get('cookie')?.includes('must-not-leak'), false);
  assert.equal(headers.get('x-wechat-uin'), 'uin-test');
  assert.equal(headers.get('finger-print-device-id'), 'device-test');
  const shape = structuralRequestShape(serializeWechatRequest('postList', {
    currentPage: 1, pageSize: 10, userpageType: 0, stickyOrder: false,
  }, SESSION, { now: () => 123, requestId: () => 'rid-test' }));
  assert.deepEqual(shape.queryKeys, ['_aid', '_pageUrl', '_rid']);
  assert.equal(shape.bodyShape.timestamp, 'string');
  assert.equal(shape.bodyShape.currentPage, 'number');
});

test('wechat api: page-number requests do not reuse response lastBuff as the next request cursor', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const api = new WechatChannelsApiClient({
    maxRetries: 0,
    fetchImpl: (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ errCode: 0, data: { list: [], continueFlag: true, lastBuff: 'opaque-not-a-request-field' } });
    }) as typeof fetch,
  });
  const first = await api.listPosts(SESSION, null, 10);
  assert.deepEqual(first, { items: [], nextCursor: '2', hasMore: true });
  await api.listPosts(SESSION, first.nextCursor, 10);
  assert.equal(bodies[1].currentPage, 2);
  assert.equal('lastBuff' in bodies[1], false);
});

test('wechat api: comment/DM adapters accept only the captured empty-result boundary', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const api = new WechatChannelsApiClient({
    maxRetries: 0,
    fetchImpl: (async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (path.endsWith('/post/post_list')) {
        return json({ errCode: 0, data: { list: [{ objectId: 'post-1', commentCount: 0, commentList: [] }],
          continueFlag: false, lastBuff: '' } }, { status: 201 });
      }
      if (path.endsWith('/get-history-msg')) {
        return json({ errCode: 0, data: { msg: [], isContinue: false, cookie: '', baseResp: { errcode: 0 } } }, { status: 201 });
      }
      return json({ errCode: 0, data: { sessionInfo: [], baseResp: { errcode: 0 } } }, { status: 201 });
    }) as typeof fetch,
  });
  assert.deepEqual(await api.listComments(SESSION, 'post-1', null, 20), { items: [], nextCursor: null, hasMore: false });
  assert.deepEqual(await api.listDmSessions(SESSION, null, 20), { items: [], nextCursor: null, hasMore: false });
  assert.deepEqual(Object.keys(calls[0].body).filter((key) => !key.startsWith('_') &&
    !['rawKeyBuff', 'timestamp', 'scene', 'reqScene', 'pluginSessionId'].includes(key)).sort(),
  ['currentPage', 'pageSize', 'stickyOrder', 'userpageType']);
  assert.deepEqual(calls.slice(1).map((call) => call.path), [
    '/micro/interaction/cgi-bin/mmfinderassistant-bin/private-msg/get-history-msg',
    '/micro/interaction/cgi-bin/mmfinderassistant-bin/private-msg/get-session-info',
  ]);
  assert.deepEqual(calls[2].body.sessionId, []);
});

test('wechat api: non-empty embedded comments remain unverified and trip only their endpoint circuit', async () => {
  const changed: WechatChannelsEndpoint[] = [];
  const api = new WechatChannelsApiClient({
    maxRetries: 0, onSchemaChanged: (endpoint) => changed.push(endpoint),
    fetchImpl: (async () => json({ errCode: 0, data: {
      list: [{ objectId: 'post-1', commentCount: 1, commentList: [{ commentId: 'unverified' }] }],
      continueFlag: false, lastBuff: '',
    } })) as typeof fetch,
  });
  await assert.rejects(() => api.listComments(SESSION, 'post-1', null),
    (error: unknown) => error instanceof WechatChannelsError && error.category === 'schema_changed');
  assert.deepEqual(changed, ['commentPagePostList']);
});

test('wechat api: comment-page pagination searches for the matching post without treating posts as comments', async () => {
  const pages: number[] = [];
  const api = new WechatChannelsApiClient({
    maxRetries: 0,
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      pages.push(body.currentPage as number);
      return json({ errCode: 0, data: body.currentPage === 1
        ? { list: [{ objectId: 'another-post', commentList: [] }], continueFlag: true, lastBuff: 'unused' }
        : { list: [{ objectId: 'post-2', commentList: [] }], continueFlag: false, lastBuff: '' } });
    }) as typeof fetch,
  });
  const first = await api.listComments(SESSION, 'post-2', null, 20);
  assert.deepEqual(first, { items: [], nextCursor: '2', hasMore: true });
  const second = await api.listComments(SESSION, 'post-2', first.nextCursor, 20);
  assert.deepEqual(second, { items: [], nextCursor: null, hasMore: false });
  assert.deepEqual(pages, [1, 2]);
});

test('wechat api: retries only bounded read calls and never retries writes', async () => {
  let readCalls = 0;
  const readApi = new WechatChannelsApiClient({
    maxRetries: 2,
    sleepImpl: async () => {},
    fetchImpl: (async () => {
      readCalls++;
      if (readCalls < 3) throw new Error('socket reset');
      return json({ errCode: 0, data: { list: [], continueFlag: false, lastBuff: '', totalCount: 0 } });
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
    (error: unknown) => error instanceof WechatChannelsError && error.category === 'schema_changed' && !error.requestDispatched,
  );
  assert.equal(writeCalls, 0);
});

test('wechat api: one deadline covers response body reads and returns a redacted transient category', async () => {
  const api = new WechatChannelsApiClient({
    timeoutMs: 5,
    maxRetries: 0,
    fetchImpl: (async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const fallback = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('{"errCode":0,"data":{"list":[],"continueFlag":false,"lastBuff":"","totalCount":0}}'));
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
    fetchImpl: (async () => json({ errCode: 0, data: { list: [{ desc: { description: 'missing id' }, createTime: 1 }], continueFlag: false, lastBuff: '' } })) as typeof fetch,
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

test('wechat api: auth, rate limit, and non-empty DM shapes outside the capture boundary are classified honestly', async () => {
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
        msg: [
          { msgId: 'm-1', sessionId: 'thread-1', type: 'voice_card_v9', direction: 'inbound', content: 'opaque', createTime: 1_700_000_000 },
        ],
        isContinue: false,
        cookie: '',
      },
    })) as typeof fetch,
  });
  await assert.rejects(
    () => dmApi.listDmHistory(SESSION, 'thread-1', null),
    (error: unknown) => error instanceof WechatChannelsError && error.category === 'schema_changed',
  );
});

test('wechat api: missing pagination/direction fields trip schema circuit and explicit negative writes are not schema drift', async () => {
  const changed: WechatChannelsEndpoint[] = [];
  const missingPaging = new WechatChannelsApiClient({
    maxRetries: 0,
    onSchemaChanged: (endpoint) => changed.push(endpoint),
    fetchImpl: (async () => json({ errCode: 0, data: { list: [] } })) as typeof fetch,
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
      data: { msg: [{ msgId: 'm-1', type: 'text', content: 'hello', createTime: 1 }], isContinue: false, cookie: '' },
    })) as typeof fetch,
  });
  await assert.rejects(
    () => missingDirection.listDmHistory(SESSION, 'thread-1', null),
    (error: unknown) => error instanceof WechatChannelsError && error.category === 'schema_changed',
  );
  assert.deepEqual(changed, ['postList', 'dmHistory']);

  let writeFetches = 0;
  const rejectedWrite = new WechatChannelsApiClient({
    onSchemaChanged: (endpoint) => changed.push(endpoint),
    fetchImpl: (async () => { writeFetches++; return json({ errCode: 0, data: { accepted: false } }); }) as typeof fetch,
  });
  await assert.rejects(
    () => rejectedWrite.sendDmText(SESSION, { threadExternalId: 'thread-1', text: 'hello' }),
    (error: unknown) => error instanceof WechatChannelsError && error.category === 'schema_changed' && !error.requestDispatched,
  );
  assert.equal(writeFetches, 0);
  assert.deepEqual(changed, ['postList', 'dmHistory', 'dmSendText']);
});
