#!/usr/bin/env tsx
/**
 * Facebook 首页「非空 Feed 已刷到底」只读真机探针。
 *
 * 目的：比较语言相关空态文案与语言无关信号，验证可否只靠结构/滚动/加载/网络判定没有新内容。
 * 探针会复用已打开的 AdsPower profile，只执行向下滚动与只读 CDP 采样；不导航、不点赞、不评论、不发帖，
 * 也不启动或关闭浏览器。默认 profile 是 Mi Xu（k1es035u）。
 *
 * 用法：
 *   npx tsx scripts/fb-feed-end-probe.ts [profile_id]
 *   AIDCP_FB_END_PROBE_ROUNDS=80 npx tsx scripts/fb-feed-end-probe.ts k1es035u
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { attachToPage } from '../src/cdp/index.js';
import { evalJson } from '../src/browse/cdp-util.js';
import { FacebookFeedReader } from '../src/facebook/feed-reader.js';

const PROFILE_ID = process.argv[2] ?? process.env.AIDCP_ADS_USER_ID ?? 'k1es035u';
const MAX_ROUNDS = Math.max(1, Number(process.env.AIDCP_FB_END_PROBE_ROUNDS ?? '60') || 60);
const REQUIRED_DRY_ROUNDS = Math.max(2, Number(process.env.AIDCP_FB_END_PROBE_DRY_ROUNDS ?? '4') || 4);
const CACHE_ROOT = path.join(os.homedir(), '.adspowerCli', 'source', 'cache');

interface PageState {
  href: string;
  readyState: string;
  scrollY: number;
  scrollHeight: number;
  innerHeight: number;
  remaining: number;
  loadingCount: number;
  feedPresent: boolean;
  semanticArticles: number;
  hydratedArticles: number;
  marker: null | {
    visible: boolean;
    text: string;
    inFeed: boolean;
    inMain: boolean;
    container: ElementShape;
    article: ElementShape | null;
    titleNode: ElementShape;
  };
  bottomElement: ElementShape | null;
}

interface ElementShape {
  tag: string;
  role: string;
  ariaHidden: string;
  dataVisualcompletion: string;
  childCount: number;
  directChildTags: string[];
  svgCount: number;
  headingCount: number;
  buttonCount: number;
  linkHrefs: string[];
  rect: { x: number; y: number; width: number; height: number };
  path: string;
}

interface GraphqlHit {
  requestId: string;
  friendlyName: string;
  sentAt: number;
  responseAt?: number;
  hasNextPageFalse: number;
  hasNextPageTrue: number;
}

const PAGE_STATE_JS = String.raw`(function(){
  function norm(v){return String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toLowerCase();}
  function visible(el){if(!el||!el.getBoundingClientRect)return false;var r=el.getBoundingClientRect();var s=getComputedStyle(el);return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0.01;}
  function seg(el){var s=String(el.tagName||'').toLowerCase();var role=el.getAttribute&&el.getAttribute('role');if(role)s+='[role='+role+']';return s;}
  function domPath(el){var out=[];var cur=el;while(cur&&cur.nodeType===1&&out.length<7){out.unshift(seg(cur));cur=cur.parentElement;}return out.join('>');}
  function shape(el){if(!el)return null;var r=el.getBoundingClientRect();var kids=[],hrefs=[],links=el.querySelectorAll('a[href]');for(var i=0;i<el.children.length&&i<12;i++)kids.push(seg(el.children[i]));for(var l=0;l<links.length&&l<8;l++){try{var u=new URL(links[l].getAttribute('href')||links[l].href||'',location.href);hrefs.push(u.origin===location.origin?u.pathname:u.origin+u.pathname);}catch(e){}}return {tag:String(el.tagName||'').toLowerCase(),role:el.getAttribute('role')||'',ariaHidden:el.getAttribute('aria-hidden')||'',dataVisualcompletion:el.getAttribute('data-visualcompletion')||'',childCount:el.children.length,directChildTags:kids,svgCount:el.querySelectorAll('svg').length,headingCount:el.querySelectorAll('h1,h2,h3,h4,[role=heading]').length,buttonCount:el.querySelectorAll('button,[role=button]').length,linkHrefs:Array.from(new Set(hrefs)),rect:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)},path:domPath(el)};}
  var root=document.scrollingElement||document.documentElement;
  var sh=Math.max(document.documentElement?document.documentElement.scrollHeight:0,document.body?document.body.scrollHeight:0);
  var sy=Number(window.scrollY||(root&&root.scrollTop)||0),ih=Number(window.innerHeight||0);
  var main=document.querySelector('[role=main],main'),feed=document.querySelector('[role=feed]');
  var articles=feed?feed.querySelectorAll('[role=article]'):document.querySelectorAll('[role=article]');var hydrated=0;
  for(var a=0;a<articles.length;a++){if(articles[a].querySelector('h2 a,h3 a,h4 a'))hydrated++;}
  var scope=main||document.body;var loading=scope?scope.querySelectorAll('[role=progressbar],[aria-busy=true]').length:0;
  var titleNode=null,compact=null,nodes=scope?scope.querySelectorAll('h1,h2,h3,h4,[role=heading],div,span'):[];
  for(var n=0;n<nodes.length;n++){var raw=String(nodes[n].innerText||nodes[n].textContent||'').replace(/\s+/g,' ').trim();if(raw.length<8||raw.length>180)continue;var t=norm(raw);if(/^(no more posts|there are no posts|khong con bai viet nao|khong co bai viet nao|没有更多帖子|没有帖子)[.!。]?$/.test(t)){titleNode=nodes[n];break;}}
  if(titleNode){var cur=titleNode;while(cur&&cur!==scope&&cur!==document.body){var own=String(cur.innerText||cur.textContent||'').replace(/\s+/g,' ').trim();var t=norm(own);var title=/(no more posts|there are no posts|khong con bai viet nao|khong co bai viet nao|没有更多帖子|没有帖子)/.test(t);var hint=/(add friends|them ban be|添加好友)/.test(t)&&/(feed|bang feed|动态消息|信息流)/.test(t);if(title&&hint&&own.length<=650)compact=cur;cur=cur.parentElement;} }
  var marker=null;if(titleNode&&compact){var article=titleNode.closest('[role=article]');marker={visible:visible(compact),text:String(compact.innerText||compact.textContent||'').replace(/\s+/g,' ').trim().slice(0,400),inFeed:!!(feed&&feed.contains(compact)),inMain:!!(main&&main.contains(compact)),container:shape(compact),article:shape(article),titleNode:shape(titleNode)};}
  var bottom=document.elementFromPoint(Math.max(1,Math.round(innerWidth/2)),Math.max(1,innerHeight-8));
  return JSON.stringify({href:location.href,readyState:document.readyState,scrollY:Math.round(sy),scrollHeight:Math.round(sh),innerHeight:Math.round(ih),remaining:Math.max(0,Math.round(sh-sy-ih)),loadingCount:loading,feedPresent:!!feed,semanticArticles:articles.length,hydratedArticles:hydrated,marker:marker,bottomElement:shape(bottom)});
})()`;

function findDebugPort(profileId: string): number {
  const prefix = `${profileId}_`;
  const candidates = fs.readdirSync(CACHE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(CACHE_ROOT, entry.name, 'DevToolsActivePort'))
    .filter((file) => fs.existsSync(file));
  for (const marker of candidates) {
    const port = Number(fs.readFileSync(marker, 'utf8').split(/\r?\n/, 1)[0]);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
  }
  throw new Error(`profile ${profileId} 没有可复用的 DevToolsActivePort；请先在 AIDCP/AdsPower 中打开该环境`);
}

function friendlyNameOf(postData: string | undefined): string {
  if (!postData) return '';
  try {
    const params = new URLSearchParams(postData);
    return params.get('fb_api_req_friendly_name') || params.get('doc_id') || '';
  } catch {
    return '';
  }
}

function compactRound(round: number, state: PageState, cardIds: string[], freshIds: string[], graphqlDelta: GraphqlHit[], dryRounds: number) {
  return {
    round,
    scroll: { y: state.scrollY, height: state.scrollHeight, viewport: state.innerHeight, remaining: state.remaining },
    dom: { feed: state.feedPresent, articles: state.semanticArticles, hydrated: state.hydratedArticles, loading: state.loadingCount },
    cards: { visible: cardIds.length, fresh: freshIds.length },
    graphql: {
      requests: graphqlDelta.length,
      names: [...new Set(graphqlDelta.map((hit) => hit.friendlyName).filter(Boolean))],
      hasNextPageFalse: graphqlDelta.reduce((sum, hit) => sum + hit.hasNextPageFalse, 0),
    },
    textMarker: state.marker ? { visible: state.marker.visible, text: state.marker.text } : null,
    languageIndependentDryRounds: dryRounds,
  };
}

async function main(): Promise<void> {
  const port = findDebugPort(PROFILE_ID);
  const session = await attachToPage({ host: '127.0.0.1', port, urlIncludes: 'facebook.com', stealth: false, network: true });
  const reader = new FacebookFeedReader({ cdp: session.cdp, logger: (message) => console.log(`[production] ${message}`) });
  const startedAt = Date.now();
  const graphql = new Map<string, GraphqlHit>();
  const bodyReads = new Set<Promise<void>>();

  const offRequest = session.cdp.on('Network.requestWillBeSent', (raw) => {
    const event = raw as { requestId?: string; request?: { url?: string; postData?: string } };
    if (!event.requestId || !/\/api\/graphql/i.test(event.request?.url ?? '')) return;
    graphql.set(event.requestId, {
      requestId: event.requestId,
      friendlyName: friendlyNameOf(event.request?.postData),
      sentAt: Date.now() - startedAt,
      hasNextPageFalse: 0,
      hasNextPageTrue: 0,
    });
  });
  const offResponse = session.cdp.on('Network.responseReceived', (raw) => {
    const event = raw as { requestId?: string };
    const hit = event.requestId ? graphql.get(event.requestId) : undefined;
    if (hit) hit.responseAt = Date.now() - startedAt;
  });
  const offFinished = session.cdp.on('Network.loadingFinished', (raw) => {
    const event = raw as { requestId?: string };
    const hit = event.requestId ? graphql.get(event.requestId) : undefined;
    if (!hit) return;
    const read = (async () => {
      try {
        const result = await session.cdp.send<{ body?: string; base64Encoded?: boolean }>('Network.getResponseBody', { requestId: hit.requestId });
        const body = result.base64Encoded ? Buffer.from(result.body ?? '', 'base64').toString('utf8') : result.body ?? '';
        hit.hasNextPageFalse = (body.match(/"has_next_page"\s*:\s*false/g) ?? []).length;
        hit.hasNextPageTrue = (body.match(/"has_next_page"\s*:\s*true/g) ?? []).length;
      } catch {
        // 响应体可能被浏览器淘汰；网络证据是加分项，不得反向制造“已到底”。
      }
    })();
    bodyReads.add(read);
    void read.finally(() => bodyReads.delete(read));
  });

  try {
    let state = await evalJson<PageState>(session.cdp, PAGE_STATE_JS);
    if (!/^https:\/\/(?:www\.)?facebook\.com\/?(?:[?#].*)?$/i.test(state.href)) {
      throw new Error(`探针只接受已打开的 Facebook 首页，当前是 ${state.href}`);
    }
    const seenIds = new Set<string>();
    const initialCards = await reader.scanCards();
    for (const card of initialCards) seenIds.add(card.noteId);
    console.log(JSON.stringify({ event: 'start', profileId: PROFILE_ID, port, href: state.href, initialCards: initialCards.length, state }));

    let dryRounds = 0;
    let roundsExecuted = 0;
    let lastHeight = state.scrollHeight;
    let lastGraphqlSize = graphql.size;
    let finalState = state;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      roundsExecuted = round;
      await reader.scrollNext();
      await sleep(700);
      const cards = await reader.scanCards();
      state = await evalJson<PageState>(session.cdp, PAGE_STATE_JS);
      await Promise.allSettled([...bodyReads]);
      const freshIds = cards.map((card) => card.noteId).filter((id) => !seenIds.has(id));
      for (const card of cards) seenIds.add(card.noteId);
      const allHits = [...graphql.values()];
      const graphqlDelta = allHits.slice(lastGraphqlSize);
      lastGraphqlSize = allHits.length;

      const heightStable = Math.abs(state.scrollHeight - lastHeight) <= 16;
      const nearBottom = state.innerHeight > 0 && state.remaining <= Math.max(120, Math.round(state.innerHeight * 0.15));
      const networkQuiet = graphqlDelta.length === 0 && bodyReads.size === 0;
      const noNewCards = freshIds.length === 0;
      const noLoader = state.loadingCount === 0;
      dryRounds = heightStable && nearBottom && networkQuiet && noNewCards && noLoader ? dryRounds + 1 : 0;
      lastHeight = state.scrollHeight;
      finalState = state;
      console.log(JSON.stringify(compactRound(round, state, cards.map((card) => card.noteId), freshIds, graphqlDelta, dryRounds)));
      if (dryRounds >= REQUIRED_DRY_ROUNDS) break;
    }

    await Promise.allSettled([...bodyReads]);
    const hits = [...graphql.values()];
    const falseWitnesses = hits.filter((hit) => hit.hasNextPageFalse > 0).map((hit) => ({
      friendlyName: hit.friendlyName,
      falseCount: hit.hasNextPageFalse,
      trueCount: hit.hasNextPageTrue,
      sentAt: hit.sentAt,
      responseAt: hit.responseAt,
    }));
    console.log(JSON.stringify({
      event: 'result',
      profileId: PROFILE_ID,
      rounds: roundsExecuted,
      languageIndependentPlateau: dryRounds >= REQUIRED_DRY_ROUNDS,
      dryRounds,
      totalUniqueProductionCards: seenIds.size,
      textMarkerObserved: Boolean(finalState.marker),
      markerStructure: finalState.marker,
      bottomElement: finalState.bottomElement,
      graphqlHasNextPageFalseWitnesses: falseWitnesses,
      note: '文字标记仅作对照；languageIndependentPlateau 只使用高度/距底/新卡/loading/网络安静。',
    }));
  } finally {
    offRequest();
    offResponse();
    offFinished();
    session.close();
  }
}

main().catch((error) => {
  console.error(`[fb-feed-end-probe] ${(error as Error).stack ?? (error as Error).message}`);
  process.exitCode = 1;
});
