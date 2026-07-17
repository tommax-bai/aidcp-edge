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

test('wechat api: comment and DM adapters use the observed read-only request shapes', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const api = new WechatChannelsApiClient({
    maxRetries: 0,
    fetchImpl: (async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (path.endsWith('/comment/comment_list')) {
        return json({ errCode: 0, data: { comment: [], downContinueFlag: 0, lastBuff: '' } }, { status: 201 });
      }
      if (path.endsWith('/get-history-msg')) {
        return json({ errCode: 0, data: { msg: [], isContinue: false, cookie: '', baseResp: { errcode: 0 } } }, { status: 201 });
      }
      if (path.endsWith('/get-session-info')) {
        return json({ errCode: 0, data: { sessionInfo: [{
          sessionId: 'dm-session-1', username: 'peer-1', nickname: '客户昵称', headImgUrl: 'https://example.invalid/avatar',
          sessionType: 1, rejectMsg: 0, extInfo: {}, fromUserType: 1,
        }], baseResp: { errcode: 0 } } }, { status: 201 });
      }
      throw new Error(`unexpected path ${path}`);
    }) as typeof fetch,
  });
  assert.deepEqual(await api.listComments(SESSION, 'post-1', null, 20), { items: [], nextCursor: null, hasMore: false });
  assert.deepEqual(await api.listDmSessions(SESSION, null, 20), { items: [], nextCursor: null, hasMore: false });
  assert.deepEqual(await api.getDmParticipantInfo(SESSION, ['dm-session-1']), [{
    sessionExternalId: 'dm-session-1',
    participant: { externalId: 'peer-1', displayName: '客户昵称', avatarUrl: 'https://example.invalid/avatar' },
  }]);
  assert.deepEqual(Object.keys(calls[0].body).filter((key) => !key.startsWith('_') &&
    !['rawKeyBuff', 'timestamp', 'scene', 'reqScene', 'pluginSessionId'].includes(key)).sort(),
  ['commentSelection', 'exportId', 'forMcn', 'lastBuff']);
  assert.equal(calls[0].body.exportId, 'post-1');
  assert.deepEqual(calls.map((call) => call.path), [
    '/micro/interaction/cgi-bin/mmfinderassistant-bin/comment/comment_list',
    '/micro/interaction/cgi-bin/mmfinderassistant-bin/private-msg/get-history-msg',
    '/micro/interaction/cgi-bin/mmfinderassistant-bin/private-msg/get-session-info',
  ]);
  assert.equal(calls[1].body.cookie, '');
  assert.deepEqual(calls[2].body.sessionId, ['dm-session-1']);
});

test('wechat api: non-empty comments preserve reply hierarchy and opaque pagination', async () => {
  const requestCursors: unknown[] = [];
  const api = new WechatChannelsApiClient({
    maxRetries: 0,
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestCursors.push(body.lastBuff);
      return json({ errCode: 0, data: {
        comment: [{
          commentId: 'comment-root', username: 'peer-a', commentNickname: 'Peer A', commentHeadurl: 'https://example.invalid/a',
          commentContent: 'root text', commentCreatetime: '1700000000', commentLikeCount: 2,
          levelTwoComment: [{
            commentId: 'comment-reply', username: 'finder-self', commentNickname: 'Self', commentHeadurl: '',
            commentContent: 'reply text', commentCreatetime: '1700000001', commentLikeCount: 0, levelTwoComment: [],
          }],
        }],
        downContinueFlag: body.lastBuff === '' ? 1 : 0,
        lastBuff: body.lastBuff === '' ? 'comment-cursor-2' : 'terminal-cookie',
      } });
    }) as typeof fetch,
  });
  const first = await api.listComments(SESSION, 'post-1', null, 20);
  assert.equal(first.nextCursor, 'comment-cursor-2');
  assert.equal(first.hasMore, true);
  assert.equal(first.items[0].postExternalId, 'post-1');
  assert.equal(first.items[0].rootExternalId, 'comment-root');
  assert.equal(first.items[0].replies[0].rootExternalId, 'comment-root');
  assert.equal(first.items[0].replies[0].parentExternalId, 'comment-root');
  assert.equal(first.items[0].replies[0].contentText, 'reply text');
  const second = await api.listComments(SESSION, 'post-1', first.nextCursor, 20);
  assert.equal(second.nextCursor, null);
  assert.equal(second.hasMore, false);
  assert.deepEqual(requestCursors, ['', 'comment-cursor-2']);
});

