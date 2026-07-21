import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { FacebookLikeExecutor } from '../../src/facebook/like-executor.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import type { OverlayKind, OverlayMonitor } from '../../src/browse/overlay-monitor.js';

/**
 * 点赞执行器（change facebook-note-scoped-targeting 后）：
 * **按命令携带的规范帖身份解析出唯一目标卡**再动手，绝不 DOM 序回落；点击/校验绑定同一张卡。
 */

/** 按 in-page 脚本阶段（resolve / rect / locate / click / verify / cleartag）返回预置 JSON 的 CDP 桩。 */
function fakeCdp(phases: {
  resolve?: unknown;
  rect?: unknown | unknown[];
  locate?: unknown;
  click?: unknown;
  verify?: unknown | unknown[];
  onEval?: (expr: string) => void;
}): BrowseCdp {
  let rectCall = 0;
  let verifyCall = 0;
  const pick = (v: unknown | unknown[], i: number): unknown =>
    Array.isArray(v) ? v[Math.min(i, v.length - 1)] : v;
  return {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {} as never;
      const expr = String(params?.expression ?? '');
      phases.onEval?.(expr);
      let value: unknown = {};
      if (expr.includes('/*aidcp:resolve*/')) value = phases.resolve ?? { status: 'ok', targetId: 'fb:g:1' };
      else if (expr.includes('/*aidcp:rect*/')) value = pick(phases.rect ?? { found: true, top: 120, bottom: 500, viewportH: 800 }, rectCall++);
      else if (expr.includes('/*aidcp:locate*/')) value = phases.locate ?? { found: true, already: false, label: '留下心情', text: '' };
      else if (expr.includes('/*aidcp:click*/')) value = phases.click ?? { clicked: true };
      else if (expr.includes('/*aidcp:verify*/')) value = pick(phases.verify ?? { tagged: true, identityMatch: true, found: true, reacted: true }, verifyCall++);
      else if (expr.includes('/*aidcp:cleartag*/')) value = { cleared: true };
      return { result: { value: JSON.stringify(value) } } as never;
    },
  };
}

function fakeMonitor(kind: OverlayKind): OverlayMonitor {
  return {
    get state() {
      return kind;
    },
    probeNow: async () => kind,
    start: () => {},
    stop: () => {},
    tick: async () => {},
  } as unknown as OverlayMonitor;
}

const fastOpts = { verifyTimeoutMs: 60, verifyPollMs: 5, settleMs: 0, scrollRounds: 3 };
const noSleep = { sleep: async () => {}, random: () => 0.5 };
const NOTE = 'https://www.facebook.com/groups/111/posts/BBB/';

test('fb-like: 目标卡按钮状态真翻转 → ok:true + executed', async () => {
  const exec = new FacebookLikeExecutor({ cdp: fakeCdp({}), ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE });
  assert.equal(r.ok, true);
  assert.equal(r.executed, true);
  assert.equal(r.reason, undefined);
});

test('fb-like: 页面上解析不到目标卡 → no_target（绝不假成功、绝不改点别的卡）', async () => {
  let clicked = false;
  const cdp = fakeCdp({
    resolve: { status: 'no_target', targetId: 'fb:111:BBB' },
    onEval: (e) => {
      if (e.includes('/*aidcp:click*/')) clicked = true;
    },
  });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_target');
  assert.equal(r.executed, false);
  assert.equal(clicked, false);
});

test('fb-like: 同层 >1 张卡命中同一身份 → ambiguous_target（诚实拒，绝不猜一张点）', async () => {
  let clicked = false;
  const cdp = fakeCdp({
    resolve: { status: 'ambiguous_target' },
    onEval: (e) => {
      if (e.includes('/*aidcp:click*/')) clicked = true;
    },
  });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE });
  assert.equal(r.reason, 'ambiguous_target');
  assert.equal(r.executed, false);
  assert.equal(clicked, false);
});

