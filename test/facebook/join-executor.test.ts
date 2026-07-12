import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import type { OverlayKind, OverlayMonitor } from '../../src/browse/overlay-monitor.js';
import { FacebookJoinExecutor, classifyCtaLabel, hasMemberSignal, structuralJoinConfirmed } from '../../src/facebook/join-executor.js';

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
  actionNodeCount?: number;
  composerPresent?: boolean;
  joinCtaPresent?: boolean;
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
    // 默认代表「页面已渲染」（真机观察恒带 actionNodeCount）——isMinimallyReady=true，除非用例显式覆盖为 loading/0（P1-5）。
    documentReady: 'complete',
    actionNodeCount: 8,
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

// ── change facebook-join-structural-verify（L3）：结构后置校验，承重=语言无关「跃迁」；消灭「本地语已加入→误判 join_failed→重复加群」──
test('L3: 跃迁（点前无 composer→点后有 composer）→ joined（词表未命中语种也识别，消灭重复加群）', async () => {
  const cdp = new FakeCdp([
    obs({ composerPresent: false, joinCtaPresent: true }), // pre：非成员加入页，无 composer、加入 CTA 在（joinButton.found 一致）
    obs({
      mainCtaText: 'Đăng bài', // 越南语「发帖」——非成员词表标签，hasMemberSignal 命不中
      mainCtaAria: null,
      membershipSignals: [],
      composerPresent: true, // 点后 composer 出现 = 跃迁
      joinCtaPresent: false,
      joinButton: { found: false },
    }),
  ]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, true); // 跃迁语言无关，不再因词表漏命本地语成员标签误报 join_failed
  assert.equal(r.clicked, true);
});

test('L3 红线: 非成员公开组点前已有 composer（无跃迁）→ 点后绝不判 joined，诚实 join_failed（防 fail-open false-positive）', async () => {
  const cdp = new FakeCdp([
    obs({ composerPresent: true, joinCtaPresent: true }), // pre：公开组对非成员已渲染 composer + 加入 CTA 在
    obs({ mainCtaText: '参加', composerPresent: true, joinCtaPresent: false, joinButton: { found: false } }), // post：composer 仍在但点前就有→无跃迁；未覆盖语种致 joinCtaPresent=false
  ]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'join_failed'); // 点前已有 composer → structuralJoinConfirmed=false → 绝不据 fail-open 的 joinCtaPresent 假成功
});

