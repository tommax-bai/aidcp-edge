'use strict';

// UI 事件解析（edge-companion-ui）：把核心进程 stdout 日志行翻译成桌面客户端的带类型 UI 事件。
// 供 main.cjs 与单测共用；无 Electron 依赖（纯 Node，可被 createRequire 直接引入）。
//
// 双层契约：
//   1) 结构化优先：核心输出 `[ui-event] {json}` 行 → 直接采用（长期出路；发射点在核心侧按需接入，
//      发布链路的插入点归 publish-edge-command-runtime 收口后串行处理，本模块只负责解析）。
//   2) 兜底映射：既有中文日志行 → 人话句子 / 在场感 / 节奏阶段 / 计数增量。现网核心零改动即可出活动流。
//
// 平台归属（change facebook-write-action-visibility 坐实，别再误会）：
//   - 下面那张兜底表 **是小红书浏览会话专属的**：22 条规则的措辞只由 `src/browse/browse-session.ts`
//     或仅 XHS 生效的 `if (autoBrowse)` 块打印（`autoBrowse` 按构造排除 Facebook）。
//   - **Facebook 一律走结构化层**（`src/facebook/companion-ui.ts` 是其唯一叙述器）。FB 的日志措辞
//     MUST NOT 依赖本表，也 MUST NOT 误命中本表里描述 XHS 专属行为的规则——曾发生：FB 的**就地读**
//     被 `/命令: profile\.open/` 叙述成「顺路去作者主页看看」（已在核心侧改措辞躲开）。
//   - 本表是**无保障的手工耦合**：解析器测试只测本文件、从不执行发射器 ⇒ 改一句核心日志措辞，
//     测试照样全绿而活动条目**静默消失**。新增覆盖请压在发射器侧。
//
// 红线（不静默假成功）：只翻译真实发生的事件；失败行绝不计数。
// 与改版前 main.cjs 内联 substring 计数的**有意偏离**（旧法把失败行也计进数）：
//   - 旧：包含 'like'/'collect' 即 +1 → 「comment_like 点击后状态未变化」这类失败行也被计赞。
//   - 旧：包含 '上报'/'提取内容' 即 views+1 → 每轮 page.cards 上报、甚至「提取内容失败」都计浏览。
//   - 新：仅 ✓ 成功行计数；浏览数 = 真打开并上报 note.detail 的笔记数。宁少不虚。

const UI_EVENT_PREFIX = '[ui-event]';

// 事件形状（字段全部可选，按需携带）。注意本解析器**对 kind / type 不作枚举校验**：只要求 kind 是
// string，其余原样透传 —— 故核心新增类型无需改本文件。下列 kind 清单是发射器现状的记录，非白名单：
// {
//   kind: 'activity' | 'presence' | 'publish' | 'publishPreview' | 'identity' | 'lastPublish'
//         | 'dailyUsage' | 'browserStandby' | 'personaBound' | 'personaWritingLanguage',
//   type: string,                     // 机器可读标签（'like' / 'note_open' / 'connect' / ...）
//                                     // FB 写动作（facebook-write-action-visibility）：
//                                     //   comment | comment_pending | comment_failed
//                                     //   join_group | join_pending | join_failed
//                                     //   search | search_failed | popup | popup_cleared
//   sentence: string,                 // 活动流一句话（人话）
//   presence: string,                 // 在场感行文案（当前正在做什么）
//   loopStage: 'feed'|'select'|'read'|'write'|'comment'|'interact'|'return'|null,
//   browserIndependent: true,         // 仅浏览器无关任务显式携带；缺省 loopStage 一律视为需要浏览器
//   statsDelta: { views?, likes?, collects?, comments? },
//   publish: { state:'pending'|'reminded'|'approved'|'published'|'rejected'|'failed', title?, code? },
//   publishPreview: { recordId, code, kind, title, content, topics, images, contentVersion, updatedAt },
//   account: { id, name },
//   lastPublish: { title, at },       // 云端快照回填「上次发布」（at=epoch ms）；不产活动流、不计数
// }

function tryParseStructured(line) {
  const at = line.indexOf(UI_EVENT_PREFIX);
  if (at === -1) return null;
  const raw = line.slice(at + UI_EVENT_PREFIX.length).trim();
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || typeof obj.kind !== 'string') return null;
    return obj;
  } catch {
    return null; // 结构化行坏了就当普通日志行走兜底，不抛错
  }
}