test('fb-like: noteId 派生不出规范帖身份（坏链接）→ no_target，连页面都不碰', async () => {
  let evaluated = 0;
  const cdp = fakeCdp({ onEval: () => (evaluated += 1) });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: 'javascript:void(0)' });
  assert.equal(r.reason, 'no_target');
  assert.equal(r.executed, false);
  assert.equal(evaluated, 0, '身份派生不出就该当场拒，绝不进页面「碰运气找一张卡」');
});

test('fb-like: 目标卡内无帖级 react 按钮 → no_target', async () => {
  const exec = new FacebookLikeExecutor({ cdp: fakeCdp({ locate: { found: false, already: false } }), ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE });
  assert.equal(r.reason, 'no_target');
  assert.equal(r.executed, false);
});

test('fb-like: 已赞 → already_liked（不重复点、不执行）', async () => {
  const cdp = fakeCdp({ locate: { found: true, already: true, label: '取消赞', text: '赞' } });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE });
  assert.equal(r.reason, 'already_liked');
  assert.equal(r.executed, false);
});

test('fb-like: 点击后状态未翻转 → state_unchanged（诚实，绝不假成功）', async () => {
  const cdp = fakeCdp({ verify: { tagged: true, identityMatch: true, found: true, reacted: false, label: '留下心情', text: '' } });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'state_unchanged');
  assert.equal(r.executed, true); // 点了但没生效——诚实回报「执行过但未变」
});

test('fb-like: 被点卡在校验前从 DOM 消失 → verify_indeterminate，且绝不重试点击', async () => {
  let clicks = 0;
  const cdp = fakeCdp({
    verify: { tagged: false, identityMatch: false, found: false, reacted: false },
    onEval: (e) => {
      if (e.includes('/*aidcp:click*/')) clicks += 1;
    },
  });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'verify_indeterminate');
  assert.equal(r.executed, true, '点击已派发——诚实说「点过了但无法确认」，不冒充成功也不冒充没点');
  assert.equal(clicks, 1, '不可重试：绝不重新解析后再点一次（会重复点赞或点到别的卡）');
});

test('fb-like: 标记节点被回收复用成别的帖 → verify_indeterminate（身份不符不认成功）', async () => {
  const cdp = fakeCdp({ verify: { tagged: true, identityMatch: false, found: true, reacted: true } });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE });
  assert.equal(r.reason, 'verify_indeterminate');
  assert.equal(r.ok, false, '身份对不上的「已反应」绝不认成功');
});

test('fb-like: 点击前复检到验证码 → blocked_by_captcha，不点击', async () => {
  let clicked = false;
  const cdp = fakeCdp({
    onEval: (e) => {
      if (e.includes('/*aidcp:click*/')) clicked = true;
    },
  });
  const exec = new FacebookLikeExecutor({ cdp, overlayMonitor: fakeMonitor('captcha'), ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE });
  assert.equal(r.reason, 'blocked_by_captcha');
  assert.equal(r.executed, false);
  assert.equal(clicked, false);
});

test('fb-like[shadow]: 目标存在但只记不执行 → shadow（executed=false，云端不记账）', async () => {
  let clicked = false;
  const cdp = fakeCdp({
    onEval: (e) => {
      if (e.includes('/*aidcp:click*/')) clicked = true;
    },
  });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE, shadow: true });
  assert.equal(r.reason, 'shadow');
  assert.equal(r.executed, false);
  assert.equal(clicked, false, 'shadow 模式绝不派发点击');
});

test('fb-like[shadow]: 目标不存在 → 仍诚实 no_target（不冒充 shadow 成功）', async () => {
  const cdp = fakeCdp({ resolve: { status: 'no_target' } });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE, shadow: true });
  assert.equal(r.reason, 'no_target');
});

// ─── 拟人有界滚动：目标在视口外先滚进来，绝不 scrollIntoView 瞬移 ───

