import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { readFacebookRouterSource } from './facebook-router-source.js';

/**
 * 阻断现场结构化采集（change blocking-overlay-dom-capture）。
 *
 * 这批用例锁的是**今天采不到的那一类**：Facebook 标准限流弹窗——带对话框语义、不含 iframe、
 * 约占视口三分之一、右下角带确认按钮。判定通道的候选筛选要求「带 iframe 或（宽≥60% 视口
 * 且 高≥40% 且 无关闭控件）」，这类弹窗三个分支全不满足，于是既有链路一个 DOM 节点都留不下。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFacebookRouterSource(repoRoot);
const run = Function(`return (${source})`)() as (
  input: { kind: string; params: Record<string, unknown> },
) => Promise<{ effectPhase: string; output: { kind: string; value: Record<string, unknown> } }>;

const VIEWPORT = { width: 1_440, height: 900 };

function install(html: string, url = 'https://www.facebook.com/reel/2815335378830397'): JSDOM {
  const dom = new JSDOM(html, { url });
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: VIEWPORT.width });
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: VIEWPORT.height });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    innerWidth: VIEWPORT.width,
    innerHeight: VIEWPORT.height,
  });
  // 默认给所有元素一个非零矩形，否则可见性判据把整页判成不可见。
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 40, width: 120, height: 40 }),
  });
  return dom;
}

function setRect(
  element: Element,
  { left, top, width, height }: { left: number; top: number; width: number; height: number },
): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: left,
      y: top,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
    }),
  });
}

/** 真实形态：`Sorry, this feature isn't available right now` + `A security check is required`。 */
const THROTTLE_DIALOG_HTML = `
  <body>
    <div id="mount">
      <div role="main"><span>Reels</span><span>38.3K</span></div>
    </div>
    <div id="layer">
      <div id="dlg" role="dialog" aria-modal="true" aria-label="Feature unavailable" data-testid="fb-block-dialog">
        <h2>Sorry, this feature isn't available right now</h2>
        <p>A security check is required to proceed.</p>
        <div role="button" data-testid="dlg-learn" aria-label="Let us know">let us know</div>
        <div role="button" data-testid="dlg-ok" aria-label="OK">OK</div>
      </div>
    </div>
  </body>
`;

function installThrottleDialog(): JSDOM {
  const dom = install(THROTTLE_DIALOG_HTML);
  const doc = dom.window.document;
  const dialog = doc.getElementById('dlg')!;
  // 约占视口 35%：刻意落在判定通道的尺寸阈值之下，正是既有链路漏掉的那一档。
  setRect(dialog, { left: 420, top: 250, width: 600, height: 380 });
  setRect(doc.querySelector('[data-testid="dlg-ok"]')!, { left: 880, top: 560, width: 96, height: 36 });
  setRect(doc.querySelector('[data-testid="dlg-learn"]')!, { left: 700, top: 560, width: 150, height: 36 });
  return dom;
}

async function pageProbe(): Promise<Record<string, unknown>> {
  const result = await run({ kind: 'page_probe', params: {} });
  assert.equal(result.output.kind, 'page_probe');
  return result.output.value;
}

type Capture = {
  captureId: string;
  status: string;
  reason?: string;
  seenCount?: number;
  truncated?: boolean;
  containers: Array<Record<string, unknown>>;
};

test('标准限流弹窗被采到（判定通道漏掉的那一类）', async () => {
  installThrottleDialog();
  const value = await pageProbe();

  assert.equal(value.blockingKind, 'unknown', '文案判据应把该页判为未知阻断');
  const capture = value.overlayCapture as Capture;
  assert.ok(capture, '判为阻断时必须产出现场采集');
  assert.equal(capture.status, 'captured');
  assert.ok(capture.containers.length >= 1, '必须至少采到那个对话框容器');

  const dialog = capture.containers.find((c) => c.testId === 'fb-block-dialog');
  assert.ok(dialog, '带 data-testid 的对话框必须在采集结果里');
  assert.equal(dialog.role, 'dialog');
  assert.equal(dialog.ariaModal, 'true');
  assert.deepEqual(dialog.rect, { x: 420, y: 250, width: 600, height: 380 });
  assert.match(String(dialog.path), /role=dialog/, '层级路径要带得出稳定锚点');
});

