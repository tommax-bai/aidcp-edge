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

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Page.navigate') {
      this.navigatedUrl = String(params?.url ?? '');
      return {} as T;
    }
    if (method === 'Input.insertText') {
      this.editorText += String(params?.text ?? '');
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
    if (expression.includes('fbPublishText(el).indexOf')) {
      const marker = expression.includes('hello facebook') ? 'hello facebook' : '';
      return { result: { value: !!marker && this.editorText.includes(marker) } } as T;
    }
    if (expression.includes('var el = fbPublishEditor()') && expression.includes('el.focus')) {
      return { result: { value: this.composerOpen } } as T;
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