test('fb-like: 目标在视口下方 → 拟人 wheel 滚进视野后再定位（不瞬移）', async () => {
  let wheels = 0;
  let clickExpr = '';
  const cdp: BrowseCdp = {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Input.dispatchMouseEvent') {
        if (params?.type === 'mouseWheel') wheels += 1;
        return {} as never;
      }
      if (method !== 'Runtime.evaluate') return {} as never;
      const expr = String(params?.expression ?? '');
      const json = (v: unknown) => ({ result: { value: JSON.stringify(v) } }) as never;
      if (expr.includes('/*aidcp:resolve*/')) return json({ status: 'ok', targetId: 'fb:111:BBB' });
      if (expr.includes('/*aidcp:rect*/')) {
        // 第一轮：卡在视口下方 2000px；滚过一轮后落进可接受带。
        return json(wheels === 0 ? { found: true, top: 2000, bottom: 2600, viewportH: 800 } : { found: true, top: 160, bottom: 760, viewportH: 800 });
      }
      if (expr.includes('/*aidcp:locate*/')) return json({ found: true, already: false, label: '留下心情', text: '' });
      if (expr.includes('/*aidcp:click*/')) {
        clickExpr = expr;
        return json({ clicked: true });
      }
      if (expr.includes('/*aidcp:verify*/')) return json({ tagged: true, identityMatch: true, found: true, reacted: true });
      if (expr.includes('window.innerWidth')) return json({ w: 1280, h: 800 });
      if (expr.includes('window.scrollY')) return json({ y: wheels * 100 });
      return json({});
    },
  };
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE });
  assert.equal(r.ok, true);
  assert.ok(wheels > 0, '必须派发真实 wheel 手势把目标滚进视野');
  assert.ok(!clickExpr.includes('scrollIntoView'), '点击脚本里绝不能再有 scrollIntoView 瞬移');
});

test('fb-like: 有界滚动后目标仍不可见 → target_not_visible（绝不对当前居中的卡下手）', async () => {
  let clicked = false;
  const cdp = fakeCdp({
    rect: { found: true, top: 9000, bottom: 9600, viewportH: 800 }, // 怎么滚都到不了
    onEval: (e) => {
      if (e.includes('/*aidcp:click*/')) clicked = true;
    },
  });
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE });
  assert.equal(r.reason, 'target_not_visible');
  assert.equal(r.executed, false);
  assert.equal(clicked, false);
});

// ─── jsdom：对真实 DOM 跑页内三段式解析/定位/点击/校验（不桩 JSON 边界，验真逻辑）───

function stubRects(dom: JSDOM): void {
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return { left: 10, top: 100, right: 60, bottom: 130, width: 50, height: 30 };
    },
  });
}

function jsdomCdp(dom: JSDOM): BrowseCdp {
  return {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {} as never;
      const value = dom.window.eval(String(params?.expression ?? ''));
      return { result: { value: typeof value === 'string' ? value : JSON.stringify(value) } } as never;
    },
  };
}

/** FB 帖级动作栏：计数汇总（非 toggle）/ 反应项「：赞」（非 toggle）/ 留下心情 toggle / 发表评论 / 分享。 */
function actionBar(opts: { author: string; countText?: string; withToggle?: boolean; withReactionOption?: boolean } = { author: 'X' }): string {
  const reactionOption = opts.withReactionOption ? `<div role="button" aria-label="给${opts.author}的帖子留下心情：赞">赞</div>` : '';
  const toggle = opts.withToggle === false ? '' : `<div role="button" aria-label="给${opts.author}的帖子留下心情"></div>`;
  return (
    '<div class="action-bar">' +
    `<div role="button" aria-label="赞">${opts.countText ?? '3,829'}</div>` +
    reactionOption +
    toggle +
    `<div role="button" aria-label="评论${opts.author}的帖子">评论</div>` +
    '<div role="button" aria-label="发送给好友或发布到你的个人主页。">12</div>' +
    '</div>'
  );
}

function card(id: string, author: string, href: string, extra = ''): string {
  return (
    `<div role="article" id="${id}">` +
    `<h2><span>${author}</span></h2><a href="${href}">1天</a>` +
    actionBar({ author }) +
    extra +
    '</div>'
  );
}

function lightCard(id: string, author: string, href: string): string {
  return (
    `<div id="${id}">` +
    `<div data-ad-rendering-role="profile_name"><h4><a href="/${id}-author">${author}</a></h4></div>` +
    `<a href="${href}">1天</a>` +
    `<div data-ad-rendering-role="story_message">${id} body</div>` +
    actionBar({ author }) +
    '</div>'
  );
}

