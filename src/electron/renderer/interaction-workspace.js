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
  const MAX_SYNC_CLOCK_SKEW_MS = 5 * 60_000;

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

  function exactKeys(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort();
    return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
  }

  function parseSyncEvidence(value) {
    if (!exactKeys(value, ['observedAt', 'receivedAt'])) return null;
    const observedAt = Number(value.observedAt);
    const receivedAt = Number(value.receivedAt);
    if (!Number.isInteger(observedAt) || observedAt <= 0 || !Number.isInteger(receivedAt) || receivedAt <= 0) return null;
    return { observedAt, receivedAt };
  }

  function parseSyncFreshness(value) {
    if (!exactKeys(value, ['comment', 'dm'])) return null;
    const comment = value.comment === null ? null : parseSyncEvidence(value.comment);
    const dm = value.dm === null ? null : parseSyncEvidence(value.dm);
    if ((value.comment !== null && !comment) || (value.dm !== null && !dm)) return null;
    return { comment, dm };
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
    const testResetRoot = options && options.testResetRoot;
    const onLifecycleAction = options && options.onLifecycleAction;
    const onLifecycleStatus = options && options.onLifecycleStatus;
    if (!root || !legacyRoot || !shell || !api) return null;

    const dom = {
      title: root.querySelector('#iw-title'),
      summary: root.querySelector('#iw-summary'),
      engineStatus: root.querySelector('#iw-engine-status'),
      authStatus: root.querySelector('#iw-auth-status'),
      browser: root.querySelector('#iw-browser'),
      browserHelp: root.querySelector('#iw-browser-help'),
      lifecycle: root.querySelector('#iw-lifecycle'),
      close: root.querySelector('#iw-close'),
      browserControl: root.querySelector('#iw-browser-control'),
      reauth: root.querySelector('#iw-reauth'),
      sync: root.querySelector('#iw-sync'),
      syncStatus: root.querySelector('#iw-sync-status'),
      syncTime: root.querySelector('#iw-as-of'),
      unreadBadge: root.querySelector('#iw-unread-badge'),
      readAll: root.querySelector('#iw-read-all'),
      readComment: root.querySelector('#iw-read-comment'),
      readDm: root.querySelector('#iw-read-dm'),
      readApply: root.querySelector('#iw-read-apply'),
      readCommentStatus: root.querySelector('#iw-read-comment-status'),
      readDmStatus: root.querySelector('#iw-read-dm-status'),
      readError: root.querySelector('#iw-read-error'),
      configStatus: root.querySelector('#iw-config-status'),
      configSummary: root.querySelector('#iw-config-summary'),
      configHelp: root.querySelector('#iw-config-help'),
      configGuidance: root.querySelector('#iw-config-guidance'),
      tabs: Array.from(root.querySelectorAll('[data-interaction-tab]')),
      tabsNav: root.querySelector('#iw-tabs'),
      search: root.querySelector('#iw-search'),
      listMeta: root.querySelector('#iw-list-meta'),
      list: root.querySelector('#iw-list'),
      listError: root.querySelector('#iw-list-error'),
      loadMore: root.querySelector('#iw-load-more'),
      detail: root.querySelector('#iw-detail'),
      testResetStatus: testResetRoot && testResetRoot.querySelector('#interaction-test-reset-status'),
      testResetButtons: testResetRoot ? Array.from(testResetRoot.querySelectorAll('[data-test-reset-channel]')) : [],
    };

    let epoch = 0;
    let listRequest = 0;
    let detailRequest = 0;
    let pollTimer = null;
    let listPollTimer = null;
    let active = false;
    let env = null;
    let state = freshState();
    const seenMessagesByEnv = new Map();
    const notifiedMessagesByEnv = new Map();
    const unreadMessagesByEnv = new Map();
    const baselineTabs = new Set();

    function freshState() {
      return {
        tab: 'pending', search: '', items: [], nextCursor: null, listLoading: false, listAppending: false,
        listError: null, selectedThreadId: null, detail: null, detailLoading: false, detailError: null,
        auth: null, syncFreshness: null, pendingSync: null, stale: false,
        actionBusy: null, actionError: null, actionNotice: null, localBrowserNotice: null,
        replyConfig: null, readControlsBusy: false, readControlsError: null, readDelivery: null, configGuidanceOpen: false,
        testDataResetEnabled: false, testResetBusy: null, testResetStatus: null,
        draftText: '', draftDirty: false, syncBusy: false, lifecycleBusy: null, pollCount: 0,
      };
    }

    function clearPoll() {
      if (pollTimer) global.clearTimeout(pollTimer);
      pollTimer = null;
    }

    function clearListPoll() {
      if (listPollTimer) global.clearTimeout(listPollTimer);
      listPollTimer = null;
    }

    function scheduleListPoll(capturedEpoch, envKey) {
      clearListPoll();
      const bootstrap = !state.auth;
      const readState = currentReadState();
      if (!active || !env || env.connectivity !== 'connected') return;
      if (!bootstrap && (state.auth.status !== 'active' || !readState.storedEnabled)) return;
      listPollTimer = global.setTimeout(() => {
        if (isCurrent(capturedEpoch, envKey) && !state.listLoading && !state.listAppending) {
          void loadList({ preserveSelection: true });
        }
      }, bootstrap ? 3_000 : 15_000);
    }

    function setVisible(show) {
      const wasActive = active;
      active = show;
      root.classList.toggle('hidden', !show);
      // 首页显隐是共享状态：内容工作区（灵感库 / 稿件审核）也会把它藏起来。
      // 非视频号账号每次状态心跳都会走到 setVisible(false)；若无条件归还首页，就会把正开着的
      // 内容工作区底下的首页一次次掀出来。只有自己真的从显示态退出时才归还首页。
      if (show || wasActive) legacyRoot.classList.toggle('hidden', show);
      shell.classList.toggle('interaction-mode', show);
      root.setAttribute('aria-hidden', String(!show));
      if (!show && testResetRoot) testResetRoot.classList.add('hidden');
    }

    function selectedEnvKey() {
      return env && env.envKey;
    }

    function assertEnvelope(result, expectedEnvKey) {
      if (!result || !result.ok) throw asApiError(result);
      const envelope = result.data;
      // 云端口径：比云端回包的 envKey（裸 profileId）。与 changeLifecycle 的本机回包守卫基准相反，勿互借。
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

    function controlsWriteBlocked() {
      const controls = state.auth && state.auth.runtimeControls;
      return !controls || controls.applicationStatus !== 'applied';
    }

    function writeBlocked() {
      return authWriteBlocked() || connectivityWriteBlocked() || controlsWriteBlocked();
    }

    function channelCapabilityBlocked(channel) {
      const caps = state.auth && state.auth.capabilities;
      if (!caps) return true;
      return channel === 'dm' ? !caps.dmSendText : !caps.commentsReply;
    }

    function replyConfigReady() {
      return Boolean(state.replyConfig && state.replyConfig.status === 'published');
    }

    function channelReadState(channel) {
      const auth = state.auth;
      const controls = auth && auth.runtimeControls;
      const stored = controls && controls.stored;
      const storedEnabled = stored ? Boolean(channel === 'dm' ? stored.dmReadEnabled : stored.commentsReadEnabled) : false;
      const applied = Boolean(controls && controls.applicationStatus === 'applied');
      const capable = Boolean(auth && auth.capabilities && (channel === 'dm' ? auth.capabilities.dmRead : auth.capabilities.commentsRead));
      if (!controls || !stored) return { storedEnabled: false, effective: false, label: '状态待确认', reason: '正在读取账号开关。' };
      if (!storedEnabled) return { storedEnabled, effective: false, label: '已关闭', reason: channel === 'dm' ? '私信收取未开启。' : '评论收取未开启。' };
      if (!applied) return { storedEnabled, effective: false, label: '已开启，等待本机应用', reason: '开关已保存，等待 Edge 应用同一版本。' };
      if (!capable) return { storedEnabled, effective: false, label: '平台读取能力未就绪', reason: '本机尚未确认该渠道的读取能力。' };
      return { storedEnabled, effective: true, label: '正在收取', reason: '开关已保存、本机已应用且平台读取能力正常。' };
    }

    function currentReadState() {
      if (!state.auth || !state.auth.runtimeControls) {
        return {
          storedEnabled: false,
          effective: false,
          label: '收取状态待确认',
          reason: state.listError ? '本次未能读取账号开关，不能据此判断是否没有互动。' : '正在读取账号开关。',
        };
      }
      if (state.tab === 'comment' || state.tab === 'dm') return channelReadState(state.tab);
      const comment = channelReadState('comment');
      const dm = channelReadState('dm');
      if (comment.effective || dm.effective) return { storedEnabled: true, effective: true, label: '至少一个渠道正在收取', reason: '' };
      if (comment.storedEnabled || dm.storedEnabled) return { storedEnabled: true, effective: false, label: '收取尚未生效', reason: comment.storedEnabled ? comment.reason : dm.reason };
      return { storedEnabled: false, effective: false, label: '互动收取未开启', reason: '请先开启评论或私信收取。' };
    }

    function relevantSyncChannels() {
      return state.tab === 'comment' || state.tab === 'dm' ? [state.tab] : ['comment', 'dm'];
    }

    function syncEvidence(channel) {
      return state.syncFreshness && state.syncFreshness[channel];
    }

    function syncClockSkewed(evidence) {
      return Boolean(evidence && evidence.observedAt > evidence.receivedAt + MAX_SYNC_CLOCK_SKEW_MS);
    }

    function syncStatusText() {
      if (!state.syncFreshness) return '同步状态待确认';
      const channels = relevantSyncChannels();
      const skewed = channels.filter((channel) => syncClockSkewed(syncEvidence(channel)));
      if (skewed.length > 0) return `${skewed.map((channel) => channel === 'dm' ? '私信' : '评论').join('、')}设备时间待校准`;
      const missing = channels.filter((channel) => !syncEvidence(channel));
      if (missing.length === channels.length) {
        return channels.length === 1
          ? `${channels[0] === 'dm' ? '私信' : '评论'}尚未成功同步`
          : '评论/私信尚未成功同步';
      }
      if (missing.length > 0) {
        return `${missing.map((channel) => channel === 'dm' ? '私信' : '评论').join('、')}尚未成功同步`;
      }
      return channels.length === 1
        ? `${channels[0] === 'dm' ? '私信' : '评论'}已有成功同步记录`
        : '评论/私信均有成功同步记录';
    }

    function syncTimeText() {
      if (!state.syncFreshness) return '同步时间待确认';
      return relevantSyncChannels().map((channel) => {
        const label = channel === 'dm' ? '私信' : '评论';
        const evidence = syncEvidence(channel);
        if (!evidence) return `${label} 尚无成功记录`;
        if (syncClockSkewed(evidence)) return `${label} 设备时间待校准 · Cloud ${formatTime(evidence.receivedAt)}收到`;
        return `${label} ${formatTime(evidence.observedAt)}`;
      }).join(' · ');
    }

    function applySyncFreshness(value) {
      const parsed = parseSyncFreshness(value);
      const projection = parsed && state.syncFreshness
        ? {
            comment: newerSyncEvidence(state.syncFreshness.comment, parsed.comment),
            dm: newerSyncEvidence(state.syncFreshness.dm, parsed.dm),
          }
        : parsed;
      state.syncFreshness = projection;
      const pending = state.pendingSync;
      if (!pending || pending.envKey !== selectedEnvKey()) return;
      const completed = Boolean(projection) && pending.channels.every((channel) => {
        const evidence = projection[channel];
        const baseline = pending.receivedAt[channel];
        return Boolean(evidence && evidence.receivedAt > (baseline || 0));
      });
      if (completed) {
        state.actionNotice = '本次同步已有成功结果。';
        state.pendingSync = null;
      } else {
        state.actionNotice = '同步请求已受理，尚未确认同步完成。';
      }
    }

    function newerSyncEvidence(current, incoming) {
      if (!current) return incoming;
      if (!incoming) return current;
      if (incoming.observedAt !== current.observedAt) {
        return incoming.observedAt > current.observedAt ? incoming : current;
      }
      return incoming.receivedAt >= current.receivedAt ? incoming : current;
    }

    function renderReadSettings() {
      const controls = state.auth && state.auth.runtimeControls;
      const stored = controls && controls.stored;
      const comment = channelReadState('comment');
      const dm = channelReadState('dm');
      // connectivity 已移除：这次写入经主进程直发 Cloud HTTP，不经过该环境的核心子进程。
      // Cloud 无 Edge 在线时按 CAS 正常落库并回 edgeDelivery.status='deferred'，
      // Edge 下次 hello 由欢迎信封的 interactionRuntime 快照收敛（cloud handler.ts:663-669）。
      // 保留的四项各有必要：stored（无它则无 expectedVersion 可携、CAS 无法构造）、
      // status==='active'（授权态，与浏览器现场 browserState 正交，MUST NOT 合并）、
      // !state.stale（正拿上次成功数据顶着时 storedVersion 可能已落后，携它发 CAS 有版本冲突风险）、
      // api 通道存在（preload 没暴露就真的调不到）。
      const editable = Boolean(stored && state.auth && state.auth.status === 'active' && !state.stale
        && typeof api.interactionUpdateReadControls === 'function');
      dom.readComment.checked = comment.storedEnabled;
      dom.readDm.checked = dm.storedEnabled;
      dom.readAll.checked = comment.storedEnabled && dm.storedEnabled;
      dom.readAll.indeterminate = comment.storedEnabled !== dm.storedEnabled;
      dom.readAll.disabled = state.readControlsBusy || !editable;
      dom.readComment.disabled = state.readControlsBusy || !editable;
      dom.readDm.disabled = state.readControlsBusy || !editable;
      dom.readCommentStatus.textContent = comment.label;
      dom.readDmStatus.textContent = dm.label;
      dom.readApply.textContent = state.readControlsBusy ? '正在保存，只会修改读取开关'
        : !controls ? '正在读取当前账号开关'
          : controls.applicationStatus === 'applied'
            ? `Cloud 已保存 v${controls.storedVersion}，本机已应用同一版本`
            : state.readDelivery === 'deferred'
              // 本次写入被 Cloud 受理但无 Edge 在线（deferred）：持久告知需启动该环境才生效，
              // 不冒充「等待本机应用」（那句默认既覆盖 enqueued 的几秒延迟、也在 Edge 离线时读作真话但没用）。
              ? `Cloud 已保存 v${controls.storedVersion}，待该环境下次连接后生效（需要启动该环境）`
              : `Cloud 已保存 v${controls.storedVersion}，等待本机应用${controls.edgeAppliedVersion == null ? '' : `（当前 v${controls.edgeAppliedVersion}）`}`;
      dom.readError.textContent = state.readControlsError ? friendlyError(state.readControlsError) : '';
      dom.readError.classList.toggle('hidden', !state.readControlsError);

      const config = state.replyConfig;
      const status = config && config.status;
      dom.configStatus.textContent = status === 'published' ? `回复配置已发布${config.publishedVersion ? ` · v${config.publishedVersion}` : ''}`
        : status === 'draft_only' ? `回复配置只有草稿${config.draftVersion ? ` · v${config.draftVersion}` : ''}`
          : status === 'missing' ? '尚未创建回复配置' : '回复配置状态暂不可确认';
      dom.configSummary.textContent = status === 'published' ? '可以按已发布规则生成、保存和批准回复。'
        : status === 'draft_only' ? '互动仍会收取；需要管理员发布草稿后才能生成或批准回复。'
          : status === 'missing' ? '互动仍会收取；需要管理员先在管理后台创建安全草稿。'
            : '为避免误发，配置恢复确认前不会生成或发送。';
      const needsGuidance = status !== 'published';
      dom.configHelp.classList.toggle('hidden', !needsGuidance);
      dom.configHelp.textContent = state.configGuidanceOpen ? '收起处理方法' : '查看处理方法';
      dom.configHelp.setAttribute('aria-expanded', String(state.configGuidanceOpen));
      dom.configGuidance.classList.toggle('hidden', !needsGuidance || !state.configGuidanceOpen);
      dom.configGuidance.textContent = status === 'draft_only'
        ? '请联系有配置权限的管理员，在管理后台检查草稿内容并点击“发布”。客户端不会代替管理员发布配置。'
        : status === 'missing'
          ? '请联系有配置权限的管理员，在管理后台点击“创建安全草稿”，检查后再手动发布。初始化不会自动开启回复或发送。'
          : '请稍后局部刷新；若持续无法确认，请让管理员检查当前账号的回复配置。';

      const unread = unreadMessagesByEnv.get(selectedEnvKey());
      const unreadCount = unread ? unread.size : 0;
      dom.unreadBadge.textContent = `${unreadCount} 条未读`;
      dom.unreadBadge.classList.toggle('hidden', unreadCount === 0);
    }

    function renderTestReset() {
      if (!testResetRoot) return;
      const enabled = active && state.testDataResetEnabled && typeof api.interactionTestReset === 'function';
      testResetRoot.classList.toggle('hidden', !enabled);
      for (const button of dom.testResetButtons) {
        button.disabled = Boolean(state.testResetBusy) || !env || env.connectivity !== 'connected' || state.stale;
        const channel = button.dataset.testResetChannel;
        button.textContent = state.testResetBusy === channel
          ? (channel === 'comment' ? '正在重置评论…' : '正在重置私信…')
          : (channel === 'comment' ? '重置评论' : '重置私信');
      }
      if (dom.testResetStatus) {
        dom.testResetStatus.textContent = state.testResetStatus || '每次只重置一个渠道；操作前需要输入确认词。';
      }
    }

    function lifecycleControl() {
      if (!env) return { action: null, label: '状态确认中' };
      if (env.session === 'paused') return { action: 'resume', label: '恢复' };
      if (env.edge === 'stopped' || env.edge === 'warning') return { action: 'start', label: '启动' };
      if (env.edge === 'starting' || env.edge === 'running') return { action: 'pause', label: '暂停' };
      return { action: null, label: '状态确认中' };
    }

    function engineStatusView() {
      if (!env) return { label: '引擎：待确认', tone: 'neutral' };
      if (env.edge === 'warning') return { label: '引擎：异常', tone: 'danger' };
      if (env.edge === 'starting') return { label: '引擎：启动中', tone: 'progress' };
      if (env.session === 'paused') return { label: '引擎：已暂停', tone: 'attention' };
      if (env.edge === 'running' && env.connectivity === 'connected') return { label: '引擎：已连接', tone: 'success' };
      if (env.edge === 'running') return { label: '引擎：连接中断', tone: 'danger' };
      if (env.edge === 'stopped') return { label: '引擎：未启动', tone: 'neutral' };
      return { label: '引擎：待确认', tone: 'neutral' };
    }

    function authStatusView(auth) {
      if (auth && auth.reasonCode === 'WECHAT_IDENTITY_MISMATCH') return { label: '视频号：账号不匹配', tone: 'danger' };
      const status = auth && auth.status;
      if (status === 'active') return { label: '视频号：鉴权通过', tone: 'success' };
      if (status === 'login_required') return { label: '视频号：等待登录', tone: 'attention' };
      if (status === 'reauth_required') return { label: '视频号：需重新登录', tone: 'danger' };
      if (status === 'challenge_required') return { label: '视频号：待人工验证', tone: 'attention' };
      if (status === 'authenticating') return { label: '视频号：鉴权中', tone: 'progress' };
      if (status === 'degraded') return { label: '视频号：同步异常', tone: 'attention' };
      if (status === 'disabled') return { label: '视频号：能力暂停', tone: 'danger' };
      return { label: '视频号：待确认', tone: 'neutral' };
    }

    function renderOverview() {
      const auth = state.auth;
      const status = auth && auth.status;
      let title = '正在加载互动状态';
      let summary = '正在读取当前环境的评论和私信。';
      let tone = 'neutral';
      if (auth && auth.reasonCode === 'WECHAT_IDENTITY_MISMATCH') {
        title = '浏览器登录了另一个视频号';
        summary = `请在“${safeText(env && env.label, '当前环境')}”的原浏览器切回已绑定账号${auth.identity ? `“${safeText(auth.identity.displayName, '原账号')}”` : ''}。历史内容仍可查看，写操作已暂停。`;
        tone = 'danger';
      } else if (status === 'active') {
        const connectivityStale = connectivityWriteBlocked();
        const controlsPending = controlsWriteBlocked();
        const commentRead = channelReadState('comment');
        const dmRead = channelReadState('dm');
        const allReadDisabled = !commentRead.storedEnabled && !dmRead.storedEnabled;
        const enabledButUnavailable = !allReadDisabled && !commentRead.effective && !dmRead.effective;
        const effectiveChannels = ['comment', 'dm'].filter((channel) => channelReadState(channel).effective);
        const syncUnconfirmed = effectiveChannels.some((channel) => !syncEvidence(channel));
        title = connectivityStale ? '同步暂时中断'
          : allReadDisabled ? '互动收取已关闭'
            : enabledButUnavailable ? '互动收取尚未生效'
              : controlsPending ? '账号开关等待本机应用'
                : syncUnconfirmed ? '等待首次成功同步'
            : auth.identity ? `已绑定：${safeText(auth.identity.displayName, '视频号账号')}` : '互动托管中';
        summary = connectivityStale ? '正在使用上次成功数据；Cloud 恢复后可局部刷新。'
          : allReadDisabled ? '评论和私信收取都已关闭。可在下方按渠道重新开启。'
            : enabledButUnavailable ? (commentRead.storedEnabled ? commentRead.reason : dmRead.reason)
              : controlsPending ? 'Cloud 已保存账号配置，但 Edge 尚未回报同版本能力；当前写操作继续关闭。'
                : syncUnconfirmed ? '开关与平台读取能力已就绪，但尚未收到所有已启用渠道的成功同步证据。'
            : '当前环境已绑定这个视频号。评论和私信按 Edge 实际能力同步，发送结果以平台确认状态为准。';
        tone = connectivityStale || controlsPending || allReadDisabled || enabledButUnavailable || syncUnconfirmed ? 'attention' : 'success';
      } else if (status === 'login_required') {
        title = '等待首次登录';
        summary = `可用下方“打开浏览器”在“${safeText(env && env.label, '当前环境')}”完成扫码；无需填写内部账号 ID，登录结果仍由引擎单独确认。`;
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

      const engineView = engineStatusView();
      const authView = authStatusView(auth);
      dom.engineStatus.textContent = engineView.label;
      dom.engineStatus.className = `iw-status-chip ${engineView.tone}`;
      dom.authStatus.textContent = authView.label;
      dom.authStatus.className = `iw-status-chip ${authView.tone}`;

      const browserState = auth && auth.browserState;
      const browserText = browserState === 'closed' && status === 'active'
        ? '自动化浏览器：后台模式'
        : browserState === 'open' ? '自动化浏览器：已打开'
          : browserState === 'opening' ? '自动化浏览器：正在打开'
            : browserState === 'closing' ? '自动化浏览器：正在关闭'
              : browserState === 'unavailable' ? '自动化浏览器：暂不可用'
                : '自动化浏览器：未回报';
      dom.browser.textContent = browserText;
      dom.browser.className = `iw-status-chip ${browserState === 'unavailable' ? 'danger' : browserState === 'closed' && status === 'active' ? 'success' : 'neutral'}`;
      const lifecycle = lifecycleControl();
      const lifecycleBusyLabel = { start: '正在启动…', resume: '正在恢复…', pause: '正在暂停…' }[state.lifecycleBusy];
      const lifecycleVisualAction = state.lifecycleBusy || lifecycle.action;
      dom.lifecycle.dataset.action = lifecycle.action || '';
      dom.lifecycle.textContent = lifecycleBusyLabel || lifecycle.label;
      dom.lifecycle.className = `iw-button ${lifecycleVisualAction === 'pause' ? 'secondary' : 'primary'}`;
      dom.lifecycle.disabled = Boolean(state.lifecycleBusy) || !active || !lifecycle.action || typeof onLifecycleAction !== 'function';
      const canClose = Boolean(env && env.session === 'paused');
      dom.close.classList.toggle('hidden', !canClose);
      dom.close.textContent = state.lifecycleBusy === 'close' ? '正在关闭…' : '关闭';
      dom.close.disabled = Boolean(state.lifecycleBusy) || !active || !canClose || typeof onLifecycleAction !== 'function';
      const canOpenLocalBrowser = active && typeof api.interactionOpenLocalBrowser === 'function';
      dom.browserControl.classList.toggle('hidden', !canOpenLocalBrowser);
      dom.browserControl.textContent = state.actionBusy === 'browser-open-local' ? '正在打开…' : '打开浏览器';
      dom.browserControl.disabled = !canOpenLocalBrowser || Boolean(state.actionBusy);
      dom.browserHelp.textContent = state.localBrowserNotice
        || '仅用于人工查看登录页和后台数据，不会启动引擎；视频号登录结果以上方鉴权状态为准。';
      dom.syncStatus.textContent = state.listLoading
        ? '正在读取当前环境'
        : state.stale ? '使用上次成功数据'
          : controlsWriteBlocked() && status === 'active' ? '账号开关已保存，等待 Edge 应用'
          : state.actionNotice || syncStatusText();
      dom.syncTime.textContent = `${state.stale ? '上次成功' : '最近成功'} · ${syncTimeText()}`;
      const canReopen = ['login_required', 'reauth_required', 'challenge_required'].includes(status);
      dom.reauth.classList.toggle('hidden', !canReopen);
      dom.reauth.textContent = status === 'challenge_required' ? '请求重新验证' : status === 'login_required' ? '请求检查登录' : '重新鉴权';
      dom.reauth.disabled = state.actionBusy === 'reauth';
      const readState = currentReadState();
      dom.sync.disabled = state.syncBusy || !active || !readState.effective;
      dom.sync.title = readState.effective ? '' : readState.reason;
      dom.sync.textContent = state.syncBusy ? '已请求，等待同步' : '局部刷新';
      renderReadSettings();
      renderTestReset();
    }

    function renderTabs() {
      for (const tab of dom.tabs) {
        const selected = tab.dataset.interactionTab === state.tab;
        tab.classList.toggle('active', selected);
        tab.setAttribute('aria-pressed', String(selected));
      }
    }

    function listEmptyCopy() {
      if (state.search.trim()) return { title: '当前已加载内容中没有匹配项', detail: '搜索只作用于当前环境已经加载的分页。' };
      const read = currentReadState();
      if (!read.effective) {
        const channel = state.tab === 'comment' ? '评论' : state.tab === 'dm' ? '私信' : '互动';
        return { title: read.label === '收取状态待确认' ? read.label : `${channel}收取未生效`, detail: read.reason };
      }
      const requiredChannels = (state.tab === 'comment' || state.tab === 'dm')
        ? [state.tab]
        : ['comment', 'dm'].filter((channel) => channelReadState(channel).effective);
      if (!state.syncFreshness) {
        return { title: '同步状态待确认', detail: '本次 API 读取成功不代表平台同步成功，当前列表为空不能证明没有互动。' };
      }
      const missingChannels = requiredChannels.filter((channel) => !syncEvidence(channel));
      if (missingChannels.length > 0) {
        const labels = missingChannels.map((channel) => channel === 'dm' ? '私信' : '评论').join('、');
        return { title: `${labels}尚未成功同步`, detail: '收到目标渠道的成功同步时间后，才能确认当前确实没有新互动。' };
      }
      if (state.tab === 'comment') return { title: '当前没有评论互动', detail: '评论收取正常；有新评论时会显示在这里。' };
      if (state.tab === 'dm') return { title: '当前没有私信会话', detail: '私信收取正常；有新私信时会显示在这里。' };
      if (state.tab === 'replied') return { title: '当前没有已确认回复记录', detail: '只有平台已确认的回复才会进入这里。' };
      return { title: '当前没有待处理互动', detail: '收取正常；需要处理的新互动会出现在这里。' };
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
        const empty = listEmptyCopy();
        dom.list.innerHTML = `<div class="iw-empty-state compact"><span class="iw-empty-icon" aria-hidden="true">···</span><strong>${escapeHtml(empty.title)}</strong><span>${escapeHtml(empty.detail)}</span></div>`;
      } else {
        dom.list.innerHTML = items.map((item) => {
          const selected = item.threadId === state.selectedThreadId;
          const job = JOB_LABEL[item.jobState] || [safeText(item.jobState, '状态待确认'), 'neutral'];
          const name = safeText(item.participantName, '未获取昵称');
          // 两级导航：列表只呈现摘要，消息正文只在详情级出现（不再渲染预览行）。
          const source = safeText(item.sourceTitle, item.channel === 'dm' ? '私信会话' : '未获取视频标题');
          return `<button class="iw-list-item${selected ? ' selected' : ''}${item.unread ? ' unread' : ''}" type="button" role="option" aria-selected="${String(selected)}" data-thread-id="${escapeHtml(item.threadId)}">
            <span class="iw-avatar" aria-hidden="true">${escapeHtml(name.slice(0, 1))}</span>
            <span class="iw-item-copy">
              <span class="iw-item-head"><strong>${item.unread ? '<i class="iw-unread-dot" aria-label="未读"></i>' : ''}${escapeHtml(name)}</strong><time>${escapeHtml(formatTime(item.lastMessageAt))}</time></span>
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

    // 详情级的图标控件（wechat-inbox-im-drilldown）。图标只是外形：每个都必须带
    // aria-label 与 title，键盘可聚焦、焦点态可见 —— MUST NOT 只靠图形传达用途。
    const ICON_BACK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 4.5 6.5 10l5.5 5.5"></path></svg>';
    const ICON_CLOSE = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"></path></svg>';
    const ICON_REFRESH = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.5 8a6.5 6.5 0 1 0 .3 3.4"></path><path d="M16.8 4v4h-4"></path></svg>';

    function backButtonHtml() {
      return `<button class="iw-iconbtn" type="button" data-iw-action="close-detail" aria-label="返回互动列表" title="返回列表">${ICON_BACK}</button>`;
    }

    function closeButtonHtml() {
      return `<button class="iw-iconbtn" type="button" data-iw-action="close-detail" aria-label="关闭详情并返回互动列表" title="关闭">${ICON_CLOSE}</button>`;
    }

    function refreshButtonHtml() {
      return `<button class="iw-iconbtn" type="button" data-iw-action="refresh-detail" aria-label="刷新状态" title="刷新状态">${ICON_REFRESH}</button>`;
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
      // 列表级：详情覆盖层既隐藏、又不渲染内容。这是红线的第二道保险——
      // 第一道是 styles.css 里显式压过 display 的 [hidden] 规则。任一道单独都不够：
      // 只靠样式，层叠一旦被后来的规则改写就复发；只靠不渲染，空容器仍会绝对定位挡住点击。
      if (!state.selectedThreadId) {
        dom.detail.hidden = true;
        dom.detail.innerHTML = '';
        return;
      }
      dom.detail.hidden = false;
      if (state.detailLoading && !state.detail) {
        dom.detail.innerHTML = '<div class="iw-loading-state detail"><i></i><i></i><i></i><span>正在加载消息上下文</span></div>';
        return;
      }
      if (!state.detail) {
        const message = state.detailError ? friendlyError(state.detailError) : '正在准备消息上下文';
        dom.detail.innerHTML = `<div class="iw-detail-scroll"><header class="iw-detail-head" data-iw-head="bare">${backButtonHtml()}<span></span><div class="headcopy"></div><div class="iw-detail-actions">${closeButtonHtml()}</div></header><div class="iw-empty-state"><span class="iw-empty-icon" aria-hidden="true">···</span><strong>${escapeHtml(message)}</strong><span>${state.detailError ? '列表不会因此被清空，可返回后选择其他互动或稍后重试。' : ''}</span></div></div>`;
        bindDetailActions();
        return;
      }

      const detail = state.detail;
      const thread = detail.thread;
      const job = detail.replyJob;
      const attempt = detail.sendAttempt;
      const participant = safeText(thread.participant && thread.participant.displayName, '未获取昵称');
      const source = safeText(thread.sourceTitle, thread.channel === 'dm' ? '私信会话' : '未获取视频标题');
      const channelSync = syncEvidence(thread.channel);
      const threadSyncText = !state.syncFreshness ? '同步时间待确认'
        : !channelSync ? '尚未成功同步'
          : syncClockSkewed(channelSync) ? `设备时间待校准 · Cloud ${formatTime(channelSync.receivedAt)}收到`
            : formatTime(channelSync.observedAt);
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
      const configBlocked = !replyConfigReady();
      const textLocked = textStateLocked || writeBlocked() || configBlocked;
      const capabilityBlocked = channelCapabilityBlocked(thread.channel);
      const primary = actionButtonModel(job);
      const busy = Boolean(state.actionBusy);

      dom.detail.innerHTML = `<div class="iw-detail-scroll">
        <header class="iw-detail-head">
          ${backButtonHtml()}
          <span class="iw-avatar large" aria-hidden="true">${escapeHtml(participant.slice(0, 1))}</span>
          <div><h2>${escapeHtml(participant)}</h2><p>${thread.channel === 'dm' ? '私信会话' : '公开视频评论'} · ${escapeHtml(formatTime(thread.lastMessageAt))}</p></div>
          <div class="iw-detail-actions">${refreshButtonHtml()}${closeButtonHtml()}</div>
        </header>
        <section class="iw-source-card">
          <span class="iw-source-icon" aria-hidden="true">${thread.channel === 'dm' ? '信' : '视'}</span>
          <div><span>${thread.channel === 'dm' ? '会话来源' : '关联视频'}</span><strong>${escapeHtml(source)}</strong><small>最近同步 ${escapeHtml(threadSyncText)}</small></div>
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
          ${authWriteBlocked() ? '<div class="iw-write-block">登录或能力状态未就绪，历史保持可读，写操作已禁用。</div>' : connectivityWriteBlocked() ? '<div class="iw-write-block">Cloud 离线或当前数据已过期，历史保持可读；刷新成功前写操作已禁用。</div>' : controlsWriteBlocked() ? '<div class="iw-write-block">账号开关已保存，但 Edge 尚未回报应用同一版本；写操作继续关闭。</div>' : configBlocked ? '<div class="iw-write-block">回复配置尚未发布；忽略和转人工仍可用，生成、保存、批准和发送暂不可用。</div>' : capabilityBlocked ? '<div class="iw-write-block">当前账号没有这个渠道的发送能力；保存、忽略、转人工和批准仍可用，只有发送被禁用。</div>' : ''}
          ${state.actionError ? `<div class="iw-action-error" role="alert">${escapeHtml(friendlyError(state.actionError))}${state.actionError.code === 'INTERACTION_VERSION_CONFLICT' || state.actionError.code === 'INTERACTION_STATE_CONFLICT' ? '<button class="iw-button ghost" type="button" data-iw-action="refresh-detail">重新加载详情</button>' : ''}</div>` : ''}
          ${state.actionNotice ? `<div class="iw-action-notice" role="status">${escapeHtml(state.actionNotice)}</div>` : ''}
          <footer class="iw-reply-actions">
            <div>
              <button class="iw-button ghost" type="button" data-iw-action="ignore" ${busy || TERMINAL_STATES.has(job.state) || writeBlocked() ? 'disabled' : ''}>忽略</button>
              <button class="iw-button ghost" type="button" data-iw-action="escalate" ${busy || TERMINAL_STATES.has(job.state) || writeBlocked() ? 'disabled' : ''}>转人工</button>
              <button class="iw-button secondary" type="button" data-iw-action="regenerate" ${busy || TERMINAL_STATES.has(job.state) || writeBlocked() || configBlocked ? 'disabled' : ''}>${state.actionBusy === 'regenerate' ? '重新生成中' : '重新生成'}</button>
            </div>
            <div>
              ${!textStateLocked ? `<button class="iw-button secondary" type="button" data-iw-action="save" ${busy || !state.draftDirty || writeBlocked() || configBlocked ? 'disabled' : ''}>${state.actionBusy === 'save' ? '保存中' : '保存修改'}</button>` : ''}
              ${primary ? `<button class="iw-button primary" type="button" data-iw-action="${primary.action}" ${busy || primary.disabled || writeBlocked() || configBlocked || (primary.action === 'send' && capabilityBlocked) ? 'disabled' : ''}>${state.actionBusy === primary.action ? '处理中' : primary.label}</button>` : ''}
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
          if (save) save.disabled = !state.draftDirty || Boolean(state.actionBusy) || writeBlocked() || !replyConfigReady();
          const approve = dom.detail.querySelector('[data-iw-action="approve"]');
          if (approve) approve.textContent = state.draftDirty ? '保存并批准' : '批准回复';
        });
      }
      bindDetailActions();
    }

    function bindDetailActions() {
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

    function envMessageSet(map, envKey) {
      let set = map.get(envKey);
      if (!set) {
        set = new Set();
        map.set(envKey, set);
      }
      return set;
    }

    function trackIncomingUnread(items, envKey, tab, append) {
      const seen = envMessageSet(seenMessagesByEnv, envKey);
      const notified = envMessageSet(notifiedMessagesByEnv, envKey);
      const unread = envMessageSet(unreadMessagesByEnv, envKey);
      const baselineKey = `${envKey}:${tab}`;
      const hasBaseline = baselineTabs.has(baselineKey);
      const newlyUnread = [];
      for (const item of items) {
        const messageId = String(item && item.messageId || '');
        if (!messageId) continue;
        if (item.unread) unread.add(messageId);
        else unread.delete(messageId);
        if (!append && hasBaseline && item.unread && !seen.has(messageId) && !notified.has(messageId)) newlyUnread.push(item);
        seen.add(messageId);
      }
      if (!hasBaseline) baselineTabs.add(baselineKey);
      if (newlyUnread.length === 0 || typeof api.interactionNotify !== 'function') return;
      for (const item of newlyUnread) notified.add(item.messageId);
      const channels = new Set(newlyUnread.map((item) => item.channel));
      const channel = channels.size === 1 ? newlyUnread[0].channel : 'mixed';
      void api.interactionNotify({ envKey, channel, count: newlyUnread.length });
    }

    async function loadList({ append = false, preserveSelection = false } = {}) {
      if (!active || !env) return;
      clearListPoll();
      const capturedEpoch = epoch;
      const envKey = env.envKey;
      const capturedTab = state.tab;
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
        trackIncomingUnread(incoming, envKey, capturedTab, append);
        if (append) {
          const seen = new Set(state.items.map((item) => `${item.threadId}:${item.messageId}`));
          state.items = state.items.concat(incoming.filter((item) => !seen.has(`${item.threadId}:${item.messageId}`)));
        } else {
          state.items = incoming;
        }
        state.nextCursor = envelope.data.nextCursor || null;
        state.auth = envelope.data.auth;
        state.replyConfig = envelope.data.replyConfig || { status: 'unknown', draftVersion: null, publishedVersion: null };
        state.testDataResetEnabled = Boolean(envelope.data.testTools && envelope.data.testTools.dataResetEnabled);
        applySyncFreshness(envelope.data.syncFreshness);
        state.listError = null;
        state.stale = false;
        // 两级导航：MUST NOT 默认选中任何一条，也不为其预取详情——只有客户显式点击才进详情级。
        if (state.selectedThreadId && !state.items.some((item) => item.threadId === state.selectedThreadId)) {
          // 正在看的那条已不在列表里 → 回列表级，而不是顺手改选第一条
          state.selectedThreadId = null;
          state.detail = null;
          state.detailError = null;
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
          scheduleListPoll(capturedEpoch, envKey);
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
        state.replyConfig = envelope.data.replyConfig || state.replyConfig || { status: 'unknown', draftVersion: null, publishedVersion: null };
        applySyncFreshness(envelope.data.syncFreshness);
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

    // 两级切换时把标签排锚到视口顶部，让收件箱区一次露全。
    // 挂在 #iw-tabs 这个静态节点上：它跨重绘存活，且正是客户点名的锚点。
    // 不自算 scrollTop —— 面板高度依赖视口、上方卡片高度可变，硬算偏移会随内容漂移。
    function anchorTabs() {
      if (!dom.tabsNav || typeof dom.tabsNav.scrollIntoView !== 'function') return;
      const reduced = typeof global.matchMedia === 'function'
        && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
      dom.tabsNav.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
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
      renderDetail();
      void loadDetail(threadId);
      if (focusDetail) dom.detail.setAttribute('tabindex', '-1');
      anchorTabs();
    }

    // 关闭详情覆盖层，回到列表级。关闭图标 / 返回箭头 / Esc 三个入口收敛到这里。
    function closeThread() {
      if (!state.selectedThreadId) return;
      clearPoll();
      state.selectedThreadId = null;
      state.detail = null;
      state.detailError = null;
      state.actionError = null;
      state.actionNotice = null;
      state.pollCount = 0;
      renderList();
      renderDetail();
      anchorTabs();
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
      if (kind === 'close-detail') {
        closeThread();
        return;
      }
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
      const configRequired = new Set(['save', 'approve', 'send', 'regenerate']).has(kind);
      if (!job || state.actionBusy || writeBlocked() || (configRequired && !replyConfigReady())
        || (kind === 'send' && channelCapabilityBlocked(state.detail.thread.channel))) return;
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

    async function updateReadControls(commentsReadEnabled, dmReadEnabled) {
      const controls = state.auth && state.auth.runtimeControls;
      if (!active || !env || state.readControlsBusy || !controls || typeof api.interactionUpdateReadControls !== 'function') return;
      const capturedEpoch = epoch;
      const envKey = env.envKey;
      state.readControlsBusy = true;
      state.readControlsError = null;
      state.actionNotice = null;
      state.readDelivery = null;
      renderAll();
      try {
        const response = await api.interactionUpdateReadControls({
          envKey,
          expectedVersion: controls.storedVersion,
          commentsReadEnabled,
          dmReadEnabled,
        });
        if (!isCurrent(capturedEpoch, envKey)) return;
        const envelope = assertEnvelope(response, envKey);
        state.auth = envelope.data.auth;
        state.replyConfig = envelope.data.replyConfig || state.replyConfig;
        // 持久落点：驱动 renderReadSettings() 的 readApply 分档（deferred → 待启动该环境才生效）。
        // 与下面一次性的 actionNotice 互补——后者是「刚点了一下」的即时反馈，会被后续任意动作清空。
        state.readDelivery = (envelope.data.edgeDelivery && envelope.data.edgeDelivery.status) || null;
        state.actionNotice = envelope.data.edgeDelivery && envelope.data.edgeDelivery.status === 'enqueued'
          ? '收取开关已保存并下发本机。'
          : '收取开关已保存，等待本机重新连接后应用。';
      } catch (error) {
        if (!isCurrent(capturedEpoch, envKey)) return;
        state.readControlsError = error;
      } finally {
        if (isCurrent(capturedEpoch, envKey)) {
          state.readControlsBusy = false;
          renderAll();
          scheduleListPoll(capturedEpoch, envKey);
        }
      }
    }

    async function syncCurrent() {
      if (!active || !env || state.syncBusy) return;
      const readState = currentReadState();
      if (!readState.effective) {
        state.actionNotice = readState.reason;
        renderAll();
        return;
      }
      const capturedEpoch = epoch;
      const envKey = env.envKey;
      const effectiveChannels = ['comment', 'dm'].filter((channel) => channelReadState(channel).effective);
      const channel = state.tab === 'comment' || state.tab === 'dm'
        ? state.tab
        : effectiveChannels.length === 1 ? effectiveChannels[0] : null;
      const pendingChannels = channel ? [channel] : effectiveChannels;
      const receivedAt = {};
      for (const pendingChannel of pendingChannels) {
        receivedAt[pendingChannel] = syncEvidence(pendingChannel)?.receivedAt || null;
      }
      state.syncBusy = true;
      state.actionNotice = null;
      renderOverview();
      try {
        const response = await api.interactionSync({
          envKey, channel, scopeExternalId: null, idempotencyKey: makeRequestKey('interaction-sync'),
        });
        if (!isCurrent(capturedEpoch, envKey)) return;
        assertEnvelope(response, envKey);
        state.pendingSync = { envKey, channels: pendingChannels, receivedAt };
        state.actionNotice = '同步请求已受理，尚未确认同步完成。';
        global.setTimeout(() => {
          if (isCurrent(capturedEpoch, envKey)) void loadList({ preserveSelection: true });
        }, 750);
      } catch (error) {
        if (!isCurrent(capturedEpoch, envKey)) return;
        state.pendingSync = null;
        state.listError = error;
        state.stale = Boolean(state.items.length || state.detail);
      } finally {
        if (isCurrent(capturedEpoch, envKey)) {
          state.syncBusy = false;
          renderAll();
        }
      }
    }

    async function resetTestData(channel) {
      if (!active || !env || state.testResetBusy || !state.testDataResetEnabled ||
          typeof api.interactionTestReset !== 'function') return;
      const label = channel === 'comment' ? '评论' : '私信';
      const confirmation = `重置${label}`;
      const typed = typeof global.prompt === 'function'
        ? global.prompt(`这会清空当前账号的 Cloud ${label}副本和读取游标，再从微信平台重新拉取。\n\n不会删除微信平台数据，也不会发送回复。\n\n请输入“${confirmation}”继续：`, '')
        : null;
      if (typed !== confirmation) {
        state.testResetStatus = typed === null ? '已取消，未清空任何数据。' : `确认词不匹配，未执行${label}重置。`;
        renderTestReset();
        return;
      }
      const capturedEpoch = epoch;
      const envKey = env.envKey;
      state.testResetBusy = channel;
      state.testResetStatus = `正在清空 Cloud ${label}副本并请求重新拉取…`;
      renderTestReset();
      try {
        const response = await api.interactionTestReset({
          envKey, channel, idempotencyKey: makeRequestKey(`interaction-test-reset-${channel}`),
        });
        if (!isCurrent(capturedEpoch, envKey)) return;
        assertEnvelope(response, envKey);
        const removedThreadIds = new Set(state.items.filter((item) => item.channel === channel).map((item) => item.threadId));
        state.items = state.items.filter((item) => item.channel !== channel);
        if (state.selectedThreadId && removedThreadIds.has(state.selectedThreadId)) {
          state.selectedThreadId = null;
          state.detail = null;
          state.detailError = null;
        }
        state.testResetStatus = `Cloud ${label}测试数据已清空，正在从微信平台重新拉取。`;
        renderAll();
        global.setTimeout(() => {
          if (isCurrent(capturedEpoch, envKey)) void loadList({ preserveSelection: true });
        }, 750);
      } catch (error) {
        if (!isCurrent(capturedEpoch, envKey)) return;
        state.testResetStatus = error && error.code === 'INTERACTION_TEST_RESET_PARTIAL'
          ? `Cloud ${label}副本已清空，但自动重新拉取没有启动；确认客户端在线后可再次重置。`
          : safeText(error && error.message, friendlyError(error));
      } finally {
        if (isCurrent(capturedEpoch, envKey)) {
          state.testResetBusy = null;
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
        state.actionNotice = '已请求引擎重新检查登录，仍需等待平台登录状态确认。';
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

    async function openLocalBrowser() {
      if (!active || !env || state.actionBusy || typeof api.interactionOpenLocalBrowser !== 'function') return;
      const capturedEpoch = epoch;
      const envKey = env.envKey;
      state.actionBusy = 'browser-open-local';
      state.actionError = null;
      state.actionNotice = '正在准备本地浏览器；这不会启动引擎。';
      state.localBrowserNotice = '正在准备本地浏览器；这不会启动引擎。';
      renderAll();
      try {
        const response = await api.interactionOpenLocalBrowser({ envKey });
        if (!isCurrent(capturedEpoch, envKey)) return;
        if (!response || !response.ok) {
          const payload = response && response.data && response.data.error;
          const error = new Error((payload && payload.message) || '本地浏览器未能打开。');
          error.code = payload && payload.code;
          error.status = response && response.status;
          throw error;
        }
        if (!response.data || response.data.envKey !== envKey || response.data.opened !== true) {
          const error = new Error('本地浏览器回包环境不一致，已丢弃。');
          error.code = 'INTERACTION_SCOPE_MISMATCH';
          throw error;
        }
        state.actionNotice = '本地浏览器已打开；未改变引擎状态，登录结果仍以上方“视频号”鉴权状态为准。';
        state.localBrowserNotice = state.actionNotice;
      } catch (error) {
        if (!isCurrent(capturedEpoch, envKey)) return;
        state.actionError = error;
        state.actionNotice = friendlyError(error);
        state.localBrowserNotice = state.actionNotice;
      } finally {
        if (isCurrent(capturedEpoch, envKey)) {
          state.actionBusy = null;
          renderAll();
        }
      }
    }

    async function changeLifecycle(requestedAction) {
      if (!active || !env || state.lifecycleBusy) return;
      const lifecycle = lifecycleControl();
      const action = requestedAction || lifecycle.action;
      if (!['start', 'resume', 'pause', 'close'].includes(action) || typeof onLifecycleAction !== 'function') return;
      if (action === 'close' && env.session !== 'paused') return;
      const capturedEpoch = epoch;
      const envKey = env.envKey;
      // 本机口径：主进程按 runtime envId（ads-<profileId>）索引环境，云端口径的 envKey 在那边查不到。
      // 缺失时诚实拒绝：回落成 envKey 会让主进程查表落空、静默回落到当前选中环境，
      // 即对另一个环境执行生命周期动作而不报错——宁可拒绝，也绝不猜目标。
      const runtimeEnvId = env.runtimeEnvId;
      if (!runtimeEnvId) {
        state.actionNotice = `${action === 'close' ? '关闭' : lifecycle.label}失败：当前环境缺少本机运行时标识，未执行。`;
        renderOverview();
        return;
      }
      state.lifecycleBusy = action;
      state.actionNotice = null;
      renderOverview();
      try {
        const next = await onLifecycleAction(action, runtimeEnvId);
        if (!isCurrent(capturedEpoch, envKey)) return;
        if (!next) return;
        // 本机回包按本机口径校验，必须与发送侧同口径（onLifecycleAction 发的就是 runtimeEnvId）。
        // 注意与 assertEnvelope 相反：那道守卫比的是云端回包的 envKey，基准是云端口径。两者绝不可互借。
        if (next && next.envId && next.envId !== runtimeEnvId) {
          const error = new Error('生命周期回包环境与当前环境不一致，已丢弃。');
          error.code = 'INTERACTION_SCOPE_MISMATCH';
          throw error;
        }
        if (next && typeof onLifecycleStatus === 'function') onLifecycleStatus(next);
        state.actionNotice = action === 'start'
          ? '已请求启动当前环境。'
          : action === 'resume' ? '已请求恢复当前环境。'
            : action === 'close' ? '已关闭当前环境。' : '已请求暂停当前环境。';
      } catch (error) {
        if (!isCurrent(capturedEpoch, envKey)) return;
        const label = action === 'close' ? '关闭' : lifecycle.label;
        state.actionNotice = `${label}失败：${friendlyError(error)}`;
      } finally {
        if (isCurrent(capturedEpoch, envKey)) {
          state.lifecycleBusy = null;
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
        clearListPoll();
        setVisible(false);
        return;
      }
      if (env && env.envKey === next.envKey && active) {
        const connectivityChanged = env.connectivity !== next.connectivity;
        const lifecycleChanged = env.edge !== next.edge || env.session !== next.session;
        env = { ...next };
        if (next.connectivity !== 'connected') {
          state.stale = Boolean(state.items.length || state.detail || state.stale);
          clearListPoll();
        } else if ((connectivityChanged || lifecycleChanged) && !state.listLoading && !state.listAppending) {
          void loadList({ preserveSelection: true });
        }
        if (connectivityChanged || lifecycleChanged) renderAll();
        return;
      }
      if (env && api.interactionCancelReads) void api.interactionCancelReads(env.envKey);
      epoch += 1;
      env = { ...next };
      state = freshState();
      if (env.connectivity !== 'connected') state.stale = true;
      clearPoll();
      clearListPoll();
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
      clearListPoll();
      state.tab = nextTab;
      state.items = [];
      state.nextCursor = null;
      state.selectedThreadId = null;
      state.detail = null;
      state.detailError = null;
      state.listError = null;
      state.actionNotice = null;
      state.pendingSync = null;
      state.pollCount = 0;
      renderAll();
      void loadList();
    }));
    dom.search.addEventListener('input', () => {
      state.search = dom.search.value;
      const visible = filteredItems();
      // 正在看的那条被搜索条件筛掉 → 回列表级，MUST NOT 改选第一条
      if (state.selectedThreadId && !visible.some((item) => item.threadId === state.selectedThreadId)) {
        clearPoll();
        state.selectedThreadId = null;
        state.detail = null;
        state.detailError = null;
      }
      renderList();
      renderDetail();
    });
    // Esc = 关闭详情覆盖层，与关闭图标、返回箭头同一个动作。
    // 挂在 root 上并由 active 兜底，与本模块其余监听同一惯例（随 root 一同消亡，不残留）。
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !active || !state.selectedThreadId) return;
      event.preventDefault();
      closeThread();
    });
    dom.list.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = filteredItems();
      if (items.length === 0) return;
      event.preventDefault();
      // 没有选中时 findIndex 返回 -1：ArrowDown 必须落到第 0 条。
      // 旧代码把 -1 夹成 0，在「默认选中第一条」的前提下无害；现在不再默认选中，
      // 夹完会让 ArrowDown 跳过第一条 —— 所以这里保留 -1 让下面的 +1 自然落到 0。
      const index = items.findIndex((item) => item.threadId === state.selectedThreadId);
      const nextIndex = event.key === 'ArrowDown'
        ? Math.min(items.length - 1, index + 1)
        : Math.max(0, index < 0 ? 0 : index - 1);
      selectThread(items[nextIndex].threadId, false);
      const button = dom.list.querySelector(`[data-thread-id="${global.CSS && global.CSS.escape ? global.CSS.escape(items[nextIndex].threadId) : items[nextIndex].threadId.replace(/["\\]/g, '\\$&')}"]`);
      if (button) button.focus();
    });
    dom.loadMore.addEventListener('click', () => void loadList({ append: true, preserveSelection: true }));
    dom.close.addEventListener('click', () => void changeLifecycle('close'));
    dom.lifecycle.addEventListener('click', () => void changeLifecycle());
    dom.browserControl.addEventListener('click', () => void openLocalBrowser());
    dom.sync.addEventListener('click', () => void syncCurrent());
    dom.reauth.addEventListener('click', () => void reopenAuth());
    dom.readAll.addEventListener('change', () => void updateReadControls(dom.readAll.checked, dom.readAll.checked));
    dom.readComment.addEventListener('change', () => void updateReadControls(dom.readComment.checked, channelReadState('dm').storedEnabled));
    dom.readDm.addEventListener('change', () => void updateReadControls(channelReadState('comment').storedEnabled, dom.readDm.checked));
    dom.configHelp.addEventListener('click', () => {
      state.configGuidanceOpen = !state.configGuidanceOpen;
      renderReadSettings();
    });
    for (const button of dom.testResetButtons) {
      button.addEventListener('click', () => void resetTestData(button.dataset.testResetChannel));
    }

    return { selectEnvironment, refresh: () => loadList({ preserveSelection: true }) };
  }

  global.InteractionWorkspace = Object.freeze({ create });
})(window);
