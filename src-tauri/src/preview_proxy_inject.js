(function(){
if(window.__ezydevInjected)return;
window.__ezydevInjected=true;
var P=window.parent;

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
      P.postMessage({type:'ezydev-console',method:m,text:a.join(' '),timestamp:Date.now()},'*');
    }catch(e){}
  };
});
window.addEventListener('error',function(e){
  P.postMessage({type:'ezydev-console',method:'error',
    text:e.message+(e.filename?' at '+e.filename+':'+e.lineno:''),timestamp:Date.now()},'*');
});
window.addEventListener('unhandledrejection',function(e){
  P.postMessage({type:'ezydev-console',method:'error',
    text:'Unhandled Promise: '+(e.reason&&e.reason.message?e.reason.message:String(e.reason)),timestamp:Date.now()},'*');
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
    P.postMessage({type:'ezydev-network',phase:'start',id:id,method:method,url:url,timestamp:start},'*');
    return _fetch.apply(this,arguments).then(function(res){
      var sz=0;
      try{var cl=res.headers.get('content-length');if(cl)sz=parseInt(cl,10)}catch(x){}
      P.postMessage({type:'ezydev-network',phase:'end',id:id,status:res.status,statusText:res.statusText||'',duration:Date.now()-start,size:sz,timestamp:Date.now()},'*');
      return res;
    }).catch(function(err){
      P.postMessage({type:'ezydev-network',phase:'end',id:id,status:0,statusText:'',duration:Date.now()-start,size:0,error:err.message||'Network error',timestamp:Date.now()},'*');
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
    P.postMessage({type:'ezydev-network',phase:'start',id:e.id,method:e.method,url:e.url,timestamp:e.start},'*');
    xhr.addEventListener('loadend',function(){
      var sz=0;
      try{var cl=xhr.getResponseHeader('content-length');if(cl)sz=parseInt(cl,10)}catch(x){}
      if(!sz){try{if(xhr.responseText)sz=xhr.responseText.length}catch(x){}}
      P.postMessage({type:'ezydev-network',phase:'end',id:e.id,status:xhr.status,statusText:xhr.statusText||'',duration:Date.now()-e.start,size:sz,timestamp:Date.now()},'*');
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
  P.postMessage({type:'ezydev-inspect-result',element:{tag:el.tagName.toLowerCase(),
    id:el.id||'',classes:el.className&&typeof el.className==='string'?el.className.trim():'',
    rect:{width:Math.round(r.width),height:Math.round(r.height),top:Math.round(r.top),left:Math.round(r.left)},
    styles:s}},'*');
}
function _istart(){if(_insp)return;_insp=true;_mkOvl();document.addEventListener('mousemove',_imov,true);document.addEventListener('click',_iclk,true);document.body.style.cursor='crosshair';}
function _istop(){_insp=false;document.removeEventListener('mousemove',_imov,true);document.removeEventListener('click',_iclk,true);if(_iovl)_iovl.style.display='none';if(_ilbl)_ilbl.style.display='none';document.body.style.cursor='';}

/* ---- Storage reader ---- */
function _readSt(){
  var ls={},ss={},ck={};
  try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k)ls[k]=(localStorage.getItem(k)||'').substring(0,1000)}}catch(x){}
  try{for(var i=0;i<sessionStorage.length;i++){var k=sessionStorage.key(i);if(k)ss[k]=(sessionStorage.getItem(k)||'').substring(0,1000)}}catch(x){}
  try{var raw=document.cookie;if(raw)raw.split(';').forEach(function(c){var p=c.trim().split('=');if(p[0])ck[p[0].trim()]=decodeURIComponent(p.slice(1).join('=').trim())})}catch(x){}
  P.postMessage({type:'ezydev-storage',localStorage:ls,sessionStorage:ss,cookies:ck,timestamp:Date.now()},'*');
}

/* ---- Message listener (parent -> iframe) ---- */
window.addEventListener('message',function(e){
  if(!e.data||!e.data.type)return;
  if(e.data.type==='ezydev-clear-storage'){try{localStorage.clear()}catch(x){}try{sessionStorage.clear()}catch(x){}location.reload();}
  if(e.data.type==='ezydev-inspect-start')_istart();
  if(e.data.type==='ezydev-inspect-stop')_istop();
  if(e.data.type==='ezydev-read-storage')_readSt();
});

/* ---- URL reporting ---- */
function reportUrl(){try{P.postMessage({type:'ezydev-url',url:location.href},'*')}catch(e){}}
reportUrl();
window.addEventListener('popstate',reportUrl);
var _push=history.pushState,_repl=history.replaceState;
history.pushState=function(){_push.apply(this,arguments);reportUrl()};
history.replaceState=function(){_repl.apply(this,arguments);reportUrl()};

/* ---- Ready signal ---- */
P.postMessage({type:'ezydev-ready'},'*');
console.info('[EzyDev] DevTools connected');
})();