function feedDom(cardsHtml: string, url = 'https://www.facebook.com/groups/111'): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body><div role="feed">${cardsHtml}</div></body></html>`, {
    runScripts: 'outside-only',
    url,
  });
  stubRects(dom);
  return dom;
}

function toggleOf(dom: JSDOM, cardId: string): HTMLElement {
  return dom.window.document.querySelector(`#${cardId} [aria-label$="留下心情"]`) as HTMLElement;
}

/** 点了 toggle → 空文案变反应词「赞」（FB 真机行为：已赞态）。 */
function wireToggle(dom: JSDOM, cardId: string, onClick?: () => void): HTMLElement {
  const el = toggleOf(dom, cardId);
  el.addEventListener('click', () => {
    el.textContent = '赞';
    onClick?.();
  });
  return el;
}

const A = 'https://www.facebook.com/groups/111/posts/AAA/?__cft__[0]=x';
const B = 'https://www.facebook.com/groups/111/posts/BBB/?__cft__[0]=y';
const C = 'https://www.facebook.com/groups/111/posts/CCC/';

test('fb-like[jsdom]: 信息流里点第 N 张卡 → 只有第 N 张翻转，前面的卡一动不动（红线：绝不 DOM 序回落）', async () => {
  const dom = feedDom(card('c1', 'Ann', A) + card('c2', 'Bob', B) + card('c3', 'Cid', C));
  let c1Clicked = false;
  let c3Clicked = false;
  wireToggle(dom, 'c1', () => (c1Clicked = true));
  wireToggle(dom, 'c2');
  wireToggle(dom, 'c3', () => (c3Clicked = true));
  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: 'https://www.facebook.com/groups/111/posts/BBB/' });
  assert.equal(r.ok, true);
  assert.equal(r.executed, true);
  assert.equal(toggleOf(dom, 'c2').textContent, '赞', '命令指定的第 2 张卡真翻转');
  assert.equal(c1Clicked, false, 'DOM 序第一张卡绝不能被点（修复前正是这里点错）');
  assert.equal(c3Clicked, false);
});

test('fb-like[jsdom]: 无 feed/article 的轻量布局仍按规范身份锁定目标卡，且见证 surface=feed', async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main>' + lightCard('l1', 'Ann', A) + lightCard('l2', 'Bob', B) + '</main></body></html>',
    { runScripts: 'outside-only', url: 'https://www.facebook.com/' },
  );
  stubRects(dom);
  let firstClicked = false;
  wireToggle(dom, 'l1', () => (firstClicked = true));
  wireToggle(dom, 'l2');

  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: B });

  assert.equal(r.ok, true);
  assert.equal(toggleOf(dom, 'l2').textContent, '赞');
  assert.equal(firstClicked, false, '轻量布局也绝不 DOM 序回落到第一张');
  assert.equal(r.observation?.surface, 'feed', '无 role=feed 时见证仍诚实标成 feed');
  assert.equal(r.observation?.noteId, 'fb:BBB');
});

test('fb-like[jsdom]: 无 permalink 的越南语轻量视频按 data-video-id 精确点赞并由同卡 Gỡ Thích 验证', async () => {
  const videoCard = (id: string, author: string) =>
    `<section id="video-${id}"><h4><a href="/${author}">${author}</a></h4>` +
    `<div data-ad-rendering-role="story_message">video ${id}</div><div data-video-id="${id}"><video></video></div>` +
    '<div class="action-bar"><div role="button" aria-label="Thích"></div>' +
    '<div role="button" aria-label="Thích: 27K người">27K</div>' +
    '<div role="button" aria-label="Viết bình luận"></div></div></section>';
  const dom = feedDom(videoCard('101', 'Ann') + videoCard('202', 'Bob'));
  const first = dom.window.document.querySelector('#video-101 [aria-label="Thích"]') as HTMLElement;
  const target = dom.window.document.querySelector('#video-202 [aria-label="Thích"]') as HTMLElement;
  let firstClicked = false;
  first.addEventListener('click', () => { firstClicked = true; first.setAttribute('aria-label', 'Gỡ Thích'); });
  target.addEventListener('click', () => { target.setAttribute('aria-label', 'Gỡ Thích'); });

  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const result = await exec.like({ noteId: 'https://www.facebook.com/watch?v=202' });

  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.equal(target.getAttribute('aria-label'), 'Gỡ Thích');
  assert.equal(firstClicked, false, '同层第一张轻量视频不能被 DOM 序回落误点');
  assert.equal(result.observation?.noteId, 'fb:202');
});

