#!/usr/bin/env node

const port = Number(process.argv[2] ?? 0);
if (!Number.isInteger(port) || port < 1) {
  console.error('usage: capture-wechat-request-shapes.mjs <cdp-port>');
  process.exit(2);
}

const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const page = pages.find((item) => item.type === 'page' && item.url?.startsWith('https://channels.weixin.qq.com/'));
if (!page?.webSocketDebuggerUrl) throw new Error('authorized WeChat Channels page not found');

const socket = new WebSocket(page.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();
const requests = new Map();
const actions = [];

function send(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return depth >= 8 ? ['array'] : value.length ? [shape(value[0], depth + 1)] : [];
  if (typeof value !== 'object') return typeof value;
  if (depth >= 8) return 'object';
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key], depth + 1)]));
}

function bodyShape(postData, contentType) {
  if (!postData) return null;
  try {
    if (contentType.includes('application/json') || /^[\s]*[{[]/.test(postData)) return shape(JSON.parse(postData));
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries([...new URLSearchParams(postData).keys()].sort().map((key) => [key, 'string']));
    }
  } catch {
    return 'unparsed';
  }
  return 'opaque';
}

function requestShape(request) {
  const url = new URL(request.url);
  if (url.hostname !== 'channels.weixin.qq.com' || !url.pathname.includes('/cgi-bin/')) return null;
  const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const contentType = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return {
    evidence: 'observed',
    method: request.method,
    path: url.pathname,
    queryKeys: [...new Set([...url.searchParams.keys()])].sort(),
    contentType: contentType || null,
    bodyShape: bodyShape(request.postData, contentType),
    headerNames: Object.keys(headers).sort(),
    response: null,
  };
}

async function clickKnownNavigation(label, candidates) {
  const result = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const candidates = ${JSON.stringify(candidates)};
      const nodes = [...document.querySelectorAll('a,button,[role="button"],li,div')];
      const exact = nodes.find((node) => candidates.includes((node.textContent || '').trim()));
      if (!exact) return false;
      exact.click();
      return true;
    })()`,
  });
  const clicked = result?.result?.result?.value === true;
  actions.push({ label, clicked });
  if (clicked) await wait(4_000);
}

async function clickFirstSafeRow() {
  const result = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const selectors = ['tbody tr', '[role="row"]'];
      for (const selector of selectors) {
        const rows = [...document.querySelectorAll(selector)].filter((node) => (node.textContent || '').trim());
        if (!rows.length) continue;
        rows[0].click();
        return { clicked: true, selector, count: rows.length };
      }
      return { clicked: false, selector: null, count: 0 };
    })()`,
  });
  const value = result?.result?.result?.value ?? { clicked: false, selector: null, count: 0 };
  actions.push({ label: 'comment_first_row', ...value });
  if (value.clicked) await wait(4_000);
}

socket.addEventListener('message', async (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id) {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message));
    else item.resolve(message);
    return;
  }
  if (message.method === 'Network.requestWillBeSent') {
    const captured = requestShape(message.params.request);
    if (captured) requests.set(message.params.requestId, captured);
  }
  if (message.method === 'Network.responseReceived') {
    const captured = requests.get(message.params.requestId);
    if (captured) captured.response = {
      status: message.params.response.status,
      mimeType: message.params.response.mimeType || null,
      bodyShape: null,
    };
  }
  if (message.method === 'Network.loadingFinished') {
    const captured = requests.get(message.params.requestId);
    if (!captured?.response) return;
    try {
      const body = await send('Network.getResponseBody', { requestId: message.params.requestId });
      if (!body?.result?.base64Encoded) captured.response.bodyShape = shape(JSON.parse(body.result.body));
    } catch {
      captured.response.bodyShape = 'unavailable';
    }
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
await send('Network.enable', { maxPostDataSize: 1_048_576 });
await send('Page.enable');
await send('Runtime.enable');
await send('Page.reload', { ignoreCache: false });
await wait(6_000);
await clickKnownNavigation('comments', ['评论管理', '评论']);
await clickFirstSafeRow();
await clickKnownNavigation('direct_messages', ['私信管理', '私信', '消息管理']);
await wait(4_000);

const unique = new Map();
for (const item of requests.values()) {
  const key = JSON.stringify([item.method, item.path, item.queryKeys, item.contentType, item.bodyShape]);
  if (!unique.has(key)) unique.set(key, item);
}
const currentUrl = new URL(page.url);
console.log(JSON.stringify({
  manifestVersion: 1,
  capturedAt: new Date().toISOString(),
  page: `${currentUrl.origin}${currentUrl.pathname}`,
  evidenceBoundary: 'observed_read_only',
  writesDispatched: false,
  rawHarPersisted: false,
  actions,
  requests: [...unique.values()].sort((a, b) => a.path.localeCompare(b.path)),
}, null, 2));
socket.close();
