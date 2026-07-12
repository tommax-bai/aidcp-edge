import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeFacebookPostComposerReadOnly } from '../../src/facebook/probes/post-composer-probe.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

interface Call {
  method: string;
  params?: Record<string, unknown>;
}

class FakePostComposerProbeCdp implements BrowseCdp {
  calls: Call[] = [];
  composerOpen = false;
  editorText = '';
  selected = false;
  hasTrigger = true;

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Input.insertText') {
      this.editorText += String(params?.text ?? '');
      return {} as T;
    }
    if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown' && params?.key === 'Backspace') {
      if (this.selected) this.editorText = '';
      return {} as T;
    }
    if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
      if (!this.composerOpen) this.composerOpen = true;
      return {} as T;
    }
    if (method !== 'Runtime.evaluate') return {} as T;

    const expression = String(params?.expression ?? '');
    if (expression.includes('var el = fbPostEditor(); var submit = fbPostSubmitControl();')) {
      const editorFound = this.composerOpen;
      const markerMatch = expression.match(/text\.indexOf\("([^"]+)"/);
      const marker = markerMatch?.[1] ?? '';
      return {
        result: {
          value: JSON.stringify({
            editorFound,
            textLength: editorFound ? this.editorText.length : null,
            markerAccepted: editorFound && marker.length > 0 && this.editorText.includes(marker),
            submitControlObserved: editorFound,
            submitControlLabel: editorFound ? 'Post' : null,
            submitControlDisabled: false,
          }),
        },
      } as T;
    }
    if (expression.includes('var el = fbPostTrigger()')) {
      return {
        result: {
          value: JSON.stringify(this.hasTrigger
            ? { found: true, x: 42, y: 50, label: 'What are you thinking?' }
            : { found: false, x: null, y: null, label: null }),
        },
      } as T;
    }
    if (expression.includes('selected:fbPostSelectEditorContents(el)')) {
      this.selected = this.composerOpen;
      return { result: { value: JSON.stringify({ found: this.composerOpen, selected: this.selected }) } } as T;
    }
    if (expression.includes('var el = fbPostEditor()') && expression.includes('fbPostCenter(el)')) {
      return {
        result: {
          value: JSON.stringify(this.composerOpen
            ? { found: true, x: 100, y: 120, label: 'What are you thinking?' }
            : { found: false, x: null, y: null, label: null }),
        },
      } as T;
    }
    return { result: { value: false } } as T;
  }
}

const instantSleep = async (_ms: number): Promise<void> => {};

test('probeFacebookPostComposerReadOnly opens, types, observes submit, clears, and never submits', async () => {
  const cdp = new FakePostComposerProbeCdp();
  const result = await probeFacebookPostComposerReadOnly(cdp, {
    marker: 'aidcp-post-probe-marker',
    sleep: instantSleep,
    pollMs: 1,
    composerTimeoutMs: 20,
  });

  assert.equal(result.ok, true);
  assert.equal(result.submitted, false);
  assert.equal(result.triggerFound, true);
  assert.equal(result.composerOpened, true);
  assert.equal(result.markerAccepted, true);
  assert.equal(result.submitControlObserved, true);
  assert.equal(result.cleared, true);
  assert.equal(result.finalTextLength, 0);
  assert.equal(cdp.editorText, '');
  assert.equal(cdp.calls.some((call) => call.method === 'Input.insertText'), true);
  assert.equal(cdp.calls.some((call) => call.method === 'Input.dispatchMouseEvent'), true);
});

test('probeFacebookPostComposerReadOnly fails honestly when trigger is missing', async () => {
  const cdp = new FakePostComposerProbeCdp();
  cdp.hasTrigger = false;
  const result = await probeFacebookPostComposerReadOnly(cdp, {
    marker: 'aidcp-post-probe-marker',
    sleep: instantSleep,
    pollMs: 1,
    composerTimeoutMs: 5,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'trigger_not_found');
  assert.equal(result.submitted, false);
  assert.equal(cdp.calls.some((call) => call.method === 'Input.insertText'), false);
});