test('L3 红线: 未覆盖语种非成员 + 主体有 composer（joinButton 未命中词表）→ observe 期绝不判 already_member', async () => {
  // 关键回归：joinCtaPresent 由词表派生、未覆盖语种 fail-open。修前 observe 期结构 already_member 会没点击就 markJoined、污染账本。
  const cdp = new FakeCdp([
    obs({ mainCtaText: '参加', mainCtaAria: '参加', composerPresent: true, joinCtaPresent: false, joinButton: { found: false } }),
  ]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123'); // observe-only
  assert.notEqual(r.reason, 'already_member'); // observe/pre-click 绝不据结构判已加入（已删除该路径）
});

test('L3: 点后 composer 在但加入 CTA 仍可见（点前无 composer、join 未生效）→ join_failed（不假成功）', async () => {
  const cdp = new FakeCdp([
    obs({ composerPresent: false, joinCtaPresent: true }),
    obs({ mainCtaText: 'Join group', composerPresent: true, joinCtaPresent: true, joinButton: { found: true } }),
  ]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'join_failed'); // joinCtaPresent=true → structuralJoinConfirmed=false → 绝不假成功
  assert.equal(r.clicked, true);
});

test('L3: Join→Pending 且渲染了 composer（跃迁）→ 判 pending（pending 先于结构 joined）', async () => {
  const cdp = new FakeCdp([
    obs({ composerPresent: false, joinCtaPresent: true }),
    obs({ pendingRequest: true, composerPresent: true, joinCtaPresent: false, joinButton: { found: false } }),
  ]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'pending'); // pending 判据先于结构 joined，composer 跃迁不把 pending 读成 joined
});

test('L3: 点后无 composer（无跃迁）无成员词表信号 → join_failed（结构不假成功）', async () => {
  const cdp = new FakeCdp([
    obs({ composerPresent: false, joinCtaPresent: true }),
    obs({ mainCtaText: null, composerPresent: false, joinCtaPresent: false, joinButton: { found: false } }),
  ]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'join_failed'); // composer 未出现 → 无跃迁 → 无正向信号不假成功
});

test('structuralJoinConfirmed: 仅「跃迁（点前无 composer→点后有且无可见加入 CTA、非 loading）」才认', () => {
  const post = { composerPresent: true, joinCtaPresent: false, documentReady: 'complete' };
  assert.equal(structuralJoinConfirmed({ composerPresent: false }, post), true); // 跃迁
  assert.equal(structuralJoinConfirmed(undefined, post), true); // 点前无观测视为无 composer
  assert.equal(structuralJoinConfirmed({ composerPresent: true }, post), false); // 点前已有 composer→无跃迁（防公开组 fail-open）
  assert.equal(structuralJoinConfirmed({ composerPresent: false }, { composerPresent: true, joinCtaPresent: true, documentReady: 'complete' }), false); // 加入 CTA 仍在
  assert.equal(structuralJoinConfirmed({ composerPresent: false }, { composerPresent: false, documentReady: 'complete' }), false); // 点后无 composer
  assert.equal(structuralJoinConfirmed({ composerPresent: false }, { composerPresent: true, joinCtaPresent: false, documentReady: 'loading' }), false); // loading 不认
  assert.equal(structuralJoinConfirmed({ composerPresent: false }, undefined), false);
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
// 空观察 = 页面尚未渲染（loading + 0 动作节点 + 无 CTA/按钮）——P1-5 语义下即「未最小就绪」，超时判 not_ready。
const EMPTY_OBS = () =>
  obs({ mainCtaText: null, mainCtaAria: null, headerText: null, membershipSignals: [], documentReady: 'loading', actionNodeCount: 0, joinButton: { found: false } });

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

test('fb-join-executor: 页面一直未渲染（空观察）触上限 → not_ready（P1-5 可重试瞬态，不点击、不假成功）', async () => {
  const cdp = new FakeCdp([EMPTY_OBS()]); // 一直 loading + 0 节点
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_ready', '页面没加载出来是慢渲染瞬态，非终局 no_button');
  assert.equal(r.clicked, false);
  assert.equal(cdp.clicks.length, 0);
});

test('fb-join-executor: 页面已渲染但确实无加入按钮 → no_button（终局，非 not_ready）', async () => {
  // 已最小就绪（documentReady=complete + 有动作节点）却没有加入按钮 → 真的没按钮，诚实 no_button。
  const cdp = new FakeCdp([obs({ mainCtaText: null, mainCtaAria: null, headerText: 'Public group', joinButton: { found: false } })]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_button');
  assert.equal(r.clicked, false);
});

test('fb-join-executor: 观察态一直空 + observe-only → not_ready（P1-5，未渲染即诚实瞬态）', async () => {
  const cdp = new FakeCdp([EMPTY_OBS()]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_ready');
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

// ── change facebook-join-comment-resilience P0-2：确认侧多语（非英中群加成功后确认已加入，替 EN/ZH 精确 ===）──
test('hasMemberSignal: 多语成员标签 contains 识别（非英中群加成功→确认已加入，P0-2）', () => {
  assert.equal(hasMemberSignal({ mainCtaText: 'Đã tham gia' }), true); // 越南语「已加入」（旧 === 漏判→误报 join_failed）
  assert.equal(hasMemberSignal({ mainCtaText: 'Salir del grupo' }), true); // 西语「退出小组」= 已是成员
  assert.equal(hasMemberSignal({ mainCtaAria: 'Rời nhóm' }), true); // 越南语「退出小组」（aria）
  assert.equal(hasMemberSignal({ mainCtaText: '✓ Joined' }), true); // 装饰性英文（旧精确 === 漏掉）
  assert.equal(hasMemberSignal({ mainCtaText: 'Joined ⌄' }), true);
  assert.equal(hasMemberSignal({ membershipSignals: ['Bạn đã là thành viên của nhóm này'] }), true); // 多语「已成为成员」整句
});

test('hasMemberSignal: 加入按钮 / 无关标签 / 空 不误判为成员（不假成功，P0-2）', () => {
  assert.equal(hasMemberSignal({ mainCtaText: 'Join group' }), false);
  assert.equal(hasMemberSignal({ mainCtaText: 'Tham gia nhóm' }), false); // 越南语「加入」不含成员词
  assert.equal(hasMemberSignal({ mainCtaText: 'Share' }), false);
  assert.equal(hasMemberSignal(undefined), false);
  assert.equal(hasMemberSignal({}), false);
});

// ── change facebook-join-comment-resilience P1-5：慢渲染瞬态 not_ready（供云端短退避重试而非 LLM→永久失败）──
test('fb-join-executor: 就绪超时仍 loading 且无加入按钮 → not_ready（P1-5 可重试瞬态，非 no_button/observation_only）', async () => {
  const cdp = new FakeCdp([obs({ documentReady: 'loading', joinButton: { found: false } })]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_ready');
  assert.equal(r.clicked, false);
  assert.equal(cdp.clicks.length, 0);
});

// ── change facebook-join-comment-resilience P1-7：点击后加群流程浮层不被盲 Esc（绝不破坏真的待审/问卷门）──
test('fb-join-executor: post-click 待审浮层不被 Esc 误关（P1-7 保守闸）', async () => {
  const cdp = new FakeCdp([
    obs(),
    obs({ modalText: 'Solicitud enviada, pendiente de aprobación', pendingRequest: true, joinButton: { found: false } }),
  ]);
  const r = await makeExecutor(cdp).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.reason, 'pending');
  assert.equal(cdp.escapes, 0);
});

// ── change facebook-join-candidate-scope-guard[jsdom]：加群候选「目标群作用域」守卫 ──
// 这些用例在 jsdom 真跑注入的 GROUP_JOIN_OBSERVE_JS / GROUP_JOIN_CLICK_JS（非预烘焙观测），端到端验证「fail-closed 正向包含」：
// 只在目标群头部/动作区内选/点 join，绝不误点「发现更多小组」推荐位的异群 join（文案与目标群逐字相同、且是兄弟裸 div 无异群 href）。
function buildGroupDom(bodyHtml: string, url = 'https://www.facebook.com/groups/123'): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, { url, runScripts: 'outside-only' });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return { left: 10, top: 100, right: 120, bottom: 140, width: 110, height: 40 };
    },
  });
  return dom;
}

function jsdomJoinCdp(dom: JSDOM): BrowseCdp {
  return {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {} as never;
      const value = dom.window.eval(String(params?.expression ?? ''));
      return { result: { value: typeof value === 'string' ? value : JSON.stringify(value) } } as never;
    },
  };
}

function makeJsdomExecutor(dom: JSDOM) {
  return new FacebookJoinExecutor(
    { cdp: jsdomJoinCdp(dom), acceptConsent: NO_CONSENT, sleep: async () => {}, logger: () => {} },
    { settleMs: 0, waitAfterClickMs: 0, readyTimeoutMs: 2000, pollMs: 500, postClickTimeoutMs: 2000, preClickSettleMs: 0 },
  );
}

// § 本次订正核心红线：推荐位异群 join 是**兄弟裸 div[role=button]、无异群 href 祖先** → 黑名单（异群链接排除）漏排、
// 唯有正向包含（目标头部块之外默认出域）挡得住。
test('scope-guard[jsdom]: 目标 pending + 推荐位裸 div 异群 join（无异群 href 祖先）→ 判 pending、绝不点异群 join（正向包含承重，非靠 E1）', async () => {
  const dom = buildGroupDom(
    '<div role="main">' +
      '<div id="header"><h1>Target Group</h1><div role="button" id="target">已申请</div></div>' +
      '<div id="suggestions"><div class="card"><a href="/groups/999">Other Group</a><div role="button" id="rail">加入小组</div></div></div>' +
      '</div>',
  );
  let railClicked = false;
  (dom.window.document.getElementById('rail') as HTMLElement).addEventListener('click', () => {
    railClicked = true;
  });
  const r = await makeJsdomExecutor(dom).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.reason, 'pending', '目标群自身控件是待审 → 判 pending');
  assert.equal(r.clicked, false);
  assert.equal(railClicked, false, '绝不点推荐位异群 join（红线）');
  assert.equal(r.observation?.outOfScopeJoinCount, 1, '推荐位 join 被判出域并如实计数');
  assert.ok(
    (r.observation?.ctaCandidates ?? []).some((c) => c.kind === 'join' && c.inTargetScope === false),
    '出域 join 候选仍全量上报（守 L4 不静默丢原文）',
  );
});

