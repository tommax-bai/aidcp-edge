'use strict';

// UI 事件解析（edge-companion-ui）：把核心进程 stdout 日志行翻译成桌面客户端的带类型 UI 事件。
// 供 main.cjs 与单测共用；无 Electron 依赖（纯 Node，可被 createRequire 直接引入）。
//
// 双层契约：
//   1) 结构化优先：核心输出 `[ui-event] {json}` 行 → 直接采用（长期出路；发射点在核心侧按需接入，
//      发布链路的插入点归 publish-edge-command-runtime 收口后串行处理，本模块只负责解析）。
//   2) 兜底映射：既有中文日志行 → 人话句子 / 在场感 / 节奏阶段 / 计数增量。现网核心零改动即可出活动流。
//
// 红线（不静默假成功）：只翻译真实发生的事件；失败行绝不计数。
// 与改版前 main.cjs 内联 substring 计数的**有意偏离**（旧法把失败行也计进数）：
//   - 旧：包含 'like'/'collect' 即 +1 → 「comment_like 点击后状态未变化」这类失败行也被计赞。
//   - 旧：包含 '上报'/'提取内容' 即 views+1 → 每轮 page.cards 上报、甚至「提取内容失败」都计浏览。
//   - 新：仅 ✓ 成功行计数；浏览数 = 真打开并上报 note.detail 的笔记数。宁少不虚。

const UI_EVENT_PREFIX = '[ui-event]';

// 事件形状（字段全部可选，按需携带）：
// {
//   kind: 'activity' | 'presence' | 'publish' | 'identity',
//   type: string,                     // 机器可读标签（'like' / 'note_open' / 'connect' / ...）
//   sentence: string,                 // 活动流一句话（人话）
//   presence: string,                 // 在场感行文案（当前正在做什么）
//   loopStage: 'feed'|'select'|'read'|'interact'|'return'|null,
//   statsDelta: { views?, likes?, collects?, comments? },
//   publish: { state:'pending'|'reminded'|'approved'|'published'|'rejected'|'failed', title?, code? },
//   account: { id, name },
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
      /✓ 点赞成功/,
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
      /✓ 评论发布成功/,
      () => ({
        kind: 'activity',
        type: 'comment',
        sentence: '写了一条评论并发布',
        presence: '刚发布了一条评论',
        loopStage: 'interact',
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
      () => ({ kind: 'activity', type: 'follow', sentence: '关注了这位作者', loopStage: 'interact' }),
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
      /阻断弹窗已清除，恢复浏览/,
      () => ({ kind: 'activity', type: 'popup_cleared', sentence: '弹窗已处理，继续浏览', presence: '继续浏览…' }),
    ],
    [
      /浏览循环结束/,
      () => ({
        kind: 'activity',
        type: 'session_end',
        sentence: '这一轮浏览结束',
        presence: '这一轮逛完了，休息一下…',
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
  };
}

module.exports = { createUiEventStream, UI_EVENT_PREFIX, clipTitle, mergeStats };
