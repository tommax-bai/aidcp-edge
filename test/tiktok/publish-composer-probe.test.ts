import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import type { FileInputSetter } from '../../src/cdp/file-input-setter.js';
import {
  TIKTOK_UPLOAD_ENTRY_JS,
  TIKTOK_UPLOAD_PAGE_SNAPSHOT_JS,
  TikTokPublishComposerProbe,
  type TikTokUploadPageSnapshot,
} from '../../src/tiktok/index.js';

function installGeometry(dom: JSDOM): void {
  Object.defineProperty(dom.window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      const raw = (this as HTMLElement).getAttribute('data-rect') ?? '0,0,0,0';
      const [left, top, width, height] = raw.split(',').map(Number);
      return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
    },
  });
}

function evaluate<T>(source: string, html: string, url = 'https://www.tiktok.com/foryou'): T {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  installGeometry(dom);
  return JSON.parse(dom.window.eval(source) as string) as T;
}

function pageSnapshot(overrides: Partial<TikTokUploadPageSnapshot> = {}): TikTokUploadPageSnapshot {
  return {
    host: 'www.tiktok.com',
    path: '/tiktokstudio/upload',
    blockReason: 'none',
    fileInputCount: 1,
    fileInputAccept: 'video/*',
    fileInputMultiple: false,
    fileInputDisabled: false,
    fileInputFilesCount: 0,
    caption: { found: false, ambiguous: false, textLength: null, evidence: null },
    fieldKinds: [],
    previewCount: 0,
    progressCount: 0,
    blockingOverlayVisible: false,
    uploadErrorVisible: false,
    uploadAcknowledged: false,
    composerReady: false,
    ...overrides,
  };
}

interface FakeCall {
  method: string;
  params: Record<string, unknown>;
}

function fakeCdp(snapshots: TikTokUploadPageSnapshot[]): { cdp: BrowseCdp; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let index = 0;
  const cdp: BrowseCdp = {
    send: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression ?? '');
        if (expression.includes('/*aidcp:tiktok-upload-page*/')) {
          const value = snapshots[Math.min(index, snapshots.length - 1)];
          index += 1;
          return { result: { type: 'string', value: JSON.stringify(value) } } as never;
        }
        if (expression.includes('/*aidcp:tiktok-caption-focus*/')) {
          return { result: { type: 'string', value: JSON.stringify({ ok: true }) } } as never;
        }
        if (expression.includes('/*aidcp:tiktok-caption-verify*/')) {
          const input = calls.find((call) => call.method === 'Input.insertText');
          const text = String(input?.params.text ?? '');
          return { result: { type: 'string', value: JSON.stringify({ matches: true, textLength: text.length }) } } as never;
        }
      }
      return {} as never;
    },
  };
  return { cdp, calls };
}

test('upload entry discovery requires one visible TikTok Studio semantic link', () => {
  const ready = evaluate<{ status: string; href?: string; candidateCount: number }>(TIKTOK_UPLOAD_ENTRY_JS, `<!doctype html><body>
    <a data-e2e="nav-upload" href="/tiktokstudio/upload?from=webapp&tab=video" data-rect="20,20,80,40">Upload</a>
  </body>`);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.candidateCount, 1);
  assert.match(ready.href ?? '', /^https:\/\/www\.tiktok\.com\/tiktokstudio\/upload/);

  const ambiguous = evaluate<{ status: string; candidateCount: number }>(TIKTOK_UPLOAD_ENTRY_JS, `<!doctype html><body>
    <a data-e2e="nav-upload" href="/tiktokstudio/upload?tab=video" data-rect="20,20,80,40">Video</a>
    <a href="/tiktokstudio/upload?tab=photo" data-rect="120,20,80,40">Photo</a>
  </body>`);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.candidateCount, 2);
});

test('upload entry discovery blocks a login page before navigation', () => {
  const result = evaluate<{ status: string; blockReason: string }>(TIKTOK_UPLOAD_ENTRY_JS, `<!doctype html><body>
    <input type="password" data-rect="20,20,200,40">
    <a data-e2e="nav-upload" href="/tiktokstudio/upload" data-rect="20,80,80,40">Upload</a>
  </body>`, 'https://www.tiktok.com/login');
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockReason, 'login_required');
});

test('pre-upload snapshot reports one video input without inventing composer readiness', () => {
  const snapshot = evaluate<TikTokUploadPageSnapshot>(TIKTOK_UPLOAD_PAGE_SNAPSHOT_JS, `<!doctype html><body>
    <input type="file" accept="video/*">
    <div data-e2e="select_video_button" data-rect="20,20,160,40">Select video</div>
  </body>`, 'https://www.tiktok.com/tiktokstudio/upload');
  assert.equal(snapshot.blockReason, 'none');
  assert.equal(snapshot.fileInputCount, 1);
  assert.equal(snapshot.fileInputAccept, 'video/*');
  assert.equal(snapshot.caption.found, false);
  assert.equal(snapshot.uploadAcknowledged, false);
  assert.equal(snapshot.composerReady, false);
});

