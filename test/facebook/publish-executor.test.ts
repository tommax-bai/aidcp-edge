import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacebookPublishExecutor } from '../../src/facebook/publish-executor.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import type { PublishCommandPayload } from '../../src/comm/protocol.js';
import { TaskTakeoverError, type TakeoverCtx } from '../../src/execution/takeover.js';

interface Call {
  method: string;
  params?: Record<string, unknown>;
}

class FakeFacebookPublishCdp implements BrowseCdp {
  calls: Call[] = [];
  composerOpen = false;
  openComposerOnClick = true;
  editorReadyAfterChecks = 0;
  editorReadyChecks = 0;
  composerClickDispatched = false;
  editorText = '';
  submitted = false;
  /** 故障注入：点击照发（submitted 可为 true）但 fbPublishSubmittedSignal 恒回 false → 复现「已点未确认」post_validate_failed。 */
  reportSubmitSignal = true;
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
  href = 'https://www.facebook.com/';
  readyState = 'complete';
  mainVisible = true;
  blockingDialog = false;
  credentialInput = false;
  pageStates: Array<Partial<{
    href: string;
    readyState: string;
    mainVisible: boolean;
    blockingDialog: boolean;
    credentialInput: boolean;
  }>> = [];
  pageStateProbeFailures = 0;
  pageStateReads = 0;
  composerProbeCalls = 0;
  triggerAvailableAfterProbe = 1;
  private typedCount = 0;

  private nextPageState(): {
    href: string;
    readyState: string;
    mainVisible: boolean;
    editorReady: boolean;
    blockingDialog: boolean;
    credentialInput: boolean;
  } {
    const scripted = this.pageStates.length > 0
      ? this.pageStates[Math.min(this.pageStateReads, this.pageStates.length - 1)]
      : {};
    this.pageStateReads += 1;
    return {
      href: scripted.href ?? this.href,
      readyState: scripted.readyState ?? this.readyState,
      mainVisible: scripted.mainVisible ?? this.mainVisible,
      editorReady: this.composerOpen,
      blockingDialog: scripted.blockingDialog ?? this.blockingDialog,
      credentialInput: scripted.credentialInput ?? this.credentialInput,
    };
  }

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
        this.composerClickDispatched = true;
        if (this.openComposerOnClick && this.editorReadyAfterChecks === 0) this.composerOpen = true;
      } else {
        this.submitted = true;
        this.composerOpen = false;
      }
      return {} as T;
    }
    if (method !== 'Runtime.evaluate') return {} as T;

    const expression = String(params?.expression ?? '');
    if (expression.includes('var state = fbPublishPageState(); var el = fbPublishComposerTrigger();')) {
      this.composerProbeCalls += 1;
      const state = this.nextPageState();
      const found = this.composerProbeCalls >= this.triggerAvailableAfterProbe;
      return {
        result: {
          value: JSON.stringify({
            ...state,
            found,
            x: found ? 100 : null,
            y: found ? 120 : null,
          }),
        },
      } as T;
    }
    if (expression.includes('return JSON.stringify(fbPublishPageState())')) {
      if (this.pageStateProbeFailures > 0) {
        this.pageStateProbeFailures -= 1;
        throw new Error('Execution context was destroyed');
      }
      return { result: { value: JSON.stringify(this.nextPageState()) } } as T;
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
      return { result: { value: this.submitted && this.reportSubmitSignal } } as T;
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
      if (this.composerClickDispatched && this.openComposerOnClick && !this.composerOpen) {
        this.editorReadyChecks += 1;
        if (this.editorReadyChecks >= this.editorReadyAfterChecks) this.composerOpen = true;
      }
      return { result: { value: this.composerOpen } } as T;
    }
    return { result: { value: false } } as T;
  }
}

const instantSleep = async (_ms: number): Promise<void> => {};

function command(kind: PublishCommandPayload['kind'], params: PublishCommandPayload['params'] = {}, seq = 0): PublishCommandPayload {
  return {
    taskId: 'task-fb',
    recordId: 77,
    seq,
    kind,
    params,
  };
}

