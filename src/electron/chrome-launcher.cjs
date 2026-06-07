const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const DEBUGGING_PORT = 9222;
const XHS_COOKIE_URL = 'https://www.xiaohongshu.com';
const LOGIN_URL = 'https://www.xiaohongshu.com';

let chromeProcess;

function findChromePath() {
  const candidates = [];
  if (process.platform === 'win32') {
    const roots = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    for (const root of roots) {
      candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium');
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function getProfilePath(app) {
  return path.join(app.getPath('userData'), 'chrome-profile');
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${DEBUGGING_PORT}${urlPath}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function isCdpAlive() {
  try {
    await httpGet('/json/version');
    return true;
  } catch { return false; }
}

async function launchChrome(app) {
  if (await isCdpAlive()) {
    return { ok: true, chromePath: '(already running)', profilePath: '(existing)', port: DEBUGGING_PORT };
  }

  const chromePath = findChromePath();
  if (!chromePath) {
    return { ok: false, error: 'Chrome was not found. Please install Google Chrome and restart AIDCP Edge.' };
  }

  const profilePath = getProfilePath(app);
  fs.mkdirSync(profilePath, { recursive: true });

  if (!chromeProcess || chromeProcess.killed) {
    chromeProcess = spawn(chromePath, [
      `--remote-debugging-port=${DEBUGGING_PORT}`,
      `--user-data-dir=${profilePath}`,
      '--no-first-run',
      '--no-default-browser-check',
      LOGIN_URL,
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    chromeProcess.unref();
  }

  await new Promise((r) => setTimeout(r, 2000));
  return { ok: true, chromePath, profilePath, port: DEBUGGING_PORT };
}

async function hasXhsCookie() {
  let targets;
  try {
    targets = await httpGet('/json/list');
  } catch { return false; }

  const xhsTarget = targets.find((t) => t.type === 'page' && /xiaohongshu\.com/.test(t.url));
  if (!xhsTarget || !xhsTarget.webSocketDebuggerUrl) return false;

  // Use ws module for WebSocket CDP communication
  const WebSocket = require('ws');
  return new Promise((resolve) => {
    let socket;
    try {
      socket = new WebSocket(xhsTarget.webSocketDebuggerUrl);
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => {
      try { socket.close(); } catch {}
      resolve(false);
    }, 5000);

    socket.on('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Network.getCookies',
        params: { urls: [XHS_COOKIE_URL] },
      }));
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    socket.on('message', (raw) => {
      clearTimeout(timer);
      try { socket.close(); } catch {}
      try {
        const data = JSON.parse(raw.toString());
        const cookies = data.result?.cookies || [];
        resolve(cookies.some((cookie) => /xiaohongshu\.com$/.test(cookie.domain) && (cookie.name === 'a1' || cookie.name === 'web_session')));
      } catch {
        resolve(false);
      }
    });
  });
}

module.exports = {
  DEBUGGING_PORT,
  LOGIN_URL,
  findChromePath,
  getProfilePath,
  hasXhsCookie,
  launchChrome,
};
