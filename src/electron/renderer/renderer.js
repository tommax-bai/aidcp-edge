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

function setBadge(element, value) {
  element.textContent = value;
  element.className = `badge ${value}`;
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
  fields.lastMessage.textContent = status.lastMessage;
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