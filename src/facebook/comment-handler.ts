// Facebook 定向评论命令处理器（change facebook-scheduled-comment，task 4.x + 静默丢弃坑修复）。
//
// Facebook 边端无 BrowseSession（driver 不声明 'browse'）。云端下发的 search.execute / note.open /
// interaction.comment 三条命令（均已在 edge-client 主动命令白名单）此前无处理器 → `browseHandler?.()`
// 可选链静默吞、零回执 → 云端 sendAndAwait 干等超时（此路径无巡视看门狗，会挂死云端）。
//
// 本处理器由 main.ts 按 driver 的 'comment' 能力注册（comment-only 平台，独立于 autoBrowse 的
// BrowseSession 单槽 browseHandler，杜绝与小红书争抢）。三条命令翻成执行器调用 + 镜像小红书回执契约：
//   - search.execute → 命中候选回 page.cards（permalink 放 noteId）；阻断/权限/导航失败回 action.completed{action:'search'}
//   - note.open{url} → 开帖+评论框就绪回 note.detail；失败回 action.completed{action:'open_note'}
//   - interaction.comment → 一律回 action.completed{action:'comment', ok}
// 白名单命中但本平台不支持的其他命令 → 显式回 action.completed{ok:false, reason:'capability_unsupported'}，
// 绝不再落回静默丢弃（红线：MUST NOT 静默假成功/静默丢弃）。

import type { Envelope, GroupJoinPayload, InteractionCommentPayload, NoteOpenPayload, SearchExecutePayload } from '../comm/protocol.js';
import type { ActionCompletedPayload, NoteDetailPayload, PageCardsPayload } from '../comm/protocol.js';
import type { FacebookCommentExecutor } from './comment-executor.js';
import type { FacebookJoinExecutor } from './join-executor.js';
import { TaskTakeoverError } from '../execution/takeover.js';

/** 处理器回执所需的最小客户端能力（EdgeClient 已实现这三个方法）。 */
export interface FacebookCommentReplyClient {
  reportPageCards(payload: PageCardsPayload): void;
  reportNoteDetail(payload: NoteDetailPayload): void;
  reportActionCompleted(payload: ActionCompletedPayload): void;
}

export interface FacebookCommentHandlerDeps {
  executor: FacebookCommentExecutor;
  joinExecutor?: FacebookJoinExecutor;
  client: FacebookCommentReplyClient;
  logger?: (msg: string) => void;
}

export class FacebookCommentHandler {
  private readonly executor: FacebookCommentExecutor;
  private readonly joinExecutor?: FacebookJoinExecutor;
  private readonly client: FacebookCommentReplyClient;
  private readonly log: (msg: string) => void;
  /** 单飞：同一时刻只处理一条评论命令，防并发争抢同一浏览器会话。 */
  private busy = false;

  constructor(deps: FacebookCommentHandlerDeps) {
    this.executor = deps.executor;
    this.joinExecutor = deps.joinExecutor;
    this.client = deps.client;
    this.log = deps.logger ?? (() => {});
  }

