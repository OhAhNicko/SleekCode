/* MADE DevTools capture — ONE script, TWO transports.
 *
 * Injected by the preview proxy into framed pages (iframe engine) and by
 * browser_view into top-level pages (native wry engine). Keeping a single file
 * is deliberate: the DevTools panel must behave identically on both engines, and
 * two copies would drift.
 *
 *   iframe  -> window.parent.postMessage(msg, '*')     (unchanged, legacy path)
 *   native  -> window.ipc.postMessage(envelope)        (wry's IPC, CSP-immune)
 *
 * SECURITY (native path): this runs in the VISITED PAGE's world, so a hostile
 * page can tamper with it, forge messages and flood the channel. Rust re-validates
 * everything — closed `kind` set, size/batch/text caps, token-bucket rate limit
 * (browser_view/policy.rs) — and the payload's only destination is panel text.
 * Batching here keeps a chatty-but-honest page under the rate limit.
 */
(function(){
if(window.__madeInjected)return;
window.__madeInjected=true;

var FRAMED = window.parent !== window;
var NATIVE = !FRAMED && window.ipc && typeof window.ipc.postMessage === 'function';
var P = window.parent;

/* ---- Transport -------------------------------------------------------
 * Native messages are batched and flushed on a short timer so a burst of
 * console lines costs one IPC message instead of hundreds. `type` is mapped to
 * the closed kind set Rust accepts; anything else is dropped there anyway. */
var KINDS = {
  'made-console':'console','made-network':'network','made-storage':'storage',
  'made-inspect-result':'inspect-result','made-url':'url','made-ready':'ready',
  'made-focus':'focus'
};
var _q=[],_t=null;
var MAX_QUEUE=200;

function _flush(){
  _t=null;
  if(!_q.length)return;
  var items=_q.splice(0,MAX_QUEUE);
  try{
    window.ipc.postMessage(JSON.stringify({v:1,kind:'devtools',items:items}));
  }catch(e){/* channel gone: never break the page */}
  if(_q.length)_schedule();
}
function _schedule(){ if(_t===null)_t=setTimeout(_flush,50); }

function SEND(msg){
  try{
    if(!NATIVE){ P.postMessage(msg,'*'); return; }
    var kind=KINDS[msg&&msg.type];
    if(!kind)return;
    // Drop rather than grow without bound if the page out-runs the flush.
    if(_q.length>=MAX_QUEUE*4)return;
    _q.push({kind:kind,payload:JSON.stringify(msg)});
    _schedule();
  }catch(e){}
}

/* ---- Console capture ---- */
var O={};
['log','warn','error','info'].forEach(function(m){
  O[m]=console[m];
  console[m]=function(){
    O[m].apply(console,arguments);
    try{
      var a=[];
      for(var i=0;i<arguments.length;i++){
        try{a.push(typeof arguments[i]==='object'?JSON.stringify(arguments[i]):String(arguments[i]))}
        catch(e){a.push(String(arguments[i]))}
      }
      SEND({type:'made-console',method:m,text:a.join(' '),timestamp:Date.now()});
    }catch(e){}
  };
});
window.addEventListener('error',function(e){
  SEND({type:'made-console',method:'error',
    text:e.message+(e.filename?' at '+e.filename+':'+e.lineno:''),timestamp:Date.now()});
});
window.addEventListener('unhandledrejection',function(e){
  SEND({type:'made-console',method:'error',
    text:'Unhandled Promise: '+(e.reason&&e.reason.message?e.reason.message:String(e.reason)),timestamp:Date.now()});
});

/* ---- Network capture (fetch + XHR) ---- */
var _nid=0;
var _fetch=window.fetch;
if(_fetch){
  window.fetch=function(input,init){
    var id=++_nid,start=Date.now();
    var method='GET',url='';
    try{
      if(init&&init.method)method=init.method;
      else if(input&&typeof input==='object'&&input.method)method=input.method;
      method=method.toUpperCase();
      if(typeof input==='string')url=input;
      else if(input&&typeof input==='object'&&input.url)url=input.url;
      else url=String(input);
    }catch(e){url=String(input)}
    SEND({type:'made-network',phase:'start',id:id,method:method,url:url,timestamp:start});
    return _fetch.apply(this,arguments).then(function(res){
      var sz=0;
      try{var cl=res.headers.get('content-length');if(cl)sz=parseInt(cl,10)}catch(x){}
      SEND({type:'made-network',phase:'end',id:id,status:res.status,statusText:res.statusText||'',duration:Date.now()-start,size:sz,timestamp:Date.now()});
      return res;
    }).catch(function(err){
      SEND({type:'made-network',phase:'end',id:id,status:0,statusText:'',duration:Date.now()-start,size:0,error:err.message||'Network error',timestamp:Date.now()});
      throw err;
    });
  };
}
var _xhrO=XMLHttpRequest.prototype.open,_xhrS=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m,u){
  this.__ezy={id:++_nid,method:(m||'GET').toUpperCase(),url:String(u)};
  return _xhrO.apply(this,arguments);
};
XMLHttpRequest.prototype.send=function(){
  var xhr=this;
  if(xhr.__ezy){
    var e=xhr.__ezy;e.start=Date.now();
    SEND({type:'made-network',phase:'start',id:e.id,method:e.method,url:e.url,timestamp:e.start});
    xhr.addEventListener('loadend',function(){
      var sz=0;
      try{var cl=xhr.getResponseHeader('content-length');if(cl)sz=parseInt(cl,10)}catch(x){}
      if(!sz){try{if(xhr.responseText)sz=xhr.responseText.length}catch(x){}}
      SEND({type:'made-network',phase:'end',id:e.id,status:xhr.status,statusText:xhr.statusText||'',duration:Date.now()-e.start,size:sz,timestamp:Date.now()});
    });
  }
  return _xhrS.apply(this,arguments);
};

/* ---- Element inspector ---- */
var _insp=false,_iovl=null,_ilbl=null;
function _mkOvl(){
  if(_iovl)return;
  _iovl=document.createElement('div');
  _iovl.style.cssText='position:fixed;pointer-events:none;z-index:999999;border:2px solid rgba(57,211,83,0.8);background:rgba(57,211,83,0.1);transition:top .05s,left .05s,width .05s,height .05s;display:none;';
  _ilbl=document.createElement('div');
  _ilbl.style.cssText='position:fixed;pointer-events:none;z-index:999999;background:#1a1a2e;color:#39d353;font-size:11px;padding:2px 6px;border-radius:3px;white-space:nowrap;display:none;font-family:system-ui,-apple-system,sans-serif;';
  document.documentElement.appendChild(_iovl);
  document.documentElement.appendChild(_ilbl);
}
function _imov(ev){
  var el=document.elementFromPoint(ev.clientX,ev.clientY);
  if(!el||el===_iovl||el===_ilbl)return;
  var r=el.getBoundingClientRect();
  _iovl.style.left=r.left+'px';_iovl.style.top=r.top+'px';
  _iovl.style.width=r.width+'px';_iovl.style.height=r.height+'px';
  _iovl.style.display='block';
  var t=el.tagName.toLowerCase(),d=el.id?'#'+el.id:'';
  var c=el.className&&typeof el.className==='string'?'.'+el.className.trim().split(/\s+/).join('.'):'';
  _ilbl.textContent=t+d+c+' '+Math.round(r.width)+'×'+Math.round(r.height);
  _ilbl.style.left=Math.max(0,r.left)+'px';
  _ilbl.style.top=Math.max(0,r.top-22)+'px';
  _ilbl.style.display='block';
}
function _iclk(ev){
  ev.preventDefault();ev.stopPropagation();ev.stopImmediatePropagation();
  var el=document.elementFromPoint(ev.clientX,ev.clientY);
  if(!el||el===_iovl||el===_ilbl)return;
  var r=el.getBoundingClientRect(),cs=getComputedStyle(el),s={};
  ['width','height','display','position','margin','padding','color','backgroundColor',
   'fontSize','fontFamily','border','borderRadius','opacity','overflow','zIndex',
   'flexDirection','justifyContent','alignItems','gap','gridTemplateColumns'
  ].forEach(function(p){s[p]=cs[p]});
  SEND({type:'made-inspect-result',element:{tag:el.tagName.toLowerCase(),
    id:el.id||'',classes:el.className&&typeof el.className==='string'?el.className.trim():'',
    rect:{width:Math.round(r.width),height:Math.round(r.height),top:Math.round(r.top),left:Math.round(r.left)},
    styles:s}});
}
function _istart(){if(_insp)return;_insp=true;_mkOvl();document.addEventListener('mousemove',_imov,true);document.addEventListener('click',_iclk,true);document.body.style.cursor='crosshair';}
function _istop(){_insp=false;document.removeEventListener('mousemove',_imov,true);document.removeEventListener('click',_iclk,true);if(_iovl)_iovl.style.display='none';if(_ilbl)_ilbl.style.display='none';document.body.style.cursor='';}

/* ---- Storage reader ---- */
/* Bounded so the snapshot always fits ONE payload. It is a single message
   carrying every key, and an over-long payload gets truncated mid-JSON, which
   fails to parse and leaves the Storage tab silently empty. */
var ST_MAX_KEYS=200, ST_MAX_VAL=256;
function _readSt(){
  var ls={},ss={},ck={};
  try{for(var i=0;i<localStorage.length&&i<ST_MAX_KEYS;i++){var k=localStorage.key(i);if(k)ls[k]=(localStorage.getItem(k)||'').substring(0,ST_MAX_VAL)}}catch(x){}
  try{for(var i=0;i<sessionStorage.length&&i<ST_MAX_KEYS;i++){var k=sessionStorage.key(i);if(k)ss[k]=(sessionStorage.getItem(k)||'').substring(0,ST_MAX_VAL)}}catch(x){}
  try{var raw=document.cookie;if(raw)raw.split(';').forEach(function(c){var p=c.trim().split('=');if(p[0])ck[p[0].trim()]=decodeURIComponent(p.slice(1).join('=').trim())})}catch(x){}
  SEND({type:'made-storage',localStorage:ls,sessionStorage:ss,cookies:ck,timestamp:Date.now()});
}
function _clearSt(){try{localStorage.clear()}catch(x){}try{sessionStorage.clear()}catch(x){}location.reload();}

/* ---- Inbound commands ----
 * iframe: parent postMessage (a framed page has a parent to talk to).
 * native: MADE calls these globals through browser_view_eval, because a
 * top-level webview has no parent frame to receive a postMessage. Same four
 * commands either way. */
window.__madeInspectStart=_istart;
window.__madeInspectStop=_istop;
window.__madeReadStorage=_readSt;
window.__madeClearStorage=_clearSt;

window.addEventListener('message',function(e){
  if(!e.data||!e.data.type)return;
  if(e.data.type==='made-clear-storage')_clearSt();
  if(e.data.type==='made-inspect-start')_istart();
  if(e.data.type==='made-inspect-stop')_istop();
  if(e.data.type==='made-read-storage')_readSt();
});

/* ---- URL reporting ---- */
function reportUrl(){try{SEND({type:'made-url',url:location.href})}catch(e){}}
reportUrl();
window.addEventListener('popstate',reportUrl);
var _push=history.pushState,_repl=history.replaceState;
history.pushState=function(){_push.apply(this,arguments);reportUrl()};
history.replaceState=function(){_repl.apply(this,arguments);reportUrl()};

/* ---- Focus reporting (native engine) ----
 * The native surface takes real Win32 focus, which blurs MADE's main webview.
 * MADE folds this into appWindowFocused so the accent ring survives browsing.
 * Harmless in iframe mode (the panel ignores the message). */
window.addEventListener('focus',function(){SEND({type:'made-focus',focused:true})});
window.addEventListener('blur',function(){SEND({type:'made-focus',focused:false})});
if(document.hasFocus&&document.hasFocus())SEND({type:'made-focus',focused:true});

/* ---- Right-click -> MADE's context menu (IFRAME ENGINE ONLY) ----
 * The native engine reports this from HOST_INIT_SCRIPT, which is always
 * present; this script is on-demand, so wiring it there too would double-report
 * whenever DevTools capture happened to be on.
 *
 * A right-click inside an iframe fires in the IFRAME's document and does not
 * bubble to the parent, so without this the browser pane has no context menu at
 * all on the localhost/proxy path (which is the default for dev servers).
 *
 * SHIFT passes through so the page can show its own menu. */
if(!NATIVE){
  window.addEventListener('contextmenu',function(e){
    if(e.shiftKey)return;
    e.preventDefault();
    var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;
    var img=e.target&&e.target.tagName==='IMG'?e.target:null;
    var sel='';
    try{sel=String(window.getSelection?window.getSelection():'')}catch(err){}
    var el=e.target;
    SEND({
      type:'made-ctxmenu',
      x:Math.round(e.clientX),y:Math.round(e.clientY),
      linkUrl:a?String(a.href).slice(0,2048):'',
      linkText:a?String(a.textContent||'').trim().slice(0,200):'',
      imgUrl:img?String(img.currentSrc||img.src||'').slice(0,2048):'',
      selText:sel.slice(0,2000),
      editable:!!(el&&(el.isContentEditable||el.tagName==='INPUT'||el.tagName==='TEXTAREA'))
    });
  },true);
}

/* ---- Ready signal ---- */
SEND({type:'made-ready'});
console.info('[MADE] DevTools connected');
})();