test('可点击子元素带文字与坐标（两种点击方式都写得出来）', async () => {
  installThrottleDialog();
  const capture = (await pageProbe()).overlayCapture as Capture;
  const dialog = capture.containers.find((c) => c.testId === 'fb-block-dialog')!;
  const clickables = dialog.clickables as Array<Record<string, unknown>>;

  const ok = clickables.find((c) => c.testId === 'dlg-ok');
  assert.ok(ok, '确认按钮必须在可点击清单里');
  assert.equal(ok.role, 'button');
  assert.equal(ok.label, 'OK');
  // rect 是硬要求：坐标点击那条路全靠它，缺了就只剩元素点击一条路可走。
  assert.deepEqual(ok.rect, { x: 880, y: 560, width: 96, height: 36 });
  assert.ok(clickables.some((c) => c.testId === 'dlg-learn'), '其余可点击项也要留下');
});

test('容器 HTML 原文被保留', async () => {
  installThrottleDialog();
  const capture = (await pageProbe()).overlayCapture as Capture;
  const dialog = capture.containers.find((c) => c.testId === 'fb-block-dialog')!;
  const html = String(dialog.html ?? '');
  assert.match(html, /Sorry, this feature isn't available right now/);
  assert.match(html, /dlg-ok/, '原文要覆盖字段设计没预料到的后续需求');
});

test('采集标识每次不同，且不由页面内容派生', async () => {
  installThrottleDialog();
  const first = (await pageProbe()).overlayCapture as Capture;
  installThrottleDialog();
  const second = (await pageProbe()).overlayCapture as Capture;

  assert.match(first.captureId, /^ovc_/);
  // 同一份页面内容采两次必须得到两个标识：内容派生的标识会把多次独立采集折叠成一条，
  // 样本表上看就成了「这个弹窗只出现过一次」。
  assert.notEqual(first.captureId, second.captureId);
});

test('判为无阻断时不采集（采集口径绝不改变判定）', async () => {
  const dom = install(`
    <body>
      <div role="main"><span>Reels</span></div>
      <div id="promo" role="dialog" aria-modal="true" data-testid="benign"><button>Close</button></div>
    </body>
  `);
  // 良性弹层：符合较宽的采集入选口径，但不命中任何阻断文案判据。
  setRect(dom.window.document.getElementById('promo')!, { left: 300, top: 200, width: 700, height: 420 });

  const value = await pageProbe();
  assert.equal(value.blockingKind, 'none', '良性弹层 MUST NOT 因采集口径较宽而被判为阻断');
  assert.equal(value.overlayCapture, undefined, '未判出阻断时不应产出采集');
});

test('三态：判为阻断但页面上没有可见容器 → none_visible，不伪装成失败', async () => {
  install(`
    <body>
      <div role="main">
        <p>Sorry, this feature isn't available right now. A security check is required to proceed.</p>
      </div>
    </body>
  `);
  const value = await pageProbe();
  assert.equal(value.blockingKind, 'unknown');
  const capture = value.overlayCapture as Capture;
  assert.equal(capture.status, 'none_visible', '采集跑通、确实没有容器：MUST NOT 记成 failed');
  assert.equal(capture.containers.length, 0);
  assert.equal(capture.reason, undefined, 'none_visible 不带失败原因');
  assert.ok(capture.captureId, '「确实没有」这一态同样要带标识');
});

test('采集抛错时降级为 failed 并带原因，既有阻断判定不受影响', async () => {
  const dom = installThrottleDialog();
  // 只让**采集独有**的那次查询抛错：`alertdialog` 这个 token 只出现在采集的候选选择器里，
  // 判定通道不用它。若改成沙包 getComputedStyle，炸掉的是判定通道自己（同意条探测也用它），
  // 那验证的就不再是「采集失败被容错兜住」这件事了。
  const realQuery = dom.window.document.querySelectorAll.bind(dom.window.document);
  Object.defineProperty(dom.window.document, 'querySelectorAll', {
    configurable: true,
    value: (selector: string) => {
      if (selector.includes('alertdialog')) throw new Error('capture query exploded');
      return realQuery(selector);
    },
  });
  Object.assign(globalThis, { document: dom.window.document });

  const value = await pageProbe();
  // 红线：采集是加法，失败绝不能成为既有阻断上报的新失败点。
  assert.equal(value.blockingKind, 'unknown', '采集失败 MUST NOT 改变阻断判定');
  assert.equal(value.blockingText !== undefined, true, '既有证据文案照常产出');
  const capture = value.overlayCapture as Capture;
  assert.equal(capture.status, 'failed');
  assert.ok(capture.captureId, '失败态也要带标识，否则告警既查不到样本也不知道曾采到过');
  assert.match(String(capture.reason), /capture query exploded/);
  assert.deepEqual(capture.containers, [], 'failed 态不得混入半截容器');
});

test('可点击子元素数超上限时显式标记截断，绝不静默截断', async () => {
  const buttons = Array.from(
    { length: 45 },
    (_, index) => `<div role="button" data-testid="b${index}">go ${index}</div>`,
  ).join('');
  const dom = install(`
    <body>
      <div id="dlg" role="dialog" aria-modal="true">
        <h2>Sorry, this feature isn't available right now</h2>
        ${buttons}
      </div>
    </body>
  `);
  setRect(dom.window.document.getElementById('dlg')!, { left: 420, top: 250, width: 600, height: 380 });

  const capture = (await pageProbe()).overlayCapture as Capture;
  const dialog = capture.containers[0]!;
  const clickables = dialog.clickables as unknown[];
  assert.equal(clickables.length, 30, '每容器可点击子元素上限为 30');
  assert.equal(dialog.clickablesTruncated, true, '触及上限必须显式标记');
});

test('HTML 原文超上限时被截断且带标记', async () => {
  const filler = 'x'.repeat(30_000);
  const dom = install(`
    <body>
      <div id="dlg" role="dialog" aria-modal="true">
        <h2>Sorry, this feature isn't available right now</h2>
        <p>${filler}</p>
      </div>
    </body>
  `);
  setRect(dom.window.document.getElementById('dlg')!, { left: 420, top: 250, width: 600, height: 380 });

  const capture = (await pageProbe()).overlayCapture as Capture;
  const dialog = capture.containers[0]!;
  assert.ok(String(dialog.html).length <= 20_000, '每容器 HTML 原文上限 20 KB');
  assert.equal(dialog.htmlTruncated, true);
  assert.equal(capture.truncated, true, '任一上限被触及要在快照层也标出来');
});

/**
 * JS ↔ Rust 字段漂移闸。
 *
 * 采集结构体刻意**不**带 `deny_unknown_fields`（留证数据不该把阻断监测打瞎），代价是
 * 页面规则先行新增字段会被 Rust 静默丢掉。本用例把这条代价从「样本里悄悄少一格」
 * 降级为「测试失败」：两侧名单都是**读出来的**，不是手抄的。
 */
test('页面规则产出的每个字段都在 Rust 侧声明过', async () => {
  const probeRs = await readFile(resolve(repoRoot, 'native/page-engine/src/probe.rs'), 'utf8');
  const declared = new Set<string>();
  for (const struct of probeRs.matchAll(/pub struct Overlay\w+\s*\{([\s\S]*?)\n\}/g)) {
    for (const field of struct[1]!.matchAll(/pub ([a-z_0-9]+):/g)) {
      declared.add(field[1]!.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()));
    }
  }
  assert.ok(declared.has('captureId'), '解析 probe.rs 失败则本闸形同虚设，先自检');

  installThrottleDialog();
  const capture = (await pageProbe()).overlayCapture as Record<string, unknown>;
  const emitted = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      emitted.add(key);
      walk(child);
    }
  };
  walk(capture);

  const undeclared = [...emitted].filter((key) => !declared.has(key));
  assert.deepEqual(
    undeclared,
    [],
    `页面规则产出了 Rust 未声明的字段，样本里会静默丢失：${undeclared.join(', ')}`,
  );
});
