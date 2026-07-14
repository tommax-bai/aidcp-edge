import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacebookPublishExecutor } from '../../src/facebook/publish-executor.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import type { PublishCommandPayload } from '../../src/comm/protocol.js';

interface Call {
  method: string;
  params?: Record<string, unknown>;
}

class FakeFacebookPublishCdp implements BrowseCdp {
  calls: Call[] = [];
  composerOpen = false;
  editorText = '';
  submitted = false;
  disabledSubmit = false;
  navigatedUrl = '';
  extractPostCalls = 0;
  postAvailableAfterExtractCalls = 1;
  /** 编辑器已全选（fbPublishSelectEditorContents 置位；Backspace 据此整体清空）。 */
  selectedAll = false;
  /** 故障注入：编辑器只吃前 N 个字符（模拟 FB 吞字），其余静默丢弃。 */
  swallowAfterChars: number | null = null;
  /** 故障注入：编辑器拒绝被清空（模拟清场失败）。 */
  refuseClear = false;
  /** 故障注入：打完字后才开始拒绝清空（模拟真脏页）。 */
  refuseClearAfterTyping = false;
  /** 故障注入：打完字后编辑器消失（页面被导航走 / 弹层关闭）。 */
  closeComposerAfterTyping = false;
  /** 故障注入：第 N 个字符之后 Input.insertText 抛错（CDP 命令超时 / 协议错误 / 断连）。 */
  throwOnInsertAfter: number | null = null;
  private typedCount = 0;

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Page.navigate') {
      this.navigatedUrl = String(params?.url ?? '');
      return {} as T;
    }
    if (method === 'Input.insertText') {
      this.selectedAll = false;
      if (this.throwOnInsertAfter !== null && this.typedCount >= this.throwOnInsertAfter) {
        throw new Error('CDP 命令超时: Input.insertText');
      }
      this.typedCount++;
      const swallowed =
        this.swallowAfterChars !== null && Array.from(this.editorText).length >= this.swallowAfterChars;
      if (!swallowed) this.editorText += String(params?.text ?? '');
      if (this.typedCount >= 1 && this.refuseClearAfterTyping) this.refuseClear = true;
      if (this.typedCount >= 1 && this.closeComposerAfterTyping) this.composerOpen = false;
      return {} as T;
    }
    if (method === 'Input.dispatchKeyEvent' && params?.key === 'Backspace') {
      if (params?.type === 'keyDown' && this.selectedAll && !this.refuseClear) this.editorText = '';
      return {} as T;
    }
    if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
      if (!this.composerOpen) {
        this.composerOpen = true;
      } else {
        this.submitted = true;
        this.composerOpen = false;
      }
      return {} as T;
    }
    if (method !== 'Runtime.evaluate') return {} as T;

    const expression = String(params?.expression ?? '');
    if (expression.includes('location.hostname')) {
      return { result: { value: true } } as T;
    }
    if (expression.includes('return JSON.stringify(fbPublishSubmitControl())')) {
      return {
        result: {
          value: JSON.stringify({
            found: true,
            disabled: this.disabledSubmit,
            label: 'Post',
            x: 100,
            y: 120,
          }),
        },
      } as T;
    }
    if (expression.includes('return fbPublishSubmittedSignal()')) {
      return { result: { value: this.submitted } } as T;
    }
    if (expression.includes('return JSON.stringify(fbPublishExtractPost())')) {
      this.extractPostCalls++;
      if (this.extractPostCalls < this.postAvailableAfterExtractCalls) {
        return {
          result: {
            value: JSON.stringify({
              postId: '',
              postUrl: '',
            }),
          },
        } as T;
      }
      return {
        result: {
          value: JSON.stringify({
            postId: 'pfbid123',
            postUrl: 'https://www.facebook.com/me/posts/pfbid123',
          }),
        },
      } as T;
    }
    if (expression.includes('return JSON.stringify(fbPublishEditorText())')) {
      return {
        result: {
          value: JSON.stringify({
            found: this.composerOpen,
            text: this.editorText.replace(/\s+/g, ' ').trim(),
          }),
        },
      } as T;
    }
    if (expression.includes('return JSON.stringify(fbPublishFocusEditor())')) {
      return {
        result: { value: JSON.stringify({ found: this.composerOpen, focused: this.composerOpen }) },
      } as T;
    }
    if (expression.includes('return JSON.stringify(fbPublishSelectEditorContents())')) {
      if (this.composerOpen) this.selectedAll = true;
      return {
        result: { value: JSON.stringify({ found: this.composerOpen, selected: this.composerOpen }) },
      } as T;
    }
    if (expression.includes('return !!fbPublishEditor()')) {
      return { result: { value: this.composerOpen } } as T;
    }
    if (expression.includes('var el = fbPublishComposerTrigger')) {
      return {
        result: {
          value: JSON.stringify({ found: true, x: 100, y: 120 }),
        },
      } as T;
    }
    return { result: { value: false } } as T;
  }
}

