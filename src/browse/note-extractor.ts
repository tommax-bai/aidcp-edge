/**
 * 笔记内容提取（从当前打开的笔记 modal）。
 *
 * 用 DomProvider 取页面 DOM 快照（真实环境为 CDP outerHTML + jsdom 解析，单测直接喂
 * jsdom document），在笔记详情容器作用域内抽取标题/正文/作者/点赞/收藏/评论/标签，
 * 并判断当前是否已点赞。
 *
 * 数字解析覆盖中文计数惯例：'1.2w' / '1.2万' → 12000，'999' → 999，'1万' → 10000，
 * 带千分位 '1,234' → 1234。无法解析时返回 0（绝不臆造）。
 *
 * ⚠️ 发布时刻抽取（change feed-hot-lead-group-comment）的选择器为最佳猜测，需运营机真机标定
 * （见 NOTE_PUBLISHED_AT_SELECTORS 注释）。边缘只抽正文列底部日期容器的【原始串】、不解析、不判热度；
 * 该日期选择器与正文白名单 NOTE_BODY_SELECTORS【物理隔离】——历史 bug f8712f5 曾把「标题+发布时间」
 * 裸抓进正文，故日期节点绝不落在正文文本容器内，抽不到诚实置空、MUST NOT 臆造。
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
  /** Original note carousel images, ordered and deduplicated. */
  images: Array<{ index: number; url: string; width?: number; height?: number; alt?: string }>;
  /** 当前是否已点赞 */
  isLiked: boolean;
  /** 发布相对时刻原始文本（change feed-hot-lead-group-comment）：如「3小时前 / 昨天 14:30 / 07-05」。
   *  只抽正文列底部日期容器的原始串、不解析；抽不到则 undefined、MUST NOT 臆造。 */
  publishedAtText?: string;
}

// 抓取精选集时单条笔记轮播图的提取上限（截图参考素材，非发布图张数）。18 = 小红书单帖图片数上界。
// 与发布侧 IMAGE_COUNT_HARD_MAX/REFERENCE_IMAGE_MAX_COUNT=9（小红书图文帖硬约束）无关，勿混改。
const NOTE_IMAGE_HARD_MAX = 18;

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
function textOf(scope: Element, selectors: readonly string[]): string {
  for (const sel of selectors) {
    const el = scope.querySelector(sel);
    const t = (el?.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return '';
}

/** 块级边界视为换行的标签（正文段落结构；jsdom 无布局，只能按标签语义判块级）。 */
const LINE_BREAK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR',
]);

/**
 * 取元素文本并保留行结构：<br> 与块级元素边界映射为 \n，文本节点里的字面 \n 保留；
 * 只压缩空格/制表符/nbsp，行首行尾空白收敛，连续空行至多留一个。
 * 背景：正文若走 textOf 的 `\s+`→' ' 压缩，段落换行全部丢失（curated_content.body 实测 0/64 含换行）；
 * DOM 快照来自 outerHTML + jsdom（无布局、innerText 不可用），<br> 在 textContent 下连空格都不留，
 * 故必须自行把行结构序列化出来。
 */
export function textWithNewlines(el: Element): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = (node as Element).tagName.toUpperCase();
    if (tag === 'BR') {
      parts.push('\n');
      return;
    }
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
    const isBlock = LINE_BREAK_TAGS.has(tag);
    if (isBlock) parts.push('\n');
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    if (isBlock) parts.push('\n');
  };
  walk(el);
  return parts
    .join('')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 正文专用取文本：保留换行（标题/作者/计数等单行字段仍走 textOf 的单行压缩）。 */
