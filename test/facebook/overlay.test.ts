import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FB_THROTTLE_FR_PHRASES,
  FB_THROTTLE_ZH_FREQUENCY_PHRASES,
  FacebookOverlayMonitor,
  OVERLAY_EVIDENCE_MAX_CHARS,
  backfillOverlayEvidenceText,
  classifyFacebookOverlay,
  classifyFacebookOverlayFromSignals,
} from '../../src/facebook/overlay.js';
import type { BrowseCdp } from '../../src/browse/cdp-util.js';
import type { BlockingOverlaySnapshot } from '../../src/browse/overlay-monitor.js';

function fakeCdp(ref: { value: unknown; throwIt?: boolean }): BrowseCdp {
  return {
    send: async () => {
      if (ref.throwIt) throw new Error('CDP boom');
      return { result: { value: ref.value } } as never;
    },
  };
}

test('classifyFacebookOverlayFromSignals: generic checkpoint is unknown without positive captcha evidence', () => {
  assert.equal(classifyFacebookOverlayFromSignals({ href: 'https://www.facebook.com/checkpoint/123' }), 'unknown');
  assert.equal(classifyFacebookOverlayFromSignals({
    href: 'https://www.facebook.com/checkpoint/123',
    text: 'Security check',
  }), 'unknown');
});

test('classifyFacebookOverlayFromSignals: positive human verification evidence is captcha-blocking', () => {
  assert.equal(classifyFacebookOverlayFromSignals({
    href: 'https://www.facebook.com/checkpoint/123',
    text: '进行人机身份验证',
    frameUrls: ['https://www.google.com/recaptcha/enterprise/anchor'],
  }), 'captcha');
  assert.equal(classifyFacebookOverlayFromSignals({
    href: 'https://www.facebook.com/',
    frameUrls: ['https://www.fbsbx.com/captcha/recaptcha/iframe'],
  }), 'captcha');
});

test('classifyFacebookOverlayFromSignals: login and recovery pages are login-blocking', () => {
  assert.equal(classifyFacebookOverlayFromSignals({ href: 'https://www.facebook.com/login/?next=x' }), 'login');
  assert.equal(classifyFacebookOverlayFromSignals({ href: 'https://www.facebook.com/recover/initiate/' }), 'login');
  assert.equal(classifyFacebookOverlayFromSignals({ href: 'https://www.facebook.com/two_step_verification/authentication/' }), 'login');
  assert.equal(classifyFacebookOverlayFromSignals({ href: 'https://www.facebook.com/', text: '登录 Facebook' }), 'login');
});

test('classifyFacebookOverlayFromSignals: AIDCP persona reminder copy is not captcha evidence', () => {
  assert.equal(classifyFacebookOverlayFromSignals({
    href: 'https://www.facebook.com/',
    text: '请先完善账号人设，完成后系统会继续自动运营。',
  }), 'none');
});

test('classifyFacebookOverlayFromSignals: temporarily blocked text is unknown-blocking', () => {
  assert.equal(classifyFacebookOverlayFromSignals({
    href: 'https://www.facebook.com/',
    text: "You're temporarily blocked from using this feature",
  }), 'unknown');
  assert.equal(classifyFacebookOverlayFromSignals({
    href: 'https://www.facebook.com/',
    text: '你暂时无法使用此功能',
  }), 'unknown');
});

test('classifyFacebookOverlayFromSignals: FB soft-block/throttle toasts are unknown-blocking (§5.2)', () => {
  const throttles = [
    'Action Blocked',
    "You can't use this feature right now",
    'We limit how often you can do this to protect our community',
    'It looks like you were misusing this feature by going too fast',
    'You’re Going Too Fast', // 智能引号 + 大小写
    '操作被封锁',
    '此功能暂时无法使用',
  ];
  for (const text of throttles) {
    assert.equal(
      classifyFacebookOverlayFromSignals({ href: 'https://www.facebook.com/', text }),
      'unknown',
      `should classify throttle text as unknown: ${text}`,
    );
  }
});

