/**
 * 小红书（XHS）业务锚点描述符。
 *
 * 这里只声明"语义锚点模板"（role/text 线索 + 自然语言目标），不含混淆 class。
 * 锚点经反污染回写晋升后才会进主缓存；首次无缓存时作为 anchorHint 兜底，
 * 同时为文本 LLM 选择提供 goal。
 *
 * 点赞按钮的文本/可访问名常见形态：
 * - "点赞" / "赞" / aria-label="点赞"
 * - "喜欢" / "xihuan" / "dianzan"（拼音/英文 hint，少数主题或埋点）
 * - 心形图标（heart）：通常落在 aria-label / title / data-* 上
 */

import type { Anchor, ScopeSpec } from '../locating/types.js';

/** XHS 点赞按钮的稳定 actionId（与云端 planner 的 note.like_button 对齐） */
export const XHS_LIKE_ACTION_ID = 'note.like_button';

/**
 * 小红书笔记详情容器（弹层 / 详情页）的特征性 CSS 选择器。
 *
 * 背景：explore 瀑布流页面上同时存在 N 条笔记卡片，每张卡片都有自己的
 * like-wrapper（实测 18 个）。点开某条笔记后会弹出详情弹层（modal/overlay），
 * 弹层内也有一个 like-wrapper —— 那才是「当前正在看的这条」要点赞的目标。
 *
 * 这里用一组按优先级排列的候选选择器锁定该弹层/详情容器：命中后把抽取
 * 作用域限定到容器内，extractor 就只会抽到弹层里的那 1 个 like-wrapper。
 *
 * 选择器设计原则（与反混淆一致）：只认人类可读、跨改版稳定的语义片段
 * （note-detail / note-container / noteContainer），用 [class*=...] 容忍
 * BEM/前缀与混淆 class 共存（如 class="note-detail-mask css-1a2b3c"）。
 * 逗号分隔多个候选，querySelector 按文档顺序取首个命中。
 */
export const XHS_NOTE_MODAL_SELECTOR =
  '.note-detail-mask, [class*="note-detail"], [class*="noteDetail"], ' +
  '[class*="note-container"], [class*="noteContainer"], ' +
  '.note-detail, #noteContainer, [class*="note-modal"]';

/**
 * 点赞作用域：把定位限制在「当前打开的笔记详情容器」内。
 * 用 CSS 选择器锁定弹层，消除 explore 瀑布流里其余卡片 like-wrapper 的干扰。
 */
export const XHS_NOTE_SCOPE: ScopeSpec = {
  selector: XHS_NOTE_MODAL_SELECTOR,
};

/**
 * XHS 点赞按钮的"语义 class 线索"。
 *
 * 小红书互动栏不暴露任何无障碍语义（无 aria-label / 无 role=button / 无"点赞"
 * 文本，图标是纯 SVG，计数是裸数字），唯一稳定可读的锚点是手写语义 class
 * `like-wrapper`。它属于 extractor 反混淆白名单，可作为稳定属性参与匹配。
 *
 * 实际 DOM 结构（语义 class 路径）：
 *   section.note-item > div.footer > div.author-wrapper > span.like-wrapper
 *                                                          └─ <svg heart/> + 计数数字
 */
export const XHS_LIKE_CLASS_HINT = 'like-wrapper';

/**
 * 点赞按钮所在的语义 class 结构路径（仅用于文档/调试与 LLM 提示，
 * 不写死进匹配——匹配只认 classHint 这一稳定语义片段）。
 */
export const XHS_LIKE_STRUCTURAL_PATH =
  'note-item > footer > author-wrapper > like-wrapper';

/**
 * 点赞按钮文本/可访问名提示词（喂给文本 LLM 选择时拼进 goal，提高召回）。
 * 覆盖中文、拼音、英文与"心形图标"语义。
 */
export const XHS_LIKE_TEXT_HINTS = [
  '点赞',
  '赞',
  '喜欢',
  'dianzan',
  'xihuan',
  'like',
  'heart',
  '心形',
] as const;

/**
 * 给文本 LLM 的自然语言目标：描述清楚"当前这条笔记的点赞按钮（心形图标）"，
 * 并附带常见文本/拼音提示，帮助在多个可交互元素中选出唯一目标。
 */
export const XHS_LIKE_GOAL =
  '点赞当前这条笔记：找到点赞按钮（通常是心形图标 heart，可访问名/文本可能是' +
  `「${XHS_LIKE_TEXT_HINTS.join('」「')}」之一），它通常位于笔记互动栏。` +
  '若页面无任何无障碍属性，可依据语义类名定位：互动栏结构通常为 ' +
  `${XHS_LIKE_STRUCTURAL_PATH}，点赞控件的 class 含 ${XHS_LIKE_CLASS_HINT}（含心形 SVG 与计数数字）。`;

