/**
 * 验收用例 AC-PUB-N* — Native 发布链的配图取材完整性（边缘侧）
 *
 * 判据来源：change `native-page-engine-production-cutover` 任务 6.5
 *（把既有的发布安全 / 完整性夹具移植到 Native 验收层）。
 *
 * 为什么这几条属于**验收层**而不是普通单测：它们守的是「哪些字节会被发到社交平台上」。
 * 与 `AC-PUB-*` 的授权红线是同一族——那一族守「未获授权绝不发布」，这一族守
 * 「即使已授权，也只发本来该发的那份内容」。两族一起才构成完整的发布红线。
 *
 * 链路事实（`src/native-page-engine/publish.ts`）：引擎侧的 `validate_publish_file` 只按
 * **扩展名 + 绝对路径 + 普通文件 + 体积**放行，而那个扩展名是**宿主按字节内容嗅探后自己写下的**，
 * 不是调用方给的。所以整条链的安全性取决于宿主这一段，而它此前**一条用例都没有**：
 * 既有的 `test/native-page-engine/publish-executor.test.ts` 覆盖的是上传顺序与封面绑定。
 *
 * 五条不变量：
 *   ① 只走 https —— 这是挡住「把本机任意文件发出去」的那道闸（file: / http: / data: 一律拒）；
 *   ② 不跟随重定向 —— 否则第 ① 条可以被一次 302 绕过；
 *   ③ 体积上限查两次 —— 声明的 content-length 会撒谎，实际流也必须查；
 *   ④ 扩展名只由字节内容决定 —— 认不出格式就诚实拒绝，绝不回落成某个默认扩展名；
 *   ⑤ 以上任一不通过时，**引擎侧一条命令都不下发**。
 *
 * 环境层级：离线 / 逻辑级（fetch 为注入桩、运行时为断言桩，不碰网络，只写系统临时目录）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PublishCommandPayload } from '../../src/comm/protocol.js';
import type { NativePageCommand } from '../../src/native-page-engine/client.js';
import { NativePublishExecutor } from '../../src/native-page-engine/publish.js';
import type { NativePageRuntime } from '../../src/native-page-engine/runtime.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const NOT_AN_IMAGE = Buffer.from('#!/bin/sh\necho hi\n', 'utf8');

function uploadCommand(imageUrl: string, seq = 1): PublishCommandPayload {
  return {
    taskId: 'task-acceptance',
    recordId: 1,
    seq,
    kind: 'upload_image',
    params: { imageUrl },
  };
}

/** 只要引擎侧被下发了任何一条命令就当场失败：拒绝路径必须在下发之前收口。 */
function refusingRuntime(dispatched: NativePageCommand[]): NativePageRuntime {
  return {
    execute: async (_owner: string, nativeCommand: NativePageCommand) => {
      dispatched.push(nativeCommand);
      return {
        effectPhase: 'confirmed' as const,
        output: { kind: 'publish_receipt', value: { ok: true } },
      };
    },
  } as unknown as NativePageRuntime;
}

