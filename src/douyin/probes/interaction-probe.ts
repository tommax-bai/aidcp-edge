import {
  defaultRandom,
  dispatchClick,
  dispatchKeystrokes,
  evalJson,
  pressEnter,
  type BrowseCdp,
  type RandomFn,
} from '../../browse/cdp-util.js';

export const DOUYIN_START_URL = 'https://www.douyin.com/jingxuan';
export const DOUYIN_LIVE_URL = 'https://live.douyin.com/';

export type DouyinBlockReason =
  | 'none'
  | 'not_douyin'
  | 'login_required'
  | 'challenge'
  | 'access_restricted';
export type DouyinLoginState = 'logged_in' | 'logged_out' | 'unknown';
export type ToggleState = 'active' | 'inactive' | 'unknown';

export interface PointTarget {
  found: boolean;
  ambiguous: boolean;
  centerX?: number;
  centerY?: number;
  state?: ToggleState;
  evidence?: string;
  hitReady?: boolean;
}

export interface DouyinPageSnapshot {
  host: string;
  path: string;
  modalId?: string;
  modalReady: boolean;
  blockReason: DouyinBlockReason;
  loginState: DouyinLoginState;
  card?: { awemeId: string; centerX: number; centerY: number };
  like: PointTarget;
  follow: PointTarget;
  collect: PointTarget;
  interactionPrompt: PointTarget;
}

export interface DouyinSafeSnapshot {
  host: string;
  path: string;
  modalId?: string;
  modalReady: boolean;
  blockReason: DouyinBlockReason;
  loginState: DouyinLoginState;
  cardId?: string;
  like: Pick<PointTarget, 'found' | 'ambiguous' | 'state' | 'evidence'>;
  follow: Pick<PointTarget, 'found' | 'ambiguous' | 'state' | 'evidence'>;
  collect: Pick<PointTarget, 'found' | 'ambiguous' | 'state' | 'evidence'>;
  interactionPrompt: Pick<PointTarget, 'found' | 'ambiguous'>;
}

