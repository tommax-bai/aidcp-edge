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
  return {
    href:String(location.href||''),
    readyState:String(document.readyState||''),
    feedCardCount:cap(document.querySelectorAll(feedSelector).length),
    noteDetailCount:cap(Array.prototype.slice.call(document.querySelectorAll(noteSelector)).filter(visible).length),
    loginWallCount:loginWallCount,
    dialogCount:cap(Array.prototype.slice.call(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).filter(visible).length),
    profileSignalCount:cap(document.querySelectorAll('.user-page,.user-info,[class*="userPage"],[class*="userInfo"],a[href*="/user/profile/"]').length),
    notificationSignalCount:cap(document.querySelectorAll('a[href*="/notification"],a[href*="/notice"],[class*="notification"],[class*="notice"]').length),
    publishSignalCount:cap(document.querySelectorAll('input[type="file"],[contenteditable="true"],xhs-publish-btn').length),
    errorSignalCount:cap(document.querySelectorAll('[class*="not-found"],[class*="notFound"],[class*="error-page"],[class*="errorPage"]').length),
    mainCount:cap(document.querySelectorAll('main,#app,[role="main"]').length)
  };
})()
