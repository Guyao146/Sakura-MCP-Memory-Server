/**
 * Static HTML for the local config panel. No server data is templated in; the
 * page reads the panel token from its own query string and fetches state via
 * the loopback API. Secrets are written with textContent / input values only.
 */
export const panelHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sakura Cline Sync</title><style>
:root{color-scheme:dark;--bg:#0b0f16;--panel:#151b26;--line:#293244;--text:#edf2fa;--muted:#96a3b7;--accent:#e58aa3;--ok:#67d6a3;--bad:#ff7b86}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 system-ui,sans-serif;padding:24px}
main{max-width:560px;margin:0 auto}h1{font-size:20px}h1 b{color:var(--accent)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin-top:16px}
label{display:block;margin:12px 0 4px;color:var(--muted);font-size:13px}
input{width:100%;background:#101621;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:9px 11px}
.row{display:flex;gap:12px}.row>div{flex:1}
.check{display:flex;align-items:center;gap:8px;margin-top:14px}.check input{width:auto}
button{border:0;border-radius:8px;padding:9px 16px;font-weight:650;cursor:pointer;background:var(--accent);color:#25141a;margin-top:16px}
button.secondary{background:#293244;color:var(--text)}button:disabled{opacity:.5}
.actions{display:flex;gap:10px}.muted{color:var(--muted)}.ok{color:var(--ok)}.bad{color:var(--bad)}
.status{font-size:13px}.status div{margin:3px 0}.list{margin-top:10px;font-size:12px}
.item{border-top:1px solid var(--line);padding:6px 0;display:flex;justify-content:space-between;gap:10px}
select{width:100%;background:#101621;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:9px 11px}
.task{border-top:1px solid var(--line);padding:8px 0;display:flex;align-items:flex-start;gap:10px;font-size:12px}
.task input{width:auto;margin-top:3px}
.task .meta{flex:1}.task .id{font-family:ui-monospace,monospace}
</style></head><body><main>
<h1><b>Sakura</b> Cline Sync</h1>
<div class="card">
  <label>MCP 地址</label><input id="mcpUrl" placeholder="https://mcp.example.com/mcp">
  <label>Agent 密钥（sk_sakura_…）</label><input id="token" placeholder="留空则保留已保存的密钥">
  <label>Cline 任务目录（留空自动检测）</label><input id="clineTasksDir">
  <div class="row">
    <div><label>扫描间隔（分钟）</label><input id="intervalMinutes" type="number" min="1" max="1440"></div>
    <div><label>忽略早于（天，0=不限）</label><input id="maxTaskAgeDays" type="number" min="0" max="3650"></div>
  </div>
  <div class="check"><input id="redactSecrets" type="checkbox"><label style="margin:0">上传前脱敏密钥/令牌</label></div>
  <div class="check"><input id="enabled" type="checkbox"><label style="margin:0">启用自动同步</label></div>
  <div class="actions">
    <button id="saveButton" onclick="save()">保存</button>
    <button class="secondary" onclick="test()">测试连接</button>
    <button class="secondary" onclick="syncNow()">立即同步</button>
  </div>
  <div id="msg" class="muted" style="margin-top:12px">加载中…</div>
</div>
<div class="card">
  <h1 style="font-size:15px;margin:0 0 8px">任务选择</h1>
  <div class="muted" style="font-size:12px">选择要同步哪些 Cline 对话。「待推送」为本次会实际上传的消息数，每个任务一次抽取调用。</div>
  <label>选择方式</label>
  <select id="selectionMode" onchange="onModeChange()">
    <option value="all">全部（仅受时间范围限制）</option>
    <option value="include">仅同步勾选的任务</option>
    <option value="exclude">排除勾选的任务</option>
  </select>
  <div class="actions" style="margin-top:10px">
    <button class="secondary" onclick="loadTasks()">刷新列表</button>
    <button class="secondary" onclick="checkAll(true)">全选</button>
    <button class="secondary" onclick="checkAll(false)">全不选</button>
  </div>
  <div id="taskList" class="list" style="margin-top:10px"><div class="muted">加载中…</div></div>
  <div id="taskSummary" class="muted" style="margin-top:8px;font-size:12px"></div>
  <button onclick="saveSelection()">保存选择</button>
</div>
<div class="card status">
  <h1 style="font-size:15px;margin:0 0 8px">状态</h1>
  <div>自动同步：<span id="stEnabled">-</span></div>
  <div>上次运行：<span id="stLast">-</span></div>
  <div>下次运行：<span id="stNext">-</span></div>
  <div>上次结果：<span id="stResult">-</span></div>
  <div class="list" id="stList"></div>
</div>
</main>
<script>
var token=new URLSearchParams(location.search).get('token')||'';
function $(id){return document.getElementById(id)}
function api(path,opt){opt=opt||{};opt.headers=Object.assign({'X-Panel-Token':token},opt.headers||{});if(opt.body)opt.headers['Content-Type']='application/json';return fetch(path,opt).then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d}})})}
function setMsg(text,cls){var m=$('msg');m.textContent=text;m.className=cls||'muted'}
function render(state){var c=state.config;$('mcpUrl').value=c.mcpUrl||'';$('token').value='';$('token').placeholder=c.token?c.token:'sk_sakura_…';$('clineTasksDir').value=c.clineTasksDir||'';$('intervalMinutes').value=c.intervalMinutes;$('maxTaskAgeDays').value=c.maxTaskAgeDays;$('redactSecrets').checked=c.redactSecrets;$('enabled').checked=c.enabled;$('selectionMode').value=c.selectionMode||'all';selected=(c.selectedTasks||[]).slice();renderStatus(state.status)}
var selected=[];
var tasks=[];
function onModeChange(){renderTasks()}
function loadTasks(){api('/api/tasks').then(function(r){if(r.ok){tasks=r.d.tasks||[];renderTasks()}else $('taskList').textContent=r.d.error||'加载失败'})}
function renderTasks(){var list=$('taskList');list.innerHTML='';var mode=$('selectionMode').value;if(!tasks.length){var e=document.createElement('div');e.className='muted';e.textContent='未发现任务。';list.append(e);$('taskSummary').textContent='';return}
var pendingTotal=0,activeCount=0;
tasks.forEach(function(t){var row=document.createElement('div');row.className='task';var box=document.createElement('input');box.type='checkbox';box.disabled=mode==='all';box.checked=selected.indexOf(t.taskId)>=0;box.onchange=function(){toggle(t.taskId,box.checked)};var meta=document.createElement('div');meta.className='meta';var id=document.createElement('div');id.className='id';id.textContent=t.taskId;var info=document.createElement('div');info.className='muted';var when=t.modifiedAt?new Date(t.modifiedAt).toLocaleString():'-';info.textContent='最后活动 '+when+' · 消息 '+t.messageCount+' · 待推送 '+t.pendingMessages+(t.syncedAt?(' · 已同步 '+new Date(t.syncedAt).toLocaleString()):' · 从未同步');meta.append(id,info);var flag=document.createElement('span');var willSync=willSyncTask(t,mode,box.checked);flag.textContent=willSync?'将同步':(t.outOfWindow?'超出时间范围':'跳过');flag.className=willSync?'ok':'muted';if(willSync){pendingTotal+=t.pendingMessages;activeCount+=1}row.append(box,meta,flag);list.append(row)});
$('taskSummary').textContent='本次将同步 '+activeCount+' 个任务，合计待推送 '+pendingTotal+' 条消息（约 '+activeCount+' 次抽取调用）。'}
function willSyncTask(t,mode,checked){if(t.outOfWindow)return false;if(mode==='include')return checked;if(mode==='exclude')return !checked;return true}
function toggle(id,on){var i=selected.indexOf(id);if(on&&i<0)selected.push(id);if(!on&&i>=0)selected.splice(i,1);renderTasks()}
function checkAll(on){if($('selectionMode').value==='all'){setMsg('当前为「全部」模式，勾选无效','muted');return}selected=on?tasks.map(function(t){return t.taskId}):[];renderTasks()}
function saveSelection(){setMsg('保存中…');api('/api/config',{method:'POST',body:JSON.stringify({selectionMode:$('selectionMode').value,selectedTasks:selected})}).then(function(r){if(r.ok){setMsg('选择已保存','ok');loadTasks()}else setMsg(r.d.error||'保存失败','bad')})}
function renderStatus(s){$('stEnabled').textContent=s.enabled?'开启':'关闭';$('stLast').textContent=s.lastRunAt||'从未';$('stNext').textContent=s.nextRunAt||'-';$('stResult').textContent=s.lastResult||'-';var list=$('stList');list.innerHTML='';(s.recent||[]).forEach(function(o){var d=document.createElement('div');d.className='item';var a=document.createElement('span');a.textContent=o.taskId;var b=document.createElement('span');b.textContent=o.status+(o.newMessages?(' · '+o.newMessages+' 条'):'')+(o.reason?(' · '+o.reason):'');b.className=o.status==='synced'?'ok':o.status==='failed'?'bad':'muted';d.append(a,b);list.append(d)})}
function collect(){return{mcpUrl:$('mcpUrl').value,token:$('token').value,clineTasksDir:$('clineTasksDir').value,intervalMinutes:Number($('intervalMinutes').value),maxTaskAgeDays:Number($('maxTaskAgeDays').value),redactSecrets:$('redactSecrets').checked,enabled:$('enabled').checked,selectionMode:$('selectionMode').value,selectedTasks:selected}}
function load(){api('/api/state').then(function(r){if(r.ok){render(r.d);setMsg('就绪')}else setMsg(r.d.error||'加载失败','bad')})}
function save(){setMsg('保存中…');api('/api/config',{method:'POST',body:JSON.stringify(collect())}).then(function(r){if(r.ok){setMsg('已保存','ok');load();loadTasks()}else setMsg(r.d.error||'保存失败','bad')})}
function test(){setMsg('测试中…');api('/api/test',{method:'POST'}).then(function(r){setMsg(r.ok?'连接成功':(r.d.error||'连接失败'),r.ok?'ok':'bad')})}
function syncNow(){setMsg('同步中…');api('/api/sync',{method:'POST'}).then(function(r){if(r.ok){setMsg('已触发同步','ok');renderStatus(r.d.status)}else setMsg(r.d.error||'同步失败','bad')})}
load();loadTasks();setInterval(function(){api('/api/state').then(function(r){if(r.ok)renderStatus(r.d.status)})},5000);
</script>
</body></html>`;