export const DOUYIN_PAGE_SNAPSHOT_JS = String.raw`(function(){/*aidcp:douyin-page-snapshot*/
  var vw=Math.max(1,innerWidth||document.documentElement.clientWidth||1280),vh=Math.max(1,innerHeight||document.documentElement.clientHeight||800);
  function rect(el){try{return el&&el.getBoundingClientRect?el.getBoundingClientRect():null;}catch(e){return null;}}
  function visible(el){var r=rect(el);if(!r||r.width<2||r.height<2||r.bottom<=0||r.top>=vh||r.right<=0||r.left>=vw)return false;var s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';}
  function effectiveRect(el){var own=rect(el);if(own&&own.width>=2&&own.height>=2)return own;var children=Array.prototype.slice.call((el&&el.querySelectorAll&&el.querySelectorAll('svg,button,[role="button"]'))||[]).map(rect).filter(function(r){return r&&r.width>=2&&r.height>=2&&r.bottom>0&&r.top<vh&&r.right>0&&r.left<vw;}).sort(function(a,b){return b.width*b.height-a.width*a.height;});return children[0]||own;}
  function point(el){var r=effectiveRect(el);return r?{centerX:Math.round(r.left+r.width/2),centerY:Math.round(r.top+r.height/2)}:{};}
  function label(el){return [el.getAttribute('aria-label')||'',el.getAttribute('title')||'',el.getAttribute('data-e2e')||'',String(el.innerText||el.textContent||'').trim().slice(0,80)].join(' ').trim();}
  function exactNodes(selector){return Array.prototype.slice.call(document.querySelectorAll(selector)).filter(function(el){var r=effectiveRect(el);return !!(r&&r.width>=2&&r.height>=2&&r.bottom>0&&r.top<vh&&r.right>0&&r.left<vw);});}
  function colors(el){var nodes=[el].concat(Array.prototype.slice.call(el.querySelectorAll('svg,path')).slice(0,48)),out=[];nodes.forEach(function(n){try{var c=getComputedStyle(n);out.push(c.color||'',c.fill||'',c.stroke||'',n.getAttribute('fill')||'',n.getAttribute('stroke')||'');}catch(e){}});return out.join(' ');}
  function likeState(el){if(!el)return {state:'unknown',evidence:'missing'};var p=el.getAttribute('aria-pressed'),e=el.getAttribute('data-e2e-state'),c=colors(el),svg=el.querySelector('svg[viewBox="0 0 24 24"]'),paths=svg?Array.prototype.slice.call(svg.querySelectorAll('path')):[],heart=paths.length===1&&/^M2\.00534 9C2\.00179 8\.91711/.test(paths[0].getAttribute('d')||''),active=/(rgb\(254\s*,\s*44\s*,\s*85\)|#fe2c55)/i.test(c),neutral=/(rgb\(255\s*,\s*255\s*,\s*255\)|#fff(?:fff)?\b)/i.test(c);if(p==='true'||e==='video-player-is-digged'||(heart&&active))return {state:'active',evidence:p==='true'?'aria_pressed':(e==='video-player-is-digged'?'digged_state':'heart_active')};if(p==='false'||(heart&&neutral&&!active))return {state:'inactive',evidence:p==='false'?'aria_pressed_false':'heart_inactive'};return {state:'unknown',evidence:heart?'heart_color_unclassified':'heart_structure_unclassified'};}
  function followState(el){if(!el)return {state:'unknown',evidence:'missing'};var l=label(el),p=el.getAttribute('aria-pressed'),c=colors(el),animated=!!el.querySelector('svg[viewBox="0 0 90 90"]');if(p==='true'||animated||/(已关注|互相关注|取消关注)/.test(l))return {state:'active',evidence:p==='true'?'aria_pressed':(animated?'follow_animation':'label_following')};if(p==='false'||/(^|\s)关注(\s|$)/.test(l)||/(rgb\(254\s*,\s*44\s*,\s*85\)|#fe2c55)/i.test(c))return {state:'inactive',evidence:p==='false'?'aria_pressed_false':(/关注/.test(l)?'label_follow':'icon_plus')};return {state:'unknown',evidence:'unclassified'};}
  function collectState(el){if(!el)return {state:'unknown',evidence:'missing'};var l=label(el),p=el.getAttribute('aria-pressed'),c=colors(el);if(p==='true'||/(取消收藏|已收藏)/.test(l)||/(rgb\(250\s*,\s*206\s*,\s*21\)|#face15|rgb\(255\s*,\s*211\s*,\s*0\))/i.test(c))return {state:'active',evidence:p==='true'?'aria_pressed':(/取消收藏|已收藏/.test(l)?'label_collected':'icon_active')};if(p==='false'||/(^|\s)收藏(\s|$)/.test(l)||/(rgb\(255\s*,\s*255\s*,\s*255\)|#fff(?:fff)?\b)/i.test(c))return {state:'inactive',evidence:p==='false'?'aria_pressed_false':(/(^|\s)收藏(\s|$)/.test(l)?'label_collect':'icon_neutral')};return {state:'unknown',evidence:'unclassified'};}
  function control(selector,stateFn){var nodes=exactNodes(selector),out={found:nodes.length===1,ambiguous:nodes.length>1};if(nodes.length===1){var p=point(nodes[0]),s=stateFn(nodes[0]),top=document.elementFromPoint?document.elementFromPoint(p.centerX,p.centerY):nodes[0];out.centerX=p.centerX;out.centerY=p.centerY;out.state=s.state;out.evidence=s.evidence;out.hitReady=!!(top&&(top===nodes[0]||nodes[0].contains(top)));}return out;}
  var host=String(location.hostname||'').toLowerCase(),path=String(location.pathname||'/').slice(0,220),body=String((document.body&&document.body.innerText)||'').slice(0,6000);
  var isDouyin=host==='douyin.com'||host.endsWith('.douyin.com');
  var challenge=/(?:captcha|challenge|verify|security-check)/i.test(path)||Array.prototype.slice.call(document.querySelectorAll('iframe[src*="captcha" i],iframe[src*="verify" i],[id*="captcha" i],[class*="captcha" i]')).some(visible)||/(安全验证|完成验证|拖动滑块|访问过于频繁)/.test(body);
  var loginPath=/^\/(?:login|passport)(?:\/|$)/i.test(path),loginNode=Array.prototype.slice.call(document.querySelectorAll('input[type="password"],input[placeholder*="手机号"],button[data-e2e*="login" i]')).some(visible);
  var restricted=/(Unable to access the website|暂时无法访问|页面不可用|访问受限|网络错误)/i.test(body);
  var loggedIn=!!document.querySelector('a[href*="/user/self"],[data-e2e="im-entry"]'),loggedOut=Array.prototype.slice.call(document.querySelectorAll('button[data-e2e*="login" i]')).some(visible);
  var blockReason=!isDouyin?'not_douyin':(challenge?'challenge':((loginPath||loginNode)?'login_required':(restricted?'access_restricted':'none'))),loginState=loggedIn?'logged_in':((loginPath||loginNode||loggedOut)?'logged_out':'unknown');
  var modalId='';try{modalId=new URL(location.href).searchParams.get('modal_id')||'';}catch(e){}
  var cards=Array.prototype.slice.call(document.querySelectorAll('[data-aweme-id]')).filter(visible).map(function(el){var r=rect(el);return {awemeId:String(el.getAttribute('data-aweme-id')||''),centerX:Math.round(r.left+r.width/2),centerY:Math.round(r.top+Math.min(r.height*0.45,Math.max(20,r.height/2))),score:Math.abs((r.top+r.height/2)-vh/2)};}).filter(function(x){return /^\d{12,24}$/.test(x.awemeId);}).sort(function(a,b){return a.score-b.score;});
  var card=cards[0]?{awemeId:cards[0].awemeId,centerX:cards[0].centerX,centerY:cards[0].centerY}:undefined;
  var follow=control('[data-e2e="feed-follow-icon"]',followState),activeVideo=exactNodes('[data-e2e="feed-active-video"]').length===1;
  if(modalId&&activeVideo&&!follow.found&&!follow.ambiguous)follow={found:true,ambiguous:false,state:'active',evidence:'follow_control_absent'};
  var prompts=Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(el){return visible(el)&&String(el.innerText||el.textContent||'').trim()==='我知道了';}),interactionPrompt={found:prompts.length===1,ambiguous:prompts.length>1};if(prompts.length===1)Object.assign(interactionPrompt,point(prompts[0]));
  return JSON.stringify({host:host,path:path,modalId:modalId||undefined,modalReady:!!(modalId&&activeVideo),blockReason:blockReason,loginState:loginState,card:card,like:control('[data-e2e="video-player-digg"]',likeState),follow:follow,collect:control('[data-e2e="video-player-collect"]',collectState),interactionPrompt:interactionPrompt});
})()`;

export interface DmSnapshot {
  host: string;
  blockReason: DouyinBlockReason;
  entry: PointTarget;
  dialogOpen: boolean;
  inboundConversation?: { centerX: number; centerY: number; proof: 'unread_badge' | 'sender_prefix'; fingerprint: string };
  inboundAmbiguous: boolean;
  selectedFingerprint?: string;
  conversationKind: 'group' | 'private' | 'unknown';
  latestDirection: 'inbound' | 'outbound' | 'unknown';
  editor: PointTarget & { empty?: boolean };
  send: PointTarget;
}