test('classifyFacebookOverlayFromSignals: 普通正文不误判为限流（no false positive）', () => {
  assert.equal(
    classifyFacebookOverlayFromSignals({
      href: 'https://www.facebook.com/groups/x/',
      text: 'This feature helps you limit distractions while you post updates.',
    }),
    'none',
  );
});

test('classifyFacebookOverlayFromSignals: clean facebook page is none', () => {
  assert.equal(classifyFacebookOverlayFromSignals({
    href: 'https://www.facebook.com/groups/example/permalink/1/',
    text: 'Some regular group post text',
  }), 'none');
});

test('classifyFacebookOverlay: invalid JSON fails closed as unknown', async () => {
  assert.equal(await classifyFacebookOverlay(fakeCdp({ value: '{bad-json' })), 'unknown');
});

// ——— change fb-throttle-popup-zh-frequency-copy ———

test('中文「频率」框架限流弹窗被判为阻断态（本 change 的主因缺口）', () => {
  // 用户真实遭遇的整句（含前后文），既有「封锁/不可用」框架词库对它零命中。
  assert.equal(
    classifyFacebookOverlayFromSignals({
      href: 'https://www.facebook.com/groups/123/',
      text: '为让社群免受垃圾信息打扰，我们限制了你发帖、评论或执行其他操作的频率。你可以稍后再试。',
    }),
    'unknown',
  );
  // 「您」变体
  assert.equal(
    classifyFacebookOverlayFromSignals({
      href: 'https://www.facebook.com/',
      text: '为让社区免受垃圾信息打扰，我们限制了您发帖、评论或执行其他操作的频率。',
    }),
    'unknown',
  );
});

test('词条不含标点与「社群/社区」⇒ 转录差异不影响命中', () => {
  // 用户文案来自截图转录：标点全/半角、社群 vs 社区 均未真机坐实。词条刻意避开这两处方言面。
  for (const phrase of FB_THROTTLE_ZH_FREQUENCY_PHRASES) {
    assert.ok(!/[，。、,.]/.test(phrase), `词条不得含标点: ${phrase}`);
    assert.ok(!phrase.includes('社群') && !phrase.includes('社区'), `词条不得含地区差异词: ${phrase}`);
  }
  // 半角标点 + 「社区」的转录变体照样命中
  assert.equal(
    classifyFacebookOverlayFromSignals({
      href: 'https://www.facebook.com/',
      text: '为让社区免受垃圾信息打扰,我们限制了你发帖、评论或执行其他操作的频率.你可以稍后再试.',
    }),
    'unknown',
  );
});

test('词条纪律：绝不含裸词「限制」/「频率」（FB 群规则页遍地都是）', () => {
  for (const phrase of FB_THROTTLE_ZH_FREQUENCY_PHRASES) {
    assert.notEqual(phrase, '限制');
    assert.notEqual(phrase, '频率');
    assert.ok(phrase.length >= 6, `词条须为长专属句片段，过短易误报: ${phrase}`);
  }
  // 正常页面含这些字但无句片段 ⇒ 绝不命中（误报=账号停摆至恢复窗结束且需人工恢复）
  const benign = [
    '本群规则：请勿刷屏。管理员有权限制发帖频率，违者移出群组。',
    '你可以在设置中调整通知的频率。',
    '我们限制了广告的展示频率以改善你的体验。',
  ];
  for (const text of benign) {
    assert.equal(
      classifyFacebookOverlayFromSignals({ href: 'https://www.facebook.com/groups/x/', text }),
      'none',
      `正常页面不得判为限流: ${text}`,
    );
  }
});