test('scope-guard[jsdom]: 推荐位异群 join 带 /groups/异 id 祖先链接（E1 场景）→ 亦出域、判 pending、不点', async () => {
  const dom = buildGroupDom(
    '<div role="main">' +
      '<div id="header"><h1>Target Group</h1><div role="button" id="target">已申请</div></div>' +
      '<div id="suggestions"><div class="card"><a href="/groups/999"><div role="button" id="rail">加入小组</div></a></div></div>' +
      '</div>',
  );
  let railClicked = false;
  (dom.window.document.getElementById('rail') as HTMLElement).addEventListener('click', () => {
    railClicked = true;
  });
  const r = await makeJsdomExecutor(dom).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.reason, 'pending');
  assert.equal(railClicked, false, '带异群链接的推荐位 join 亦绝不点');
});

test('scope-guard[jsdom]: 目标群自身 join 在头部块内 → 点击腿点的是目标 join、非推荐位异群 join；点后 joined', async () => {
  const dom = buildGroupDom(
    '<div role="main">' +
      '<div id="header"><h1>Target Group</h1><div role="button" id="target">加入小组</div></div>' +
      '<div id="suggestions"><div class="card"><a href="/groups/999">Other Group</a><div role="button" id="rail">加入小组</div></div></div>' +
      '</div>',
  );
  const doc = dom.window.document;
  let railClicked = false;
  (doc.getElementById('rail') as HTMLElement).addEventListener('click', () => {
    railClicked = true;
  });
  (doc.getElementById('target') as HTMLElement).addEventListener('click', () => {
    (doc.getElementById('target') as HTMLElement).textContent = '已加入'; // 点后翻成成员态供点后 observe 判 joined
  });
  const r = await makeJsdomExecutor(dom).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(railClicked, false, '绝不点推荐位异群 join');
  assert.equal(r.clicked, true, '点的是目标群自身 join');
  assert.equal(r.ok, true, '点后翻成「已加入」→ joined');
});