export const DOUYIN_DM_SNAPSHOT_JS = String.raw`(function(){/*aidcp:douyin-dm-snapshot*/
  var vw=Math.max(1,innerWidth||1280),vh=Math.max(1,innerHeight||800);
  function rect(el){try{return el&&el.getBoundingClientRect?el.getBoundingClientRect():null;}catch(e){return null;}}
  function visible(el){var r=rect(el);if(!r||r.width<2||r.height<2||r.bottom<=0||r.top>=vh||r.right<=0||r.left>=vw)return false;var s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';}
  function pt(el){var r=rect(el);return r?{centerX:Math.round(r.left+r.width/2),centerY:Math.round(r.top+r.height/2)}:{};}
  function target(nodes){nodes=nodes.filter(visible);var out={found:nodes.length===1,ambiguous:nodes.length>1};if(nodes.length===1)Object.assign(out,pt(nodes[0]));return out;}
  function fingerprint(value){var text=String(value||''),hash=2166136261;for(var i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619);return (hash>>>0).toString(16);}
  var host=String(location.hostname||'').toLowerCase(),body=String((document.body&&document.body.innerText)||'').slice(0,5000),isDouyin=host==='douyin.com'||host.endsWith('.douyin.com');
  var blockReason=!isDouyin?'not_douyin':(/安全验证|完成验证|拖动滑块|访问过于频繁/.test(body)?'challenge':'none');
  var entry=target(Array.prototype.slice.call(document.querySelectorAll('[data-e2e="im-entry"]'))),dialog=Array.prototype.slice.call(document.querySelectorAll('[data-e2e="im-dialog"]')).filter(visible);
  var inbound=[];
  if(dialog.length===1){Array.prototype.slice.call(dialog[0].querySelectorAll('[data-e2e="conversation-item"]')).filter(visible).forEach(function(item){
    var preview=item.querySelector('pre[class*="ConversationItemHint"],pre'),text=String(preview&&preview.textContent||'').trim(),unread=item.querySelector('[class*="UnReadCount"] [class*="badge-count"],[class*="UnreadCount"] [class*="badge-count"],[class*="UnReadCount"][class*="badge"]'),sender=text.match(/^([^:：]{1,40})[:：]/);
    var system=/(授权|系统通知|账号主体|服务通知)/.test(text),outbound=/^我[:：]/.test(text),proof=(unread&&visible(unread))?'unread_badge':((sender&&sender[1]!=='我')?'sender_prefix':'');
    var title=item.querySelector('.conversationConversationItemtitle'),titleText=String(title&&title.textContent||'').trim();
    if(proof&&!system&&!outbound&&titleText){var p=pt(item);inbound.push({centerX:p.centerX,centerY:p.centerY,proof:proof,fingerprint:fingerprint(titleText)});}
  });}
  var right=dialog.length===1?dialog[0].querySelector('.componentsRightPanelwrapper'):null,selectedTitle=right&&right.querySelector('.RightPanelHeadertitle'),selectedTitleText=String(selectedTitle&&selectedTitle.textContent||'').trim(),selectedFingerprint=selectedTitleText?fingerprint(selectedTitleText):undefined;
  var messageBoxes=right?Array.prototype.slice.call(right.querySelectorAll('[class*="messageMessageBoxmessageBox"]')):[],senderTitles=right?right.querySelectorAll('.MessageBoxMessageTitleavatarName').length:0,groupSignals=right?right.querySelectorAll('.ContentBottomHasReadisGroup,.MessageItemGroupNoticeGroupNoticeBox').length:0;
  var conversationKind=(groupSignals>0||senderTitles>0)?'group':(messageBoxes.length>0?'private':'unknown'),messageContents=messageBoxes.map(function(box){return box.querySelector('[class*="messageMessageBoxcontentBox"]');}).filter(Boolean),latestContent=messageContents[messageContents.length-1],latestDirection=latestContent?(String(latestContent.className||'').indexOf('messageMessageBoxisFromMe')>=0?'outbound':'inbound'):'unknown';
  var editorNodes=Array.prototype.slice.call(document.querySelectorAll('[data-e2e="msg-input"] textarea,[data-e2e="msg-input"] [contenteditable="true"]')).filter(function(el){var r=rect(el),container=el.closest('[data-e2e="msg-input"]');if(!r||r.height<2||!visible(container))return false;var p=[el.getAttribute('placeholder')||'',el.getAttribute('data-placeholder')||'',el.getAttribute('aria-label')||'',String(el.className||'')].join(' ');return !/搜索/.test(p);});
  var editor={found:editorNodes.length===1,ambiguous:editorNodes.length>1};
  if(editorNodes.length===1){var v='value' in editorNodes[0]?String(editorNodes[0].value||''):String(editorNodes[0].textContent||'');editor.empty=v.replace(/[\u200b\u200c\u200d\ufeff]/g,'').length===0;}
  var sends=Array.prototype.slice.call(document.querySelectorAll('[data-e2e="msg-input"] .e2e-send-msg-btn,[data-e2e="im-dialog"] button,[data-e2e="im-dialog"] [role="button"]')).filter(function(el){return visible(el)&&(/e2e-send-msg-btn/.test(String(el.className&&el.className.baseVal||el.className||''))||/^(发送|Send)$/i.test(String(el.innerText||el.getAttribute('aria-label')||'').trim()));});
  return JSON.stringify({host:host,blockReason:blockReason,entry:entry,dialogOpen:dialog.length===1,inboundConversation:inbound.length===1?inbound[0]:undefined,inboundAmbiguous:inbound.length>1,selectedFingerprint:selectedFingerprint,conversationKind:conversationKind,latestDirection:latestDirection,editor:editor,send:target(sends)});
})()`;