function releasedClickCount(cdp: FakeFacebookPublishCdp): number {
  return cdp.calls.filter(
    (call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mouseReleased',
  ).length;
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
    { sleep: instantSleep, pollMs: 1, navigationTimeoutMs: 50, composerTimeoutMs: 1_000, submitVerifyTimeoutMs: 50 },
  );

  assert.equal((await executor.dispatch(command('navigate_entry', {}, 0))).ok, true);
  assert.equal(cdp.navigatedUrl, 'https://www.facebook.com/');

  assert.equal((await executor.dispatch(command('select_mode', { optionKind: 'target', optionValue: 'facebook_personal_timeline' }, 1))).ok, true);
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

test('FacebookPublishExecutor: navigate waits for same-origin group page to become a ready home page', async () => {
  const cdp = new FakeFacebookPublishCdp();
  cdp.pageStates = [
    { href: 'https://www.facebook.com/groups/123', readyState: 'complete', mainVisible: true },
    { href: 'https://www.facebook.com/', readyState: 'loading', mainVisible: false },
    { href: 'https://www.facebook.com/', readyState: 'complete', mainVisible: true },
  ];
  const clock = fakeClock();
  const logs: string[] = [];
  const executor = new FacebookPublishExecutor(
    { cdp, logger: (message) => logs.push(message) },
    { sleep: clock.sleep, now: clock.now, pollMs: 100, navigationTimeoutMs: 1_000 },
  );

  const result = await executor.dispatch(command('navigate_entry'));

  assert.equal(result.ok, true);
  assert.equal(cdp.pageStateReads, 3);
  assert.equal(releasedClickCount(cdp), 0);
  assert.match(logs.at(-1) ?? '', /stage=navigate surface=home path=\/ attempts=3 elapsedMs=200/);
});

test('FacebookPublishExecutor: navigate does not accept a same-origin group page as home', async () => {
  const cdp = new FakeFacebookPublishCdp();
  cdp.pageStates = [
    { href: 'https://www.facebook.com/groups/123?secret=must-not-log', readyState: 'complete', mainVisible: true },
  ];
  const clock = fakeClock();
  const logs: string[] = [];
  const executor = new FacebookPublishExecutor(
    { cdp, logger: (message) => logs.push(message) },
    { sleep: clock.sleep, now: clock.now, pollMs: 100, navigationTimeoutMs: 500 },
  );

  const result = await executor.dispatch(command('navigate_entry'));

  assert.equal(result.ok, false);
  assert.equal(result.error, 'home_not_reached');
  assert.equal(releasedClickCount(cdp), 0);
  assert.equal(logs.some((message) => message.includes('must-not-log')), false);
  assert.match(logs.at(-1) ?? '', /surface=group path=\/groups\/123/);
});

test('FacebookPublishExecutor: navigate tolerates transient page-probe context loss', async () => {
  const cdp = new FakeFacebookPublishCdp();
  cdp.pageStateProbeFailures = 2;
  const clock = fakeClock();
  const executor = new FacebookPublishExecutor(
    { cdp },
    { sleep: clock.sleep, now: clock.now, pollMs: 100, navigationTimeoutMs: 1_000 },
  );

  const result = await executor.dispatch(command('navigate_entry'));

  assert.equal(result.ok, true);
  assert.equal(clock.now(), 200);
});

test('FacebookPublishExecutor: navigate reports nav_error when every page probe fails', async () => {
  const cdp = new FakeFacebookPublishCdp();
  cdp.pageStateProbeFailures = Number.POSITIVE_INFINITY;
  const clock = fakeClock();
  const executor = new FacebookPublishExecutor(
    { cdp },
    { sleep: clock.sleep, now: clock.now, pollMs: 100, navigationTimeoutMs: 300 },
  );

  const result = await executor.dispatch(command('navigate_entry'));

  assert.equal(result.ok, false);
  assert.match(String(result.error), /^nav_error: Execution context was destroyed$/);
});

for (const scenario of [
  {
    name: 'login page',
    state: { href: 'https://www.facebook.com/login/', credentialInput: true },
    error: 'login_required',
  },
  {
    name: 'checkpoint page',
    state: { href: 'https://www.facebook.com/checkpoint/123' },
    error: 'checkpoint_detected',
  },
  {
    name: 'blocking dialog',
    state: { href: 'https://www.facebook.com/', blockingDialog: true },
    error: 'blocked_dialog',
  },
] as const) {
  test(`FacebookPublishExecutor: navigate classifies ${scenario.name}`, async () => {
    const cdp = new FakeFacebookPublishCdp();
    cdp.pageStates = [{ readyState: 'complete', mainVisible: true, ...scenario.state }];
    const clock = fakeClock();
    const executor = new FacebookPublishExecutor(
      { cdp },
      { sleep: clock.sleep, now: clock.now, pollMs: 100, navigationTimeoutMs: 200 },
    );

    const result = await executor.dispatch(command('navigate_entry'));

    assert.equal(result.ok, false);
    assert.equal(result.error, scenario.error);
    assert.equal(releasedClickCount(cdp), 0);
  });
}

test('FacebookPublishExecutor: select_mode waits for a late home composer trigger and clicks exactly once', async () => {
  const cdp = new FakeFacebookPublishCdp();
  cdp.triggerAvailableAfterProbe = 4;
  const clock = fakeClock();
  const executor = new FacebookPublishExecutor(
    { cdp },
    { sleep: clock.sleep, now: clock.now, pollMs: 100 },
  );

  const result = await executor.dispatch(command(
    'select_mode',
    { optionKind: 'target', optionValue: 'facebook_personal_timeline' },
    1,
  ));

  assert.equal(result.ok, true);
  assert.equal(cdp.composerProbeCalls, 4);
  assert.equal(releasedClickCount(cdp), 1);
});

test('FacebookPublishExecutor: select_mode uses the remaining total budget for a late editor', async () => {
  const cdp = new FakeFacebookPublishCdp();
  cdp.editorReadyAfterChecks = 3;
  const clock = fakeClock();
  const executor = new FacebookPublishExecutor(
    { cdp },
    { sleep: clock.sleep, now: clock.now, pollMs: 100 },
  );
  const payload = command(
    'select_mode',
    { optionKind: 'target', optionValue: 'facebook_personal_timeline' },
    1,
  );
  payload.timeoutMs = 1_000;

  const result = await executor.dispatch(payload);

  assert.equal(result.ok, true);
  assert.equal(cdp.editorReadyChecks, 3);
  assert.equal(releasedClickCount(cdp), 1);
  assert.equal(clock.now(), 200);
});

test('FacebookPublishExecutor: navigation from a group page must reach home before select_mode clicks', async () => {
  const cdp = new FakeFacebookPublishCdp();
  cdp.pageStates = [
    { href: 'https://www.facebook.com/groups/123', readyState: 'complete', mainVisible: true },
    { href: 'https://www.facebook.com/', readyState: 'complete', mainVisible: true },
  ];
  const clock = fakeClock();
  const executor = new FacebookPublishExecutor(
    { cdp },
    { sleep: clock.sleep, now: clock.now, pollMs: 100, navigationTimeoutMs: 1_000 },
  );

  const navigated = await executor.dispatch(command('navigate_entry'));
  assert.equal(navigated.ok, true);
  assert.equal(releasedClickCount(cdp), 0);

  const selected = await executor.dispatch(command(
    'select_mode',
    { optionKind: 'target', optionValue: 'facebook_personal_timeline' },
    1,
  ));
  assert.equal(selected.ok, true);
  assert.equal(releasedClickCount(cdp), 1);
});

test('FacebookPublishExecutor: select_mode caps trigger waiting at 20s within the 40s total budget', async () => {
  const cdp = new FakeFacebookPublishCdp();
  cdp.triggerAvailableAfterProbe = Number.POSITIVE_INFINITY;
  const clock = fakeClock();
  const executor = new FacebookPublishExecutor(
    { cdp },
    { sleep: clock.sleep, now: clock.now, pollMs: 100 },
  );
  const payload = command(
    'select_mode',
    { optionKind: 'target', optionValue: 'facebook_personal_timeline' },
    1,
  );
  payload.timeoutMs = 40_000;

  const result = await executor.dispatch(payload);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_target');
  assert.equal(releasedClickCount(cdp), 0);
  assert.equal(clock.now(), 20_000);
});

test('FacebookPublishExecutor: select_mode clicks once then reports post_validate_failed when editor never opens', async () => {
  const cdp = new FakeFacebookPublishCdp();
  cdp.openComposerOnClick = false;
  const clock = fakeClock();
  const executor = new FacebookPublishExecutor(
    { cdp },
    { sleep: clock.sleep, now: clock.now, pollMs: 100 },
  );
  const payload = command(
    'select_mode',
    { optionKind: 'target', optionValue: 'facebook_personal_timeline' },
    1,
  );
  payload.timeoutMs = 1_000;

  const result = await executor.dispatch(payload);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'post_validate_failed');
  assert.equal(releasedClickCount(cdp), 1);
  assert.equal(clock.now(), 1_000);
});