test('fb-like[jsdom]: 目标帖不在页面上 → no_target，DOM 序第一张卡一动不动', async () => {
  const dom = feedDom(card('c1', 'Ann', A) + card('c2', 'Bob', B));
  let anyClick = false;
  wireToggle(dom, 'c1', () => (anyClick = true));
  wireToggle(dom, 'c2', () => (anyClick = true));
  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: 'https://www.facebook.com/groups/111/posts/ZZZ/' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_target');
  assert.equal(anyClick, false);
});

test('fb-like[jsdom]: 卡上只有坏链接（javascript:/#）→ 派生不出身份 → no_target，不误点', async () => {
  const dom = feedDom(
    '<div role="article" id="c1"><a href="javascript:void(0)">1天</a><a href="#">空操作</a>' + actionBar({ author: 'Ann' }) + '</div>',
  );
  let clicked = false;
  wireToggle(dom, 'c1', () => (clicked = true));
  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: 'https://www.facebook.com/groups/111/posts/BBB/' });
  assert.equal(r.reason, 'no_target');
  assert.equal(clicked, false);
});

test('fb-like[jsdom]: 同层两张卡撞同一身份 → ambiguous_target，两张都不点', async () => {
  const dom = feedDom(card('c1', 'Ann', B) + card('c2', 'Bob', B));
  let clicks = 0;
  wireToggle(dom, 'c1', () => (clicks += 1));
  wireToggle(dom, 'c2', () => (clicks += 1));
  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: 'https://www.facebook.com/groups/111/posts/BBB/' });
  assert.equal(r.reason, 'ambiguous_target');
  assert.equal(clicks, 0);
});

test('fb-like[jsdom]: 详情弹层（主帖 + 嵌套评论 article + 背景同键 feed 卡）→ 只锁主帖', async () => {
  // 评论 article 嵌在主帖 article 内（真机结构），且评论里也带指向本帖的链接（评论 permalink）。
  const commentArticle =
    '<div role="article" id="cmt"><a href="https://www.facebook.com/groups/111/posts/BBB/?comment_id=999">2小时</a>' +
    '<div class="action-bar"><div role="button" aria-label="给Zoe的评论留下心情"></div><div role="button" aria-label="回复Zoe的评论">回复</div></div></div>';
  const dom = new JSDOM(
    '<!doctype html><html><body>' +
      `<div role="feed">${card('bg', 'Bob', B)}</div>` + // 背景 feed 里同一帖的卡（同键）
      `<div role="dialog">${card('main', 'Bob', B, commentArticle)}</div>` +
      '</body></html>',
    { runScripts: 'outside-only', url: 'https://www.facebook.com/groups/111/posts/BBB/' },
  );
  stubRects(dom);
  let bgClicked = false;
  let cmtClicked = false;
  wireToggle(dom, 'bg', () => (bgClicked = true));
  wireToggle(dom, 'main');
  (dom.window.document.querySelector('#cmt [aria-label="给Zoe的评论留下心情"]') as HTMLElement).addEventListener('click', () => {
    cmtClicked = true;
  });
  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: 'https://www.facebook.com/groups/111/posts/BBB/' });
  assert.equal(r.ok, true, '三段式：作用域取最后打开的可见 dialog → 顶层非嵌套候选 → 身份匹配');
  assert.equal(toggleOf(dom, 'main').textContent, '赞');
  assert.equal(bgClicked, false, '背景 feed 里的同键卡不在作用域内，绝不被点');
  assert.equal(cmtClicked, false, '嵌套评论 article 的 react 是评论级，绝不被当成帖级');
});

