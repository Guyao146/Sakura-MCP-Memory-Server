/**
 * Branded login landing page. `/auth/login` renders this page instead of
 * redirecting straight to Authentik so that a signed-out visitor sees an
 * explicit Sakura entry point and is not silently re-authenticated by an
 * existing SSO cookie. The actual OIDC redirect happens on `/auth/start`.
 *
 * When an Authentik SSO session already exists, `/auth/login` first performs a
 * silent `prompt=none` probe through `/auth/peek`. The probe only reads the
 * display name and cannot be redeemed for a session, so the page can offer
 * "continue as <name>" while still requiring an explicit click.
 *
 * No server data is templated into the markup: the return target, the status
 * notice and the probed display name are all derived in the browser from the
 * query string or a signed short-lived cookie, and written with textContent.
 *
 * Layout and typography follow Life Dashboard so the ecosystem shares one
 * visual language, while the accent colour stays Sakura pink.
 */
export const loginPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · Sakura-MCP-Server</title>
<meta name="theme-color" content="#12161f">
<script>try{var t=localStorage.getItem('sakura-theme')||'auto';var d=t==='dark'||(t==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light'}catch(e){document.documentElement.dataset.theme='dark'}</script>
<style>
:root{--bg:#f2f0f1;--ink:#1f181b;--muted:#7d7378;--line:#ded7da;--card:#fff;--accent:#d2647f;--accent-soft:#fbe6ec;--panel-a:#2a1d24;--panel-b:#12161f;--shadow:0 10px 30px rgba(48,34,40,.07)}
[data-theme=dark]{--bg:#0f1116;--ink:#eceaf0;--muted:#8d8792;--line:#2a2730;--card:#171a21;--accent:#e58aa3;--accent-soft:#2c1f26;--panel-a:#2b1e26;--panel-b:#0c0e14;--shadow:0 10px 30px rgba(0,0,0,.45);color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;grid-template-columns:1.05fr .95fr;background:var(--bg);color:var(--ink);font:14px/1.6 system-ui,'Microsoft YaHei',sans-serif;letter-spacing:.01em}
.panel{position:relative;overflow:hidden;padding:clamp(32px,5vw,64px);display:flex;flex-direction:column;justify-content:space-between;background:linear-gradient(150deg,var(--panel-a),var(--panel-b));color:#f4eef1}
.panel:before,.panel:after{content:'';position:absolute;border-radius:50%;pointer-events:none}
.panel:before{width:420px;height:420px;right:-150px;top:-130px;background:radial-gradient(circle,rgba(229,138,163,.30),transparent 68%)}
.panel:after{width:320px;height:320px;left:-120px;bottom:-110px;background:radial-gradient(circle,rgba(229,138,163,.16),transparent 70%)}
.brand{display:flex;gap:11px;align-items:center;font-weight:700;font-size:17px;position:relative}
.logo{width:28px;height:28px;border-radius:9px;background:var(--accent);position:relative;flex:none}
.logo:after{content:'';position:absolute;width:10px;height:10px;border:2px solid #fff;border-radius:50%;top:7px;left:7px}
.copy{position:relative;margin:40px 0}
.headline{font-size:clamp(24px,2.7vw,33px);line-height:1.42;font-weight:700;margin:0 0 26px}
.points{list-style:none;margin:0;padding:0;display:grid;gap:13px;color:rgba(244,238,241,.78)}
.points li{display:flex;gap:11px;align-items:flex-start}
.pt{color:var(--accent);font-size:15px;line-height:1.5}
.panel-foot{position:relative;display:flex;gap:11px;align-items:center;flex-wrap:wrap;font-size:12px;color:rgba(244,238,241,.6)}
.mono{font:500 11px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.08em;border:1px solid rgba(244,238,241,.22);border-radius:999px;padding:4px 10px}
.side{display:flex;align-items:center;justify-content:center;padding:clamp(24px,4vw,48px)}
main{width:100%;max-width:392px;background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);padding:clamp(26px,3vw,36px) clamp(24px,3vw,32px);text-align:center}
main>.logo{margin:0 auto 16px}
h1{font-size:21px;margin:0 0 7px}
.sub{color:var(--muted);margin:0 0 24px;font-size:13px}
#notice{display:none;margin:0 0 20px;padding:11px 13px;border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:10px;background:var(--accent-soft);color:var(--ink);text-align:left;font-size:13px}
#who{display:none;margin:0 0 18px;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--bg);text-align:left}
#who .who-label{display:block;font-size:12px;color:var(--muted);margin-bottom:5px}
#who .who-name{display:block;font-weight:600;font-size:15px;overflow-wrap:anywhere}
.btn{display:block;width:100%;border:0;border-radius:10px;padding:12px 16px;font:inherit;font-weight:700;cursor:pointer;text-decoration:none;text-align:center;background:var(--accent);color:#2b141c}
.btn:hover{filter:brightness(1.06)}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.btn.ghost{margin-top:10px;background:transparent;color:var(--muted);font-weight:500;border:1px solid var(--line)}
.btn.ghost:hover{color:var(--ink);filter:none}
.themes{display:flex;gap:6px;justify-content:center;margin:22px 0 0}
.themes button{border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:8px;padding:6px 11px;font:inherit;font-size:12px;cursor:pointer}
.themes button.on{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
.foot{margin:20px 0 0;padding-top:18px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);line-height:1.7}
.version{font:500 11px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted)}
@media(max-width:880px){body{grid-template-columns:1fr;grid-template-rows:auto 1fr}.panel{padding:28px 24px}.copy{margin:24px 0}.headline{font-size:22px;margin-bottom:18px}.points{display:none}.side{padding:24px}}
</style></head><body>
<section class="panel">
  <div class="brand"><span class="logo"></span>Sakura-MCP-Server</div>
  <div class="copy">
    <h2 class="headline">让每个 AI Agent，<br>共享同一份长期记忆。</h2>
    <ul class="points">
      <li><span class="pt">❀</span>个人与共享空间，按角色划分访问边界</li>
      <li><span class="pt">◈</span>全文与语义混合召回，保留来源与版本</li>
      <li><span class="pt">◎</span>Agent 密钥独立授权，可随时查看与撤销</li>
    </ul>
  </div>
  <div class="panel-foot"><span class="mono">OIDC · PKCE</span>由 樱落怡然验证服务 提供统一登录</div>
</section>
<div class="side">
  <main>
    <div class="logo"></div>
    <h1 id="title">欢迎回来</h1>
    <p class="sub" id="subtitle">本站使用 Authentik 单点登录，请通过下方按钮继续。</p>
    <div id="notice" role="status"></div>
    <div id="who"><span class="who-label">检测到已登录的 Authentik 会话</span><span class="who-name" id="whoName"></span></div>
    <a id="startButton" class="btn" href="/auth/start">使用 Authentik 登录</a>
    <a id="switchButton" class="btn ghost" href="/auth/start" hidden>使用其他账号登录</a>
    <div class="themes" role="group" aria-label="外观">
      <button type="button" data-theme-choice="light">日间</button>
      <button type="button" data-theme-choice="dark">夜间</button>
      <button type="button" data-theme-choice="auto">跟随系统</button>
    </div>
    <p class="foot">登录后可管理记忆空间、Agent 密钥与模型 Provider。<br><span class="version" id="version">管理台登录</span></p>
  </main>
</div>
<script>
var $=function(id){return document.getElementById(id)};
var params=new URLSearchParams(location.search);
var target=params.get('return_to')||'/admin';
var safeTarget=/^\\/(?!\\/)/.test(target)?target:'/admin';
var query='?return_to='+encodeURIComponent(safeTarget);
$('startButton').href='/auth/start'+query;
$('switchButton').href='/auth/start'+query+'&switch=1';

var notices={expired:'登录状态已过期，请重新登录。',logged_out:'已退出登录，Authentik 单点登录会话也已结束。',probe_failed:'无法确认现有登录状态，请照常登录。'};
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
$('startButton').focus();
</script>
</body></html>`;

