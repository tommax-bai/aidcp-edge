/**
 * Feed 滚动与卡片识别（小红书 explore 瀑布流）。
 *
 * 职责：
 *  - getVisibleCards(): 在浏览器侧用一段 JS 遍历 DOM，识别"封面图 + 标题/作者"
 *    的重复笔记卡片结构，返回带几何中心坐标的卡片清单；
 *  - scrollNext(): 用惯性滚动序列（加速→峰值→衰减）逐帧 window.scrollBy（模拟触控板）；
 *  - openCard(): 用贝塞尔鼠标轨迹移动到卡片中心（带随机偏移）再点击打开 modal。
 *
 * 为什么不复用 DomProvider/jsdom：卡片识别需要真实布局（可见性、几何中心坐标），
 * jsdom 无布局；这里直接用 CDP Runtime.evaluate 在真实页面内计算 getBoundingClientRect。
 * 点击/滚动同样用拟人化输入（贝塞尔轨迹 + 惯性序列，见 docs/anti-detection.md §5）。
 */

import type { BrowseCdp } from './cdp-util.js';
import { evalJson, dispatchClick, type RandomFn, defaultRandom } from './cdp-util.js';
import { generateScrollSequence } from '../humanize/index.js';

/** 一张笔记卡片（feed 中的单元） */
export interface NoteCard {
  /** 在 feed 中的序号（仅当前快照内有效） */
  position: number;
  /** 卡片中心 x（CSS 像素，相对视口） */
  centerX: number;
  /** 卡片中心 y（CSS 像素，相对视口） */
  centerY: number;
  /** 卡片上的标题预览 */
  title?: string;
  /** 作者名 */
  author?: string;
  /** 点赞数文本（如 "1.2w"，未解析） */
  likes?: string;
  /** 封面图 URL */
  coverUrl?: string;
  /** 是否为视频笔记 */
  isVideo?: boolean;
}

export interface FeedScroller {
  /** 获取当前可见的笔记卡片列表 */
  getVisibleCards(): Promise<NoteCard[]>;
  /** 滚动到下一屏（惯性序列，模拟人类） */
  scrollNext(): Promise<void>;
  /** 点击指定卡片打开 modal */
  openCard(card: NoteCard): Promise<void>;
}

export interface FeedScrollerOptions {
  /** 随机源（测试可注入确定性序列） */
  random?: RandomFn;
  /** 一次 scrollNext 的目标总位移（CSS 像素，默认 800；实际帧由惯性序列切分） */
  scrollDistancePx?: number;
  /** 注入 sleep（测试用，默认 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
}

/** 浏览器侧识别卡片的 JS（返回 NoteCard[] 的 JSON 字符串）。 */
const CARD_SCAN_JS = `(function(){
  function pickCover(el){
    var img = el.querySelector('img');
    if (img && img.src) return img.src;
    var bg = el.querySelector('[style*="background-image"]');
    if (bg) {
      var m = (bg.getAttribute('style')||'').match(/url\\(["']?([^"')]+)["']?\\)/);
      if (m) return m[1];
    }
    return undefined;
  }
  function txt(el, sels){
    for (var i=0;i<sels.length;i++){
      var n = el.querySelector(sels[i]);
      if (n && n.textContent && n.textContent.trim()) return n.textContent.trim();
    }
    return undefined;
  }
  // 小红书卡片容器常见为 .note-item / [class*=note]，兜底找含封面图的重复块。
  var nodes = Array.prototype.slice.call(
    document.querySelectorAll('.note-item, [class*="note-item"], section[class*="note"]')
  );
  if (nodes.length === 0) {
    // 兜底：找带 cover/封面图链接的卡片
    nodes = Array.prototype.slice.call(document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]'))
      .map(function(a){ return a.closest('section,div,li') || a; });
  }
  var out = [];
  var pos = 0;
  for (var i=0;i<nodes.length;i++){
    var el = nodes[i];
    var rect = el.getBoundingClientRect();
    // 仅保留在视口内、有面积的卡片
    if (rect.width < 40 || rect.height < 40) continue;
    if (rect.bottom <= 0 || rect.top >= (window.innerHeight||0)) continue;
    var cx = rect.left + rect.width/2;
    var cy = rect.top + rect.height/2;
    if (cy < 50 || cy > ((window.innerHeight||0) - 50) || cx < 0 || cx > (window.innerWidth||1920)) continue;
    var cover = pickCover(el);
    var title = txt(el, ['.title', '[class*="title"]', 'a[title]']);
    if (!title) {
      var a = el.querySelector('a[title]');
      if (a) title = a.getAttribute('title') || undefined;
    }
    var author = txt(el, ['.author', '[class*="author"]', '[class*="name"]']);
    var likes = txt(el, ['.like-wrapper', '[class*="like"] [class*="count"]', '[class*="count"]']);
    var isVideo = !!(el.querySelector('.play-icon') || el.querySelector('[class*="play-icon"]') || el.querySelector('video'));
    out.push({
      position: pos++,
      centerX: Math.round(cx),
      centerY: Math.round(cy),
      title: title,
      author: author,
      likes: likes,
      coverUrl: cover,
      isVideo: isVideo
    });
  }
  return JSON.stringify(out);
})()`;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 基于 CDP 的 FeedScroller 实现 */
export class CdpFeedScroller implements FeedScroller {
  private readonly random: RandomFn;
  private readonly scrollDistancePx: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** 记录上一次点击落点，作为下次鼠标轨迹起点（光标连续性） */
  private lastCursor: { x: number; y: number } | undefined;

  constructor(
    private readonly cdp: BrowseCdp,
    options: FeedScrollerOptions = {},
  ) {
    this.random = options.random ?? defaultRandom;
    this.scrollDistancePx = options.scrollDistancePx ?? 800;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async getVisibleCards(): Promise<NoteCard[]> {
    const raw = await evalJson<NoteCard[]>(this.cdp, CARD_SCAN_JS);
    return Array.isArray(raw) ? raw : [];
  }

  async scrollNext(): Promise<void> {
    // 目标总位移加 ±20% 随机（人手力度不均），再切成惯性帧序列。
    const jitter = 1 + (this.random() - 0.5) * 0.4;
    const total = Math.round(this.scrollDistancePx * jitter);
    const seq = generateScrollSequence(total, { random: this.random });
    for (const frame of seq) {
      await evalJson<unknown>(
        this.cdp,
        `(function(){ window.scrollBy(0, ${frame.deltaY}); return true; })()`,
      );
      if (frame.delay > 0) await this.sleep(frame.delay);
    }
  }

  async openCard(card: NoteCard): Promise<void> {
    // 沿贝塞尔轨迹移动到卡片中心（落点抖动由 mouse-path 处理），起点为上次光标位置。
    const x = card.centerX;
    const y = card.centerY;
    const opts: Parameters<typeof dispatchClick>[3] = { random: this.random, sleep: this.sleep };
    if (this.lastCursor) opts.from = this.lastCursor;
    await dispatchClick(this.cdp, x, y, opts);
    this.lastCursor = { x, y };
  }
}