test('scope-guard[jsdom]: 无群名主标题（头部块解析不出）→ fail-closed，scopeResolved=false、不点任何 join', async () => {
  const dom = buildGroupDom(
    '<div role="main">' +
      '<div id="suggestions"><div class="card"><a href="/groups/999">Other Group</a><div role="button" id="rail">加入小组</div></div></div>' +
      '</div>',
  );
  let railClicked = false;
  (dom.window.document.getElementById('rail') as HTMLElement).addEventListener('click', () => {
    railClicked = true;
  });
  const r = await makeJsdomExecutor(dom).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.observation?.scopeResolved, false, '无 h1 → 作用域未确立');
  assert.equal(r.reason, 'not_ready', '作用域未确立映射为可重试 not_ready（非 no_button 永久失败）');
  assert.equal(r.clicked, false);
  assert.equal(railClicked, false, '绝不页面级点异群 join');
});

test('scope-guard[jsdom]: 推荐位建议群「已加入」信号在头部块外 → 不进 membershipSignals、不误判 already_member（红线尾巴）', async () => {
  const dom = buildGroupDom(
    '<div role="main">' +
      '<div id="header"><h1>Target Group</h1><div role="button" id="target">加入小组</div></div>' +
      '<div id="suggestions"><div class="card"><a href="/groups/999">Other Group</a><div role="button" id="rail">已加入</div></div></div>' +
      '</div>',
  );
  const r = await makeJsdomExecutor(dom).joinGroup('https://www.facebook.com/groups/123'); // observe-only
  assert.notEqual(r.reason, 'already_member', '推荐位异群「已加入」绝不使目标群假成员');
  assert.equal(r.reason, 'observation_only');
  assert.ok(
    !(r.observation?.membershipSignals ?? []).some((s) => s.includes('已加入')),
    'membershipSignals 不含推荐位异群「已加入」',
  );
});