const instantSleep = async (_ms: number): Promise<void> => {};

function command(kind: PublishCommandPayload['kind'], params: PublishCommandPayload['params'] = {}, seq = 0): PublishCommandPayload {
  return {
    platform: 'facebook',
    taskId: 'task-fb',
    recordId: 77,
    seq,
    kind,
    params,
  };
}

test('FacebookPublishExecutor: opens composer, fills content, uploads image, submits, and captures post id', async () => {
  const cdp = new FakeFacebookPublishCdp();
  const uploaded: string[] = [];
  const executor = new FacebookPublishExecutor(
    {
      cdp,
      uploader: {
        upload: async (url: string) => {
          uploaded.push(url);
          return { ok: true };
        },
      } as never,
    },
    { sleep: instantSleep, pollMs: 1, settleMs: 0, composerTimeoutMs: 50, submitVerifyTimeoutMs: 50 },
  );

  assert.equal((await executor.dispatch(command('navigate_entry', {}, 0))).ok, true);
  assert.equal(cdp.navigatedUrl, 'https://www.facebook.com/');

  assert.equal((await executor.dispatch(command('select_mode', { value: 'facebook_personal_timeline' }, 1))).ok, true);
  assert.equal(cdp.composerOpen, true);
  assert.equal(
    cdp.calls.some((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mouseReleased'),
    true,
  );

  const content = 'hello facebook';
  const filled = await executor.dispatch(command('fill_field', { fieldType: 'content', value: content }, 2));
  assert.equal(filled.ok, true);
  assert.equal(cdp.editorText, content);
  const textInserts = cdp.calls
    .filter((call) => call.method === 'Input.insertText')
    .map((call) => String(call.params?.text ?? ''));
  assert.equal(textInserts.length, Array.from(content).length);
  assert.equal(textInserts.join(''), content);
  assert.equal(textInserts.some((text) => text === content), false);

  const uploadedResult = await executor.dispatch(command('upload_image', { imageUrl: 'https://cdn.example/one.png' }, 3));
  assert.equal(uploadedResult.ok, true);
  assert.deepEqual(uploaded, ['https://cdn.example/one.png']);

  const submitted = await executor.dispatch(command('submit_publish', {}, 4));
  assert.equal(submitted.ok, true);
  assert.equal(cdp.calls.some((call) => call.method === 'Input.dispatchMouseEvent'), true);

  const capture = await executor.dispatch(command('capture_postId', {}, 5));
  assert.equal(capture.ok, true);
  assert.equal(capture.value, 'pfbid123');
  assert.equal(capture.postUrl, 'https://www.facebook.com/me/posts/pfbid123');
});

test('FacebookPublishExecutor: waits for current-page permalink hydration after submit', async () => {
  const cdp = new FakeFacebookPublishCdp();
  cdp.submitted = true;
  cdp.postAvailableAfterExtractCalls = 3;
  const executor = new FacebookPublishExecutor(
    { cdp },
    { sleep: instantSleep, pollMs: 1, capturePostTimeoutMs: 50 },
  );

  const capture = await executor.dispatch(command('capture_postId', {}, 5));
  assert.equal(capture.ok, true);
  assert.equal(capture.value, 'pfbid123');
  assert.equal(cdp.extractPostCalls, 3);
});

test('FacebookPublishExecutor: disabled submit is an honest failure', async () => {
  const cdp = new FakeFacebookPublishCdp();
  cdp.composerOpen = true;
  cdp.disabledSubmit = true;
  const executor = new FacebookPublishExecutor({ cdp }, { sleep: instantSleep });

  const result = await executor.dispatch(command('submit_publish'));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'submit_control_disabled');
  assert.equal(cdp.submitted, false);
});

/**
 * 假时钟：sleep 推进虚拟墙钟，让「逐字输入撞上预算」这条分支可测。
 * 老用例用的 instantSleep 让墙钟恒为 0——deadline 分支在那种桩下永远走不到。
 */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

async function openComposer(cdp: FakeFacebookPublishCdp, executor: FacebookPublishExecutor): Promise<void> {
  await executor.dispatch(command('select_mode', { value: 'facebook_personal_timeline' }, 1));
  assert.equal(cdp.composerOpen, true);
}

test('FacebookPublishExecutor: 编辑器吞掉正文尾部 → 诚实失败 + 清场，绝不判成功', async () => {
  const cdp = new FakeFacebookPublishCdp();
  const executor = new FacebookPublishExecutor(
    { cdp },
    { sleep: instantSleep, pollMs: 1, composerTimeoutMs: 50, fillVerifyTimeoutMs: 20 },
  );
  await openComposer(cdp, executor);

  const content = '第一句足够长的正文开头，后面这些字会被编辑器吞掉。';
  // 只吃前 12 个字符：老的「前 20 字」探针会把这判成 ok:true 并继续走到提交。
  cdp.swallowAfterChars = 12;

  const filled = await executor.dispatch(command('fill_field', { fieldType: 'content', value: content }, 2));
  assert.equal(filled.ok, false);
  assert.match(String(filled.error), /^content_not_accepted$/);
  assert.equal(cdp.editorText, '', '失败后 composer 必须已清场，不给下一篇留残文');
  assert.equal(cdp.submitted, false);
});

test('FacebookPublishExecutor: 正文打不完预算 → 停手、清场、诚实回报，绝不留孤儿打字循环', async () => {
  const cdp = new FakeFacebookPublishCdp();
  const clock = fakeClock();
  const executor = new FacebookPublishExecutor(
    { cdp },
    { sleep: clock.sleep, now: clock.now, pollMs: 1, composerTimeoutMs: 50_000, fillReserveMs: 1_000 },
  );
  await openComposer(cdp, executor);

  const content = '很长的正文'.repeat(60); // 300 字，按 ~110ms/字远超下面这点预算
  const filled = await executor.dispatch(
    { ...command('fill_field', { fieldType: 'content', value: content }, 2), timeoutMs: 3_000 },
  );

  assert.equal(filled.ok, false);
  assert.match(String(filled.error), /^fill_deadline_exceeded/);
  const typed = cdp.calls.filter((c) => c.method === 'Input.insertText').length;
  assert.ok(typed > 0 && typed < Array.from(content).length, `应打到一半就停手，实际 typed=${typed}`);
  assert.equal(cdp.editorText, '', '放弃后 composer 必须已清场');
  assert.equal(cdp.submitted, false);
});

test('FacebookPublishExecutor: 云端下发的预算够用时，长正文能完整打完并通过全文回读', async () => {
  const cdp = new FakeFacebookPublishCdp();
  const clock = fakeClock();
  const executor = new FacebookPublishExecutor(
    { cdp },
    { sleep: clock.sleep, now: clock.now, pollMs: 1, composerTimeoutMs: 50_000 },
  );
  await openComposer(cdp, executor);

  const content = '很长的正文'.repeat(60);
  const filled = await executor.dispatch(
    { ...command('fill_field', { fieldType: 'content', value: content }, 2), timeoutMs: 20_000 + 300 * 250 },
  );

  assert.equal(filled.ok, true);
  assert.equal(cdp.editorText, content);
});

test('FacebookPublishExecutor: 复用到脏 composer 时先清空再打字，绝不与上一篇残稿拼接', async () => {
  const cdp = new FakeFacebookPublishCdp();
  const executor = new FacebookPublishExecutor(
    { cdp },
    { sleep: instantSleep, pollMs: 1, composerTimeoutMs: 50, fillVerifyTimeoutMs: 20 },
  );
  await openComposer(cdp, executor);
  cdp.editorText = '上一篇失败留下的残稿';

  const content = '这一篇的正文';
  const filled = await executor.dispatch(command('fill_field', { fieldType: 'content', value: content }, 2));

  assert.equal(filled.ok, true);
  assert.equal(cdp.editorText, content, '编辑器里只能有这一篇的正文');
});

test('FacebookPublishExecutor: composer 清不干净 → 诚实失败，绝不在残文之上追加', async () => {
  const cdp = new FakeFacebookPublishCdp();
  const executor = new FacebookPublishExecutor(
    { cdp },
    { sleep: instantSleep, pollMs: 1, composerTimeoutMs: 50, fillVerifyTimeoutMs: 20 },
  );
  await openComposer(cdp, executor);
  cdp.editorText = '清不掉的残稿';
  cdp.refuseClear = true;

  const filled = await executor.dispatch(command('fill_field', { fieldType: 'content', value: '这一篇的正文' }, 2));

  assert.equal(filled.ok, false);
  assert.match(String(filled.error), /^composer_not_clean/);
  assert.equal(cdp.calls.some((c) => c.method === 'Input.insertText'), false, '清不干净就绝不能开始打字');
  assert.equal(cdp.submitted, false);
});

test('FacebookPublishExecutor: 打字途中抛 CDP 异常 → 同样清场并诚实回报，绝不把脏 composer 报成干净失败', async () => {
  const cdp = new FakeFacebookPublishCdp();
  const executor = new FacebookPublishExecutor(
    { cdp },
    { sleep: instantSleep, pollMs: 1, composerTimeoutMs: 50, fillVerifyTimeoutMs: 20 },
  );
  await openComposer(cdp, executor);

  const content = '这是一篇会在打字途中撞上 CDP 命令超时的正文';
  cdp.throwOnInsertAfter = 8; // 打到第 9 个字时 CDP 抛错（命令超时 / 断连）

  const filled = await executor.dispatch(command('fill_field', { fieldType: 'content', value: content }, 2));

  assert.equal(filled.ok, false);
  assert.match(String(filled.error), /^engine_error/);
  assert.equal(/_dirty_composer/.test(String(filled.error)), false, '清得干净就不该标 dirty');
  assert.equal(cdp.editorText, '', '半篇正文必须被清掉，不能留给下一篇拼接');
  assert.equal(cdp.submitted, false);
});

test('FacebookPublishExecutor: 清不干净时标 dirty；编辑器已消失时标 composer_gone（两者不得混为一谈）', async () => {
  const dirty = new FakeFacebookPublishCdp();
  const e1 = new FacebookPublishExecutor({ cdp: dirty }, { sleep: instantSleep, pollMs: 1, composerTimeoutMs: 50, fillVerifyTimeoutMs: 20 });
  await openComposer(dirty, e1);
  dirty.swallowAfterChars = 3;
  dirty.refuseClearAfterTyping = true;
  const r1 = await e1.dispatch(command('fill_field', { fieldType: 'content', value: '一段会被吞掉大半的正文内容' }, 2));
  assert.equal(r1.ok, false);
  assert.match(String(r1.error), /_dirty_composer$/);

  const gone = new FakeFacebookPublishCdp();
  const e2 = new FacebookPublishExecutor({ cdp: gone }, { sleep: instantSleep, pollMs: 1, composerTimeoutMs: 50, fillVerifyTimeoutMs: 20 });
  await openComposer(gone, e2);
  gone.swallowAfterChars = 3;
  gone.closeComposerAfterTyping = true; // 页面被导航走 / 弹层关闭 → 没有残文可留
  const r2 = await e2.dispatch(command('fill_field', { fieldType: 'content', value: '一段会被吞掉大半的正文内容' }, 2));
  assert.equal(r2.ok, false);
  assert.match(String(r2.error), /_composer_gone$/);
});