const DOUYIN_DM_FOCUS_JS = String.raw`(function(){/*aidcp:douyin-dm-focus*/
  var nodes=Array.prototype.slice.call(document.querySelectorAll('[data-e2e="msg-input"] textarea,[data-e2e="msg-input"] [contenteditable="true"]')).filter(function(el){var r=el.getBoundingClientRect(),container=el.closest('[data-e2e="msg-input"]'),cr=container&&container.getBoundingClientRect(),s=container&&getComputedStyle(container),p=[el.getAttribute('placeholder')||'',el.getAttribute('data-placeholder')||'',el.getAttribute('aria-label')||'',String(el.className||'')].join(' ');return r.height>2&&cr&&cr.width>2&&cr.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&!/搜索/.test(p);});
  if(nodes.length!==1)return JSON.stringify({ok:false,reason:nodes.length>1?'ambiguous':'editor_missing'});var el=nodes[0],v='value' in el?String(el.value||''):String(el.textContent||'');if(v.replace(/[\u200b\u200c\u200d\ufeff]/g,'').length)return JSON.stringify({ok:false,reason:'editor_not_empty'});el.focus();return JSON.stringify({ok:document.activeElement===el});
})()`;

export interface LiveSnapshot {
  host: string;
  blockReason: DouyinBlockReason;
  room?: { centerX: number; centerY: number; url: string };
  roomAmbiguous: boolean;
  chatEditor: PointTarget & { empty?: boolean; matches1111?: boolean };
  send: PointTarget;
  replyTarget?: { centerX: number; centerY: number };
  replyAmbiguous: boolean;
  replyEditor: PointTarget & { empty?: boolean };
  exact1111Count: number;
}

export const DOUYIN_LIVE_SNAPSHOT_JS = String.raw`(function(){/*aidcp:douyin-live-snapshot*/
  var vw=Math.max(1,innerWidth||1280),vh=Math.max(1,innerHeight||800);
  function rect(el){try{return el&&el.getBoundingClientRect?el.getBoundingClientRect():null;}catch(e){return null;}}
  function visible(el){var r=rect(el);if(!r||r.width<2||r.height<2||r.bottom<=0||r.top>=vh||r.right<=0||r.left>=vw)return false;var s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';}
  function pt(el){var r=rect(el);return r?{centerX:Math.round(r.left+r.width/2),centerY:Math.round(r.top+r.height/2)}:{};}
  function target(nodes){nodes=nodes.filter(visible);var out={found:nodes.length===1,ambiguous:nodes.length>1};if(nodes.length===1)Object.assign(out,pt(nodes[0]));return out;}
  var host=String(location.hostname||'').toLowerCase(),body=String((document.body&&document.body.innerText)||'').slice(0,5000),isLive=host==='live.douyin.com';
  var blockReason=!isLive?'not_douyin':(/安全验证|完成验证|拖动滑块|访问过于频繁/.test(body)?'challenge':'none');
  var roomLinks=Array.prototype.slice.call(document.querySelectorAll('a[href]')).filter(function(a){if(!visible(a))return false;try{var u=new URL(a.href,location.href);return u.hostname==='live.douyin.com'&&/^\/\d{5,24}\/?$/.test(u.pathname);}catch(e){return false;}});
  var roomUnique=[];roomLinks.forEach(function(a){var href=a.href.replace(/[?#].*$/,'');if(!roomUnique.some(function(x){return x.href===href;}))roomUnique.push({href:href,el:a});});
  var room=roomUnique.length?Object.assign(pt(roomUnique[0].el),{url:roomUnique[0].href}):undefined;
  var editors=Array.prototype.slice.call(document.querySelectorAll('[data-e2e="live-chatting"] textarea,[data-e2e="live-chatting"] [contenteditable="true"]')).filter(function(el){return visible(el);});
  var chatEditor=target(editors);if(editors.length===1){var v='value' in editors[0]?String(editors[0].value||''):String(editors[0].textContent||''),clean=v.replace(/[\u200b\u200c\u200d\ufeff]/g,'');chatEditor.empty=clean.length===0;chatEditor.matches1111=clean==='1111';}
  var sends=Array.prototype.slice.call(document.querySelectorAll('#chatInput .webcast-chatroom___send-btn,button,[role="button"]')).filter(function(el){return visible(el)&&(/webcast-chatroom___send-btn/.test(String(el.className&&el.className.baseVal||el.className||''))||/^(发送|Send)$/.test(String(el.innerText||el.getAttribute('aria-label')||'').trim()));});
  var sendTarget=target(sends);if(sends.length===1&&/webcast-chatroom___send-btn/.test(String(sends[0].className&&sends[0].className.baseVal||sends[0].className||''))){var sr=rect(sends[0]);sendTarget.centerX=Math.round(sr.right-3);sendTarget.centerY=Math.round(sr.top+sr.height/2);}
  var comments=Array.prototype.slice.call(document.querySelectorAll('[data-e2e*="comment" i],[class*="comment" i],[class*="chat" i]')).filter(function(el){if(!visible(el)||!el.children.length)return false;var t=String(el.innerText||'').trim();return t.length>0&&t.length<240&&/(回复|Reply)/i.test(t)&&!el.querySelector('textarea,[contenteditable="true"]');}).filter(function(el,idx,arr){return !arr.some(function(other,j){return j!==idx&&other.contains(el);});});
  var replyButtons=Array.prototype.slice.call(document.querySelectorAll('button,[role="button"],span')).filter(function(el){return visible(el)&&/^(回复|Reply)$/i.test(String(el.innerText||el.getAttribute('aria-label')||'').trim())&&!el.closest('form');});
  var replyEditors=Array.prototype.slice.call(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(function(el){if(!visible(el))return false;var p=[el.getAttribute('placeholder')||'',el.getAttribute('aria-label')||''].join(' ');return /回复\s*@|Reply to/i.test(p);});
  var replyEditor=target(replyEditors);if(replyEditors.length===1){var rv='value' in replyEditors[0]?String(replyEditors[0].value||''):String(replyEditors[0].textContent||'');replyEditor.empty=rv.length===0;}
  var exact1111Count=Array.prototype.slice.call(document.querySelectorAll('.webcast-chatroom___item')).filter(function(el){return /(^|[：:\s])1111$/.test(String(el.innerText||'').trim());}).length;
  return JSON.stringify({host:host,blockReason:blockReason,room:room,roomAmbiguous:false,chatEditor:chatEditor,send:sendTarget,replyTarget:replyButtons.length===1?pt(replyButtons[0]):undefined,replyAmbiguous:replyButtons.length>1,replyEditor:replyEditor,exact1111Count:exact1111Count});
})()`;