test('scope-guard[jsdom]: 目标群自身 join 被指向本群 id 的链接包裹 → 不误排（同群链接在域、候选可选）', async () => {
  // 同群 /groups/123 链接不触发异群排除、也不收窄头部块 → join 候选仍在域内可选（outOfScopeJoinCount=0，判定得到 join 观测）。
  // 注：真机 FB 的 join 控件是 div[role=button] 非锚点；此处仅验作用域「不误排同群链接」，故走 observe-only 断言在域可选（不做点击-导航）。
  const dom = buildGroupDom(
    '<div role="main">' +
      '<div id="header"><h1>Target Group</h1><a href="/groups/123"><div role="button" id="target">加入小组</div></a></div>' +
      '</div>',
  );
  const r = await makeJsdomExecutor(dom).joinGroup('https://www.facebook.com/groups/123'); // observe-only
  assert.equal(r.reason, 'observation_only', '在域内找到 join 候选（非 no_button）');
  assert.equal(r.observation?.outOfScopeJoinCount, 0, '同群链接不被判异群、无候选被误排');
  assert.equal(classifyCtaLabel(r.observation?.mainCtaText), 'join', 'mainCta 反映在域 join 候选');
});

// § 对抗评审 Fix 1a 红线闭合：推荐位用**非锚点导航**（div[role=link] + data-* 编码 group id，无 a[href]）——
// 修前 __hasForeignGroupLink 只认 a[href] → 找不到异群引用 → 头部块吞到 [role=main] → 误点/误判（fail-open 红线）。
// 修后 __groupIdFromEl 扫元素属性值里的 /groups/<id> → 认出异群引用 → 框住头部块 → 推荐位出域。
test('scope-guard[jsdom]: 推荐位用非锚点导航（role=link + data-* 编码异群 id，无 a[href]）→ 仍被识别为异群、出域，不误点（红线闭合）', async () => {
  const dom = buildGroupDom(
    '<div role="main">' +
      '<div id="header"><h1>Target Group</h1><div role="button" id="target">已申请</div></div>' +
      '<div id="feed"><div class="card"><div role="link" data-visit="/groups/999">Other</div><div role="button" id="rail">加入小组</div></div></div>' +
      '</div>',
  );
  let railClicked = false;
  (dom.window.document.getElementById('rail') as HTMLElement).addEventListener('click', () => {
    railClicked = true;
  });
  const r = await makeJsdomExecutor(dom).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.reason, 'pending', '目标 pending；非锚点推荐位 join 出域、不冒充目标 CTA');
  assert.equal(railClicked, false, '非锚点推荐位异群 join 绝不被点（红线闭合）');
  assert.equal(r.observation?.outOfScopeJoinCount, 1, '非锚点推荐位 join 被判出域并计数');
});

