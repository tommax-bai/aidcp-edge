(function attachContentWorkspace(global) {
  'use strict';

  const PAGE_SIZE = 12;
  const INSPIRATION_SATURATION_COUNT = 30;
  const PUBLISH_QUEUE_POLL_MS = 20_000;
  const QUEUE_TASK_STATUSES = new Set(['queued', 'planning', 'deferred']);
  const QUEUE_JOURNEY_STATUSES = new Set([
    'generating', 'waiting_approval', 'dispatching', 'scheduled', 'published',
    'submitted', 'failed', 'rejected', 'draft', 'skipped',
  ]);
  const QUEUE_STAGE_STATES = new Set([
    'pending', 'running', 'retrying', 'waiting_human', 'completed', 'partial', 'failed', 'skipped',
  ]);

  function createElement(document, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function finiteCount(value) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
  }

  function countText(value) {
    const count = finiteCount(value);
    return count === null ? '暂无数据' : String(count);
  }

  function relativeDate(value) {
    if (!Number.isFinite(value)) return '时间未知';
    try {
      return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        .format(new Date(value));
    } catch {
      return '时间未知';
    }
  }

  function sourcePublishedText(item) {
    const rawText = typeof item?.sourcePublishedAtText === 'string'
      ? item.sourcePublishedAtText.trim()
      : '';
    if (item?.sourcePublishedAtStatus === 'parsed' && Number.isFinite(item.sourcePublishedAt)) {
      const precision = item.sourcePublishedAtPrecision;
      try {
        if (precision === 'day') {
          const formatted = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric',
          }).format(new Date(item.sourcePublishedAt));
          return `发布于 ${formatted}`;
        }
        if (precision === 'hour') {
          const formatted = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', hour12: false,
          }).format(new Date(item.sourcePublishedAt));
          return `发布于 ${formatted}时左右`;
        }
        if (precision === 'minute') {
          const formatted = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: false,
          }).format(new Date(item.sourcePublishedAt));
          return `发布于 ${formatted}`;
        }
      } catch {
        // Fall through to retained raw evidence or the explicit unknown state.
      }
    }
    if (item?.sourcePublishedAtStatus === 'unparseable' && rawText) {
      return `发布于 ${rawText}（未转换）`;
    }
    return '发布时间未知';
  }

  function normalizePublishQueueResponse(response) {
    const data = response?.ok && response.data && response.data.data;
    const meta = response?.data && response.data.meta;
    if (!data || !data.summary || !Array.isArray(data.tasks)
        || !Array.isArray(data.active) || !Array.isArray(data.recent)) return null;
    const summary = {
      inProgress: finiteCount(data.summary.inProgress),
      waitingForYou: finiteCount(data.summary.waitingForYou),
      cancellable: finiteCount(data.summary.cancellable),
    };
    if (Object.values(summary).some((value) => value === null)) return null;
    const tasks = data.tasks.map((task) => {
      if (!task || typeof task.id !== 'string' || !task.id.trim() || typeof task.title !== 'string'
          || typeof task.action !== 'string' || !QUEUE_TASK_STATUSES.has(task.status)
          || typeof task.statusLabel !== 'string' || typeof task.cancelRequested !== 'boolean'
          || !Number.isInteger(task.version) || task.version < 0) return null;
      return {
        id: task.id,
        title: task.title || 'AI 创作任务',
        action: task.action,
        status: task.status,
        statusLabel: task.statusLabel,
        cancelRequested: task.cancelRequested,
        version: task.version,
        createdAt: Number(task.createdAt),
        updatedAt: Number(task.updatedAt),
        notBefore: Number(task.notBefore),
      };
    });
    if (tasks.some((task) => task === null)) return null;
    const normalizeJourney = (journey) => {
      if (!journey || typeof journey.id !== 'string' || typeof journey.title !== 'string'
          || !QUEUE_JOURNEY_STATUSES.has(journey.status) || typeof journey.statusLabel !== 'string'
          || !Array.isArray(journey.stages)) return null;
      const stages = journey.stages.map((stage) => {
        if (!stage || typeof stage.key !== 'string' || typeof stage.label !== 'string'
            || !QUEUE_STAGE_STATES.has(stage.state) || typeof stage.summary !== 'string') return null;
        const progress = stage.progress;
        if (progress !== undefined && (!progress || !Number.isFinite(progress.current)
            || !Number.isFinite(progress.total) || progress.total <= 0)) return null;
        return {
          key: stage.key,
          label: stage.label,
          state: stage.state,
          summary: stage.summary,
          ...(progress ? { progress: { current: progress.current, total: progress.total } } : {}),
        };
      });
      if (stages.some((stage) => stage === null)) return null;
      return {
        id: journey.id,
        recordId: Number.isInteger(journey.recordId) ? journey.recordId : null,
        title: journey.title || '未命名笔记',
        sourceTitle: typeof journey.sourceTitle === 'string' && journey.sourceTitle.trim() ? journey.sourceTitle.trim() : null,
        kind: journey.kind,
        startedAt: Number(journey.startedAt),
        status: journey.status,
        statusLabel: journey.statusLabel,
        stages,
      };
    };
    const active = data.active.map(normalizeJourney);
    const recent = data.recent.map(normalizeJourney);
    if (active.some((journey) => journey === null) || recent.some((journey) => journey === null)) return null;
    const asOf = Number(meta && meta.asOf);
    if (!Number.isFinite(asOf)) return null;
    return { summary, tasks, active, recent, asOf };
  }

  function referenceImageUrl(image) {
    if (!image || typeof image !== 'object') return '';
    if (typeof image.ossUrl === 'string' && image.ossUrl.trim()) return image.ossUrl.trim();
    return typeof image.sourceUrl === 'string' ? image.sourceUrl.trim() : '';
  }

  function hasReferenceImages(item) {
    return Array.isArray(item && item.referenceImages) && item.referenceImages.some((image) => referenceImageUrl(image));
  }

  function rejectionMessage(reason, detail) {
    switch (reason) {
      case 'image_text_only': return '这条内容不是可参照创作的图文内容。';
      case 'empty_body': return '这条内容缺少可参考的正文。';
      case 'reference_images_unavailable': return '参考图已经不可用，请改为只参考文字。';
      case 'environment_not_owned': return '当前账号已不在你的可用范围内，请刷新环境。';
      case 'client_session_expired': return '登录已过期，请重新登录客户端。';
      case 'client_session_required': return '请先登录客户端，再打开当前账号的灵感库。';
      case 'selected_environment_required': return '请先选择一个账号环境。';
      case 'account_paused': return '当前账号已暂停，暂时不能排队创作。';
      case 'account_name_required': return '当前账号缺少可读昵称，请先完成账号信息采集。';
      case 'unsupported_action': return '当前账号平台暂不支持这项创作任务。';
      case 'platform_mismatch': return '账号平台信息已变化，请刷新环境后重试。';
      case 'curated_content_unavailable':
      case 'curated_actions_unavailable': return '灵感库服务暂时不可用，请稍后重试。';
      // 环境→账号绑定（change curated-envkey-account-binding）：区分「还不知道是谁」「跨客户争用」「离线未佐证」。
      case 'binding_unknown': return '系统还不知道这个环境上登录的是哪个账号。把这个环境连上云端一次就会自动识别。';
      case 'binding_conflict': return '这个账号同时出现在多个客户的环境上，出于安全暂不能读取，请联系管理员核对环境归属。';
      case 'binding_unverified': return '暂时无法确认这个环境当前登录的账号，请让它连上云端后重试。';
      default:
        return typeof detail === 'string' && detail.trim() && detail !== reason
          ? detail.trim()
          : '请求没有完成，请稍后重试。';
    }
  }

  /**
   * 任务已被受理时的诚实回执；未受理（终态）返回 null 交给 terminalTaskMessage。
   * 同一分钟内重复提交会被服务端按去重键收敛到上一条同样的任务，那条可能已经跑起来甚至跑完了——
   * 它同样是「被受理」，绝不能报成失败：报失败会把操作员推去再点一次，反而制造重复稿件。
   */
  function acceptedTaskMessage(status, shortId) {
    switch (status) {
      case 'queued':
      case 'draft':
      case 'awaiting_confirmation':
        return `已排队创作 · 任务 ${shortId}。后续会生成稿件并进入审核；这里不代表已经生成或发布。`;
      case 'planning':
      case 'executing':
        return `这条灵感的创作任务已在执行 · 任务 ${shortId}。稿件生成后会进入审核。`;
      case 'waiting_approval':
        return `这条灵感的稿件已生成、正在等待审核 · 任务 ${shortId}。`;
      case 'deferred':
        return `这条灵感的创作任务已受理、正在等待可执行的时机 · 任务 ${shortId}。`;
      case 'completed':
      case 'partially_completed':
        return `刚刚这条灵感的创作任务已经完成 · 任务 ${shortId}。请到稿件审核查看结果。`;
      default:
        return null;
    }
  }

  /** 未受理的终态：如实说明上一条同样的任务是什么下场，不含糊成「没排上队」。 */
  function terminalTaskMessage(status) {
    switch (status) {
      case 'cancelled': return '刚刚这条灵感上一次的创作任务已被取消，稍后可再试';
      case 'failed': return '刚刚这条灵感上一次的创作任务失败了，稍后可再试';
      default: return `服务端返回了未知的任务状态「${status}」，未按成功处理`;
    }
  }

  function responseFailureMessage(response) {
    return rejectionMessage(response?.reason || response?.error, response?.error);
  }

  function create(options) {
    const root = options && options.root;
    const legacyRoot = options && options.legacyRoot;
    const interactionRoot = options && options.interactionRoot;
    const shell = options && options.shell;
    const api = (options && options.api) || {};
    if (!root || !legacyRoot) return null;

    const document = root.ownerDocument;
    const fields = {
      entry: document.querySelector('#content-library-entry'),
      entryCount: document.querySelector('#content-library-entry-count'),
      entryDraftCount: document.querySelector('#content-library-entry-draft-count'),
      back: root.querySelector('#content-workspace-back'),
      close: root.querySelector('#content-workspace-close'),
      kicker: root.querySelector('#content-workspace-kicker'),
      title: root.querySelector('#content-workspace-title'),
      meta: root.querySelector('#content-workspace-meta'),
      library: root.querySelector('#curated-library-view'),
      detailView: root.querySelector('#curated-detail-view'),
      createView: root.querySelector('#curated-create-view'),
      queueView: root.querySelector('#publish-queue-view'),
      queueContent: root.querySelector('#publish-queue-content'),
      draft: root.querySelector('#publish-preview-panel'),
      list: root.querySelector('#curated-list'),
      total: root.querySelector('#curated-list-total'),
      page: root.querySelector('#curated-page'),
      prev: root.querySelector('#curated-prev'),
      next: root.querySelector('#curated-next'),
      modeButtons: Array.from(root.querySelectorAll('[data-curated-mode]')),
      detail: root.querySelector('#curated-detail'),
      create: root.querySelector('#curated-create'),
      queueCancelDialog: document.querySelector('#publish-queue-cancel-confirm'),
      queueCancelClose: document.querySelector('#publish-queue-cancel-close'),
      queueCancelBack: document.querySelector('#publish-queue-cancel-back'),
      queueCancelSubmit: document.querySelector('#publish-queue-cancel-submit'),
      queueCancelTitle: document.querySelector('#publish-queue-cancel-title'),
      queueCancelDetail: document.querySelector('#publish-queue-cancel-detail'),
    };

    const states = new Map();
    let environment = null;
    let requestEpoch = 0;
    let summaryEpoch = 0;
    let queueEpoch = 0;
    let queuePollTimer = null;
    let queueCancelContext = null;
    let currentPage = 'home';
    let backStack = [];
    let sourceWorkspace = 'legacy';
    let currentDetail = null;
    let createMode = false;
    let createBusy = false;

    function envState() {
      if (!environment) return null;
      if (!states.has(environment.envId)) {
        states.set(environment.envId, {
          mode: 'uncreated',
          page: 1,
          total: 0,
          items: [],
          scrollTop: 0,
          loaded: false,
          needsReload: false,
          inspirationCount: null,
          referenceDraftCount: null,
          summaryLoading: false,
          summaryFailed: false,
          summaryRequestId: 0,
          publishQueue: {
            kind: 'idle',
            data: null,
            error: null,
            stale: false,
            refreshing: false,
            requestedAt: 0,
          },
          queueFeedback: null,
          queueCancelBusyId: null,
        });
      }
      return states.get(environment.envId);
    }

    function visible() {
      return !root.classList.contains('hidden');
    }

    function inspirationAvailable() {
      return environment?.platform === 'xiaohongshu';
    }

    function publishQueueAvailable() {
      return inspirationAvailable() && typeof api.publishQueueGet === 'function';
    }

    function captureSourceWorkspace() {
      sourceWorkspace = interactionRoot && !interactionRoot.classList.contains('hidden') ? 'interaction' : 'legacy';
    }

    function setWorkspaceVisible(show) {
      root.classList.toggle('hidden', !show);
      if (show) {
        legacyRoot.classList.add('hidden');
        interactionRoot?.classList.add('hidden');
        shell?.classList.add('content-mode');
      } else {
        shell?.classList.remove('content-mode');
        if (sourceWorkspace === 'interaction' && interactionRoot) {
          interactionRoot.classList.remove('hidden');
          legacyRoot.classList.add('hidden');
        } else {
          legacyRoot.classList.remove('hidden');
          interactionRoot?.classList.add('hidden');
        }
      }
    }

    function hideViews() {
      for (const view of [fields.library, fields.detailView, fields.createView, fields.queueView, fields.draft]) {
        view?.classList.add('hidden');
      }
      fields.draft?.classList.remove('open');
      fields.draft?.setAttribute('aria-hidden', 'true');
    }

    function configureHeader(page) {
      const account = environment?.label || '当前账号';
      const isDetail = page === 'detail';
      const returnsToLibrary = isDetail || page === 'create';
      fields.back?.classList.toggle('hidden', backStack.length === 0 || isDetail);
      fields.close?.setAttribute('aria-label', returnsToLibrary ? '返回灵感库' : '关闭内容工作区');
      if (page === 'library') {
        fields.kicker.textContent = '精选内容';
        fields.title.textContent = '灵感库';
        fields.meta.textContent = `${account} · 只展示这个账号进入精选池的内容`;
      } else if (page === 'detail') {
        fields.kicker.textContent = '灵感详情';
        fields.title.textContent = currentDetail?.title || '查看灵感';
        fields.meta.textContent = account;
      } else if (page === 'create') {
        fields.kicker.textContent = '参考创作';
        fields.title.textContent = '选择参考方式';
        fields.meta.textContent = `${account} · 确认后只代表任务排队`;
      } else if (page === 'draft') {
        fields.kicker.textContent = '待你确认';
        fields.title.textContent = '稿件审核';
        fields.meta.textContent = `${account} · 发布与取消仍以云端回执为准`;
      } else if (page === 'queue') {
        fields.kicker.textContent = '小红书发布';
        fields.title.textContent = '发布进度';
        fields.meta.textContent = `${account} · 只展示这个账号的排队与发布真态`;
      }
    }

    function showPage(page, pushCurrent) {
      if (pushCurrent && currentPage !== 'home') backStack.push(currentPage);
      currentPage = page;
      root.classList.toggle('curated-detail-mode', page === 'detail');
      hideViews();
      const view = page === 'library'
        ? fields.library
        : page === 'detail'
          ? fields.detailView
          : page === 'create'
            ? fields.createView
            : page === 'queue'
              ? fields.queueView
              : fields.draft;
      view?.classList.remove('hidden');
      if (page === 'draft') {
        fields.draft?.classList.add('open');
        fields.draft?.setAttribute('aria-hidden', 'false');
      }
      configureHeader(page);
    }

    function close() {
      const leavingPage = currentPage;
      requestEpoch += 1;
      queueEpoch += 1;
      if (queuePollTimer) {
        global.clearTimeout(queuePollTimer);
        queuePollTimer = null;
      }
      closeQueueCancelDialog();
      currentPage = 'home';
      backStack = [];
      currentDetail = null;
      createBusy = false;
      root.classList.remove('curated-detail-mode');
      hideViews();
      setWorkspaceVisible(false);
      schedulePublishQueuePoll();
      if (leavingPage !== 'home') {
        root.dispatchEvent(new global.CustomEvent('content-workspace:leave', { detail: { page: leavingPage } }));
      }
    }

    function goBack() {
      const previous = backStack.pop();
      if (!previous || previous === 'home') {
        close();
        return;
      }
      const leavingPage = currentPage;
      showPage(previous, false);
      if (leavingPage !== previous) {
        root.dispatchEvent(new global.CustomEvent('content-workspace:leave', { detail: { page: leavingPage } }));
      }
      if (previous === 'library') {
        const state = envState();
        if (state?.needsReload) {
          state.needsReload = false;
          void loadList();
        } else {
          renderList();
          if (state && fields.list) fields.list.scrollTop = state.scrollTop;
        }
      } else if (previous === 'detail') {
        renderDetail(currentDetail);
      } else if (previous === 'queue') {
        renderPublishQueue();
        schedulePublishQueuePoll();
      }
    }

    function returnToLibrary() {
      const libraryIndex = backStack.lastIndexOf('library');
      if (libraryIndex < 0) {
        close();
        return;
      }
      backStack.splice(libraryIndex + 1);
      goBack();
    }

    function handleCloseControl() {
      if (currentPage === 'detail' || currentPage === 'create') {
        returnToLibrary();
        return;
      }
      close();
    }

    function updateEntry() {
      const state = envState();
      const available = inspirationAvailable();
      const count = finiteCount(state?.inspirationCount);
      const draftCount = finiteCount(state?.referenceDraftCount);
      const loading = Boolean(state?.summaryLoading);
      const failed = Boolean(state?.summaryFailed);
      const fill = count === null ? 0 : Math.min(100, (count / INSPIRATION_SATURATION_COUNT) * 100);
      if (fields.entry) {
        fields.entry.classList.toggle('hidden', !available);
        fields.entry.disabled = !available;
      }
      if (fields.entryCount) fields.entryCount.textContent = count === null ? '—' : String(count);
      if (fields.entryDraftCount) fields.entryDraftCount.textContent = draftCount === null ? '—' : String(draftCount);
      if (fields.entry) {
        fields.entry.style.setProperty('--inspiration-fill', `${fill}%`);
        fields.entry.classList.toggle('is-rich', count !== null && count >= INSPIRATION_SATURATION_COUNT);
        // 数值未知时储备条必须与「真的 0 条」不同：0% 宽度和真实零值像素级等同，会把「没读到」画成「没有」。
        fields.entry.classList.toggle('is-unknown', available && count === null);
        fields.entry.setAttribute('aria-busy', loading ? 'true' : 'false');
        // 「加载中」只在真的在加载时说；读失败必须说失败，不能永远停在加载中。
        const unknownLabel = loading ? '数据加载中' : failed ? '数据读取失败' : '数据暂缺';
        const countLabel = count === null ? `灵感${unknownLabel}` : `灵感 ${count}`;
        const draftLabel = draftCount === null ? `成稿${unknownLabel}` : `已成稿 ${draftCount}`;
        const action = failed && !loading ? '点击重试' : '点击进入';
        fields.entry.setAttribute(
          'aria-label',
          environment ? `灵感库，${countLabel}，${draftLabel}，${action}` : '灵感库，请先选择账号',
        );
        fields.entry.title = !environment
          ? '请先选择一个账号环境'
          : failed && !loading
            ? '灵感数据没读到，点击进入并重试'
            : '点击进入灵感库';
      }
    }

    async function loadSummary(force = false) {
      const state = envState();
      if (!state || !inspirationAvailable() || typeof api.curatedSummary !== 'function') return;
      if (state.summaryLoading || (!force && state.inspirationCount !== null && state.referenceDraftCount !== null)) return;
      const capturedEnvId = environment.envId;
      const capturedEpoch = ++summaryEpoch;
      state.summaryLoading = true;
      state.summaryRequestId = capturedEpoch;
      updateEntry();
      let response;
      try {
        response = await api.curatedSummary(capturedEnvId);
      } catch {
        response = { ok: false, error: 'request_failed' };
      }
      const isLatestForState = state.summaryRequestId === capturedEpoch;
      if (!isLatestForState || capturedEpoch !== summaryEpoch || environment?.envId !== capturedEnvId) {
        if (isLatestForState) state.summaryLoading = false;
        return;
      }
      state.summaryLoading = false;
      // 读失败与「读到但计数缺失」都落 null，但两者不是一回事：前者要说失败、后者是服务端诚实缺数。
      state.summaryFailed = !response?.ok;
      state.inspirationCount = response?.ok ? finiteCount(response.data?.total) : null;
      state.referenceDraftCount = response?.ok ? finiteCount(response.data?.referenceDraftCount) : null;
      updateEntry();
    }

    function renderListMessage(title, detail, retry) {
      fields.list.replaceChildren();
      const state = createElement(document, 'div', 'cw-state');
      state.appendChild(createElement(document, 'strong', '', title));
      state.appendChild(createElement(document, 'span', '', detail));
      if (retry) {
        const button = createElement(document, 'button', 'cw-button secondary', '重新加载');
        button.type = 'button';
        button.addEventListener('click', () => { void loadList(); });
        state.appendChild(button);
      }
      fields.list.appendChild(state);
    }

    function renderStats(parent, item) {
      const stats = createElement(document, 'div', 'curated-stats');
      stats.appendChild(createElement(document, 'span', '', `赞 ${countText(item.likeCount)}`));
      stats.appendChild(createElement(document, 'span', '', `藏 ${countText(item.collectCount)}`));
      stats.appendChild(createElement(document, 'span', '', `评 ${countText(item.commentCount)}`));
      parent.appendChild(stats);
    }

    function renderList() {
      const state = envState();
      if (!state || !fields.list) return;
      fields.list.replaceChildren();
      fields.list.setAttribute('aria-busy', 'false');
      const totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
      fields.total.textContent = state.total === 0 ? '暂无内容' : `共 ${state.total} 条`;
      fields.page.textContent = `第 ${state.page} / ${totalPages} 页`;
      fields.prev.disabled = state.page <= 1;
      fields.next.disabled = state.page >= totalPages;
      fields.modeButtons.forEach((button) => {
        const active = button.dataset.curatedMode === state.mode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      if (state.items.length === 0) {
        const empty = state.mode === 'uncreated'
          ? ['还没有未创作灵感', '可以切到“已创作”或“全部”查看其它内容。']
          : state.mode === 'created'
            ? ['还没有已创作灵感', '成功发起一次洗稿后，对应灵感会出现在这里。']
            : ['精选池还是空的', '系统发现适合当前账号的内容后，会出现在这里。'];
        renderListMessage(
          empty[0],
          empty[1],
          false,
        );
        return;
      }
      for (const item of state.items) {
        const card = createElement(document, 'button', 'curated-card');
        card.type = 'button';
        card.dataset.curatedId = String(item.id);
        const imageUrl = Array.isArray(item.referenceImages)
          ? item.referenceImages.map(referenceImageUrl).find(Boolean)
          : '';
        if (imageUrl) {
          const image = createElement(document, 'img', 'curated-card-image');
          image.src = imageUrl;
          image.alt = '';
          image.referrerPolicy = 'no-referrer';
          card.appendChild(image);
        } else {
          card.appendChild(createElement(document, 'span', 'curated-card-image placeholder', item.contentType === 'video' ? '视频' : '文字'));
        }
        const copy = createElement(document, 'span', 'curated-card-copy');
        const top = createElement(document, 'span', 'curated-card-top');
        top.appendChild(createElement(document, 'strong', '', item.title || '未命名内容'));
        top.appendChild(createElement(document, 'em', item.creatable ? 'ready' : '', item.creatable ? '可创作' : '仅查看'));
        copy.appendChild(top);
        copy.appendChild(createElement(document, 'span', 'curated-card-body', item.bodyPreview || '暂无正文摘要'));
        copy.appendChild(createElement(document, 'span', 'curated-card-meta', `${item.author || '作者未知'} · ${sourcePublishedText(item)}`));
        renderStats(copy, item);
        card.appendChild(copy);
        card.addEventListener('click', () => {
          state.scrollTop = fields.list.scrollTop;
          void openDetail(item.id);
        });
        fields.list.appendChild(card);
      }
    }

    async function loadList() {
      const state = envState();
      if (!state || !environment) return;
      const capturedEnvId = environment.envId;
      const capturedEpoch = ++requestEpoch;
      fields.list.setAttribute('aria-busy', 'true');
      fields.total.textContent = '正在读取…';
      renderListMessage('正在读取这个账号的灵感', '只会显示当前账号进入精选池的内容。', false);
      if (typeof api.curatedList !== 'function') {
        renderListMessage('当前版本暂不支持灵感库', '请升级客户端后重试。', false);
        return;
      }
      let response;
      try {
        response = await api.curatedList(capturedEnvId, {
          mode: state.mode,
          limit: PAGE_SIZE,
          offset: (state.page - 1) * PAGE_SIZE,
        });
      } catch {
        response = { ok: false, error: 'request_failed' };
      }
      if (capturedEpoch !== requestEpoch || environment?.envId !== capturedEnvId || currentPage !== 'library') return;
      if (!response?.ok || !response.data || !Array.isArray(response.data.items)) {
        // 「还不知道这个环境上是谁」是一等可见状态，MUST NOT 复用「精选池还是空的」空态（那是谎）：
        // 上线当日多数环境都是这个态，画成通用失败会让运营把正常的自愈期误报为故障（change
        // curated-envkey-account-binding）。连一次云端即自愈，故给重新加载按钮。
        const failReason = response?.reason || response?.error;
        if (failReason === 'binding_unknown') {
          fields.total.textContent = '尚未识别账号';
          renderListMessage('还不知道这个环境上是谁',
            '系统还没识别到这个环境当前登录的账号。把这个环境连上云端一次就会自动识别，随后灵感库会自动出现。', true);
          return;
        }
        fields.total.textContent = '读取失败';
        renderListMessage('暂时没能读取灵感库', responseFailureMessage(response), true);
        return;
      }
      state.items = response.data.items;
      state.total = finiteCount(response.data.total) ?? 0;
      if (state.mode === 'all') state.inspirationCount = finiteCount(response.data.total);
      const referenceDraftCount = finiteCount(response.data.referenceDraftCount);
      if (referenceDraftCount !== null) state.referenceDraftCount = referenceDraftCount;
      state.loaded = true;
      updateEntry();
      const lastPage = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
      if (state.page > lastPage) {
        state.page = lastPage;
        await loadList();
        return;
      }
      renderList();
      if (fields.list) fields.list.scrollTop = state.scrollTop;
    }

    function openLibrary() {
      if (!inspirationAvailable()) return;
      if (!visible()) {
        captureSourceWorkspace();
        setWorkspaceVisible(true);
      }
      backStack = ['home'];
      currentDetail = null;
      showPage('library', false);
      void loadSummary(true);
      void loadList();
    }

    function renderDetailMessage(title, detail) {
      fields.detail.replaceChildren();
      const state = createElement(document, 'div', 'cw-state');
      state.appendChild(createElement(document, 'strong', '', title));
      state.appendChild(createElement(document, 'span', '', detail));
      fields.detail.appendChild(state);
    }

    function renderDetail(item) {
      if (!item) return;
      currentDetail = item;
      configureHeader('detail');
      fields.detail.replaceChildren();
      const layout = createElement(document, 'div', 'curated-detail-layout');
      const media = createElement(document, 'section', 'curated-detail-media');
      const images = Array.isArray(item.referenceImages)
        ? item.referenceImages.map(referenceImageUrl).filter(Boolean)
        : [];
      if (images.length > 0) {
        for (const url of images) {
          const image = createElement(document, 'img', 'curated-detail-image');
          image.src = url;
          image.alt = '';
          image.referrerPolicy = 'no-referrer';
          media.appendChild(image);
        }
      } else {
        media.appendChild(createElement(document, 'div', 'curated-detail-no-image', '这条灵感没有可用参考图'));
      }
      const content = createElement(document, 'article', 'curated-detail-copy');
      const type = item.contentType === 'image_text' ? '图文' : item.contentType === 'video' ? '视频' : '评论';
      content.appendChild(createElement(document, 'span', `curated-detail-badge ${item.creatable ? 'ready' : ''}`, item.creatable ? '可参考创作' : `${type} · 仅查看`));
      content.appendChild(createElement(document, 'h2', '', item.title || '未命名内容'));
      content.appendChild(createElement(document, 'p', 'curated-detail-author', `${item.author || '作者未知'} · ${sourcePublishedText(item)}`));
      renderStats(content, item);
      content.appendChild(createElement(document, 'div', 'curated-detail-body', item.body || '暂无正文'));
      if (Array.isArray(item.topics) && item.topics.length > 0) {
        const topics = createElement(document, 'div', 'curated-detail-topics');
        item.topics.forEach((topic) => topics.appendChild(createElement(document, 'span', '', `#${String(topic).replace(/^#/, '')}`)));
        content.appendChild(topics);
      }
      const footer = createElement(document, 'div', 'curated-detail-actions');
      if (item.creatable) {
        const createButton = createElement(document, 'button', 'cw-button primary', '用这条灵感创作');
        createButton.type = 'button';
        createButton.addEventListener('click', () => {
          createMode = hasReferenceImages(item);
          showPage('create', true);
          renderCreate();
        });
        footer.appendChild(createButton);
      } else {
        footer.appendChild(createElement(document, 'span', 'cw-inline-note', '当前只支持正文非空的图文内容发起参考创作。'));
      }
      content.appendChild(footer);
      layout.appendChild(media);
      layout.appendChild(content);
      fields.detail.appendChild(layout);
    }

    async function openDetail(id) {
      if (!environment || !Number.isInteger(id)) return;
      const capturedEnvId = environment.envId;
      const capturedEpoch = ++requestEpoch;
      showPage('detail', true);
      renderDetailMessage('正在读取灵感详情', '正文和参考图只来自当前账号的精选快照。');
      if (typeof api.curatedGet !== 'function') {
        renderDetailMessage('当前版本暂不支持灵感详情', '请升级客户端后重试。');
        return;
      }
      let response;
      try {
        response = await api.curatedGet(capturedEnvId, id);
      } catch {
        response = { ok: false, error: 'request_failed' };
      }
      if (capturedEpoch !== requestEpoch || environment?.envId !== capturedEnvId || currentPage !== 'detail') return;
      if (!response?.ok || !response.data?.item) {
        renderDetailMessage('没有读到这条灵感', responseFailureMessage(response));
        return;
      }
      renderDetail(response.data.item);
    }

    function renderCreate() {
      const item = currentDetail;
      if (!item) return;
      fields.create.replaceChildren();
      const intro = createElement(document, 'div', 'curated-create-intro');
      intro.appendChild(createElement(document, 'span', 'cw-kicker', '本次参考'));
      intro.appendChild(createElement(document, 'h2', '', item.title || '未命名内容'));
      intro.appendChild(createElement(document, 'p', '', '选择 AI 参考哪些素材。确认后只创建排队任务，稿件生成后仍会进入审核。'));
      fields.create.appendChild(intro);

      const modes = createElement(document, 'div', 'curated-create-modes');
      const imageAvailable = hasReferenceImages(item);
      const addMode = (useImages, title, detail) => {
        const button = createElement(document, 'button', `curated-mode-card ${createMode === useImages ? 'selected' : ''}`);
        button.type = 'button';
        button.disabled = useImages && !imageAvailable;
        button.setAttribute('aria-pressed', createMode === useImages ? 'true' : 'false');
        button.appendChild(createElement(document, 'strong', '', title));
        button.appendChild(createElement(document, 'span', '', detail));
        button.addEventListener('click', () => {
          createMode = useImages;
          renderCreate();
        });
        modes.appendChild(button);
      };
      addMode(true, '图文一起参考', imageAvailable ? '参考正文、话题和已保存的参考图' : '这条灵感没有可用参考图');
      addMode(false, '只参考文字', '只参考正文和话题，配图由创作链路重新规划');
      fields.create.appendChild(modes);

      const message = createElement(document, 'p', 'curated-create-message');
      message.setAttribute('aria-live', 'polite');
      const submit = createElement(document, 'button', 'cw-button primary', createBusy ? '正在排队…' : '确认并排队创作');
      submit.type = 'button';
      submit.disabled = createBusy || (createMode && !imageAvailable);
      submit.addEventListener('click', async () => {
        if (createBusy || !environment || typeof api.curatedCreatePost !== 'function') return;
        createBusy = true;
        renderCreate();
        const capturedEnvId = environment.envId;
        const capturedEpoch = ++requestEpoch;
        let response;
        try {
          response = await api.curatedCreatePost(capturedEnvId, item.id, createMode);
        } catch {
          response = { ok: false, error: 'request_failed' };
        }
        // 忙碌锁必须先解，再判陈旧：解锁写在 return 之后的话，请求在途时离开创作页
        // （返回详情 / 打开稿件审核）就会把锁永久留死，回到创作页只剩一个禁用的「正在排队…」。
        createBusy = false;
        if (capturedEpoch !== requestEpoch || environment?.envId !== capturedEnvId || currentPage !== 'create') return;
        renderCreate();
        const liveMessage = fields.create.querySelector('.curated-create-message');
        const liveSubmit = fields.create.querySelector('.cw-button.primary');
        if (!response?.ok) {
          liveMessage.textContent = responseFailureMessage(response);
          liveMessage.classList.add('error');
          return;
        }
        if (response.data?.triggered === false) {
          liveMessage.textContent = rejectionMessage(response.data.reason);
          liveMessage.classList.add('error');
          return;
        }
        const task = response.data?.task;
        if (!task || typeof task.status !== 'string') {
          liveMessage.textContent = '服务端没有返回任务，未按成功处理。';
          liveMessage.classList.add('error');
          return;
        }
        const shortId = typeof task.id === 'string' ? `${task.id.slice(0, 8)}…` : '未知';
        const accepted = acceptedTaskMessage(task.status, shortId);
        if (!accepted) {
          // 只有真正没被受理的终态才算失败（同一分钟内重复提交会被去重到上一条同样的任务）。
          liveMessage.textContent = `${terminalTaskMessage(task.status)}（任务 ${shortId}）`;
          liveMessage.classList.add('error');
          return;
        }
        liveMessage.textContent = accepted;
        liveMessage.classList.add('queued');
        liveSubmit.disabled = true;
        liveSubmit.textContent = '已受理';
        const state = envState();
        if (state) state.needsReload = true;
      });
      fields.create.appendChild(message);
      fields.create.appendChild(submit);
    }

    function publishQueueSnapshot() {
      if (!environment || !inspirationAvailable()) return null;
      const state = envState();
      if (!state) return null;
      if (!publishQueueAvailable()) return { kind: 'unsupported', envId: environment.envId };
      return {
        envId: environment.envId,
        kind: state.publishQueue.kind,
        data: state.publishQueue.data,
        error: state.publishQueue.error,
        stale: state.publishQueue.stale,
        refreshing: state.publishQueue.refreshing,
        feedback: state.queueFeedback,
      };
    }

    function notifyPublishQueueChange() {
      root.dispatchEvent(new global.CustomEvent('publish-queue:update', { detail: publishQueueSnapshot() }));
    }

    function publishQueueFailureMessage(response) {
      const reason = response?.reason || response?.error;
      if (reason === 'version_conflict') return '任务状态已经变化，已为你刷新当前队列。';
      if (reason === 'task_cancel_pending') return '这条任务已经在取消中，无需重复操作。';
      if (reason === 'task_not_cancellable') return '这条任务已经进入下一阶段，不能再从队列取消。';
      if (reason === 'publish_queue_unavailable') return '发布进度暂时不可用，请稍后重试。';
      if (reason === 'unsupported_platform') return '当前环境不是小红书，未读取发布队列。';
      return rejectionMessage(reason, response?.error);
    }

    function renderQueueState(title, detail, retry) {
      fields.queueContent.replaceChildren();
      const block = createElement(document, 'div', 'cw-state publish-queue-state');
      block.appendChild(createElement(document, 'span', 'publish-queue-state-mark', '!'));
      block.appendChild(createElement(document, 'strong', '', title));
      block.appendChild(createElement(document, 'span', '', detail));
      if (retry) {
        const button = createElement(document, 'button', 'cw-button secondary', '重新读取');
        button.type = 'button';
        button.addEventListener('click', () => { void loadPublishQueue(true); });
        block.appendChild(button);
      }
      fields.queueContent.appendChild(block);
    }

    function renderQueueStages(parent, stages) {
      const rail = createElement(document, 'div', 'publish-queue-stages');
      rail.setAttribute('role', 'list');
      rail.setAttribute('aria-label', '发布进度');
      stages.forEach((stage) => {
        const item = createElement(document, 'div', `publish-queue-stage is-${stage.state}`);
        item.setAttribute('role', 'listitem');
        const dot = createElement(document, 'span', 'publish-queue-stage-dot');
        dot.setAttribute('aria-hidden', 'true');
        item.appendChild(dot);
        const copy = createElement(document, 'div', 'publish-queue-stage-copy');
        copy.appendChild(createElement(document, 'strong', '', stage.label));
        const progress = stage.progress
          ? ` · ${Math.max(0, stage.progress.current)}/${Math.max(0, stage.progress.total)}`
          : '';
        const statusText = `${stage.summary.replace(`${stage.label}：`, '')}${progress}`;
        copy.appendChild(createElement(document, 'span', '', statusText));
        item.setAttribute('aria-label', `${stage.label}，${statusText}`);
        item.appendChild(copy);
        rail.appendChild(item);
      });
      parent.appendChild(rail);
    }

    function renderJourneyCard(journey, recent = false) {
      const card = createElement(document, 'article', `publish-queue-card journey status-${journey.status}`);
      const head = createElement(document, 'div', 'publish-queue-card-head');
      const copy = createElement(document, 'div');
      copy.appendChild(createElement(document, 'span', 'publish-queue-badge', journey.statusLabel));
      copy.appendChild(createElement(document, 'h3', '', journey.title || '未命名笔记'));
      const meta = journey.sourceTitle
        ? `参考「${journey.sourceTitle}」 · ${relativeDate(journey.startedAt)}`
        : relativeDate(journey.startedAt);
      copy.appendChild(createElement(document, 'p', '', meta));
      head.appendChild(copy);
      if (!recent && journey.status === 'waiting_approval' && Number.isInteger(journey.recordId)) {
        const review = createElement(document, 'button', 'cw-button primary compact', '审核稿件');
        review.type = 'button';
        review.addEventListener('click', () => {
          root.dispatchEvent(new global.CustomEvent('publish-queue:review', { detail: { recordId: journey.recordId } }));
        });
        head.appendChild(review);
      }
      card.appendChild(head);
      renderQueueStages(card, journey.stages);
      return card;
    }

    function openQueueCancelDialog(task) {
      if (!task || task.cancelRequested || !environment) return;
      queueCancelContext = {
        envId: environment.envId,
        taskId: task.id,
        version: task.version,
        title: task.title,
      };
      fields.queueCancelTitle.textContent = `确定取消「${task.title}」？`;
      fields.queueCancelDetail.textContent = `只会取消这条${task.action}任务，不影响当前账号的其它内容。`;
      fields.queueCancelSubmit.disabled = false;
      fields.queueCancelSubmit.textContent = '确认取消任务';
      if (typeof fields.queueCancelDialog.showModal === 'function') {
        if (!fields.queueCancelDialog.open) fields.queueCancelDialog.showModal();
      } else {
        fields.queueCancelDialog.setAttribute('open', '');
      }
    }

    function closeQueueCancelDialog() {
      queueCancelContext = null;
      if (!fields.queueCancelDialog) return;
      if (typeof fields.queueCancelDialog.close === 'function' && fields.queueCancelDialog.open) {
        fields.queueCancelDialog.close();
      } else {
        fields.queueCancelDialog.removeAttribute('open');
      }
    }

    function renderTaskCard(task) {
      const state = envState();
      const busy = state?.queueCancelBusyId === task.id;
      const card = createElement(document, 'article', `publish-queue-card task status-${task.status}`);
      const head = createElement(document, 'div', 'publish-queue-card-head');
      const copy = createElement(document, 'div');
      copy.appendChild(createElement(document, 'span', `publish-queue-badge ${task.cancelRequested ? 'stopping' : ''}`, task.statusLabel));
      copy.appendChild(createElement(document, 'h3', '', task.title || task.action));
      copy.appendChild(createElement(
        document,
        'p',
        '',
        task.status === 'queued'
          ? `尚未进入创作流程 · ${relativeDate(task.createdAt)}`
          : task.status === 'planning'
            ? '正在准备所需素材与执行条件'
            : '暂未满足安全执行条件',
      ));
      head.appendChild(copy);
      if (!task.cancelRequested) {
        const cancel = createElement(document, 'button', 'cw-button danger compact', busy ? '正在取消…' : '取消任务');
        cancel.type = 'button';
        cancel.disabled = busy;
        cancel.dataset.queueTaskId = task.id;
        cancel.addEventListener('click', () => openQueueCancelDialog(task));
        head.appendChild(cancel);
      }
      card.appendChild(head);
      if (task.cancelRequested) {
        card.appendChild(createElement(document, 'div', 'publish-queue-safe-stop', '取消请求已送达，将在安全边界停止；这里暂不宣称任务已经停止。'));
      }
      return card;
    }

    function appendQueueSection(parent, kicker, title, items, renderItem, emptyText) {
      const section = createElement(document, 'section', 'publish-queue-section');
      const header = createElement(document, 'header', 'publish-queue-section-head');
      const copy = createElement(document, 'div');
      copy.appendChild(createElement(document, 'span', 'cw-kicker', kicker));
      copy.appendChild(createElement(document, 'h2', '', title));
      header.appendChild(copy);
      header.appendChild(createElement(document, 'span', 'publish-queue-section-count', String(items.length)));
      section.appendChild(header);
      if (items.length === 0) {
        section.appendChild(createElement(document, 'p', 'publish-queue-section-empty', emptyText));
      } else {
        const list = createElement(document, 'div', 'publish-queue-list');
        items.forEach((item) => list.appendChild(renderItem(item)));
        section.appendChild(list);
      }
      parent.appendChild(section);
    }

    function renderPublishQueue() {
      if (!fields.queueContent) return;
      const state = envState();
      if (!state || !publishQueueAvailable()) {
        renderQueueState('当前环境没有发布队列', '发布队列只在已识别的小红书环境中提供。', false);
        return;
      }
      const queue = state.publishQueue;
      fields.queueContent.setAttribute('aria-busy', queue.kind === 'loading' || queue.refreshing ? 'true' : 'false');
      if (!queue.data && queue.kind === 'loading') {
        renderQueueState('正在整理发布进度', '从 Cloud 读取当前账号的排队、创作和发布真态。', false);
        return;
      }
      if (!queue.data && queue.kind === 'error') {
        renderQueueState('暂时无法读取发布进度', queue.error || '当前不会把未知状态显示成空队列。', true);
        return;
      }
      if (!queue.data) {
        renderQueueState('发布进度尚未读取', '点击重新读取当前账号的发布队列。', true);
        return;
      }

      const data = queue.data;
      fields.queueContent.replaceChildren();
      const hero = createElement(document, 'section', 'publish-queue-hero');
      const heroCopy = createElement(document, 'div', 'publish-queue-hero-copy');
      heroCopy.appendChild(createElement(document, 'span', 'cw-kicker', '当前账号'));
      heroCopy.appendChild(createElement(
        document,
        'h2',
        '',
        data.summary.inProgress > 0 ? `${data.summary.inProgress} 条内容正在路上` : '目前没有进行中的内容',
      ));
      heroCopy.appendChild(createElement(
        document,
        'p',
        '',
        data.summary.waitingForYou > 0
          ? `其中 ${data.summary.waitingForYou} 条正在等你确认。`
          : data.summary.inProgress > 0
            ? 'AI 正在处理，你可以离开此页，进度会继续。'
            : '最近结果仍保留在下方，方便核对。',
      ));
      hero.appendChild(heroCopy);
      const metrics = createElement(document, 'div', 'publish-queue-metrics');
      [
        ['进行中', data.summary.inProgress],
        ['待你确认', data.summary.waitingForYou],
        ['可取消', data.summary.cancellable],
      ].forEach(([label, value]) => {
        const metric = createElement(document, 'div', 'publish-queue-metric');
        metric.appendChild(createElement(document, 'strong', '', String(value)));
        metric.appendChild(createElement(document, 'span', '', label));
        metrics.appendChild(metric);
      });
      hero.appendChild(metrics);
      fields.queueContent.appendChild(hero);

      if (state.queueFeedback) {
        const feedback = createElement(document, 'div', `publish-queue-feedback ${state.queueFeedback.kind}`);
        feedback.setAttribute('role', state.queueFeedback.kind === 'error' ? 'alert' : 'status');
        feedback.textContent = state.queueFeedback.message;
        fields.queueContent.appendChild(feedback);
      }
      if (queue.stale || queue.refreshing) {
        fields.queueContent.appendChild(createElement(
          document,
          'div',
          `publish-queue-sync ${queue.stale ? 'stale' : ''}`,
          queue.stale ? `刷新未完成，正在保留 ${relativeDate(data.asOf)} 的已确认进度。` : '正在同步最新进度…',
        ));
      }

      const waiting = data.active.filter((journey) => journey.status === 'waiting_approval');
      const processing = data.active.filter((journey) => journey.status !== 'waiting_approval');
      appendQueueSection(
        fields.queueContent,
        '需要你处理',
        '待确认稿件',
        waiting,
        (journey) => renderJourneyCard(journey, false),
        '现在没有等待你确认的稿件。',
      );

      const systemSection = createElement(document, 'section', 'publish-queue-section');
      const systemHead = createElement(document, 'header', 'publish-queue-section-head');
      const systemCopy = createElement(document, 'div');
      systemCopy.appendChild(createElement(document, 'span', 'cw-kicker', '系统处理中'));
      systemCopy.appendChild(createElement(document, 'h2', '', '排队与创作'));
      systemHead.appendChild(systemCopy);
      systemHead.appendChild(createElement(document, 'span', 'publish-queue-section-count', String(processing.length + data.tasks.length)));
      systemSection.appendChild(systemHead);
      const systemList = createElement(document, 'div', 'publish-queue-list');
      processing.forEach((journey) => systemList.appendChild(renderJourneyCard(journey, false)));
      data.tasks.forEach((task) => systemList.appendChild(renderTaskCard(task)));
      if (systemList.childElementCount === 0) {
        systemSection.appendChild(createElement(document, 'p', 'publish-queue-section-empty', '现在没有排队或创作中的任务。'));
      } else {
        systemSection.appendChild(systemList);
      }
      fields.queueContent.appendChild(systemSection);

      appendQueueSection(
        fields.queueContent,
        '最近完成',
        '发布结果',
        data.recent,
        (journey) => renderJourneyCard(journey, true),
        '暂时没有可以核对的最近结果。',
      );
    }

    async function loadPublishQueue(force = false) {
      const state = envState();
      if (!state || !publishQueueAvailable()) return;
      const existing = state.publishQueue;
      if (existing.kind === 'loading' || existing.refreshing) return;
      if (!force && existing.data && Date.now() - Number(existing.requestedAt || 0) < 5_000) return;
      const capturedEnvId = environment.envId;
      const capturedEpoch = ++queueEpoch;
      state.publishQueue = existing.data
        ? { ...existing, refreshing: true, requestedAt: Date.now() }
        : { kind: 'loading', data: null, error: null, stale: false, refreshing: false, requestedAt: Date.now() };
      if (currentPage === 'queue') renderPublishQueue();
      notifyPublishQueueChange();
      let response;
      try {
        response = await api.publishQueueGet(capturedEnvId);
      } catch {
        response = { ok: false, error: 'request_failed' };
      }
      if (capturedEpoch !== queueEpoch || environment?.envId !== capturedEnvId) return;
      const normalized = normalizePublishQueueResponse(response);
      if (normalized) {
        state.publishQueue = {
          kind: 'ok', data: normalized, error: null, stale: false, refreshing: false, requestedAt: Date.now(),
        };
      } else if (existing.data) {
        state.publishQueue = {
          ...existing,
          kind: 'ok',
          stale: true,
          refreshing: false,
          error: publishQueueFailureMessage(response),
          requestedAt: Date.now(),
        };
      } else {
        state.publishQueue = {
          kind: 'error', data: null, error: publishQueueFailureMessage(response), stale: false,
          refreshing: false, requestedAt: Date.now(),
        };
      }
      if (currentPage === 'queue') renderPublishQueue();
      notifyPublishQueueChange();
      schedulePublishQueuePoll();
    }

    function schedulePublishQueuePoll() {
      if (queuePollTimer) global.clearTimeout(queuePollTimer);
      queuePollTimer = null;
      if (!publishQueueAvailable()) return;
      queuePollTimer = global.setTimeout(() => {
        queuePollTimer = null;
        void loadPublishQueue(true);
      }, PUBLISH_QUEUE_POLL_MS);
    }

    function openPublishQueue() {
      if (!environment || !publishQueueAvailable()) return;
      if (!visible()) {
        captureSourceWorkspace();
        setWorkspaceVisible(true);
        backStack = ['home'];
      } else if (currentPage !== 'queue') {
        backStack.push(currentPage);
      }
      showPage('queue', false);
      renderPublishQueue();
      void loadPublishQueue(true);
      schedulePublishQueuePoll();
    }

    async function confirmQueueCancellation() {
      const context = queueCancelContext;
      const state = envState();
      if (!context || !state || !environment || environment.envId !== context.envId
          || typeof api.publishQueueCancel !== 'function') return;
      const liveTask = state.publishQueue.data?.tasks.find((task) => task.id === context.taskId);
      if (!liveTask || liveTask.version !== context.version || liveTask.cancelRequested) {
        closeQueueCancelDialog();
        state.queueFeedback = { kind: 'error', message: '任务状态已经变化，已为你刷新当前队列。' };
        renderPublishQueue();
        void loadPublishQueue(true);
        return;
      }
      fields.queueCancelSubmit.disabled = true;
      fields.queueCancelSubmit.textContent = '正在取消…';
      state.queueCancelBusyId = context.taskId;
      renderPublishQueue();
      let response;
      try {
        response = await api.publishQueueCancel(context.envId, context.taskId, context.version);
      } catch {
        response = { ok: false, error: 'request_failed' };
      }
      state.queueCancelBusyId = null;
      if (!environment || environment.envId !== context.envId) return;
      const receipt = response?.ok && response.data && response.data.data;
      if (receipt && receipt.id === context.taskId && typeof receipt.terminal === 'boolean'
          && typeof receipt.cancelRequested === 'boolean') {
        state.queueFeedback = {
          kind: 'success',
          message: receipt.terminal
            ? `「${context.title}」已取消。`
            : `「${context.title}」正在取消，将在安全边界停止。`,
        };
      } else {
        state.queueFeedback = { kind: 'error', message: publishQueueFailureMessage(response) };
      }
      const refreshForConflict = response?.reason === 'version_conflict' || response?.error === 'version_conflict';
      closeQueueCancelDialog();
      renderPublishQueue();
      await loadPublishQueue(true);
      if (refreshForConflict) renderPublishQueue();
    }

    function openDraft() {
      if (!environment) return;
      if (!visible()) {
        captureSourceWorkspace();
        setWorkspaceVisible(true);
        backStack = ['home'];
      } else if (currentPage !== 'draft') {
        backStack.push(currentPage);
      }
      showPage('draft', false);
    }

    function setEnvironment(next) {
      const normalized = next && next.envId ? {
        envId: String(next.envId),
        label: String(next.label || '当前账号'),
        platform: String(next.platform || '').trim().toLowerCase(),
      } : null;
      const changed = normalized?.envId !== environment?.envId || normalized?.platform !== environment?.platform;
      if (changed && environment) {
        const previousState = states.get(environment.envId);
        if (previousState) {
          previousState.summaryLoading = false;
          previousState.summaryRequestId = 0;
        }
      }
      environment = normalized;
      updateEntry();
      if (!changed) {
        // 账号没变也必须重新主张自己的可见性：首页显隐是与互动工作区共享的状态，
        // 对方每次状态心跳都会归还首页；只有本工作区开着时再压一次，才不会被掀开。
        if (visible()) {
          setWorkspaceVisible(true);
          configureHeader(currentPage);
        }
        return;
      }
      requestEpoch += 1;
      summaryEpoch += 1;
      queueEpoch += 1;
      if (queuePollTimer) {
        global.clearTimeout(queuePollTimer);
        queuePollTimer = null;
      }
      closeQueueCancelDialog();
      fields.queueContent?.replaceChildren();
      currentDetail = null;
      createBusy = false;
      if (inspirationAvailable()) void loadSummary(true);
      if (publishQueueAvailable()) void loadPublishQueue(true);
      if (!visible()) return;
      if (currentPage === 'queue') {
        if (!publishQueueAvailable()) {
          close();
          return;
        }
        backStack = ['home'];
        showPage('queue', false);
        renderPublishQueue();
        schedulePublishQueuePoll();
        return;
      }
      if (!environment || currentPage === 'draft' || !inspirationAvailable()) {
        close();
        return;
      }
      backStack = ['home'];
      showPage('library', false);
      void loadList();
    }

    fields.entry?.addEventListener('click', openLibrary);
    fields.close?.addEventListener('click', handleCloseControl);
    fields.back?.addEventListener('click', goBack);
    fields.modeButtons.forEach((button) => button.addEventListener('click', () => {
      const state = envState();
      const mode = button.dataset.curatedMode;
      if (!state || (mode !== 'uncreated' && mode !== 'created' && mode !== 'all') || state.mode === mode) return;
      state.mode = mode;
      state.page = 1;
      state.scrollTop = 0;
      void loadList();
    }));
    fields.prev?.addEventListener('click', () => {
      const state = envState();
      if (!state || state.page <= 1) return;
      state.page -= 1;
      state.scrollTop = 0;
      void loadList();
    });
    fields.next?.addEventListener('click', () => {
      const state = envState();
      if (!state || state.page >= Math.ceil(state.total / PAGE_SIZE)) return;
      state.page += 1;
      state.scrollTop = 0;
      void loadList();
    });
    fields.queueCancelClose?.addEventListener('click', closeQueueCancelDialog);
    fields.queueCancelBack?.addEventListener('click', closeQueueCancelDialog);
    fields.queueCancelSubmit?.addEventListener('click', () => { void confirmQueueCancellation(); });
    fields.queueCancelDialog?.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeQueueCancelDialog();
    });
    global.addEventListener('focus', () => {
      if (publishQueueAvailable()) void loadPublishQueue(true);
    });

    updateEntry();
    return {
      setEnvironment,
      openLibrary,
      openPublishQueue,
      openDraft,
      close,
      goBack,
      publishQueueSnapshot,
      refreshPublishQueue: () => loadPublishQueue(true),
      isDraftOpen: () => visible() && currentPage === 'draft',
      currentPage: () => currentPage,
    };
  }

  global.ContentWorkspace = Object.freeze({ create });
})(window);