test('fb-like[jsdom]: 被点卡在校验前从 DOM 消失（虚拟化回收）→ verify_indeterminate', async () => {
  const dom = feedDom(card('c1', 'Ann', A) + card('c2', 'Bob', B));
  const el = toggleOf(dom, 'c2');
  el.addEventListener('click', () => {
    dom.window.document.querySelector('#c2')?.remove(); // 点完卡就被回收
  });
  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: 'https://www.facebook.com/groups/111/posts/BBB/' });
  assert.equal(r.reason, 'verify_indeterminate');
  assert.equal(r.executed, true);
  assert.equal(dom.window.document.querySelector('#c1 [aria-label$="留下心情"]')?.textContent, '', '绝不改点第一张卡兜底');
});

test('fb-like[jsdom]: 反应【计数汇总】按钮（赞 + 数字文案）绝不当 toggle（critical 回归）', async () => {
  const dom = feedDom(
    `<div role="article" id="c1"><a href="${B}">1天</a>` + actionBar({ author: 'Bob', countText: '10,532', withReactionOption: true }) + '</div>',
  );
  const toggle = wireToggle(dom, 'c1');
  let optionClicked = false;
  (dom.window.document.querySelector('[aria-label="给Bob的帖子留下心情：赞"]') as HTMLElement).addEventListener('click', () => {
    optionClicked = true;
  });
  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: 'https://www.facebook.com/groups/111/posts/BBB/' });
  assert.equal(r.ok, true);
  assert.equal(toggle.textContent, '赞');
  assert.equal(dom.window.document.querySelector('[aria-label="赞"]')?.textContent, '10,532', '计数按钮不是 toggle，不能被点');
  assert.equal(optionClicked, false, '反应项「：赞」不是主 toggle');
});

test('fb-like[jsdom]: 目标卡只有计数按钮、无 toggle → no_target（绝不把计数按钮当 toggle 点）', async () => {
  const dom = feedDom(`<div role="article" id="c1"><a href="${B}">1天</a>` + actionBar({ author: 'Bob', withToggle: false }) + '</div>');
  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: 'https://www.facebook.com/groups/111/posts/BBB/' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_target');
  assert.equal(r.executed, false);
});

