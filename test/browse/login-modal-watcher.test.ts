import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CdpLoginModalWatcher,
  buildLoginModalOpenJs,
  DEFAULT_LOGIN_CONTAINER_SELECTORS,
  DEFAULT_LOGIN_PHRASES,
} from '../../src/browse/login-modal-watcher.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';

function fakeCdp(handler: (method: string, params: Record<string, unknown>) => unknown): {
  cdp: BrowseCdp;
  calls: { method: string; params: Record<string, unknown> }[];
} {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const cdp: BrowseCdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return handler(method, params) as never;
    },
  };
  return { cdp, calls };
}

test('isOpen: 返回 evaluate 的布尔结果', async () => {
  const { cdp } = fakeCdp(() => ({ result: { type: 'boolean', value: true } }));
  assert.equal(await new CdpLoginModalWatcher(cdp).isOpen(), true);

  const { cdp: cdp2 } = fakeCdp(() => ({ result: { type: 'boolean', value: false } }));
  assert.equal(await new CdpLoginModalWatcher(cdp2).isOpen(), false);
});

test('isOpen: 探测异常按未弹出处理且触发 onError', async () => {
  let captured: Error | undefined;
  const cdp: BrowseCdp = {
    send: async () => {
      throw new Error('CDP boom');
    },
  };
  const watcher = new CdpLoginModalWatcher(cdp, { onError: (e) => (captured = e) });
  assert.equal(await watcher.isOpen(), false);
  assert.ok(captured && /boom/.test(captured.message));
});

test('isOpen: evaluate 抛出 exceptionDetails 也按未弹出处理', async () => {
  const { cdp } = fakeCdp(() => ({ exceptionDetails: { text: 'Uncaught' } }));
  assert.equal(await new CdpLoginModalWatcher(cdp).isOpen(), false);
});

// —— 判定 JS 在真实 DOM 语义下的行为（用 jsdom 风格的轻量断言：直接执行生成的 JS）——

/** 在一个最小 DOM 桩里执行生成的判定 JS，返回 boolean。 */
interface RunOpts {
  rect?: DOMRectLike;
  style?: Partial<CSSStyleDeclarationLike>;
  /** el.closest(EXCLUDE) 是否命中（模拟落在笔记详情容器内）*/
  insideNoteDetail?: boolean;
}

function runOpenJs(html: string, opts?: RunOpts): boolean {
  const js = buildLoginModalOpenJs(DEFAULT_LOGIN_CONTAINER_SELECTORS, DEFAULT_LOGIN_PHRASES);
  const { document, window } = makeDomStub(html, opts);
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'window', `return ${js};`);
  return fn(document, window) === true;
}

interface DOMRectLike {
  width: number;
  height: number;
}
interface CSSStyleDeclarationLike {
  display: string;
  visibility: string;
  opacity: string;
}

/**
 * 极简 DOM 桩：仅支持 querySelectorAll('a, b, ...') 命中我们造的元素，
 * 每个元素带 textContent / getBoundingClientRect / closest / 默认可见样式。
 */
function makeDomStub(html: string, opts?: RunOpts): { document: unknown; window: unknown } {
  const rect = opts?.rect ?? { width: 320, height: 400 };
  const style: CSSStyleDeclarationLike = {
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    ...opts?.style,
  };
  const text = html;
  const el = {
    getBoundingClientRect: () => rect,
    textContent: text,
    // 模拟 closest：仅当显式标记"在笔记详情容器内"时返回一个非空祖先。
    closest: (_sel: string) => (opts?.insideNoteDetail ? ({} as unknown) : null),
  };
  const document = {
    querySelectorAll: () => [el],
  };
  const window = {
    getComputedStyle: () => style,
  };
  return { document, window };
}

test('判定JS: 容器含"扫码登录"且可见 → true', () => {
  assert.equal(runOpenJs('扫码登录 / 手机号登录'), true);
});

test('判定JS: 容器文本不含登录短语 → false', () => {
  assert.equal(runOpenJs('笔记详情 评论 点赞 收藏'), false);
});

test('判定JS: 命中短语但容器不可见（display:none）→ false', () => {
  assert.equal(runOpenJs('扫码登录', { style: { display: 'none' } }), false);
});

test('判定JS: 命中短语但容器零尺寸 → false', () => {
  assert.equal(runOpenJs('扫码登录', { rect: { width: 0, height: 0 } }), false);
});

test('判定JS: 命中短语但 opacity≈0（淡入淡出）→ false', () => {
  assert.equal(runOpenJs('扫码登录', { style: { opacity: '0.02' } }), false);
});

test('判定JS: 候选落在笔记详情容器内（closest 命中排除选择器）→ false（防评论误判）', () => {
  // 即便文本含"手机号登录"（如评论"我手机号登录失败了"），只要在笔记详情容器内就排除
  assert.equal(runOpenJs('我手机号登录失败了 还有好多评论…', { insideNoteDetail: true }), false);
  // 同样文本但不在笔记容器内（真·登录弹窗）→ true
  assert.equal(runOpenJs('手机号登录', { insideNoteDetail: false }), true);
});

test('默认短语只用多字强短语，不含裸"登录"与过松的"登录后"', () => {
  // 防止误命中导航栏恒存在的"登录"按钮，以及评论/CTA 里的"登录后…"
  assert.ok(!DEFAULT_LOGIN_PHRASES.includes('登录'));
  assert.ok(!DEFAULT_LOGIN_PHRASES.includes('登录后'));
  assert.ok(DEFAULT_LOGIN_PHRASES.includes('扫码登录'));
});