test('词条集合锁：与云端 FB_THROTTLE_PHRASES 逐条对齐（任一侧漂移即失败）', () => {
  // 两仓各自维护、无共享模块 ⇒ 本断言是唯一防漂移手段。改动须两侧同步（云端同名测试镜像本表）。
  assert.deepEqual([...FB_THROTTLE_ZH_FREQUENCY_PHRASES], [
    '我们限制了你发帖',
    '我们限制了您发帖',
    '执行其他操作的频率',
  ]);
});

// ——— change fb-throttle-popup-fr-copy ———

/** FB 法语软阻断弹窗的真实文案（带完整重音与撇号），本 change 的主因缺口。 */
const FR_SECURITY_CHECK_POPUP = [
  "Cette fonctionnalité n'est pas disponible.",
  'Un contrôle de sécurité est requis pour continuer.',
  "Si vous pensez que ceci ne va pas à l'encontre des Standards de la communauté, dites-le nous.",
  'OK',
].join(' ');

test('法语软阻断弹窗被判为阻断态（本 change 的主因缺口）', () => {
  // 本 change 之前这里返回 'none' ⇒ 连 captcha.detected 都不发 ⇒ 云端风控停 normal 继续按原节奏下发。
  assert.equal(
    classifyFacebookOverlayFromSignals({
      href: 'https://www.facebook.com/groups/123/',
      text: FR_SECURITY_CHECK_POPUP,
    }),
    'unknown',
  );
});

test('法语与英语同一弹窗判定等价（不因界面语言分叉）', () => {
  const en = [
    "This feature isn't available.",
    'A security check is required to continue.',
    "If you think this doesn't go against our Community Standards, let us know.",
    'OK',
  ].join(' ');
  const href = 'https://www.facebook.com/groups/123/';
  assert.equal(classifyFacebookOverlayFromSignals({ href, text: en }), 'unknown', '英文版今天已命中（回归护栏）');
  assert.equal(
    classifyFacebookOverlayFromSignals({ href, text: FR_SECURITY_CHECK_POPUP }),
    classifyFacebookOverlayFromSignals({ href, text: en }),
  );
});

test('变音符归一：预组合 / 组合序列 / 重音丢失三种形式判定一致', () => {
  const href = 'https://www.facebook.com/groups/123/';
  // ① 预组合形式（U+00E9 等）
  assert.equal(
    classifyFacebookOverlayFromSignals({ href, text: FR_SECURITY_CHECK_POPUP.normalize('NFC') }),
    'unknown',
  );
  // ② 组合序列形式（'e' + U+0301）：页面 innerText 用哪种不受我们控制，字面比较不相等
  assert.equal(
    classifyFacebookOverlayFromSignals({ href, text: FR_SECURITY_CHECK_POPUP.normalize('NFD') }),
    'unknown',
  );
  // ③ 重音整体丢失（文案取证经截图转录的典型损耗）
  assert.equal(
    classifyFacebookOverlayFromSignals({ href, text: 'Un controle de securite est requis pour continuer.' }),
    'unknown',
  );
  assert.equal(
    classifyFacebookOverlayFromSignals({ href, text: "Cette fonctionnalite n'est pas disponible." }),
    'unknown',
  );
  // 注：OCR 把 ô 误认成别的字母（contrale）属**字符识别错误**、非变音符丢失，不在本归一的承诺范围内。
});

test('词条纪律：法语申诉话术绝不命中（陈年违规通知会误把账号打进 restricted）', () => {
  // 「如果你认为这不违反社群规范，请告知我们」附在一切违规告知之后，包括通知中心里的陈年内容删除通知。
  // 与云端删除 'we removed your' 的理由完全同源。
  for (const phrase of FB_THROTTLE_FR_PHRASES) {
    assert.ok(!phrase.includes('standards'), `词条不得含申诉话术: ${phrase}`);
    assert.ok(!phrase.includes('communaute'), `词条不得含申诉话术: ${phrase}`);
  }
  const benign = [
    "Si vous pensez que ceci ne va pas à l'encontre des Standards de la communauté, dites-le nous.",
    'Nous avons supprimé votre publication car elle ne respecte pas nos Standards de la communauté.',
  ];
  for (const text of benign) {
    assert.equal(
      classifyFacebookOverlayFromSignals({ href: 'https://www.facebook.com/groups/x/', text }),
      'none',
      `申诉话术不得判为限流: ${text}`,
    );
  }
});