const DOUYIN_LIVE_CHAT_FOCUS_JS = String.raw`(function(){/*aidcp:douyin-live-chat-focus*/
  var nodes=Array.prototype.slice.call(document.querySelectorAll('[data-e2e="live-chatting"] textarea,[data-e2e="live-chatting"] [contenteditable="true"]')).filter(function(el){var r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&r.bottom>0&&r.top<innerHeight&&s.display!=='none'&&s.visibility!=='hidden';});
  if(nodes.length!==1)return JSON.stringify({ok:false,reason:nodes.length>1?'ambiguous':'editor_missing'});var el=nodes[0],v='value' in el?String(el.value||''):String(el.textContent||'');if(v.replace(/[\u200b\u200c\u200d\ufeff]/g,'').length)return JSON.stringify({ok:false,reason:'editor_not_empty'});el.focus();return JSON.stringify({ok:document.activeElement===el});
})()`;

const DOUYIN_LIVE_REPLY_FOCUS_JS = String.raw`(function(){/*aidcp:douyin-live-reply-focus*/
  var nodes=Array.prototype.slice.call(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(function(el){var r=el.getBoundingClientRect(),s=getComputedStyle(el),p=[el.getAttribute('placeholder')||'',el.getAttribute('aria-label')||''].join(' ');return r.width>2&&r.height>2&&r.bottom>0&&r.top<innerHeight&&s.display!=='none'&&s.visibility!=='hidden'&&/回复\s*@|Reply to/i.test(p);});
  if(nodes.length!==1)return JSON.stringify({ok:false,reason:nodes.length>1?'ambiguous':'editor_missing'});var el=nodes[0],v='value' in el?String(el.value||''):String(el.textContent||'');if(v)return JSON.stringify({ok:false,reason:'editor_not_empty'});el.focus();return JSON.stringify({ok:document.activeElement===el});
})()`;

export type ActionStatus =
  | 'shadow'
  | 'ui_confirmed'
  | 'already_active'
  | 'blocked'
  | 'ambiguous'
  | 'target_missing'
  | 'state_unknown'
  | 'gate_rejected'
  | 'budget_exhausted'
  | 'postcondition_unknown'
  | 'prompt_absent'
  | 'group_chat'
  | 'conversation_type_unknown'
  | 'inbound_unconfirmed';

export interface ActionResult {
  status: ActionStatus;
  executed: boolean;
  targetId?: string;
  beforeState?: ToggleState;
  afterState?: ToggleState;
  reason?: string;
  confirmation: 'none' | 'ui_only';
}

export interface MessageResult {
  status: ActionStatus;
  executed: boolean;
  textLength: number;
  submitted: boolean;
  reason?: string;
  confirmation: 'none' | 'ui_only';
}

export interface DouyinProbeOptions {
  sleep?: (ms: number) => Promise<void>;
  random?: RandomFn;
  settleRounds?: number;
}

export function isDouyinTargetUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'douyin.com' || host.endsWith('.douyin.com');
  } catch {
    return false;
  }
}

export function hasExactAdsPowerProfileMarker(
  targets: Array<{ type?: string; url?: string }>,
  profileId: string,
): boolean {
  return targets.some((target) => {
    if (target.type !== 'page' || !target.url) return false;
    try {
      const url = new URL(target.url);
      return url.hostname === 'start.adspower.net' && url.searchParams.get('id') === profileId;
    } catch {
      return false;
    }
  });
}

export function isRealActionAuthorized(profileId: string, execute: boolean, confirmedProfile?: string): boolean {
  return execute && confirmedProfile === profileId;
}

export function toDouyinSafeSnapshot(snapshot: DouyinPageSnapshot): DouyinSafeSnapshot {
  return {
    host: snapshot.host,
    path: snapshot.path,
    modalId: snapshot.modalId,
    modalReady: snapshot.modalReady,
    blockReason: snapshot.blockReason,
    loginState: snapshot.loginState,
    cardId: snapshot.card?.awemeId,
    like: {
      found: snapshot.like.found,
      ambiguous: snapshot.like.ambiguous,
      state: snapshot.like.state,
      evidence: snapshot.like.evidence,
    },
    follow: {
      found: snapshot.follow.found,
      ambiguous: snapshot.follow.ambiguous,
      state: snapshot.follow.state,
      evidence: snapshot.follow.evidence,
    },
    collect: {
      found: snapshot.collect.found,
      ambiguous: snapshot.collect.ambiguous,
      state: snapshot.collect.state,
      evidence: snapshot.collect.evidence,
    },
    interactionPrompt: {
      found: snapshot.interactionPrompt.found,
      ambiguous: snapshot.interactionPrompt.ambiguous,
    },
  };
}

export class DouyinInteractionProbe {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: RandomFn;
  private readonly settleRounds: number;
  private budgets = { like: 1, follow: 1, collect: 1, dm: 1, liveChat: 1, liveReply: 1 };