test('post-upload snapshot recognizes one semantic caption and visible preview', () => {
  const snapshot = evaluate<TikTokUploadPageSnapshot>(TIKTOK_UPLOAD_PAGE_SNAPSHOT_JS, `<!doctype html><body>
    <canvas data-rect="20,-200,300,500"></canvas>
    <img src="blob:probe-preview" data-rect="20,-20,120,160">
    <div contenteditable="true" role="combobox" data-rect="360,-40,500,120">probe filename</div>
    <input type="text" role="input" placeholder="Tìm kiếm vị trí" data-rect="360,120,300,40">
  </body>`, 'https://www.tiktok.com/tiktokstudio/upload');
  assert.equal(snapshot.caption.found, true);
  assert.equal(snapshot.caption.ambiguous, false);
  assert.equal(snapshot.previewCount, 2);
  assert.equal(snapshot.uploadAcknowledged, true);
  assert.equal(snapshot.composerReady, true);
});

test('known modal keeps composer not-ready without hiding upload acknowledgement', () => {
  const snapshot = evaluate<TikTokUploadPageSnapshot>(TIKTOK_UPLOAD_PAGE_SNAPSHOT_JS, `<!doctype html><body>
    <canvas data-rect="20,20,300,500"></canvas>
    <div contenteditable="true" role="combobox" data-rect="360,40,500,120">probe filename</div>
    <div role="alertdialog" data-rect="700,200,300,300">Tutorial</div>
  </body>`, 'https://www.tiktok.com/tiktokstudio/upload');
  assert.equal(snapshot.uploadAcknowledged, true);
  assert.equal(snapshot.blockingOverlayVisible, true);
  assert.equal(snapshot.composerReady, false);
});

test('stageFile binds one exact file and waits for composer evidence', async () => {
  const ready = pageSnapshot({
    caption: { found: true, ambiguous: false, textLength: 0, evidence: null },
    previewCount: 1,
    uploadAcknowledged: true,
    composerReady: true,
  });
  const { cdp } = fakeCdp([pageSnapshot(), ready]);
  const paths: string[][] = [];
  const setter: FileInputSetter = { setFiles: async (items) => { paths.push(items); return { ok: true }; } };
  const probe = new TikTokPublishComposerProbe(cdp, { fileInputSetter: setter, sleep: async () => {}, pollMs: 0 });
  const result = await probe.stageFile('/tmp/aidcp-tiktok-probe.mp4');
  assert.equal(result.status, 'upload_acknowledged');
  assert.equal(result.fileSelected, true);
  assert.equal(result.uploadAcknowledged, true);
  assert.equal(result.submitted, false);
  assert.deepEqual(paths, [['/tmp/aidcp-tiktok-probe.mp4']]);
});

test('stageFile refuses ambiguous file inputs without setting a path', async () => {
  const { cdp } = fakeCdp([pageSnapshot({ fileInputCount: 2, fileInputAccept: null })]);
  let setCalls = 0;
  const setter: FileInputSetter = { setFiles: async () => { setCalls += 1; return { ok: true }; } };
  const result = await new TikTokPublishComposerProbe(cdp, { fileInputSetter: setter }).stageFile('/tmp/probe.mp4');
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.executed, false);
  assert.equal(setCalls, 0);
});

test('caption probe replaces the selected editor text and never dispatches a submit action', async () => {
  const ready = pageSnapshot({
    caption: { found: true, ambiguous: false, textLength: 12, evidence: null },
    previewCount: 1,
    uploadAcknowledged: true,
    composerReady: true,
  });
  const { cdp, calls } = fakeCdp([ready]);
  const result = await new TikTokPublishComposerProbe(cdp).fillCaptionDraft('AIDCP TikTok probe');
  assert.equal(result.status, 'composer_ready_not_submitted');
  assert.equal(result.matched, true);
  assert.equal(result.submitted, false);
  assert.equal(calls.filter((call) => call.method === 'Input.insertText').length, 1);
  assert.equal(calls.some((call) => call.method === 'Input.dispatchKeyEvent'), false);
  assert.equal(calls.some((call) => call.method === 'Input.dispatchMouseEvent'), false);
});

test('publish probe sources contain no final-control or form-submit primitive', async () => {
  const modulePath = fileURLToPath(new URL('../../src/tiktok/probes/publish-composer-probe.ts', import.meta.url));
  const runnerPath = fileURLToPath(new URL('../../scripts/tiktok-publish-composer-probe.ts', import.meta.url));
  const [moduleSource, runnerSource] = await Promise.all([readFile(modulePath, 'utf8'), readFile(runnerPath, 'utf8')]);
  const source = `${moduleSource}\n${runnerSource}`;
  assert.doesNotMatch(source, /Input\.dispatchKeyEvent/);
  assert.doesNotMatch(source, /requestSubmit\s*\(/);
  assert.doesNotMatch(source, /\.submit\s*\(/);
  assert.doesNotMatch(source, /querySelector(?:All)?\([^\n]*(?:button|type=["']?submit)/i);
});