test('词条纪律：不带「est requis」限定的裸短语绝不命中（设置页里是功能名）', () => {
  const benign = [
    'Contrôle de sécurité',
    'Contrôle de sécurité — vérifiez les paramètres de sécurité de votre compte.',
    'Cette option est disponible dans vos paramètres.',
  ];
  for (const text of benign) {
    assert.equal(
      classifyFacebookOverlayFromSignals({ href: 'https://www.facebook.com/settings/', text }),
      'none',
      `设置页措辞不得判为限流: ${text}`,
    );
  }
});

test('词条集合锁：法语两条须与云端 FB_THROTTLE_PHRASES 逐条对齐（任一侧漂移即失败）', () => {
  // 两仓各自维护、无共享模块 ⇒ 本断言是唯一防漂移手段（云端同名测试镜像本表）。
  assert.deepEqual([...FB_THROTTLE_FR_PHRASES], [
    'controle de securite est requis',
    'cette fonctionnalite nest pas disponible',
  ]);
  // 词条不经归一、靠人工保证已归一 ⇒ 一条带变音符或撇号的词条会**永不命中**且无任何报错。
  for (const phrase of FB_THROTTLE_FR_PHRASES) {
    assert.equal(phrase, phrase.toLowerCase());
    assert.ok(!phrase.includes("'"), `词条含撇号未归一（将永不命中）: ${phrase}`);
    assert.equal(
      phrase.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      phrase,
      `词条含变音符未归一（将永不命中）: ${phrase}`,
    );
    assert.ok(phrase.length >= 12, `词条须为长专属句片段，过短易误报: ${phrase}`);
  }
});

test('此前只在云端的 we restrict certain content and actions 现已可达（消除死代码）', () => {
  // 该条此前只在云端词库、边缘不认 ⇒ 边缘不分类就永不上报 ⇒ 云端永远收不到能命中它的文本。
  assert.equal(
    classifyFacebookOverlayFromSignals({
      href: 'https://www.facebook.com/',
      text: 'We restrict certain content and actions to protect our community.',
    }),
    'unknown',
  );
});

test('backfillOverlayEvidenceText: 候选为空时用判定同源文本回填（本 change 的钉）', () => {
  // FB 标准限流弹窗：role=dialog / 无 iframe / 约占视口 35% / 右上角有关闭 × ⇒ 快照候选筛选三分支全不满足
  // ⇒ candidates 空 ⇒ text=undefined ⇒ 云端「无文案不臆断限流」返否定 ⇒ 只到 warned 降速而非 restricted。
  const emptySnapshot: BlockingOverlaySnapshot = {
    kind: 'unknown',
    firstDetectedUrl: 'https://www.facebook.com/groups/123/',
    capturedAt: 1,
    candidates: [],
  };
  const scanText = '为让社群免受垃圾信息打扰，我们限制了你发帖、评论或执行其他操作的频率。你可以稍后再试。';
  const out = backfillOverlayEvidenceText(emptySnapshot, 'unknown', 'https://www.facebook.com/', scanText);
  assert.ok(out?.text, '判为阻断态的上报必须携带非空证据文案');
  assert.ok(out.text.includes('执行其他操作的频率'), '证据须为判定同源文本');
  assert.equal(out.kind, 'unknown');
  assert.equal(out.firstDetectedUrl, 'https://www.facebook.com/groups/123/', '回填不得改写其它字段');
});

