const fields = {
  auth: document.querySelector('#auth-status'),
  cloud: document.querySelector('#cloud-status'),
  session: document.querySelector('#session-state'),
  risk: document.querySelector('#risk-status'),
  edge: document.querySelector('#edge-state'),
  views: document.querySelector('#views'),
  likes: document.querySelector('#likes'),
  collects: document.querySelector('#collects'),
  updatedAt: document.querySelector('#updated-at'),
  lastMessage: document.querySelector('#last-message'),
  toggle: document.querySelector('#toggle-session'),
  relogin: document.querySelector('#relogin'),
  loginGuide: document.querySelector('#login-guide'),
};

let currentStatus;
const LOG_RETENTION_MS = 2 * 60 * 1000; // 2 minutes
const logEntries = [];

function setBadge(element, value) {
  element.textContent = value;
  element.className = `badge ${value}`;
}

function addLogEntry(message) {
  if (!message) return;
  const now = Date.now();
  logEntries.push({ time: now, message });
  // Prune entries older than 2 minutes
  const cutoff = now - LOG_RETENTION_MS;
  while (logEntries.length > 0 && logEntries[0].time < cutoff) {
    logEntries.shift();
  }
  renderLog();
}

function renderLog() {
  fields.lastMessage.innerHTML = logEntries.map((entry) => {
    const time = new Date(entry.time).toLocaleTimeString();
    return `<div class="log-entry"><span class="log-time">${time}</span> ${entry.message}</div>`;
  }).join('');
  fields.lastMessage.scrollTop = fields.lastMessage.scrollHeight;
}

function render(status) {
  currentStatus = status;
  setBadge(fields.auth, status.auth);
  setBadge(fields.cloud, status.cloud);
  setBadge(fields.session, status.session);
  setBadge(fields.risk, status.risk);
  setBadge(fields.edge, status.edge);
  fields.views.textContent = status.stats.views;
  fields.likes.textContent = status.stats.likes;
  fields.collects.textContent = status.stats.collects;
  fields.updatedAt.textContent = new Date(status.updatedAt).toLocaleTimeString();
  addLogEntry(status.lastMessage);
  fields.toggle.textContent = status.session === 'paused' ? 'Resume' : 'Pause';
  fields.loginGuide.classList.toggle('hidden', status.auth !== 'login required');
}

fields.toggle.addEventListener('click', async () => {
  fields.toggle.disabled = true;
  try {
    const next = currentStatus?.session === 'paused'
      ? await window.aidcpEdge.resume()
      : await window.aidcpEdge.pause();
    render(next);
  } finally {
    fields.toggle.disabled = false;
  }
});

fields.relogin.addEventListener('click', async () => {
  fields.relogin.disabled = true;
  try {
    render(await window.aidcpEdge.relogin());
  } finally {
    fields.relogin.disabled = false;
  }
});

window.aidcpEdge.onStatusUpdate(render);
window.aidcpEdge.getStatus().then(render);