// § 对抗评审 Finding 3 闭合（点击腿作用域守卫回归护栏）：推荐位异群 join 在文档序**先于**目标群自身 join。
// 若点击腿的 `&& __inTargetScope(node)` 被删（退回页面级文档序首个 join），会先点到推荐位异群 join → 本用例失败。
test('scope-guard[jsdom]: 推荐位异群 join 在文档序先于目标 join + click → 点击腿只点在域的目标 join、绝不点先出现的异群 join', async () => {
  const dom = buildGroupDom(
    '<div role="main">' +
      '<div id="suggestions"><div class="card"><a href="/groups/999">Other</a><div role="button" id="rail">加入小组</div></div></div>' +
      '<div id="header"><h1>Target Group</h1><div role="button" id="target">加入小组</div></div>' +
      '</div>',
  );
  const doc = dom.window.document;
  let railClicked = false;
  (doc.getElementById('rail') as HTMLElement).addEventListener('click', () => {
    railClicked = true;
  });
  (doc.getElementById('target') as HTMLElement).addEventListener('click', () => {
    (doc.getElementById('target') as HTMLElement).textContent = '已加入';
  });
  const r = await makeJsdomExecutor(dom).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(railClicked, false, '先出现的推荐位异群 join 绝不被点（作用域守卫承重）');
  assert.equal(r.clicked, true, '点的是文档序更后、但在域的目标 join');
  assert.equal(r.ok, true, '点后 joined');
});

// § 对抗评审 Finding 4 闭合：目标群 id 从 in-page location 解析不出（畸形/非群页）→ fail-closed（scopeResolved=false、not_ready、不点）。
test('scope-guard[jsdom]: in-page URL 无 /groups/<id>（畸形）→ __TARGET_GID=null，fail-closed（scopeResolved=false、not_ready、不点任何 join）', async () => {
  const dom = buildGroupDom(
    '<div role="main">' +
      '<div id="header"><h1>Target Group</h1><div role="button" id="target">加入小组</div></div>' +
      '<div id="feed"><div class="card"><a href="/groups/999">Other</a><div role="button" id="rail">加入小组</div></div></div>' +
      '</div>',
    'https://www.facebook.com/watch', // in-page location 无 /groups/<id> → __parseGroupId 返回 null
  );
  const doc = dom.window.document;
  let railClicked = false;
  let targetClicked = false;
  (doc.getElementById('rail') as HTMLElement).addEventListener('click', () => {
    railClicked = true;
  });
  (doc.getElementById('target') as HTMLElement).addEventListener('click', () => {
    targetClicked = true;
  });
  const r = await makeJsdomExecutor(dom).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.observation?.targetGroupId, null, '畸形 in-page URL → 目标群 id 解析为 null');
  assert.equal(r.observation?.scopeResolved, false, 'targetGid=null → 作用域未确立');
  assert.equal(r.reason, 'not_ready', 'fail-closed 可重试（非 no_button 永久失败）');
  assert.equal(railClicked, false, '绝不点任何 join');
  assert.equal(targetClicked, false);
});

// § 对抗评审 Finding 5 闭合（点后子句）：点击目标 join 后，目标未翻成成员，而推荐位卡片显示异群「已加入」（出域）→
// 绝不据推荐位信号伪造 joined，诚实 join_failed。
test('scope-guard[jsdom]: 点后目标未成成员、推荐位异群「已加入」在头部块外 → 不伪造 joined、诚实 join_failed', async () => {
  const dom = buildGroupDom(
    '<div role="main">' +
      '<div id="header"><h1>Target Group</h1><div role="button" id="target">加入小组</div></div>' +
      '<div id="suggestions"><div class="card"><a href="/groups/999">Other</a><div role="button" id="rail">已加入</div></div></div>' +
      '</div>',
  );
  // target 点击后不改变状态（模拟加入未生效）；推荐位「已加入」是异群、出域，绝不能被读成目标 joined。
  const r = await makeJsdomExecutor(dom).joinGroup('https://www.facebook.com/groups/123', { click: true });
  assert.equal(r.clicked, true, '点了目标 join');
  assert.equal(r.reason, 'join_failed', '目标未翻成成员 + 推荐位异群「已加入」出域 → 不伪造 joined');
  assert.ok(
    !(r.postObservation?.membershipSignals ?? []).some((s) => s.includes('已加入')),
    '点后 membershipSignals 亦不含推荐位异群「已加入」',
  );
});
