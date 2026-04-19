import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import http from "node:http";
import https from "node:https";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/* ------------------------------------------------------------------ */
/*  DevTools injection script — injected by the proxy into HTML pages. */
/*  Captures: console, network (fetch/XHR), element inspector,        */
/*  storage, URL changes. Communicates via postMessage.                */
/* ------------------------------------------------------------------ */
const DEVTOOLS_INJECT_SCRIPT = `(function(){
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
  var c=el.className&&typeof el.className==='string'?'.'+el.className.trim().split(/\\s+/).join('.'):'';
  _ilbl.textContent=t+d+c+' '+Math.round(r.width)+'\\u00d7'+Math.round(r.height);
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

/* ---- Message listener (parent → iframe) ---- */
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
})();`;

/* ------------------------------------------------------------------ */
/*  Vite plugin: preview proxy                                         */
/*  Starts a local HTTP proxy server that forwards requests to the     */
/*  target dev server, injecting the console capture script into HTML. */
/*  The iframe loads from the proxy (normal src=), so window.location  */
/*  and all page behaviour remain correct.                             */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/*  Themed error page — rendered inside the iframe when the proxy      */
/*  can't reach the target. Uses EzyDev color tokens so it blends with */
/*  the host app instead of showing WebView2's generic block page.     */
/* ------------------------------------------------------------------ */
function renderProxyErrorPage(opts: {
  title: string;
  detail: string;
  hint?: string;
  target?: string;
}): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
    );
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(opts.title)}</title>
<style>
  :root{color-scheme:dark;}
  html,body{margin:0;padding:0;height:100%;background:#0d1117;color:#e6edf3;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    -webkit-font-smoothing:antialiased;}
  .wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:32px;}
  .card{max-width:480px;width:100%;background:#161b22;border:1px solid #30363d;
    border-radius:8px;padding:28px 28px 24px;box-shadow:0 8px 24px rgba(0,0,0,0.3);}
  .icon{width:44px;height:44px;border-radius:50%;background:rgba(248,81,73,0.12);
    display:flex;align-items:center;justify-content:center;margin-bottom:16px;}
  h1{margin:0 0 8px;font-size:16px;font-weight:600;color:#e6edf3;letter-spacing:-0.01em;}
  p{margin:0 0 14px;font-size:13px;line-height:1.55;color:#8b949e;}
  .target{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:12px;background:#1c2128;border:1px solid #30363d;border-radius:4px;
    padding:6px 10px;color:#c9d1d9;word-break:break-all;margin-bottom:14px;}
  .hint{font-size:12px;color:#8b949e;border-top:1px solid #21262d;padding-top:12px;margin-top:4px;}
  .hint b{color:#c9d1d9;font-weight:600;}
</style></head><body><div class="wrap"><div class="card">
<div class="icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f85149" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
<h1>${esc(opts.title)}</h1>
<p>${esc(opts.detail)}</p>
${opts.target ? `<code class="target">${esc(opts.target)}</code>` : ""}
${opts.hint ? `<div class="hint">${opts.hint}</div>` : ""}
</div></div></body></html>`;
}

function previewProxy(): Plugin {
  let proxyPort = 0;
  let targetOrigin = "";

  return {
    name: "ezydev-preview-proxy",
    configureServer(server) {
      /* ---- Proxy HTTP server ---- */
      const proxy = http.createServer((cReq, cRes) => {
        // CORS preflight
        if (cReq.method === "OPTIONS") {
          cRes.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
            "Access-Control-Allow-Headers": "*",
          });
          cRes.end();
          return;
        }

        if (!targetOrigin) {
          cRes.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
          cRes.end(
            renderProxyErrorPage({
              title: "Preview not configured",
              detail:
                "The preview proxy hasn't been pointed at a target URL yet. Enter a URL in the address bar and press Enter.",
            }),
          );
          return;
        }

        const targetUrl = new URL(cReq.url || "/", targetOrigin);
        const lib = targetUrl.protocol === "https:" ? https : http;

        const headers: Record<string, string | string[] | undefined> = {
          ...cReq.headers,
          host: targetUrl.host,
          // Request uncompressed so we can inject into HTML
          "accept-encoding": "identity",
        };
        // Remove origin/referer that might confuse the target
        delete headers["origin"];
        delete headers["referer"];

        const proxyReq = lib.request(
          targetUrl,
          { method: cReq.method, headers },
          (proxyRes) => {
            const ct = (proxyRes.headers["content-type"] || "").toLowerCase();

            if (ct.includes("text/html")) {
              // Buffer HTML, inject script, send
              const chunks: Buffer[] = [];
              proxyRes.on("data", (c: Buffer) => chunks.push(c));
              proxyRes.on("end", () => {
                let html = Buffer.concat(chunks).toString("utf-8");
                const tag = `<script>${DEVTOOLS_INJECT_SCRIPT}</script>`;
                const m = html.match(/<head[^>]*>/i);
                html = m ? html.replace(m[0], m[0] + tag) : tag + html;

                const h: Record<string, string | string[] | undefined> = {
                  ...proxyRes.headers,
                };
                delete h["content-length"];
                delete h["content-encoding"];
                // Strip security headers that block our injected script
                delete h["content-security-policy"];
                delete h["content-security-policy-report-only"];
                delete h["x-frame-options"];
                h["access-control-allow-origin"] = "*";
                cRes.writeHead(proxyRes.statusCode || 200, h);
                cRes.end(html);
              });
            } else {
              // Stream non-HTML transparently
              const h: Record<string, string | string[] | undefined> = {
                ...proxyRes.headers,
              };
              h["access-control-allow-origin"] = "*";
              cRes.writeHead(proxyRes.statusCode || 200, h);
              proxyRes.pipe(cRes);
            }
          },
        );

        proxyReq.on("error", (err: NodeJS.ErrnoException) => {
          const code = err.code || "";
          let title = "Can't reach the page";
          let detail = err.message || "The preview proxy failed to contact the target.";
          let hint = "";
          if (code === "ECONNREFUSED") {
            title = "Connection refused";
            detail =
              "Nothing is listening on this address. The dev server may have stopped, crashed, or hasn't started yet.";
            hint =
              "<b>Tip:</b> start your dev server (e.g. <code>npm run dev</code>) and then refresh.";
          } else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
            title = "Host not found";
            detail = "DNS lookup failed for this address.";
            hint = "<b>Tip:</b> double-check the URL for typos.";
          } else if (code === "ETIMEDOUT" || code === "ECONNRESET") {
            title = "Request timed out";
            detail = "The target server didn't respond in time.";
            hint = "<b>Tip:</b> make sure the server is responsive, then refresh.";
          }
          cRes.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
          cRes.end(
            renderProxyErrorPage({
              title,
              detail,
              target: targetUrl.href,
              hint,
            }),
          );
        });

        cReq.pipe(proxyReq);
      });

      proxy.listen(0, "127.0.0.1", () => {
        const a = proxy.address();
        proxyPort = typeof a === "object" && a ? a.port : 0;
        // eslint-disable-next-line no-console
        console.log(`  [ezydev] Preview proxy → http://127.0.0.1:${proxyPort}`);
      });

      /* ---- Vite middleware: config endpoints ---- */
      server.middlewares.use("/__ezy_proxy__", (req, res) => {
        // Allow requests from any origin (Tauri webview may differ)
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "*");

        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }

        const u = new URL(req.url || "/", "http://localhost");

        if (u.pathname === "/port") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ port: proxyPort }));
          return;
        }

        if (u.pathname === "/set-target") {
          targetOrigin = u.searchParams.get("url") || "";
          res.end("OK");
          return;
        }

        res.statusCode = 404;
        res.end("Not found");
      });
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), previewProxy()],
  clearScreen: false,
  server: {
    port: 5420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