  constructor(private readonly cdp: BrowseCdp, options: DouyinProbeOptions = {}) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? defaultRandom;
    this.settleRounds = options.settleRounds ?? 8;
  }

  inspect(): Promise<DouyinPageSnapshot> {
    return evalJson<DouyinPageSnapshot>(this.cdp, DOUYIN_PAGE_SNAPSHOT_JS);
  }

  inspectDm(): Promise<DmSnapshot> {
    return evalJson<DmSnapshot>(this.cdp, DOUYIN_DM_SNAPSHOT_JS);
  }

  inspectLive(): Promise<LiveSnapshot> {
    return evalJson<LiveSnapshot>(this.cdp, DOUYIN_LIVE_SNAPSHOT_JS);
  }

  async dismissKnownInteractionPrompt(): Promise<ActionResult> {
    const before = await this.inspect();
    if (before.interactionPrompt.ambiguous) return { status: 'ambiguous', executed: false, confirmation: 'none', reason: 'interaction_prompt_ambiguous' };
    if (!before.interactionPrompt.found) return { status: 'prompt_absent', executed: false, confirmation: 'none' };
    await this.cdp.send('Page.bringToFront');
    await dispatchClick(this.cdp, before.interactionPrompt.centerX!, before.interactionPrompt.centerY!, { random: this.random, sleep: this.sleep, jitter: 0 });
    const after = await this.waitFor(() => this.inspect(), (value) => !value.interactionPrompt.found && !value.interactionPrompt.ambiguous);
    return !after.interactionPrompt.found && !after.interactionPrompt.ambiguous
      ? { status: 'ui_confirmed', executed: true, confirmation: 'ui_only' }
      : { status: 'postcondition_unknown', executed: true, confirmation: 'none', reason: 'interaction_prompt_still_visible' };
  }

  private async waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
    let last = await read();
    for (let index = 0; index < this.settleRounds && !accept(last); index++) {
      await this.sleep(500);
      last = await read();
    }
    return last;
  }

  async openCurrentCard(): Promise<ActionResult> {
    const before = await this.inspect();
    if (before.blockReason !== 'none') return { status: 'blocked', executed: false, confirmation: 'none', reason: before.blockReason };
    if (before.loginState !== 'logged_in') return { status: 'blocked', executed: false, confirmation: 'none', reason: `login_${before.loginState}` };
    if (before.interactionPrompt.found || before.interactionPrompt.ambiguous) return { status: 'blocked', executed: false, confirmation: 'none', reason: 'interaction_prompt_visible' };
    if (before.modalId && before.modalReady) return { status: 'already_active', executed: false, targetId: before.modalId, confirmation: 'ui_only' };
    if (before.modalId) return { status: 'postcondition_unknown', executed: false, targetId: before.modalId, confirmation: 'none', reason: 'page_not_hydrated' };
    if (!before.card) return { status: 'target_missing', executed: false, confirmation: 'none', reason: 'visible_card_missing' };
    await dispatchClick(this.cdp, before.card.centerX, before.card.centerY, { random: this.random, sleep: this.sleep });
    let after = await this.waitFor(() => this.inspect(), (value) => value.modalId === before.card?.awemeId && value.modalReady);
    if (after.modalId !== before.card.awemeId || !after.modalReady) {
      // Jingxuan occasionally drops the delegated click while the card grid is re-rendering. A same-page
      // modal URL is a bounded, non-publishing fallback and still preserves the stable aweme id postcondition.
      await this.cdp.send('Page.navigate', { url: `https://${before.host}${before.path}?modal_id=${before.card.awemeId}` });
      after = await this.waitFor(() => this.inspect(), (value) => value.modalId === before.card?.awemeId && value.modalReady);
    }
    return after.modalId === before.card.awemeId && after.modalReady
      ? { status: 'ui_confirmed', executed: true, targetId: after.modalId, confirmation: 'ui_only' }
      : { status: 'postcondition_unknown', executed: true, targetId: before.card.awemeId, confirmation: 'none', reason: 'modal_id_not_confirmed' };
  }

  private async activateToggle(kind: 'like' | 'follow' | 'collect', options: { profileId: string; execute: boolean; confirmedProfile?: string }): Promise<ActionResult> {
    const before = await this.inspect();
    const control = before[kind];
    if (before.blockReason !== 'none') return { status: 'blocked', executed: false, confirmation: 'none', reason: before.blockReason };
    if (before.loginState !== 'logged_in') return { status: 'blocked', executed: false, confirmation: 'none', reason: `login_${before.loginState}` };
    if (before.interactionPrompt.found || before.interactionPrompt.ambiguous) return { status: 'blocked', executed: false, confirmation: 'none', reason: 'interaction_prompt_visible' };
    if (!before.modalId) return { status: 'target_missing', executed: false, confirmation: 'none', reason: 'stable_modal_id_missing' };
    if (!before.modalReady) return { status: 'target_missing', executed: false, targetId: before.modalId, confirmation: 'none', reason: 'page_not_hydrated' };
    if (control.ambiguous) return { status: 'ambiguous', executed: false, targetId: before.modalId, confirmation: 'none', reason: `${kind}_control_ambiguous` };
    if (!control.found) return { status: 'target_missing', executed: false, targetId: before.modalId, confirmation: 'none', reason: `${kind}_control_missing` };
    if (control.state === 'active') return { status: 'already_active', executed: false, targetId: before.modalId, beforeState: 'active', afterState: 'active', confirmation: 'ui_only' };
    if (control.state !== 'inactive') return { status: 'state_unknown', executed: false, targetId: before.modalId, beforeState: control.state, confirmation: 'none', reason: control.evidence };
    if (control.hitReady === false) return { status: 'blocked', executed: false, targetId: before.modalId, beforeState: control.state, confirmation: 'none', reason: 'control_obstructed' };
    if (!options.execute) return { status: 'shadow', executed: false, targetId: before.modalId, beforeState: control.state, confirmation: 'none' };
    if (!isRealActionAuthorized(options.profileId, true, options.confirmedProfile)) return { status: 'gate_rejected', executed: false, targetId: before.modalId, beforeState: control.state, confirmation: 'none', reason: 'profile_confirmation_mismatch' };
    if (this.budgets[kind] < 1) return { status: 'budget_exhausted', executed: false, targetId: before.modalId, beforeState: control.state, confirmation: 'none' };
    this.budgets[kind]--;
    await this.cdp.send('Page.bringToFront');
    await dispatchClick(this.cdp, control.centerX!, control.centerY!, { random: this.random, sleep: this.sleep });
    const after = await this.waitFor(() => this.inspect(), (value) => value.modalId === before.modalId && value[kind].state === 'active');
    const afterState = after.modalId === before.modalId ? after[kind].state : 'unknown';
    return afterState === 'active'
      ? { status: 'ui_confirmed', executed: true, targetId: before.modalId, beforeState: 'inactive', afterState, confirmation: 'ui_only' }
      : { status: 'postcondition_unknown', executed: true, targetId: before.modalId, beforeState: 'inactive', afterState, confirmation: 'none', reason: 'active_state_not_confirmed' };
  }

  likeCurrent(options: { profileId: string; execute: boolean; confirmedProfile?: string }): Promise<ActionResult> {
    return this.activateToggle('like', options);
  }

  followCurrent(options: { profileId: string; execute: boolean; confirmedProfile?: string }): Promise<ActionResult> {
    return this.activateToggle('follow', options);
  }

  collectCurrent(options: { profileId: string; execute: boolean; confirmedProfile?: string }): Promise<ActionResult> {
    return this.activateToggle('collect', options);
  }

  async replyLatestInboundDm(options: { profileId: string; execute: boolean; confirmedProfile?: string; text: '好的' | 'ok' }): Promise<MessageResult> {
    const base = { textLength: options.text.length, submitted: false, confirmation: 'none' as const };
    if (!options.execute) return { ...base, status: 'shadow', executed: false };
    if (!isRealActionAuthorized(options.profileId, true, options.confirmedProfile)) return { ...base, status: 'gate_rejected', executed: false, reason: 'profile_confirmation_mismatch' };
    if (!(['好的', 'ok'] as const).includes(options.text)) return { ...base, status: 'gate_rejected', executed: false, reason: 'text_not_allowlisted' };
    if (this.budgets.dm < 1) return { ...base, status: 'budget_exhausted', executed: false };
    let state = await this.inspectDm();
    if (state.blockReason !== 'none') return { ...base, status: 'blocked', executed: false, reason: state.blockReason };
    if (!state.dialogOpen) {
      if (!state.entry.found || state.entry.ambiguous) return { ...base, status: state.entry.ambiguous ? 'ambiguous' : 'target_missing', executed: false, reason: 'dm_entry_unavailable' };
      await dispatchClick(this.cdp, state.entry.centerX!, state.entry.centerY!, { random: this.random, sleep: this.sleep });
      state = await this.waitFor(() => this.inspectDm(), (value) => value.dialogOpen);
    }
    if (!state.dialogOpen) return { ...base, status: 'postcondition_unknown', executed: false, reason: 'dm_dialog_not_open' };
    if (state.inboundAmbiguous) return { ...base, status: 'ambiguous', executed: false, reason: 'inbound_conversation_ambiguous' };
    if (!state.inboundConversation) return { ...base, status: 'target_missing', executed: false, reason: 'unique_unread_inbound_conversation_missing' };
    const targetFingerprint = state.inboundConversation.fingerprint;
    await dispatchClick(this.cdp, state.inboundConversation.centerX, state.inboundConversation.centerY, { random: this.random, sleep: this.sleep });
    state = await this.waitFor(
      () => this.inspectDm(),
      (value) => value.selectedFingerprint === targetFingerprint && value.conversationKind !== 'unknown' && value.editor.found && !value.editor.ambiguous,
    );
    if (state.selectedFingerprint !== targetFingerprint) return { ...base, status: 'ambiguous', executed: false, reason: 'selected_conversation_not_confirmed' };
    if (state.conversationKind === 'group') return { ...base, status: 'group_chat', executed: false, reason: 'group_conversation_forbidden' };
    if (state.conversationKind !== 'private') return { ...base, status: 'conversation_type_unknown', executed: false, reason: 'private_conversation_unconfirmed' };
    if (state.latestDirection !== 'inbound') return { ...base, status: 'inbound_unconfirmed', executed: false, reason: `latest_direction_${state.latestDirection}` };
    if (!state.editor.found || state.editor.ambiguous || state.editor.empty !== true) return { ...base, status: state.editor.ambiguous ? 'ambiguous' : 'target_missing', executed: false, reason: 'unique_empty_dm_editor_missing' };
    const focused = await evalJson<{ ok: boolean; reason?: string }>(this.cdp, DOUYIN_DM_FOCUS_JS);
    if (!focused.ok) return { ...base, status: 'target_missing', executed: false, reason: focused.reason ?? 'dm_focus_failed' };
    await dispatchKeystrokes(this.cdp, options.text, { random: this.random, sleep: this.sleep });
    this.budgets.dm--;
    if (state.send.found && !state.send.ambiguous) await dispatchClick(this.cdp, state.send.centerX!, state.send.centerY!, { random: this.random, sleep: this.sleep });
    else await pressEnter(this.cdp);
    const after = await this.waitFor(() => this.inspectDm(), (value) => value.editor.found && value.editor.empty === true);
    return after.editor.found && after.editor.empty === true
      ? { status: 'ui_confirmed', executed: true, textLength: options.text.length, submitted: true, confirmation: 'ui_only' }
      : { status: 'postcondition_unknown', executed: true, textLength: options.text.length, submitted: true, confirmation: 'none', reason: 'dm_editor_not_cleared' };
  }

  async enterFirstLiveRoom(): Promise<ActionResult> {
    const state = await this.inspectLive();
    if (state.blockReason !== 'none') return { status: 'blocked', executed: false, confirmation: 'none', reason: state.blockReason };
    if (!state.room) return { status: 'target_missing', executed: false, confirmation: 'none', reason: 'visible_live_room_missing' };
    // Live cards deliberately open target=_blank. Keep the probe on its already profile-bound page target so
    // subsequent state checks cannot accidentally remain attached to the lobby while a new tab receives input.
    await this.cdp.send('Page.navigate', { url: state.room.url });
    const after = await this.waitFor(() => this.inspectLive(), (value) => value.chatEditor.found || value.blockReason !== 'none');
    return after.chatEditor.found
      ? { status: 'ui_confirmed', executed: true, confirmation: 'ui_only' }
      : { status: 'postcondition_unknown', executed: true, confirmation: 'none', reason: 'live_room_editor_not_confirmed' };
  }

  private async sendLiveText(kind: 'liveChat' | 'liveReply', options: { profileId: string; execute: boolean; confirmedProfile?: string; text: string }): Promise<MessageResult> {
    const expected = kind === 'liveChat' ? '1111' : '666';
    const base = { textLength: options.text.length, submitted: false, confirmation: 'none' as const };
    if (!options.execute) return { ...base, status: 'shadow', executed: false };
    if (!isRealActionAuthorized(options.profileId, true, options.confirmedProfile)) return { ...base, status: 'gate_rejected', executed: false, reason: 'profile_confirmation_mismatch' };
    if (options.text !== expected) return { ...base, status: 'gate_rejected', executed: false, reason: 'text_not_exactly_authorized' };
    if (this.budgets[kind] < 1) return { ...base, status: 'budget_exhausted', executed: false };
    let state = await this.inspectLive();
    const beforeExact1111Count = state.exact1111Count;
    if (state.blockReason !== 'none') return { ...base, status: 'blocked', executed: false, reason: state.blockReason };
    if (kind === 'liveReply') {
      if (state.replyAmbiguous) return { ...base, status: 'ambiguous', executed: false, reason: 'reply_target_ambiguous' };
      if (!state.replyTarget) return { ...base, status: 'target_missing', executed: false, reason: 'unique_reply_target_missing' };
      await dispatchClick(this.cdp, state.replyTarget.centerX, state.replyTarget.centerY, { random: this.random, sleep: this.sleep });
      state = await this.waitFor(() => this.inspectLive(), (value) => value.replyEditor.found && !value.replyEditor.ambiguous);
    }
    const editor = kind === 'liveChat' ? state.chatEditor : state.replyEditor;
    if (!editor.found || editor.ambiguous || editor.empty !== true) return { ...base, status: editor.ambiguous ? 'ambiguous' : 'target_missing', executed: false, reason: kind === 'liveChat' ? 'unique_empty_live_editor_missing' : 'unique_empty_reply_editor_missing' };
    const focused = await evalJson<{ ok: boolean; reason?: string }>(this.cdp, kind === 'liveChat' ? DOUYIN_LIVE_CHAT_FOCUS_JS : DOUYIN_LIVE_REPLY_FOCUS_JS);
    if (!focused.ok) return { ...base, status: 'target_missing', executed: false, reason: focused.reason ?? 'live_focus_failed' };
    await dispatchKeystrokes(this.cdp, options.text, { random: this.random, sleep: this.sleep });
    this.budgets[kind]--;
    if (kind === 'liveChat') {
      state = await this.waitFor(() => this.inspectLive(), (value) => value.chatEditor.matches1111 === true && value.send.found && !value.send.ambiguous);
      if (state.chatEditor.matches1111 !== true || !state.send.found || state.send.ambiguous) return { ...base, status: 'postcondition_unknown', executed: true, submitted: false, reason: 'exact_live_draft_or_send_control_not_confirmed' };
      await dispatchClick(this.cdp, state.send.centerX!, state.send.centerY!, { random: this.random, sleep: this.sleep, jitter: 0 });
    } else {
      // A targeted reply has a separate reply editor; Enter is scoped to that editor and cannot fall back to chat.
      await pressEnter(this.cdp);
    }
    const after = await this.waitFor(() => this.inspectLive(), (value) => {
      const next = kind === 'liveChat' ? value.chatEditor : value.replyEditor;
      return next.found && next.empty === true && (kind !== 'liveChat' || value.exact1111Count > beforeExact1111Count);
    });
    const afterEditor = kind === 'liveChat' ? after.chatEditor : after.replyEditor;
    return afterEditor.found && afterEditor.empty === true && (kind !== 'liveChat' || after.exact1111Count > beforeExact1111Count)
      ? { status: 'ui_confirmed', executed: true, textLength: options.text.length, submitted: true, confirmation: 'ui_only' }
      : { status: 'postcondition_unknown', executed: true, textLength: options.text.length, submitted: true, confirmation: 'none', reason: 'live_editor_not_cleared' };
  }

  sendLiveChat(options: { profileId: string; execute: boolean; confirmedProfile?: string; text: '1111' }): Promise<MessageResult> {
    return this.sendLiveText('liveChat', options);
  }

  replyLiveComment(options: { profileId: string; execute: boolean; confirmedProfile?: string; text: '666' }): Promise<MessageResult> {
    return this.sendLiveText('liveReply', options);
  }
}
