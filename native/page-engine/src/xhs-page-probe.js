(function(){
  var cap=function(value){return Math.max(0,Math.min(999,Number(value)||0));};
  var visible=function(element){
    if(!element||!element.getBoundingClientRect)return false;
    var rect=element.getBoundingClientRect();
    if(rect.width<=0||rect.height<=0)return false;
    var style=window.getComputedStyle?window.getComputedStyle(element):null;
    return !style||(style.display!=='none'&&style.visibility!=='hidden'&&parseFloat(style.opacity||'1')>0.05);
  };
  var noteSelector='.note-detail-mask,.note-container,#noteContainer,[class*="note-detail"],[class*="noteDetail"],[class*="note-modal"]';
  var feedSelector='section.note-item,[class*="note-item"],a[href*="/explore/"],a[href*="/discovery/item/"]';
  var loginSelector='[class*="login"],[class*="mask"],[class*="modal"],[role="dialog"],[aria-modal="true"]';
  var loginPhrases=['扫码登录','手机号登录','验证码登录','新用户登录','安全登录'];
  var loginNodes=Array.prototype.slice.call(document.querySelectorAll(loginSelector));
  var loginWallCount=loginNodes.some(function(element){
    if(element.closest&&element.closest(noteSelector))return false;
    if(!visible(element))return false;
    var text=(element.textContent||'').replace(/\s+/g,'');
    return loginPhrases.some(function(phrase){return text.indexOf(phrase)>=0;});
  })?1:0;
  var captchaSignalCount=cap(Array.prototype.slice.call(document.querySelectorAll('[class*="captcha"],[class*="Captcha"],[class*="geetest"],iframe[src*="captcha"],iframe[src*="verify"]')).filter(visible).length);
  // 通知未读角标（真机校准 2026-06-23 的结构判据，与类名无关）。入口真实结构是
  // 「入口链接 > 角标容器 > 常驻图标 + 条件渲染的角标」，无未读时角标位是空注释槽。
  // 未读 = 角标容器里存在图标之外的可见元素；只有常驻图标 = 无未读。
  // 宽（左侧栏）/ 窄（底部图标栏）两套入口在 DOM 里常同时存在、其中一套隐藏：
  // 只取首个会命中隐藏那个，窄布局下恒判无未读（真机实测漏报 10 条）。故遍历取可见的那个。
  // 三态，且「读不到」MUST NOT 回落成「无未读」——那会把一次读取失败静默变成「已清零」。
  var ICON_SELECTOR='svg,i,img,[class*="icon"]';
  var notificationUnread=function(){
    try{
      var entries=Array.prototype.slice.call(document.querySelectorAll('a[href*="/notification"],a[href*="/notice"]')).filter(visible);
      var container=null;
      for(var i=0;i<entries.length&&!container;i++){
        container=entries[i].querySelector('[class*="badge"]');
      }
      if(!container)return {state:'unreadable',count:0};
      var badges=Array.prototype.slice.call(container.children).filter(function(child){
        if(child.matches&&child.matches(ICON_SELECTOR))return false;
        return visible(child);
      });
      if(!badges.length)return {state:'clear',count:0};
      // 计数只是附带：红点无数字同样算未读（count 0），带单位的文本不折算成条数。
      var digits=0;
      for(var j=0;j<badges.length&&!digits;j++){
        var raw=String(badges[j].textContent||'').replace(/\s+/g,'');
        if(/^[0-9]{1,3}$/.test(raw))digits=Number(raw);
      }
      return {state:'unread',count:digits};
    }catch(error){
      return {state:'unreadable',count:0};
    }
  };
  return {
    notificationUnread:notificationUnread(),
    href:String(location.href||''),
    readyState:String(document.readyState||''),
    feedCardCount:cap(document.querySelectorAll(feedSelector).length),
    noteDetailCount:cap(Array.prototype.slice.call(document.querySelectorAll(noteSelector)).filter(visible).length),
    loginWallCount:loginWallCount,
    captchaSignalCount:captchaSignalCount,
    dialogCount:cap(Array.prototype.slice.call(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).filter(visible).length),
    profileSignalCount:cap(document.querySelectorAll('.user-page,.user-info,[class*="userPage"],[class*="userInfo"],a[href*="/user/profile/"]').length),
    notificationSignalCount:cap(document.querySelectorAll('a[href*="/notification"],a[href*="/notice"],[class*="notification"],[class*="notice"]').length),
    publishSignalCount:cap(document.querySelectorAll('input[type="file"],[contenteditable="true"],xhs-publish-btn').length),
    errorSignalCount:cap(document.querySelectorAll('[class*="not-found"],[class*="notFound"],[class*="error-page"],[class*="errorPage"]').length),
    mainCount:cap(document.querySelectorAll('main,#app,[role="main"]').length)
  };
})()