  /**
   * 云端主动命令入口（由 client.onBrowseCommand 转发）。绝不抛：任何异常都翻成诚实非成功回执。
   *
   * `checkpoint`（change lease-strict-preemption 4.1）：安全取消点。**这条链的终点在本函数**——
   * FB 评论 / 加群由会话直接委托执行，不经浏览命令主循环，所以接管**必须在这里就地转成回执并 return，
   * MUST NOT 重抛**：抛出去只会落到会话的链级 catch（只打日志、不发回执）⇒ 云端干等到超时、
   * 空闲看门狗把整会话杀掉。
   */
  async handle(env: Envelope, checkpoint?: () => void): Promise<void> {
    try {
      switch (env.type) {
        case 'search.execute':
          await this.onSearch(env.payload as SearchExecutePayload);
          return;
        case 'note.open':
          await this.onOpen(env.payload as NoteOpenPayload);
          return;
        case 'interaction.comment':
          await this.onComment(env.payload as InteractionCommentPayload, checkpoint);
          return;
        case 'group.join':
          await this.onJoin(env.payload as GroupJoinPayload);
          return;
        default:
          // 白名单命中但本平台不支持：显式诚实回执，绝不静默丢弃。
          this.log(`[fb-comment] 收到本平台不支持的命令 ${env.type}，回 capability_unsupported`);
          this.client.reportActionCompleted({ action: env.type, ok: false, reason: 'capability_unsupported' });
          return;
      }
    } catch (err) {
      // 归一到该命令的回执面，让云端 sendAndAwait 不至于干等超时。
      const action = env.type === 'search.execute' ? 'search' : env.type === 'note.open' ? 'open_note' : env.type === 'interaction.comment' ? 'comment' : env.type;
      if (err instanceof TaskTakeoverError) {
        // 被接管 = **未开始 / 已作废**，不是一次业务失败。绝不降级成 handler_error。
        this.log(`[fb-comment] 命令 ${env.type} 在安全取消点被独占任务接管 → 零页面副作用作废`);
        this.client.reportActionCompleted({ action, ok: false, reason: 'preempted_by_task' });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[fb-comment] 处理命令 ${env.type} 异常：${message}`);
      this.client.reportActionCompleted({ action, ok: false, reason: `handler_error:${message}` });
    }
  }

  private async onSearch(payload: SearchExecutePayload): Promise<void> {
    const keyword = payload.keyword ?? '';
    const container = payload.container ?? '';
    if (!container) {
      // 无容器 = 绝不全站搜（红线）：诚实非成功。
      this.client.reportActionCompleted({ action: 'search', ok: false, reason: 'permission_gated' });
      return;
    }
    const r = await this.executor.searchInContainer(keyword, container);
    if (!r.ok) {
      this.client.reportActionCompleted({ action: 'search', ok: false, reason: r.reason ?? 'no_candidates' });
      return;
    }
    // 命中（含空候选）→ page.cards：permalink 放 noteId，云端据此下发 note.open{url}。
    // containerName：容器真实群名回传，云端据此把配置容器名自动回填（人只看群名、不看 id）。
    const cards: PageCardsPayload['cards'] = r.candidates.map((c, i) => ({
      index: i,
      title: '',
      likeCount: 0,
      collectCount: 0,
      noteId: c.permalink,
    }));
    this.client.reportPageCards({ cards, ...(r.containerName ? { containerName: r.containerName } : {}) });
  }

  private async onOpen(payload: NoteOpenPayload): Promise<void> {
    const url = payload.url ?? '';
    if (!url) {
      this.client.reportActionCompleted({ action: 'open_note', ok: false, reason: 'no_target' });
      return;
    }
    const r = await this.executor.openPost(url);
    if (!r.ok) {
      this.client.reportActionCompleted({ action: 'open_note', ok: false, reason: r.reason ?? 'open_failed' });
      return;
    }
    if (!r.editorReady) {
      // 帖子开了但评论框始终催不出来 → 诚实非成功，让云端换下一个候选（不做无望的提交）。
      this.client.reportActionCompleted({ action: 'open_note', ok: false, reason: 'editor_not_found' });
      return;
    }
    // permalink 作为 noteId 回 note.detail；content=帖子正文（图片帖常空）、comments=顶部他人评论——
    // 供云端撰写器「读了再写」（顺着讨论、用内容语言）。计数诚实置零（本流程不做点赞/收藏计数）。
    this.client.reportNoteDetail({
      noteId: url,
      title: '',
      content: r.postText ?? '',
      likeCount: 0,
      collectCount: 0,
      ...(r.comments && r.comments.length > 0 ? { comments: r.comments } : {}),
    });
  }

  private async onComment(
    payload: InteractionCommentPayload,
    checkpoint?: () => void,
  ): Promise<void> {
    if (this.busy) {
      this.client.reportActionCompleted({ action: 'comment', ok: false, reason: 'busy' });
      return;
    }
    this.busy = true;
    try {
      // noteId 即候选帖 permalink（云端下发）；submitComment 在「已由 note.open 打开的该帖」上操作，
      // 并用它做 own-identity 服务器确认的目标帖收窄。
      const r = await this.executor.submitComment(payload.noteId, payload.text ?? '', payload.groupChatCode, checkpoint);
      this.client.reportActionCompleted({ action: 'comment', ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) });
    } finally {
      this.busy = false;
    }
  }

  private async onJoin(payload: GroupJoinPayload): Promise<void> {
    if (!this.joinExecutor) {
      this.client.reportActionCompleted({ action: 'join_group', ok: false, reason: 'capability_unsupported' });
      return;
    }
    if (this.busy) {
      this.client.reportActionCompleted({ action: 'join_group', ok: false, reason: 'busy' });
      return;
    }
    this.busy = true;
    try {
      const r = await this.joinExecutor.joinGroup(payload.groupUrl, { click: payload.click, thinkMs: payload.thinkMs });
      this.client.reportActionCompleted({
        action: 'join_group',
        ok: r.ok,
        groupUrl: r.groupUrl,
        clicked: r.clicked,
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.observation ? { observation: r.observation } : {}),
        ...(r.postObservation ? { postObservation: r.postObservation } : {}),
      });
    } finally {
      this.busy = false;
    }
  }
}