test('backfillOverlayEvidenceText: 候选非空时沿用原证据，绝不覆盖', () => {
  const snapshot: BlockingOverlaySnapshot = {
    kind: 'unknown',
    capturedAt: 1,
    text: '弹窗元素原文',
    candidates: [],
  };
  const out = backfillOverlayEvidenceText(snapshot, 'unknown', 'https://www.facebook.com/', '整页扫描文本');
  assert.equal(out?.text, '弹窗元素原文');
});

test('backfillOverlayEvidenceText: 无同源文本时诚实保持现状，绝不臆造证据', () => {
  const snapshot: BlockingOverlaySnapshot = { kind: 'unknown', capturedAt: 1, candidates: [] };
  assert.equal(backfillOverlayEvidenceText(snapshot, 'unknown', 'u', undefined)?.text, undefined);
  assert.equal(backfillOverlayEvidenceText(snapshot, 'unknown', 'u', '   ')?.text, undefined);
  assert.equal(backfillOverlayEvidenceText(undefined, 'unknown', 'u', undefined), undefined);
});

test('backfillOverlayEvidenceText: 快照采集整个失败时仍送达同源证据', () => {
  const out = backfillOverlayEvidenceText(undefined, 'unknown', 'https://www.facebook.com/x', '我们限制了你发帖');
  assert.equal(out?.kind, 'unknown');
  assert.equal(out?.text, '我们限制了你发帖');
  assert.equal(out?.firstDetectedUrl, 'https://www.facebook.com/x');
  assert.deepEqual(out?.candidates, []);
});

test('backfillOverlayEvidenceText: 证据按上限截断且折叠空白', () => {
  const out = backfillOverlayEvidenceText(undefined, 'unknown', 'u', 'a\n\n  b' + 'x'.repeat(5000));
  assert.equal(out?.text?.length, OVERLAY_EVIDENCE_MAX_CHARS);
  assert.ok(out?.text?.startsWith('a b'), '空白须折叠');
});

test('回填不改变判定：不命中词库的页面绝不因回填变成阻断态', () => {
  // 回填只在「已判为阻断」之后发生；判定仍完全由词库在整页文本上完成。
  assert.equal(
    classifyFacebookOverlayFromSignals({
      href: 'https://www.facebook.com/',
      text: '一段完全正常的正文，随便提到限制与频率两个词。',
    }),
    'none',
  );
});

test('FacebookOverlayMonitor.lastScanText: 暴露判定同源文本，探测失败不覆盖', async () => {
  const text = '为让社群免受垃圾信息打扰，我们限制了你发帖、评论或执行其他操作的频率。';
  const ref = { value: JSON.stringify({ href: 'https://www.facebook.com/', text }) as unknown };
  const monitor = new FacebookOverlayMonitor(fakeCdp(ref), { pollMs: 1 });

  await monitor.tick();
  assert.equal(monitor.state, 'unknown');
  assert.equal(monitor.lastScanText, text, 'lastScanText 须是判定所依据的那份文本');

  (ref as { throwIt?: boolean }).throwIt = true;
  await monitor.tick();
  assert.equal(monitor.lastScanText, text, '探测失败不得抹掉已有证据（与 state 的 sticky 语义一致）');
});

test('FacebookOverlayMonitor: sticky on probe errors', async () => {
  const ref = { value: JSON.stringify({ href: 'https://www.facebook.com/login/' }) as unknown };
  const monitor = new FacebookOverlayMonitor(fakeCdp(ref), { pollMs: 1 });
  const transitions: Array<[string, string]> = [];

  await monitor.tick((from, to) => transitions.push([from, to]));
  assert.equal(monitor.state, 'login');
  ref.value = JSON.stringify({ href: 'https://www.facebook.com/' });
  (ref as { throwIt?: boolean }).throwIt = true;
  await monitor.tick((from, to) => transitions.push([from, to]));
  assert.equal(monitor.state, 'login');
  assert.deepEqual(transitions, [['none', 'login']]);
});
