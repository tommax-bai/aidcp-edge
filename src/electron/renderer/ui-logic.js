'use strict';

// 陪伴式界面的纯视图逻辑（edge-companion-ui）：健康合成 / 在场感动效门 / 发布卡状态机 / 相对时间。
// 无 DOM、无 Electron 依赖——浏览器里挂 window.uiLogic，node:test 里经 createRequire 直接单测。
(function (root, factory) {
  const displayNameApi = typeof module !== 'undefined' && module.exports
    ? require('./environment-display-name.cjs')
    : root && root.environmentDisplayName;
  const api = factory(displayNameApi);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.uiLogic = api;
})(typeof window !== 'undefined' ? window : null, function (displayNameApi) {
  // ── 相对时间：诚实走字（「刚刚 / N 秒前 / N 分钟前 / N 小时前」）──
  function relTime(fromMs, nowMs) {
    const diff = Math.max(0, nowMs - fromMs);
    if (diff < 5_000) return '刚刚';
    if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return `${Math.floor(diff / 86_400_000)} 天前`;
  }

  // 已等待时长：与 relTime 的「N 分钟前」不同，这里说的是「等了多久」，不是「多久之前发生」。
  function waitedText(fromMs, nowMs) {
    const diff = Math.max(0, nowMs - fromMs);
    if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟`;
    return `${Math.floor(diff / 3_600_000)} 小时`;
  }

  // ── 健康合成：客户会话 + 自动化 + 浏览器 → 一句结论。core/cloud 仅作旧版兼容，不参与主结论。──
  const AUTH_ATTENTION = { 'login required': '需要登录小红书', 'chrome missing': '本机缺少 Chrome', 'config required': '需要完成初始设置' };
  const FACEBOOK_AUTH_ATTENTION = {
    credential_fill_unavailable: '需要登录：AdsPower 未填充账号密码',
    stale_totp_input_requires_fresh_start: '2FA 输入框中有未确认验证码，请在浏览器完成验证',
    fresh_start_policy_unavailable: '当前浏览器无法安全自动填写 2FA，请在浏览器完成验证',
    auth_probe_unavailable: '暂时无法读取 Facebook 登录页面，请在浏览器检查后继续',
  };

  function authAttentionDetail(status) {
    if (status.auth === 'login required'
        && Object.prototype.hasOwnProperty.call(FACEBOOK_AUTH_ATTENTION, status.authReason)) {
      return FACEBOOK_AUTH_ATTENTION[status.authReason];
    }
    return AUTH_ATTENTION[status.auth] || '';
  }

  function isFacebookManualAttention(status) {
    return status.auth === 'login required' && (
      status.authReason === 'stale_totp_input_requires_fresh_start'
      || status.authReason === 'fresh_start_policy_unavailable'
      || status.authReason === 'auth_probe_unavailable'
    );
  }

  function loginFlowState(status) {
    const flow = status && status.loginFlow;
    return flow && typeof flow === 'object' ? flow.state : '';
  }

  function loginFlowFailureDetail(status) {
    const flow = status && status.loginFlow;
    const reason = flow && typeof flow.reason === 'string' ? flow.reason.trim() : '';
    return reason ? `登录认证异常：${reason}` : '登录认证异常，需要处理后重新启动';
  }

  function lifecycleView(status) {
    const raw = status || {};
    const automationState = raw.automationState
      || (raw.session === 'paused' ? 'paused'
        : raw.edge === 'warning' || raw.coreState === 'error' ? 'error'
        : raw.edge === 'starting' || raw.coreState === 'starting' || raw.coreState === 'restarting' ? 'starting'
        : (raw.session === 'running' || raw.session === 'resting') && (raw.edge === 'running' || raw.coreState === 'online') ? 'running'
        : 'stopped');
    const legacyEngineActive = ['starting', 'ready', 'running', 'waiting_resource'].includes(automationState);
    const engineLinkState = raw.engineLinkState
      || (raw.cloudState === 'offline' ? 'disconnected' : raw.cloudState)
      || (raw.cloud === 'connected' ? 'connected'
        : legacyEngineActive && (raw.edge === 'running' || raw.edge === 'starting')
          ? (raw.cloudEverConnected ? 'reconnecting' : 'connecting')
          : 'disconnected');
    return {
      ...raw,
      clientSessionState: raw.clientSessionState || 'ready',
      automationState,
      engineLinkState,
      browserState: raw.browserState || (raw.browserStandby ? 'closed' : raw.edge === 'running' ? 'ready' : 'closed'),
    };
  }

  function synthesizeHealth(status) {
    const s = lifecycleView(status);
    const edgeFailure = s.edgeFailure && typeof s.edgeFailure.summary === 'string' ? s.edgeFailure.summary.trim() : '';
    if (s.clientSessionState === 'signed_out' || s.clientSessionState === 'expired') {
      return { code: 'attention', label: '需登录', detail: '需要登录客户端；登录后即可继续数据管理，不会自动启动浏览器' };
    }
    if (s.risk === 'frozen') return { code: 'error', label: '已暂停', detail: '账号已暂停，当前无法继续操作，请查看详情' };
    if (s.risk === 'restricted') return { code: 'attention', label: '受限制', detail: '账号受限，自动运营已暂停；确认 Facebook 可正常使用后可解除受限' };
    if (loginFlowState(s) === 'failed') return { code: 'error', label: '异常', detail: loginFlowFailureDetail(s) };
    if (s.automationState === 'error' || ((s.coreState === 'error' || s.edge === 'warning') && s.automationState !== 'stopped')) {
      return { code: 'error', label: '异常', detail: edgeFailure || '自动化引擎未能继续运行，请查看详情' };
    }
    const authDetail = authAttentionDetail(s);
    if (authDetail) return { code: 'attention', label: '需处理', detail: authDetail };
    if (s.automationState === 'pausing') return { code: 'paused', label: '暂停中', detail: '正在断开引擎并释放浏览器；数据管理仍可用' };
    if (s.automationState === 'stopping') return { code: 'paused', label: '关闭中', detail: '数据管理仍可用' };
    if (s.automationState === 'waiting_resource') return { code: 'ready', label: '排队中', detail: '轮到当前环境后会自动继续' };
    if (s.automationState === 'starting') return { code: 'ready', label: '启动中', detail: '正在连接引擎并准备浏览器' };
    if (s.engineLinkState === 'reconnecting' && ['ready', 'running'].includes(s.automationState)) {
      return { code: 'attention', label: '重连中', detail: '数据管理不受影响；连接恢复后会自动继续' };
    }
    if (s.browserState === 'error') {
      return { code: 'attention', label: '异常', detail: '浏览器异常；数据管理仍可用，可重新打开浏览器恢复页面操作' };
    }
    if (loginFlowState(s) === 'automatic') {
      return { code: 'ready', label: '登录中', detail: '系统正在自动登录，无需人工操作' };
    }
    if (s.automationState === 'paused') return { code: 'paused', label: '已暂停', detail: '引擎已断开；数据管理仍可继续使用' };
    if (s.automationState === 'running') {
      return { code: 'running', label: '运行中', detail: s.risk === 'warned' ? '账号保护已要求放慢节奏' : '自动化正在执行任务' };
    }
    if (s.automationState === 'ready') return { code: 'ready', label: '待任务', detail: '引擎已连接，等待下一项任务' };
    return { code: 'ready', label: '未启动', detail: '数据管理可直接使用；启动自动化时才会连接引擎和打开浏览器' };
  }

  // 标题带色调：可恢复的节奏调整用琥珀，只有冻结使用红色。
  function bandTone(status) {
    const risk = (status || {}).risk;
    if (risk === 'frozen') return 'danger';
    if (risk === 'warned' || risk === 'restricted') return 'warned';
    return 'normal';
  }

  // 用户可见明细只展示产品概念；coreState/cloudState 保留在诊断快照，不进入这里。
  const DETAIL_LABELS = {
    clientSessionState: { label: '客户会话', values: { ready: '已登录', signed_out: '未登录', expired: '已过期' } },
    automationState: { label: '自动化', values: { stopped: '未启动', starting: '启动中', ready: '待任务', running: '运行中', waiting_resource: '排队中', pausing: '暂停中', paused: '已暂停', stopping: '关闭中', error: '异常' } },
    engineLinkState: { label: '引擎连接', values: { disconnected: '未连接', connecting: '连接中', connected: '已连接', reconnecting: '重连中', error: '异常' } },
    browserState: { label: '浏览器', values: { closed: '已关闭', queued: '等待槽位', starting: '启动中', ready: '已就绪', blocked: '等待人工处理', closing: '关闭中', error: '异常' } },
    risk: { label: '账号保护', values: { normal: '正常', warned: '谨慎放慢', restricted: '账号受限', frozen: '已暂停' } },
  };

  function detailRows(status) {
    const s = status || {};
    return Object.keys(DETAIL_LABELS).map((key) => {
      const def = DETAIL_LABELS[key];
      const raw = s[key];
      return { key, label: def.label, value: def.values[raw] || String(raw || '未知'), raw: raw || '' };
    });
  }

  // ── 在场感动效门（红线：绝不用动效盖住停滞会话）──
  // 只有「会话在跑 + 引擎在跑 + 最近事件足够新鲜（与看门狗有界 idle 对齐，5 分钟）」才允许动。
  const PRESENCE_FRESH_MS = 5 * 60_000;
  // 「正在做」与「已做完、在等云端下一步」的分界。超过这条线，动作文案仍然保留（运营要知道最后
  // 推进到哪一步），但动效与「刚刚更新」必须撤掉——那两样是在向用户承诺「此刻正在做这件事」。
  const PRESENCE_LIVE_MS = 60_000;
  // 有上限的动作按此序参与「配额休息 / 计划完成」判定。**漏一个键的后果不是报错**，是该动作的上限对
  // 这套逻辑完全不可见（加群满了也不会被算作在等配额）。与 protocol.ts 的 UI_DAILY_USAGE_ACTIONS 同集，
  // 只是这里额外承载优先级顺序（本文件是纯 JS、import 不了那张表，改动时须手工对齐）。
  const QUOTA_ACTION_PRIORITY = ['view', 'search', 'like', 'collect', 'comment', 'follow', 'publish', 'join_group'];

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function count(value) {
    const n = finiteNumber(value);
    return n === null ? 0 : Math.max(0, Math.floor(n));
  }

  function compactCount(value) {
    const n = count(value);
    const format = (num) => {
      const rounded = num >= 10 ? Math.round(num) : Math.round(num * 10) / 10;
      return String(rounded).replace(/\.0$/, '');
    };
    if (n >= 100_000_000) return `${format(n / 100_000_000)} 亿`;
    if (n >= 10_000) return `${format(n / 10_000)} 万`;
    return String(n);
  }

  function objectOrEmpty(value) {
    return value && typeof value === 'object' ? value : {};
  }

  function futureWaitText(at, nowMs) {
    if (at === null) return '';
    const diff = at - nowMs;
    if (!(diff > 0)) return '';
    const seconds = Math.ceil(diff / 1000);
    if (seconds < 90) return `${seconds} 秒后`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 90) return `${minutes} 分钟后`;
    const hours = Math.ceil(minutes / 60);
    if (hours < 24) return `${hours} 小时后`;
    return `${Math.ceil(hours / 24)} 天后`;
  }

  // ── 运行价值说明：只把已确认的浏览阶段转为成果与下一步，不推断单项互动会暂停整轮浏览。──
  function guidanceWindow(status, key, nowMs) {
    const windows = status && status.dailyUsage && objectOrEmpty(status.dailyUsage).windows;
    const window = windows && objectOrEmpty(windows)[key];
    if (!window || typeof window !== 'object') return null;
    const totals = objectOrEmpty(window.totals);
    const quotas = objectOrEmpty(window.quotas);
    const active = key === 'session' ? window.active !== false : true;
    const expiresAt = finiteNumber(window.expiresAt);
    const expired = key !== 'session' && expiresAt !== null && expiresAt <= nowMs;
    const saturated = new Set(Array.isArray(window.saturated) ? window.saturated : []);
    const capped = [];
    for (const action of QUOTA_ACTION_PRIORITY) {
      const cap = finiteNumber(quotas[action]);
      if (cap === null) continue;
      const used = count(totals[action]);
      capped.push({
        action,
        used,
        cap: count(cap),
        complete: saturated.has(action) || used >= count(cap),
      });
    }
    return {
      key,
      active,
      expired,
      totals,
      saturated,
      expiresAt,
      releaseAt: finiteNumber(window.releaseAt),
      capped,
      view: capped.find((entry) => entry.action === 'view') || null,
    };
  }

  function firstCount(sources, keys) {
    for (const source of sources) {
      const obj = objectOrEmpty(source);
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) return count(obj[key]);
      }
    }
    return 0;
  }

  function firstPositiveCount(sources, keys) {
    for (const source of sources) {
      const obj = objectOrEmpty(source);
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
        const value = count(obj[key]);
        if (value > 0) return value;
      }
    }
    return 0;
  }

  function usageCount(status, window, keys) {
    const daily = objectOrEmpty(objectOrEmpty(status).dailyUsage);
    return firstCount([window && window.totals, daily.totals, objectOrEmpty(status).stats], keys);
  }

  function dailyUsageCount(status, dayWindow, keys) {
    const daily = objectOrEmpty(objectOrEmpty(status).dailyUsage);
    return firstCount([dayWindow && dayWindow.totals, daily.totals, objectOrEmpty(status).stats], keys);
  }

  function observedCount(status, window) {
    return usageCount(status, window, ['view', 'views']);
  }

  function dailyObservedCount(status, dayWindow) {
    return dailyUsageCount(status, dayWindow, ['view', 'views']);
  }

  function inspirationCount(status, window) {
    return usageCount(status, window, ['inspiration', 'inspirations', 'candidate', 'candidates', 'collect', 'collects']);
  }

  function explorationWindow(status, nowMs) {
    for (const key of ['session', 'hour']) {
      const window = guidanceWindow(status, key, nowMs);
      if (window && window.active && !window.expired) return window;
    }
    return null;
  }

  function explorationProgress(status, window, resting, dayWindow) {
    const daily = objectOrEmpty(objectOrEmpty(status).dailyUsage);
    const dailyTarget = firstPositiveCount([dayWindow && dayWindow.view, daily.quotas], ['cap', 'view', 'views']);
    const windowTarget = firstPositiveCount([window && window.view], ['cap', 'view', 'views']);
    const useDailyProgress = dailyTarget > 0;
    const configuredTarget = useDailyProgress ? dailyTarget : windowTarget;
    const hasTarget = configuredTarget > 0;
    const observed = useDailyProgress ? dailyObservedCount(status, dayWindow) : observedCount(status, window);
    const target = hasTarget ? Math.max(observed, configuredTarget) : Math.max(observed, 1);
    const percent = hasTarget && target > 0 ? Math.min(100, Math.round((observed / target) * 100)) : 0;
    const title = resting
      ? (observed > 0 ? `本轮已查看 ${observed} 条推荐内容` : '本轮探索进展已记录')
      : (observed > 0 ? `正在查看第 ${observed} 条推荐内容` : '正在观察推荐内容');
    return {
      current: observed,
      target,
      percent,
      title,
      counter: hasTarget ? `${observed}/${target}` : '',
      meta: resting ? '进展已记录' : '进展实时记录',
    };
  }

  function firstPostGuidance(status) {
    const daily = objectOrEmpty(objectOrEmpty(status).dailyUsage);
    const firstPost = objectOrEmpty(daily.firstPost);
    if (firstPost.state !== 'searching' && firstPost.state !== 'generating') return null;
    const viewed = count(firstPost.viewed);
    const target = 20;
    const generating = firstPost.state === 'generating';
    const shown = Math.min(viewed, target);
    return {
      mode: 'first-post',
      mascot: generating ? 'celebration' : 'task-execution',
      animate: false,
      kicker: generating ? '已找到创作灵感' : '正在为第一篇作品找灵感',
      title: generating ? '正在生成你的第一篇作品。' : '正在观察平台推荐的上升话题。',
      value: generating
        ? '这条灵感来自平台正在推荐、且符合你人设的方向。'
        : '自动浏览不是漫无目的，而是在寻找目标人群感兴趣、又符合人设的方向。',
      detail: '',
      steps: [
        { icon: 'browse', state: generating ? 'done' : 'current', label: '看趋势', detail: generating ? `已观察 ${viewed} 条推荐内容` : '观察平台上升话题' },
        { icon: 'match', state: generating ? 'done' : 'next', label: '找匹配', detail: generating ? '已筛出 1 条创作灵感' : '筛选人设匹配方向' },
        { icon: 'create', state: generating ? 'current' : 'next', label: '开始创作', detail: generating ? '正在生成第一篇作品' : '找到后自动生成' },
      ],
      progress: {
        current: viewed,
        target,
        percent: Math.min(100, Math.round((shown / target) * 100)),
        title: generating
          ? `已从 ${viewed} 条推荐内容中找到灵感`
          : viewed >= target
            ? '已观察约 20 条，继续寻找合适方向'
            : viewed > 0
              ? `正在观察第 ${viewed} 条推荐内容`
              : '首轮观察刚刚开始',
        counter: viewed > target ? `${viewed} 条` : `${shown}/${target}`,
        meta: generating ? '已找到 1 条灵感' : '通常筛出 1 条灵感',
      },
      resume: '',
      note: generating ? '生成后仍会由你确认发布' : '找到后，将自动生成你的第一篇作品',
    };
  }

  function inspirationHarvest(status) {
    const daily = objectOrEmpty(objectOrEmpty(status).dailyUsage);
    const summary = objectOrEmpty(daily.inspirationSummary);
    const savedCount = firstCount([summary], ['count', 'inspirationCount', 'savedCount', 'curatedCount']);
    if (savedCount <= 0) return null;
    const sourceLikeCount = firstCount([summary], ['sourceLikeCount', 'sourceLikes', 'likeCount', 'likes']);
    return {
      title: '本轮收获已保存',
      countText: `${compactCount(savedCount)} 条创作灵感`,
      heatText: sourceLikeCount > 0 ? `${compactCount(sourceLikeCount)}赞` : '',
      hasHeat: sourceLikeCount > 0,
    };
  }

  function guidanceReleaseAt(window) {
    if (!window) return null;
    return window.releaseAt !== null ? window.releaseAt : window.expiresAt;
  }

  function dayBrowseComplete(window) {
    return Boolean(window && window.active && !window.expired && window.view && window.view.cap > 0 && window.view.complete);
  }

  function fallbackResumeText(status, nowMs) {
    const windows = status && status.dailyUsage && objectOrEmpty(status.dailyUsage).windows;
    if (!windows || typeof windows !== 'object') return '';
    for (const key of ['session', 'hour', 'minute']) {
      const raw = objectOrEmpty(windows)[key];
      if (!raw || typeof raw !== 'object') continue;
      const releaseAt = finiteNumber(raw.releaseAt);
      const expiresAt = finiteNumber(raw.expiresAt);
      const wait = futureWaitText(releaseAt !== null ? releaseAt : expiresAt, nowMs);
      if (!wait) continue;
      return `约 ${wait}自动继续`;
    }
    return '';
  }

  function hasBrowseRestSignal(status, window, strict) {
    if (!window || !window.active || window.expired) return false;
    const observed = observedCount(status, window);
    const inspirations = inspirationCount(status, window);
    const browseComplete = window.view && window.view.cap > 0 && window.view.complete;
    if (strict) return Boolean(browseComplete && observed > 0);
    return observed > 0 || inspirations > 0;
  }

  function intervalGuidance(status, window, key, nowMs) {
    const wait = futureWaitText(guidanceReleaseAt(window), nowMs);
    if (!wait) return null;
    const isSession = key === 'session';
    const observed = observedCount(status, window);
    const inspirations = inspirationCount(status, window);
    const day = guidanceWindow(status, 'day', nowMs);
    return {
      mode: key,
      mascot: 'monitoring',
      animate: false,
      kicker: isSession ? '' : '这一小时的探索告一段落',
      title: isSession ? '先整理一下刚才发现的方向。' : '先让平台认识你一点。',
      value: '停一停不是失去进度，而是为下一轮寻找留出自然节奏。',
      detail: '',
      steps: guidanceSteps(observed, inspirations),
      progress: explorationProgress(status, window, true, day),
      resume: '',
      note: '',
    };
  }

  function dayCompletionFresh(status, nowMs) {
    const day = guidanceWindow(status || {}, 'day', nowMs);
    const wait = futureWaitText(guidanceReleaseAt(day), nowMs);
    return wait ? `预计约 ${wait}开启新一天计划` : '';
  }

  function guidanceSteps(observed, inspirations) {
    const browseDetail = inspirations > 0 ? `${inspirations} 条灵感已记录` : `${observed} 条首页内容已观察`;
    return [
      { icon: 'browse', state: 'done', label: '浏览与互动', detail: browseDetail },
      { icon: 'pause', state: 'current', label: '留出自然间隔', detail: '让账号信号更清晰' },
      { icon: 'search', state: 'next', label: '继续寻找灵感', detail: '推荐内容更聚焦' },
    ];
  }

  function runtimeGuidanceView(status, nowMs, platform) {
    const s = status || {};
    const facebook = platform === 'facebook';
    // Facebook 未启动时，缓存的首帖 / 窗口 / 今日成果不代表自动化仍在推进。
    // 只匹配标准化后的 stopped；待机、暂停、排队、启动与异常继续走既有证据规则。
    if (facebook && lifecycleView(s).automationState === 'stopped') return null;
    const firstPost = firstPostGuidance(s);
    // Facebook 保留完整的人设完成弹窗，但主运行区不再重复展示寻找/生成首作的大卡。
    if (firstPost) return facebook ? null : firstPost;
    const p = s.presence || null;
    const at = p && p.at ? Date.parse(p.at) : NaN;
    const running = s.edge === 'running' && s.session === 'running';
    const fresh = Number.isFinite(at) && nowMs - at < PRESENCE_FRESH_MS;
    const day = guidanceWindow(s, 'day', nowMs);
    const harvest = inspirationHarvest(s);
    if (dayBrowseComplete(day)) {
      return {
        mode: 'day',
        mascot: 'celebration',
        animate: false,
        kicker: '探索完成',
        title: '今天先到这里，明天继续。',
        value: '今天累积的信号，会让下一次开始更容易找到方向。',
        detail: '',
        steps: [
          { icon: 'circleCheck', state: 'done', label: '浏览与互动', detail: '今日浏览计划已完成' },
          { icon: 'bookmarkCheck', state: 'done', label: '自然沉淀', detail: '让账号信号持续积累' },
          { icon: 'sunrise', state: 'next', label: '继续寻找灵感', detail: '明天继续探索新机会' },
        ],
        resume: '',
        harvest,
      };
    }
    if (running && p && p.text && fresh) {
      // 顶部真实动作与今日进展已经承载运行状态；Facebook 不再追加普通运行获得感卡。
      if (facebook) return null;
      const window = explorationWindow(s, nowMs);
      const progress = explorationProgress(s, window, false, day);
      if (harvest) {
        progress.meta = `已记录 ${harvest.countText}`;
        progress.hasOutcome = true;
      }
      return {
        mode: 'running',
        mascot: 'task-execution',
        animate: false,
        kicker: '正在理解目标人群喜欢什么',
        title: '正在缩小创作方向。',
        value: '刷首页不是漫无目的，而是在寻找目标人群已经验证过的方向。',
        detail: '',
        progress,
        resume: '',
      };
    }

    if (day && day.active && !day.expired && day.capped.length > 0 && day.capped.every((entry) => entry.cap > 0 && entry.complete)) {
      return {
        mode: 'day',
        mascot: 'celebration',
        animate: false,
        kicker: '探索完成',
        title: '今天先到这里，明天继续。',
        value: '今天累积的信号，会让下一次开始更容易找到方向。',
        detail: '',
        steps: [
          { icon: 'circleCheck', state: 'done', label: '浏览与互动', detail: `${day.capped.length} 项今日计划已完成` },
          { icon: 'bookmarkCheck', state: 'done', label: '自然沉淀', detail: '让账号信号持续积累' },
          { icon: 'sunrise', state: 'next', label: '继续寻找灵感', detail: '明天继续探索新机会' },
        ],
        resume: '',
        harvest,
      };
    }

    for (const key of ['session', 'hour']) {
      const window = guidanceWindow(s, key, nowMs);
      if (!hasBrowseRestSignal(s, window, true)) continue;
      const guidance = intervalGuidance(s, window, key, nowMs);
      if (guidance) return guidance;
    }

    if (s.session === 'resting') {
      const sessionWindow = guidanceWindow(s, 'session', nowMs);
      if (hasBrowseRestSignal(s, sessionWindow, false)) {
        const guidance = intervalGuidance(s, sessionWindow, 'session', nowMs);
        if (guidance) return guidance;
      }
    }
    return null;
  }

  function quotaCompletionPresence(status, nowMs) {
    const guidance = runtimeGuidanceView(status, nowMs);
    if (!guidance || guidance.mode === 'running' || guidance.mode === 'first-post') return null;
    const text = guidance.mode === 'day'
      ? '今日内容探索已经完成'
      : guidance.mode === 'session'
        ? '本轮浏览完成，正在为下一轮留出自然节奏'
        : '这一小时的探索告一段落，稍后会继续';
    const fresh = guidance.mode === 'day' ? dayCompletionFresh(status, nowMs) : fallbackResumeText(status, nowMs);
    return { text, animate: false, fresh };
  }

  function presenceView(status, nowMs) {
    const s = status || {};
    const p = s.presence || null;
    const at = p && p.at ? Date.parse(p.at) : NaN;
    const hasFresh = Number.isFinite(at) && nowMs - at < PRESENCE_FRESH_MS;
    const running = s.edge === 'running' && s.session === 'running';
    // 静态诚实态也带时间戳（真实的状态时刻，不是假装活跃）——否则新鲜度行留白过大。
    const staticFresh = Number.isFinite(at) ? `状态更新 · ${relTime(at, nowMs)}` : '';

    // 非运行态：诚实静态文案，presence 历史文本不再当「正在做」展示。
    if (loginFlowState(s) === 'failed') {
      return { text: loginFlowFailureDetail(s), animate: false, fresh: staticFresh };
    }
    if (s.session === 'paused') return { text: '已暂停，浏览器保持打开', animate: false, fresh: staticFresh };
    // 只有主进程明确标出「仅关闭本机自动化」时，才采用这次原子写入的范围文案；普通关闭继续讲
    // 「已关闭浏览器」，也绝不能让任意历史 presence 文本在关闭态复活。
    if (s.session === 'closed') {
      const text = s.closeScope === 'local_automation_only' && p && p.text ? p.text : '已关闭浏览器';
      return { text, animate: false, fresh: staticFresh };
    }
    if (s.auth === 'login required') {
      return {
        text: authAttentionDetail(s) || '等你登录小红书后继续',
        animate: false,
        fresh: '',
      };
    }
    if (s.auth === 'config required') return { text: '等待完成初始设置', animate: false, fresh: '' };
    // restricted 会主动暂停自动运营并可能关闭浏览器进入冷待机；它不是「本轮配额已完成」，
    // 也不能展示 resting 的自动继续倒计时（平台阻断未解除时并不会按那个时刻正常续跑）。
    if (s.risk === 'restricted') {
      return { text: '账号受限，自动运营已暂停', animate: false, fresh: '确认 Facebook 已可正常使用后，可解除受限' };
    }
    if (s.edge === 'warning') return { text: '引擎已停止，请查看详情或重新启动', animate: false, fresh: staticFresh };
    if (s.edge === 'starting') return { text: '正在启动引擎…', animate: true, fresh: '' };
    const quotaCompletion = quotaCompletionPresence(s, nowMs);
    if (s.session === 'resting') {
      return quotaCompletion || { text: '这一轮已经完成，稍作等待后会自动继续', animate: false, fresh: fallbackResumeText(s, nowMs) || staticFresh };
    }
    if (!running) return { text: '待命中', animate: false, fresh: staticFresh };

    // 终态优先：当日浏览额度已跑满时，终态压过仍在新鲜期内的中途动作文案——否则同屏的探索进度卡
    // 已经在说「今天先到这里」，这一行还在说「顺路去作者主页看看…」，两块 UI 就同一份数据互相打脸。
    // 只在云端下发的当日额度真跑满时才出终态（quotaCompletionPresence 拿不到依据就返回 null），
    // 客户端绝不自行推断「今日已完成」——那是新造一次假成功。
    if (quotaCompletion) {
      return {
        text: quotaCompletion.text,
        animate: false,
        fresh: quotaCompletion.fresh,
      };
    }

    if (p && p.text && hasFresh) {
      // 一分钟内才算「此刻正在做」；之后动作文案照留，但动效与「刚刚更新」撤掉、改说等了多久。
      // 这一格正是「执行端已做完、球在云端」（如进主页后要过一次大模型决定是否关注）的真实处境。
      if (nowMs - at < PRESENCE_LIVE_MS) {
        return { text: p.text, animate: true, fresh: `刚刚更新 · ${relTime(at, nowMs)}` };
      }
      return { text: p.text, animate: false, fresh: `已等待 · ${waitedText(at, nowMs)}` };
    }
    // 在跑但事件已不新鲜：如实说「没有新动态」，绝不假装仍在忙。
    return {
      text: '有一会儿没有新动态了',
      animate: false,
      fresh: Number.isFinite(at) ? `最后动态 · ${relTime(at, nowMs)}` : '',
    };
  }

  // ── 发布卡（常驻，四个内容态，只读投影）──
  // flow：进行中（pending →(30min 琥珀化)→ [reminded 仅收到明确事件] → approved）
  // submitted：提交动作已被接受、公开结果未确认（绝不冒充 published / last）
  // last：上次已确认发布（published / 本地或云端带回的最近发布记录），四节点全勾
  // empty：从未发布，幽灵旅程 + 空态文案
  // 终态另产 collapsed（折进活动流一条记录，渲染层按签名去重）。
  const PUBLISH_WAIT_HOT_MS = 30 * 60_000;
  const PUBLISH_STEPS = ['写好内容', '发到飞书', '等你确认', '择时发布'];
  const FACEBOOK_PUBLISH_STEPS = ['准备内容', '发布审批', '提交平台', '发布结果'];
  /**
   * 下发阻塞原因 → 人话（change publish-approval-signal-to-database）。
   * 未知原因**原样透出**，绝不吞成「无原因」——没有原因恰恰是最需要被看见的那种情形。
   */
  const DISPATCH_BLOCKED_LABELS = {
    edge_offline_waiting: '客户端核心暂时离线',
    browser_slot_waiting: '浏览器在等本机可用槽位',
    breaker_open: '该账号下发暂停，待人工确认',
    captcha_paused: '账号正处于验证码 / 风控暂停',
    approval_unreadable: '授权状态暂时读不到（不会误发）',
  };
  function dispatchBlockedLabel(reason) {
    if (typeof reason !== 'string' || !reason) return '';
    return DISPATCH_BLOCKED_LABELS[reason] || reason;
  }

  function publishView(publish, lastPublish, nowMs, platform = 'xiaohongshu') {
    const at = publish && publish.at ? Date.parse(publish.at) : nowMs;
    const waitedMs = Math.max(0, nowMs - (Number.isFinite(at) ? at : nowMs));
    const waitedMin = Math.floor(waitedMs / 60_000);
    const title = (publish && publish.title) || '';
    const state = publish ? publish.state : null;
    const facebook = platform === 'facebook';

    const base = {
      steps: facebook ? FACEBOOK_PUBLISH_STEPS : PUBLISH_STEPS,
      title,
      code: (publish && publish.code) || '',
      collapsed: null,
      showLink: false,
      platform: facebook ? 'facebook' : 'xiaohongshu',
    };

    if (state === 'pending' || state === 'reminded') {
      const hot = waitedMs >= PUBLISH_WAIT_HOT_MS;
      return {
        ...base,
        mode: 'flow',
        showLink: false,
        head: facebook ? '一条 Facebook 内容等你确认' : 'AI 写好了一条新笔记',
        corner: waitedMin < 1 ? '刚刚发出' : `已等 ${waitedMin} 分钟`,
        cornerHot: hot,
        stepStates: facebook ? ['done', 'cur', 'todo', 'todo'] : ['done', 'done', 'cur', 'todo'],
        curCalm: false,
        // 红线：只有收到明确的「已再提醒」事件才这么说；单纯等得久绝不谎称已提醒。
        foot: facebook
          ? (state === 'reminded'
            ? '内容仍待确认 · 可在内容预览里**发布 / 取消**'
            : '内容可在预览中直接**发布 / 取消**，审批结果会自动同步到这里。')
          : (state === 'reminded'
            ? '稿件仍待确认 · 可在稿件预览里**发布 / 取消**'
            : '全文在稿件预览里，可直接**发布 / 取消**，审批结果会自动同步到这里。'),
      };
    }
    if (state === 'approved') {
      // 「已批准·待下发」（change publish-approval-signal-to-database）：批准之后、真正开始下发之前
      // 是一个独立可见的状态。字段缺省（旧云端）时**行为与今天完全一致**，绝不显示为失败。
      const dispatchState = typeof publish.dispatchState === 'string' ? publish.dispatchState : '';
      if (dispatchState === 'pending_dispatch' || dispatchState === 'blocked') {
        const blocked = dispatchBlockedLabel(publish.dispatchBlockedReason);
        return {
          ...base,
          mode: 'flow',
          showLink: false,
          head: facebook ? '内容已批准，待下发' : '已批准，待下发',
          corner: '待下发',
          cornerHot: false,
          stepStates: facebook ? ['done', 'done', 'cur', 'todo'] : ['done', 'done', 'done', 'cur'],
          curCalm: true,
          foot: blocked
            ? `**已批准，尚未开始下发** · ${blocked}；恢复后会自动继续，无需重新批准`
            : '**已批准，尚未开始下发** · 正在排队等待执行，无需重新批准',
        };
      }
      return {
        ...base,
        mode: 'flow',
        showLink: false,
        head: facebook ? '内容已确认，等待提交' : '已确认发布',
        corner: facebook ? '等待提交' : '将择时发布',
        cornerHot: false,
        stepStates: facebook ? ['done', 'done', 'cur', 'todo'] : ['done', 'done', 'done', 'cur'],
        curCalm: true,
        foot: facebook
          ? '**无需操作** · 系统会按当前发布计划提交到 Facebook'
          : '**无需操作** · 系统会挑一个自然时段发出，发完这里会记一笔',
      };
    }

    if (state === 'submitted') {
      const submittedAt = Date.parse(publish.at || '');
      return {
        ...base,
        mode: 'submitted',
        collapsed: {
          type: 'submitted',
          sentence: title
            ? `${facebook ? '内容' : '笔记'}「${title}」已提交，待链接确认`
            : `一条${facebook ? '内容' : '笔记'}已提交，待链接确认`,
        },
        steps: facebook ? FACEBOOK_PUBLISH_STEPS : ['写好内容', '发到飞书', '等你确认', '确认结果'],
        head: facebook ? '已提交 Facebook，等待确认' : '已提交，平台确认中',
        corner: Number.isFinite(submittedAt) ? relTime(submittedAt, nowMs) : '',
        cornerHot: false,
        title: title || (facebook ? '一条 Facebook 内容' : '一条新笔记'),
        stepStates: ['done', 'done', 'done', 'cur'],
        curCalm: true,
        foot: facebook
          ? '**无需重复操作** · 已提交 Facebook，正在确认公开结果'
          : '**无需重复操作** · 发布请求已提交，正在确认公开结果',
      };
    }

    // 终态：折一条进活动流；卡片本体转入「上次发布 / 空态」。
    let collapsed = null;
    let last = lastPublish || null;
    if (state === 'published') {
      collapsed = {
        type: 'published',
        sentence: title
          ? `${facebook ? '内容' : '笔记'}「${title}」已发布`
          : `一条${facebook ? '内容' : '笔记'}已发布`,
      };
      last = { title, at: publish.at }; // 刚发布的就是最近一次（主进程同时落盘持久化）
    } else if (state === 'rejected') {
      collapsed = { type: 'rejected', sentence: '你选择了取消发布 · 内容已留档' };
    } else if (state === 'failed') {
      collapsed = {
        type: 'failed',
        sentence: title
          ? `${facebook ? '内容' : '笔记'}「${title}」发布未成功，已如实记录`
          : '发布未成功，已如实记录',
      };
    }

    if (last && last.title) {
      const lastAt = Date.parse(last.at || '');
      return {
        ...base,
        mode: 'last',
        collapsed,
        showLink: false,
        head: facebook ? '最近一次 Facebook 发布' : '上次发布',
        corner: Number.isFinite(lastAt) ? relTime(lastAt, nowMs) : '',
        cornerHot: false,
        title: last.title,
        stepStates: ['done', 'done', 'done', 'done'],
        curCalm: false,
        foot: facebook
          ? '**已发布** · 下一条内容准备好后会在这里等待发布审批'
          : '**已发布** · 新笔记写好后会在这里等你确认',
      };
    }
    return {
      ...base,
      mode: 'empty',
      collapsed,
      showLink: false,
      head: facebook ? 'Facebook 内容发布' : '发布过的 AI 写好的笔记',
      corner: '',
      cornerHot: false,
      title: '还没有发布过内容',
      stepStates: ['todo', 'todo', 'todo', 'todo'],
      curCalm: false,
      foot: facebook
        ? 'AI 准备好 Facebook 内容后会先在这里等待**发布 / 取消**。'
        : 'AI 写好笔记后会先在这里等你**发布 / 取消**，确认后才会发布。',
    };
  }

  // 发布卡收展（dock）：进行中审批与已提交待确认永远展开；已发布历史与空态默认收起成薄条；
  // manualOpen 为用户点薄条的临时展开，空态不因引擎 / 会话运行状态改变默认收展。
  function publishDock(view, _status, manualOpen) {
    if (view.mode === 'flow' || view.mode === 'submitted') return { collapsed: false, label: '', summary: '' };
    if (view.mode === 'last') {
      return {
        collapsed: !manualOpen,
        label: view.title ? `已发布：${view.title}` : '已发布',
        summary: view.corner || '',
      };
    }
    return {
      collapsed: !manualOpen,
      label: view.platform === 'facebook' ? 'Facebook 内容发布' : '发布过的 AI 写好的笔记',
      summary: '还没有发布过内容',
    };
  }

  // ── 多环境 fleet（edge-multi-environment-fleet）：环境栏状态分级 / 分组 / 待处理计数 ──
  // 分级（状态点承担运行类别，平台头像与交互侧标保持正交）：
  //   error(红,需处理)     放弃重启终态 / 引擎异常
  //   attention(琥珀,需处理) 需登录 / 待配置 / 风控受限 / 账号重复运行 / 云端**断线**重连（连上过才算）
  //   launching(蓝)        启动中（含「本轮核心还没连上过云端」的首次连接窗口——那是启动，不是断线）
  //   stale(深黄)          状态心跳超阈值——失联，MUST NOT 呈现为在线
  //   running(绿)          运行中
  //   offline(灰)          已停止 / 已暂停
  const FLEET_STALE_MS = 5 * 60_000; // 状态投影超 5 分钟无任何更新即判失联（诚实：不确定 ≠ 在线）

  function fleetLevel(status, nowMs) {
    const s = lifecycleView(status);
    const result = (level, needsAction, label, state, railGroup, detail = '') => (
      { level, needsAction, label, state, railGroup, detail }
    );
    const edgeFailure = s.edgeFailure && typeof s.edgeFailure.summary === 'string' ? s.edgeFailure.summary.trim() : '';
    if (s.respawnGaveUp) return result('error', true, '已停机', 'error', 'attention', '错误 · 已放弃重启');
    if (loginFlowState(s) === 'failed') {
      return result('error', true, '异常', 'error', 'attention', loginFlowFailureDetail(s));
    }
    if (s.automationState === 'error' || ((s.coreState === 'error' || s.edge === 'warning') && s.automationState !== 'stopped')) {
      return result('error', true, '异常', 'error', 'attention', edgeFailure || '自动化引擎异常');
    }
    if (s.cloudRebind && s.cloudRebind.state === 'failed') return result('attention', true, '需重绑', 'attention', 'attention', '引擎重绑失败');
    // 阻断浮层待人工（登录/验证码/未知阻断，核心已本地暂停）：即便 edge 仍 running 也 MUST 浮顶为需处理，
    // 绝不呈现为绿色在线（多环境跨窗盯验证码是本控制台核心目的）。置于 running 判定之前。
    if (s.overlayBlocked) return result('attention', true, '需处理', 'attention', 'attention', '等待你处理');
    if (s.auth === 'login required') {
      const label = isFacebookManualAttention(s) ? '需处理' : '需登录';
      return result('attention', true, label, 'attention', 'attention', authAttentionDetail(s) || '需要登录平台');
    }
    if (s.auth === 'config required') return result('attention', true, '待配置', 'attention', 'attention', '需要完成初始设置');
    if (s.auth === 'chrome missing') return result('attention', true, '待配置', 'attention', 'attention', '缺少 Chrome');
    if (s.clientSessionState === 'signed_out' || s.clientSessionState === 'expired') return result('attention', true, '需登录', 'attention', 'attention', '需要登录客户端');
    if (s.risk === 'frozen') return result('error', true, '已暂停', 'error', 'attention', '账号已暂停');
    if (s.risk === 'restricted') return result('attention', true, '受限制', 'attention', 'attention', '账号受限');
    if (s.sameAccountWarning) return result('attention', true, '有冲突', 'attention', 'attention', '账号重复运行');
    if (s.browserState === 'error') return result('attention', true, '异常', 'attention', 'attention', '浏览器异常');
    if (loginFlowState(s) === 'automatic') {
      return result('launching', false, '登录中', 'starting', 'starting', '系统正在自动登录，无需人工操作');
    }
    if (s.automationState === 'waiting_resource') {
      return result('launching', false, '排队中', 'queued', 'queued', '等待浏览器执行位');
    }
    if (s.automationState === 'pausing') {
      return result('launching', false, '暂停中', 'starting', 'paused', '正在暂停自动化');
    }
    if (s.automationState === 'stopping') {
      return result('launching', false, '关闭中', 'starting', 'offline', '正在关闭自动化引擎');
    }
    if (s.automationState === 'starting') {
      const connecting = s.browserState === 'ready' && s.engineLinkState === 'connecting';
      return result('launching', false, connecting ? '连接中' : '启动中', 'starting', 'starting', connecting ? '浏览器已就绪，正在连接引擎' : '正在启动自动化');
    }
    if (s.automationState === 'ready' || s.automationState === 'running') {
      const at = Date.parse(s.updatedAt || '');
      if (Number.isFinite(at) && Number.isFinite(nowMs) && nowMs - at > FLEET_STALE_MS) {
        return result('stale', false, '失联', 'stale', 'offline', '状态长时间没有更新');
      }
      if (s.engineLinkState === 'connecting') return result('launching', false, '连接中', 'starting', 'starting', '正在连接引擎');
      if (s.engineLinkState === 'reconnecting') return result('attention', true, '重连中', 'attention', 'attention', '引擎连接正在恢复');
      if (s.automationState === 'running') return result('running', false, '运行中', 'running', 'running', '正在执行任务');
      if (s.browserState === 'closed') return result('running', false, '待机中', 'standby', 'standby', '引擎在线，浏览器已关闭且不占槽位');
      if (s.browserState === 'ready') return result('running', false, '待任务', 'ready', 'ready', '引擎和浏览器已就绪，等待任务');
      if (s.browserState === 'queued') return result('launching', false, '排队中', 'queued', 'queued', '等待浏览器执行位');
      return result('launching', false, '启动中', 'starting', 'starting', '正在准备浏览器');
    }
    if (s.automationState === 'paused') return result('offline', false, '已暂停', 'paused', 'paused', '自动化已暂停');
    return result('offline', false, '未启动', 'offline', 'offline', '自动化尚未启动');
  }

  // 需处理浮顶；普通环境按用户可理解的运行阶段分组。排队组按权威位次，其余同组保持花名册序。
  const FLEET_LEVEL_RANK = { error: 0, attention: 1, launching: 2, stale: 3, running: 4, offline: 5 };
  const FLEET_GROUP_RANK = { attention: 0, running: 1, ready: 2, starting: 3, queued: 4, standby: 5, paused: 6, offline: 7 };

  // 全客户端唯一规则位于 environment-display-name.cjs；uiLogic 只兼容既有消费入口。
  const resolveEnvironmentDisplayName = displayNameApi.resolveEnvironmentDisplayName;

  // 兼容既有左栏调用与测试；所有新消费位置应使用上面的来源感知解析器。
  function railDisplayName(row) {
    return resolveEnvironmentDisplayName(row).name;
  }

  /** 输入 [{envId, name, status}]，输出 { rows:[{envId,name,level,needsAction,label,status}], pendingCount }。 */
  function fleetRailModel(list, nowMs) {
    const rows = (Array.isArray(list) ? list : []).map((e, i) => {
      const lv = fleetLevel(e && e.status, nowMs);
      return {
        envId: e && e.envId,
        profileId: (e && e.profileId) || '',
        name: (e && (e.name || (e.status && e.status.envName))) || '',
        systemName: (e && e.systemName) || '',
        nameSource: e && e.nameSource === 'manual' ? 'manual' : undefined,
        nameSyncState: e && e.nameSource === 'manual'
          && (e.nameSyncState === 'synced' || e.nameSyncState === 'unsynced') ? e.nameSyncState : undefined,
        platform: (e && e.platform) || '', // 平台视觉标识（rail 行按平台上色）
        level: lv.level,
        needsAction: lv.needsAction,
        label: lv.label,
        detail: lv.detail,
        state: lv.state,
        railGroup: lv.railGroup,
        queuePosition: Number.isInteger(e && e.status && e.status.queuePosition) && e.status.queuePosition > 0
          ? e.status.queuePosition
          : null,
        rosterIndex: i,
        status: e && e.status,
      };
    });
    rows.sort((a, b) => {
      const groupOrder = FLEET_GROUP_RANK[a.railGroup] - FLEET_GROUP_RANK[b.railGroup];
      if (groupOrder !== 0) return groupOrder;
      const levelOrder = FLEET_LEVEL_RANK[a.level] - FLEET_LEVEL_RANK[b.level];
      if (levelOrder !== 0) return levelOrder;
      if (a.railGroup === 'queued') {
        const aPosition = a.queuePosition === null ? Number.POSITIVE_INFINITY : a.queuePosition;
        const bPosition = b.queuePosition === null ? Number.POSITIVE_INFINITY : b.queuePosition;
        if (aPosition !== bPosition) return aPosition - bPosition;
      }
      return a.rosterIndex - b.rosterIndex;
    });
    return { rows, pendingCount: rows.filter((r) => r.needsAction).length };
  }

  /** Batch start is complete only when automation is executing, or can execute immediately with a ready browser. */
  function batchStartReady(status) {
    const s = lifecycleView(status);
    return s.automationState === 'running'
      || (s.automationState === 'ready' && s.engineLinkState === 'connected' && s.browserState === 'ready');
  }

  // ── 环境级慢启动脚注行（change environment-level-slow-start）──
  //
  // 渲染契约（每一条都对着一个具体的谎）：
  // - **字段缺省 → 整行 hidden，绝不默认成「关」**：照 personaBound 三态判例（未知 ≠ 否）。
  //   云端还没说的时候显示一个没勾的框，等于替云端回答了「这个号没在养」。
  // - active + binding=true  → 「慢启动 · 第 3/7 天」
  // - active + binding=false → 「慢启动 · 第 5/7 天 · 当前档位已更严，不额外限制」
  //   慢启动语义是 min(曲线, 档位)，而档位数字面板可热编辑 → 勾了却一格没压是真实可达的状态。
  //   MUST NOT 宣称「正在压低配额」；让「没变」成为一个被明说的态，而不是看起来像 bug 的沉默。
  // - graduated → 「慢启动 · 已完成（X 月 X 日起上限已放开）」，显式告知而非静默消失
  //   ——上限是哪天放开的，正是最该被告知的那一刻。
  // - eligible=false 通常禁用；binding_unknown / binding_conflict 例外：配置属于环境，未绑定也可预设。
  //   此时 state/checked 是环境真态，reason 只说明当前没有唯一执行账号；绝不显示 binding/dayQuotas 已生效。
  // - **离线（内核 / 云链路断开）不再禁用开关**（change slow-start-offline-toggle）：慢启动真态是纯云端算的、
  //   写入执行体也在云端配额计算内、经运行时现读生效——这次写根本不经过环境内核。那道内核在线闸是 INCIDENTAL，
  //   摘掉。离线只影响**用量计数**（边缘上报的今日已做多少），对它单独打「可能已过期」标签，绝不据此禁用开关。
  // - 断连 → 字段不会变缺省（主进程 if (evt.dailyUsage) 不清空）→ 真态照常呈现，仅给用量计数打陈旧标签。
  //
  // 两条文案红线：全域不出现「新账号」（系统只知道它连上我们多少天，不知道它多老）；
  // 不暗示「动作更慢 / 更像真人」（clamp 只返回配额数字，完全不进 pacing）。
  const SLOW_START_INELIGIBLE_TEXT = {
    platform_unsupported: '该平台暂不支持慢启动',
    platform_unknown: '账号平台待确认，暂不启用慢启动',
    globally_disabled: '慢启动已被运维全局停用',
    binding_unknown: '设置跟随当前环境；登录账号后会按该环境的慢启动曲线生效',
    binding_conflict: '该账号同时出现在多个环境，当前配置不会被当作已生效；请先处理环境绑定冲突',
  };

  /** 「7 月 17 日」——毕业文案里只用到月/日。 */
  function monthDayCN(ms) {
    const d = new Date(ms);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }

  // source（change slow-start-offline-toggle）：'snapshot' = 来自边缘活快照的 dailyUsage（带用量计数，离线时陈旧）；
  // 'http' = 来自不依赖边缘的 env-scoped 读（纯云端真态，根本不带用量计数 ⇒ 无「陈旧」可言）。默认 'snapshot'（向后兼容）。
  function slowStartLine(dailyUsage, connState, source) {
    const ss = dailyUsage && dailyUsage.slowStart;
    // 字段缺省 = 云端还没说 → 整行不渲染（绝不默认 off）。
    if (!ss || typeof ss !== 'object') return { visible: false };
    const src = source === 'http' ? 'http' : 'snapshot';
    // **用量计数陈旧**只在「来自活快照 + 此刻离线」时成立；HTTP 读不带用量、无从陈旧。**慢启动真态永远新鲜**。
    const usageStale = src === 'snapshot' && connState !== 'online';
    const totalDays = Number.isFinite(ss.totalDays) ? ss.totalDays : 7;
    const out = { visible: true, checked: ss.state === 'active' || ss.state === 'graduated', stale: usageStale, badge: '', tone: ss.state, source: src };

    const environmentConfiguredOnly = ss.eligible === false
      && (ss.ineligibleReason === 'binding_unknown' || ss.ineligibleReason === 'binding_conflict')
      && (ss.state === 'off' || ss.state === 'active' || ss.state === 'graduated');
    if (ss.eligible === false && !environmentConfiguredOnly) {
      out.disabled = true;
      out.checked = false;
      out.reason = SLOW_START_INELIGIBLE_TEXT[ss.ineligibleReason] || '当前无法启用慢启动';
      return out;
    }
    // 慢启动真态是纯云端算的、写入执行体也在云端配额计算内、经运行时现读生效 → **离线也可改**：不再因内核 /
    // 云链路离线禁用开关（change slow-start-offline-toggle：那道内核在线闸 INCIDENTAL，这次写根本不经过环境内核）。
    out.disabled = false;
    if (environmentConfiguredOnly) {
      out.reason = SLOW_START_INELIGIBLE_TEXT[ss.ineligibleReason];
      out.configurationOnly = true;
    }
    // 离线时**只有用量计数**陈旧（真态与开关照常）：给用量那一条单独打标签，绝不说成「状态过期 / 开关不可用」。
    if (usageStale && !environmentConfiguredOnly) out.reason = '云端已断开，下方今日用量为最后一次同步、可能已过期';

    if (ss.state === 'active') {
      out.badge = `慢启动 · 第 ${ss.day}/${totalDays} 天`;
      // binding=false 必须说出口，否则「勾了没变」看起来就是个 bug。
      if (!environmentConfiguredOnly && ss.binding === false) out.badge += ' · 当前档位已更严，不额外限制';
    } else if (ss.state === 'graduated') {
      // 文案受本卡既有口径约束（#daily-summary 全域不得出现「已达 / 上限 / 额度 / 释放 / 已满」，
      // companion-ui 的陪伴式口径，有测试守着）→ 说「按正常档位执行」而非「上限已放开」。
      out.badge = Number.isFinite(ss.since)
        ? `慢启动 · 已完成（${monthDayCN(ss.since + totalDays * 86400000)}起按正常档位执行）`
        : '慢启动 · 已完成（已按正常档位执行）';
    }
    return out;
  }

  // ── 规则模式免人设的呈现口径（change facebook-rule-mode-without-persona）──
  //
  // Facebook 规则模式的四个动作（浏览、点赞、加群、模板评论）一个字都不读人设，所以云端为这类账号取消了
  // 「必须先绑人设才能起会话」的入口闸。界面上因此出现第四种真实状态：**账号确实没有人设，但它正在正常运行**。
  //
  // 呈现红线（每条对着一个具体的谎）：
  // - MUST NOT 沿用「待补人设」的说法与引导：那会让运营去补一份系统根本不会读的配置（纯空转），
  //   还会把「正在按规则跑」误传成「没跑起来」。
  // - MUST NOT 说成「已绑」：它确实没有人设。谎称已绑之后，真正需要人设的路径（普通浏览、发布、
  //   生成式评论）被诚实拒绝时就无从解释。
  // - 判据只认**已经读到的云端权威规则模式配置**。没读到 / 读失败 / 回包不完整一律按「未启用」处理，
  //   回到既有三态呈现——照 personaBound 三态判例：未知绝不等同已启用，绝不由本地状态反推。
  //
  // 同一条判据在受控页横幅侧另有一份（`persona-notice.cjs`，主进程不加载本模块）；两处改动必须同步。
  const RULE_MODE_WITHOUT_PERSONA_BADGE = '按规则运行';
  const RULE_MODE_WITHOUT_PERSONA_NOTE = '这个账号没有人设，正按云端规则模式运行：选卡、点赞与模板评论都不读人设，无需为它补人设。若要让它做普通浏览或发布，仍需先设置人设。';

  /**
   * 判定某账号此刻是否应呈现为「按规则运行、未绑人设」。
   *
   * - `platform`：该环境的平台（规范 id）。例外只在 Facebook 成立。
   * - `personaBound`：云端权威绑定态三态。只有 `=== false`（云端确认未绑）才算数；true/未知都不是这一态。
   * - `ruleMode`：客户端**已拿到的**云端权威规则模式配置对象（含 `enabled`）；null / undefined = 还没读到。
   */
  function facebookRuleModeWithoutPersona(input) {
    const raw = input && typeof input === 'object' ? input : {};
    if (raw.platform !== 'facebook') return false;
    if (raw.personaBound !== false) return false;
    const ruleMode = raw.ruleMode;
    return Boolean(ruleMode && typeof ruleMode === 'object' && ruleMode.enabled === true);
  }

  function formatReceivedBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const amount = bytes / (1024 ** index);
    const digits = index === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toFixed(digits)} ${units[index]}`;
  }

  /** 只呈现配置、Inactive 启动前的 Facebook 可达性结果和本次接管流量。 */
  function proxyRuntimeView(runtime, configuration, preflight) {
    const evidence = runtime && typeof runtime === 'object' ? runtime : {};
    const config = configuration && typeof configuration === 'object' ? configuration : {};
    const early = preflight && typeof preflight === 'object' ? preflight : {};
    const noProxy = config.known === true && config.noProxy === true;
    const bytes = formatReceivedBytes(evidence.sessionReceivedBytes);
    let label = '待检测';
    let tone = 'pending';
    if (noProxy) {
      label = '未配置代理';
      tone = 'danger';
    } else if (early.state === 'checking') {
      label = '代理检测中';
      tone = 'pending';
    } else if (early.state === 'available') {
      label = '代理可用';
      tone = 'verified';
    } else if (early.state === 'unavailable') {
      label = '代理不可用';
      tone = 'danger';
    } else if (early.state === 'unknown') {
      label = '无法确认';
      tone = 'unknown';
    }
    return {
      label,
      tone,
      bytes,
      compact: `${label} · 本次 ${bytes}`,
      configuration: config.summary || (config.known ? '无代理配置' : '配置待读取'),
      checkedAt: early.checkedAt || '',
    };
  }

  return { relTime, synthesizeHealth, bandTone, detailRows, presenceView, runtimeGuidanceView, publishView, publishDock, PRESENCE_FRESH_MS, PUBLISH_WAIT_HOT_MS, fleetLevel, fleetRailModel, batchStartReady, resolveEnvironmentDisplayName, railDisplayName, slowStartLine, facebookRuleModeWithoutPersona, RULE_MODE_WITHOUT_PERSONA_BADGE, RULE_MODE_WITHOUT_PERSONA_NOTE, formatReceivedBytes, proxyRuntimeView, FLEET_STALE_MS };
});
