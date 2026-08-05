(function attachEnvironmentSchedule(global) {
  'use strict';

  const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const DAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const DAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'];
  const WEEKDAY_INDEX = Object.freeze({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 });
  const MINUTE_MS = 60_000;

  function validRange(value) {
    return value
      && Number.isInteger(value.startHour)
      && Number.isInteger(value.endHour)
      && value.startHour >= 0
      && value.endHour <= 24
      && value.startHour < value.endHour;
  }

  function normalizeRange(value) {
    return validRange(value) ? { startHour: value.startHour, endHour: value.endHour } : null;
  }

  function normalizeOccurrence(value) {
    if (value === null) return null;
    if (!value || !validRange(value) || !DAY_KEYS.includes(value.day)
        || !Number.isInteger(value.dayIndex) || value.dayIndex < 0 || value.dayIndex > 6
        || !Number.isInteger(value.dayOffset) || value.dayOffset < 0 || value.dayOffset > 7
        || !Number.isFinite(value.startsAt) || !Number.isFinite(value.endsAt)
        || value.startsAt >= value.endsAt) return undefined;
    return {
      day: value.day,
      dayIndex: value.dayIndex,
      dayOffset: value.dayOffset,
      startHour: value.startHour,
      endHour: value.endHour,
      startsAt: value.startsAt,
      endsAt: value.endsAt,
    };
  }

  function normalizeResponse(response) {
    const envelope = response?.ok && response.data;
    const data = envelope?.data;
    const meta = envelope?.meta;
    if (!data || typeof data.envKey !== 'string' || typeof data.timezone !== 'string'
        || data.weekStartsOn !== 'monday' || typeof data.autoEnabled !== 'boolean'
        || !Array.isArray(data.days) || data.days.length !== 7 || !Array.isArray(data.actions)
        || !data.windows || !Number.isFinite(Number(meta?.asOf))) return null;
    const days = data.days.map((day, dayIndex) => {
      if (!day || day.day !== DAY_KEYS[dayIndex]
          || !Array.isArray(day.activityRanges) || !Array.isArray(day.contentRanges)) return null;
      const activityRanges = day.activityRanges.map(normalizeRange);
      const contentRanges = day.contentRanges.map(normalizeRange);
      if (activityRanges.some((range) => range === null) || contentRanges.some((range) => range === null)) return null;
      return { day: day.day, activityRanges, contentRanges };
    });
    if (days.some((day) => day === null)) return null;
    const actions = data.actions.map((action) => {
      if (!action || !['post', 'comment', 'contact_comment'].includes(action.key)
          || typeof action.label !== 'string' || !Number.isInteger(action.dailyCap) || action.dailyCap < 0
          || !['review', 'automatic'].includes(action.approval) || typeof action.resultCopy !== 'string') return null;
      return {
        key: action.key,
        label: action.label,
        dailyCap: action.dailyCap,
        approval: action.approval,
        resultCopy: action.resultCopy,
      };
    });
    if (actions.some((action) => action === null)) return null;
    const windows = {
      currentActivity: normalizeOccurrence(data.windows.currentActivity),
      currentContent: normalizeOccurrence(data.windows.currentContent),
      nextActivity: normalizeOccurrence(data.windows.nextActivity),
      nextContent: normalizeOccurrence(data.windows.nextContent),
    };
    if (Object.values(windows).some((value) => value === undefined)) return null;
    return {
      envKey: data.envKey,
      timezone: data.timezone,
      autoEnabled: data.autoEnabled,
      days,
      actions,
      windows,
      asOf: Number(meta.asOf),
    };
  }

  function hourText(hour) {
    return `${String(hour).padStart(2, '0')}:00`;
  }

  function rangeText(range) {
    return `${hourText(range.startHour)}–${hourText(range.endHour)}`;
  }

  function clockFor(schedule) {
    const fallback = { dayIndex: new Date(schedule.asOf).getDay() === 0 ? 6 : new Date(schedule.asOf).getDay() - 1, minute: 0 };
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: schedule.timezone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(schedule.asOf));
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      const dayIndex = WEEKDAY_INDEX[values.weekday];
      const hour = Number(values.hour);
      const minute = Number(values.minute);
      if (!Number.isInteger(dayIndex) || !Number.isFinite(hour) || !Number.isFinite(minute)) return fallback;
      return { dayIndex, minute: hour * 60 + minute };
    } catch {
      return fallback;
    }
  }

  function failureCopy(response) {
    const reason = response?.reason || response?.error;
    if (reason === 'client_session_expired' || reason === 'client_session_required') return '登录状态已失效，请重新登录后再查看';
    if (reason === 'binding_unknown' || reason === 'binding_unverified') return '当前环境还没有确认对应的小红书账号';
    if (reason === 'unsupported_platform') return '排期目前只用于小红书环境';
    if (reason === 'environment_not_owned') return '当前环境已不在你的可用范围内';
    return '本周安排暂时没有读取成功';
  }

  function createElement(document, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function create(options) {
    const root = options?.root;
    const entry = options?.entry;
    const legacyRoot = options?.legacyRoot;
    const interactionRoot = options?.interactionRoot;
    const contentRoot = options?.contentRoot;
    const shell = options?.shell;
    const api = options?.api || {};
    const onRuntimeAction = typeof options?.onRuntimeAction === 'function' ? options.onRuntimeAction : () => {};
    if (!root || !entry || !legacyRoot) return null;

    const document = root.ownerDocument;
    const fields = {
      entryDay: document.querySelector('#environment-schedule-entry-day'),
      entryBadge: document.querySelector('#environment-schedule-entry-badge'),
      entrySummary: document.querySelector('#environment-schedule-entry-summary'),
      back: root.querySelector('#environment-schedule-back'),
      account: root.querySelector('#environment-schedule-account'),
      browser: root.querySelector('#environment-schedule-browser'),
      lifecycle: root.querySelector('#environment-schedule-lifecycle'),
      now: root.querySelector('#environment-schedule-now'),
      nowKicker: root.querySelector('#environment-schedule-now-kicker'),
      nowTitle: root.querySelector('#environment-schedule-now-title'),
      nowDetail: root.querySelector('#environment-schedule-now-detail'),
      retry: root.querySelector('#environment-schedule-retry'),
      days: root.querySelector('#environment-schedule-days'),
      dayKicker: root.querySelector('#environment-schedule-day-kicker'),
      dayTitle: root.querySelector('#environment-schedule-day-title'),
      daySummary: root.querySelector('#environment-schedule-day-summary'),
      ranges: root.querySelector('#environment-schedule-ranges'),
      actions: root.querySelector('#environment-schedule-actions'),
      usage: root.querySelector('#environment-schedule-usage'),
    };

    const cache = new Map();
    let environment = null;
    let runtime = {};
    let phase = 'idle';
    let errorMessage = '';
    let requestEpoch = 0;
    let selectedDay = 0;
    let restoreScrollY = 0;
    let refreshTimer = null;

    function scheduleData() {
      return environment ? cache.get(environment.envId) || null : null;
    }

    // 「此刻真的在跑」与「环境已经启动」是两件事，MUST 分开判：
    // 前者是能否声称正在工作的证据（九档里只有 running 算），后者决定按钮该给启动还是关闭。
    // 用前者当按钮判据，会让 starting / ready / waiting_resource / paused 这几档都显示成
    // 「启动当前环境」，用户再点一次就是对一个已经起来的环境重复下达启动。
    function running() {
      return runtime.automationState === 'running';
    }

    function automationActive() {
      return String(runtime.automationState || 'stopped') !== 'stopped';
    }

    // 浏览器状态的真实取值域来自主进程投影：closed / queued / starting / ready / closing / blocked / error。
    // 这里曾判 'open'——那一档从来不存在，于是判定恒为假：按钮永远停在「打开浏览器」，
    // 浏览器已经开着也收不起来，点下去只会再下达一次打开。
    function browserReady() {
      return String(runtime.browserState || 'closed') === 'ready';
    }

    function visible() {
      return !root.classList.contains('hidden');
    }

    function setWorkspaceVisible(show) {
      root.classList.toggle('hidden', !show);
      if (show) {
        legacyRoot.classList.add('hidden');
        interactionRoot?.classList.add('hidden');
        contentRoot?.classList.add('hidden');
        shell?.classList.add('schedule-mode');
      } else {
        shell?.classList.remove('schedule-mode');
        legacyRoot.classList.remove('hidden');
        interactionRoot?.classList.add('hidden');
        contentRoot?.classList.add('hidden');
      }
    }

    function todayIndex(schedule) {
      return clockFor(schedule).dayIndex;
    }

    function occurrenceSummary(occurrence) {
      if (!occurrence) return '';
      const prefix = occurrence.dayOffset === 0 ? '今天' : DAY_LABELS[occurrence.dayIndex];
      return `${prefix} ${rangeText(occurrence)}`;
    }

    function renderEntry() {
      const supported = environment?.platform === 'xiaohongshu';
      entry.classList.toggle('hidden', !supported);
      if (!supported) return;
      const schedule = scheduleData();
      fields.entryDay.textContent = schedule ? DAY_SHORT[todayIndex(schedule)] : '今';
      if (!schedule) {
        fields.entryBadge.textContent = phase === 'error' ? '可重试' : '正在读取';
        fields.entryBadge.className = phase === 'error' ? 'is-attention' : '';
        fields.entrySummary.textContent = phase === 'error' ? errorMessage : '正在读取这个账号的可工作时间';
        entry.setAttribute('aria-label', fields.entrySummary.textContent);
        return;
      }
      fields.entryBadge.className = '';
      const current = schedule.windows.currentActivity;
      const next = schedule.windows.nextActivity;
      if (current) {
        fields.entryBadge.textContent = running() ? '工作中' : '可工作';
        fields.entryBadge.className = running() ? 'is-running' : 'is-available';
        const content = schedule.windows.currentContent ? ' · 内容与互动时段已开启' : '';
        fields.entrySummary.textContent = `${running() ? '当前正在工作' : '当前允许工作'}，至 ${hourText(current.endHour)}${content}`;
      } else if (next) {
        fields.entryBadge.textContent = '下次';
        fields.entrySummary.textContent = `下一段 ${occurrenceSummary(next)}`;
      } else {
        fields.entryBadge.textContent = '本周空闲';
        fields.entrySummary.textContent = '本周暂无账号工作时段';
      }
      entry.setAttribute('aria-label', `查看本周安排，${fields.entrySummary.textContent}`);
    }

    // 过渡档位（启动中 / 关闭中 / 排队中）如实说出来并禁用按钮：把它们显示成静止的
    // 「启动」或「关闭」，等于邀请用户对一件正在发生的事重复下达同一个命令。
    // 档位划分与价值首页的运行详情保持同一口径，同一状态两处不得给出不同结论。
    function renderRuntimeActions() {
      const automation = String(runtime.automationState || 'stopped');
      const browser = String(runtime.browserState || 'closed');
      const active = automationActive();
      fields.lifecycle.textContent = automation === 'starting' ? '启动中'
        : automation === 'stopping' ? '关闭中'
          : active ? '关闭当前环境' : '启动当前环境';
      fields.lifecycle.disabled = ['starting', 'stopping', 'pausing', 'waiting_resource'].includes(automation);
      fields.lifecycle.classList.toggle('danger', active);
      fields.lifecycle.classList.toggle('primary', !active);
      fields.browser.textContent = browser === 'ready' ? '收起浏览器'
        : ['queued', 'starting'].includes(browser) ? '浏览器开启中'
          : ['closing', 'releasing'].includes(browser) ? '浏览器关闭中' : '打开浏览器';
      fields.browser.disabled = ['queued', 'starting', 'closing', 'releasing'].includes(browser);
    }

    function renderNow() {
      const schedule = scheduleData();
      fields.retry.classList.toggle('hidden', phase !== 'error');
      fields.now.classList.toggle('is-error', phase === 'error');
      fields.now.classList.toggle('is-running', Boolean(schedule?.windows.currentActivity && running()));
      fields.now.classList.toggle('is-available', Boolean(schedule?.windows.currentActivity && !running()));
      if (!schedule) {
        fields.nowKicker.textContent = phase === 'error' ? '安排暂时不可用' : '正在读取本周安排';
        fields.nowTitle.textContent = phase === 'error' ? errorMessage : '请稍候';
        fields.nowDetail.textContent = phase === 'error'
          ? '这不会影响环境运行，你也可以稍后再试。'
          : '安排属于当前账号，浏览器关闭时也可以查看。';
        return;
      }
      const current = schedule.windows.currentActivity;
      if (current) {
        fields.nowKicker.textContent = running() ? '当前正在工作' : '当前可工作';
        fields.nowTitle.textContent = `${rangeText(current)} · 账号工作时段`;
        fields.nowDetail.textContent = running()
          ? (schedule.windows.currentContent ? '系统正在执行当前环境任务，内容与互动时段也已开启。' : '系统正在按当前环境状态工作。')
          : '当前处于允许工作的时间；只有启动环境后，系统才会执行任务。';
        return;
      }
      const next = schedule.windows.nextActivity;
      fields.nowKicker.textContent = next ? '下一段安排' : '本周安排';
      fields.nowTitle.textContent = next ? occurrenceSummary(next) : '本周暂无账号工作时段';
      fields.nowDetail.textContent = next
        ? (schedule.windows.nextContent
            ? `下一段内容与互动：${occurrenceSummary(schedule.windows.nextContent)}。`
            : '当前没有进行中的工作，到了允许时间后仍需环境处于启动状态。')
        : '当前账号本周没有生效的工作时间，可以联系管理员调整安排。';
    }

    function rangeState(schedule, dayIndex, range) {
      const clock = clockFor(schedule);
      if (dayIndex < clock.dayIndex) return { key: 'past', label: '已结束' };
      if (dayIndex > clock.dayIndex) return { key: 'future', label: '待开始' };
      const start = range.startHour * 60;
      const end = range.endHour * 60;
      if (clock.minute >= end) return { key: 'past', label: '已结束' };
      if (clock.minute < start) return { key: 'future', label: '待开始' };
      return running() ? { key: 'running', label: '工作中' } : { key: 'available', label: '当前可工作' };
    }

    function contentForActivity(day, activity) {
      return day.contentRanges.filter((range) =>
        range.startHour < activity.endHour && range.endHour > activity.startHour);
    }

    function renderDays() {
      const schedule = scheduleData();
      fields.days.replaceChildren();
      if (!schedule) return;
      const currentDay = todayIndex(schedule);
      schedule.days.forEach((day, index) => {
        const button = createElement(document, 'button', index === selectedDay ? 'active' : '');
        button.type = 'button';
        button.dataset.dayIndex = String(index);
        button.setAttribute('aria-pressed', index === selectedDay ? 'true' : 'false');
        const label = createElement(document, 'span', '', DAY_LABELS[index]);
        const meta = createElement(
          document,
          'small',
          '',
          day.activityRanges.length > 0 ? `${day.activityRanges.length} 段` : '无安排',
        );
        button.append(label, meta);
        if (index === currentDay) button.append(createElement(document, 'i', '', '今天'));
        fields.days.appendChild(button);
      });
    }

    function renderRanges() {
      const schedule = scheduleData();
      fields.ranges.replaceChildren();
      if (!schedule) return;
      const day = schedule.days[selectedDay];
      fields.dayKicker.textContent = selectedDay === todayIndex(schedule) ? '今天' : '本周';
      fields.dayTitle.textContent = DAY_LABELS[selectedDay];
      fields.daySummary.textContent = day.activityRanges.length > 0
        ? `${day.activityRanges.length} 个账号工作时段`
        : '没有账号工作时段';
      if (day.activityRanges.length === 0) {
        const empty = createElement(document, 'div', 'esw-empty');
        empty.append(
          createElement(document, 'span', 'esw-empty-mark', '○'),
          createElement(document, 'strong', '', '这一天没有工作安排'),
          createElement(document, 'p', '', '系统不会把空白时段当成已完成，也不会自动补做任务。'),
        );
        fields.ranges.appendChild(empty);
        return;
      }
      day.activityRanges.forEach((range) => {
        const state = rangeState(schedule, selectedDay, range);
        const item = createElement(document, 'article', `esw-range is-${state.key}`);
        const rail = createElement(document, 'span', 'esw-range-rail');
        const body = createElement(document, 'div', 'esw-range-body');
        const head = createElement(document, 'div', 'esw-range-head');
        const title = createElement(document, 'div');
        title.append(
          createElement(document, 'strong', '', rangeText(range)),
          createElement(document, 'span', '', '账号工作时段'),
        );
        head.append(title, createElement(document, 'em', '', state.label));
        body.appendChild(head);
        const contentRanges = contentForActivity(day, range);
        if (contentRanges.length > 0) {
          const content = createElement(document, 'div', 'esw-content-windows');
          content.appendChild(createElement(document, 'span', '', '内容与互动'));
          contentRanges.forEach((contentRange) =>
            content.appendChild(createElement(document, 'b', '', rangeText(contentRange))));
          body.appendChild(content);
        } else {
          body.appendChild(createElement(document, 'p', 'esw-range-note', '这一段没有自动内容安排'));
        }
        item.append(rail, body);
        fields.ranges.appendChild(item);
      });
    }

    function renderActions() {
      const schedule = scheduleData();
      fields.actions.replaceChildren();
      if (!schedule) return;
      if (!schedule.autoEnabled || schedule.actions.length === 0) {
        const empty = createElement(document, 'div', 'esw-side-empty');
        empty.append(
          createElement(document, 'strong', '', schedule.autoEnabled ? '暂未安排自动内容' : '自动内容暂未开启'),
          createElement(document, 'span', '', '账号工作时间仍会照常展示'),
        );
        fields.actions.appendChild(empty);
        return;
      }
      const marks = { post: '稿', comment: '评', contact_comment: '联' };
      schedule.actions.forEach((action) => {
        const row = createElement(document, 'div', 'esw-action-row');
        row.appendChild(createElement(document, 'span', `esw-action-mark is-${action.key}`, marks[action.key]));
        const copy = createElement(document, 'div');
        copy.append(
          createElement(document, 'strong', '', action.label),
          createElement(document, 'span', '', action.resultCopy),
        );
        row.append(copy, createElement(document, 'em', '', `每天最多 ${action.dailyCap}`));
        fields.actions.appendChild(row);
      });
    }

    function renderUsage() {
      fields.usage.replaceChildren();
      const totals = runtime.dailyUsage?.totals || runtime.dailyUsage || null;
      if (!totals) {
        const empty = createElement(document, 'div', 'esw-side-empty');
        empty.append(
          createElement(document, 'strong', '', '今日数据等待同步'),
          createElement(document, 'span', '', '浏览器关闭时也会从账号数据面读取'),
        );
        fields.usage.appendChild(empty);
        return;
      }
      const metrics = [
        ['浏览', totals.view ?? totals.views],
        ['搜索', totals.search ?? totals.searches],
        ['点赞', totals.like ?? totals.likes],
        ['收藏', totals.collect ?? totals.collects],
        ['评论', totals.comment ?? totals.comments],
        ['发布', totals.publish ?? totals.publishes],
      ];
      metrics.forEach(([label, value]) => {
        const item = createElement(document, 'div');
        item.append(
          createElement(document, 'b', '', Number.isFinite(Number(value)) ? String(Math.max(0, Math.floor(Number(value)))) : '—'),
          createElement(document, 'span', '', label),
        );
        fields.usage.appendChild(item);
      });
    }

    function renderPage() {
      const schedule = scheduleData();
      fields.account.textContent = `${environment?.label || '当前账号'} · 本周有效安排`;
      renderRuntimeActions();
      renderNow();
      renderDays();
      renderRanges();
      renderActions();
      renderUsage();
      root.setAttribute('aria-busy', phase === 'loading' ? 'true' : 'false');
      root.classList.toggle('is-loading', phase === 'loading' && !schedule);
    }

    function render() {
      renderEntry();
      if (visible()) renderPage();
    }

    async function load(options = {}) {
      if (!environment || environment.platform !== 'xiaohongshu'
          || typeof api.getEnvironmentSchedule !== 'function') return;
      const requestedEnvId = environment.envId;
      const epoch = ++requestEpoch;
      phase = 'loading';
      errorMessage = '';
      render();
      try {
        const response = await api.getEnvironmentSchedule(requestedEnvId);
        if (epoch !== requestEpoch || environment?.envId !== requestedEnvId) return;
        const schedule = normalizeResponse(response);
        if (!schedule) {
          phase = 'error';
          errorMessage = failureCopy(response);
          render();
          return;
        }
        cache.set(requestedEnvId, schedule);
        phase = 'ready';
        selectedDay = todayIndex(schedule);
        render();
      } catch {
        if (epoch !== requestEpoch || environment?.envId !== requestedEnvId) return;
        phase = 'error';
        errorMessage = '本周安排暂时没有读取成功';
        render();
      }
    }

    function stopRefreshTimer() {
      if (refreshTimer !== null) global.clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    function scheduleMinuteRefresh() {
      stopRefreshTimer();
      const delay = MINUTE_MS - (Date.now() % MINUTE_MS) + 20;
      refreshTimer = global.setTimeout(async () => {
        refreshTimer = null;
        await load({ force: true });
        if (visible()) scheduleMinuteRefresh();
      }, delay);
    }

    function open() {
      if (!environment || environment.platform !== 'xiaohongshu') return;
      restoreScrollY = Number(global.scrollY) || 0;
      const schedule = scheduleData();
      if (schedule) selectedDay = todayIndex(schedule);
      setWorkspaceVisible(true);
      renderPage();
      global.scrollTo?.(0, 0);
      scheduleMinuteRefresh();
      if (!schedule && phase === 'idle') void load({ force: true });
    }

    function close() {
      if (!visible()) return;
      stopRefreshTimer();
      setWorkspaceVisible(false);
      global.setTimeout(() => global.scrollTo?.(0, restoreScrollY), 0);
    }

    function setEnvironment(next) {
      const normalized = next?.envId
        ? { envId: String(next.envId), label: String(next.label || '当前账号'), platform: String(next.platform || '') }
        : null;
      const previousId = environment?.envId || null;
      const same = previousId === normalized?.envId && environment?.platform === normalized?.platform;
      environment = normalized;
      if (!normalized || normalized.platform !== 'xiaohongshu') {
        requestEpoch += 1;
        phase = 'idle';
        errorMessage = '';
        if (visible()) close();
        renderEntry();
        return;
      }
      if (same) {
        render();
        return;
      }
      requestEpoch += 1;
      phase = cache.has(normalized.envId) ? 'ready' : 'idle';
      errorMessage = '';
      render();
      void load();
    }

    function setRuntime(next) {
      runtime = next || {};
      render();
    }

    entry.addEventListener('click', open);
    fields.back.addEventListener('click', close);
    fields.retry.addEventListener('click', () => void load({ force: true }));
    fields.days.addEventListener('click', (event) => {
      const button = event.target.closest?.('button[data-day-index]');
      if (!button) return;
      const index = Number(button.dataset.dayIndex);
      if (!Number.isInteger(index) || index < 0 || index > 6) return;
      selectedDay = index;
      renderDays();
      renderRanges();
    });
    fields.lifecycle.addEventListener('click', () => onRuntimeAction(automationActive() ? 'close' : 'start'));
    fields.browser.addEventListener('click', () => onRuntimeAction(browserReady() ? 'browser-close' : 'browser-open'));

    renderEntry();
    return {
      setEnvironment,
      setRuntime,
      open,
      close,
      refresh: () => load({ force: true }),
      isOpen: visible,
      snapshot: () => ({ environment, runtime, phase, selectedDay, data: scheduleData() }),
    };
  }

  global.EnvironmentSchedule = { create, normalizeResponse };
})(window);
