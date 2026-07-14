/**
 * Facebook 视口的拟人化滚动手势。
 *
 * FB feed 与评论编辑器都走 document 视口；这里统一派发惯性 wheel，并且只有在
 * 观测到 wheel 没有推动页面时才做一次 JS 兜底，避免旧实现的无条件双滚。
 */

import { evalJson, evalRaw, type BrowseCdp } from '../browse/cdp-util.js';
import { generateScrollSequence, defaultRandom, type RandomFn } from '../humanize/index.js';

export interface FacebookViewportScrollOptions {
  /**
   * 本次手势的基准总位移（CSS 像素）。实际目标在 +/-20% 内抖动。
   * **带符号**：正=向下、负=向上（点赞前把视口外的目标卡拟人地滚进视野需要能向上滚）。
   */
  distancePx: number;
  random?: RandomFn;
  sleep?: (ms: number) => Promise<void>;
  logger?: (message: string) => void;
}

export interface FacebookViewportScrollResult {
  targetDistancePx: number;
  wheelFrames: number;
  wheelMovedDocument: boolean;
  fallbackUsed: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function readViewport(cdp: BrowseCdp): Promise<{ w: number; h: number }> {
  return await evalJson<{ w: number; h: number }>(
    cdp,
    '(function(){ return JSON.stringify({ w: window.innerWidth || 1280, h: window.innerHeight || 800 }); })()',
  );
}

async function readDocumentScrollY(cdp: BrowseCdp): Promise<number | undefined> {
  try {
    const value = await evalJson<{ y?: unknown }>(
      cdp,
      '(function(){ var root=document.scrollingElement||document.documentElement; return JSON.stringify({ y: Number(window.scrollY || (root&&root.scrollTop) || 0) }); })()',
    );
    return typeof value?.y === 'number' && Number.isFinite(value.y) ? value.y : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 用一段惯性 wheel 手势滚动 Facebook document。
 *
 * 输入异常不会中断 browse loop。只有前后都成功量到位置且完全没动时才允许 JS 兜底；
 * 量不到位置宁可不猜测补滚，避免在部分 wheel 已生效时制造第二段位移。
 */
export async function scrollFacebookViewport(
  cdp: BrowseCdp,
  options: FacebookViewportScrollOptions,
): Promise<FacebookViewportScrollResult> {
  const random = options.random ?? defaultRandom;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.logger ?? (() => {});
  const signed = Math.round(options.distancePx);
  const direction = signed < 0 ? -1 : 1;
  const baseline = Math.max(1, Math.abs(signed));
  const magnitudePx = Math.max(1, Math.round(baseline * (1 + (random() - 0.5) * 0.4)));
  const targetDistancePx = direction * magnitudePx;
  const sequence = generateScrollSequence(magnitudePx, { random });
  const beforeY = await readDocumentScrollY(cdp);
  let wheelFrames = 0;

  try {
    const viewport = await readViewport(cdp).catch(() => ({ w: 1280, h: 800 }));
    const x = Math.round(viewport.w / 2);
    const y = Math.round(viewport.h / 2);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (const frame of sequence) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: 0,
        deltaY: direction * frame.deltaY,
      });
      wheelFrames += 1;
      if (frame.delay > 0) await sleep(frame.delay);
    }
  } catch (err) {
    log(`[fb-scroll] wheel gesture interrupted (continuing safely): ${(err as Error).message}`);
  }

  const afterY = await readDocumentScrollY(cdp);
  const wheelMovedDocument = beforeY !== undefined && afterY !== undefined && afterY !== beforeY;
  let fallbackUsed = false;
  if (beforeY !== undefined && afterY !== undefined && !wheelMovedDocument) {
    try {
      await evalRaw<unknown>(
        cdp,
        `(function(){ window.scrollBy(0, ${targetDistancePx}); return true; })()`,
      );
      fallbackUsed = true;
    } catch (err) {
      log(`[fb-scroll] fallback scroll failed (continuing safely): ${(err as Error).message}`);
    }
  }

  return { targetDistancePx, wheelFrames, wheelMovedDocument, fallbackUsed };
}
