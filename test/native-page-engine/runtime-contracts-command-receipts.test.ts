import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { nativeCommandKindByEnvelopeType } from '../../src/native-page-engine/command-mapper.js';

/**
 * 命令清单的 `receipts` / `requestContract` 声明 ↔ 宿主真能发出的回执 的机械对账。
 *
 * 背景：这几列过去零消费——全仓对 `receipts` 只有一处接口字段声明、没有任何断言，
 * `requestContract` 的唯一断言是「字符串非空」。于是声明可以写一条发不出去的回执，
 * 而且下一条新命令照样能再写一条。这份检查把声明变成断言。
 *
 * 判据（两条都不可省，否则对账会退化成恒真）：
 * ① **跨平台取并集**——一次执行只产出一个输出，同一条命令在小红书与 Facebook 上的成功输出
 *    可以不同（`note_close` 在小红书回动作回执、在 Facebook 回列表卡片）。
 * ② **排除失败路径**——`reportFailure` 对任何命令都会发一条 ok:false 的动作完成；
 *    把它算进来，`action.completed` 对每条命令都成立，对账就没有意义了。
 */

const repoFile = (relative: string): string => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

interface ManifestCommand {
  routeKey: string;
  edgeType: string;
  nativeKind: string;
  requestContract: string;
  receipts: string[];
  effect: string;
  cancellation: string;
}

const manifest = JSON.parse(
  await readFile(repoFile('native/page-engine/command-manifest.json'), 'utf8'),
) as { commands: ManifestCommand[]; sessionControls: Array<{ edgeType: string; requestContract: string; receipt: string | null }> };
const browseSessionSource = await readFile(repoFile('src/native-page-engine/browse-session.ts'), 'utf8');
const protocolSource = await readFile(repoFile('src/comm/protocol.ts'), 'utf8');
const commandRsSource = await readFile(repoFile('native/page-engine/src/command.rs'), 'utf8');

// ---------------------------------------------------------------------------
// 1. 从宿主源码里**导出** report() 的输出分派表（不是手抄一份再跟自己比）
// ---------------------------------------------------------------------------

/** 宿主上报方法 → 它发出的回执名。新增上报出口而不登记，下面的提取会当场失败。 */
const RECEIPT_EMITTERS: Readonly<Record<string, string>> = {
  reportPageCards: 'page.cards',
  reportNoteDetail: 'note.detail',
  reportProfileDetail: 'profile.detail',
  reportActionCompleted: 'action.completed',
};

/** 不产出「命令回执」的调用：巡视信号与本地投影，云端不靠它们给命令结案。 */
const NON_RECEIPT_CALLS = new Set([
  'observeFacebookProbe',
  'projectFacebookCardActivity',
  'emitUi',
  'emitFacebookAction',
  'searchContext',
  'diagnosticToken',
  'reportFacebookBlocking',
  'observeProbe',
  'logger',
]);

interface SegmentReceipts {
  always: Set<string>;
  /** 仅当信封类型等于该键时才发出的回执（现役唯一一处：搜索执行在卡片上报后补一条动作完成）。 */
  whenEnvelope: Map<string, Set<string>>;
  /**
   * 仅当输出里带了该随行载荷时才发出的回执（现役唯一一处：「回执 + 随行观测」的两段可选载荷）。
   * 这一层不能省：看图翻页只可能带详情快照、分类通知只可能带条目，
   * 把两者都算成「可达」会让对账凭空多出两条谁都发不出的回执。
   */
  whenCompanion: Map<string, Set<string>>;
}

/** 类里是否声明了这个方法（可见性修饰符可有可无），返回可用于定位方法体的签名前缀。 */
function declaredMethod(name: string): string | undefined {
  const match = browseSessionSource.match(
    new RegExp(`\\n\\s{2}((?:private |protected |public )?(?:async )?${name})\\(`),
  );
  return match?.[1];
}

function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `browse-session.ts must still declare ${signature}`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`unbalanced body for ${signature}`);
}

