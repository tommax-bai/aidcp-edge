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
    return `${Math.floor(diff / 3_600_000)} 小时前`;
  }

  // ── 健康合成：五路技术状态 → 一句结论 + 色调。attention 恒优先。──
  const AUTH_ATTENTION = { 'login required': '需要登录小红书', 'chrome missing': '本机缺少 Chrome', 'config required': '需要完成初始设置' };

  function synthesizeHealth(status) {
    const s = status || {};
    if (s.edge === 'warning') return { code: 'attention', label: '需要注意', detail: '引擎异常退出，请查看详情或重新启动' };
    if (AUTH_ATTENTION[s.auth]) return { code: 'attention', label: '需要注意', detail: AUTH_ATTENTION[s.auth] };
    if (s.risk === 'restricted' || s.risk === 'frozen') {
      return { code: 'attention', label: '需要注意', detail: s.risk === 'frozen' ? '账号被冻结，已停止操作' : '账号受限，已收紧动作' };
    }
    if (s.edge === 'running' && s.session === 'running' && s.cloud !== 'connected') {
      return { code: 'attention', label: '云端连接中断', detail: '正在等待与云端恢复连接' };
    }
    if (s.session === 'paused') return { code: 'paused', label: '已暂停', detail: '点右下角「恢复」继续' };
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
    session: { label: '自动运营', values: { idle: '待命', running: '进行中', paused: '已暂停' } },
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
    if (s.auth === 'login required') return { text: '等你登录小红书后继续', animate: false, fresh: '' };
    if (s.auth === 'config required') return { text: '等待完成初始设置', animate: false, fresh: '' };
    if (s.edge === 'warning') return { text: '引擎异常退出，需要处理', animate: false, fresh: staticFresh };
    if (s.edge === 'starting') return { text: '正在启动引擎…', animate: true, fresh: '' };
    if (!running) return { text: '待命中', animate: false, fresh: staticFresh };

    if (p && p.text && hasFresh) {
      return { text: p.text, animate: true, fresh: `刚刚更新 · ${relTime(at, nowMs)}` };
    }
    // 在跑但事件已不新鲜：如实说「没有新动态」，绝不假装仍在忙。
    return {
      text: '有一会儿没有新动态了',
      animate: false,
      fresh: Number.isFinite(at) ? `最后动态 · ${relTime(at, nowMs)}` : '',
    };
  }

  // ── 浏览循环 chip：feed → select → read → interact → return ──
  const LOOP_STAGES = ['feed', 'select', 'read', 'interact', 'return'];
  function loopIndex(stage) {
    const i = LOOP_STAGES.indexOf(stage);
    return i === -1 ? -1 : i;
  }

  // ── 发布卡状态机（只读投影）──
  // 状态：pending →(30min 时长琥珀化)→ [reminded 仅在收到明确事件时] → approved → published | rejected | failed
  const PUBLISH_WAIT_HOT_MS = 30 * 60_000;
  const PUBLISH_STEPS = ['写好内容', '发到飞书', '等你确认', '择时发布'];

  function publishView(publish, nowMs) {
    if (!publish || !publish.state) return { visible: false, collapsed: null };
    const at = publish.at ? Date.parse(publish.at) : nowMs;
    const waitedMs = Math.max(0, nowMs - (Number.isFinite(at) ? at : nowMs));
    const waitedMin = Math.floor(waitedMs / 60_000);
    const title = publish.title || '';
    const state = publish.state;

    const base = {
      visible: true,
      collapsed: null,
      steps: PUBLISH_STEPS,
      title,
      code: publish.code || '',
      linkable: true,
    };

    if (state === 'pending' || state === 'reminded') {
      const hot = waitedMs >= PUBLISH_WAIT_HOT_MS;
      return {
        ...base,
        head: 'AI 写好了一条新笔记',
        corner: waitedMin < 1 ? '刚刚发出' : `已等 ${waitedMin} 分钟`,
        cornerHot: hot,
        stepStates: ['done', 'done', 'cur', 'todo'],
        curCalm: false,
        // 红线：只有收到明确的「已再提醒」事件才这么说；单纯等得久绝不谎称已提醒。
        foot: state === 'reminded'
          ? '已在飞书再次提醒你 · 不会重复打扰'
          : '全文和「通过 / 驳回」按钮在飞书里，审批结果会自动同步到这里。',
      };
    }
    if (state === 'approved') {
      return {
        ...base,
        head: '你已在飞书通过',
        corner: '将择时发布',
        cornerHot: false,
        stepStates: ['done', 'done', 'done', 'cur'],
        curCalm: true,
        foot: '无需操作 · 系统会挑一个自然时段发出，发完这里会记一笔',
      };
    }
    // 终态：卡片收起，折进活动流一条记录。
    if (state === 'published') {
      return { visible: false, collapsed: { type: 'published', sentence: title ? `笔记「${title}」已发布` : '一条笔记已发布' } };
    }
    if (state === 'rejected') {
      return { visible: false, collapsed: { type: 'rejected', sentence: '你在飞书选择了暂不发布 · 内容已留档' } };
    }
    if (state === 'failed') {
      return { visible: false, collapsed: { type: 'failed', sentence: title ? `笔记「${title}」发布未成功，已如实记录` : '发布未成功，已如实记录' } };
    }
    return { visible: false, collapsed: null };
  }

  return { relTime, synthesizeHealth, bandTone, detailRows, presenceView, loopIndex, LOOP_STAGES, publishView, PRESENCE_FRESH_MS, PUBLISH_WAIT_HOT_MS };
});
