/**
 * 笔记内容提取（从当前打开的笔记 modal）。
 *
 * 用 DomProvider 取页面 DOM 快照（真实环境为 CDP outerHTML + jsdom 解析，单测直接喂
 * jsdom document），在笔记详情容器作用域内抽取标题/正文/作者/点赞/收藏/评论/标签，
 * 并判断当前是否已点赞。
 *
 * 数字解析覆盖中文计数惯例：'1.2w' / '1.2万' → 12000，'999' → 999，'1万' → 10000，
 * 带千分位 '1,234' → 1234。无法解析时返回 0（绝不臆造）。
 */

import type { DomProvider } from '../locating/engine.js';
import { findScope } from '../locating/extractor.js';
import { isLikedElement } from '../flows/like-post.js';
import { XHS_NOTE_SCOPE } from '../flows/anchors.js';

export interface NoteContent {
  title: string;
  body: string;
  author: string;
  /** 点赞数（已解析） */
  likes: number;
  /** 收藏数 */
  collects: number;
  /** 评论数 */
  comments: number;
  /** 话题标签（不含 # 包裹符） */
  tags: string[];
  /** 笔记 URL */
  noteUrl?: string;
  /** 当前是否已点赞 */
  isLiked: boolean;
}

/**
 * 解析中文计数文本为整数。
 * 支持：'1.2w'/'1.2W'/'1.2万' → 12000，'3.5k' → 3500，'1,234' → 1234，
 * '999' → 999，'10万+' → 100000，纯文本/空 → 0。
 */
export function parseCount(raw: string | null | undefined): number {
  if (!raw) return 0;
  const s = String(raw).trim().toLowerCase().replace(/,/g, '').replace(/\+$/, '');
  if (!s) return 0;
  // 提取数字 + 可选单位
  const m = s.match(/(\d+(?:\.\d+)?)\s*(w|万|k|千|百)?/);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  if (Number.isNaN(num)) return 0;
  const unit = m[2];
  switch (unit) {
    case 'w':
    case '万':
      return Math.round(num * 10000);
    case 'k':
    case '千':
      return Math.round(num * 1000);
    case '百':
      return Math.round(num * 100);
    default:
      return Math.round(num);
  }
}

/** 从话题文本里抽取 #标签#（小红书）或 #标签 形式，去重去 # 包裹符。 */
export function extractTags(text: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  // 优先匹配 #xxx# 双井号包裹；再兜底匹配 #xxx（到空白/换行止）。
  const re = /#([^#\s][^#]*?)(?:#|(?=\s)|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tag = m[1].trim();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

/** 在作用域内取首个命中选择器的元素文本 */
function textOf(scope: Element, selectors: string[]): string {
  for (const sel of selectors) {
    const el = scope.querySelector(sel);
    const t = (el?.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return '';
}

/** 在作用域内取首个命中选择器元素的某属性 */
function attrOf(scope: Element, selectors: string[], attr: string): string {
  for (const sel of selectors) {
    const el = scope.querySelector(sel);
    const v = el?.getAttribute(attr);
    if (v) return v;
  }
  return '';
}

/**
 * 在某个数字计数控件附近取其计数文本：先取控件自身文本，
 * 命中类似 like-wrapper / collect-wrapper / comment-wrapper 的语义容器。
 */
function countNear(scope: Element, classKeywords: string[]): number {
  const all = Array.from(scope.querySelectorAll('*')) as Element[];
  for (const el of all) {
    const cls = (el.getAttribute('class') || '').toLowerCase();
    if (classKeywords.some((k) => cls.includes(k))) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const n = parseCount(t);
      if (n > 0) return n;
    }
  }
  return 0;
}

/** 判断作用域内点赞控件是否已点赞 */
function detectLiked(scope: Element): boolean {
  const candidates = Array.from(
    scope.querySelectorAll('[class*="like"], [aria-label*="赞"], [title*="赞"]'),
  ) as Element[];
  for (const el of candidates) {
    if (isLikedElement(el)) return true;
  }
  return false;
}

/**
 * 从当前打开的 modal 中提取笔记内容。
 * 找不到笔记详情容器时降级到整个 document 抽取（单条笔记页场景）。
 */
export async function extractNoteContent(dom: DomProvider): Promise<NoteContent> {
  const root = await dom.getRoot();
  // 找笔记详情容器；未命中则降级用 documentElement / body。
  let scope = XHS_NOTE_SCOPE.selector ? findScope(root, XHS_NOTE_SCOPE) : null;
  if (!scope) {
    const doc = (root as Document).documentElement ? (root as Document) : null;
    scope = doc?.body ?? (root as Element);
  }
  const container = scope as Element;

  const title = textOf(container, [
    '#detail-title',
    '.title',
    '[class*="title"]',
    'h1',
  ]);
  const body = textOf(container, [
    '#detail-desc',
    '.desc',
    '.note-content',
    '[class*="desc"]',
    '[class*="content"]',
  ]);
  const author = textOf(container, [
    '.author-wrapper .name',
    '.author .name',
    '[class*="author"] [class*="name"]',
    '[class*="author"]',
  ]);

  const likes = countNear(container, ['like-wrapper', 'like']);
  const collects = countNear(container, ['collect-wrapper', 'collect']);
  const comments = countNear(container, ['comment-wrapper', 'chat-wrapper', 'comment']);

  const noteUrl = attrOf(container, ['a[href*="/explore/"]', 'a[href*="/discovery/"]'], 'href');

  const tags = extractTags(`${title} ${body}`);
  const isLiked = detectLiked(container);

  const content: NoteContent = {
    title,
    body,
    author,
    likes,
    collects,
    comments,
    tags,
    isLiked,
  };
  if (noteUrl) content.noteUrl = noteUrl;
  return content;
}
