#!/usr/bin/env tsx
/**
 * adspower-fingerprint-probe.ts — 一次性探针（change adspower-auto-create-env 下码前置 task 1.x）。
 *
 * 目的：对真实 AdsPower 打 user/create，实测两个存疑点，据此定护栏：
 *   Q1 device_memory=6（非 2 的幂）是被静默接受还是纠正？（读 navigator.deviceMemory 为准）
 *   Q2 webgl='3'(random matching) 时同传 webgl_config 是被忽略还是生效？随机池是否受 OS 约束？
 *      对照 webgl='2'(custom) 看 config 是否被 honor。（读 UNMASKED_RENDERER_WEBGL 为准）
 * 顺带读 platform/UA/时区/webdriver，观察 ua_auto 给的 OS 与我方声明 renderer 的 OS 是否自洽（H6 现场）。
 *
 * 安全：只建本次的测试分身、结束**只删本次自己建的这几个 id**（从不碰已有号，never-logged-in 安全豁免）。
 * 运行：cd ../aidcp-edge && npx tsx scripts/adspower-fingerprint-probe.ts
 */
import { attachToPage } from '../src/cdp/index.js';
import { evalRaw } from '../src/browse/index.js';

const API_BASE = process.env.AIDCP_ADS_API_BASE ?? 'http://local.adspower.net:50325';
const API_KEY = process.env.AIDCP_ADS_API_KEY;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface AdsResp<T> {
  code: number;
  msg?: string;
  data?: T;
}

