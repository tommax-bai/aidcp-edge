import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { ImageUploader } from '../../src/flows/image-uploader.js';
import type { FileInputSetter, FileInputSetResult } from '../../src/cdp/file-input-setter.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const NOT_IMAGE = new Uint8Array([0x68, 0x69, 0x21, 0x21, 0x21, 0x21]); // "hi!!!!"

function doc(): Document {
  return new JSDOM('<!doctype html><html><body></body></html>').window.document;
}

/** 注入式文件设置桩：替整段 locate+set；成功时按需向 jsdom 注入缩略图（让后置校验通过）。 */
class FakeFileInputSetter implements FileInputSetter {
  public received: string[][] = [];
  constructor(
    private readonly document: Document,
    private readonly result: FileInputSetResult = { ok: true },
    private readonly injectThumb = true,
  ) {}
  async setFiles(absPaths: string[]): Promise<FileInputSetResult> {
    this.received.push(absPaths);
    if (this.result.ok && this.injectThumb) {
      const el = this.document.createElement('div');
      el.setAttribute('data-action-id', 'note.publish_image_thumb');
      this.document.body.appendChild(el);
    }
    return this.result;
  }
}

const fetchReturning = (bytes: Uint8Array, headers: Record<string, string> = {}): typeof fetch =>
  ((_url: unknown, _opts: unknown) =>
    Promise.resolve(new Response(bytes as unknown as BodyInit, { status: 200, headers }))) as unknown as typeof fetch;

const fetchHanging = (): typeof fetch =>
  ((_url: unknown, opts: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;

/** headers 立即返回 200，但 body 永不产出（半开/涓流）；signal 不绑定到此流（模拟非原生 Response）。 */
const fetchStallingBody = (): typeof fetch =>
  ((_url: unknown, _opts: unknown) => {
    const body = new ReadableStream<Uint8Array>({
      start() {
        /* 永不 enqueue、永不 close */
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as unknown as typeof fetch;

function makeUploader(d: Document, setter: FileInputSetter, fetchImpl: typeof fetch, over = {}) {
  return new ImageUploader({
    fileInputSetter: setter,
    dom: { getRoot: () => d },
    fetchImpl,
    verifyTimeoutMs: 60,
    verifyPollMs: 10,
    downloadTimeoutMs: 50,
    ...over,
  });
}

test('AC-MEDIA upload 成功 → ok:true，FileInputSetter 收到临时路径，缩略图见，临时文件已清理', async () => {
  const d = doc();
  const setter = new FakeFileInputSetter(d, { ok: true }, true);
  const up = makeUploader(d, setter, fetchReturning(PNG));
  const r = await up.upload('https://cdn.example.com/a.png');
  assert.equal(r.ok, true);
  assert.equal(setter.received.length, 1, 'setFiles 被调用一次');
  const tmpPath = setter.received[0][0];
  assert.match(tmpPath, /aidcp-img-/, '用专用前缀临时目录');
  // finally 清理：临时文件应已不存在。
  await assert.rejects(access(tmpPath), '上传后临时文件必须清理');
});

test('AC-MEDIA 非 https URL → image_url_rejected（不下载、不设文件）', async () => {
  const d = doc();
  const setter = new FakeFileInputSetter(d);
  const up = makeUploader(d, setter, fetchReturning(PNG));
  for (const bad of ['file:///etc/passwd', 'data:image/png;base64,xxxx', 'not a url']) {
    const r = await up.upload(bad);
    assert.equal(r.ok, false, `${bad} 应拒`);
    assert.equal(r.error, 'image_url_rejected');
  }
  assert.equal(setter.received.length, 0, '拒绝的 URL 绝不进文件设置');
});

test('AC-MEDIA 下载超时 → image_fetch_failed（不假成功）', async () => {
  const d = doc();
  const setter = new FakeFileInputSetter(d);
  const up = makeUploader(d, setter, fetchHanging(), { downloadTimeoutMs: 20 });
  const r = await up.upload('https://cdn.example.com/slow.png');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'image_fetch_failed');
  assert.equal(setter.received.length, 0);
});

test('AC-MEDIA body 半开/涓流 → 超时按 image_fetch_failed（deadline 覆盖 body 流读，不挂死）', async () => {
  const d = doc();
  const setter = new FakeFileInputSetter(d);
  const up = makeUploader(d, setter, fetchStallingBody(), { downloadTimeoutMs: 30 });
  const start = Date.now();
  const r = await up.upload('https://cdn.example.com/trickle.png');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'image_fetch_failed', 'body 流读须被 deadline 抢断');
  assert.ok(Date.now() - start < 2000, '必须在下载超时内返回，不得挂到云端超时');
  assert.equal(setter.received.length, 0, 'body 未读完绝不进文件设置');
});

test('AC-MEDIA 非图字节 → image_format_unsupported（magic-byte 判定，不信扩展名）', async () => {
  const d = doc();
  const setter = new FakeFileInputSetter(d);
  const up = makeUploader(d, setter, fetchReturning(NOT_IMAGE));
  const r = await up.upload('https://cdn.example.com/evil.png');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'image_format_unsupported');
  assert.equal(setter.received.length, 0, '非图绝不喂给文件输入');
});

test('AC-MEDIA 超大图 → image_too_large（流式累计上限，防 Content-Length 说谎）', async () => {
  const d = doc();
  const setter = new FakeFileInputSetter(d);
  const big = new Uint8Array(40);
  big.set(PNG, 0);
  const up = makeUploader(d, setter, fetchReturning(big), { maxBytes: 10 });
  const r = await up.upload('https://cdn.example.com/huge.png');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'image_too_large');
  assert.equal(setter.received.length, 0);
});

test('AC-MEDIA 文件输入定位不到 → no_target（来自 setter；不假成功）', async () => {
  const d = doc();
  const setter = new FakeFileInputSetter(d, { ok: false, error: 'no_target' });
  const up = makeUploader(d, setter, fetchReturning(PNG));
  const r = await up.upload('https://cdn.example.com/a.png');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_target');
});

test('AC-MEDIA 红线反例：设了 files 但无缩略图（成功态缺）→ image_not_attached（files.length 不算成功）', async () => {
  const d = doc();
  // setter 成功但 injectThumb=false：files 设了，但控件成功态从不出现。
  const setter = new FakeFileInputSetter(d, { ok: true }, false);
  const up = makeUploader(d, setter, fetchReturning(PNG), { verifyTimeoutMs: 40, verifyPollMs: 10 });
  const r = await up.upload('https://cdn.example.com/a.png');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'image_not_attached', '后置校验须以控件成功态为准，绝不以 files.length 充数');
  // 即便后置校验失败也必须清理临时文件。
  await assert.rejects(access(setter.received[0][0]), '失败路径也必须清理临时文件');
});