// 截断笔记标题用于叙述（活动流一行放得下）。
function clipTitle(title, max = 18) {
  const t = String(title || '').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function publishPresence(publish) {
  const title = clipTitle(publish && publish.title, 16);
  const subject = title ? `「${title}」` : '这条笔记';
  switch (publish && publish.state) {
    case 'pending':
      return `${subject}已发到飞书，等你确认…`;
    case 'reminded':
      return `${subject}还在等确认，飞书已再次提醒…`;
    case 'approved':
      return `${subject}已通过，正在择时发布…`;
    case 'submitted':
      return `${subject}已提交，待链接确认…`;
    case 'published':
      return `${subject}已发布，准备回到浏览…`;
    case 'rejected':
      return `${subject}暂不发布，继续浏览…`;
    case 'failed':
      return `${subject}发布未成功，已如实记录…`;
    default:
      return '';
  }
}

/**
 * 创建一条 UI 事件流。带极薄会话上下文（最近打开的笔记标题），用于把「✓ 点赞成功」这类
 * 无上下文的成功行叙述成「给「xxx」点了个赞」。上下文只增不猜：拿不到标题就说泛化句子。
 */
function createUiEventStream() {
  let lastNoteTitle = '';

  // 映射表：[匹配器, 事件构造器]。首个命中生效；都不命中返回 null（该行只进开发者详情）。
  const rules = [
    [
      /账号身份已确立: (\S+?)(?: \((.+?)\))? \[source=/,
      (m) => ({
        kind: 'identity',
        type: 'identity',
        account: { id: m[1], name: m[2] || '' },
        // 无昵称时绝不把长 id 塞进叙述（读取路径为 in-place 时 displayName 为 null，属常态）
        sentence: m[2] ? `账号「${m[2]}」已就位` : '账号已就位，准备开工',
        presence: '账号已就位，准备开工…',
      }),
    ],
    [
      /已连接云端/,
      () => ({
        kind: 'activity',
        type: 'connect',
        sentence: '已连接云端，开始今天的运营',
        presence: '已连接云端，等待安排…',
      }),
    ],
    [
      /自动浏览已启动/,
      () => ({
        kind: 'activity',
        type: 'session_start',
        sentence: '开始自动浏览',
        presence: '开始今天的浏览…',
        loopStage: 'feed',
      }),
    ],
    [
      /已上报 (\d+) 张可见卡片/,
      () => ({ kind: 'presence', type: 'feed', presence: '正在浏览推荐流…', loopStage: 'feed' }),
    ],
    [
      /命令: page\.scroll/,
      () => ({ kind: 'presence', type: 'scroll', presence: '刷一刷，看看新内容…', loopStage: 'feed' }),
    ],
    [
      /命令: note\.open/,
      () => ({ kind: 'presence', type: 'note_opening', presence: '挑中一篇笔记，正在打开…', loopStage: 'select' }),
    ],
    [
      /note\.open: 已上报 note\.detail .*?「(.*?)」/,
      (m) => {
        lastNoteTitle = clipTitle(m[1]);
        return {
          kind: 'activity',
          type: 'note_open',
          sentence: lastNoteTitle ? `打开笔记「${lastNoteTitle}」` : '打开了一篇笔记',
          presence: lastNoteTitle ? `正在认真读「${lastNoteTitle}」…` : '正在认真读这篇笔记…',
          loopStage: 'read',
          statsDelta: { views: 1 },
        };
      },
    ],
    [
      /^(?!.*\[fb-like\]).*✓ 点赞成功/,
      () => ({
        kind: 'activity',
        type: 'like',
        sentence: lastNoteTitle ? `给「${lastNoteTitle}」点了个赞` : '点了个赞',
        presence: '刚点了个赞',
        loopStage: 'interact',
        statsDelta: { likes: 1 },
      }),
    ],
    [
      /✓ 收藏成功/,
      () => ({
        kind: 'activity',
        type: 'collect',
        sentence: lastNoteTitle ? `收藏了「${lastNoteTitle}」` : '收藏了这篇笔记',
        presence: '收藏了这篇笔记',
        loopStage: 'interact',
        statsDelta: { collects: 1 },
      }),
    ],
    [
      /命令: interaction\.comment/,
      () => ({
        kind: 'presence',
        type: 'comment_composing',
        presence: '正在创作评论…',
        loopStage: 'comment',
      }),
    ],
    [
      /✓ 评论发布成功/,
      () => ({
        kind: 'activity',
        type: 'comment',
        sentence: '写了一条评论并发布',
        presence: '刚发布了一条评论',
        loopStage: 'comment',
        statsDelta: { comments: 1 },
      }),
    ],
    [
      // 评论点赞也是一次真实点赞（旧法经命令行 'like' 子串误触；新法按 ✓ 成功行计）。
      /✓ 评论点赞成功/,
      () => ({
        kind: 'activity',
        type: 'comment_like',
        sentence: '给一条评论点了赞',
        loopStage: 'interact',
        statsDelta: { likes: 1 },
      }),
    ],
    [
      /✓ 关注成功/,
      () => ({
        kind: 'activity',
        type: 'follow',
        sentence: '关注了这位作者',
        loopStage: 'interact',
        statsDelta: { follows: 1 },
      }),
    ],
    [
      /浏览了 (\d+)\/(\d+) 张图片/,
      (m) => ({ kind: 'activity', type: 'images', sentence: `看了 ${m[1]} 张配图`, loopStage: 'read' }),
    ],
    [
      /命令: note\.scroll_comments/,
      () => ({ kind: 'presence', type: 'comments', presence: '翻看评论区…', loopStage: 'read' }),
    ],
    [
      /命令: profile\.open/,
      () => ({ kind: 'presence', type: 'profile', presence: '顺路去作者主页看看…', loopStage: 'read' }),
    ],
    [
      /profile\.open: 作者资料 粉丝/,
      () => ({ kind: 'activity', type: 'profile_read', sentence: '看了作者主页', loopStage: 'read' }),
    ],
    [
      /命令: navigation\.back/,
      () => ({ kind: 'presence', type: 'back', presence: '返回推荐流，继续逛…', loopStage: 'return' }),
    ],
    [
      /命令: notification\./,
      () => ({ kind: 'presence', type: 'notification', presence: '正在巡视消息通知…' }),
    ],
    [
      /检测到「消息」未读/,
      () => ({ kind: 'activity', type: 'notification_found', sentence: '发现新的消息通知，安排查看' }),
    ],
    [
      // 真实阻断如实呈现（红线：绝不用「一切正常」盖住弹窗阻断）。
      /检测到(.+?)弹窗，暂停操作/,
      (m) => ({
        kind: 'activity',
        type: 'popup',
        sentence: `遇到${m[1]}弹窗，先停一停等处理`,
        presence: '遇到弹窗，暂停操作中…',
      }),
    ],
    [
      // 两条恢复信号：overlayReportGate 发「已清除」（云端上报路径，main.ts）、browse-session 循环发「已消失」
      // （本地闸放行路径）。两者都归一为 popup_cleared，使多环境的 overlayBlocked 待人工态可靠即时清除，
      // 不必等下一次成功互动兜底（否则纯登录墙路径清除会延迟）。
      /阻断弹窗已(清除|消失)，恢复浏览/,
      () => ({ kind: 'activity', type: 'popup_cleared', sentence: '弹窗已处理，继续浏览', presence: '继续浏览…' }),
    ],
    [
      /浏览循环结束(?:，预计休息约\s*(\d+)\s*分钟后继续)?/,
      (m) => ({
        kind: 'activity',
        type: 'session_end',
        sentence: m[1] ? `这一轮浏览结束，约 ${m[1]} 分钟后继续` : '这一轮浏览结束',
        presence: m[1] ? `这一轮逛完了，休息约 ${m[1]} 分钟后会继续` : '这一轮逛完了，休息一下…',
        loopStage: null,
      }),
    ],
  ];

  return {
    /** 解析一行日志 → UI 事件或 null（null = 该行只进开发者详情原始日志）。 */
    push(line) {
      const text = String(line || '').trim();
      if (!text) return null;
      const structured = tryParseStructured(text);
      if (structured) {
        // 结构化 publish 事件顺手更新标题上下文（叙述后续互动用）。
        if (structured.kind === 'publish' && structured.publish && structured.publish.title) {
          structured.publish.title = clipTitle(structured.publish.title, 30);
        }
        if (structured.kind === 'publish' && structured.publish && structured.publish.state && !structured.presence) {
          structured.presence = publishPresence(structured.publish);
        }
        if (structured.kind === 'publish' && structured.publish && structured.publish.state && structured.loopStage === undefined) {
          structured.loopStage = 'write';
        }
        if (structured.kind === 'lastPublish' && structured.lastPublish && structured.lastPublish.title) {
          structured.lastPublish.title = clipTitle(structured.lastPublish.title, 30);
        }
        return structured;
      }
      for (const [matcher, build] of rules) {
        const m = text.match(matcher);
        if (m) return build(m);
      }
      return null;
    },
  };
}

/**
 * 控制面已连接但浏览器仍在等执行槽位时，账号身份与 Cloud 连接都只是前置条件，不是「已开工」。
 * 等待事实由主进程传入；事件解析器不自行猜浏览器状态。
 */
function projectBrowserSlotWaitingEvent(event, waitingForSlot) {
  if (!event || !waitingForSlot || (event.type !== 'identity' && event.type !== 'connect')) return event;
  const copy = event.type === 'identity'
    ? '账号身份已确认，等待浏览器槽位'
    : '自动化引擎已连接，等待浏览器槽位';
  return { ...event, sentence: copy, presence: copy };
}

/**
 * 合并计数补丁：partial patch 只带变化项，其余计数必须保留（修「一次 {views:+1} 把
 * 点赞/收藏清空」的老 bug——updateStatus 先 Object.assign 整体替换、再合并已替换对象）。
 * 纯函数供 main.cjs 与单测共用；数值兜底 0，绝不让 undefined 漏进渲染层。
 */
function mergeStats(prev, patch) {
  const base = prev || {};
  const next = { ...base, ...(patch || {}) };
  return {
    views: Number(next.views) || 0,
    likes: Number(next.likes) || 0,
    collects: Number(next.collects) || 0,
    comments: Number(next.comments) || 0,
    follows: Number(next.follows) || 0,
    publishes: Number(next.publishes) || 0,
  };
}

module.exports = {
  createUiEventStream,
  UI_EVENT_PREFIX,
  clipTitle,
  mergeStats,
  projectBrowserSlotWaitingEvent,
};