test('wechat api: a visible comment nickname survives a blank platform username via an opaque surrogate', async () => {
  const api = new WechatChannelsApiClient({
    maxRetries: 0,
    fetchImpl: (async () => json({ errCode: 0, data: {
      comment: [{
        commentId: 'comment-anonymous', username: '', commentNickname: '可见昵称',
        commentHeadurl: 'https://example.invalid/anonymous-avatar', commentContent: 'hello',
        commentCreatetime: '1700000000', commentLikeCount: 0, levelTwoComment: [],
      }],
      downContinueFlag: 0,
      lastBuff: '',
    } })) as typeof fetch,
  });

  const page = await api.listComments(SESSION, 'post-1', null, 20);
  assert.equal(page.items[0].participant?.displayName, '可见昵称');
  assert.equal(page.items[0].participant?.avatarUrl, 'https://example.invalid/anonymous-avatar');
  assert.match(page.items[0].participant?.externalId ?? '', /^comment_opaque_[a-f0-9]{64}$/);
  assert.doesNotMatch(page.items[0].participant?.externalId ?? '', /可见昵称|anonymous-avatar|comment-anonymous/);
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

test('wechat api: response limits are transient while real schema failures open only the observed endpoint', async () => {
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
    (error: unknown) => error instanceof WechatChannelsError &&
      error.category === 'transient_network' && error.retryable,
  );
  assert.equal(changed.length, 0);

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
      error.requestDispatched &&
      !error.message.includes('cookie-secret'),
  );
  assert.deepEqual(changed, ['postList']);
});

test('wechat api: an HTTP 200 HTML response is transient and does not open the schema circuit', async () => {
  const changed: WechatChannelsEndpoint[] = [];
  const api = new WechatChannelsApiClient({
    maxRetries: 0,
    onSchemaChanged: (endpoint) => changed.push(endpoint),
    fetchImpl: (async () => new Response('<html>temporary WAF page</html>', { status: 200 })) as typeof fetch,
  });

  await assert.rejects(
    () => api.listPosts(SESSION, null),
    (error: unknown) => error instanceof WechatChannelsError &&
      error.category === 'transient_network' && error.retryable && error.requestDispatched,
  );
  assert.deepEqual(changed, []);
});

test('wechat api: auth/rate errors remain classified and non-empty DMs retain safe message truth', async () => {
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
          { svrMsgId: 'm-1', sessionId: 'thread-1', msgType: 1, fromUsername: 'peer-1', toUsername: 'finder-self', textMsg: { content: 'hello' }, ts: 1_700_000_000 },
          { svrMsgId: 'm-2', sessionId: 'thread-1', msgType: 3, fromUsername: 'finder-self', toUsername: 'peer-1', imgMsg: { url: 'https://example.invalid/image', aeskey: 'must-not-survive', width: 640, height: 480 }, ts: 1_700_000_001 },
          { svrMsgId: 'm-3', sessionId: 'thread-2', msgType: 99, fromUsername: 'peer-2', toUsername: 'finder-self', rawContent: 'must-not-survive', ts: 1_700_000_002 },
        ],
        isContinue: false,
        cookie: 'incremental-cookie',
      },
    })) as typeof fetch,
  });
  const updates = await dmApi.listDmUpdates(SESSION, null, 'finder-self');
  assert.equal(updates.sessions.length, 2);
  assert.equal(updates.messages[0].direction, 'inbound');
  assert.equal(updates.messages[0].contentText, 'hello');
  assert.equal(updates.messages[1].direction, 'outbound');
  assert.deepEqual(updates.messages[1].attachmentMeta, {
    mimeType: null, width: 640, height: 480, url: 'https://example.invalid/image',
  });
  assert.equal(updates.messages[2].messageType, 'unknown');
  assert.equal(updates.messages[2].contentText, null);
  assert.equal(updates.nextCursor, 'incremental-cookie');
  assert.equal(updates.hasMore, false);
  assert.doesNotMatch(JSON.stringify(updates), /aeskey|must-not-survive|rawContent/);
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
      data: { msg: [{ svrMsgId: 'm-1', sessionId: 'thread-1', msgType: 1, textMsg: { content: 'hello' }, ts: 1 }], isContinue: false, cookie: '' },
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