async function withFetch<T>(
  impl: typeof globalThis.fetch,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

/** Buffer 直接交给 Response 在当前 lib 定义下不满足 BodyInit，统一转成拥有独立 ArrayBuffer 的视图。 */
function body(bytes: Buffer): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

function respond(bytes: Buffer, headers: Record<string, string> = {}): Response {
  return new Response(body(bytes), {
    status: 200,
    headers: { 'content-length': String(bytes.length), ...headers },
  });
}

describe('AC-PUB-N Native 发布配图取材完整性（edge）', () => {
  it('AC-PUB-N01 非 https 取材一律拒绝，且一次网络都不发、一条命令都不下发', async () => {
    // 这是整条链最要紧的一格：它挡住的是「把本机任意文件当配图发出去」。
    const rejected = [
      'file:///etc/passwd',
      'file:///Users/someone/.ssh/id_rsa',
      'http://cdn.test/one.png',
      'data:image/png;base64,iVBORw0KGgo=',
      'ftp://cdn.test/one.png',
    ];
    for (const imageUrl of rejected) {
      const dispatched: NativePageCommand[] = [];
      let fetches = 0;
      const result = await withFetch(
        async () => {
          fetches += 1;
          return respond(PNG);
        },
        async () => {
          const executor = new NativePublishExecutor(refusingRuntime(dispatched), 'aidcp-ac-pub-n-');
          return executor.dispatch(uploadCommand(imageUrl), 'xiaohongshu');
        },
      );
      assert.equal(result.ok, false, `${imageUrl} 必须被拒`);
      assert.equal(result.error, 'image_url_rejected', `${imageUrl} 的拒因必须可区分`);
      assert.equal(fetches, 0, `${imageUrl} 不该发起任何取材请求`);
      assert.equal(dispatched.length, 0, `${imageUrl} 不该向引擎下发任何命令`);
    }
  });

  it('AC-PUB-N02 无法解析的地址同样是可区分的拒绝，不落到通用失败里', async () => {
    const dispatched: NativePageCommand[] = [];
    const result = await withFetch(
      async () => { throw new Error('must not fetch'); },
      async () => new NativePublishExecutor(refusingRuntime(dispatched), 'aidcp-ac-pub-n-')
        .dispatch(uploadCommand('not a url at all'), 'xiaohongshu'),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'image_url_rejected');
    assert.equal(dispatched.length, 0);
  });

  it('AC-PUB-N03 取材不跟随重定向 —— 否则一次 302 就能绕开 https 那道闸', async () => {
    let sawRedirectError = false;
    const dispatched: NativePageCommand[] = [];
    const result = await withFetch(
      async (_input, init) => {
        // 实现必须显式要求「遇重定向即报错」；这里把该约定断言出来，
        // 因为它是 N01 能成立的前提：跟随重定向的话，https 起手也能落到别的协议或内网地址上。
        assert.equal((init as RequestInit | undefined)?.redirect, 'error', 'fetch 必须以 redirect:error 发起');
        sawRedirectError = true;
        throw new TypeError('redirect not allowed');
      },
      async () => new NativePublishExecutor(refusingRuntime(dispatched), 'aidcp-ac-pub-n-')
        .dispatch(uploadCommand('https://cdn.test/redirects.png'), 'xiaohongshu'),
    );
    assert.equal(sawRedirectError, true);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'image_fetch_failed');
    assert.equal(dispatched.length, 0);
  });

  it('AC-PUB-N04 认不出格式就诚实拒绝，绝不回落成某个默认扩展名', async () => {
    // 引擎侧只按扩展名放行，而扩展名由这一步的字节嗅探决定。
    // 一旦这里给了兜底扩展名，引擎那道闸就等于形同虚设 —— 任意字节都能拿到一张通行证。
    const dispatched: NativePageCommand[] = [];
    const result = await withFetch(
      async () => respond(NOT_AN_IMAGE),
      async () => new NativePublishExecutor(refusingRuntime(dispatched), 'aidcp-ac-pub-n-')
        .dispatch(uploadCommand('https://cdn.test/script.png'), 'xiaohongshu'),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'image_format_unsupported');
    assert.equal(dispatched.length, 0, '格式不通过时不得向引擎下发上传命令');
  });

  it('AC-PUB-N05 扩展名取自字节内容，不取自地址 —— 地址说 png、字节是 jpg 时按字节走', async () => {
    const dispatched: NativePageCommand[] = [];
    const result = await withFetch(
      async () => respond(JPG),
      async () => new NativePublishExecutor(refusingRuntime(dispatched), 'aidcp-ac-pub-n-')
        .dispatch(uploadCommand('https://cdn.test/lies-about-being.png'), 'xiaohongshu'),
    );
    assert.equal(result.ok, true);
    assert.equal(dispatched.length, 1);
    const path = String(dispatched[0]?.params.path ?? '');
    assert.ok(path.endsWith('.jpg'), `落盘文件应按字节判成 .jpg，实际=${path}`);
    assert.ok(!path.endsWith('.png'), '不得沿用地址里的扩展名');
    // 交给引擎的必须是宿主自己落盘的绝对路径，不是调用方给的任何东西。
    assert.ok(path.startsWith('/'), '交给引擎的必须是绝对路径');
    assert.ok(!path.includes('cdn.test'), '交给引擎的路径不得由调用方地址拼出');
  });

  it('AC-PUB-N06 体积上限查两次：声明值撒谎时按实际流量拦下', async () => {
    const oversize = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024, 7)]);

    // ① 声明值本身超限 —— 连body 都不该读。
    const declaredOnly: NativePageCommand[] = [];
    const byDeclared = await withFetch(
      async () => new Response(body(PNG), {
        status: 200,
        headers: { 'content-length': String(64 * 1024 * 1024) },
      }),
      async () => new NativePublishExecutor(refusingRuntime(declaredOnly), 'aidcp-ac-pub-n-')
        .dispatch(uploadCommand('https://cdn.test/huge.png'), 'xiaohongshu'),
    );
    assert.equal(byDeclared.ok, false);
    assert.equal(byDeclared.error, 'image_too_large');
    assert.equal(declaredOnly.length, 0);

    // ② 声明值撒谎（报一个小数字，实际很大）—— 只信声明值就会把 11MB 落盘并发出去。
    const dispatched: NativePageCommand[] = [];
    const byActual = await withFetch(
      async () => new Response(body(oversize), {
        status: 200,
        headers: { 'content-length': '10' },
      }),
      async () => new NativePublishExecutor(refusingRuntime(dispatched), 'aidcp-ac-pub-n-')
        .dispatch(uploadCommand('https://cdn.test/lies-about-size.png'), 'xiaohongshu'),
    );
    assert.equal(byActual.ok, false, '声明值撒谎时必须按实际流量拦下');
    assert.equal(byActual.error, 'image_too_large');
    assert.equal(dispatched.length, 0);
  });

  it('AC-PUB-N07 取材失败不产生任何引擎侧动作，拒因逐条可区分', async () => {
    // 「都失败了」不够：上游要靠拒因区分「换一张图重试」与「这条链本身配错了」。
    const dispatched: NativePageCommand[] = [];
    const notOk = await withFetch(
      async () => new Response('nope', { status: 404 }),
      async () => new NativePublishExecutor(refusingRuntime(dispatched), 'aidcp-ac-pub-n-')
        .dispatch(uploadCommand('https://cdn.test/missing.png'), 'xiaohongshu'),
    );
    assert.equal(notOk.ok, false);
    assert.equal(notOk.error, 'image_fetch_failed');
    assert.equal(dispatched.length, 0);

    const reasons = new Set(['image_url_rejected', 'image_fetch_failed', 'image_too_large', 'image_format_unsupported']);
    assert.equal(reasons.size, 4, '四类拒因必须互不相同，不得合并成一个通用失败');
  });
});