test('fb-like[jsdom] 两段: 反应浮层「赞」项走 CDP 坐标点击、落点=浮层项坐标（非首卡回归：不点到别卡「赞」，簇82）', async () => {
  // 真机双根因（本轮实证）：① feed 里**每张卡**的 Like/计数按钮 aria-label 都恰是「赞」，反应浮层是 portal、
  // document 序排在所有卡之后——旧 picker-commit 全文档搜 `/^赞$/` 会命中上方另一张卡的「赞」（点错帖 + 目标浮层
  // 永不提交）；② 浮层反应项监听真实指针事件，in-page element.click 被当 hover 忽略、不提交，必须 CDP 坐标点击。
  // 修法：只在浮层 dialog 内定位「赞」项**坐标**，交由 dispatchClick 走 press/release。本测断言落点=浮层项坐标
  // (620,820)，绝非 feed 卡按钮的默认 stub 坐标(35,115)。
  const dom = feedDom(card('c1', 'Ann', A) + card('c2', 'Bob', B) + card('c3', 'Cid', C));
  const doc = dom.window.document;
  const c2toggle = toggleOf(dom, 'c2');
  // 点目标卡「留下心情」→ 弹浮层（portal 在 body 末尾）；浮层「赞」项 rect 覆写为独特**屏内**坐标 (600,380,40x40)→中心(620,400)。
  c2toggle.addEventListener('click', () => {
    const dlg = doc.createElement('div');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-label', '心情');
    dlg.innerHTML =
      '<div role="button" aria-label="赞">赞</div>' +
      '<div role="button" aria-label="大爱">大爱</div>' +
      '<div role="button" aria-label="哇">哇</div>';
    doc.body.appendChild(dlg);
    const like = dlg.querySelector('[aria-label="赞"]') as HTMLElement;
    Object.defineProperty(like, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 600, top: 380, right: 640, bottom: 420, width: 40, height: 40, x: 600, y: 380, toJSON() {} }),
    });
  });
  const pressed: { x: number; y: number }[] = [];
  // 自定义 CDP：Runtime.evaluate 跑真 in-page JS；Input.dispatchMouseEvent 记录 press，命中浮层坐标即真提交（翻转目标卡）。
  const cdp: BrowseCdp = {
    async send(method: string, params?: Record<string, unknown>) {
      if (method === 'Runtime.evaluate') {
        const v = dom.window.eval(String(params?.expression ?? ''));
        return { result: { value: typeof v === 'string' ? v : JSON.stringify(v) } } as never;
      }
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') {
        const x = Number(params.x);
        const y = Number(params.y);
        pressed.push({ x, y });
        if (Math.abs(x - 620) <= 20 && Math.abs(y - 400) <= 20) {
          c2toggle.textContent = '赞'; // 坐标命中浮层「赞」项 → 真提交，目标卡翻转
          doc.querySelector('[role="dialog"][aria-label="心情"]')?.remove();
        }
      }
      return {} as never;
    },
  };
  // 确定性制造“第二段坐标轨迹耗尽 60ms 确认窗口”：写已派发后仍必须至少复读一次，不能误报 state_unchanged。
  let delayedPickerPointer = false;
  const slowPickerSleep = async (ms: number) => {
    if (!delayedPickerPointer && ms > 0 && doc.querySelector('[role="dialog"][aria-label="心情"]')) {
      delayedPickerPointer = true;
      await new Promise<void>((resolve) => setTimeout(resolve, fastOpts.verifyTimeoutMs + 20));
    }
  };
  const exec = new FacebookLikeExecutor({ cdp, sleep: slowPickerSleep, random: noSleep.random }, fastOpts);
  const r = await exec.like({ noteId: 'https://www.facebook.com/groups/111/posts/BBB/' });
  assert.equal(delayedPickerPointer, true, '回归夹具必须让第二段坐标轨迹越过原确认窗口');
  assert.equal(r.ok, true, '坐标点击浮层「赞」项 → 目标卡翻转');
  assert.equal(c2toggle.textContent, '赞');
  const hitPicker = pressed.find((p) => Math.abs(p.x - 620) <= 20 && Math.abs(p.y - 400) <= 20);
  assert.ok(hitPicker, '必须对浮层「赞」项坐标(620,400)派发 mousePressed（scoped 到浮层，非首卡也对）');
  const hitCard = pressed.find((p) => Math.abs(p.x - 35) <= 8 && Math.abs(p.y - 115) <= 8);
  assert.equal(hitCard, undefined, '绝不点到 feed 卡「赞」按钮坐标(35,115)（修复前全文档搜索会点错帖）');
});

test('fb-like[jsdom]: 命令不带 noteId（老云端）→ 回落 location.href 派生身份，仍不 DOM 序回落', async () => {
  const dom = new JSDOM(
    `<!doctype html><html><body><div role="feed">${card('c1', 'Ann', A)}${card('c2', 'Bob', B)}</div></body></html>`,
    { runScripts: 'outside-only', url: 'https://www.facebook.com/groups/111/posts/BBB/' },
  );
  stubRects(dom);
  let c1Clicked = false;
  wireToggle(dom, 'c1', () => (c1Clicked = true));
  wireToggle(dom, 'c2');
  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like({});
  assert.equal(r.ok, true);
  assert.equal(toggleOf(dom, 'c2').textContent, '赞', '按当前 URL 的帖身份锁卡');
  assert.equal(c1Clicked, false);
});

test('fb-like[jsdom]: 单帖详情页、卡内派生不出身份 → 由 URL 佐证锁定唯一那张卡（不是 DOM 序回落）', async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div role="article" id="only"><h2>Bob</h2>' +
      '<a href="/groups/111/members">群成员</a>' + // 卡内没有任何可派生帖身份的链接
      actionBar({ author: 'Bob' }) +
      '</div></body></html>',
    { runScripts: 'outside-only', url: 'https://www.facebook.com/groups/111/posts/BBB/' },
  );
  stubRects(dom);
  wireToggle(dom, 'only');
  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: 'https://www.facebook.com/groups/111/posts/BBB/' });
  assert.equal(r.ok, true);
  assert.equal(toggleOf(dom, 'only').textContent, '赞');
});

