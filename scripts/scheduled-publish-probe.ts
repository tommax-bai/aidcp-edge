/**
 * Controlled XHS scheduled-publish probe.
 *
 * Safety properties:
 * - refuses to run without an explicit confirmation token;
 * - verifies the logged-in stable account id before any write;
 * - executes the production PublishCommandDispatcher sequence;
 * - deletes the uniquely matched scheduled record before reporting success;
 * - leaves the browser open on any failure so an operator can clean up manually.
 *
 * PowerShell:
 *   $env:AIDCP_SCHEDULE_PROBE_CONFIRM='ENGINEER_DABAI'
 *   $env:AIDCP_CDP_PORT='<AdsPower debug port>'
 *   npx tsx scripts/scheduled-publish-probe.ts
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import { attachToPage, readSelfIdentity } from '../src/cdp/index.js';
import { CdpFileInputSetter } from '../src/cdp/file-input-setter.js';
import { PublishCommandDispatcher } from '../src/flows/publish-command-handlers.js';
import { ImageUploader } from '../src/flows/image-uploader.js';
import { AnchorCache } from '../src/locating/cache.js';
import type { ElementDescriptor, ElementSelector, SelectionResult } from '../src/locating/index.js';
import type { PublishCommandPayload, PublishCommandResultPayload } from '../src/comm/protocol.js';

const CONFIRM_TOKEN = 'ENGINEER_DABAI';
const EXPECTED_ACCOUNT_ID = '63e2ff0500000000260049ce';
const RECORD_ID = 999_071_801;
const TASK_ID = 'probe:xhs-native-scheduled-publish';
const HOST = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
const PORT = Number(process.env.AIDCP_CDP_PORT ?? 0);
const MANAGE_URL = 'https://creator.xiaohongshu.com/new/note-manager?source=official';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const stubSelector: ElementSelector = {
  async select(_goal: string, _elements: ElementDescriptor[]): Promise<SelectionResult> {
    return { index: null, reason: 'scheduled-probe-no-llm' };
  },
};

function command(
  seq: number,
  kind: PublishCommandPayload['kind'],
  params: PublishCommandPayload['params'] = {},
): PublishCommandPayload {
  return {
    taskId: TASK_ID,
    recordId: RECORD_ID,
    seq,
    kind,
    params,
    platform: 'xiaohongshu',
    reason: 'controlled_engineer_dabai_probe',
  };
}

async function serveProbeImage(): Promise<{ url: string; close: () => Promise<void> }> {
  const bytes = await readFile(fileURLToPath(new URL('../src/electron/renderer/assets/mascot-task-execution-512.png', import.meta.url)));
  const server = createServer((_req, response) => {
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(bytes.length),
      'cache-control': 'no-store',
    });
    response.end(bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/probe.png`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function evaluateJson<T>(
  cdp: { send: <R = unknown>(method: string, params?: Record<string, unknown>) => Promise<R> },
  expression: string,
): Promise<T> {
  const response = await cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return JSON.parse(response.result?.value ?? '{}') as T;
}

async function clickScheduledRecordDelete(
  cdp: { send: <R = unknown>(method: string, params?: Record<string, unknown>) => Promise<R> },
  scheduledId: string,
  title: string,
): Promise<void> {
  const locateAndClick = String.raw`(() => {
    const wantedId=${JSON.stringify(scheduledId)};
    const wantedTitle=${JSON.stringify(title)};
    const visible=(el)=>{try{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}catch(e){return false;}};
    const norm=(s)=>String(s||'').replace(/\s+/g,'').trim();
    const seen=new Set();const rows=[];
    const seeds=Array.from(document.querySelectorAll('.note-card[data-impression],[data-impression],a[href*="/explore/"],a[href*="/discovery/item/"]'));
    for(const seed of seeds){
      const row=seed.closest('.note-card')||seed.closest('tr,li,[class*="note" i],[class*="card" i],[class*="item" i]')||seed.parentElement||seed;
      if(!row||seen.has(row))continue;seen.add(row);
      const raw=[row,...Array.from(row.querySelectorAll('[data-impression]'))].map((el)=>el.getAttribute&&el.getAttribute('data-impression')||'').join(' ');
      const text=norm(row.innerText||row.textContent||'');
      if(raw.includes(wantedId)||text.includes(norm(wantedTitle)))rows.push(row);
    }
    if(rows.length===0)return JSON.stringify({ok:false,reason:'scheduled_row_missing',count:0});
    const keys=new Set(rows.map((row)=>{const raw=[row,...Array.from(row.querySelectorAll('[data-impression]'))].map((el)=>el.getAttribute&&el.getAttribute('data-impression')||'').join(' ');return (raw.match(/["'](?:note_id|noteId)["']\s*:\s*["']([0-9a-f]{16,32})["']/i)||[])[1]||norm(row.innerText||row.textContent||'');}));
    if(keys.size!==1)return JSON.stringify({ok:false,reason:'scheduled_row_ambiguous',count:rows.length,keys:Array.from(keys)});
    const row=rows.find((candidate)=>{const r=candidate.getBoundingClientRect();return r.bottom>0&&r.top<(window.innerHeight||0);})||rows[0];
    const iconDelete=row.querySelector('.note-card__action-btn--del');
    if(iconDelete&&visible(iconDelete)){iconDelete.click();return JSON.stringify({ok:true,stage:'row-action',labels:['delete-icon']});}
    const controls=Array.from(row.querySelectorAll('button,a,[role="button"],[class*="action-btn" i]')).filter(visible);
    const labels=controls.map((el)=>norm(el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('title')||'')).filter(Boolean);
    const remove=controls.find((el)=>{const x=norm(el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('title')||'');return x==='删除'||x==='取消定时';});
    if(remove){remove.click();return JSON.stringify({ok:true,stage:'row-action',labels});}
    const more=controls.find((el)=>{const x=norm(el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('title')||'');return x==='更多'||/更多|more|menu|ellipsis/i.test(x);});
    if(more){more.click();return JSON.stringify({ok:true,stage:'row-menu',labels});}
    return JSON.stringify({ok:false,reason:'delete_control_missing',labels});
  })()`;
  const first = await evaluateJson<{ ok: boolean; reason?: string; stage?: string; labels?: string[] }>(cdp, locateAndClick);
  console.log('[probe] cleanup row:', JSON.stringify(first));
  if (!first.ok) throw new Error(`cleanup_failed:${first.reason ?? 'unknown'}`);

  if (first.stage === 'row-menu') {
    await sleep(600);
    const menuResult = await evaluateJson<{ ok: boolean; reason?: string; labels?: string[] }>(cdp, String.raw`(() => {
      const visible=(el)=>{try{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}catch(e){return false;}};
      const norm=(s)=>String(s||'').replace(/\s+/g,'').trim();
      const controls=Array.from(document.querySelectorAll('button,a,[role="button"],li,[class*="menu" i] div,[class*="dropdown" i] div')).filter(visible);
      const labels=controls.map((el)=>norm(el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('title')||'')).filter(Boolean);
      const remove=controls.find((el)=>{const x=norm(el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('title')||'');return x==='删除'||x==='取消定时';});
      if(!remove)return JSON.stringify({ok:false,reason:'delete_menu_item_missing',labels:labels.slice(-30)});
      remove.click();return JSON.stringify({ok:true,labels:labels.slice(-30)});
    })()`);
    console.log('[probe] cleanup menu:', JSON.stringify(menuResult));
    if (!menuResult.ok) throw new Error(`cleanup_failed:${menuResult.reason ?? 'unknown'}`);
  }

  await sleep(600);
  const confirmation = await evaluateJson<{ clicked: boolean; labels: string[] }>(cdp, String.raw`(() => {
    const visible=(el)=>{try{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}catch(e){return false;}};
    const norm=(s)=>String(s||'').replace(/\s+/g,'').trim();
    const dialogs=Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="modal" i]')).filter(visible);
    if(!dialogs.length)return JSON.stringify({clicked:false,labels:[]});
    const controls=dialogs.flatMap((root)=>Array.from(root.querySelectorAll('button,a,[role="button"]'))).filter(visible);
    const labels=controls.map((el)=>norm(el.innerText||el.textContent||'')).filter(Boolean);
    const confirm=controls.find((el)=>{const x=norm(el.innerText||el.textContent||'');return x==='确认删除'||x==='删除'||x==='确定';});
    if(confirm){confirm.click();return JSON.stringify({clicked:true,labels});}
    return JSON.stringify({clicked:false,labels});
  })()`);
  console.log('[probe] cleanup confirmation:', JSON.stringify(confirmation));

  // The manager can render duplicate virtual-list replicas for the same note id. A successful
  // delete may remove only the clicked replica locally, so reload before asserting backend absence.
  await cdp.send('Page.navigate', { url: MANAGE_URL });
  await sleep(2_000);

  const deadline = Date.now() + 12_000;
  for (;;) {
    const state = await evaluateJson<{ present: boolean; matches: number }>(cdp, String.raw`(() => {
      const wantedId=${JSON.stringify(scheduledId)};
      const wantedTitle=${JSON.stringify(title)};
      const norm=(s)=>String(s||'').replace(/\s+/g,'').trim();
      const nodes=Array.from(document.querySelectorAll('[data-impression],tr,li,[class*="note" i],[class*="card" i],[class*="item" i]'));
      const matches=nodes.filter((el)=>{const raw=el.getAttribute&&el.getAttribute('data-impression')||'';const text=norm(el.innerText||el.textContent||'');return raw.includes(wantedId)||text.includes(norm(wantedTitle));});
      return JSON.stringify({present:matches.length>0,matches:matches.length});
    })()`);
    if (!state.present) return;
    if (Date.now() >= deadline) throw new Error(`cleanup_failed:scheduled_row_still_present(matches=${state.matches})`);
    await sleep(500);
  }
}

async function dispatchOrThrow(
  dispatcher: PublishCommandDispatcher,
  payload: PublishCommandPayload,
): Promise<PublishCommandResultPayload> {
  const startedAt = Date.now();
  const result = await dispatcher.dispatch(payload);
  console.log(`[probe] ${payload.seq} ${payload.kind} ${result.ok ? 'OK' : 'FAIL'} ${Date.now() - startedAt}ms ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error(`${payload.kind}:${result.error ?? 'unknown'}`);
  return result;
}

async function main(): Promise<void> {
  if (process.env.AIDCP_SCHEDULE_PROBE_CONFIRM !== CONFIRM_TOKEN) {
    throw new Error(`refusing_write: set AIDCP_SCHEDULE_PROBE_CONFIRM=${CONFIRM_TOKEN}`);
  }
  if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65_535) {
    throw new Error('invalid_or_missing_AIDCP_CDP_PORT');
  }

  const session = await attachToPage({ host: HOST, port: PORT, urlIncludes: 'xiaohongshu', stealth: false });
  let cleaned = false;
  let imageServer: Awaited<ReturnType<typeof serveProbeImage>> | undefined;
  try {
    const identity = await readSelfIdentity(session.cdp, { allowNavigate: true });
    if (!identity.ok) throw new Error(`identity_unavailable:${identity.reason}`);
    console.log('[probe] identity:', JSON.stringify(identity.identity));
    if (identity.identity.accountId !== EXPECTED_ACCOUNT_ID) {
      throw new Error(`account_mismatch: expected=${EXPECTED_ACCOUNT_ID} actual=${identity.identity.accountId}`);
    }

    const publishTime = Math.ceil((Date.now() + 90 * 60_000) / 60_000) * 60_000;
    const suffix = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date()).replace(/\D/g, '');
    const title = `定时探针${suffix}`;
    const content = '定时发布能力受控探针。用于验证提交、定时列表对账与清理，创建后立即删除，不会公开发布。';
    console.log('[probe] plan:', JSON.stringify({ title, publishTime, iso: new Date(publishTime).toISOString() }));

    imageServer = await serveProbeImage();
    const uploader = new ImageUploader({
      fileInputSetter: new CdpFileInputSetter(session.cdp, {
        inputSelector: "document.querySelector('input.upload-input[type=file]') || document.querySelector('input[type=file]')",
      }),
      dom: session.dom,
      tempDirPrefix: 'aidcp-img-scheduled-probe-',
      allowHttp: true,
      tempRetainMs: 0,
      hasThumbnail: (root) => {
        try {
          return Array.from(root.querySelectorAll('.img-preview-area img, img#creator-preview-image-0')).some(
            (image) => (image.getAttribute('src') || '').length > 0,
          );
        } catch {
          return false;
        }
      },
    });
    const dispatcher = new PublishCommandDispatcher(
      { dom: session.dom, executor: session.executor, selector: stubSelector, cache: new AnchorCache() },
      {},
      Date.now,
      uploader,
      session.cdp,
      { enabled: false },
    );

    const sequence: PublishCommandPayload[] = [
      command(0, 'navigate_entry'),
      command(1, 'select_mode'),
      command(2, 'upload_image', { imageUrl: imageServer.url }),
      command(3, 'fill_field', { fieldType: 'title', value: title }),
      command(4, 'fill_field', { fieldType: 'content', value: content }),
      command(5, 'set_schedule', { publishTime }),
      command(6, 'submit_publish'),
      command(7, 'capture_scheduled', { publishTime, scheduledTitle: title }),
    ];
    let capture: PublishCommandResultPayload | undefined;
    for (const payload of sequence) capture = await dispatchOrThrow(dispatcher, payload);
    const scheduledId = capture?.value?.trim() ?? '';
    if (!scheduledId) throw new Error('capture_scheduled:missing_internal_id');
    console.log('[probe] scheduled record captured:', JSON.stringify({ scheduledId, title, publishTime }));

    await clickScheduledRecordDelete(session.cdp, scheduledId, title);
    cleaned = true;
    console.log('[probe] PASS: scheduled record was uniquely captured and deleted; no public post id/link was expected or fabricated.');
    await session.cdp.send('Page.navigate', { url: 'https://www.xiaohongshu.com/explore' }).catch(() => undefined);
  } finally {
    await imageServer?.close().catch(() => undefined);
    session.close();
    if (!cleaned) {
      console.error('[probe] IMPORTANT: cleanup was not confirmed; AdsPower must remain open for manual inspection.');
    }
  }
}

main().catch((error) => {
  console.error('[probe] FAILED:', error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
