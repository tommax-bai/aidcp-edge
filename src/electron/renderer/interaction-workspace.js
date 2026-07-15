(function initInteractionWorkspace(global) {
  'use strict';

  const TAB_QUERY = Object.freeze({
    pending: { state: 'pending' },
    comment: { channel: 'comment' },
    dm: { channel: 'dm' },
    replied: { state: 'sent' },
  });

  const TAB_LABEL = Object.freeze({
    pending: '待处理',
    comment: '评论',
    dm: '私信',
    replied: '已回复',
  });

  const JOB_LABEL = Object.freeze({
    new: ['等待生成', 'neutral'],
    classifying: ['正在判断', 'progress'],
    draft_ready: ['草稿已生成', 'neutral'],
    approval_required: ['等待批准', 'attention'],
    approved: ['已批准，待发送', 'progress'],
    queued: ['已进入发送队列', 'progress'],
    sending: ['正在等待平台确认', 'progress'],
    sent: ['平台已确认发送', 'success'],
    failed: ['发送未完成', 'danger'],
    ambiguous: ['平台结果待核验', 'attention'],
    ignored: ['已忽略', 'neutral'],
    escalated: ['已转人工', 'attention'],
  });

  const RISK_LABEL = Object.freeze({
    low: '低风险',
    medium: '中风险',
    high: '高风险',
    unknown: '待核验',
  });

  const RISK_REASON_LABEL = Object.freeze({
    order: '订单', refund: '退款', after_sales: '售后', pricing: '价格', promotion: '促销',
    inventory: '库存', shipping: '发货承诺', personal_data: '个人信息', complaint: '投诉',
    dispute: '争议', legal: '法律', medical: '医疗', safety: '安全', abuse: '辱骂骚扰',
    minor_safety: '未成年人安全', meaning_changed: '润色改变原意', introduced_claim: '润色引入新承诺',
    unknown: '原因待核验',
  });

  const TERMINAL_STATES = new Set(['sent', 'ignored', 'escalated']);
  const LOCKED_TEXT_STATES = new Set(['approved', 'queued', 'sending', 'sent', 'failed', 'ambiguous', 'ignored', 'escalated']);
  const WRITE_BLOCKING_AUTH = new Set(['login_required', 'reauth_required', 'challenge_required', 'disabled']);

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function safeText(value, fallback) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
  }

  function formatTime(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return '时间待确认';
    const diff = Date.now() - value;
    if (diff >= 0 && diff < 60_000) return '刚刚';
    if (diff >= 60_000 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    return new Date(value).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function makeRequestKey(prefix) {
    const uuid = global.crypto && typeof global.crypto.randomUUID === 'function'
      ? global.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${uuid}`;
  }

  function maskedId(value) {
    const text = String(value || '');
    if (!text) return '未返回';
    return text.length <= 6 ? `…${text.slice(-2)}` : `${text.slice(0, 2)}…${text.slice(-4)}`;
  }

  function asApiError(result) {
    const envelope = result && result.data && result.data.error;
    const error = new Error((envelope && envelope.message) || (result && result.error) || '请求未完成');
    error.code = (envelope && envelope.code) || (result && result.status === 0 ? 'INTERACTION_UPSTREAM_UNAVAILABLE' : 'INTERACTION_INTERNAL_ERROR');
    error.status = Number(result && result.status) || 0;
    error.retryable = Boolean(envelope && envelope.retryable);
    error.details = (envelope && envelope.details) || null;
    return error;
  }

  function friendlyError(error) {
    const code = error && error.code;
    if (code === 'INTERACTION_VERSION_CONFLICT' || code === 'INTERACTION_STATE_CONFLICT') return '这条互动已在别处更新。当前输入已保留，请重新加载详情后再操作。';
    if (code === 'INTERACTION_PERMISSION_DENIED') return '当前登录没有查看或操作这条互动的权限。';
    if (code === 'INTERACTION_NOT_FOUND' || code === 'INTERACTION_SCOPE_MISMATCH') return '这条互动已不可用，或不属于当前环境。';
    if (code === 'INTERACTION_CONFIG_MISSING') return '当前账号尚未发布回复配置。互动仍会保留，但暂时不能生成或发送。';
    if (code === 'INTERACTION_RATE_LIMITED' || code === 'WECHAT_RATE_LIMITED') return '平台正在限流，请稍后再试。';
    if (code === 'INTERACTION_AUTH_REQUIRED' || code === 'WECHAT_AUTH_REQUIRED') return '视频号登录已失效。历史仍可查看，重新登录后才能继续写操作。';
    if (code === 'WECHAT_CHALLENGE_REQUIRED') return '平台需要人工验证。请在原浏览器完成验证后再继续。';
    if (code === 'WECHAT_SCHEMA_CHANGED' || code === 'INTERACTION_FEATURE_DISABLED') return '接口能力已暂停，避免在字段变化时误操作。';
    if (code === 'INTERACTION_SEND_AMBIGUOUS') return '平台结果待核验，系统不会自动重复发送。';
    if (code === 'INTERACTION_UPSTREAM_UNAVAILABLE' || (error && error.status === 0)) return 'Cloud 暂时不可达。已保留当前可读内容，恢复后可局部刷新。';
    return safeText(error && error.message, '请求未完成，请稍后重试。');
  }

  function create(options) {
    const root = options && options.root;
    const legacyRoot = options && options.legacyRoot;
    const shell = options && options.shell;
    const api = options && options.api;
    if (!root || !legacyRoot || !shell || !api) return null;

    const dom = {
      title: root.querySelector('#iw-title'),
      summary: root.querySelector('#iw-summary'),
      browser: root.querySelector('#iw-browser'),
      reauth: root.querySelector('#iw-reauth'),
      sync: root.querySelector('#iw-sync'),
      syncStatus: root.querySelector('#iw-sync-status'),
      asOf: root.querySelector('#iw-as-of'),
      tabs: Array.from(root.querySelectorAll('[data-interaction-tab]')),
      search: root.querySelector('#iw-search'),
      listMeta: root.querySelector('#iw-list-meta'),
      list: root.querySelector('#iw-list'),
      listError: root.querySelector('#iw-list-error'),
      loadMore: root.querySelector('#iw-load-more'),
      detail: root.querySelector('#iw-detail'),
    };

    let epoch = 0;
    let listRequest = 0;
    let detailRequest = 0;
    let pollTimer = null;
    let active = false;
    let env = null;
    let state = freshState();

    function freshState() {
      return {
        tab: 'pending', search: '', items: [], nextCursor: null, listLoading: false, listAppending: false,
        listError: null, selectedThreadId: null, detail: null, detailLoading: false, detailError: null,
        auth: null, asOf: null, stale: false, actionBusy: null, actionError: null, actionNotice: null,
        draftText: '', draftDirty: false, syncBusy: false, pollCount: 0,
      };
    }

    function clearPoll() {
      if (pollTimer) global.clearTimeout(pollTimer);
      pollTimer = null;
    }

    function setVisible(show) {
      active = show;
      root.classList.toggle('hidden', !show);
      legacyRoot.classList.toggle('hidden', show);
      shell.classList.toggle('interaction-mode', show);
      root.setAttribute('aria-hidden', String(!show));
    }

    function selectedEnvKey() {
      return env && env.envKey;
    }

    function assertEnvelope(result, expectedEnvKey) {
      if (!result || !result.ok) throw asApiError(result);
      const envelope = result.data;
      if (!envelope || !envelope.data || envelope.data.envKey !== expectedEnvKey) {
        const error = new Error('响应环境与当前环境不一致，已丢弃。');
        error.code = 'INTERACTION_SCOPE_MISMATCH';
        throw error;
      }
      return envelope;
    }

    function isCurrent(capturedEpoch, envKey) {
      return active && capturedEpoch === epoch && selectedEnvKey() === envKey;
    }

    function filteredItems() {
      const query = state.search.trim().toLocaleLowerCase();
      if (!query) return state.items;
      return state.items.filter((item) => [item.participantName, item.previewText, item.sourceTitle]
        .some((value) => String(value || '').toLocaleLowerCase().includes(query)));
    }

    function authWriteBlocked() {
      const auth = state.auth;
      return !auth || auth.status !== 'active' || WRITE_BLOCKING_AUTH.has(auth.status);
    }

    function connectivityWriteBlocked() {
      return state.stale || !env || env.connectivity !== 'connected';
    }

    function writeBlocked() {
      return authWriteBlocked() || connectivityWriteBlocked();
    }

    function channelCapabilityBlocked(channel) {
      const caps = state.auth && state.auth.capabilities;
      if (!caps) return true;
      return channel === 'dm' ? !caps.dmSendText : !caps.commentsReply;
    }

    function renderOverview() {
      const auth = state.auth;
      const status = auth && auth.status;
      let title = '正在加载互动状态';
      let summary = '正在读取当前环境的评论和私信。';
      let tone = 'neutral';
      if (status === 'active') {
        const connectivityStale = connectivityWriteBlocked();
        title = connectivityStale ? '同步暂时中断' : '互动托管中';
        summary = connectivityStale ? '正在使用上次成功数据；Cloud 恢复后可局部刷新。' : '评论和私信通过接口同步，发送结果以平台确认状态为准。';
        tone = connectivityStale ? 'attention' : 'success';
      } else if (status === 'login_required') {
        title = '等待首次登录';
        summary = '已同步历史仍可阅读；完成视频号登录后才能生成或发送回复。';
        tone = 'attention';
      } else if (status === 'reauth_required') {
        title = '需要重新登录';
        summary = '登录已失效。历史内容保持可读，所有写操作已暂停。';
        tone = 'danger';
      } else if (status === 'challenge_required') {
        title = '需要完成平台验证';
        summary = '请在原浏览器处理验证。系统不会把远程请求受理当作验证完成。';
        tone = 'attention';
      } else if (status === 'degraded') {
        title = '同步暂时中断';
        summary = '网络或限流导致本次同步未完成，当前可读内容会继续保留。';
        tone = 'attention';
      } else if (status === 'disabled') {
        title = '接口能力已暂停';
        summary = '权限、配置或 schema 状态不确定，系统已停止相关写操作。';
        tone = 'danger';
      } else if (status === 'authenticating') {
        title = '正在确认登录';
        summary = '等待身份和只读能力探针完成。';
        tone = 'progress';
      }
      dom.title.textContent = title;
      dom.title.dataset.tone = tone;
      dom.summary.textContent = summary;

      const browserState = auth && auth.browserState;
      const browserText = browserState === 'closed' && status === 'active'
        ? '浏览器已关闭（正常）'
        : browserState === 'open' ? '浏览器已打开'
          : browserState === 'opening' ? '浏览器正在打开'
            : browserState === 'closing' ? '浏览器正在关闭'
              : browserState === 'unavailable' ? '浏览器暂不可用'
                : '浏览器状态待确认';
      dom.browser.textContent = browserText;
      dom.browser.className = `iw-status-chip ${browserState === 'unavailable' ? 'danger' : browserState === 'closed' && status === 'active' ? 'success' : 'neutral'}`;
      dom.syncStatus.textContent = state.listLoading
        ? '正在读取当前环境'
        : state.stale ? '使用上次成功数据'
          : state.actionNotice || (state.asOf ? '评论/私信同步正常' : '同步状态待确认');
      dom.asOf.textContent = state.asOf ? `数据时间 ${formatTime(state.asOf)}` : '—';
      const canReopen = ['login_required', 'reauth_required', 'challenge_required'].includes(status);
      dom.reauth.classList.toggle('hidden', !canReopen);
      dom.reauth.textContent = status === 'challenge_required' ? '打开浏览器处理验证' : status === 'login_required' ? '打开登录窗口' : '重新登录';
      dom.reauth.disabled = state.actionBusy === 'reauth';
      dom.sync.disabled = state.syncBusy || !active;
      dom.sync.textContent = state.syncBusy ? '已请求，等待同步' : '局部刷新';
    }

    function renderTabs() {
      for (const tab of dom.tabs) {
        const selected = tab.dataset.interactionTab === state.tab;
        tab.classList.toggle('active', selected);
        tab.setAttribute('aria-pressed', String(selected));
      }
    }

    function listEmptyCopy() {
      if (state.search.trim()) return '当前已加载内容中没有匹配项';
      if (state.tab === 'comment') return '当前没有评论互动';
      if (state.tab === 'dm') return '当前没有私信会话';
      if (state.tab === 'replied') return '当前没有已确认回复记录';
      return '当前没有待处理互动';
    }

    function renderList() {
      const focusedThreadId = dom.list.contains(global.document.activeElement)
        ? global.document.activeElement && global.document.activeElement.dataset.threadId
        : null;
      renderTabs();
      const items = filteredItems();
      dom.list.setAttribute('aria-busy', String(state.listLoading || state.listAppending));
      dom.listMeta.textContent = state.listLoading && state.items.length === 0
        ? '正在加载'
        : `${TAB_LABEL[state.tab]} · 已加载 ${state.items.length} 条${state.search.trim() ? ` · 匹配 ${items.length} 条` : ''}`;
      if (state.listLoading && state.items.length === 0) {
        dom.list.innerHTML = '<div class="iw-loading-state"><i></i><i></i><i></i><span>正在获取当前环境互动</span></div>';
      } else if (items.length === 0) {
        dom.list.innerHTML = `<div class="iw-empty-state compact"><span class="iw-empty-icon" aria-hidden="true">···</span><strong>${escapeHtml(listEmptyCopy())}</strong><span>${state.search.trim() ? '搜索只作用于当前环境已经加载的分页。' : '需要处理的新互动会出现在这里。'}</span></div>`;
      } else {
        dom.list.innerHTML = items.map((item) => {
          const selected = item.threadId === state.selectedThreadId;
          const job = JOB_LABEL[item.jobState] || [safeText(item.jobState, '状态待确认'), 'neutral'];
          const name = safeText(item.participantName, '未获取昵称');
          const preview = safeText(item.previewText, item.channel === 'dm' ? '暂不支持的私信类型' : '暂不支持的评论类型');
          const source = safeText(item.sourceTitle, item.channel === 'dm' ? '私信会话' : '未获取视频标题');
          return `<button class="iw-list-item${selected ? ' selected' : ''}" type="button" role="option" aria-selected="${String(selected)}" data-thread-id="${escapeHtml(item.threadId)}">
            <span class="iw-avatar" aria-hidden="true">${escapeHtml(name.slice(0, 1))}</span>
            <span class="iw-item-copy">
              <span class="iw-item-head"><strong>${escapeHtml(name)}</strong><time>${escapeHtml(formatTime(item.lastMessageAt))}</time></span>
              <span class="iw-item-preview">${escapeHtml(preview)}</span>
              <span class="iw-item-foot"><span>${item.channel === 'dm' ? '私信' : '评论'} · ${escapeHtml(source)}</span><em class="iw-badge ${job[1]}">${escapeHtml(job[0])}</em></span>
            </span>
          </button>`;
        }).join('');
      }
      dom.listError.textContent = state.listError ? friendlyError(state.listError) : '';
      dom.listError.classList.toggle('hidden', !state.listError);
      dom.loadMore.classList.toggle('hidden', !state.nextCursor);
      dom.loadMore.disabled = state.listAppending;
      dom.loadMore.textContent = state.listAppending ? '正在加载更多' : '加载更多';
      for (const button of root.querySelectorAll('[data-thread-id]')) {
        button.addEventListener('click', () => selectThread(button.dataset.threadId, true));
      }
      if (focusedThreadId) {
        const selectorId = global.CSS && global.CSS.escape
          ? global.CSS.escape(focusedThreadId)
          : focusedThreadId.replace(/["\\]/g, '\\$&');
        const nextFocused = dom.list.querySelector(`[data-thread-id="${selectorId}"]`);
        if (nextFocused) nextFocused.focus({ preventScroll: true });
      }
    }

    function renderMessages(detail) {
      const messages = Array.isArray(detail.messages) ? detail.messages : [];
      if (messages.length === 0) return '<div class="iw-empty-inline">暂无可读消息上下文</div>';
      return messages.map((message) => {
        const unknown = message.messageType !== 'text';
        const content = safeText(message.contentText, message.messageType === 'image' ? '图片消息（当前仅展示类型）' : '暂不支持的消息类型');
        return `<article class="iw-message ${message.direction === 'outbound' ? 'outbound' : 'inbound'}${unknown ? ' unknown' : ''}">
          <header><span>${message.direction === 'outbound' ? '当前账号' : '对方'}</span><time>${escapeHtml(formatTime(message.platformCreatedAt))}</time></header>
          <p>${escapeHtml(content)}</p>
        </article>`;
      }).join('');
    }

    function renderSendState(job, attempt) {
      if (!job) return '';
      const label = JOB_LABEL[job.state] || [safeText(job.state, '状态待确认'), 'neutral'];
      let detail = '';
      if (job.state === 'sent') {
        detail = `平台已确认${attempt && attempt.finishedAt ? ` · ${formatTime(attempt.finishedAt)}` : ''}${attempt && attempt.externalMessageId ? ` · 回执 ${maskedId(attempt.externalMessageId)}` : ''}`;
      } else if (job.state === 'ambiguous') {
        detail = '发送请求可能已经到达平台，但当前无法确认。系统不会自动重复发送。';
      } else if (job.state === 'queued') {
        detail = 'Cloud 已受理并进入发送队列；这还不等于平台发送完成。';
      } else if (job.state === 'sending') {
        detail = '已派发到 Edge，正在等待平台确认结果。';
      } else if (job.state === 'failed') {
        detail = '平台已明确拒绝或确认未发送，可查看原因后再决定下一步。';
      } else if (job.state === 'approved') {
        detail = '回复已批准，尚未提交到平台。';
      } else if (job.state === 'approval_required') {
        detail = '需要你确认最终文字后才能进入发送队列。';
      }
      return `<section class="iw-send-state ${label[1]}"><strong>${escapeHtml(label[0])}</strong><span>${escapeHtml(detail)}</span></section>`;
    }

    function actionButtonModel(job) {
      if (!job) return null;
      if (job.state === 'approval_required') return { action: 'approve', label: state.draftDirty ? '保存并批准' : '批准回复' };
      if (job.state === 'approved') return { action: 'send', label: '发送回复' };
      if (job.state === 'queued') return { action: '', label: '已进入发送队列', disabled: true };
      if (job.state === 'sending') return { action: '', label: '等待平台确认', disabled: true };
      if (job.state === 'ambiguous') return { action: '', label: '结果待核验', disabled: true };
      if (job.state === 'sent') return { action: '', label: '平台已确认', disabled: true };
      return null;
    }

    function renderDetail() {
      dom.detail.setAttribute('aria-busy', String(state.detailLoading));
      if (state.detailLoading && !state.detail) {
        dom.detail.innerHTML = '<div class="iw-loading-state detail"><i></i><i></i><i></i><span>正在加载消息上下文</span></div>';
        return;
      }
      if (!state.selectedThreadId || !state.detail) {
        const message = state.detailError ? friendlyError(state.detailError) : '选择一条互动查看详情';
        dom.detail.innerHTML = `<div class="iw-empty-state"><span class="iw-empty-icon" aria-hidden="true">···</span><strong>${escapeHtml(message)}</strong><span>${state.detailError ? '列表不会因此被清空，可选择其他互动或稍后重试。' : '消息上下文、回复依据和发送状态会显示在这里。'}</span></div>`;
        return;
      }

      const detail = state.detail;
      const thread = detail.thread;
      const job = detail.replyJob;
      const attempt = detail.sendAttempt;
      const participant = safeText(thread.participant && thread.participant.displayName, '未获取昵称');
      const source = safeText(thread.sourceTitle, thread.channel === 'dm' ? '私信会话' : '未获取视频标题');
      const templateId = job && job.template && job.template.templateId;
      const templateVersion = job && job.template && job.template.templateVersion;
      const renderedText = safeText(job && job.renderedText, '未生成模板原文');
      const polishedText = safeText(job && job.polishedText, '本次未使用 AI 润色');
      const changed = Boolean(job && job.polishedText && job.renderedText !== job.polishedText);
      const risk = job ? RISK_LABEL[job.riskLevel] || '待核验' : '未评估';
      const riskReasons = job && Array.isArray(job.riskReasons) && job.riskReasons.length > 0
        ? job.riskReasons.map((reason) => RISK_REASON_LABEL[reason] || reason).join('、')
        : '未发现额外风险标签';
      const textStateLocked = !job || LOCKED_TEXT_STATES.has(job.state);
      const textLocked = textStateLocked || writeBlocked();
      const capabilityBlocked = channelCapabilityBlocked(thread.channel);
      const primary = actionButtonModel(job);
      const busy = Boolean(state.actionBusy);

      dom.detail.innerHTML = `<div class="iw-detail-scroll">
        <header class="iw-detail-head">
          <span class="iw-avatar large" aria-hidden="true">${escapeHtml(participant.slice(0, 1))}</span>
          <div><h2>${escapeHtml(participant)}</h2><p>${thread.channel === 'dm' ? '私信会话' : '公开视频评论'} · ${escapeHtml(formatTime(thread.lastMessageAt))}</p></div>
          <button class="iw-button ghost" type="button" data-iw-action="refresh-detail">刷新状态</button>
        </header>
        <section class="iw-source-card">
          <span class="iw-source-icon" aria-hidden="true">${thread.channel === 'dm' ? '信' : '视'}</span>
          <div><span>${thread.channel === 'dm' ? '会话来源' : '关联视频'}</span><strong>${escapeHtml(source)}</strong><small>最近同步 ${escapeHtml(formatTime(thread.lastSyncedAt))}</small></div>
        </section>
        <section class="iw-thread" aria-label="消息上下文">${renderMessages(detail)}${detail.nextCursor ? '<button class="iw-button ghost" type="button" data-iw-action="load-messages">加载更早消息</button>' : ''}</section>
        ${renderSendState(job, attempt)}
        ${job ? `<section class="iw-reply-card">
          <header><div><span class="iw-kicker">回复依据</span><h3>最终回复</h3></div><em class="iw-badge ${job.riskLevel === 'high' ? 'danger' : job.riskLevel === 'unknown' ? 'attention' : 'neutral'}">${escapeHtml(risk)}</em></header>
          <div class="iw-reply-meta"><span>模板 ${escapeHtml(templateId ? `${templateId} · v${templateVersion || '?'}` : '未绑定')}</span><span>配置版本 ${escapeHtml(job.configVersion || '待确认')}</span></div>
          <div class="iw-diff-grid">
            <div><span>模板原文</span><p>${escapeHtml(renderedText)}</p></div>
            <div><span>AI 润色${changed ? ' · 已调整措辞' : ' · 未改变内容'}</span><p>${escapeHtml(polishedText)}</p></div>
          </div>
          <label class="iw-editor"><span>可编辑的最终文字</span><textarea id="iw-final-text" rows="4" maxlength="4000" ${textLocked ? 'disabled' : ''}>${escapeHtml(state.draftText)}</textarea><small id="iw-draft-count">${state.draftText.length}/4000${state.draftDirty ? ' · 尚未保存' : ''}</small></label>
          <div class="iw-risk-card ${job.riskLevel === 'high' ? 'danger' : job.riskLevel === 'unknown' ? 'attention' : 'neutral'}"><strong>风险检查：${escapeHtml(risk)}</strong><span>${escapeHtml(riskReasons)}</span></div>
          ${authWriteBlocked() ? '<div class="iw-write-block">登录或能力状态未就绪，历史保持可读，写操作已禁用。</div>' : connectivityWriteBlocked() ? '<div class="iw-write-block">Cloud 离线或当前数据已过期，历史保持可读；刷新成功前写操作已禁用。</div>' : capabilityBlocked ? '<div class="iw-write-block">当前账号没有这个渠道的发送能力，写操作已禁用。</div>' : ''}
          ${state.actionError ? `<div class="iw-action-error" role="alert">${escapeHtml(friendlyError(state.actionError))}${state.actionError.code === 'INTERACTION_VERSION_CONFLICT' || state.actionError.code === 'INTERACTION_STATE_CONFLICT' ? '<button class="iw-button ghost" type="button" data-iw-action="refresh-detail">重新加载详情</button>' : ''}</div>` : ''}
          ${state.actionNotice ? `<div class="iw-action-notice" role="status">${escapeHtml(state.actionNotice)}</div>` : ''}
          <footer class="iw-reply-actions">
            <div>
              <button class="iw-button ghost" type="button" data-iw-action="ignore" ${busy || TERMINAL_STATES.has(job.state) || writeBlocked() ? 'disabled' : ''}>忽略</button>
              <button class="iw-button ghost" type="button" data-iw-action="escalate" ${busy || TERMINAL_STATES.has(job.state) || writeBlocked() ? 'disabled' : ''}>转人工</button>
              <button class="iw-button secondary" type="button" data-iw-action="regenerate" ${busy || TERMINAL_STATES.has(job.state) || writeBlocked() ? 'disabled' : ''}>${state.actionBusy === 'regenerate' ? '重新生成中' : '重新生成'}</button>
            </div>
            <div>
              ${!textStateLocked ? `<button class="iw-button secondary" type="button" data-iw-action="save" ${busy || !state.draftDirty || writeBlocked() ? 'disabled' : ''}>${state.actionBusy === 'save' ? '保存中' : '保存修改'}</button>` : ''}
              ${primary ? `<button class="iw-button primary" type="button" data-iw-action="${primary.action}" ${busy || primary.disabled || writeBlocked() || capabilityBlocked ? 'disabled' : ''}>${state.actionBusy === primary.action ? '处理中' : primary.label}</button>` : ''}
            </div>
          </footer>
        </section>` : '<section class="iw-empty-inline">这条互动尚未生成回复任务，可保留查看并等待 Cloud 工作流。</section>'}
      </div>`;

      const textarea = dom.detail.querySelector('#iw-final-text');
      if (textarea) {
        textarea.addEventListener('input', () => {
          state.draftText = textarea.value;
          state.draftDirty = textarea.value !== safeText(state.detail.replyJob && state.detail.replyJob.finalText, '');
          const count = dom.detail.querySelector('#iw-draft-count');
          if (count) count.textContent = `${state.draftText.length}/4000${state.draftDirty ? ' · 尚未保存' : ''}`;
          const save = dom.detail.querySelector('[data-iw-action="save"]');
          if (save) save.disabled = !state.draftDirty || Boolean(state.actionBusy) || writeBlocked();
          const approve = dom.detail.querySelector('[data-iw-action="approve"]');
          if (approve) approve.textContent = state.draftDirty ? '保存并批准' : '批准回复';
        });
      }
      for (const button of dom.detail.querySelectorAll('[data-iw-action]')) {
        button.addEventListener('click', () => handleDetailAction(button.dataset.iwAction));
      }
    }

    function renderAll() {
      if (!active) return;
      renderOverview();
      renderList();
      renderDetail();
    }

    async function loadList({ append = false, preserveSelection = false } = {}) {
      if (!active || !env) return;
      const capturedEpoch = epoch;
      const envKey = env.envKey;
      const request = ++listRequest;
      if (append) state.listAppending = true;
      else {
        state.listLoading = true;
        state.listError = null;
        if (!preserveSelection) {
          state.selectedThreadId = null;
          state.detail = null;
          state.detailError = null;
        }
      }
      renderAll();
      try {
        const response = await api.interactionList({
          envKey,
          ...TAB_QUERY[state.tab],
          cursor: append ? state.nextCursor : null,
          limit: 30,
        });
        if (!isCurrent(capturedEpoch, envKey) || request !== listRequest) return;
        const envelope = assertEnvelope(response, envKey);
        const incoming = Array.isArray(envelope.data.items) ? envelope.data.items : [];
        if (append) {
          const seen = new Set(state.items.map((item) => `${item.threadId}:${item.messageId}`));
          state.items = state.items.concat(incoming.filter((item) => !seen.has(`${item.threadId}:${item.messageId}`)));
        } else {
          state.items = incoming;
        }
        state.nextCursor = envelope.data.nextCursor || null;
        state.auth = envelope.data.auth;
        state.asOf = envelope.meta && envelope.meta.asOf;
        state.listError = null;
        state.stale = false;
        const visible = filteredItems();
        if (!state.selectedThreadId && visible[0]) {
          state.selectedThreadId = visible[0].threadId;
          void loadDetail(visible[0].threadId);
        } else if (state.selectedThreadId && !state.items.some((item) => item.threadId === state.selectedThreadId)) {
          state.selectedThreadId = visible[0] ? visible[0].threadId : null;
          state.detail = null;
          if (state.selectedThreadId) void loadDetail(state.selectedThreadId);
        }
      } catch (error) {
        if (!isCurrent(capturedEpoch, envKey) || request !== listRequest) return;
        state.listError = error;
        state.stale = Boolean(state.items.length || state.detail);
      } finally {
        if (isCurrent(capturedEpoch, envKey) && request === listRequest) {
          state.listLoading = false;
          state.listAppending = false;
          renderAll();
        }
      }
    }

    async function loadDetail(threadId, { cursor = null, append = false, silent = false } = {}) {
      if (!active || !env || !threadId) return;
      const capturedEpoch = epoch;
      const envKey = env.envKey;
      const request = ++detailRequest;
      if (!silent) state.detailLoading = true;
      state.detailError = null;
      if (!append && !silent && (!state.detail || state.detail.thread.id !== threadId)) state.detail = null;
      renderDetail();
      try {
        const response = await api.interactionDetail({ envKey, threadId, cursor, limit: 50 });
        if (!isCurrent(capturedEpoch, envKey) || request !== detailRequest || state.selectedThreadId !== threadId) return;
        const envelope = assertEnvelope(response, envKey);
        if (!envelope.data.thread || envelope.data.thread.id !== threadId || envelope.data.thread.envKey !== envKey) {
          const error = new Error('详情 scope 与当前环境不一致，已丢弃。');
          error.code = 'INTERACTION_SCOPE_MISMATCH';
          throw error;
        }
        if (append && state.detail && state.detail.thread.id === threadId) {
          const incomingIds = new Set(envelope.data.messages.map((message) => message.id));
          envelope.data.messages = envelope.data.messages.concat(state.detail.messages.filter((message) => !incomingIds.has(message.id)));
        }
        state.detail = envelope.data;
        state.auth = envelope.data.auth;
        state.asOf = envelope.meta && envelope.meta.asOf;
        if (env && env.connectivity === 'connected') state.stale = false;
        state.detailError = null;
        state.draftText = safeText(envelope.data.replyJob && envelope.data.replyJob.finalText, '');
        state.draftDirty = false;
        state.actionError = null;
        const jobState = envelope.data.replyJob && envelope.data.replyJob.state;
        if (jobState === 'queued' || jobState === 'sending') schedulePoll(threadId, capturedEpoch);
        else {
          state.pollCount = 0;
          clearPoll();
        }
      } catch (error) {
        if (!isCurrent(capturedEpoch, envKey) || request !== detailRequest) return;
        state.detailError = error;
        if (state.detail) state.stale = true;
      } finally {
        if (isCurrent(capturedEpoch, envKey) && request === detailRequest) {
          state.detailLoading = false;
          renderAll();
        }
      }
    }

    function schedulePoll(threadId, capturedEpoch) {
      clearPoll();
      if (state.pollCount >= 12) return;
      state.pollCount += 1;
      pollTimer = global.setTimeout(() => {
        if (capturedEpoch === epoch && state.selectedThreadId === threadId) void loadDetail(threadId, { silent: true });
      }, 1500);
    }

    function selectThread(threadId, focusDetail) {
      if (!threadId || state.selectedThreadId === threadId) return;
      clearPoll();
      state.selectedThreadId = threadId;
      state.detail = null;
      state.detailError = null;
      state.actionError = null;
      state.actionNotice = null;
      state.pollCount = 0;
      renderList();
      void loadDetail(threadId);
      if (focusDetail) dom.detail.setAttribute('tabindex', '-1');
    }

    function updateListJob(job) {
      if (!job) return;
      state.items = state.items.map((item) => item.messageId === job.inboundMessageId
        ? { ...item, jobState: job.state, jobVersion: job.version }
        : item);
    }

    async function requestJobAction(kind, expectedVersion) {
      const envKey = env.envKey;
      const job = state.detail.replyJob;
      const message = state.items.find((item) => item.threadId === state.selectedThreadId);
      const payload = { envKey, expectedVersion };
      if (kind === 'save') return api.interactionUpdateDraft({ ...payload, jobId: job.id, finalText: state.draftText });
      if (kind === 'approve') return api.interactionApprove({ ...payload, jobId: job.id });
      if (kind === 'send') return api.interactionSend({ ...payload, jobId: job.id, idempotencyKey: makeRequestKey('interaction-send') });
      if (kind === 'regenerate') return api.interactionRegenerate({ ...payload, jobId: job.id });
      if (kind === 'ignore') return api.interactionIgnore({ ...payload, messageId: message && message.messageId });
      if (kind === 'escalate') return api.interactionEscalate({ ...payload, messageId: message && message.messageId, reason: 'operator_requested_from_edge_client' });
      throw new Error('不支持的互动动作');
    }

    async function handleDetailAction(kind) {
      if (!active || !env) return;
      if (kind === 'refresh-detail') {
        state.actionError = null;
        state.actionNotice = null;
        await loadDetail(state.selectedThreadId);
        return;
      }
      if (kind === 'load-messages') {
        await loadDetail(state.selectedThreadId, { cursor: state.detail.nextCursor, append: true });
        return;
      }
      const job = state.detail && state.detail.replyJob;
      if (!job || state.actionBusy || writeBlocked() || channelCapabilityBlocked(state.detail.thread.channel)) return;
      if (kind === 'save' && !state.draftDirty) return;
      const capturedEpoch = epoch;
      const envKey = env.envKey;
      state.actionBusy = kind;
      state.actionError = null;
      state.actionNotice = null;
      renderAll();
      try {
        let currentJob = job;
        if (kind === 'approve' && state.draftDirty) {
          const draftEnvelope = assertEnvelope(await requestJobAction('save', currentJob.version), envKey);
          currentJob = draftEnvelope.data.job;
          state.detail.replyJob = currentJob;
          state.draftDirty = false;
        }
        const response = await requestJobAction(kind, currentJob.version);
        if (!isCurrent(capturedEpoch, envKey)) return;
        const envelope = assertEnvelope(response, envKey);
        state.detail.replyJob = envelope.data.job;
        state.draftText = safeText(envelope.data.job.finalText, state.draftText);
        state.draftDirty = false;
        updateListJob(envelope.data.job);
        state.actionNotice = kind === 'send'
          ? envelope.data.job.state === 'sent' ? '平台已确认发送。' : '已提交到发送流程，正在等待平台确认。'
          : kind === 'approve' ? '回复已批准，尚未发送。'
            : kind === 'save' ? '最终文字已保存。'
              : kind === 'regenerate' ? '已请求重新生成，当前状态以 Cloud 回包为准。'
                : kind === 'ignore' ? '这条互动已忽略。'
                  : '这条互动已转人工。';
        if (kind === 'ignore' || kind === 'escalate') void loadList({ preserveSelection: false });
        if (envelope.data.job.state === 'queued' || envelope.data.job.state === 'sending') schedulePoll(state.selectedThreadId, capturedEpoch);
      } catch (error) {
        if (!isCurrent(capturedEpoch, envKey)) return;
        state.actionError = error;
      } finally {
        if (isCurrent(capturedEpoch, envKey)) {
          state.actionBusy = null;
          renderAll();
        }
      }
    }

    async function syncCurrent() {
      if (!active || !env || state.syncBusy) return;
      const capturedEpoch = epoch;
      const envKey = env.envKey;
      state.syncBusy = true;
      state.actionNotice = null;
      renderOverview();
      try {
        const channel = state.tab === 'comment' || state.tab === 'dm' ? state.tab : null;
        const response = await api.interactionSync({
          envKey, channel, scopeExternalId: null, idempotencyKey: makeRequestKey('interaction-sync'),
        });
        if (!isCurrent(capturedEpoch, envKey)) return;
        assertEnvelope(response, envKey);
        state.actionNotice = 'Cloud 已受理同步请求，正在等待新数据。';
        global.setTimeout(() => {
          if (isCurrent(capturedEpoch, envKey)) void loadList({ preserveSelection: true });
        }, 750);
      } catch (error) {
        if (!isCurrent(capturedEpoch, envKey)) return;
        state.listError = error;
        state.stale = Boolean(state.items.length || state.detail);
      } finally {
        if (isCurrent(capturedEpoch, envKey)) {
          state.syncBusy = false;
          renderAll();
        }
      }
    }

    async function reopenAuth() {
      if (!active || !env || state.actionBusy) return;
      const capturedEpoch = epoch;
      const envKey = env.envKey;
      state.actionBusy = 'reauth';
      state.actionError = null;
      renderAll();
      try {
        const response = await api.interactionReopenAuth({ envKey, idempotencyKey: makeRequestKey('interaction-reauth') });
        if (!isCurrent(capturedEpoch, envKey)) return;
        assertEnvelope(response, envKey);
        state.actionNotice = '已请求打开原浏览器，仍需等待平台登录状态确认。';
      } catch (error) {
        if (!isCurrent(capturedEpoch, envKey)) return;
        state.actionError = error;
        state.actionNotice = friendlyError(error);
      } finally {
        if (isCurrent(capturedEpoch, envKey)) {
          state.actionBusy = null;
          renderAll();
        }
      }
    }

    function selectEnvironment(next) {
      const isWechat = next && next.platform === 'wechat_channels';
      if (!isWechat) {
        if (env && api.interactionCancelReads) void api.interactionCancelReads(env.envKey);
        epoch += 1;
        env = null;
        clearPoll();
        setVisible(false);
        return;
      }
      if (env && env.envKey === next.envKey && active) {
        const connectivityChanged = env.connectivity !== next.connectivity;
        env = { ...next };
        if (next.connectivity !== 'connected') state.stale = Boolean(state.items.length || state.detail || state.stale);
        if (connectivityChanged) renderAll();
        return;
      }
      if (env && api.interactionCancelReads) void api.interactionCancelReads(env.envKey);
      epoch += 1;
      env = { ...next };
      state = freshState();
      if (env.connectivity !== 'connected') state.stale = true;
      clearPoll();
      setVisible(true);
      renderAll();
      void loadList();
    }

    dom.tabs.forEach((tab) => tab.addEventListener('click', () => {
      const nextTab = tab.dataset.interactionTab;
      if (!TAB_QUERY[nextTab] || nextTab === state.tab) return;
      if (env && api.interactionCancelReads) void api.interactionCancelReads(env.envKey);
      listRequest += 1;
      detailRequest += 1;
      clearPoll();
      state.tab = nextTab;
      state.items = [];
      state.nextCursor = null;
      state.selectedThreadId = null;
      state.detail = null;
      state.detailError = null;
      state.listError = null;
      state.actionNotice = null;
      state.pollCount = 0;
      renderAll();
      void loadList();
    }));
    dom.search.addEventListener('input', () => {
      state.search = dom.search.value;
      const visible = filteredItems();
      if (state.selectedThreadId && !visible.some((item) => item.threadId === state.selectedThreadId)) {
        state.selectedThreadId = visible[0] ? visible[0].threadId : null;
        state.detail = null;
        if (state.selectedThreadId) void loadDetail(state.selectedThreadId);
      }
      renderList();
      renderDetail();
    });
    dom.list.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = filteredItems();
      if (items.length === 0) return;
      event.preventDefault();
      const index = Math.max(0, items.findIndex((item) => item.threadId === state.selectedThreadId));
      const nextIndex = event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
      selectThread(items[nextIndex].threadId, false);
      const button = dom.list.querySelector(`[data-thread-id="${global.CSS && global.CSS.escape ? global.CSS.escape(items[nextIndex].threadId) : items[nextIndex].threadId.replace(/["\\]/g, '\\$&')}"]`);
      if (button) button.focus();
    });
    dom.loadMore.addEventListener('click', () => void loadList({ append: true, preserveSelection: true }));
    dom.sync.addEventListener('click', () => void syncCurrent());
    dom.reauth.addEventListener('click', () => void reopenAuth());

    return { selectEnvironment, refresh: () => loadList({ preserveSelection: true }) };
  }

  global.InteractionWorkspace = Object.freeze({ create });
})(window);
