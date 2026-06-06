const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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

function launchChrome(app) {
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

  return { ok: true, chromePath, profilePath, port: DEBUGGING_PORT };
}

async function cdpJson(pathname) {
  const response = await fetch(`http://127.0.0.1:${DEBUGGING_PORT}${pathname}`);
  if (!response.ok) throw new Error(`CDP request failed: ${response.status}`);
  return response.json();
}

async function hasXhsCookie() {
  const version = await cdpJson('/json/version');
  if (!version.webSocketDebuggerUrl) return false;

  const WebSocket = global.WebSocket || require('ws');
  return new Promise((resolve) => {
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.close();
      resolve(false);
    }, 5000);

    socket.onopen = () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Network.getCookies',
        params: { urls: [XHS_COOKIE_URL] },
      }));
    };
    socket.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    socket.onmessage = (event) => {
      clearTimeout(timer);
      socket.close();
      try {
        const data = JSON.parse(event.data);
        const cookies = data.result?.cookies || [];
        resolve(cookies.some((cookie) => /xiaohongshu\.com$/.test(cookie.domain) && !cookie.session));
      } catch {
        resolve(false);
      }
    };
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