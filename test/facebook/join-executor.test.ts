import test from 'node:test';
import assert from 'node:assert/strict';

import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import type { OverlayKind, OverlayMonitor } from '../../src/browse/overlay-monitor.js';
import { FacebookJoinExecutor, classifyCtaLabel } from '../../src/facebook/join-executor.js';

interface RawJoinObservation {
  pageUrl?: string;
  title?: string;
  mainCtaText?: string | null;
  mainCtaAria?: string | null;
  headerText?: string | null;
  modalText?: string | null;
  membershipSignals?: string[];
  loginRequired?: boolean;
  captchaDetected?: boolean;
  questionnaireRequired?: boolean;
  pendingRequest?: boolean;
  navError?: string | null;
  documentReady?: string;
  joinButton?: { found: boolean; disabled?: boolean; x?: number; y?: number; text?: string | null; aria?: string | null };
}

function obs(over: Partial<RawJoinObservation> = {}): RawJoinObservation {
  return {
    pageUrl: 'https://www.facebook.com/groups/123',
    title: 'Group',
    mainCtaText: 'Join group',
    mainCtaAria: 'Join group',
    headerText: 'Group Join group',
    modalText: null,
    membershipSignals: [],
    loginRequired: false,
    captchaDetected: false,
    questionnaireRequired: false,
    pendingRequest: false,
    navError: null,
    joinButton: { found: true, disabled: false, x: 100, y: 50, text: 'Join group', aria: 'Join group' },
    ...over,
  };
}

class FakeCdp implements BrowseCdp {
  navigations: string[] = [];
  /** 加入点击次数（现由页面内 JS element.click() 完成，标记表达式 __FB_JOIN_CLICK__ 计入）。 */
  clicks: Array<{ x: number; y: number }> = [];
  /** 原始坐标 mousePressed 次数——改用 JS 点击后加入路径应恒为 0（坐标点击真机不生效已移除）。 */
  mousePresses = 0;
  /** 模拟页面内 JS 点击是否命中到「加入」按钮；置 false 复现「点击瞬间按钮消失」。 */
  jsClickSucceeds = true;
  escapes = 0;
  private evalCount = 0;

  constructor(private readonly observations: RawJoinObservation[] = [obs()]) {}

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'Page.navigate') {
      this.navigations.push(String(params.url));
      return {} as T;
    }
    if (method === 'Runtime.evaluate') {
      // JS 加入点击 eval（带唯一标记）：记一次加入点击、返回 clicked，不消费观察序列。
      if (String(params.expression ?? '').includes('__FB_JOIN_CLICK__')) {
        if (this.jsClickSucceeds) this.clicks.push({ x: -1, y: -1 });
        return { result: { value: JSON.stringify({ clicked: this.jsClickSucceeds }) } } as T;
      }
      const current = this.observations[Math.min(this.evalCount, this.observations.length - 1)] ?? obs();
      this.evalCount++;
      return { result: { value: JSON.stringify(current) } } as T;
    }
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mousePressed') this.mousePresses++;
      return {} as T;
    }
    if (method === 'Input.dispatchKeyEvent') {
      if (params.key === 'Escape' && params.type === 'keyDown') this.escapes++;
      return {} as T;
    }
    return {} as T;
  }
}

function overlay(kind: OverlayKind): OverlayMonitor {
  return {
    state: kind,
    probeNow: async () => kind,
    start: () => {},
    stop: () => {},
  };
}

// 默认注入「无同意条」no-op：隔离 join 逻辑测试，不让真 detector 多消费一次序列型 eval。
// cookie 同意浮层的真实行为由 consent.test.ts 覆盖，wiring 由本文件专门的 consent 用例覆盖。
const NO_CONSENT = async () => ({ handled: false, cleared: false, attempts: 0 });

function makeExecutor(cdp: FakeCdp, overlayMonitor?: OverlayMonitor) {
  return new FacebookJoinExecutor(
    {
      cdp,
      ...(overlayMonitor ? { overlayMonitor } : {}),
      acceptConsent: NO_CONSENT,
      sleep: async () => {},
      logger: () => {},
    },
    { settleMs: 0, waitAfterClickMs: 0, readyTimeoutMs: 2000, pollMs: 500, postClickTimeoutMs: 2000 },
  );
}

