import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { JSDOM } from 'jsdom';
import { ImageUploader } from '../../src/flows/image-uploader.js';
import type { FileInputSetter, FileInputSetResult } from '../../src/cdp/file-input-setter.js';
import { TaskTakeoverError, abortForTakeover, type TakeoverCtx } from '../../src/execution/takeover.js';

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
    /** 文件已进上传控件、setFiles 即将返回的那一刻（接管用例在此触发抢占）。 */
    private readonly onSet?: () => void,
  ) {}
  async setFiles(absPaths: string[]): Promise<FileInputSetResult> {
    this.received.push(absPaths);
    this.onSet?.();
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

/** 下载在途（连接/头阶段）时被独占任务接管：请求挂着，由抢占方 abort 掉。 */
const fetchAbortedByTakeover = (controller: AbortController): typeof fetch =>
  ((_url: unknown, opts: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      setTimeout(() => abortForTakeover(controller), 0);
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

test('AC-MEDIA upload 成功 → ok:true，FileInputSetter 收到临时路径，缩略图见，临时文件可配置为立即清理', async () => {
  const d = doc();
  const setter = new FakeFileInputSetter(d, { ok: true }, true);
  const up = makeUploader(d, setter, fetchReturning(PNG), { tempRetainMs: 0 });
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
  const up = makeUploader(d, setter, fetchReturning(PNG), { verifyTimeoutMs: 40, verifyPollMs: 10, tempRetainMs: 0 });
  const r = await up.upload('https://cdn.example.com/a.png');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'image_not_attached', '后置校验须以控件成功态为准，绝不以 files.length 充数');
  // 即便后置校验失败也必须清理临时文件。
  await assert.rejects(access(setter.received[0][0]), '失败路径也必须清理临时文件');
});

// ── 独占任务接管的取消边界（lease-strict-preemption 4.4）──

test('AC-TAKEOVER 下载段被接管 → 抛 TaskTakeoverError（不是 image_fetch_failed / engine_error），零 setFiles、零临时残留', async () => {
  const d = doc();
  const setter = new FakeFileInputSetter(d);
  const controller = new AbortController();
  const prefix = `aidcp-img-takeover-${process.pid}-`;
  const up = makeUploader(d, setter, fetchAbortedByTakeover(controller), {
    tempDirPrefix: prefix,
    // 远大于本用例耗时：结束必须由「接管」触发，绝不能是下载超时把它救回来。
    downloadTimeoutMs: 5_000,
  });
  const ctx: TakeoverCtx = {
    checkpoint: () => {
      if (controller.signal.aborted) throw new TaskTakeoverError();
    },
    signal: controller.signal,
  };

  await assert.rejects(
    up.upload('https://cdn.example.com/a.png', ctx),
    (err: unknown) => {
      // 被接管 ≠「图取不到」：降级成 image_fetch_failed 会让上游换图重试（一条假失败）。
      assert.ok(err instanceof TaskTakeoverError, `接管须原样抛 TaskTakeoverError，实收 ${String(err)}`);
      return true;
    },
    '被接管必须抛出，绝不返回 ok:false 的业务失败',
  );

  assert.equal(setter.received.length, 0, '被接管的下载绝不进文件设置');
  const leftovers = (await readdir(tmpdir())).filter((n) => n.startsWith(prefix));
  assert.deepEqual(leftovers, [], '接管路径不得留临时目录/临时文件');
});

test('🔴 AC-TAKEOVER setFiles 返回后被接管 → 后置校验照跑完（图已交给页面：取消=当没贴过 ⇒ 上游重传 ⇒ 同图双贴）', async () => {
  const d = doc();
  const controller = new AbortController();
  let setFilesDone = false;
  let checkpointsAfterSetFiles = 0;
  // 文件一进上传控件（setFiles 返回的那一刻）就被独占任务接管；页面脚本此时已在异步读 FileList。
  const setter = new FakeFileInputSetter(d, { ok: true }, false, () => {
    setFilesDone = true;
    abortForTakeover(controller);
  });

  let now = 0;
  let sleeps = 0;
  let probes = 0;
  const sleep = async (ms: number): Promise<void> => {
    now += ms;
    sleeps += 1;
    // 平台**真的**把图贴上去了：成功态（缩略图）在接管之后才姗姗出现。
    if (sleeps === 2) {
      const el = d.createElement('div');
      el.setAttribute('data-action-id', 'note.publish_image_thumb');
      d.body.appendChild(el);
    }
  };
  const up = makeUploader(d, setter, fetchReturning(PNG), {
    tempRetainMs: 0,
    verifyTimeoutMs: 60,
    verifyPollMs: 10,
    clock: () => now,
    sleep,
    hasThumbnail: (root: Element | Document) => {
      probes += 1;
      return !!root.querySelector('[data-action-id="note.publish_image_thumb"]');
    },
  });
  const ctx: TakeoverCtx = {
    checkpoint: () => {
      if (setFilesDone) checkpointsAfterSetFiles += 1;
      if (controller.signal.aborted) throw new TaskTakeoverError();
    },
    signal: controller.signal,
  };

  const r = await up.upload('https://cdn.example.com/a.png', ctx);

  assert.equal(setter.received.length, 1, '文件已塞进上传控件（不可逆点已过）');
  assert.equal(checkpointsAfterSetFiles, 0, 'setFiles 之后 MUST NOT 再有取消点（禁区：已提交的写）');
  assert.ok(probes >= 2, '后置校验必须继续轮询到底，不得被接管掐断');
  // 结论来自**真出现的成功态**，不是来自「被接管」——成功态若始终不出现，这里必须是 image_not_attached。
  assert.equal(r.ok, true);
  assert.equal(r.error, undefined);
});

// ── 多环境临时目录隔离（edge-multi-environment-fleet D5）──

test('多环境：tempDirPrefix 注入后下载目录落在本环境命名空间', async () => {
  const d = doc();
  const setter = new FakeFileInputSetter(d, { ok: true }, true);
  const up = makeUploader(d, setter, fetchReturning(PNG), { tempDirPrefix: 'aidcp-img-ads-p1-' });
  const r = await up.upload('https://cdn.example.com/a.png');
  assert.equal(r.ok, true);
  assert.match(setter.received[0][0], /aidcp-img-ads-p1-/, '临时路径必须带本环境命名空间前缀');
});

test('红线回归：启动清扫只清自己命名空间，兄弟环境在途目录不被误删', async () => {
  const { mkdtemp, mkdir, writeFile, access: accessF, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { imageTempPrefixFor, sweepImageTempDirs } = await import('../../src/flows/image-uploader.js');
  // 用独立沙箱 base 目录，避免动真实 tmpdir 里其它进程的文件。
  const base = await mkdtemp(join(tmpdir(), 'aidcp-sweep-test-'));
  try {
    const prefixA = imageTempPrefixFor('ads-envA');
    const prefixB = imageTempPrefixFor('ads-envB');
    const dirA = join(base, `${prefixA}residue`);
    const dirB = join(base, `${prefixB}inflight`);
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirB, 'image.png'), 'in-flight-upload');
    // 环境 A 启动清扫：只清 A 的残留。
    await sweepImageTempDirs(prefixA, base);
    await assert.rejects(accessF(dirA), 'A 自己的残留目录应被清掉');
    await accessF(join(dirB, 'image.png')); // B 的在途上传完好（误删=兄弟发布半截，红线）
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