test('FacebookPublishExecutor: select_mode stops when the page leaves home while waiting for the trigger', async () => {
  const cdp = new FakeFacebookPublishCdp();
  cdp.triggerAvailableAfterProbe = Number.POSITIVE_INFINITY;
  cdp.pageStates = [
    { href: 'https://www.facebook.com/' },
    { href: 'https://www.facebook.com/groups/123' },
  ];
  const clock = fakeClock();
  const executor = new FacebookPublishExecutor(
    { cdp },
    { sleep: clock.sleep, now: clock.now, pollMs: 100 },
  );

  const result = await executor.dispatch(command(
    'select_mode',
    { optionKind: 'target', optionValue: 'facebook_personal_timeline' },
    1,
  ));

  assert.equal(result.ok, false);
  assert.equal(result.error, 'home_not_reached');
  assert.equal(releasedClickCount(cdp), 0);
});

test('FacebookPublishExecutor: select_mode target guard trusts canonical option fields', async () => {
  const cdp = new FakeFacebookPublishCdp();
  const executor = new FacebookPublishExecutor({ cdp }, { sleep: instantSleep });

  const result = await executor.dispatch(command('select_mode', {
    optionKind: 'target',
    optionValue: 'facebook_group',
    value: 'facebook_personal_timeline',
  }));

  assert.equal(result.ok, false);
  assert.equal(result.error, 'unsupported_target');
  assert.equal(cdp.calls.length, 0);

  const legacyOnly = await executor.dispatch(command('select_mode', {
    value: 'facebook_personal_timeline',
  }));
  assert.equal(legacyOnly.ok, false);
  assert.equal(legacyOnly.error, 'unsupported_target');
  assert.equal(cdp.calls.length, 0);
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
  await executor.dispatch(command('select_mode', { optionKind: 'target', optionValue: 'facebook_personal_timeline' }, 1));
  assert.equal(cdp.composerOpen, true);
}

test('FacebookPublishExecutor: 编辑器吞掉正文尾部 → 诚实失败 + 清场，绝不判成功', async () => {
  const cdp = new FakeFacebookPublishCdp();
  const executor = new FacebookPublishExecutor(
    { cdp },
    { sleep: instantSleep, pollMs: 1, composerTimeoutMs: 1_000, fillVerifyTimeoutMs: 20 },
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
    { sleep: instantSleep, pollMs: 1, composerTimeoutMs: 1_000, fillVerifyTimeoutMs: 20 },
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
    { sleep: instantSleep, pollMs: 1, composerTimeoutMs: 1_000, fillVerifyTimeoutMs: 20 },
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
    { sleep: instantSleep, pollMs: 1, composerTimeoutMs: 1_000, fillVerifyTimeoutMs: 20 },
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
  const e1 = new FacebookPublishExecutor({ cdp: dirty }, { sleep: instantSleep, pollMs: 1, composerTimeoutMs: 1_000, fillVerifyTimeoutMs: 20 });
  await openComposer(dirty, e1);
  dirty.swallowAfterChars = 3;
  dirty.refuseClearAfterTyping = true;
  const r1 = await e1.dispatch(command('fill_field', { fieldType: 'content', value: '一段会被吞掉大半的正文内容' }, 2));
  assert.equal(r1.ok, false);
  assert.match(String(r1.error), /_dirty_composer$/);

  const gone = new FakeFacebookPublishCdp();
  const e2 = new FacebookPublishExecutor({ cdp: gone }, { sleep: instantSleep, pollMs: 1, composerTimeoutMs: 1_000, fillVerifyTimeoutMs: 20 });
  await openComposer(gone, e2);
  gone.swallowAfterChars = 3;
  gone.closeComposerAfterTyping = true; // 页面被导航走 / 弹层关闭 → 没有残文可留
  const r2 = await e2.dispatch(command('fill_field', { fieldType: 'content', value: '一段会被吞掉大半的正文内容' }, 2));
  assert.equal(r2.ok, false);
  assert.match(String(r2.error), /_composer_gone$/);
});

test('🔴 复核 wf_1657e89b BLOCKER：FB submit 提交窗口打开前被接管 → 零点击（帖子未发出）+ 抛 TaskTakeoverError', async () => {
  const cdp = new FakeFacebookPublishCdp();
  const executor = new FacebookPublishExecutor({ cdp }, { sleep: instantSleep, pollMs: 1, submitVerifyTimeoutMs: 50 });
  // 抢占落在提交窗口打开之前：submit 的 checkpoint 在 target 查找之后、enter 之前——此刻抛出即点击前作废。
  let checkpointCalls = 0;
  const takeover: TakeoverCtx = {
    checkpoint: () => {
      checkpointCalls++;
      throw new TaskTakeoverError();
    },
  };
  await assert.rejects(
    () => executor.dispatch(command('submit_publish', {}, 4), takeover),
    (e) => e instanceof TaskTakeoverError,
    '被接管 MUST 抛 TaskTakeoverError（由上层 PublishCommandDispatcher.dispatch 转 preempted_by_task），绝不吞成 engine_error',
  );
  assert.equal(checkpointCalls, 1, 'submit 确实在 target 查找后、enter 前检查了接管');
  assert.equal(cdp.submitted, false, '提交窗口前被接管 MUST 零点击：帖子一个字节没发出（否则协调器判 preempted 可重投 → 双发）');
  // 反「空测」自证：换回旧的「submit 不接 takeover / enter 前无 checkpoint」实现，checkpoint 永不被调用 → 点击照发 → cdp.submitted===true（本断言变红）。
});

test('🔴 6.2：FB submit press 已派发但确认超时未命中 → post_validate_failed 且 submitDispatched=true（区分「已点未确认」与「压根没点」）', async () => {
  // reportSubmitSignal=false：mouseReleased 照发（点击真发出、submitted=true），但 fbPublishSubmittedSignal 恒回 false → waitUntil 超时。
  const cdp = new FakeFacebookPublishCdp();
  cdp.composerOpen = true; // 桩：composer 已开，submit 的 mouseReleased 才置 submitted（否则首个 release 只开 composer）
  cdp.reportSubmitSignal = false;
  const executor = new FacebookPublishExecutor({ cdp }, { sleep: instantSleep, pollMs: 1, submitVerifyTimeoutMs: 20 });
  const res = await executor.dispatch(command('submit_publish', {}, 4));
  assert.equal(cdp.submitted, true, '点击确实发出（mouseReleased 到达）');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'post_validate_failed');
  assert.equal(res.submitDispatched, true, 'press 派发那一刻即置真（onPressDispatched）——即便确认失败，云端 MUST NOT 当提交前失败重投');
});