/** 本地 API 全局 1req/s：每次调用后垫 1.2s，串行安全。 */
let lastAt = 0;
async function throttle(): Promise<void> {
  const wait = 1200 - (Date.now() - lastAt);
  if (lastAt !== 0 && wait > 0) await sleep(wait);
  lastAt = Date.now();
}
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h = { ...extra };
  if (API_KEY) h.Authorization = `Bearer ${API_KEY}`;
  return h;
}
async function adsGet<T>(path: string, params: Record<string, string>): Promise<AdsResp<T>> {
  await throttle();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}${path}?${qs}`, { headers: authHeaders() });
  return (await res.json()) as AdsResp<T>;
}
async function adsPost<T>(path: string, body: unknown): Promise<AdsResp<T>> {
  await throttle();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  return (await res.json()) as AdsResp<T>;
}

const NVIDIA_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
const NVIDIA_VENDOR = 'Google Inc. (NVIDIA)';

interface Probe {
  key: string;
  question: string;
  fp: Record<string, unknown>;
}
const PROBES: Probe[] = [
  {
    key: 'P1-devmem6',
    question: 'Q1: device_memory=6 会被静默接受还是纠正',
    fp: {
      automatic_timezone: '1',
      webrtc: 'disabled',
      canvas: '1',
      webgl_image: '1',
      audio: '1',
      client_rects: '1',
      media_devices: '1',
      webgl: '3',
      device_memory: '6', // ← 被测：非 2 的幂
      hardware_concurrency: '8',
      screen_resolution: 'none',
      fonts: ['all'],
      browser_kernel_config: { version: '148', type: 'chrome' },
      flash: 'block',
    },
  },
  {
    key: 'P2-webgl3+cfg',
    question: 'Q2: webgl=3(random) 时同传 webgl_config 是否被吞',
    fp: {
      automatic_timezone: '1',
      webrtc: 'disabled',
      canvas: '1',
      webgl_image: '1',
      audio: '1',
      client_rects: '1',
      media_devices: '1',
      webgl: '3', // random matching
      webgl_config: { unmasked_vendor: NVIDIA_VENDOR, unmasked_renderer: NVIDIA_RENDERER },
      device_memory: '8',
      hardware_concurrency: '8',
      screen_resolution: 'none',
      fonts: ['all'],
      browser_kernel_config: { version: '148', type: 'chrome' },
      flash: 'block',
    },
  },
  {
    key: 'P3-webgl2+cfg',
    question: '对照: webgl=2(custom) 是否 honor webgl_config',
    fp: {
      automatic_timezone: '1',
      webrtc: 'disabled',
      canvas: '1',
      webgl_image: '1',
      audio: '1',
      client_rects: '1',
      media_devices: '1',
      webgl: '2', // custom
      webgl_config: { unmasked_vendor: NVIDIA_VENDOR, unmasked_renderer: NVIDIA_RENDERER },
      device_memory: '4',
      hardware_concurrency: '8',
      screen_resolution: 'none',
      fonts: ['all'],
      browser_kernel_config: { version: '148', type: 'chrome' },
      flash: 'block',
    },
  },
];

const READ_JS = `(function(){
  function webgl(){try{
    var c=document.createElement('canvas');
    var gl=c.getContext('webgl')||c.getContext('experimental-webgl');
    if(!gl) return {err:'no-webgl-context'};
    var dbg=gl.getExtension('WEBGL_debug_renderer_info');
    return {vendor:dbg?gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL):'(no-ext)',
            renderer:dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):'(no-ext)'};
  }catch(e){return {err:String(e)};}}
  function canvasHash(){try{
    var c=document.createElement('canvas');c.width=200;c.height=40;
    var x=c.getContext('2d');x.textBaseline='top';x.font='14px Arial';
    x.fillStyle='#069';x.fillText('aidcp-probe \\u{1F512}',2,2);
    var d=c.toDataURL();var h=0;for(var i=0;i<d.length;i++){h=(h*31+d.charCodeAt(i))>>>0;}
    return h.toString(16);
  }catch(e){return 'ERR';}}
  var g=webgl();
  return JSON.stringify({
    deviceMemory: navigator.deviceMemory,
    hardwareConcurrency: navigator.hardwareConcurrency,
    platform: navigator.platform,
    ua: navigator.userAgent,
    tz: (Intl.DateTimeFormat().resolvedOptions()||{}).timeZone,
    lang: navigator.language,
    webdriver: navigator.webdriver,
    webglVendor: g.vendor, webglRenderer: g.renderer, webglErr: g.err||null,
    canvasHash: canvasHash()
  });
})()`;

interface Reading {
  deviceMemory?: unknown;
  hardwareConcurrency?: unknown;
  platform?: string;
  ua?: string;
  tz?: string;
  lang?: string;
  webdriver?: unknown;
  webglVendor?: string;
  webglRenderer?: string;
  webglErr?: string | null;
  canvasHash?: string;
}

async function waitCdp(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {
      /* not ready */
    }
    if (Date.now() >= deadline) throw new Error(`CDP ${port} not ready`);
    await sleep(300);
  }
}

async function main(): Promise<void> {
  console.log(`[probe] API_BASE=${API_BASE} key=${API_KEY ? 'yes' : 'no'}`);
  // 建专用分组
  const grp = await adsPost<{ group_id: string | number }>('/api/v1/group/create', { group_name: 'aidcp-probe' });
  let groupId = String(grp.data?.group_id ?? '');
  if (grp.code !== 0 || !groupId) {
    // 分组可能已存在——从 group/list 找
    const gl = await adsGet<{ list?: Array<{ group_id: string | number; group_name: string }> }>('/api/v1/group/list', {
      page: '1',
      page_size: '100',
    });
    const found = gl.data?.list?.find((x) => x.group_name === 'aidcp-probe');
    groupId = String(found?.group_id ?? '');
    console.log(`[probe] group/create code=${grp.code} msg=${grp.msg ?? ''} → 复用/查得 group_id=${groupId || '(none)'}`);
  } else {
    console.log(`[probe] 建分组 aidcp-probe → group_id=${groupId}`);
  }
  if (!groupId) throw new Error('拿不到 group_id，停手');

  const created: Array<{ key: string; userId: string; reading?: Reading; note: string }> = [];

  for (const p of PROBES) {
    const body = {
      group_id: groupId,
      name: p.key,
      user_proxy_config: { proxy_soft: 'no_proxy' },
      fingerprint_config: p.fp,
    };
    const res = await adsPost<{ id?: string; user_id?: string }>('/api/v1/user/create', body);
    const userId = String(res.data?.id ?? res.data?.user_id ?? '');
    if (res.code !== 0 || !userId) {
      console.log(`[probe] ✗ ${p.key} 建号失败 code=${res.code} msg=${res.msg ?? ''}`);
      created.push({ key: p.key, userId: '', note: `create-failed: ${res.msg ?? res.code}` });
      continue;
    }
    console.log(`[probe] ✓ 建 ${p.key} → user_id=${userId}（${p.question}）`);
    created.push({ key: p.key, userId, note: 'created' });
  }

  // 逐个真开 → 读 → 停
  for (const c of created) {
    if (!c.userId) continue;
    let closed = false;
    try {
      const start = await adsGet<{ debug_port?: string | number }>('/api/v1/browser/start', {
        user_id: c.userId,
        open_tabs: '1',
        ip_tab: '0',
        headless: '0',
        launch_args: JSON.stringify(['--window-size=1200,800', 'about:blank']),
      });
      const port = Number(start.data?.debug_port);
      if (start.code !== 0 || !port) {
        c.note = `start-failed: ${start.msg ?? start.code}`;
        console.log(`[probe] ✗ ${c.key} start 失败：${c.note}`);
        continue;
      }
      await waitCdp(port);
      const session = await attachToPage({ host: '127.0.0.1', port, stealth: false });
      try {
        await session.cdp.send('Page.navigate', { url: 'https://example.com/' });
        // deviceMemory 仅在安全上下文(HTTPS)暴露；about:blank 会恒为 undefined。等加载完成再读。
        {
          const deadline = Date.now() + 20000;
          for (;;) {
            const rs = await evalRaw<string>(session.cdp, 'String(document.readyState)').catch(() => '');
            const href = await evalRaw<string>(session.cdp, 'String(location.href)').catch(() => '');
            if (rs === 'complete' && href.startsWith('https://example.com')) break;
            if (Date.now() >= deadline) break;
            await sleep(400);
          }
        }
        await sleep(600);
        const raw = await evalRaw<string>(session.cdp, READ_JS);
        c.reading = JSON.parse(raw) as Reading;
        c.note = 'read-ok';
      } finally {
        session.close();
      }
    } catch (e) {
      c.note = `probe-error: ${(e as Error).message}`;
      console.log(`[probe] ✗ ${c.key} ${c.note}`);
    } finally {
      const stop = await adsGet<unknown>('/api/v1/browser/stop', { user_id: c.userId });
      closed = stop.code === 0;
      console.log(`[probe] ${c.key} browser/stop code=${stop.code}${closed ? '' : ' msg=' + (stop.msg ?? '')}`);
    }
  }

  // 结果表
  console.log('\n================ 探针结果 ================');
  for (const c of created) {
    console.log(`\n### ${c.key}  (user_id=${c.userId || 'n/a'})  [${c.note}]`);
    if (c.reading) {
      const r = c.reading;
      console.log(`  navigator.deviceMemory      = ${JSON.stringify(r.deviceMemory)}`);
      console.log(`  navigator.hardwareConcurrency = ${JSON.stringify(r.hardwareConcurrency)}`);
      console.log(`  navigator.platform          = ${r.platform}`);
      console.log(`  timezone                    = ${r.tz}   lang=${r.lang}`);
      console.log(`  navigator.webdriver         = ${JSON.stringify(r.webdriver)}`);
      console.log(`  WebGL vendor                = ${r.webglVendor}`);
      console.log(`  WebGL renderer              = ${r.webglRenderer}${r.webglErr ? '  err=' + r.webglErr : ''}`);
      console.log(`  canvasHash                  = ${r.canvasHash}`);
      console.log(`  UA                          = ${(r.ua ?? '').slice(0, 90)}…`);
    }
  }

  // 关键判读
  console.log('\n================ 判读 ================');
  const p1 = created.find((c) => c.key === 'P1-devmem6')?.reading;
  if (p1) {
    const dm = p1.deviceMemory;
    console.log(`Q1 device_memory=6 → navigator.deviceMemory=${JSON.stringify(dm)}  ⇒ ${dm === 6 ? '⚠ 静默接受(护栏必须拦)' : '已被纠正/忽略为 ' + JSON.stringify(dm)}`);
  }
  const p2 = created.find((c) => c.key === 'P2-webgl3+cfg')?.reading;
  const p3 = created.find((c) => c.key === 'P3-webgl2+cfg')?.reading;
  if (p2) console.log(`Q2 webgl=3 + NVIDIA config → renderer=${p2.webglRenderer}  ⇒ ${(p2.webglRenderer ?? '').includes('NVIDIA') ? 'config 生效' : 'config 被吞(随机池给出)'}`);
  if (p3) console.log(`   对照 webgl=2 + NVIDIA config → renderer=${p3.webglRenderer}  ⇒ ${(p3.webglRenderer ?? '').includes('NVIDIA') ? 'config 生效' : 'config 未生效'}`);
  if (p2 || p3) {
    const plat = (p2 ?? p3)?.platform;
    console.log(`   宿主/声明 OS 观察：platform=${plat}（本机 Mac；若 renderer 强给 Windows D3D11 → H6 现场：OS 与 renderer 不自洽）`);
  }

  // 清理：只删本次建的 id
  console.log('\n================ 清理（只删本次建的测试分身）================');
  for (const c of created) {
    if (!c.userId) continue;
    const del = await adsPost<unknown>('/api/v1/user/delete', { user_ids: [c.userId] });
    console.log(`[probe] user/delete ${c.key} ${c.userId} → code=${del.code} msg=${del.msg ?? ''}`);
  }
  console.log('\n[probe] done.');
}

main().catch((e) => {
  console.error('[probe] FATAL', e);
  process.exitCode = 1;
});
