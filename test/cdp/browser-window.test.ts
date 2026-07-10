import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  applyBrowserParking,
  browserParkingConfigFromEnv,
  createBrowserPersonaNoticeController,
  setBrowserPersonaNotice,
  showBrowserWindow,
} from '../../src/cdp/index.js';

function fakeCdp(probes: Array<{ hidden: boolean; visibility: string; w: number; h: number }>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Browser.setWindowBounds') return {};
      if (method === 'Runtime.evaluate') return { result: { value: probes.shift() } };
      return {};
    },
  };
  return { cdp: cdp as never, calls };
}

const env = {
  AIDCP_BROWSER_PARKING_MODE: 'offscreen',
  AIDCP_BROWSER_PARKING_EFFECTIVE_MODE: 'offscreen',
  AIDCP_BROWSER_PARKING_BOUNDS: JSON.stringify({ left: 2000, top: 0, width: 1440, height: 980 }),
  AIDCP_BROWSER_PARKING_FALLBACK_BOUNDS: JSON.stringify({ left: 1902, top: 0, width: 1440, height: 980 }),
  AIDCP_BROWSER_PARKING_VISIBLE_BOUNDS: JSON.stringify({ left: 80, top: 60, width: 1440, height: 980 }),
};

test('browserParkingConfigFromEnv parses valid config', () => {
  const cfg = browserParkingConfigFromEnv(env);
  assert.equal(cfg?.mode, 'offscreen');
  assert.equal(cfg?.bounds.left, 2000);
});

test('applyBrowserParking keeps configured bounds when visibility is valid', async () => {
  const cfg = browserParkingConfigFromEnv(env);
  const page = fakeCdp([{ hidden: false, visibility: 'visible', w: 1280, h: 720 }]);
  await applyBrowserParking(page.cdp, cfg, () => undefined);
  const sets = page.calls.filter((c) => c.method === 'Browser.setWindowBounds');
  assert.equal(sets.length, 1);
  assert.deepEqual((sets[0].params.bounds as Record<string, unknown>).left, 2000);
});

test('applyBrowserParking falls back when hidden after first placement', async () => {
  const cfg = browserParkingConfigFromEnv(env);
  const page = fakeCdp([
    { hidden: true, visibility: 'hidden', w: 1280, h: 720 },
    { hidden: false, visibility: 'visible', w: 1280, h: 720 },
  ]);
  await applyBrowserParking(page.cdp, cfg, () => undefined);
  const sets = page.calls.filter((c) => c.method === 'Browser.setWindowBounds');
  assert.equal(sets.length, 2);
  assert.deepEqual((sets[1].params.bounds as Record<string, unknown>).left, 1902);
});

test('showBrowserWindow moves to visible bounds', async () => {
  const cfg = browserParkingConfigFromEnv(env);
  const page = fakeCdp([]);
  await showBrowserWindow(page.cdp, cfg, () => undefined);
  const set = page.calls.find((c) => c.method === 'Browser.setWindowBounds');
  assert.deepEqual((set?.params.bounds as Record<string, unknown>).left, 80);
});

function noticeCdp(dom: JSDOM) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  const cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        return { result: { value: dom.window.eval(String(params.expression || '')) } };
      }
      return {};
    },
    on: (method: string, listener: (params: unknown) => void) => {
      let set = listeners.get(method);
      if (!set) {
        set = new Set();
        listeners.set(method, set);
      }
      set.add(listener);
      return () => set!.delete(listener);
    },
  };
  return {
    cdp: cdp as never,
    calls,
    emit(method: string, params: unknown = {}) {
      for (const listener of listeners.get(method) || []) listener(params);
    },
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('browser persona notice is isolated in Shadow DOM, dismissible, and removable', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main id="site-owned">site content</main></body></html>', { runScripts: 'outside-only' });
  const page = noticeCdp(dom);
  await setBrowserPersonaNotice(page.cdp, { active: true, accountLabel: '招聘账号 A' });

  const site = dom.window.document.querySelector('#site-owned');
  const host = dom.window.document.querySelector('#__aidcp_persona_notice_host__') as HTMLElement;
  assert.equal(site?.textContent, 'site content', 'site-owned DOM must remain unchanged');
  assert.ok(host, 'AIDCP host should be present');
  assert.equal(host.textContent, '', 'reminder copy must not leak into light DOM');
  assert.match(host.shadowRoot?.textContent || '', /招聘账号 A/);
  assert.match(host.shadowRoot?.textContent || '', /回到 AIDCP 客户端/);

  (host.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
  assert.equal(dom.window.document.querySelector('#__aidcp_persona_notice_host__'), null, 'dismiss removes only the current host');

  await setBrowserPersonaNotice(page.cdp, { active: true, accountLabel: '招聘账号 A' });
  await setBrowserPersonaNotice(page.cdp, { active: false });
  assert.equal(dom.window.document.querySelector('#__aidcp_persona_notice_host__'), null, 'inactive state removes the host');
});

test('browser persona notice controller reapplies after top-frame navigation and reconnect only while active', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const page = noticeCdp(dom);
  const controller = createBrowserPersonaNoticeController(page.cdp, () => undefined);
  await controller.update({ active: true, accountLabel: '环境 A' });
  const evaluateCount = () => page.calls.filter((call) => call.method === 'Runtime.evaluate').length;
  assert.equal(evaluateCount(), 1);

  page.emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'top' } });
  await flush();
  assert.equal(evaluateCount(), 1, 'subframe navigation must not reapply the top-level notice');

  dom.window.document.querySelector('#__aidcp_persona_notice_host__')?.remove();
  page.emit('Page.frameNavigated', { frame: { id: 'top' } });
  await flush();
  assert.equal(evaluateCount(), 2);
  assert.ok(dom.window.document.querySelector('#__aidcp_persona_notice_host__'));

  page.emit('cdp.reconnected');
  await flush();
  assert.equal(evaluateCount(), 3);

  await controller.update({ active: false });
  assert.equal(evaluateCount(), 4);
  page.emit('Page.frameNavigated', { frame: { id: 'top-2' } });
  await flush();
  assert.equal(evaluateCount(), 4, 'inactive notice must not reappear after navigation');
  controller.dispose();
});