function bodyTextOf(scope: Element, selectors: readonly string[]): string {
  for (const sel of selectors) {
    const el = scope.querySelector(sel);
    if (!el) continue;
    const t = textWithNewlines(el);
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

function parseSrcset(srcset: string | null | undefined): string {
  if (!srcset) return '';
  const first = srcset
    .split(',')
    .map((p) => p.trim().split(/\s+/)[0])
    .find(Boolean);
  return first ?? '';
}

function normalizeImageUrl(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  if (s.startsWith('//')) return `https:${s}`;
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}

function numberAttr(img: HTMLImageElement, attr: 'width' | 'height'): number | undefined {
  const fromProp = Number(img[attr]);
  if (Number.isFinite(fromProp) && fromProp > 0) return Math.floor(fromProp);
  const fromAttr = Number(img.getAttribute(attr));
  return Number.isFinite(fromAttr) && fromAttr > 0 ? Math.floor(fromAttr) : undefined;
}

function isNonNoteImage(img: HTMLImageElement): boolean {
  const container = img.closest('[class*="avatar"], [class*="user-avatar"], [class*="author"]');
  if (container) return true;
  if (img.closest('.swiper-slide-duplicate')) return true;
  const cls = (img.getAttribute('class') || '').toLowerCase();
  return cls.includes('avatar') || cls.includes('emoji');
}

/**
 * Extract original note carousel image references. This only reads DOM URLs.
 */
export function extractNoteImages(container: Element, limit = NOTE_IMAGE_HARD_MAX): NoteContent['images'] {
  const cap = Math.max(0, Math.min(Math.floor(limit), NOTE_IMAGE_HARD_MAX));
  if (cap <= 0) return [];
  const selectors = [
    '.swiper-slide:not(.swiper-slide-duplicate) img',
    'img.note-slider-img',
    '.note-slider-img',
    '[class*="media"] img',
  ];
  const nodes: HTMLImageElement[] = [];
  const seenNode = new Set<Element>();
  for (const sel of selectors) {
    for (const el of Array.from(container.querySelectorAll(sel))) {
      const element = el as Element;
      const img = (element.tagName?.toUpperCase() === 'IMG' ? element : element.querySelector?.('img')) as HTMLImageElement | null;
      if (!img || seenNode.has(img)) continue;
      seenNode.add(img);
      nodes.push(img);
    }
  }

  const seenUrl = new Set<string>();
  const images: NoteContent['images'] = [];
  for (const img of nodes) {
    if (isNonNoteImage(img)) continue;
    const url = normalizeImageUrl(
      img.currentSrc || img.getAttribute('src') || parseSrcset(img.getAttribute('srcset')) || img.getAttribute('data-src'),
    );
    if (!url || seenUrl.has(url)) continue;
    seenUrl.add(url);
    const alt = (img.getAttribute('alt') || '').trim();
    const item: NoteContent['images'][number] = {
      index: images.length,
      url,
    };
    const width = numberAttr(img, 'width');
    const height = numberAttr(img, 'height');
    if (width) item.width = width;
    if (height) item.height = height;
    if (alt) item.alt = alt;
    images.push(item);
    if (images.length >= cap) break;
  }
  return images;
}

/**
 * 在某个数字计数控件附近取其计数文本：先取控件自身文本，
 * 命中类似 like-wrapper / collect-wrapper / comment-wrapper 的语义容器。
 */
function countNear(scope: Element, classKeywords: string[]): number {
  const all = Array.from(scope.querySelectorAll('*')) as Element[];
  // 按关键词优先级【两遍扫描】：先精确容器（如 like-wrapper）全扫一遍，再退松匹配（如 like 子串）。
  // 否则 DOM 里靠前的松匹配元素（collect/comment 的 count）会抢先命中，造成 feed/detail 点赞数口径不一。
  for (const kw of classKeywords) {
    for (const el of all) {
      const cls = (el.getAttribute('class') || '').toLowerCase();
      if (cls.includes(kw)) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const n = parseCount(t);
        if (n > 0) return n;
      }
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
 * 笔记正文容器选择器——【渲染门 waitForNoteBody 与抽取器 extractNoteContent 共用同一份】，
 * 避免门通过但抽取器未命中（或反之）的漂移。按优先级：#detail-desc 系列优先，再退布局变体
 * （note-scroller / note-content 内的 .note-text/.desc 末级文本节点）。
 * 【刻意不含】裸 `.note-content` / `[class*="content"]`：它们会把"标题+发布时间(刚刚)"拼进正文
 * （假阳性，f8712f5 实测根因）。变体一律下钻到 .note-text/.desc，既救回长文布局变体（治假阴性）
 * 又不泄漏标题。
 */
export const NOTE_BODY_SELECTORS: readonly string[] = [
  '#detail-desc',
  '.note-detail-mask .desc',
  '.desc',
  '#detail-desc .note-text',
  '.note-scroller .note-text',
  '[class*="note-content"] .note-text',
  '[class*="note-content"] .desc',
];

/**
 * 非笔记插页标题 denylist（小红书把「猜你想搜」搜索推荐行等混进瀑布流 / 详情页）：抽到这些串视为未命中,
 * 既防详情标题被污染（真机实测详情标题偶发被抓成「猜你想搜」），也供 feed 卡片识别跳过这些插页（见 feed-scroller CARD_SCAN）。
 */
export const INTERSTITIAL_TITLES: ReadonlySet<string> = new Set(['猜你想搜', '猜你想看', '大家都在搜']);

/**
 * 发布相对时刻【窄选择器】（change feed-hot-lead-group-comment）。
 * ⚠️ 选择器需运营机真机标定：以下均为最佳猜测。小红书详情页发布时刻位于【正文列底部的日期容器】
 * （常见结构 `.bottom-container > .date`，文本形如「编辑于 3小时前 广东」/「昨天 14:30」/「07-05」），
 * 与标题/正文同处一片区——历史 bug f8712f5 曾把「标题+发布时间」裸抓进正文。
 * 隔离设计：① 只取日期【叶子节点】、优先 bottom-container 作用域；② 与正文白名单 NOTE_BODY_SELECTORS
 * 物理隔离（是两份独立常量、互不交叉）；③ 抽取时再过一道正文文本容器 denylist
 * （见 NOTE_BODY_TEXT_DENYLIST），命中正文文本容器内的候选一律跳过，绝不把正文当日期。
 * 末两条 `.date` / `[class*="date"]` 为兜底、匹配偏宽（如评论区日期、误含 "date" 子串的类），仅在前面全落空时用，务必真机确认。
 */
export const NOTE_PUBLISHED_AT_SELECTORS: readonly string[] = [
  '.bottom-container .date',
  '[class*="bottom-container"] .date',
  '.bottom-container time',
  'time[datetime]',
  '.date',
  '[class*="date"]',
];

/**
 * 正文【文本叶子容器】denylist：发布时刻抽取时，凡候选日期节点本身位于这些正文文本容器内即跳过，
 * 与正文抽取物理隔离（防 f8712f5 类「标题+发布时间」串进正文，反向亦然）。
 * 注意【刻意不含】宽泛的 `.note-content` / `[class*="content"]`：真机里日期容器本就嵌在 note-content 列内，
 * 排它会误杀合法日期；这里只排真正承载正文文字的末级容器（#detail-desc / .desc / .note-text）。
 */
const NOTE_BODY_TEXT_DENYLIST = '#detail-desc, .desc, .note-text';

/**
 * 从笔记详情作用域抽发布时刻【原始文本】（trim 后），抽不到返回 undefined。
 * 只读原始串、不解析（云端解析成小时数并算热度速率）；命中正文文本容器内的候选一律跳过（隔离于正文）。
 */
export function extractPublishedAtText(container: Element): string | undefined {
  for (const sel of NOTE_PUBLISHED_AT_SELECTORS) {
    for (const el of Array.from(container.querySelectorAll(sel))) {
      // 隔离闸：日期节点若落在正文文本容器内则跳过（绝不把正文首段误当发布时刻）。
      if ((el as Element).closest(NOTE_BODY_TEXT_DENYLIST)) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
  }
  return undefined;
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

  // 标题：收紧选择器——去掉贪婪的 [class*="title"] 与裸 h1（作用域降级到整页时它们会命中全局
  // 「猜你想搜」搜索推荐插页标题，真机实测污染源）；再过一道插页 denylist,命中则视为未抓到（置空）,
  // 交由调用方（openAndReportNote）回退卡片标题。⚠️选择器需真机校准：确认 #detail-title/.title 仍是现行详情标题。
  let title = textOf(container, ['#detail-title', '.note-content .title', '.title']);
  if (INTERSTITIAL_TITLES.has(title)) title = '';
  // 正文取共享 NOTE_BODY_SELECTORS（与渲染门 waitForNoteBody 同一份，避免漂移）。注意：评论区也用
  // .note-text，故所有 .note-text 候选都下钻在 desc/note-scroller/note-content 容器作用域内，
  // 不用裸 .note-text 兜底（会抓到评论），也不回退裸 .note-content / [class*="content"]（会拼进标题+时间）。
  // 正文走保留换行的序列化（bodyTextOf）：段落结构是精选语料/创作素材的一部分，不得压平。
  // 【与发布时刻隔离】：正文只走 NOTE_BODY_SELECTORS 白名单（末级文本容器），发布时刻另走
  // NOTE_PUBLISHED_AT_SELECTORS（bottom-container 里的 .date 等日期叶子），两份选择器物理独立、
  // 日期节点是正文容器的【兄弟节点】不在其内，故正文抽取不会命中日期串（f8712f5 隔离约束）。
  const body = bodyTextOf(container, NOTE_BODY_SELECTORS);
  const author = textOf(container, [
    '.author-wrapper .name',
    '.author .name',
    '[class*="author"] [class*="name"]',
    '[class*="author"]',
  ]);

  // 点赞/收藏/评论数限定到互动栏（engage-bar）作用域统计——否则在整个 modal 内扫会落到评论区每条评论
  // 自带的 like-wrapper（真机实测「卡片👍311 vs 详情👍1」：详情点赞被错成某条评论的赞数）。collect-wrapper
  // 只在互动栏故收藏数本来就对。取不到 engage-bar 才退回整个 container（保底）。⚠️engage-bar 类名需真机校准。
  // 与 browse-session.executeLikeOrCollect 的 '.interactions.engage-bar' 锚点同口径。
  const engageBar = container.querySelector('.interactions.engage-bar, .engage-bar') ?? container;
  const likes = countNear(engageBar, ['like-wrapper', 'like']);
  const collects = countNear(engageBar, ['collect-wrapper', 'collect']);
  const comments = countNear(engageBar, ['comment-wrapper', 'chat-wrapper', 'comment']);

  const noteUrl = attrOf(container, ['a[href*="/explore/"]', 'a[href*="/discovery/"]'], 'href');

  const tags = extractTags(`${title} ${body}`);
  const isLiked = detectLiked(container);
  const images = extractNoteImages(container);
  // 发布相对时刻原始文本（窄选择器、与正文物理隔离）：抽不到则 undefined、诚实置空，云端负责解析算热度。
  const publishedAtText = extractPublishedAtText(container);

  const content: NoteContent = {
    title,
    body,
    author,
    likes,
    collects,
    comments,
    tags,
    images,
    isLiked,
  };
  if (noteUrl) content.noteUrl = noteUrl;
  if (publishedAtText) content.publishedAtText = publishedAtText;
  return content;
}