test('fb-join-executor: 非 Facebook group URL → not_facebook 且不导航', async () => {
  const cdp = new FakeCdp();
  const r = await makeExecutor(cdp).joinGroup('https://evil.example.com/groups/123', { click: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_facebook');
  assert.equal(cdp.navigations.length, 0);
});

test('fb-join-executor: observe-only 返回结构化 observation，不点击', async () => {
  const cdp = new FakeCdp([obs()]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'observation_only');
  assert.equal(r.clicked, false);
  assert.equal(cdp.clicks.length, 0);
  assert.equal(r.observation?.mainCtaText, 'Join group');
});

test('fb-join-executor: click=true 点击一次 Join，post observation 显示 joined 才 ok=true', async () => {
  const cdp = new FakeCdp([
    obs(),
    obs({
      mainCtaText: 'Joined',
      mainCtaAria: 'Joined',
      membershipSignals: ['You are now a member'],
      joinButton: { found: false },
    }),
  ]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123?x=1', { click: true });
  assert.equal(r.ok, true);
  assert.equal(r.clicked, true);
  assert.equal(cdp.navigations[0], 'https://www.facebook.com/groups/123');
  assert.equal(cdp.clicks.length, 1);
  assert.equal(r.postObservation?.mainCtaText, 'Joined');
});

test('fb-join-executor: pre-click 已有问卷门槛时 fail-closed，不点击不提交', async () => {
  const cdp = new FakeCdp([
    obs({
      modalText: 'Membership questions are required',
      questionnaireRequired: true,
    }),
  ]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'questionnaire_required');
  assert.equal(r.clicked, false);
  assert.equal(cdp.clicks.length, 0);
  assert.equal(cdp.escapes, 0);
});

test('fb-join-executor: post-click pending/questionnaire 不冒充成功', async () => {
  const cdp = new FakeCdp([
    obs(),
    obs({
      modalText: 'Answer membership questions',
      questionnaireRequired: true,
      joinButton: { found: false },
    }),
  ]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'questionnaire_required');
  assert.equal(r.clicked, true);
  assert.equal(cdp.clicks.length, 1);
  assert.equal(cdp.escapes, 0);
});

test('fb-join-executor: captcha overlay fail-closed，不点击', async () => {
  const cdp = new FakeCdp([obs()]);
  const r = await makeExecutor(cdp, overlay('captcha')).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked_by_captcha');
  assert.equal(r.clicked, false);
  assert.equal(cdp.clicks.length, 0);
  assert.equal(r.observation?.captchaDetected, true);
});

// ── change facebook-group-join-observe-i18n：Join 按钮多语识别（修复越南语等群 CTA 被 EN/ZH 精确匹配吞成 null）──
test('classifyCtaLabel: 多语 Join 标签均识别为 join', () => {
  for (const label of [
    'Join group', 'Join', '加入小组', '加入群组',
    'Tham gia nhóm',            // 越南语（本次真机故障的群）
    'Unirte al grupo', 'Únete', // 西语
    'Participar', 'Entrar no grupo', // 葡语
    'Gabung', 'Bergabung',      // 印尼语
    'Rejoindre le groupe',      // 法语
    'Beitreten',                // 德语
    'เข้าร่วมกลุ่ม',              // 泰语
    '참여하기',                  // 韩语
  ]) {
    assert.equal(classifyCtaLabel(label), 'join', `expected join for "${label}"`);
  }
});

test('classifyCtaLabel: 已加入 / 待批准语义优先于 join（避免子串误判）', () => {
  // "Đã tham gia"(已加入) 含 "tham gia"(加入) 子串——必须判 member、绝不判 join。
  assert.equal(classifyCtaLabel('Đã tham gia'), 'member');
  assert.equal(classifyCtaLabel('Joined'), 'member');
  assert.equal(classifyCtaLabel('已加入'), 'member');
  assert.equal(classifyCtaLabel('Leave group'), 'member');
  assert.equal(classifyCtaLabel('Rời nhóm'), 'member');           // 越南语「退出小组」
  assert.equal(classifyCtaLabel('Solicitud enviada'), 'pending'); // 西语「已申请」
  assert.equal(classifyCtaLabel('Đang chờ phê duyệt'), 'pending');// 越南语「待批准」
  assert.equal(classifyCtaLabel('Pending'), 'pending');
});

test('classifyCtaLabel: 空 / 无关标签 → 空（保持 fail-closed，不误当 join）', () => {
  assert.equal(classifyCtaLabel(''), '');
  assert.equal(classifyCtaLabel(null), '');
  assert.equal(classifyCtaLabel('Share'), '');
  assert.equal(classifyCtaLabel('Invite'), '');
  assert.equal(classifyCtaLabel('分享'), '');
});

test('fb-join-executor: 同意浮层清不掉 → blocked_by_consent，不点击 Join', async () => {
  const cdp = new FakeCdp([obs()]);
  const ex = new FacebookJoinExecutor(
    {
      cdp,
      acceptConsent: async () => ({ handled: true, cleared: false, attempts: 3, reason: 'blocked_by_consent' as const }),
      sleep: async () => {},
      logger: () => {},
    },
    { settleMs: 0, waitAfterClickMs: 0 },
  );
  const r = await ex.joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked_by_consent');
  assert.equal(r.clicked, false);
  assert.equal(cdp.clicks.length, 0);
});

test('fb-join-executor: 同意浮层清掉后继续正常入组判定', async () => {
  // consent 清除后，join 逻辑照常：observe-only 返回结构化 observation。
  const cdp = new FakeCdp([obs()]);
  const ex = new FacebookJoinExecutor(
    {
      cdp,
      acceptConsent: async () => ({ handled: true, cleared: true, attempts: 1 }),
      sleep: async () => {},
      logger: () => {},
    },
    { settleMs: 0, waitAfterClickMs: 0 },
  );
  const r = await ex.joinGroup('https://www.facebook.com/groups/123');
  assert.equal(r.reason, 'observation_only');
  assert.equal(r.observation?.mainCtaText, 'Join group');
});

// ── change fb-group-join-wait-render：就绪轮询——等页面真渲染出决定性信号再判定，别死等固定时长（FB 网络不稳）──
const EMPTY_OBS = () => obs({ mainCtaText: null, mainCtaAria: null, headerText: null, membershipSignals: [], joinButton: { found: false } });

test('fb-join-executor: 页面仍在加载（空观察）时轮询等待，直到加入按钮渲染出来再点击加入', async () => {
  // 前两次观察是"还在加载"（无按钮/无信号），第三次才渲染出加入按钮；点击后确认已加入。
  const cdp = new FakeCdp([
    EMPTY_OBS(),
    EMPTY_OBS(),
    obs(), // 第三次：加入按钮已渲染（默认 obs 即 joinButton.found + Join group）
    obs({ mainCtaText: 'Joined', mainCtaAria: 'Joined', membershipSignals: ['You are now a member'], joinButton: { found: false } }),
  ]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, true, '等到按钮渲染后成功加入');
  assert.equal(r.clicked, true);
  assert.equal(cdp.navigations.length, 1, '只导航一次（轮询不重复导航）');
  assert.equal(cdp.clicks.length, 1);
});

test('fb-join-executor: 触上限仍无决定性信号 → 诚实 no_button（点击路径），绝不假成功', async () => {
  const cdp = new FakeCdp([EMPTY_OBS()]); // 一直空
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_button', '等不到按钮就诚实报 no_button，不点击、不冒充成功');
  assert.equal(r.clicked, false);
  assert.equal(cdp.clicks.length, 0);
});

test('fb-join-executor: 观察态一直空 + observe-only → observation_only（诚实，不假成功）', async () => {
  const cdp = new FakeCdp([EMPTY_OBS()]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'observation_only');
  assert.equal(r.clicked, false);
});

// ── change fb-group-join-cta-precision：避开页面 chrome 误判 + 不因杂项 CTA 提前停轮询（真机:退出联想输入被裸「退出」误判致提前停在 loading）──
test('classifyCtaLabel: 页面 chrome / 无关词不误判（真机回归）', () => {
  assert.equal(classifyCtaLabel('退出联想输入'), '', '输入法 chrome，曾被裸「退出」误判成 member');
  assert.equal(classifyCtaLabel('查看推荐小组'), '', '含「小组」但非加入/退出');
  assert.equal(classifyCtaLabel('分享小组'), '');
  assert.equal(classifyCtaLabel('返回上一页'), '');
  assert.equal(classifyCtaLabel('Reunir equipo'), '', '含「unir」子串但非入组——裸 unir 已移除');
});

test('fb-join-executor: 杂项 CTA 文本（无真加入按钮/无成员/门槛信号）不算决定性，继续轮询到加入按钮出现', async () => {
  const cdp = new FakeCdp([
    obs({ mainCtaText: '退出联想输入', mainCtaAria: '退出联想输入', membershipSignals: [], joinButton: { found: false } }),
    obs(), // 真加入按钮渲染出来
    obs({ mainCtaText: 'Joined', mainCtaAria: 'Joined', membershipSignals: ['You are now a member'], joinButton: { found: false } }),
  ]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, true, '跳过杂项 CTA、等到真加入按钮再点');
  assert.equal(r.clicked, true);
  assert.equal(cdp.clicks.length, 1);
});

// ── change fb-group-join-postclick-wait：点击后轮询等「已加入」渲染，别死等一次把已成功的加入误判失败（真机:加群成功但飞书回失败）──
test('fb-join-executor: 点击后按钮延迟翻转（加入小组→稍后已加入）→ 轮询等到成员态判 joined', async () => {
  const cdp = new FakeCdp([
    obs(), // pre: 加入按钮
    obs({ mainCtaText: '加入小组', mainCtaAria: '加入小组', membershipSignals: [], joinButton: { found: true, x: 100, y: 50 } }), // post1: 未翻
    obs({ mainCtaText: '加入小组', mainCtaAria: '加入小组', membershipSignals: [], joinButton: { found: true, x: 100, y: 50 } }), // post2: 未翻
    obs({ mainCtaText: '已加入', mainCtaAria: '已加入', membershipSignals: [], joinButton: { found: false } }), // post3: 已加入
  ]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, true, '等到「已加入」渲染再判成功');
  assert.equal(r.clicked, true);
  assert.equal(r.postObservation?.mainCtaText, '已加入');
});

test('fb-join-executor: 点击后按钮始终未翻转 → 超时诚实 join_failed（不假成功）', async () => {
  const cdp = new FakeCdp([
    obs(),
    obs({ mainCtaText: '加入小组', mainCtaAria: '加入小组', membershipSignals: [], joinButton: { found: true, x: 100, y: 50 } }),
  ]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'join_failed');
  assert.equal(r.clicked, true);
});

// ── change fb-group-join-await-ready：加入按钮在 loading 瞬间出现不立即判定，等到 interactive 再判（真机:loading 态观察被云端 LLM 保守判 ambiguous）──
test('fb-join-executor: 加入按钮在 loading 阶段出现→不立即判定，等 interactive 才停并送可信观察', async () => {
  const cdp = new FakeCdp([
    obs({ documentReady: 'loading' }),      // 加入按钮已在，但页面 loading → 不决定、继续轮询
    obs({ documentReady: 'loading' }),
    obs({ documentReady: 'interactive' }),  // 页面 interactive + 加入按钮 → 决定
    obs({ mainCtaText: '已加入', mainCtaAria: '已加入', joinButton: { found: false } }), // post: joined
  ]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.observation?.documentReady, 'interactive', '送云端的是 interactive 态、不是 loading');
  assert.equal(r.ok, true);
  assert.equal(r.clicked, true);
});

test('fb-join-executor: documentReady 未知（旧形态）时加入按钮仍决定（零回归）', async () => {
  const cdp = new FakeCdp([obs()]); // 无 documentReady 字段 → undefined，不等于 loading → 决定
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123');
  assert.equal(r.reason, 'observation_only');
  assert.equal(r.observation?.mainCtaText, 'Join group');
});

// ── change fb-group-join-js-click：加入点击改用页面内 element.click()（真机实证:坐标鼠标点击不让 FB 加入、
//    水合布局漂移使坐标落空；JS 点击在同一 div[role=button] 上稳定翻成「已加入」）。保留点前拟人 hover 移动做反检测。──
test('fb-join-executor: 加入用页面内 JS 点击，不再派发坐标 mousePressed', async () => {
  const cdp = new FakeCdp([
    obs(),
    obs({ mainCtaText: 'Joined', mainCtaAria: 'Joined', membershipSignals: ['You are now a member'], joinButton: { found: false } }),
  ]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, true);
  assert.equal(r.clicked, true);
  assert.equal(cdp.clicks.length, 1, 'JS 加入点击一次');
  assert.equal(cdp.mousePresses, 0, '不再用坐标 mousePressed 点加入（真机不生效已移除）');
});

test('fb-join-executor: JS 点击瞬间按钮消失（未命中）→ 诚实 no_button，不冒充点过、不进 post 轮询', async () => {
  const cdp = new FakeCdp([
    obs(), // pre: 加入按钮在（进入点击分支）
    obs({ mainCtaText: 'Joined', membershipSignals: ['You are now a member'], joinButton: { found: false } }), // 不应被消费
  ]);
  cdp.jsClickSucceeds = false;
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_button');
  assert.equal(r.clicked, false);
  assert.equal(cdp.clicks.length, 0);
});
