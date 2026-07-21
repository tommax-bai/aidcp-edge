import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserSidecarState, WechatChannelsBrowserSidecar } from '../../src/wechat-channels/browser-sidecar.js';
import {
  LeasedWechatChannelsBrowserSidecar,
  TransientBrowserLeaseClient,
  type TransientLeaseIpc,
} from '../../src/wechat-channels/transient-browser-lease.js';

class FakeSidecar implements WechatChannelsBrowserSidecar {
  readonly browserProfileId = 'wechat-profile';
  state: BrowserSidecarState = 'closed';
  openCalls = 0;
  closeCalls = 0;
  failOpen = false;
  failOpenState: BrowserSidecarState = 'closed';

  getState(): BrowserSidecarState {
    return this.state;
  }

  async open(): Promise<void> {
    this.openCalls += 1;
    if (this.failOpen) {
      this.state = this.failOpenState;
      throw new Error('sidecar unavailable');
    }
    this.state = 'open';
  }

  async readSessionCandidate(): Promise<null> {
    return null;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
  }
}

function ipcHarness() {
  const sent: Array<Record<string, unknown>> = [];
  const ipc: TransientLeaseIpc = {
    connected: true,
    send: (payload) => sent.push(payload),
  };
  return { ipc, sent };
}

test('有效保存会话不打开浏览器，并在初始化完成后释放预授予通道', () => {
  const { ipc, sent } = ipcHarness();
  const lease = new TransientBrowserLeaseClient({ ipc, initiallyHeld: true, lifecycleGeneration: 7 });
  const delegate = new FakeSidecar();
  const sidecar = new LeasedWechatChannelsBrowserSidecar(delegate, lease);

  sidecar.releaseIfBrowserClosed('stored_session_valid');

  assert.equal(delegate.openCalls, 0);
  assert.equal(lease.isHeld(), false);
  assert.deepEqual(sent, [{
    type: 'lifecycle.transient_browser_released',
    requestId: 'startup',
    reason: 'stored_session_valid',
    generation: 7,
  }]);
});

test('重新鉴权必须先获临时通道，关闭浏览器确认后才释放', async () => {
  const { ipc, sent } = ipcHarness();
  const lease = new TransientBrowserLeaseClient({ ipc, lifecycleGeneration: 3 });
  const delegate = new FakeSidecar();
  const sidecar = new LeasedWechatChannelsBrowserSidecar(delegate, lease);

  const opening = sidecar.open();
  assert.equal(delegate.openCalls, 0, '未获通道不得调用实际浏览器 open');
  const request = sent[0];
  assert.equal(request.type, 'lifecycle.transient_browser_requested');
  assert.equal(request.generation, 3);

  lease.handleMessage({
    type: 'lifecycle.transient_browser_granted',
    requestId: request.requestId,
    generation: 2,
  });
  assert.equal(delegate.openCalls, 0, '旧代 grant 不得放行');

  lease.handleMessage({
    type: 'lifecycle.transient_browser_granted',
    requestId: request.requestId,
    generation: 3,
  });
  await opening;
  assert.equal(delegate.openCalls, 1);
  assert.equal(lease.isHeld(), true);

  await sidecar.close();
  assert.equal(delegate.closeCalls, 1);
  assert.equal(lease.isHeld(), false);
  assert.deepEqual(sent.at(-1), {
    type: 'lifecycle.transient_browser_released',
    requestId: request.requestId,
    reason: 'sidecar_closed',
    generation: 3,
  });
});

test('浏览器打开失败且已确认关闭时释放临时通道', async () => {
  const { ipc, sent } = ipcHarness();
  const lease = new TransientBrowserLeaseClient({ ipc, lifecycleGeneration: 11 });
  const delegate = new FakeSidecar();
  delegate.failOpen = true;
  const sidecar = new LeasedWechatChannelsBrowserSidecar(delegate, lease);

  const opening = sidecar.open();
  const request = sent[0];
  lease.handleMessage({
    type: 'lifecycle.transient_browser_granted',
    requestId: request.requestId,
    generation: 11,
  });

  await assert.rejects(opening, /sidecar unavailable/);
  assert.equal(lease.isHeld(), false);
  assert.equal(sent.at(-1)?.type, 'lifecycle.transient_browser_released');
  assert.equal(sent.at(-1)?.reason, 'sidecar_open_failed_closed');
});

test('浏览器关闭未确认时保持临时通道，交给外壳有界超时回收', async () => {
  const { ipc, sent } = ipcHarness();
  const lease = new TransientBrowserLeaseClient({ ipc, lifecycleGeneration: 12 });
  const delegate = new FakeSidecar();
  delegate.failOpen = true;
  delegate.failOpenState = 'unavailable';
  const sidecar = new LeasedWechatChannelsBrowserSidecar(delegate, lease);

  const opening = sidecar.open();
  const request = sent[0];
  lease.handleMessage({
    type: 'lifecycle.transient_browser_granted',
    requestId: request.requestId,
    generation: 12,
  });

  await assert.rejects(opening, /sidecar unavailable/);
  assert.equal(lease.isHeld(), true, '物理关闭未确认时不得提前放行下一环境');
  assert.equal(sent.filter((message) => message.type === 'lifecycle.transient_browser_released').length, 0);
});
