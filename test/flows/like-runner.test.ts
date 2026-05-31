import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDom } from '../helpers.js';
import { AnchorCache } from '../../src/locating/index.js';
import type {
  ActionExecutor,
  ActionRequest,
  DomProvider,
  ElementDescriptor,
  ElementSelector,
  SelectionResult,
} from '../../src/locating/index.js';
import { LikeStepRunner, toActionResultPayload } from '../../src/client/like-runner.js';
import type { ActionResult } from '../../src/locating/index.js';
import { XHS_LIKE_ACTION_ID } from '../../src/flows/anchors.js';
import type { PlanStep } from '../../src/comm/protocol.js';

class LiveDom implements DomProvider {
  constructor(private readonly doc: Document) {}
  getRoot(): Document {
    return this.doc;
  }
}
class FakeExecutor implements ActionExecutor {
  readonly calls: { op: string; element: ElementDescriptor }[] = [];
  constructor(private readonly onClick?: (el: ElementDescriptor) => void) {}
  execute(op: ActionRequest['op'], element: ElementDescriptor): void {
    this.calls.push({ op, element });
    if (op === 'click' && this.onClick) this.onClick(element);
  }
}
class FakeSelector implements ElementSelector {
  constructor(private readonly pick: (els: ElementDescriptor[]) => SelectionResult) {}
  async select(_g: string, els: ElementDescriptor[]): Promise<SelectionResult> {
    return this.pick(els);
  }
}

test('toActionResultPayload: 透传 ok/outcome/attempts/reason/escalation', () => {
  const r: ActionResult = {
    ok: false,
    actionId: 'a',
    attempts: 3,
    outcome: 'escalated',
    escalation: 'systemic_revision',
    reason: 'post_validate_failed',
  };
  const p = toActionResultPayload(r);
  assert.equal(p.actionId, 'a');
  assert.equal(p.ok, false);
  assert.equal(p.outcome, 'escalated');
  assert.equal(p.attempts, 3);
  assert.equal(p.escalation, 'systemic_revision');
});

test('LikeStepRunner: 收到点赞步骤 → 走点赞流程并回传 success', async () => {
  const { document } = buildDom(
    `<button aria-label="点赞" data-id="like1" aria-pressed="false">赞</button>`,
  );
  const executor = new FakeExecutor(() => {
    document.querySelector('[data-id="like1"]')!.setAttribute('aria-pressed', 'true');
  });
  const cache = new AnchorCache();
  cache.put({
    actionId: XHS_LIKE_ACTION_ID,
    role: 'button',
    text: '点赞',
    textMatch: 'contains',
    attributes: { 'aria-label': '点赞' },
  });
  const runner = new LikeStepRunner({
    dom: new LiveDom(document),
    executor,
    selector: new FakeSelector(() => ({ index: null, reason: 'none' })),
    cache,
  });

  const step: PlanStep = {
    actionId: XHS_LIKE_ACTION_ID,
    op: 'click',
    goal: '给当前这条笔记点赞',
  };
  const payload = await runner.run(step);
  assert.equal(payload.ok, true);
  assert.equal(payload.actionId, XHS_LIKE_ACTION_ID);
  assert.equal(payload.outcome, 'success');
  assert.equal(executor.calls.length, 1);
});

test('LikeStepRunner: goal 含"点赞"亦走点赞流程（actionId 不同）', async () => {
  const { document } = buildDom(
    `<button aria-label="点赞" data-id="like1" aria-pressed="false">赞</button>`,
  );
  const executor = new FakeExecutor(() => {
    document.querySelector('[data-id="like1"]')!.setAttribute('aria-pressed', 'true');
  });
  const cache = new AnchorCache();
  cache.put({
    actionId: 'note.like_button',
    role: 'button',
    text: '点赞',
    textMatch: 'contains',
    attributes: { 'aria-label': '点赞' },
  });
  const runner = new LikeStepRunner({
    dom: new LiveDom(document),
    executor,
    selector: new FakeSelector(() => ({ index: null, reason: 'none' })),
    cache,
  });
  const payload = await runner.run({ actionId: 'x.unknown', op: 'click', goal: '点赞这条' });
  assert.equal(payload.ok, true);
});