function collectReceipts(body: string, seen = new Set<string>()): SegmentReceipts {
  const always = new Set<string>();
  const whenEnvelope = new Map<string, Set<string>>();
  const whenCompanion = new Map<string, Set<string>>();
  const conditions: Array<{ envelopeType?: string; companion?: string; depth: number }> = [];
  const companionBindings = new Map<string, string>();
  let depth = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const binding = line.match(/^const ([A-Za-z]+) = value\.([A-Za-z]+);$/);
    if (binding) companionBindings.set(binding[1]!, binding[2]!);
    const envelopeGuard = line.match(/env\?\.type === '([a-z._]+)'/);
    const companionGuard = [...companionBindings.entries()]
      .find(([identifier]) => line.startsWith(`if (${identifier} && `))?.[1];
    const activeEnvelope = conditions.find((entry) => entry.envelopeType)?.envelopeType
      ?? envelopeGuard?.[1];
    const activeCompanion = conditions.find((entry) => entry.companion)?.companion
      ?? companionGuard;
    const record = (receipt: string): void => {
      if (activeCompanion) {
        const bucket = whenCompanion.get(activeCompanion) ?? new Set<string>();
        bucket.add(receipt);
        whenCompanion.set(activeCompanion, bucket);
        return;
      }
      if (activeEnvelope) {
        const bucket = whenEnvelope.get(activeEnvelope) ?? new Set<string>();
        bucket.add(receipt);
        whenEnvelope.set(activeEnvelope, bucket);
        return;
      }
      always.add(receipt);
    };
    for (const [method, receipt] of Object.entries(RECEIPT_EMITTERS)) {
      if (line.includes(`client.${method}(`)) record(receipt);
    }
    for (const send of line.matchAll(/client\.send\('([a-z._]+)'/g)) record(send[1]!);
    for (const call of line.matchAll(/this\.([A-Za-z]+)\(/g)) {
      const name = call[1]!;
      if (NON_RECEIPT_CALLS.has(name) || seen.has(name)) continue;
      if (Object.hasOwn(RECEIPT_EMITTERS, name)) continue;
      // 递归进宿主自己的上报段（现役唯一一处：动作回执的统一处理段）。
      // 找不到同名私有方法 = 这是个字段调用或新出口，必须显式登记，绝不默认它不发回执。
      const declaration = declaredMethod(name);
      assert.ok(
        declaration,
        `this.${name}( is neither a class method nor a registered non-receipt call`,
      );
      const nested = collectReceipts(
        methodBody(browseSessionSource, declaration),
        new Set([...seen, name]),
      );
      for (const receipt of nested.always) record(receipt);
      for (const [envelopeType, receipts] of nested.whenEnvelope) {
        const bucket = whenEnvelope.get(envelopeType) ?? new Set<string>();
        for (const receipt of receipts) bucket.add(receipt);
        whenEnvelope.set(envelopeType, bucket);
      }
      for (const [companion, receipts] of nested.whenCompanion) {
        const bucket = whenCompanion.get(companion) ?? new Set<string>();
        for (const receipt of receipts) bucket.add(receipt);
        whenCompanion.set(companion, bucket);
      }
    }
    // 未登记的 client.<method>( 出口一律当作漏网，逼作者登记而不是静默漏算。
    for (const call of line.matchAll(/client\.([A-Za-z]+)\(/g)) {
      const name = call[1]!;
      assert.ok(
        Object.hasOwn(RECEIPT_EMITTERS, name) || name === 'send',
        `unknown host receipt emitter client.${name}(); register it in RECEIPT_EMITTERS`,
      );
    }
    if (envelopeGuard) conditions.push({ envelopeType: envelopeGuard[1], depth });
    if (companionGuard) conditions.push({ companion: companionGuard, depth });
    depth += (line.match(/[{[(]/g)?.length ?? 0) - (line.match(/[}\])]/g)?.length ?? 0);
    while (conditions.length > 0 && depth <= conditions[conditions.length - 1]!.depth) {
      conditions.pop();
    }
  }
  return { always, whenEnvelope, whenCompanion };
}

function reportDispatchTable(): Map<string, SegmentReceipts> {
  const body = methodBody(browseSessionSource, 'private report(');
  const table = new Map<string, SegmentReceipts>();
  const cases = [...body.matchAll(/case '([a-z_]+)':/g)];
  assert.ok(cases.length > 0, 'report() must still dispatch on the output kind');
  for (const [index, match] of cases.entries()) {
    const start = match.index! + match[0].length;
    const end = index + 1 < cases.length ? cases[index + 1]!.index! : body.length;
    table.set(match[1]!, collectReceipts(body.slice(start, end)));
  }
  return table;
}

const DISPATCH = reportDispatchTable();

test('report() 的输出分派表未漂移（导出值 vs 本检查所依据的口径）', () => {
  const flattened = Object.fromEntries(
    [...DISPATCH.entries()].map(([kind, receipts]) => [
      kind,
      {
        always: [...receipts.always].sort(),
        whenEnvelope: Object.fromEntries(
          [...receipts.whenEnvelope.entries()].map(([type, set]) => [type, [...set].sort()]),
        ),
        whenCompanion: Object.fromEntries(
          [...receipts.whenCompanion.entries()].map(([name, set]) => [name, [...set].sort()]),
        ),
      },
    ]),
  );
  assert.deepEqual(flattened, {
    page_cards: {
      always: ['page.cards'],
      whenEnvelope: { 'search.execute': ['action.completed'] },
      whenCompanion: {},
    },
    note_detail: { always: ['note.detail'], whenEnvelope: {}, whenCompanion: {} },
    profile_detail: { always: ['profile.detail'], whenEnvelope: {}, whenCompanion: {} },
    identity_observation: { always: ['identity.observed'], whenEnvelope: {}, whenCompanion: {} },
    notification_home: { always: ['notification.home'], whenEnvelope: {}, whenCompanion: {} },
    notification_items: { always: ['notification.items'], whenEnvelope: {}, whenCompanion: {} },
    // 动作回执的统一处理段里，搜索执行那条分支同样只发动作完成，故与无条件一致。
    action_receipt: {
      always: ['action.completed'],
      whenEnvelope: { 'search.execute': ['action.completed'] },
      whenCompanion: {},
    },
    action_receipt_with_observation: {
      always: ['action.completed'],
      whenEnvelope: { 'search.execute': ['action.completed'] },
      whenCompanion: {
        noteDetail: ['note.detail'],
        notificationItems: ['notification.items'],
      },
    },
    page_probe: { always: [], whenEnvelope: {}, whenCompanion: {} },
    plan_results: { always: ['action.result'], whenEnvelope: {}, whenCompanion: {} },
  });
});

// ---------------------------------------------------------------------------
// 2. 每条命令在**成功路径**上的输出（跨平台取并集）
// ---------------------------------------------------------------------------

interface SuccessOutput {
  /** 引擎输出的 kind，必须是 report() 认识的那一批。 */
  output: string;
  platform: 'xiaohongshu' | 'facebook';
  /** 该输出可能携带的随行载荷（只对「回执 + 随行观测」有意义）。 */
  companions?: readonly string[];
  /** 出处：读到这条结论的文件与函数。 */
  source: string;
}

/**
 * 这张表由逐条实读得出（引擎 Rust 侧的拦截分支 + 两份页面规则的分派分支），
 * 键集必须恰好等于「经浏览会话下发」的那批命令 —— 新增一条命令而不在这里登记，下面的用例失败。
 */
const BROWSE_SUCCESS_OUTPUTS: Readonly<Record<string, readonly SuccessOutput[]>> = {
  plan_execute: [
    { output: 'plan_results', platform: 'xiaohongshu', source: 'xhs-command-router.js kind===plan_execute' },
  ],
  session_stop: [
    { output: 'action_receipt', platform: 'xiaohongshu', source: 'xhs-command-router.js kind===session_stop' },
    { output: 'action_receipt', platform: 'facebook', source: 'facebook/session.rs → 90-dispatch.js kind===session_stop' },
  ],
  page_scroll: [
    { output: 'page_cards', platform: 'xiaohongshu', source: 'engine.rs execute_xhs_feed_scroll（手势在引擎，卡片仍由注入路由的 initial_scan 只读扫描给出）' },
    { output: 'page_cards', platform: 'facebook', source: 'facebook/feed.rs execute_facebook_page_scroll' },
  ],
  feed_refresh: [
    { output: 'page_cards', platform: 'xiaohongshu', source: 'xhs-command-router.js kind===feed_refresh' },
    { output: 'page_cards', platform: 'facebook', source: 'facebook/feed.rs execute_facebook_feed_refresh' },
  ],
  search_execute: [
    { output: 'page_cards', platform: 'xiaohongshu', source: 'xhs-command-router.js kind===search_execute' },
    { output: 'page_cards', platform: 'facebook', source: 'facebook/feed.rs execute_facebook_search' },
  ],
  note_open: [
    { output: 'note_detail', platform: 'xiaohongshu', source: 'xhs-command-router.js kind===note_open (confirmedDetail)' },
    { output: 'note_detail', platform: 'facebook', source: 'facebook/feed.rs execute_facebook_note_navigation / 20-feed.js currentDetail' },
  ],
  note_close: [
    { output: 'action_receipt', platform: 'xiaohongshu', source: 'xhs-command-router.js kind===note_close' },
    { output: 'page_cards', platform: 'facebook', source: 'facebook/feed.rs execute_facebook_back_to_list' },
  ],
  navigation_back: [
    { output: 'action_receipt', platform: 'xiaohongshu', source: 'xhs-command-router.js kind===navigation_back' },
    { output: 'page_cards', platform: 'facebook', source: 'facebook/feed.rs execute_facebook_back_to_list' },
  ],
  note_browse_images: [
    {
      output: 'action_receipt_with_observation',
      platform: 'xiaohongshu',
      companions: ['noteDetail'],
      source: 'xhs-command-router.js kind===note_browse_images（抽到图才带 noteDetail 快照）',
    },
  ],
  note_scroll_comments: [
    { output: 'action_receipt', platform: 'xiaohongshu', source: 'engine.rs execute_xhs_comment_scroll（引擎特化后不再走注入路由）' },
  ],
  profile_open: [
    { output: 'profile_detail', platform: 'xiaohongshu', source: 'xhs-command-router.js kind===profile_open' },
  ],
  identity_read_current: [
    { output: 'identity_observation', platform: 'facebook', source: 'facebook/session.rs IdentityReadCurrent' },
  ],
  identity_read_self_profile: [
    { output: 'identity_observation', platform: 'xiaohongshu', source: 'engine.rs IdentityObservationSource::SelfProfile' },
  ],
  notification_open: [
    { output: 'notification_home', platform: 'xiaohongshu', source: 'xhs-command-router.js kind===notification_open' },
  ],
  notification_browse_comments: [
    { output: 'notification_items', platform: 'xiaohongshu', source: 'xhs-command-router.js notification_browse_* (category===comment)' },
  ],
  notification_browse_likes: [
    {
      output: 'action_receipt_with_observation',
      platform: 'xiaohongshu',
      companions: ['notificationItems'],
      source: 'xhs-command-router.js notification_browse_*（抽到发送者才带 notificationItems）',
    },
  ],
  notification_browse_follows: [
    {
      output: 'action_receipt_with_observation',
      platform: 'xiaohongshu',
      companions: ['notificationItems'],
      source: 'xhs-command-router.js notification_browse_*（抽到发送者才带 notificationItems）',
    },
  ],
  notification_back_home: [
    // 与 notification_open 同一个产出，因为二者共用同一份实现（`enterNotificationHome`）：
    // 这条命令回的是**通知首页三栏未读**，不是信息流卡片。此处曾登记成 page_cards ——
    // 那是按走岔了的实现（导航到 /explore）回填的，与 command-manifest.json 早已声明的
    // `receipts: ["notification.home", …]` 直接矛盾，却因为两处从不互相对账而并存了下来。
    { output: 'notification_home', platform: 'xiaohongshu', source: 'xhs-command-router.js kind===notification_back_home (enterNotificationHome)' },
  ],
  interaction_like: [
    { output: 'action_receipt', platform: 'xiaohongshu', source: 'xhs-command-router.js interaction_like/collect/follow' },
    { output: 'action_receipt', platform: 'facebook', source: 'facebook/shared.rs facebook_action_result' },
  ],
  interaction_collect: [
    { output: 'action_receipt', platform: 'xiaohongshu', source: 'xhs-command-router.js interaction_like/collect/follow' },
  ],
  interaction_follow: [
    { output: 'action_receipt', platform: 'xiaohongshu', source: 'xhs-command-router.js interaction_like/collect/follow' },
    { output: 'action_receipt', platform: 'facebook', source: 'facebook/shared.rs facebook_action_result' },
  ],
  interaction_comment: [
    { output: 'action_receipt', platform: 'xiaohongshu', source: 'engine.rs execute_xhs_comment（引擎特化后不再走注入路由）' },
    { output: 'action_receipt', platform: 'facebook', source: 'facebook/comment.rs facebook_action_result' },
  ],
  interaction_like_comment: [
    { output: 'action_receipt', platform: 'xiaohongshu', source: 'xhs-command-router.js kind===interaction_like_comment' },
  ],
  group_join: [
    { output: 'action_receipt', platform: 'facebook', source: 'facebook/group_join.rs facebook_action_result' },
  ],
};

/** 不经浏览会话下发的命令：回执由另一处宿主出口发出，本对账不覆盖，但必须点名出口。 */
const OUT_OF_BAND_EMITTERS: Readonly<Record<string, string>> = {
  publish_navigate_entry: 'src/main.ts client.send("publish.command.result")',
  publish_select_mode: 'src/main.ts client.send("publish.command.result")',
  publish_upload_image: 'src/main.ts client.send("publish.command.result")',
  publish_set_cover: 'src/main.ts client.send("publish.command.result")',
  publish_fill_field: 'src/main.ts client.send("publish.command.result")',
  publish_add_with_candidate: 'src/main.ts client.send("publish.command.result")',
  publish_set_option: 'src/main.ts client.send("publish.command.result")',
  publish_set_schedule: 'src/main.ts client.send("publish.command.result")',
  publish_submit: 'src/main.ts client.send("publish.command.result")',
  publish_capture_post_id: 'src/main.ts client.send("publish.command.result")',
  publish_capture_scheduled: 'src/main.ts client.send("publish.command.result")',
  publish_reconcile_scheduled: 'src/main.ts client.send("publish.command.result")',
  wechat_capture_session: 'src/native-page-engine/identity.ts (引擎内部读取，非云端信封)',
  identity_bootstrap: 'src/native-page-engine/identity.ts (引擎内部读取，非云端信封)',
  captcha_capture: 'src/captcha/* 协助链路',
  captcha_click: 'src/captcha/* 协助链路',
};

/**
 * 经浏览会话下发的命令 kind。**直接取那张表本身**，不再切源码文本。
 *
 * 原先按 `const nativeKinds = {` 到第一处 `} as const;` 切一段源码再正则捞 kind：
 * 改一次变量名（本仓 change `restore-native-actuation-humanization-and-locating` 把它导出成
 * `nativeCommandKindByEnvelopeType`，供时间指令门禁按表派生）就切出空串、已路由集合变成空集。
 * 这类失效不会报「找不到那张表」，只会让对账退化成「空集 == 空集」；改成从真实产物派生。
 */
const BROWSE_ROUTED = new Set<string>(Object.values(nativeCommandKindByEnvelopeType));

test('每条命令都必须登记它的下发路径（浏览会话 / 其他出口），不许有第三种「没人管」', () => {
  const kinds = manifest.commands.map((command) => command.nativeKind).sort();
  const declared = [...Object.keys(BROWSE_SUCCESS_OUTPUTS), ...Object.keys(OUT_OF_BAND_EMITTERS)].sort();
  assert.deepEqual(declared, kinds);
  assert.deepEqual([...BROWSE_ROUTED].sort(), Object.keys(BROWSE_SUCCESS_OUTPUTS).sort());
  for (const outputs of Object.values(BROWSE_SUCCESS_OUTPUTS)) {
    assert.ok(outputs.length > 0);
    for (const entry of outputs) {
      assert.ok(DISPATCH.has(entry.output), `report() cannot handle output ${entry.output}`);
      assert.ok(entry.source.length > 0);
      // 有随行载荷分支的输出，必须逐条命令说明它带哪几段——不说明就等于默认「全带」，
      // 那会把两条谁都发不出的回执算成可达。
      const companionAware = DISPATCH.get(entry.output)!.whenCompanion.size > 0;
      assert.equal(
        companionAware,
        (entry.companions ?? []).length > 0,
        `${entry.output} 的随行载荷声明与 report() 的分支对不上`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 3. 对账：声明 ↔ 成功路径上可达的发出点（两个方向）
// ---------------------------------------------------------------------------

function reachableReceipts(command: ManifestCommand): Set<string> {
  const reachable = new Set<string>();
  for (const entry of BROWSE_SUCCESS_OUTPUTS[command.nativeKind] ?? []) {
    const dispatch = DISPATCH.get(entry.output)!;
    for (const receipt of dispatch.always) reachable.add(receipt);
    for (const receipt of dispatch.whenEnvelope.get(command.edgeType) ?? []) reachable.add(receipt);
    for (const companion of entry.companions ?? []) {
      const receipts = dispatch.whenCompanion.get(companion);
      assert.ok(receipts, `${command.nativeKind} 声明的随行载荷 ${companion} 在 report() 里没有归宿`);
      for (const receipt of receipts) reachable.add(receipt);
    }
  }
  return reachable;
}

interface Mismatch {
  nativeKind: string;
  direction: 'declared_but_unreachable' | 'reachable_but_undeclared';
  receipt: string;
}

function reconcile(): Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const command of manifest.commands) {
    if (!Object.hasOwn(BROWSE_SUCCESS_OUTPUTS, command.nativeKind)) continue;
    const reachable = reachableReceipts(command);
    const declared = new Set(command.receipts);
    for (const receipt of declared) {
      if (!reachable.has(receipt)) {
        mismatches.push({ nativeKind: command.nativeKind, direction: 'declared_but_unreachable', receipt });
      }
    }
    for (const receipt of reachable) {
      if (!declared.has(receipt)) {
        mismatches.push({ nativeKind: command.nativeKind, direction: 'reachable_but_undeclared', receipt });
      }
    }
  }
  return mismatches.sort((left, right) => (
    `${left.nativeKind}:${left.direction}:${left.receipt}`
      .localeCompare(`${right.nativeKind}:${right.direction}:${right.receipt}`)
  ));
}

/**
 * 冻结清单：对账**当场暴露**、但本 change 不在这一轮改声明的缺口。
 *
 * 为什么不在这一轮当场改清单：`command-manifest.json` 整份被哈希进能力摘要
 * （`native/page-engine/build.rs`），而打包侧的期望摘要是写死在
 * `src/electron/native-page-engine-artifact.cjs` 里的常量，并由
 * `test/native-page-engine/build-contract.test.ts` 反向绑定成「必须等于清单的 sha256」。
 * 清单改一个字就必须同批改那个常量——那个文件归并行 change
 * `enforce-native-engine-artifact-gates`，本 change 不动它。
 * 声明本身不改变运行期行为（回执由宿主发，清单是契约声明），所以先冻结、随那批一起改；
 * 反过来在这里改一半，会让打包校验带着一个对不上的摘要出门。
 *
 * 纪律：这张表**只许缩短**。每条都写明消除动作；条目数由下面的用例锁住。
 */
const FROZEN_RECEIPT_GAPS: ReadonlyArray<Mismatch & { removal: string }> = [
  {
    nativeKind: 'plan_execute',
    direction: 'declared_but_unreachable',
    receipt: 'action.completed',
    removal: '兼容路径的计划执行回的是逐步结果（action.result），把声明改成 ["action.result"]',
  },
  {
    nativeKind: 'plan_execute',
    direction: 'reachable_but_undeclared',
    receipt: 'action.result',
    removal: '同上，一并写进声明',
  },
  {
    nativeKind: 'session_stop',
    direction: 'reachable_but_undeclared',
    receipt: 'action.completed',
    removal: '结束会话两平台都回动作回执，声明由 [] 改成 ["action.completed"]',
  },
  {
    nativeKind: 'page_scroll',
    direction: 'declared_but_unreachable',
    receipt: 'action.completed',
    removal: '滚动成功恒回卡片；删掉声明里的 action.completed',
  },
  {
    nativeKind: 'feed_refresh',
    direction: 'declared_but_unreachable',
    receipt: 'action.completed',
    removal: '刷新成功恒回卡片；删掉声明里的 action.completed',
  },
  {
    nativeKind: 'note_open',
    direction: 'declared_but_unreachable',
    receipt: 'action.completed',
    removal: '两平台成功恒回详情；删掉声明里的 action.completed',
  },
  {
    nativeKind: 'profile_open',
    direction: 'declared_but_unreachable',
    receipt: 'action.completed',
    removal: '成功恒回主页详情；删掉声明里的 action.completed',
  },
  {
    nativeKind: 'notification_open',
    direction: 'declared_but_unreachable',
    receipt: 'action.completed',
    removal: '成功恒回通知首页读数；删掉声明里的 action.completed',
  },
  {
    nativeKind: 'notification_browse_comments',
    direction: 'declared_but_unreachable',
    receipt: 'action.completed',
    removal: '评论类成功恒回条目；删掉声明里的 action.completed',
  },
  {
    nativeKind: 'notification_browse_likes',
    direction: 'reachable_but_undeclared',
    receipt: 'notification.items',
    removal: '「看一眼」两类的随行观测会带条目；补进声明',
  },
  {
    nativeKind: 'notification_browse_follows',
    direction: 'reachable_but_undeclared',
    receipt: 'notification.items',
    removal: '同上',
  },
  // 曾经冻结在这里的另外两条（`declared_but_unreachable: notification.home` 与
  // `reachable_but_undeclared: page.cards`）由 change `restore-notification-home-return` 消除。
  // 值得记一笔它们当初的消除动作写的是什么：「回首页成功回的是首页卡片，不是通知读数；
  // 改成 ["page.cards"]」—— 也就是**打算改声明去迁就实现**。而声明才是对的：云端下发这条
  // 命令就是为了拿三栏未读挑下一类，清单从一开始就写着 `["notification.home", …]`。
  // 教训是对账暴露出方向不一致时，「改哪一边」不能默认选实现那边。
  {
    nativeKind: 'notification_back_home',
    direction: 'declared_but_unreachable',
    receipt: 'action.completed',
    removal: '成功恒回通知首页读数；删掉声明里的 action.completed（与 notification_open 同因）',
  },
];

/** 初始条目数。后续 change 只许下降，涨了就是新缺口被静默冻结。 */
const FROZEN_GAP_BUDGET = 12;

test('声明的回执与成功路径上可达的发出点逐条对账（两个方向）', () => {
  const mismatches = reconcile();
  const frozen = new Set(FROZEN_RECEIPT_GAPS.map((gap) => `${gap.nativeKind}:${gap.direction}:${gap.receipt}`));
  const unfrozen = mismatches.filter((gap) => !frozen.has(`${gap.nativeKind}:${gap.direction}:${gap.receipt}`));
  assert.deepEqual(
    unfrozen,
    [],
    `命令清单声明的回执与宿主真能发出的回执对不上：\n${unfrozen
      .map((gap) => `  ${gap.nativeKind} ${gap.direction} ${gap.receipt}`)
      .join('\n')}`,
  );

  // 反向：冻结清单不许留下已经消除的条目（否则「只许缩短」会被一张过期的表架空）。
  const observed = new Set(mismatches.map((gap) => `${gap.nativeKind}:${gap.direction}:${gap.receipt}`));
  const stale = [...frozen].filter((key) => !observed.has(key));
  assert.deepEqual(stale, [], '冻结清单里有已经不成立的条目，删掉它并下调预算');

  assert.ok(FROZEN_RECEIPT_GAPS.length <= FROZEN_GAP_BUDGET, '冻结清单只许缩短');
  assert.equal(FROZEN_RECEIPT_GAPS.length, FROZEN_GAP_BUDGET);
  for (const gap of FROZEN_RECEIPT_GAPS) assert.ok(gap.removal.length > 0);
});

test('对账不把失败路径算进来（否则 action.completed 对每条命令都恒成立）', () => {
  // reportFailure 对任何命令都会发一条 ok:false 的动作完成——它必须留在对账之外。
  const failureBody = methodBody(browseSessionSource, 'private reportFailure(');
  assert.ok(failureBody.includes('client.reportActionCompleted('));
  const reachable = reachableReceipts(
    manifest.commands.find((command) => command.nativeKind === 'note_open')!,
  );
  assert.deepEqual([...reachable], ['note.detail']);
});

// ---------------------------------------------------------------------------
// 4. requestContract 必须解析到一个真实存在的具名请求契约
// ---------------------------------------------------------------------------

/**
 * 非云端信封契约的解析目标。左边是清单里的名字，右边是它到底指什么：
 * 投影类必须点名它投影自哪个云端载荷，内部命令必须点名引擎侧的具名参数结构。
 */
const CONTRACT_RESOLUTIONS: Readonly<Record<string, { base?: string; rustStruct?: string; via: string }>> = {
  PlanResponsePayloadAllowlistedProjection: {
    base: 'PlanResponsePayload',
    via: 'command-mapper.ts allowedByKind.plan_execute 白名单投影',
  },
  IdentityReadPayloadWithEdgeBoundAccount: {
    base: 'IdentityReadPayload',
    via: 'command-mapper.ts 为身份命令补 edge 绑定的 accountId',
  },
  EmptyParams: {
    rustStruct: 'EmptyParams',
    via: '引擎内部命令，无云端信封载荷',
  },
};

test('每条 requestContract 都解析到一个真实存在的具名请求契约', () => {
  const contracts = [
    ...manifest.commands.map((command) => ({ owner: command.nativeKind, name: command.requestContract })),
    ...manifest.sessionControls.map((control) => ({ owner: control.edgeType, name: control.requestContract })),
  ];
  for (const { owner, name } of contracts) {
    assert.match(name, /^[A-Za-z][A-Za-z0-9]*$/, `${owner} 的请求契约名不合法`);
    const resolution = CONTRACT_RESOLUTIONS[name];
    if (!resolution) {
      assert.match(
        protocolSource,
        new RegExp(`export (?:interface|type) ${name}\\b`),
        `${owner} 的请求契约 ${name} 在 src/comm/protocol.ts 里不存在`,
      );
      continue;
    }
    assert.ok(resolution.via.length > 0, `${name} 必须写明它怎么派生`);
    if (resolution.base) {
      assert.match(
        protocolSource,
        new RegExp(`export (?:interface|type) ${resolution.base}\\b`),
        `${name} 的基契约 ${resolution.base} 不存在`,
      );
    }
    if (resolution.rustStruct) {
      assert.match(
        commandRsSource,
        new RegExp(`pub struct ${resolution.rustStruct}\\b`),
        `${name} 的引擎侧结构 ${resolution.rustStruct} 不存在`,
      );
    }
  }
});

test('清单里的回执名只能出自一个封闭集合', () => {
  const KNOWN_RECEIPTS = new Set([
    'action.completed',
    'action.result',
    'page.cards',
    'note.detail',
    'profile.detail',
    'identity.observed',
    'notification.home',
    'notification.items',
    'publish.command.result',
    // 引擎内部读取的两条：不是云端消息类型，由宿主就地消费。
    'wechat_session_candidate',
    'identity_receipt',
    'captcha.assist.snapshot',
    'captcha.assist.click_result',
  ]);
  for (const command of manifest.commands) {
    for (const receipt of command.receipts) {
      assert.ok(KNOWN_RECEIPTS.has(receipt), `${command.nativeKind} 声明了未知回执 ${receipt}`);
    }
  }
  for (const kind of Object.keys(OUT_OF_BAND_EMITTERS)) {
    assert.ok(OUT_OF_BAND_EMITTERS[kind]!.length > 0, `${kind} 必须点名它的回执出口`);
  }
});
