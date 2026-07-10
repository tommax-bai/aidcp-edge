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
  clicks: Array<{ x: number; y: number }> = [];
  escapes = 0;
  private evalCount = 0;

  constructor(private readonly observations: RawJoinObservation[] = [obs()]) {}

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'Page.navigate') {
      this.navigations.push(String(params.url));
      return {} as T;
    }
    if (method === 'Runtime.evaluate') {
      const current = this.observations[Math.min(this.evalCount, this.observations.length - 1)] ?? obs();
      this.evalCount++;
      return { result: { value: JSON.stringify(current) } } as T;
    }
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mousePressed') this.clicks.push({ x: Number(params.x), y: Number(params.y) });
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
    { settleMs: 0, waitAfterClickMs: 0 },
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
