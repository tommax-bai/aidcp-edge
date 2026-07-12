/**
 * Facebook 浏览会话（change facebook-browse-and-like-loop）。
 *
 * 装配闸（main.ts）在 Facebook driver 声明 'browse' 后，据平台解析到本会话（而非小红书 BrowseSession）——
 * design 的「browse 能力翻转与 FB BrowseSession 原子同落」不变量。它独占 edge-client 的单槽 browseHandler，
 * 因此**必须同时承载评论/加群**（FB 声明 browse 后，旧 comment-only 注册闸 `(comment||join)&&!browse` 不再触发）：
 * 评论/搜索/加群/按 url 开帖【委托】给现成 {@link FacebookCommentHandler}（原样、已测），浏览/点赞/翻页/返回/
 * 按 permalink 深读由本会话新增。
 *
 * 平台无关的编排在云端 role-dispatcher（feed.entered→pick→open→deep-read→interact→back），本会话只是
 * 平台执行器：把云端命令翻成 FB DOM 操作、把结构化结果按【既有平台中立消息】上报（page.cards / note.detail /
 * action.completed），零改 protocol.ts。
 *
 * 红线：
 *  - 每条命令恰好一个诚实回执（page.cards / note.detail / action.completed）；有界超时兜底 timeout 回执，
 *    绝不静默丢弃 / 假成功（否则云端 sendAndAwait + idle 看门狗挂死）。
 *  - kill switch `AIDCP_FB_BROWSE_AUTO`（三态 off/shadow/on）：off=不自动浏览/点赞（评论/加群仍服务）；
 *    shadow=浏览+上报但点赞只记不执行；on=真点赞。默认 off。
 *  - FB 无收藏/关注/看图（v1）：这些命令诚实回 capability_unsupported，绝不臆造。
 */

import { evalJson, type BrowseCdp } from '../browse/cdp-util.js';
import type { OverlayMonitor } from '../browse/overlay-monitor.js';
import { jitterAround } from '../humanize/index.js';
import type { EdgeBrowseSession } from '../browse/edge-browse-session.js';
import type {
  Envelope,
  ActionCompletedPayload,
  NoteDetailPayload,
  NoteOpenPayload,
  InteractionLikePayload,
  PageCardsPayload,
  ProfileDetailPayload,
  ProfileOpenPayload,
  PacingOp,
  PacingFloorPayload,
} from '../comm/protocol.js';
import type { PlatformDriver } from '../platform/driver.js';
import { FACEBOOK_DEFAULT_START_URL } from './driver.js';
import { FacebookFeedReader, type FacebookFeedCard } from './feed-reader.js';
import { FacebookPostReader } from './post-reader.js';
import { FacebookLikeExecutor } from './like-executor.js';
import { FacebookCommentHandler } from './comment-handler.js';
import { defaultFacebookConsentAccepter, type FacebookConsentAccepter } from './consent.js';

export type FacebookBrowseMode = 'off' | 'shadow' | 'on';

/** 解析 kill switch：默认 off。'shadow' → 浏览但点赞只记不执行；'on'/'true'/'1' → 真点赞。 */
export function parseFacebookBrowseMode(env: Record<string, string | undefined> = process.env): FacebookBrowseMode {
  const v = String(env.AIDCP_FB_BROWSE_AUTO ?? '').trim().toLowerCase();
  if (v === 'shadow') return 'shadow';
  if (v === 'on' || v === 'true' || v === '1' || v === 'yes') return 'on';
  return 'off';
}

/**
 * 协变落地判定（co-landing）：声明 'browse' 的 Facebook edge 解析到 FacebookBrowseSession（绝不小红书）。
 * main.ts 用它选会话；测试用它锁死不变量。
 */
export function usesFacebookBrowseSession(driver: PlatformDriver): boolean {
  return driver.platform === 'facebook' && driver.capabilities.includes('browse');
}

/** 本会话上报所需的最小客户端能力（EdgeClient 已实现）。 */
export interface FacebookSessionClient {
  reportPageCards(payload: PageCardsPayload): void;
  reportNoteDetail(payload: NoteDetailPayload): void;
  reportProfileDetail(payload: ProfileDetailPayload): void;
  reportActionCompleted(payload: ActionCompletedPayload): void;
}