/**
 * 点赞按钮的兜底锚点模板（首次无主缓存时作为 anchorHint）。
 * 只给 role + 文本线索，不写死任何混淆属性；textMatch=contains 以容忍
 * "点赞 12"这类带计数的可访问名。
 */
export const XHS_LIKE_ANCHOR_HINT: Omit<Anchor, 'actionId'> = {
  role: 'button',
  text: '点赞',
  textMatch: 'contains',
  // 语义 class 兜底：当页面无 aria/role/text（小红书）时，靠白名单语义 class 命中。
  // role/text 与 classHint 同时给出，匹配器按"指定信号占比"打分，能兼容两类站点。
  classHint: XHS_LIKE_CLASS_HINT,
  // 作用域兜底：先把定位限制在当前笔记详情弹层内，消除 explore 瀑布流里其余
  // 卡片 like-wrapper 的干扰。弹层不存在时 extractor 走 scopeFallback='root'
  // 降级整页抽取（单条笔记页/无弹层场景仍可定位）。
  scope: XHS_NOTE_SCOPE,
};

/** 完整锚点（含 actionId），供建库/离线写主缓存用 */
export const XHS_LIKE_ANCHOR: Anchor = {
  actionId: XHS_LIKE_ACTION_ID,
  ...XHS_LIKE_ANCHOR_HINT,
};

/** XHS 发布入口按钮的稳定 actionId。 */
export const XHS_PUBLISH_ENTRY_ACTION_ID = 'note.publish_entry';
/** XHS 发布标题输入框的稳定 actionId。 */
export const XHS_PUBLISH_TITLE_ACTION_ID = 'note.publish_title';
/** XHS 发布正文输入框的稳定 actionId。 */
export const XHS_PUBLISH_CONTENT_ACTION_ID = 'note.publish_content';
/** XHS 发布标签输入框/入口的稳定 actionId。 */
export const XHS_PUBLISH_TAG_ACTION_ID = 'note.publish_tag';
/** XHS 提交发布按钮的稳定 actionId。 */
export const XHS_PUBLISH_SUBMIT_ACTION_ID = 'note.publish_submit';

const XHS_PUBLISH_SCOPE: ScopeSpec = {
  selector:
    '.publish-container, [class*="publish-container"], [class*="publishContainer"], ' +
    '.note-edit-container, [class*="note-edit"], [class*="noteEdit"], ' +
    '.creator-container, [class*="creator-container"]',
};

export const XHS_PUBLISH_ENTRY_GOAL =
  '进入笔记发布页：找到页面中的发布/创作入口按钮，常见文本/可访问名可能是「发布」「去发布」「发笔记」「写笔记」「创建」「创作中心」「发布笔记」「发图文」。';
export const XHS_PUBLISH_ENTRY_ANCHOR_HINT: Omit<Anchor, 'actionId'> = {
  text: '创作',
  textMatch: 'contains',
};

export const XHS_PUBLISH_TITLE_GOAL =
  '在发布页填写标题：找到标题输入框，常见文本/占位提示可能是「标题」「填写标题」「输入标题」。';
export const XHS_PUBLISH_TITLE_ANCHOR_HINT: Omit<Anchor, 'actionId'> = {
  role: 'textbox',
  text: '标题',
  textMatch: 'contains',
  scope: XHS_PUBLISH_SCOPE,
};

export const XHS_PUBLISH_CONTENT_GOAL =
  '在发布页填写正文：找到正文输入框或内容编辑区，常见文本/占位提示可能是「正文」「输入正文」「添加正文」「写点什么」。';
export const XHS_PUBLISH_CONTENT_ANCHOR_HINT: Omit<Anchor, 'actionId'> = {
  role: 'textbox',
  text: '正文',
  textMatch: 'contains',
  scope: XHS_PUBLISH_SCOPE,
};

export const XHS_PUBLISH_TAG_GOAL =
  '在发布页添加标签：找到标签输入框或添加话题入口，常见文本/可访问名可能是「标签」「话题」「添加标签」「添加话题」。';
export const XHS_PUBLISH_TAG_ANCHOR_HINT: Omit<Anchor, 'actionId'> = {
  role: 'textbox',
  text: '标签',
  textMatch: 'contains',
  scope: XHS_PUBLISH_SCOPE,
};

export const XHS_PUBLISH_SUBMIT_GOAL =
  '提交发布当前笔记：找到最终发布按钮，常见文本/可访问名可能是「发布」「立即发布」「确认发布」。';
export const XHS_PUBLISH_SUBMIT_ANCHOR_HINT: Omit<Anchor, 'actionId'> = {
  role: 'button',
  text: '发布',
  textMatch: 'contains',
  scope: XHS_PUBLISH_SCOPE,
};