test('fb-like[jsdom]: 单帖态兜底不越界——URL 是别的帖 → no_target（唯一性≠随便点）', async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div role="article" id="only"><h2>Bob</h2><a href="/groups/111/members">群成员</a>' +
      actionBar({ author: 'Bob' }) +
      '</div></body></html>',
    { runScripts: 'outside-only', url: 'https://www.facebook.com/groups/111/posts/OTHER/' },
  );
  stubRects(dom);
  let clicked = false;
  wireToggle(dom, 'only', () => (clicked = true));
  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: 'https://www.facebook.com/groups/111/posts/BBB/' });
  assert.equal(r.reason, 'no_target');
  assert.equal(clicked, false);
});

// ─── 对抗性评审复现的两条回归（都能在真机上把点赞/评论整死或点错卡）───

test('fb-like[jsdom]: 卡头作者头像是 /people/<slug>/pfbid…/ 形态 → 仍锁目标卡（绝不把作者身份当卡身份）', async () => {
  // FB 卡头 DOM 序：头像链接 → 作者名链接 → 时间戳 permalink。2022 后无自定义用户名的账号，其主页链接
  // 也带 pfbid 段——若身份派生不看「帖子形状」，作者链接会抢在时间戳之前定义卡身份 → 该作者每张卡永久 no_target。
  const author = '<a href="https://www.facebook.com/people/Nguyen-Van-A/pfbid02Xk9aBcDeF/"><img/></a>';
  const dom = feedDom(
    `<div role="article" id="c1">${author}<h2><a href="https://www.facebook.com/people/Nguyen-Van-A/pfbid02Xk9aBcDeF/">Nguyen</a></h2>` +
      `<a href="${B}">1天</a>` +
      actionBar({ author: 'Nguyen' }) +
      '</div>',
  );
  wireToggle(dom, 'c1');
  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: 'https://www.facebook.com/groups/111/posts/BBB/' });
  assert.equal(r.ok, true);
  assert.equal(toggleOf(dom, 'c1').textContent, '赞');
});

test('fb-like[jsdom]: 页面上挂着不含帖子的弹层（聊天/同意条/发帖框）→ 作用域不被劫持，照常锁 feed 里的目标卡', async () => {
  // 无条件「取最后一个可见 dialog」会让作用域落在一个没有任何帖子的弹层里 → 目标永远解析不到 → 点赞永久失败。
  const dom = new JSDOM(
    '<!doctype html><html><body>' +
      `<div role="feed">${card('c1', 'Ann', A)}${card('c2', 'Bob', B)}</div>` +
      '<div role="dialog" id="chat"><div role="textbox" contenteditable="true" aria-label="输入消息…"></div></div>' +
      '</body></html>',
    { runScripts: 'outside-only', url: 'https://www.facebook.com/groups/111' },
  );
  stubRects(dom);
  let c1Clicked = false;
  wireToggle(dom, 'c1', () => (c1Clicked = true));
  wireToggle(dom, 'c2');
  const exec = new FacebookLikeExecutor({ cdp: jsdomCdp(dom), ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: 'https://www.facebook.com/groups/111/posts/BBB/' });
  assert.equal(r.ok, true, '无帖弹层不得成为作用域根');
  assert.equal(toggleOf(dom, 'c2').textContent, '赞');
  assert.equal(c1Clicked, false);
});

test('fb-like: CDP/eval 异常 → nav_error（不冒充「页面上没这张卡」）', async () => {
  const cdp: BrowseCdp = {
    send: async () => {
      throw new Error('CDP transient failure');
    },
  };
  const exec = new FacebookLikeExecutor({ cdp, ...noSleep }, fastOpts);
  const r = await exec.like({ noteId: NOTE });
  assert.equal(r.reason, 'nav_error');
  assert.equal(r.executed, false);
});
