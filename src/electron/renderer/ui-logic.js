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

  // ── 健康合成：五路技术状态 → 一句结论 + 色调。attention 恒优先。──
  const AUTH_ATTENTION = { 'login required': '需要登录小红书', 'chrome missing': '本机缺少 Chrome', 'config required': '需要完成初始设置' };

  function synthesizeHealth(status) {
    const s = status || {};
    const edgeFailure = s.edgeFailure && typeof s.edgeFailure.summary === 'string' ? s.edgeFailure.summary.trim() : '';
    if (s.edge === 'warning') return { code: 'attention', label: '需要注意', detail: edgeFailure || '引擎已停止，请查看开发者详情，或重新启动 / 重新登录' };
    if (AUTH_ATTENTION[s.auth]) return { code: 'attention', label: '需要注意', detail: AUTH_ATTENTION[s.auth] };
    if (s.risk === 'restricted' || s.risk === 'frozen') {
      return { code: 'attention', label: '需要注意', detail: s.risk === 'frozen' ? '账号被冻结，已停止操作' : '账号受限，已收紧动作' };
    }
    if (s.edge === 'running' && s.session === 'running' && s.cloud !== 'connected') {
      return { code: 'attention', label: '云端连接中断', detail: '正在等待与云端恢复连接' };
    }
    if (s.session === 'paused') return { code: 'paused', label: '已暂停', detail: '点右下角「恢复」继续' };
    if (s.edge === 'running' && s.session === 'resting') return { code: 'paused', label: '休息中', detail: '休息结束后会自动继续' };
    if (s.edge === 'starting') return { code: 'ready', label: '正在启动…', detail: '引擎启动中' };
    if (s.edge === 'running' && s.session === 'running') {
      return { code: 'running', label: s.risk === 'warned' ? '运行中 · 放慢节奏' : '运行中 · 一切正常', detail: '' };
    }
    return { code: 'ready', label: '就绪', detail: '点右下角「启动」开始' };
  }

  // 标题带色调：随风控状态染色（normal 平静 / warned 琥珀 / restricted·frozen 警示）。
  function bandTone(status) {
    const risk = (status || {}).risk;
    if (risk === 'restricted' || risk === 'frozen') return 'danger';
    if (risk === 'warned') return 'warned';
    return 'normal';
  }

  // 五路明细的人话标签（内部词 → 客户能懂的话）。
  const DETAIL_LABELS = {
    auth: { label: '小红书登录', values: { checking: '检测中', 'login required': '需要登录', 'logged in': '已登录', 'chrome missing': '缺少 Chrome', 'config required': '待完成设置' } },
    cloud: { label: '云端连接', values: { disconnected: '未连接', connected: '已连接' } },
    session: { label: '自动运营', values: { idle: '待命', running: '进行中', resting: '休息中', paused: '已暂停' } },
    risk: { label: '账号保护', values: { normal: '正常', warned: '谨慎放慢', restricted: '受限', frozen: '已冻结' } },
    edge: { label: '本机引擎', values: { stopped: '已停止', starting: '启动中', running: '运行中', warning: '异常' } },
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
  const QUOTA_ACTION_LABELS = {
    view: '浏览',
    like: '点赞',
    collect: '收藏',
    comment: '评论',
    follow: '关注',
    publish: '发帖',
  };
  const QUOTA_WINDOW_LABELS = {
    session: '单场',
    minute: '分钟',
    hour: '小时',
    day: '今日',
  };
  const QUOTA_WINDOW_PRIORITY = ['session', 'minute', 'hour', 'day'];
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

  function quotaRestPresenceText(status, nowMs) {
    const windows = status && status.dailyUsage && objectOrEmpty(status.dailyUsage).windows;
    if (!windows || typeof windows !== 'object') return '';
    for (const windowKey of QUOTA_WINDOW_PRIORITY) {
      const window = objectOrEmpty(windows[windowKey]);
      if (!Object.keys(window).length) continue;
      if (windowKey === 'session' && window.active === false) continue;
      const expiresAt = finiteNumber(window.expiresAt);
      if ((windowKey === 'minute' || windowKey === 'hour' || windowKey === 'day') && expiresAt !== null && expiresAt <= nowMs) continue;
      const totals = objectOrEmpty(window.totals);
      const quotas = objectOrEmpty(window.quotas);
      const saturated = new Set(Array.isArray(window.saturated) ? window.saturated : []);
      for (const action of QUOTA_ACTION_PRIORITY) {
        const cap = finiteNumber(quotas[action]);
        if (cap === null) continue;
        const used = count(totals[action]);
        if (!saturated.has(action) && used < count(cap)) continue;
        const wait = futureWaitText(finiteNumber(window.releaseAt), nowMs);
        return `${QUOTA_ACTION_LABELS[action]}已达到${QUOTA_WINDOW_LABELS[windowKey]}上限，休息中${wait ? `，预计 ${wait}继续` : ''}`;
      }
    }
    return '';
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
    if (s.session === 'paused') return { text: '已暂停，随时可以恢复', animate: false, fresh: staticFresh };
    if (s.session === 'resting') return { text: (p && p.text) || '这一轮结束，休息后会自动继续', animate: false, fresh: staticFresh };
    if (s.auth === 'login required') return { text: '等你登录小红书后继续', animate: false, fresh: '' };
    if (s.auth === 'config required') return { text: '等待完成初始设置', animate: false, fresh: '' };
    if (s.edge === 'warning') return { text: '引擎已停止，请查看详情或重新启动', animate: false, fresh: staticFresh };
    if (s.edge === 'starting') return { text: '正在启动引擎…', animate: true, fresh: '' };
    if (!running) return { text: '待命中', animate: false, fresh: staticFresh };

    if (p && p.text && hasFresh) {
      return { text: p.text, animate: true, fresh: `刚刚更新 · ${relTime(at, nowMs)}` };
    }
    const quotaRestText = quotaRestPresenceText(s, nowMs);
    if (quotaRestText) {
      return {
        text: quotaRestText,
        animate: false,
        fresh: Number.isFinite(at) ? `最后动态 · ${relTime(at, nowMs)}` : '',
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
  // last：上次发布（终态 published / 本地或云端带回的最近发布记录），四节点全勾
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
        showLink: true,
        head: 'AI 写好了一条新笔记',
        corner: waitedMin < 1 ? '刚刚发出' : `已等 ${waitedMin} 分钟`,
        cornerHot: hot,
        stepStates: ['done', 'done', 'cur', 'todo'],
        curCalm: false,
        // 红线：只有收到明确的「已再提醒」事件才这么说；单纯等得久绝不谎称已提醒。
        foot: state === 'reminded'
          ? '已在飞书**再次提醒**你 · 不会重复打扰'
          : '全文和**「通过 / 驳回」**按钮在飞书里，审批结果会自动同步到这里。',
      };
    }
    if (state === 'approved') {
      return {
        ...base,
        mode: 'flow',
        showLink: true,
        head: '你已在飞书通过',
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
    if (state === 'published') {
      collapsed = { type: 'published', sentence: title ? `笔记「${title}」已发布` : '一条笔记已发布' };
      last = { title, at: publish.at }; // 刚发布的就是最近一次（主进程同时落盘持久化）
    } else if (state === 'rejected') {
      collapsed = { type: 'rejected', sentence: '你在飞书选择了暂不发布 · 内容已留档' };
    } else if (state === 'failed') {
      collapsed = { type: 'failed', sentence: title ? `笔记「${title}」发布未成功，已如实记录` : '发布未成功，已如实记录' };
    }

    if (last && last.title) {
      const lastAt = Date.parse(last.at || '');
      return {
        ...base,
        mode: 'last',
        collapsed,
        showLink: true,
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
      showLink: true,
      head: '发布过的 AI 写好的笔记',
      corner: '',
      cornerHot: false,
      title: '还没有发布过内容',
      stepStates: ['todo', 'todo', 'todo', 'todo'],
      curCalm: false,
      foot: 'AI 写好笔记后会先发到飞书等你**「通过/驳回」**，通过后才会发布。',
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

  return { relTime, synthesizeHealth, bandTone, detailRows, presenceView, loopIndex, LOOP_STAGES, publishView, publishDock, PRESENCE_FRESH_MS, PUBLISH_WAIT_HOT_MS };
});