export interface FacebookBrowseSessionDeps {
  cdp: BrowseCdp;
  client: FacebookSessionClient;
  /** 评论/搜索/加群/按 url 开帖的委托处理器（原样复用，已测）。 */
  commentHandler: FacebookCommentHandler;
  overlayMonitor?: OverlayMonitor;
  acceptConsent?: FacebookConsentAccepter;
  /** 子执行器（缺省内部按 cdp 构造；测试可注入桩）。 */
  feedReader?: FacebookFeedReader;
  postReader?: FacebookPostReader;
  likeExecutor?: FacebookLikeExecutor;
  sleep?: (ms: number) => Promise<void>;
  logger?: (msg: string) => void;
}

export interface FacebookBrowseSessionOptions {
  feedUrl?: string;
  mode?: FacebookBrowseMode;
  /** 单条浏览命令的兜底超时（毫秒）；超时回诚实 timeout 回执，绝不挂死。 */
  commandTimeoutMs?: number;
  tempo?: number;
}

type TerminalReport =
  | { type: 'cards'; payload: PageCardsPayload }
  | { type: 'detail'; payload: NoteDetailPayload }
  | { type: 'profile'; payload: ProfileDetailPayload }
  | { type: 'action'; payload: ActionCompletedPayload };

interface FacebookProfileSnapshot {
  url?: string;
  title?: string;
  nickname?: string;
  bodyTextLen?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const FEED_CARD_HYDRATION_RETRY_ROUNDS = 6;
const FEED_CARD_HYDRATION_RETRY_MS = 700;

export class FacebookBrowseSession implements EdgeBrowseSession {
  private readonly cdp: BrowseCdp;
  private readonly client: FacebookSessionClient;
  private readonly commentHandler: FacebookCommentHandler;
  private readonly feedReader: FacebookFeedReader;
  private readonly postReader: FacebookPostReader;
  private readonly likeExecutor: FacebookLikeExecutor;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly feedUrl: string;
  private readonly mode: FacebookBrowseMode;
  private readonly commandTimeoutMs: number;

