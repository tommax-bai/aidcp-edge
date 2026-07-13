'use strict';

// 陪伴式界面的纯视图逻辑（edge-companion-ui）：健康合成 / 在场感动效门 / 发布卡状态机 / 相对时间。
// 无 DOM、无 Electron 依赖——浏览器里挂 window.uiLogic，node:test 里经 createRequire 直接单测。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.uiLogic = api;
})(typeof window !== 'undefined' ? window : null, function () {
  // ── 相对时间：诚实走字（「刚刚 / N 秒前 / N 分钟前 / N 小时前」）──
  function relTime(fromMs, nowMs) {
    const diff = Math.max(0, nowMs - fromMs);
    if (diff < 5_000) return '刚刚';
    if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return `${Math.floor(diff / 86_400_000)} 天前`;
  }

  // ── 健康合成：五路技术状态 → 一句结论 + 色调。真正中断与可恢复协助分级。──
  const AUTH_ATTENTION = { 'login required': '需要登录小红书', 'chrome missing': '本机缺少 Chrome', 'config required': '需要完成初始设置' };

  function synthesizeHealth(status) {
    const s = status || {};
    const edgeFailure = s.edgeFailure && typeof s.edgeFailure.summary === 'string' ? s.edgeFailure.summary.trim() : '';
    if (s.edge === 'warning') return { code: 'error', label: '运行异常', detail: edgeFailure || '引擎未能继续运行，请查看详情后重新启动' };
    if (s.risk === 'frozen') return { code: 'error', label: '账号已暂停', detail: '账号当前无法继续操作，请查看详情' };
    if (AUTH_ATTENTION[s.auth]) return { code: 'attention', label: '需要协助', detail: AUTH_ATTENTION[s.auth] };
    if (s.risk === 'restricted') return { code: 'attention', label: '节奏已调整', detail: '账号互动暂时受限，已自动放慢节奏' };
    if (s.edge === 'running' && s.session === 'running' && s.cloud !== 'connected') {
      return { code: 'attention', label: '正在重新连接', detail: '连接恢复后会自动继续' };
    }
    if (s.session === 'paused') return { code: 'paused', label: '已暂停', detail: '浏览器保持打开；可恢复或关闭' };
    if (s.session === 'closed') return { code: 'ready', label: '已关闭', detail: '浏览器已关闭，点右下角「启动」重新打开' };
    if (s.edge === 'running' && s.session === 'resting') return { code: 'paused', label: '等待下一轮', detail: '当前阶段完成后会自动继续' };
    if (s.edge === 'starting') return { code: 'ready', label: '正在启动…', detail: '引擎启动中' };
    if (s.edge === 'running' && s.session === 'running') {
      return { code: 'running', label: s.risk === 'warned' ? '运行中 · 放慢节奏' : '运行中 · 一切正常', detail: '' };
    }
    return { code: 'ready', label: '就绪', detail: '点右下角「启动」开始' };
  }

  // 标题带色调：可恢复的节奏调整用琥珀，只有冻结使用红色。
  function bandTone(status) {
    const risk = (status || {}).risk;
    if (risk === 'frozen') return 'danger';
    if (risk === 'warned' || risk === 'restricted') return 'warned';
    return 'normal';
  }

  // 五路明细的人话标签（内部词 → 客户能懂的话）。
  const DETAIL_LABELS = {
    auth: { label: '小红书登录', values: { checking: '检测中', 'login required': '需要登录', 'logged in': '已登录', 'chrome missing': '缺少 Chrome', 'config required': '待完成设置' } },
    cloud: { label: '云端连接', values: { disconnected: '未连接', connected: '已连接' } },
    session: { label: '自动运营', values: { idle: '待命', running: '进行中', resting: '等待下一轮', paused: '已暂停', closed: '已关闭' } },
    risk: { label: '账号保护', values: { normal: '正常', warned: '谨慎放慢', restricted: '已调整节奏', frozen: '已暂停' } },
    edge: { label: '本机引擎', values: { stopped: '已停止', starting: '启动中', running: '运行中', warning: '需要处理' } },
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
  const QUOTA_ACTION_PRIORITY = ['view', 'like', 'collect', 'comment', 'follow', 'publish'];

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function count(value) {
    const n = finiteNumber(value);
    return n === null ? 0 : Math.max(0, Math.floor(n));
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

  function usageCount(status, window, keys) {
    const daily = objectOrEmpty(objectOrEmpty(status).dailyUsage);
    return firstCount([window && window.totals, daily.totals, objectOrEmpty(status).stats], keys);
  }

  function observedCount(status, window) {
    return usageCount(status, window, ['view', 'views']);
  }

  function inspirationCount(status, window) {
    return usageCount(status, window, ['inspiration', 'inspirations', 'candidate', 'candidates', 'collect', 'collects']);
  }

  function guidanceReleaseAt(window) {
    if (!window) return null;
    return window.releaseAt !== null ? window.releaseAt : window.expiresAt;
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
    return {
      mode: key,
      mascot: 'monitoring',
      animate: false,
      kicker: isSession ? '' : '这一小时的探索告一段落',
      title: isSession ? '先整理一下刚才发现的方向。' : '先让平台认识你一点。',
      value: '停一停不是失去进度，而是为下一轮寻找留出自然节奏。',
      detail: '',
      steps: guidanceSteps(observedCount(status, window), inspirationCount(status, window)),
      resume: `约 ${wait}自动继续`,
      note: isSession ? '本轮进展已记录' : '本小时进展已记录',
    };
  }

  function guidanceSteps(observed, inspirations) {
    const browseDetail = inspirations > 0 ? `${inspirations} 条灵感已记录` : `${observed} 条首页内容已观察`;
    return [
      { icon: 'browse', state: 'done', label: '浏览与互动', detail: browseDetail },
      { icon: 'pause', state: 'current', label: '留出自然间隔', detail: '让账号信号更清晰' },
      { icon: 'search', state: 'next', label: '继续寻找灵感', detail: '推荐内容更聚焦' },
    ];
  }

  function runtimeGuidanceView(status, nowMs) {
    const s = status || {};
    const p = s.presence || null;
    const at = p && p.at ? Date.parse(p.at) : NaN;
    const running = s.edge === 'running' && s.session === 'running';
    const fresh = Number.isFinite(at) && nowMs - at < PRESENCE_FRESH_MS;
    if (running && p && p.text && fresh) {
      return {
        mode: 'running',
        mascot: 'task-execution',
        animate: true,
        kicker: '为你探索',
        title: '正在首页为你寻找更容易被看见的内容灵感',
        detail: '观察平台推荐的内容，寻找正在上升的话题。',
        steps: [],
        resume: '',
      };
    }

    const day = guidanceWindow(s, 'day', nowMs);
    if (day && day.active && !day.expired && day.capped.length > 0 && day.capped.every((entry) => entry.cap > 0 && entry.complete)) {
      const wait = futureWaitText(day.expiresAt, nowMs);
      return {
        mode: 'day',
        mascot: 'celebration',
        animate: false,
        kicker: '今日探索完成',
        title: '今天先到这里，明天继续。',
        value: '今天累积的信号，会让下一次开始更容易找到方向。',
        detail: '',
        steps: [
          { icon: 'browse', state: 'done', label: '浏览与互动', detail: `${day.capped.length} 项今日计划已完成` },
          { icon: 'pause', state: 'done', label: '自然沉淀', detail: '让账号信号持续积累' },
          { icon: 'search', state: 'next', label: '继续寻找灵感', detail: '明天继续探索新机会' },
        ],
        resume: wait ? `预计约 ${wait}开启新一天计划` : '',
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
    if (!guidance || guidance.mode === 'running') return null;
    const text = guidance.mode === 'day'
      ? '今日内容探索已经完成'
      : guidance.mode === 'session'
        ? '本轮浏览完成，正在为下一轮留出自然节奏'
        : '这一小时的探索告一段落，稍后会继续';
    return { text, animate: false, fresh: guidance.resume || '' };
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
    if (s.session === 'paused') return { text: '已暂停，浏览器保持打开', animate: false, fresh: staticFresh };
    if (s.session === 'closed') return { text: '已关闭浏览器', animate: false, fresh: staticFresh };
    if (s.auth === 'login required') return { text: '等你登录小红书后继续', animate: false, fresh: '' };
    if (s.auth === 'config required') return { text: '等待完成初始设置', animate: false, fresh: '' };
    if (s.edge === 'warning') return { text: '引擎已停止，请查看详情或重新启动', animate: false, fresh: staticFresh };
    if (s.edge === 'starting') return { text: '正在启动引擎…', animate: true, fresh: '' };
    const quotaCompletion = quotaCompletionPresence(s, nowMs);
    if (s.session === 'resting') {
      return quotaCompletion || { text: '这一轮已经完成，稍作等待后会自动继续', animate: false, fresh: staticFresh };
    }
    if (!running) return { text: '待命中', animate: false, fresh: staticFresh };

    if (p && p.text && hasFresh) {
      return { text: p.text, animate: true, fresh: `刚刚更新 · ${relTime(at, nowMs)}` };
    }
    if (quotaCompletion) {
      return {
        text: quotaCompletion.text,
        animate: false,
        fresh: quotaCompletion.fresh,
      };
    }
    // 在跑但事件已不新鲜：如实说「没有新动态」，绝不假装仍在忙。
    return {
      text: '有一会儿没有新动态了',
      animate: false,
      fresh: Number.isFinite(at) ? `最后动态 · ${relTime(at, nowMs)}` : '',
    };
  }

  // ── 浏览循环 chip：feed → select → read → write/comment/interact → return ──
  const LOOP_STAGES = ['feed', 'select', 'read', 'write', 'comment', 'interact', 'return'];
  function loopIndex(stage) {
    const i = LOOP_STAGES.indexOf(stage);
    return i === -1 ? -1 : i;
  }

  // ── 发布卡（常驻，三个内容态，只读投影）──
  // flow：进行中（pending →(30min 琥珀化)→ [reminded 仅收到明确事件] → approved）
  // last：上次已确认发布（published / 本地或云端带回的最近发布记录），四节点全勾
  // empty：从未发布，幽灵旅程 + 空态文案
  // 终态另产 collapsed（折进活动流一条记录，渲染层按签名去重）。
  const PUBLISH_WAIT_HOT_MS = 30 * 60_000;
  const PUBLISH_STEPS = ['写好内容', '发到飞书', '等你确认', '择时发布'];

  function publishView(publish, lastPublish, nowMs) {
    const at = publish && publish.at ? Date.parse(publish.at) : nowMs;
    const waitedMs = Math.max(0, nowMs - (Number.isFinite(at) ? at : nowMs));
    const waitedMin = Math.floor(waitedMs / 60_000);
    const title = (publish && publish.title) || '';
    const state = publish ? publish.state : null;

    const base = {
      steps: PUBLISH_STEPS,
      title,
      code: (publish && publish.code) || '',
      collapsed: null,
      showLink: false,
    };

    if (state === 'pending' || state === 'reminded') {
      const hot = waitedMs >= PUBLISH_WAIT_HOT_MS;
      return {
        ...base,
        mode: 'flow',
        showLink: false,
        head: 'AI 写好了一条新笔记',
        corner: waitedMin < 1 ? '刚刚发出' : `已等 ${waitedMin} 分钟`,
        cornerHot: hot,
        stepStates: ['done', 'done', 'cur', 'todo'],
        curCalm: false,
        // 红线：只有收到明确的「已再提醒」事件才这么说；单纯等得久绝不谎称已提醒。
        foot: state === 'reminded'
          ? '稿件仍待确认 · 可在稿件预览里**发布 / 取消**'
          : '全文在稿件预览里，可直接**发布 / 取消**，审批结果会自动同步到这里。',
      };
    }
    if (state === 'approved') {
      return {
        ...base,
        mode: 'flow',
        showLink: false,
        head: '已确认发布',
        corner: '将择时发布',
        cornerHot: false,
        stepStates: ['done', 'done', 'done', 'cur'],
        curCalm: true,
        foot: '**无需操作** · 系统会挑一个自然时段发出，发完这里会记一笔',
      };
    }

    // 终态：折一条进活动流；卡片本体转入「上次发布 / 空态」。
    let collapsed = null;
    let last = lastPublish || null;
    if (state === 'submitted') {
      collapsed = { type: 'submitted', sentence: title ? `笔记「${title}」已提交，待链接确认` : '一条笔记已提交，待链接确认' };
    } else if (state === 'published') {
      collapsed = { type: 'published', sentence: title ? `笔记「${title}」已发布` : '一条笔记已发布' };
      last = { title, at: publish.at }; // 刚发布的就是最近一次（主进程同时落盘持久化）
    } else if (state === 'rejected') {
      collapsed = { type: 'rejected', sentence: '你选择了取消发布 · 内容已留档' };
    } else if (state === 'failed') {
      collapsed = { type: 'failed', sentence: title ? `笔记「${title}」发布未成功，已如实记录` : '发布未成功，已如实记录' };
    }

    if (last && last.title) {
      const lastAt = Date.parse(last.at || '');
      return {
        ...base,
        mode: 'last',
        collapsed,
        showLink: false,
        head: '上次发布',
        corner: Number.isFinite(lastAt) ? relTime(lastAt, nowMs) : '',
        cornerHot: false,
        title: last.title,
        stepStates: ['done', 'done', 'done', 'done'],
        curCalm: false,
        foot: '**已发布** · 新笔记写好后会在这里等你确认',
      };
    }
    return {
      ...base,
      mode: 'empty',
      collapsed,
      showLink: false,
      head: '发布过的 AI 写好的笔记',
      corner: '',
      cornerHot: false,
      title: '还没有发布过内容',
      stepStates: ['todo', 'todo', 'todo', 'todo'],
      curCalm: false,
      foot: 'AI 写好笔记后会先在这里等你**发布 / 取消**，确认后才会发布。',
    };
  }

  // 发布卡收展（dock）：进行中审批永远展开；运行中且无在途审批 → 自动收起成薄条（版面让给活动流）；
  // 未运行时保持展开（空态旅程有引导价值）。manualOpen 为用户点薄条的临时展开。
  function publishDock(view, status, manualOpen) {
    const s = status || {};
    const running = s.edge === 'running' && s.session === 'running';
    if (view.mode === 'flow') return { collapsed: false, summary: '' };
    const summary = view.mode === 'last'
      ? `上次发布 · ${view.corner || ''}`.replace(/ · $/, '')
      : '还没有发布过内容';
    return { collapsed: running && !manualOpen, summary };
  }

  // ── 多环境 fleet（edge-multi-environment-fleet）：环境栏状态环分级 / 紧迫度排序 / 待处理计数 ──
  // 分级（收起态由头像外圈色环承担）：
  //   error(红,需处理)     放弃重启终态 / 引擎异常
  //   attention(琥珀,需处理) 需登录 / 待配置 / 风控受限 / 账号重复运行 / 云端重连
  //   launching(蓝)        启动中
  //   stale(深黄)          状态心跳超阈值——失联，MUST NOT 呈现为在线
  //   running(绿)          运行中
  //   offline(灰)          已停止 / 已暂停
  const FLEET_STALE_MS = 5 * 60_000; // 状态投影超 5 分钟无任何更新即判失联（诚实：不确定 ≠ 在线）

  function fleetLevel(status, nowMs) {
    const s = status || {};
    if (s.respawnGaveUp) return { level: 'error', needsAction: true, label: '错误 · 已放弃重启' };
    if (s.edge === 'warning') return { level: 'error', needsAction: true, label: '异常' };
    // 阻断浮层待人工（登录/验证码/未知阻断，核心已本地暂停）：即便 edge 仍 running 也 MUST 浮顶为需处理，
    // 绝不呈现为绿色在线（多环境跨窗盯验证码是本控制台核心目的）。置于 running 判定之前。
    if (s.overlayBlocked) return { level: 'attention', needsAction: true, label: '等待你处理' };
    if (s.auth === 'login required') return { level: 'attention', needsAction: true, label: '需要登录' };
    if (s.auth === 'config required') return { level: 'attention', needsAction: true, label: '待配置' };
    if (s.auth === 'chrome missing') return { level: 'attention', needsAction: true, label: '缺少 Chrome' };
    if (s.risk === 'frozen') return { level: 'error', needsAction: true, label: '账号已暂停' };
    if (s.risk === 'restricted') return { level: 'attention', needsAction: true, label: '节奏已调整' };
    if (s.sameAccountWarning) return { level: 'attention', needsAction: true, label: '账号重复运行' };
    if (s.edge === 'starting') return { level: 'launching', needsAction: false, label: '启动中' };
    if (s.edge === 'running') {
      const at = Date.parse(s.updatedAt || '');
      if (Number.isFinite(at) && Number.isFinite(nowMs) && nowMs - at > FLEET_STALE_MS) {
        return { level: 'stale', needsAction: false, label: '失联' };
      }
      if (s.session === 'running' && s.cloud !== 'connected') return { level: 'attention', needsAction: true, label: '正在重新连接' };
      return { level: 'running', needsAction: false, label: s.session === 'paused' ? '已暂停' : s.session === 'resting' ? '等待下一轮' : '运行中' };
    }
    if (s.session === 'paused') return { level: 'offline', needsAction: false, label: '已暂停' };
    if (s.session === 'closed') return { level: 'offline', needsAction: false, label: '已关闭' };
    return { level: 'offline', needsAction: false, label: '已停止' };
  }

  // 紧迫度排序：需处理（error→attention）浮顶，其后 launching/stale/running，再 offline；同级保持花名册序。
  const FLEET_LEVEL_RANK = { error: 0, attention: 1, launching: 2, stale: 3, running: 4, offline: 5 };

  // 左栏环境显示名优先级（change edge-adspower-name-follows-nickname）：真实登录昵称（account.source!=='env'，
  // 即登录读出的真实身份，见 main.cjs：source 'xhs'=读出昵称 / 'env'=环境名兜底）优先 → 花名册/环境名 →
  // 「环境 …末4位」兜底。真实昵称压过花名册名，兜住「实时名回填把花名册名刷成 AdsPower 模板名」遮蔽昵称的
  // 回归；即使 AdsPower 侧尚未改名 / 改名写失败，左栏也已显示昵称。纯函数、可单测。
  function railDisplayName(row) {
    const acct = row && row.status && row.status.account;
    const realNick = acct && acct.source !== 'env' && acct.name ? String(acct.name) : '';
    const rosterName = (row && (row.name || (row.status && row.status.envName))) || '';
    const fallbackAcct = acct && acct.name ? String(acct.name) : '';
    const envId = row && row.envId != null ? String(row.envId) : '';
    return realNick || rosterName || fallbackAcct || `环境 …${envId.slice(-4)}`;
  }

  /** 输入 [{envId, name, status}]，输出 { rows:[{envId,name,level,needsAction,label,status}], pendingCount }。 */
  function fleetRailModel(list, nowMs) {
    const rows = (Array.isArray(list) ? list : []).map((e, i) => {
      const lv = fleetLevel(e && e.status, nowMs);
      return {
        envId: e && e.envId,
        name: (e && (e.name || (e.status && e.status.envName))) || '',
        platform: (e && e.platform) || '', // 平台视觉标识（rail 行按平台上色）
        level: lv.level,
        needsAction: lv.needsAction,
        label: lv.label,
        rosterIndex: i,
        status: e && e.status,
      };
    });
    rows.sort((a, b) => (FLEET_LEVEL_RANK[a.level] - FLEET_LEVEL_RANK[b.level]) || (a.rosterIndex - b.rosterIndex));
    return { rows, pendingCount: rows.filter((r) => r.needsAction).length };
  }

  return { relTime, synthesizeHealth, bandTone, detailRows, presenceView, runtimeGuidanceView, loopIndex, LOOP_STAGES, publishView, publishDock, PRESENCE_FRESH_MS, PUBLISH_WAIT_HOT_MS, fleetLevel, fleetRailModel, railDisplayName, FLEET_STALE_MS };
});
