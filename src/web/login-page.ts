import { loginPolishStyles } from './design.js';

/**
 * Branded login landing page. `/auth/login` renders this page instead of
 * redirecting straight to Authentik so that a signed-out visitor sees an
 * explicit Sakura entry point and is not silently re-authenticated by an
 * existing SSO cookie. The actual OIDC redirect happens on `/auth/start`.
 *
 * When Authentik is the only enabled browser login method, `/auth/login` may
 * first perform a silent `prompt=none` probe. The probe only reads the
 * display name and cannot be redeemed for a session, so the page can offer
 * "continue as <name>" while still requiring an explicit click.
 *
 * No server data is templated into the markup: the return target, the status
 * notice and the probed display name are all derived in the browser from the
 * query string or a signed short-lived cookie, and written with textContent.
 *
 * Both pages follow the Sakura-fall (樱落) design language: a full-height
 * gradient brand panel on desktop (>=900px) with the product story, and a
 * single-column form with a compact brand row on narrow screens. The gradient
 * starts at the project Sakura pink accent and fades into violet; the form side
 * keeps the existing light/dark theme variables and input styling.
 */
export const loginPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · Sakura-MCP-Server</title>
<meta name="theme-color" content="#12161f">
<script>try{var t=localStorage.getItem('sakura-theme')||'auto';var d=t==='dark'||(t==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light'}catch(e){document.documentElement.dataset.theme='dark'}</script>
<style>
[hidden]{display:none!important}
:root{--bg:#f2f0f1;--ink:#1f181b;--muted:#7d7378;--line:#ded7da;--card:#fff;--accent:#d2647f;--accent-soft:#fbe6ec;--shadow:0 10px 30px rgba(48,34,40,.07);--brand-a:#d2647f;--brand-m:#ab51b1;--brand-b:#7c3aed}
[data-theme=dark]{--bg:#0f1116;--ink:#eceaf0;--muted:#8d8792;--line:#2a2730;--card:#171a21;--accent:#e58aa3;--accent-soft:#2c1f26;--shadow:0 10px 30px rgba(0,0,0,.45);color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;grid-template-columns:1.05fr .95fr;background:var(--bg);color:var(--ink);font:14px/1.6 system-ui,'Microsoft YaHei',sans-serif;letter-spacing:.01em}
/* 樱落品牌面板：固定品牌渐变（樱粉→紫罗兰），不随深浅主题变化 */
.brand-panel{position:relative;overflow:hidden;display:flex;flex-direction:column;padding:64px 48px 24px;background:linear-gradient(150deg,var(--brand-a) 0%,var(--brand-m) 45%,var(--brand-b) 100%);color:#fff}
.brand-body{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:flex-start}
.brand-chip{width:72px;height:72px;border-radius:20px;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;flex:none;color:#fff}
.brand-chip svg{width:40px;height:40px;display:block}
.brand-name{margin:22px 0 0;font-size:2.1rem;font-weight:700;line-height:1.25}
.brand-slogan{margin:8px 0 0;font-size:15px;color:rgba(255,255,255,.85)}
.brand-features{list-style:none;margin:40px 0 0;padding:0;display:grid;gap:20px}
.brand-features li{display:flex;gap:14px;align-items:center}
.feat-icon{width:34px;height:34px;border-radius:10px;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;flex:none;color:#fff}
.feat-icon svg{width:18px;height:18px;display:block}
.feat-title{display:block;font-size:14px;font-weight:600;color:#fff;line-height:1.4}
.feat-desc{display:block;font-size:13px;color:rgba(255,255,255,.7);line-height:1.5}
.brand-deco{position:absolute;right:-56px;bottom:-56px;width:260px;height:260px;opacity:.12;pointer-events:none;color:#fff}
.brand-foot{position:relative;margin:24px 0 0;font-size:12px;color:rgba(255,255,255,.6)}
.side{display:flex;align-items:center;justify-content:center;padding:clamp(24px,4vw,48px)}
.form-col{width:100%;max-width:420px}
.compact-brand{display:none;align-items:center;gap:10px;margin:0 0 18px}
.compact-chip{width:34px;height:34px;border-radius:10px;background:linear-gradient(150deg,var(--brand-a),var(--brand-b));display:flex;align-items:center;justify-content:center;flex:none;color:#fff}
.compact-chip svg{width:20px;height:20px;display:block}
.compact-name{font-size:15px;font-weight:700}
main{width:100%;background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);padding:clamp(26px,3vw,36px) clamp(24px,3vw,32px);text-align:center}
h1{font-size:20px;font-weight:700;margin:0 0 7px}
.sub{color:var(--muted);margin:0 0 24px;font-size:13px}
#notice{display:none;margin:0 0 20px;padding:11px 13px;border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:10px;background:var(--accent-soft);color:var(--ink);text-align:left;font-size:13px}
#who{display:none;margin:0 0 18px;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--bg);text-align:left}
#who .who-label{display:block;font-size:12px;color:var(--muted);margin-bottom:5px}
#who .who-name{display:block;font-weight:600;font-size:15px;overflow-wrap:anywhere}
.btn{display:block;width:100%;border:0;border-radius:10px;padding:12px 16px;font:inherit;font-weight:700;cursor:pointer;text-decoration:none;text-align:center;background:var(--accent);color:#2b141c;transition:filter .18s ease,color .18s ease,background .18s ease,border-color .18s ease}
.btn:hover{filter:brightness(1.06)}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.btn.ghost{margin-top:10px;background:transparent;color:var(--muted);font-weight:500;border:1px solid var(--line)}
.btn.ghost:hover{color:var(--ink);filter:none}
.themes{display:flex;gap:6px;justify-content:center;margin:22px 0 0}
.themes button{border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:8px;padding:6px 11px;font:inherit;font-size:12px;cursor:pointer;transition:color .18s ease,border-color .18s ease,background .18s ease}
.themes button.on{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
.foot{margin:20px 0 0;padding-top:18px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);line-height:1.7}
.version{font:500 11px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted)}
${loginPolishStyles}
@media(max-width:899px){body{grid-template-columns:1fr}.brand-panel{display:none}.side{padding:24px 20px}.compact-brand{display:flex}}
</style></head><body>
<section class="brand-panel">
  <div class="brand-body">
    <div class="brand-chip" aria-hidden="true"><svg viewBox="0 0 24 24"><mask id="sk-chip"><rect width="24" height="24" fill="#fff"/><circle cx="12" cy="11.8" r="2.1" fill="#000"/></mask><g fill="currentColor" mask="url(#sk-chip)"><circle cx="12" cy="6.5" r="4.1"/><circle cx="6.77" cy="10.3" r="4.1"/><circle cx="8.77" cy="16.45" r="4.1"/><circle cx="15.23" cy="16.45" r="4.1"/><circle cx="17.23" cy="10.3" r="4.1"/></g></svg></div>
    <h2 class="brand-name">Sakura MCP Server</h2>
    <p class="brand-slogan">一个记忆库，服务你所有的 AI 助手。</p>
    <ul class="brand-features">
      <li><span class="feat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg></span><span class="feat-text"><span class="feat-title">长期记忆</span><span class="feat-desc">跨会话保存与召回用户记忆</span></span></li>
      <li><span class="feat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span><span class="feat-text"><span class="feat-title">多用户隔离</span><span class="feat-desc">每个用户独立的记忆空间</span></span></li>
      <li><span class="feat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8z"/><path d="M12 17v5"/></svg></span><span class="feat-text"><span class="feat-title">MCP 原生</span><span class="feat-desc">任何 MCP 兼容 Agent 即插即用</span></span></li>
    </ul>
  </div>
  <svg class="brand-deco" viewBox="0 0 24 24" aria-hidden="true"><mask id="sk-deco"><rect width="24" height="24" fill="#fff"/><circle cx="12" cy="11.8" r="2.1" fill="#000"/></mask><g fill="currentColor" mask="url(#sk-deco)"><circle cx="12" cy="6.5" r="4.1"/><circle cx="6.77" cy="10.3" r="4.1"/><circle cx="8.77" cy="16.45" r="4.1"/><circle cx="15.23" cy="16.45" r="4.1"/><circle cx="17.23" cy="10.3" r="4.1"/></g></svg>
  <p class="brand-foot">本地账号与可选单点登录</p>
</section>
<div class="side">
  <div class="form-col">
    <header class="compact-brand"><span class="compact-chip" aria-hidden="true"><svg viewBox="0 0 24 24"><mask id="sk-mini"><rect width="24" height="24" fill="#fff"/><circle cx="12" cy="11.8" r="2.1" fill="#000"/></mask><g fill="currentColor" mask="url(#sk-mini)"><circle cx="12" cy="6.5" r="4.1"/><circle cx="6.77" cy="10.3" r="4.1"/><circle cx="8.77" cy="16.45" r="4.1"/><circle cx="15.23" cy="16.45" r="4.1"/><circle cx="17.23" cy="10.3" r="4.1"/></g></svg></span><span class="compact-name">Sakura MCP Server</span></header>
    <main>
      <h1 id="title">欢迎回来</h1>
    <p class="sub" id="subtitle">请选择已启用的登录方式：本地账号、Sakura 或 Authentik。</p>
    <div id="notice" role="status"></div>
    <div id="who"><span class="who-label">检测到已登录的 Authentik 会话</span><span class="who-name" id="whoName"></span></div>
    <a id="localLoginLink" class="btn ghost" href="/auth/local-login" hidden>本地账号登录</a>
    <a id="startButton" class="btn" href="/auth/start" hidden>单点登录</a>
    <a id="switchButton" class="btn ghost" href="/auth/start" hidden>使用其他账号登录</a>
    <a id="otherProviderLink" class="btn ghost" href="/auth/start" hidden></a>
    <div class="themes" role="group" aria-label="外观">
      <button type="button" data-theme-choice="light">日间</button>
      <button type="button" data-theme-choice="dark">夜间</button>
      <button type="button" data-theme-choice="auto">跟随系统</button>
    </div>
    <p class="foot">登录后可管理记忆空间、Agent 密钥与模型 Provider。<br><span class="version" id="version">管理台登录</span></p>
    </main>
  </div>
</div>
<script>
var $=function(id){return document.getElementById(id)};
var params=new URLSearchParams(location.search);
var target=params.get('return_to')||'/admin';
var safeTarget=/^\\/(?!\\/)/.test(target)?target:'/admin';
var query='?return_to='+encodeURIComponent(safeTarget);
$('startButton').href='/auth/start'+query;
$('switchButton').href='/auth/start'+query+'&switch=1';

var notices={expired:'登录状态已过期，请重新登录。',logged_out:'已退出本服务器登录。',probe_failed:'无法确认现有登录状态，请照常登录。'};
var notice=notices[params.get('reason')];
if(notice){$('notice').textContent=notice;$('notice').style.display='block'}

/* The probe writes a short-lived signed cookie. The signature is only ever
   verified server-side; the value here is displayed, never trusted. */
function readHint(){
  var hit=document.cookie.split(';').map(function(v){return v.trim()}).filter(function(v){return v.indexOf('sakura_login_hint=')===0})[0];
  if(!hit)return '';
  var raw=hit.slice('sakura_login_hint='.length).split('.')[0];
  if(!raw)return '';
  try{
    var bin=atob(raw.replace(/-/g,'+').replace(/_/g,'/'));
    var bytes=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    return new TextDecoder().decode(bytes)
  }catch(e){return ''}
}
var hint=params.get('probed')==='1'?readHint():'';
if(hint){
  $('whoName').textContent=hint;
  $('who').style.display='block';
  $('title').textContent='继续登录';
  $('subtitle').textContent='已检测到有效的单点登录会话，确认后即可直接进入。';
  $('startButton').textContent='以 '+hint+' 的身份登录';
  $('switchButton').hidden=false;
}

var choice='auto';
try{choice=localStorage.getItem('sakura-theme')||'auto'}catch(e){}
function applyTheme(next){
  choice=next;
  try{localStorage.setItem('sakura-theme',next)}catch(e){}
  var dark=next==='dark'||(next==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme=dark?'dark':'light';
  var all=document.querySelectorAll('[data-theme-choice]');
  for(var i=0;i<all.length;i++)all[i].classList.toggle('on',all[i].dataset.themeChoice===next);
}
var buttons=document.querySelectorAll('[data-theme-choice]');
for(var i=0;i<buttons.length;i++)buttons[i].addEventListener('click',function(){applyTheme(this.dataset.themeChoice)});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',function(){if(choice==='auto')applyTheme('auto')});
applyTheme(choice);

fetch('/health',{headers:{Accept:'application/json'}}).then(function(r){return r.json()}).then(function(d){
  if(d&&d.version)$('version').textContent='v'+d.version
}).catch(function(){});
/* The login method buttons follow whichever providers the installation
   actually has: the primary provider owns the main button, any second
   provider gets its own link, and local accounts appear when enabled.
   The labels are static strings keyed by provider name, so a mode response
   can never inject markup into the page. */
var PROVIDER_NAMES={authentik:'Authentik',sakura:'Sakura'};
fetch('/auth/modes').then(function(r){return r.json()}).then(function(d){
  if(!d)return;
  if(d.local){var link=$('localLoginLink');link.hidden=false;link.href='/auth/local-login'+query}
  var primary=d.provider;
  if(primary&&PROVIDER_NAMES[primary]){
    $('startButton').hidden=false;
    $('startButton').href='/auth/start'+query+'&provider='+primary;
    $('switchButton').href='/auth/start'+query+'&provider=authentik&switch=1';
    if(!hint||primary!=='authentik'){
      $('startButton').textContent='使用 '+PROVIDER_NAMES[primary]+' 登录';
      $('who').style.display='none';$('switchButton').hidden=true;
    }
    /* Offer the other configured provider as a separate entry, so both can be
       used when the installation has Authentik and Sakura together. */
    var other=primary==='authentik'?'sakura':'authentik';
    if(d[other]){var otherLink=$('otherProviderLink');otherLink.hidden=false;otherLink.href='/auth/start'+query+'&provider='+other;otherLink.textContent='使用 '+PROVIDER_NAMES[other]+' 登录'}
  }
}).catch(function(){});
$('startButton').focus();
</script>
</body></html>`;

/**
 * Username + password login page, served at `/auth/local-login` (and at
 * `/auth/login` when no external OIDC provider is configured at all).
 *
 * Same security rules as the OIDC landing page: no server data is templated in,
 * everything user-controlled is written with textContent, and the form posts via
 * fetch so a failed attempt never loses the page. `/auth/local` answers with
 * the redirect target only after the session cookie has been set.
 */
export const localLoginPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · Sakura-MCP-Server</title>
<meta name="theme-color" content="#12161f">
<script>try{var t=localStorage.getItem('sakura-theme')||'auto';var d=t==='dark'||(t==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light'}catch(e){document.documentElement.dataset.theme='dark'}</script>
<style>
:root{--bg:#f2f0f1;--ink:#1f181b;--muted:#7d7378;--line:#ded7da;--card:#fff;--accent:#d2647f;--accent-soft:#fbe6ec;--shadow:0 10px 30px rgba(48,34,40,.07);--brand-a:#d2647f;--brand-m:#ab51b1;--brand-b:#7c3aed}
[data-theme=dark]{--bg:#0f1116;--ink:#eceaf0;--muted:#8d8792;--line:#2a2730;--card:#171a21;--accent:#e58aa3;--accent-soft:#2c1f26;--shadow:0 10px 30px rgba(0,0,0,.45);color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;grid-template-columns:1.05fr .95fr;background:var(--bg);color:var(--ink);font:14px/1.6 system-ui,'Microsoft YaHei',sans-serif;letter-spacing:.01em}
/* 樱落品牌面板：固定品牌渐变（樱粉→紫罗兰），不随深浅主题变化 */
.brand-panel{position:relative;overflow:hidden;display:flex;flex-direction:column;padding:64px 48px 24px;background:linear-gradient(150deg,var(--brand-a) 0%,var(--brand-m) 45%,var(--brand-b) 100%);color:#fff}
.brand-body{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:flex-start}
.brand-chip{width:72px;height:72px;border-radius:20px;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;flex:none;color:#fff}
.brand-chip svg{width:40px;height:40px;display:block}
.brand-name{margin:22px 0 0;font-size:2.1rem;font-weight:700;line-height:1.25}
.brand-slogan{margin:8px 0 0;font-size:15px;color:rgba(255,255,255,.85)}
.brand-features{list-style:none;margin:40px 0 0;padding:0;display:grid;gap:20px}
.brand-features li{display:flex;gap:14px;align-items:center}
.feat-icon{width:34px;height:34px;border-radius:10px;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;flex:none;color:#fff}
.feat-icon svg{width:18px;height:18px;display:block}
.feat-title{display:block;font-size:14px;font-weight:600;color:#fff;line-height:1.4}
.feat-desc{display:block;font-size:13px;color:rgba(255,255,255,.7);line-height:1.5}
.brand-deco{position:absolute;right:-56px;bottom:-56px;width:260px;height:260px;opacity:.12;pointer-events:none;color:#fff}
.brand-foot{position:relative;margin:24px 0 0;font-size:12px;color:rgba(255,255,255,.6)}
.side{display:flex;align-items:center;justify-content:center;padding:clamp(24px,4vw,48px)}
.form-col{width:100%;max-width:420px}
.compact-brand{display:none;align-items:center;gap:10px;margin:0 0 18px}
.compact-chip{width:34px;height:34px;border-radius:10px;background:linear-gradient(150deg,var(--brand-a),var(--brand-b));display:flex;align-items:center;justify-content:center;flex:none;color:#fff}
.compact-chip svg{width:20px;height:20px;display:block}
.compact-name{font-size:15px;font-weight:700}
main{width:100%;background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);padding:clamp(26px,3vw,36px) clamp(24px,3vw,32px);text-align:center}
h1{font-size:20px;font-weight:700;margin:0 0 7px}
.sub{color:var(--muted);margin:0 0 20px;font-size:13px}
#notice{display:none;color:var(--accent);background:var(--accent-soft);border-radius:9px;padding:10px 13px;margin-bottom:16px;font-size:13px;text-align:left}
.btn{display:block;width:100%;text-align:center;text-decoration:none;margin-top:16px;padding:12px 16px;border:0;border-radius:10px;font-weight:650;background:var(--accent);color:#2b141c;transition:filter .18s ease,color .18s ease,border-color .18s ease}
.btn:hover{filter:brightness(1.06)}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
form{display:grid}
label{margin:12px 0 5px;font-size:13px;color:var(--muted)}
input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--ink);font:inherit;transition:border-color .18s ease}
input:focus{outline:2px solid var(--accent);border-color:var(--accent)}
button{margin-top:18px;padding:12px;border:0;border-radius:10px;font:inherit;font-weight:650;cursor:pointer;background:var(--accent);color:#fff;transition:filter .18s ease}
button:hover{filter:brightness(1.06)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
button:disabled{opacity:.5;cursor:not-allowed;filter:none}
.themes{display:flex;gap:6px;margin-top:22px}
.themes button{flex:1;padding:8px;background:transparent;border:1px solid var(--line);color:var(--muted);font:inherit;font-size:12px;border-radius:999px;cursor:pointer;transition:color .18s ease,border-color .18s ease}
.themes button.on{border-color:var(--accent);color:var(--accent)}
.foot{margin-top:26px;font-size:12px;color:var(--muted);line-height:1.7}
.foot a{color:var(--accent)}
.version{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
${loginPolishStyles}
@media(max-width:899px){body{grid-template-columns:1fr}.brand-panel{display:none}.side{padding:24px 20px}.compact-brand{display:flex}}
</style></head>
<body>
<section class="brand-panel">
  <div class="brand-body">
    <div class="brand-chip" aria-hidden="true"><svg viewBox="0 0 24 24"><mask id="sk-chip"><rect width="24" height="24" fill="#fff"/><circle cx="12" cy="11.8" r="2.1" fill="#000"/></mask><g fill="currentColor" mask="url(#sk-chip)"><circle cx="12" cy="6.5" r="4.1"/><circle cx="6.77" cy="10.3" r="4.1"/><circle cx="8.77" cy="16.45" r="4.1"/><circle cx="15.23" cy="16.45" r="4.1"/><circle cx="17.23" cy="10.3" r="4.1"/></g></svg></div>
    <h2 class="brand-name">Sakura MCP Server</h2>
    <p class="brand-slogan">一个记忆库，服务你所有的 AI 助手。</p>
    <ul class="brand-features">
      <li><span class="feat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg></span><span class="feat-text"><span class="feat-title">长期记忆</span><span class="feat-desc">跨会话保存与召回用户记忆</span></span></li>
      <li><span class="feat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span><span class="feat-text"><span class="feat-title">多用户隔离</span><span class="feat-desc">每个用户独立的记忆空间</span></span></li>
      <li><span class="feat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8z"/><path d="M12 17v5"/></svg></span><span class="feat-text"><span class="feat-title">MCP 原生</span><span class="feat-desc">任何 MCP 兼容 Agent 即插即用</span></span></li>
    </ul>
  </div>
  <svg class="brand-deco" viewBox="0 0 24 24" aria-hidden="true"><mask id="sk-deco"><rect width="24" height="24" fill="#fff"/><circle cx="12" cy="11.8" r="2.1" fill="#000"/></mask><g fill="currentColor" mask="url(#sk-deco)"><circle cx="12" cy="6.5" r="4.1"/><circle cx="6.77" cy="10.3" r="4.1"/><circle cx="8.77" cy="16.45" r="4.1"/><circle cx="15.23" cy="16.45" r="4.1"/><circle cx="17.23" cy="10.3" r="4.1"/></g></svg>
  <p class="brand-foot">记忆空间 · Agent · Provider 管理</p>
</section>
<div class="side">
  <div class="form-col">
    <header class="compact-brand"><span class="compact-chip" aria-hidden="true"><svg viewBox="0 0 24 24"><mask id="sk-mini"><rect width="24" height="24" fill="#fff"/><circle cx="12" cy="11.8" r="2.1" fill="#000"/></mask><g fill="currentColor" mask="url(#sk-mini)"><circle cx="12" cy="6.5" r="4.1"/><circle cx="6.77" cy="10.3" r="4.1"/><circle cx="8.77" cy="16.45" r="4.1"/><circle cx="15.23" cy="16.45" r="4.1"/><circle cx="17.23" cy="10.3" r="4.1"/></g></svg></span><span class="compact-name">Sakura MCP Server</span></header>
    <main>
      <h1 id="title">欢迎回来</h1>
      <p class="sub" id="subtitle">请输入服务器本地账号的用户名和密码。</p>
    <div id="notice" role="status"></div>
    <form id="localForm" autocomplete="on">
      <label for="username">用户名</label>
      <input id="username" name="username" autocomplete="username" autocapitalize="none" required>
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button id="submitButton" type="submit">登录</button>
    </form>
    <div class="themes" role="group" aria-label="外观">
      <button type="button" data-theme-choice="light">日间</button>
      <button type="button" data-theme-choice="dark">夜间</button>
      <button type="button" data-theme-choice="auto">跟随系统</button>
    </div>
    <p class="foot"><span id="version">管理台登录</span></p>
    </main>
  </div>
</div>
<script>
var $=function(id){return document.getElementById(id)};
var params=new URLSearchParams(location.search);
var target=params.get('return_to')||'/admin';
var safeTarget=/^\\/(?!\\/)/.test(target)?target:'/admin';
var query='?return_to='+encodeURIComponent(safeTarget);
var notices={expired:'登录状态已过期，请重新登录。',logged_out:'已退出登录。'};
var notice=notices[params.get('reason')];
if(notice){$('notice').textContent=notice;$('notice').style.display='block'}
$('localForm').addEventListener('submit',function(event){
  event.preventDefault();
  var button=$('submitButton');button.disabled=true;button.textContent='正在登录…';
  var body={username:$('username').value.trim(),password:$('password').value,return_to:safeTarget};
  fetch('/auth/local',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){
    return r.json().then(function(d){return {ok:r.ok,data:d}})
  }).then(function(out){
    if(out.ok){location.href=out.data.redirectTo||'/admin';return}
    $('notice').textContent=out.data&&out.data.error_description||'登录失败，请检查用户名和密码。';
    $('notice').style.display='block';
    $('password').value='';
    $('password').focus();
  }).catch(function(){
    $('notice').textContent='网络错误，请稍后重试。';$('notice').style.display='block'
  }).finally(function(){button.disabled=false;button.textContent='登录'});
});
var choice='auto';
try{choice=localStorage.getItem('sakura-theme')||'auto'}catch(e){}
function applyTheme(next){
  choice=next;
  try{localStorage.setItem('sakura-theme',next)}catch(e){}
  var dark=next==='dark'||(next==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme=dark?'dark':'light';
  var all=document.querySelectorAll('[data-theme-choice]');
  for(var i=0;i<all.length;i++)all[i].classList.toggle('on',all[i].dataset.themeChoice===next);
}
var buttons=document.querySelectorAll('[data-theme-choice]');
for(var i=0;i<buttons.length;i++)buttons[i].addEventListener('click',function(){applyTheme(this.dataset.themeChoice)});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',function(){if(choice==='auto')applyTheme('auto')});
applyTheme(choice);
fetch('/health',{headers:{Accept:'application/json'}}).then(function(r){return r.json()}).then(function(d){
  if(d&&d.version)$('version').textContent='v'+d.version
}).catch(function(){});
fetch('/auth/modes').then(function(r){return r.json()}).then(function(d){
  /* Every configured provider gets its own link, so an installation with
     Authentik and Sakura offers both next to the local form. Labels are static
     strings keyed by the provider name, never the response itself. */
  if(!d)return;
  var names={authentik:'Authentik',sakura:'Sakura'};
  var here=$('localForm');
  ['sakura','authentik'].forEach(function(name){
    if(!d[name])return;
    var a=document.createElement('a');
    a.className='btn';
    a.href='/auth/start'+query+'&provider='+name;
    a.textContent='使用 '+names[name]+' 登录';
    here.parentNode.insertBefore(a,here.nextSibling);
    here=a;
  });
}).catch(function(){});
$('username').focus();
</script>
</body></html>`;
