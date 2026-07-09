const FACEBOOK_DOMAIN = 'facebook.com';
const FACEBOOK_COOKIE_DOMAIN = '.facebook.com';
const FACEBOOK_START_URL = 'https://www.facebook.com/';
const FIELD_DELIMITER = '----';
const FB_COOKIE_NAMES = new Set([
  'c_user',
  'xs',
  'datr',
  'sb',
  'oo',
  'wd',
  'fr',
  'presence',
  'locale',
  'dpr',
  'm_pixel_ratio',
  'spin',
  'usida',
  'ps_l',
  'ps_n',
  'i_user',
  'm_page_voice',
]);

function firstEqIndex(value) {
  return String(value).indexOf('=');
}

function parseCookiePairs(rawCookie) {
  return String(rawCookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = firstEqIndex(part);
      if (eq <= 0) return null;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!name) return null;
      return { name, value };
    })
    .filter(Boolean);
}

function looksStructuredCookie(rawCookie) {
  const text = String(rawCookie || '').trim();
  return text.startsWith('[') || text.includes('\t');
}

function normalizeFacebookCookie(rawCookie) {
  const text = String(rawCookie || '').trim();
  if (!text) return { ok: false, error: '缺少 cookie' };
  if (looksStructuredCookie(text)) return { ok: true, cookie: text };

  const pairs = parseCookiePairs(text).filter((p) => FB_COOKIE_NAMES.has(p.name));
  if (!pairs.some((p) => p.name === 'c_user')) {
    return { ok: false, error: 'cookie 缺少 c_user' };
  }
  if (!pairs.some((p) => p.name === 'xs')) {
    return { ok: false, error: 'cookie 缺少 xs' };
  }

  const cookies = pairs.map((pair, idx) => ({
    domain: FACEBOOK_COOKIE_DOMAIN,
    path: '/',
    name: pair.name,
    value: pair.value,
    secure: true,
    sameSite: 'unspecified',
    id: idx + 1,
  }));
  return { ok: true, cookie: JSON.stringify(cookies) };
}

function parseImportLine(line, index) {
  const parts = String(line).split(FIELD_DELIMITER);
  const lineNo = index + 1;
  if (parts.length < 4) {
    return { ok: false, error: `第 ${lineNo} 行格式错误` };
  }
  const username = parts[0].trim();
  const password = parts[1].trim();
  const fakey = parts[2].trim();
  const rawCookie = parts.slice(3).join(FIELD_DELIMITER).trim();
  if (!username) return { ok: false, error: `第 ${lineNo} 行缺少 username` };
  if (!rawCookie) return { ok: false, error: `第 ${lineNo} 行缺少 cookie` };

  const cookie = normalizeFacebookCookie(rawCookie);
  if (!cookie.ok) return { ok: false, error: `第 ${lineNo} 行${cookie.error}` };

  return {
    ok: true,
    entry: {
      username,
      password,
      fakey,
      cookie: cookie.cookie,
      domainName: FACEBOOK_DOMAIN,
      openUrls: [FACEBOOK_START_URL],
      repeatConfig: [4],
      ignoreCookieError: '0',
    },
  };
}

function parseFacebookAccountImport(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { ok: true, entries: [] };

  const entries = [];
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseImportLine(lines[i], i);
    if (!parsed.ok) return { ok: false, error: parsed.error, entries: [] };
    entries.push(parsed.entry);
  }
  return { ok: true, entries };
}

function profileNameForFacebookImport(_entry, idx) {
  return `Facebook import ${idx + 1}`;
}

module.exports = {
  FACEBOOK_DOMAIN,
  FACEBOOK_START_URL,
  normalizeFacebookCookie,
  parseFacebookAccountImport,
  profileNameForFacebookImport,
};
