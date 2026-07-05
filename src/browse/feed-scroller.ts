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
import { evalJson, evalRaw, dispatchClick, type RandomFn, defaultRandom } from './cdp-util.js';
import { generateScrollSequence } from '../humanize/index.js';

/** 一张笔记卡片（feed 中的单元） */
export interface NoteCard {
  /** 在 feed 中的序号（仅当前快照内有效） */
  position: number;
  /** 卡片中心 x（CSS 像素，相对视口） */
  centerX: number;
  /** 卡片中心 y（CSS 像素，相对视口） */
  centerY: number;
  /** 笔记唯一标识（云端命令模式下用于定位） */
  noteId?: string;
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
    // 跳过非笔记插页（搜索推荐行「猜你想搜」等）：它们会占 position 槽污染 index↔noteId 配对、并被误当卡片打开。
    // 跳过即不 pos++,使真笔记的 index 无空洞、与 noteId 一一对应。⚠️denylist 串需真机核对是否覆盖现行插页。
    if (title === '猜你想搜' || title === '猜你想看' || title === '大家都在搜') continue;
    var author = txt(el, ['.author', '[class*="author"]', '[class*="name"]']);
    // 点赞数仅取 like 作用域内的计数：去掉贪婪的裸 [class*="count"] 末位兜底（它会抓到
    // 收藏/评论/分享的 count，造成 feed 卡与详情页点赞数口径不一）。宁可取空也不取错。
    var likes = txt(el, ['.like-wrapper', '[class*="like-wrapper"]', '[class*="like"] [class*="count"]']);
    var isVideo = !!(el.querySelector('.play-icon') || el.querySelector('[class*="play-icon"]') || el.querySelector('video'));
    // 提取真实 noteId（从卡片的 /explore/<id> 链接），供云端 visited 去重；缺失则由 modal 兜底解析。
    var lk = (el.matches && el.matches('a[href*="/explore/"], a[href*="/discovery/item/"]'))
      ? el
      : (el.querySelector('a[href*="/explore/"], a[href*="/discovery/item/"]') ||
        (el.closest && el.closest('a[href*="/explore/"], a[href*="/discovery/item/"]')));
    var noteId;
    if (lk) {
      var hm = (lk.getAttribute('href')||'').match(/\\/(?:explore|discovery\\/item)\\/([A-Za-z0-9]+)/);
      if (hm) noteId = hm[1];
    }
    out.push({
      position: pos++,
      centerX: Math.round(cx),
      centerY: Math.round(cy),
      noteId: noteId,
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
    // 默认 ~500（约半屏）：相邻两次扫描的可见卡片保留重叠，降低 AI 卡在两次扫描之间被整屏跳过的概率。
    // （原 800 ≈ 一整屏，相邻快照几乎不重叠 → borderline 卡只有一次被评估机会就划走。）
    this.scrollDistancePx = options.scrollDistancePx ?? 500;
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
    // 滚动机制：CDP 真实 mouseWheel 在 feed 区中心派发，浏览器原生滚动当前命中的可滚容器——
    // 小红书宽/窄两布局可滚元素不同（window/document 或内层 .feeds-page，见 docs/xhs-layout-states.md），
    // 旧的 window.scrollBy 在 document 不可滚的布局上是 no-op（feed 永不推进）。真实滚轮两布局通吃，
    // 且补回硬件 wheel 事件（消除"无 wheel 事件"指纹），并触发 XHS 懒加载。
    const vp = await evalRaw<{ w: number; h: number }>(
      this.cdp,
      '(function(){ return { w: window.innerWidth || 1280, h: window.innerHeight || 800 }; })()',
    ).catch(() => ({ w: 1280, h: 800 }));
    const cx = Math.round(vp.w / 2);
    const cy = Math.round(vp.h / 2);
    // 先把光标移到 feed 中心（hover 真实化），再逐帧派发滚轮，保留惯性节奏。
    // best-effort：单次派发失败（如通知巡视后回 feed 的页面导航瞬间，CDP 对 Input.dispatchMouseEvent 短暂超时）
    // 只中止本轮滚动、【绝不抛出】——否则一次瞬时超时就会让整个 browse loop 结束（真机实测踩过的坑）。
    // 下一轮 feed 稳定后再滚；mouseWheel 在稳定页正常生效并触发懒加载。
    try {
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
      for (const frame of seq) {
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: cx,
          y: cy,
          deltaX: 0,
          deltaY: frame.deltaY,
        });
        if (frame.delay > 0) await this.sleep(frame.delay);
      }
    } catch (err) {
      console.warn(
        `[feed-scroller] 滚动派发中止（本轮跳过，不中断浏览）：${err instanceof Error ? err.message : String(err)}`,
      );
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