  private running = false;
  private closing = false;
  private tempo: number;
  /** 命令串行链：一次只处理一条，避免并发争抢同一浏览器会话。 */
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: FacebookBrowseSessionDeps, options: FacebookBrowseSessionOptions = {}) {
    this.cdp = deps.cdp;
    this.client = deps.client;
    this.commentHandler = deps.commentHandler;
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.logger ?? ((m) => console.log(m));
    this.feedUrl = options.feedUrl ?? FACEBOOK_DEFAULT_START_URL;
    this.mode = options.mode ?? parseFacebookBrowseMode();
    this.commandTimeoutMs = options.commandTimeoutMs ?? 90_000;
    this.tempo = options.tempo && options.tempo > 0 ? options.tempo : 1.0;
    const accept = deps.acceptConsent ?? defaultFacebookConsentAccepter();
    this.feedReader =
      deps.feedReader ??
      new FacebookFeedReader({ cdp: this.cdp, overlayMonitor: deps.overlayMonitor, acceptConsent: accept, sleep: this.sleep, logger: this.log });
    this.postReader =
      deps.postReader ??
      new FacebookPostReader({ cdp: this.cdp, overlayMonitor: deps.overlayMonitor, acceptConsent: accept, sleep: this.sleep, logger: this.log });
    this.likeExecutor =
      deps.likeExecutor ?? new FacebookLikeExecutor({ cdp: this.cdp, overlayMonitor: deps.overlayMonitor, sleep: this.sleep, logger: this.log });
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * 启动会话。mode==='off' → 不自动浏览（评论/加群仍按命令服务）；否则导航 feed → 上报首屏 page.cards
   * 以驱动云端浏览闭环。仅在 kill switch 开启时才有自动浏览行为。
   */
  async start(): Promise<void> {
    this.running = true;
    if (this.closing) return;
    if (this.mode === 'off') {
      this.log('[fb-session] AIDCP_FB_BROWSE_AUTO=off：不自动浏览/点赞（评论/加群仍按命令服务）');
      return;
    }
    this.log(`[fb-session] 启动自动浏览（mode=${this.mode}）→ 导航 feed ${this.feedUrl}`);
    await this.reportInitialFeed();
  }

  stop(): void {
    this.running = false;
  }

  close(): void {
    this.closing = true;
    this.running = false;
  }

  async quiesceForTask(): Promise<number> {
    await this.chain.catch(() => {});
    return 0;
  }

  async resumeAfterTask(): Promise<void> {
    /* FB 会话无独立恢复态：命令到达即处理。 */
  }

  discardQueuedCloudCommands(_reason?: string): void {
    /* FB 会话不缓冲命令（串行即时处理），无队列可丢弃。 */
  }

  applyPacingSnapshot(_opFloorsMs?: Partial<Record<PacingOp, PacingFloorPayload>>, tempo?: number): void {
    if (typeof tempo === 'number' && Number.isFinite(tempo) && tempo > 0) this.tempo = tempo;
  }

  async recoverAfterCloudReconnect(): Promise<void> {
    if (this.closing || this.mode === 'off') return;
    this.log('[fb-session] 云端重连后重报 feed 首屏，恢复浏览闭环');
    await this.reportInitialFeed().catch((err) => this.log(`[fb-session] 重连重报失败：${(err as Error).message}`));
  }

  /** 云端主动命令入口：串行化处理，保证每条恰好一个诚实回执。 */
  onCloudCommand(env: Envelope): Promise<void> {
    this.chain = this.chain.then(() => this.dispatch(env)).catch((err) => {
      this.log(`[fb-session] 命令处理未捕获异常 type=${env.type}：${(err as Error).message}`);
    });
    return this.chain;
  }

  private async dispatch(env: Envelope): Promise<void> {
    if (this.closing) {
      // 终态：诚实回执，绝不静默丢弃。
      this.client.reportActionCompleted({ action: this.actionName(env.type), ok: false, reason: 'session_closing' });
      return;
    }
    switch (env.type) {
      // —— 委托给评论处理器（评论/搜索/加群；已测、自带诚实回执与单飞）——
      case 'search.execute':
      case 'interaction.comment':
      case 'group.join':
        await this.commentHandler.handle(env);
        return;
      case 'note.open': {
        const payload = (env.payload ?? {}) as NoteOpenPayload;
        // url 存在 = 评论支线按 permalink 开帖（读评论供撰写）；否则 = 浏览闭环按卡片 noteId 深读。
        if (payload.url) {
          await this.commentHandler.handle(env);
          return;
        }
        await this.runBrowseCommand('open_note', async () => {
          await this.thinkBefore(payload.thinkMs); // 开帖前犹豫（云端中心值 × tempo + 抖动）
          return this.openBrowseNote(payload.noteId);
        });
        return;
      }
      // —— 浏览/点赞类（受 kill switch 门控）——
      case 'page.scroll':
        await this.runBrowseCommand('scroll', () => this.scrollFeed());
        return;
      case 'interaction.like': {
        const payload = env.payload as InteractionLikePayload;
        await this.runBrowseCommand('like', async () => {
          await this.thinkBefore(payload?.thinkMs); // 点赞前犹豫（云端中心值 × tempo + 抖动）
          return this.likeCurrent(payload);
        });
        return;
      }
      case 'navigation.back':
        await this.runBrowseCommand('back', () => this.backToFeed());
        return;
      case 'note.close':
        await this.runBrowseCommand('close', () => this.closeNote());
        return;
      case 'profile.open': {
        const payload = (env.payload ?? {}) as ProfileOpenPayload;
        if (payload.direct) {
          await this.runProfileCommand(payload);
          return;
        }
        this.log('[fb-session] profile.open 非 direct 路径 FB v1 不支持，回 capability_unsupported');
        this.client.reportActionCompleted({ action: 'profile_open', ok: false, reason: 'capability_unsupported' });
        return;
      }
      case 'session.end':
        this.log('[fb-session] 命令: session.end');
        this.running = false;
        await this.navigateFeedBestEffort();
        return;
      // —— FB v1 浏览不支持：诚实 capability_unsupported，绝不臆造 ——
      default:
        this.log(`[fb-session] 命令 ${env.type} FB v1 浏览不支持，回 capability_unsupported`);
        this.client.reportActionCompleted({ action: this.actionName(env.type), ok: false, reason: 'capability_unsupported' });
        return;
    }
  }

  /**
   * 执行一条浏览命令：kill switch off → 诚实 browse_disabled；否则跑 fn（返回终态报文），
   * 有界超时兜底 timeout。保证恰好一个终态上报。
   */
  private async runBrowseCommand(action: string, fn: () => Promise<TerminalReport>): Promise<void> {
    if (this.mode === 'off') {
      this.client.reportActionCompleted({ action, ok: false, reason: 'browse_disabled' });
      return;
    }
    let settled = false;
    const emitOnce = (r: TerminalReport): void => {
      if (settled) return;
      settled = true;
      this.emit(r);
    };
    // 有界超时【race】fn：超时即回诚实 timeout 并**放行串行链**（哪怕 fn 卡死 CDP 仍挂着）——
    // 否则一个卡死命令会永久阻塞后续命令与云端 nudge，整会话活锁（task 4.3 红线）。
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.log(`[fb-session] 命令 ${action} 超时（${this.commandTimeoutMs}ms），回诚实 timeout 并放行链`);
        emitOnce({ type: 'action', payload: { action, ok: false, reason: 'timeout' } });
        resolve();
      }, this.commandTimeoutMs);
      fn()
        .then((report) => {
          clearTimeout(timer);
          emitOnce(report);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timer);
          emitOnce({ type: 'action', payload: { action, ok: false, reason: `handler_error:${(err as Error).message}` } });
          resolve();
        });
    });
  }

  /** 动作前犹豫：云端下发的中心值 thinkMs × 风控 tempo，叠 lognormal 抖动（边缘只叠抖动，不自造系数）。 */
  private async thinkBefore(thinkMs?: number): Promise<void> {
    if (!thinkMs || thinkMs <= 0) return;
    const ms = jitterAround(thinkMs * this.tempo, 0.25);
    if (ms > 0) await this.sleep(ms);
  }

  private emit(r: TerminalReport): void {
    if (r.type === 'cards') this.client.reportPageCards(r.payload);
    else if (r.type === 'detail') this.client.reportNoteDetail(r.payload);
    else if (r.type === 'profile') this.client.reportProfileDetail(r.payload);
    else this.client.reportActionCompleted(r.payload);
  }

  /** 导航 feed → 扫卡 → 上报 page.cards（首屏 / 重连恢复）。无命令可回，best-effort 直发。 */
  private async reportInitialFeed(): Promise<void> {
    const ensure = await this.feedReader.ensureFeed(this.feedUrl);
    if (!ensure.ok) {
      this.log(`[fb-session] feed 未就绪（${ensure.reason}）：不上报首屏（云端看门狗后续可 nudge）`);
      return;
    }
    const cards = await this.scanFeedCardsWithHydrationRetry('initial');
    if (cards.length === 0) {
      this.log('[fb-session] feed 就绪但无可上报卡片');
      return;
    }
    this.client.reportPageCards(this.toPageCards(cards));
    this.log(`[fb-session] 已上报首屏 ${cards.length} 张 feed 卡片`);
  }

  /** 浏览闭环：按 permalink（noteId）深读 → note.detail。 */
  private async openBrowseNote(noteId?: string): Promise<TerminalReport> {
    if (!noteId) return { type: 'action', payload: { action: 'open_note', ok: false, reason: 'no_target' } };
    const detail = await this.postReader.openAndRead(noteId);
    if (!detail.ok) {
      return { type: 'action', payload: { action: 'open_note', ok: false, reason: detail.reason ?? 'open_failed' } };
    }
    const payload: NoteDetailPayload = {
      noteId: detail.permalink,
      title: detail.body ? detail.body.slice(0, 60) : '',
      content: detail.body,
      mediaType: detail.isVideo ? 'video' : 'image_text',
      likeCount: detail.reactionCount,
      collectCount: 0, // FB 无收藏：诚实缺省，绝不臆造
      url: detail.permalink,
      ...(detail.author ? { author: detail.author } : {}),
      ...(detail.comments.length > 0 ? { comments: detail.comments } : {}),
    };
    this.log(
      `[fb-session] note.detail noteId=${detail.permalink} 👍${detail.reactionCount} 💬${detail.commentCount} ` +
        `正文:${detail.body.slice(0, 40).replace(/\s+/g, ' ')}…`,
    );
    return { type: 'detail', payload };
  }

  /** 点赞当前帖：mode=shadow → 只记不执行（诚实 shadow）；on → 真点赞 + 后置校验。 */
  private async likeCurrent(_payload: InteractionLikePayload): Promise<TerminalReport> {
    const shadow = this.mode === 'shadow';
    const r = await this.likeExecutor.like({ shadow });
    // ok:true 才让云端经 RiskController.record 记账；shadow/失败一律 ok:false（云端不记、不扣风控）。
    return { type: 'action', payload: { action: 'like', ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) } };
  }

  /** feed 翻页 → 扫卡 → page.cards。 */
  private async scrollFeed(): Promise<TerminalReport> {
    await this.feedReader.scrollNext();
    const cards = await this.scanFeedCardsWithHydrationRetry('scroll');
    if (cards.length === 0) {
      return { type: 'action', payload: { action: 'scroll', ok: false, reason: 'no_target' } };
    }
    return { type: 'cards', payload: this.toPageCards(cards) };
  }

  /** 返回 feed：导航回 feed → 重扫 → page.cards（驱动云端下一轮 feed.entered）。 */
  private async backToFeed(): Promise<TerminalReport> {
    const ensure = await this.feedReader.ensureFeed(this.feedUrl);
    if (!ensure.ok) {
      return { type: 'action', payload: { action: 'back', ok: false, reason: ensure.reason ?? 'no_feed' } };
    }
    const cards = await this.scanFeedCardsWithHydrationRetry('back');
    if (cards.length === 0) {
      return { type: 'action', payload: { action: 'back', ok: false, reason: 'no_feed' } };
    }
    return { type: 'cards', payload: this.toPageCards(cards) };
  }

  /** 关闭当前帖（详情态 dialog）：导航回 feed 关闭 dialog，诚实回 close ok。 */
  private async closeNote(): Promise<TerminalReport> {
    await this.navigateFeedBestEffort();
    return { type: 'action', payload: { action: 'close', ok: true } };
  }

  /**
   * FB feed 常先水合作者/正文，permalink 链接晚一拍出现。page.cards 必须有可开 permalink，
   * 所以这里只做短有界重试，不造卡、不放宽候选规则。
   */
  private async scanFeedCardsWithHydrationRetry(context: 'initial' | 'scroll' | 'back'): Promise<FacebookFeedCard[]> {
    for (let i = 0; i < FEED_CARD_HYDRATION_RETRY_ROUNDS; i++) {
      const cards = await this.feedReader.scanCards();
      if (cards.length > 0) {
        if (i > 0) this.log(`[fb-session] feed permalink 延迟水合，${context} 第 ${i + 1} 次扫描拿到 ${cards.length} 张卡片`);
        return cards;
      }
      if (i < FEED_CARD_HYDRATION_RETRY_ROUNDS - 1) await this.sleep(FEED_CARD_HYDRATION_RETRY_MS);
    }
    return [];
  }

  /**
   * Facebook 本人昵称采集：云端会在首个 page.cards 后下发 profile.open{direct:true}。
   * v1 只支持 direct 自己主页采集，回 profile.detail 解除云端 nickname-enricher 等待；
   * 不支持普通作者主页/关注链路，避免扩大自动行为面。
   */
  private async runProfileCommand(payload: ProfileOpenPayload): Promise<void> {
    let settled = false;
    const emitOnce = (report: TerminalReport): void => {
      if (settled) return;
      settled = true;
      this.emit(report);
    };
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.log(`[fb-session] profile.open direct 超时（${this.commandTimeoutMs}ms），回 extracted:false`);
        emitOnce({ type: 'profile', payload: this.profileFallback(payload.authorId) });
        resolve();
      }, this.commandTimeoutMs);
      this.openDirectProfile(payload)
        .then((report) => {
          clearTimeout(timer);
          emitOnce(report);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timer);
          this.log(`[fb-session] profile.open direct 失败：${(err as Error).message}`);
          emitOnce({ type: 'profile', payload: this.profileFallback(payload.authorId) });
          resolve();
        });
    });
  }

  private async openDirectProfile(payload: ProfileOpenPayload): Promise<TerminalReport> {
    const authorId = String(payload.authorId ?? '').trim();
    if (!authorId) return { type: 'profile', payload: this.profileFallback(authorId) };
    await this.thinkBefore(payload.thinkMs);
    const url = /^\d+$/.test(authorId)
      ? `https://www.facebook.com/profile.php?id=${encodeURIComponent(authorId)}`
      : `https://www.facebook.com/${encodeURIComponent(authorId)}`;
    this.log(`[fb-session] 命令: profile.open direct（authorId=${authorId}）`);
    await this.cdp.send('Page.navigate', { url });
    const snapshot = await this.waitAndReadProfile();
    const nickname = (snapshot.nickname ?? '').trim();
    const landedUrl = snapshot.url?.startsWith('https://www.facebook.com/') ? snapshot.url : url;
    this.log(
      `[fb-session] profile.detail direct authorId=${authorId}` +
        `${nickname ? ` nickname="${nickname}"` : ' nickname=<empty>'} extracted=false`,
    );
    return {
      type: 'profile',
      payload: {
        authorId,
        postsCount: 0,
        followersCount: 0,
        likesCollects: 0,
        extracted: false,
        ...(nickname ? { nickname } : {}),
        ...(landedUrl ? { url: landedUrl } : {}),
      },
    };
  }

  private async waitAndReadProfile(timeoutMs = 8000): Promise<FacebookProfileSnapshot> {
    const deadline = Date.now() + timeoutMs;
    let last: FacebookProfileSnapshot = {};
    while (Date.now() < deadline) {
      last = await this.readProfileSnapshot();
      if (last.nickname || (last.bodyTextLen ?? 0) > 0) return last;
      await this.sleep(300);
    }
    return last;
  }

  private async readProfileSnapshot(): Promise<FacebookProfileSnapshot> {
    return evalJson<FacebookProfileSnapshot>(
      this.cdp,
      `(() => {
        const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
        const title = clean(document.title).replace(/\\s*\\|\\s*Facebook\\s*$/i, '');
        const h1 = clean(document.querySelector('h1')?.textContent || '');
        const mainH1 = clean(document.querySelector('[role="main"] h1')?.textContent || '');
        const bodyText = clean(document.body?.innerText || '');
        const nickname = [mainH1, h1, title].find((v) =>
          v && !/^(Facebook|首页|Home|通知|Notifications)$/i.test(v)
        ) || '';
        return JSON.stringify({
          url: location.href,
          title: document.title,
          nickname,
          bodyTextLen: bodyText.length
        });
      })()`,
    );
  }

  private profileFallback(authorId?: string): ProfileDetailPayload {
    return {
      authorId: authorId ?? '',
      postsCount: 0,
      followersCount: 0,
      likesCollects: 0,
      extracted: false,
    };
  }

  private async navigateFeedBestEffort(): Promise<void> {
    try {
      await this.cdp.send('Page.navigate', { url: this.feedUrl });
    } catch {
      /* best-effort：关 dialog 失败不影响回执 */
    }
  }

  private toPageCards(cards: FacebookFeedCard[]): PageCardsPayload {
    return {
      cards: cards.map((c, i) => ({
        index: c.index ?? i,
        title: c.textPreview ?? '',
        likeCount: c.reactionCount,
        collectCount: 0, // FB 无收藏：诚实缺省
        noteId: c.noteId,
        isVideo: c.isVideo,
        ...(c.author ? { author: c.author } : {}),
      })),
    };
  }

  private actionName(type: string): string {
    switch (type) {
      case 'note.open':
        return 'open_note';
      case 'page.scroll':
        return 'scroll';
      case 'interaction.like':
        return 'like';
      case 'navigation.back':
        return 'back';
      case 'note.close':
        return 'close';
      case 'interaction.comment':
        return 'comment';
      case 'search.execute':
        return 'search';
      case 'group.join':
        return 'join_group';
      default:
        return type;
    }
  }
}
