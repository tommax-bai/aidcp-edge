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
import {
  clipFacebookUiText,
  emitCompanionUiEvent,
  facebookGroupName,
  facebookReadUiText,
  isAttempted,
  reasonText,
  type FacebookCompanionUiEvent,
} from './companion-ui.js';

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

interface SearchReceiptContext {
  activityId: string;
  purpose: NonNullable<SearchExecutePayload['purpose']>;
  scope: NonNullable<SearchExecutePayload['scope']>;
  actuated: boolean;
}

function makeSearchReceiptContext(payload: SearchExecutePayload, envelopeId: string): SearchReceiptContext {
  return {
    activityId: payload.activityId?.trim() || envelopeId,
    purpose: payload.purpose ?? (payload.taskId || payload.container ? 'task_targeting' : 'discovery'),
    scope: payload.scope ?? (payload.container ? 'container' : 'global'),
    actuated: false,
  };
}

function searchReceiptFields(context: SearchReceiptContext): Pick<
  ActionCompletedPayload,
  'activityId' | 'purpose' | 'scope' | 'actuated' | 'searchOutcome'
> {
  return {
    activityId: context.activityId,
    purpose: context.purpose,
    scope: context.scope,
    actuated: context.actuated,
    searchOutcome: context.actuated ? 'failed_after_submit' : 'not_submitted',
  };
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
   * 陪伴客户端活动条目（change facebook-write-action-visibility）。
   *
   * 这条路径原本对客户端**完全静默**：评论 / 加群 / 定向搜索由会话直接委托到本处理器，
   * 本处理器自己回执给云端后返回，走不到会话里唯一的叙述出口 ⇒ 运营分不清「没做」和「做了但没显示」。
   *
   * 红线：这里**不做任何成功判定**——只叙述执行器已经作出、且已回报云端的判断（判据与上面的
   * reportActionCompleted 完全同源）。
   */
  private emitUi(event: FacebookCompanionUiEvent): void {
    emitCompanionUiEvent(this.log, event);
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
    const searchContext = env.type === 'search.execute'
      ? makeSearchReceiptContext((env.payload ?? {}) as SearchExecutePayload, env.id)
      : undefined;
    try {
      switch (env.type) {
        case 'search.execute':
          await this.onSearch((env.payload ?? {}) as SearchExecutePayload, searchContext!);
          return;
        case 'note.open':
          await this.onOpen(env.payload as NoteOpenPayload);
          return;
        case 'interaction.comment':
          await this.onComment(env.payload as InteractionCommentPayload, checkpoint);
          return;
        case 'group.join':
          await this.onJoin(env.payload as GroupJoinPayload, checkpoint);
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
        this.client.reportActionCompleted({
          action,
          ok: false,
          ...(searchContext ? searchReceiptFields(searchContext) : {}),
          reason: 'preempted_by_task',
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[fb-comment] 处理命令 ${env.type} 异常：${message}`);
      this.client.reportActionCompleted({
        action,
        ok: false,
        ...(searchContext ? searchReceiptFields(searchContext) : {}),
        reason: `handler_error:${message}`,
      });
    }
  }

  private async onSearch(payload: SearchExecutePayload, context: SearchReceiptContext): Promise<void> {
    const keyword = payload.keyword ?? '';
    const container = payload.container ?? '';
    if (!container) {
      // 无容器 = 绝不全站搜（红线）：诚实非成功。
      // 不产活动条目：这是配置问题（没给容器），不是一次真发生过的搜索动作。
      this.client.reportActionCompleted({ action: 'search', ok: false, ...searchReceiptFields(context), reason: 'permission_gated' });
      return;
    }
    const r = await this.executor.searchInContainer(keyword, container, () => { context.actuated = true; });
    context.actuated ||= r.actuated === true;
    if (!r.ok) {
      const reason = r.reason ?? 'no_candidates';
      if (isAttempted(reason)) {
        this.emitUi({
          kind: 'activity',
          type: 'search_failed',
          sentence: `搜「${clipFacebookUiText(keyword, 20)}」失败：${reasonText(reason)}`,
          loopStage: 'feed',
        });
      }
      this.client.reportActionCompleted({ action: 'search', ok: false, ...searchReceiptFields(context), reason });
      return;
    }
    // 群名用执行器现读回传的真名（读不出为 undefined → 回落「群」），绝不把容器 id / URL 当群名展示。
    const where = clipFacebookUiText(r.containerName, 18) || '群';
    const kw = clipFacebookUiText(keyword, 20);
    // 零候选是「搜索成功执行、但没有匹配」——与「搜索失败」是两回事，MUST NOT 混为一谈。
    // 风险计数由 Cloud 消费统一搜索终态；本地不另造 statsDelta。
    this.emitUi({
      kind: 'activity',
      type: 'search',
      sentence: r.candidates.length > 0
        ? `在「${where}」搜「${kw}」，找到 ${r.candidates.length} 条`
        : `在「${where}」搜「${kw}」，没有匹配的帖子`,
      loopStage: 'feed',
    });
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
    this.client.reportActionCompleted({
      action: 'search',
      ok: true,
      activityId: context.activityId,
      purpose: context.purpose,
      scope: context.scope,
      actuated: context.actuated,
      searchOutcome: cards.length > 0 ? 'results_ready' : 'no_results',
      resultCount: cards.length,
    });
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
      // 刻意**不产活动条目**：帖子确实打开并读到了，回非成功只是为了换候选。发一条失败条目会被
      // 误读成「读失败」——把一次成功的阅读叙述成失败，同样是不诚实。沉默才是这里的诚实投影。
      this.client.reportActionCompleted({ action: 'open_note', ok: false, reason: 'editor_not_found' });
      return;
    }
    // permalink 作为 noteId 回 note.detail；content=帖子正文（图片帖常空）、comments=顶部他人评论——
    // 供云端撰写器「读了再写」（顺着讨论、用内容语言）。计数诚实置零（本流程不做点赞/收藏计数）。
    const detail: NoteDetailPayload = {
      noteId: url,
      title: '',
      content: r.postText ?? '',
      likeCount: 0,
      collectCount: 0,
      ...(r.comments && r.comments.length > 0 ? { comments: r.comments } : {}),
    };
    this.client.reportNoteDetail(detail);
    // 与浏览路径共用同一构造器：同一条 note.open 不能一路记「读」、一路隐形（两路措辞必须一致）。
    // 云端本来就在两路都从 note.detail 记一次浏览；这里补齐本地兜底增量使两者对齐。
    this.emitUi({
      kind: 'activity',
      type: 'note_open',
      ...facebookReadUiText(detail),
      loopStage: 'read',
      statsDelta: { views: 1 },
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
      const r = await this.executor.submitComment(
        payload.noteId,
        payload.text ?? '',
        payload.groupChatCode,
        checkpoint,
        payload.fastReturnToFeed === true,
      );
      this.emitCommentOutcome(payload.text ?? '', r.ok, r.reason, payload.fastReturnToFeed === true);
      this.client.reportActionCompleted({ action: 'comment', ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) });
    } finally {
      this.busy = false;
    }
  }

  /**
   * 评论结果 → 活动条目，四档互斥（change facebook-write-action-visibility）。
   *
   * 主语用**我们打进去的评论文本**（一手），绝不用 permalink / noteId。
   * `ok:true` 的语义完全沿用执行器现状（own-identity 服务器确认落地才为真），这里不新增任何成功判定。
   */
  private emitCommentOutcome(text: string, ok: boolean, reason?: string, fastReturnToFeed = false): void {
    const excerpt = clipFacebookUiText(text, 24);
    const subject = excerpt ? `：「${excerpt}」` : '';
    if (ok) {
      // 唯一计数点：真成功才贡献一次本地 comments 兜底增量（云端 dailyUsage 快照仍是权威、会覆盖本地）。
      this.emitUi({
        kind: 'activity',
        type: 'comment',
        sentence: `评论了${subject}`,
        presence: '刚发布了一条评论',
        loopStage: 'interact',
        statsDelta: { comments: 1 },
      });
      return;
    }
    if (reason === 'pending_group_approval') {
      // 诚实枢轴：执行器一手看到待审徽章 / 参与审批弹层，并**有意不刷新**以保住该证据。
      // 这是真实发生的事实，值得告诉运营——但它**没上墙**：绝不说成已发布，绝不计数。
      this.emitUi({
        kind: 'activity',
        type: 'comment_pending',
        sentence: `评论待管理员批准，还没显示出来${subject}`,
        presence: '评论等着群管理员批准…',
        loopStage: 'interact',
      });
      return;
    }
    if (fastReturnToFeed && reason === 'verification_ambiguous') {
      this.emitUi({
        kind: 'activity',
        type: 'comment_pending',
        sentence: `评论已提交，按 --feed 返回首页，未确认是否显示${subject}`,
        presence: '评论已提交，平台结果未确认…',
        loopStage: 'interact',
      });
      return;
    }
    if (!isAttempted(reason)) return; // 被占 / 被抢占 / 会话关闭中：未开始，不是失败——不产条目
    this.emitUi({
      kind: 'activity',
      type: 'comment_failed',
      sentence: `评论没发出去：${reasonText(reason)}`,
      loopStage: 'interact',
    });
  }

  private async onJoin(payload: GroupJoinPayload, checkpoint?: () => void): Promise<void> {
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
      // checkpoint（5.10b）：加群点击后短确认窗口过后的观察尾段可被接管中断，被接管即抛 → handle catch 转 preempted_by_task。
      const r = await this.joinExecutor.joinGroup(payload.groupUrl, { click: payload.click, thinkMs: payload.thinkMs }, checkpoint);
      this.emitJoinOutcome(r.ok, r.clicked, r.reason, r.postObservation ?? r.observation);
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

  /**
   * 加群结果 → 活动条目（change facebook-write-action-visibility）。
   *
   * 成功判据**镜像云端自己的证据闸**（cloud handler.ts 的 interaction.occurred：`ok && clicked===true`），
   * 使客户端与云端永不就「到底有没有加进去」给出互相矛盾的结论。
   *
   * 无 statsDelta：本地 stats / 云端 dailyUsage 的形状里**根本没有加群字段**（云端投影只覆盖 6 个动作），
   * 凭空造一个会让本地兜底与云端权威计数漂移——零收益。
   */
  private emitJoinOutcome(
    ok: boolean,
    clicked: boolean,
    reason?: string,
    observation?: { title?: string },
  ): void {
    const name = facebookGroupName(observation);
    if (ok && clicked) {
      this.emitUi({
        kind: 'activity',
        type: 'join_group',
        sentence: `加入了小组「${name}」`,
        presence: `刚加入了「${name}」`,
        loopStage: 'interact',
      });
      return;
    }
    // 点了 ≠ 加进去了：FB 群普遍要管理员审批 / 答题。二者都是一手观察到的真实中间态，
    // 如实单列，绝不表述为已加入。
    if (reason === 'pending') {
      this.emitUi({
        kind: 'activity',
        type: 'join_pending',
        sentence: `申请加入「${name}」，等待管理员通过`,
        loopStage: 'interact',
      });
      return;
    }
    if (reason === 'questionnaire_required') {
      this.emitUi({
        kind: 'activity',
        type: 'join_pending',
        sentence: `「${name}」需要回答入群问题，没有自动作答`,
        loopStage: 'interact',
      });
      return;
    }
    // already_member = 本来就是成员，没发生一次加群动作；observation_only = 按设计只探不点。
    // 二者都在 isAttempted 的拒绝集里（observation_only），already_member 在此显式拦掉。
    if (reason === 'already_member') return;
    if (!isAttempted(reason)) return;
    this.emitUi({
      kind: 'activity',
      type: 'join_failed',
      sentence: `没能加入「${name}」：${reasonText(reason)}`,
      loopStage: 'interact',
    });
  }
}
