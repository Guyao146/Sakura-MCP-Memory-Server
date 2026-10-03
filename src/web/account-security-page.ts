export const accountSecurityHtml = `
<style>#security label,#localAccountDialog label{display:block;margin:12px 0}#security input,#localAccountDialog input:not([type=checkbox]){display:block;width:100%;margin-top:5px}#localAccountDialog input[type=checkbox]{min-width:0}</style>
<section id="security"><h1>账号安全中心</h1>
<p class="muted">各登录来源的账号独立，不自动合并。以下操作不撤销 Agent Key；请在 Agent 密钥页面单独管理。</p>
<div id="selfSecurity" class="box"><h2>我的登录会话</h2><p class="muted">最多展示最近 200 个有效会话。这里只退出本站会话，不退出上游身份服务；已有 SSO 登录可能再次进入本站。</p>
<div class="toolbar"><button class="secondary" onclick="loadSecurity()">刷新</button><button class="danger" onclick="revokeOtherSessions()">退出其他会话</button></div><div id="webSessionList" class="list"></div>
<form id="passwordForm" onsubmit="event.preventDefault();changeOwnPassword()" style="display:none"><h2>修改本地密码</h2><p class="muted">修改后包括当前会话在内的所有本地会话都会退出，请重新登录。</p>
<label>当前密码<input id="currentPassword" type="password" autocomplete="current-password" required maxlength="200"></label>
<label>新密码<input id="newPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="200"></label>
<label>确认新密码<input id="confirmPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="200"></label>
<button id="changePasswordButton" type="submit">修改密码并退出</button></form></div>
<div id="localAccountAdmin" class="box" style="display:none;margin-top:16px"><h2>本地账号管理</h2><p id="localLoginNotice" class="muted"></p>
<p class="muted">用户名不区分大小写。删除只移除本地登录凭据，保留用户、记忆和 Agent Key；不能删除或降权最后一个未锁定的本地管理员。</p>
<p class="muted">删除凭据后保留的用户名不能重新注册；恢复访问需由部署运维显式恢复。</p><button onclick="openLocalAccount()">创建账号</button><div id="localUserList" class="list" style="margin-top:16px"></div></div></section>
<div id="localAccountDialog" class="dialog"><form class="modal" onsubmit="event.preventDefault();saveLocalAccount()"><h2 id="localAccountTitle">本地账号</h2>
<label>用户名<input id="accountUsername" autocomplete="username" required pattern="[A-Za-z0-9._\\x2d]{3,60}" maxlength="60"></label>
<label>显示名称<input id="accountDisplayName" required maxlength="120"></label>
<label>邮箱（可选）<input id="accountEmail" type="email"></label>
<label><input id="accountAdmin" type="checkbox">系统管理员</label>
<label id="accountPasswordLabel">密码<input id="accountPassword" type="password" autocomplete="new-password" minlength="8" maxlength="200"></label>
<p id="accountFormNotice" class="muted"></p><div class="toolbar"><button id="saveLocalAccountButton" type="submit">保存</button><button type="button" class="secondary" onclick="closeDialogs()">取消</button></div></form></div>`;

export const accountSecurityScript = `
let localAccounts=[],accountMode='create';
function securityButton(label,action,danger=false){const b=document.createElement('button');b.textContent=label;b.className=danger?'danger':'secondary';b.onclick=action;return b}
async function loadSecurity(){
  $('selfSecurity').style.display=state.authEnabled?'block':'none';
  $('passwordForm').style.display=state.authEnabled&&state.localLogin&&state.me.authSource==='local'?'block':'none';
  $('localAccountAdmin').style.display=state.me.isSystemAdmin?'block':'none';
  $('localLoginNotice').textContent=state.localLogin?'本地登录已启用。':'本地登录未启用：管理凭据不会自动启用登录。';
  try{if(state.authEnabled){const d=await api('/api/me/sessions');$('webSessionList').innerHTML='';
    for(const s of d.sessions){const item=document.createElement('div');item.className='item';const text=document.createElement('div');
      text.textContent=(s.current?'当前会话 · ':'')+s.authSource+' · 创建 '+new Date(s.createdAt).toLocaleString()+' · 最近活动 '+new Date(s.lastSeenAt).toLocaleString()+' · 到期 '+new Date(s.expiresAt).toLocaleString();
      item.append(text,securityButton(s.current?'退出当前会话':'退出',()=>revokeWebSession(s.id),true));$('webSessionList').append(item)}}
    if(state.me.isSystemAdmin){const d=await api('/api/admin/local-users');localAccounts=d.users;$('localUserList').innerHTML='';
      for(const u of localAccounts){const item=document.createElement('div');item.className='item';const text=document.createElement('div');
        text.textContent=u.displayName+' ('+u.username+') · '+(u.isSystemAdmin?'管理员':'用户')+' · '+(new Date(u.lockedUntil)>new Date()?'已锁定':'未锁定')+' · 失败次数 '+u.failedAttempts;
        const actions=document.createElement('div');actions.className='actions';actions.append(securityButton('编辑',()=>openLocalAccount(u,'edit')),securityButton('重置密码',()=>openLocalAccount(u,'reset')),securityButton('解锁',()=>localAccountAction(u,'unlock')),securityButton('删除凭据',()=>localAccountAction(u,'delete'),true));item.append(text,actions);$('localUserList').append(item)}}
  }catch(e){toast(e.message,true)}
}
async function revokeOtherSessions(){if(!confirm('退出此账号的其他本站会话？不影响 Agent Key 或上游 SSO。'))return;try{await api('/api/me/sessions/revoke-others',{method:'POST'});await loadSecurity();toast('其他会话已退出')}catch(e){toast(e.message,true)}}
async function revokeWebSession(id){if(!confirm('退出这个本站会话？'))return;try{const d=await api('/api/me/sessions/'+encodeURIComponent(id),{method:'DELETE'});if(d.redirectTo){location=d.redirectTo;return}await loadSecurity()}catch(e){toast(e.message,true)}}
async function changeOwnPassword(){if($('newPassword').value!==$('confirmPassword').value){toast('两次新密码不一致',true);return}$('changePasswordButton').disabled=true;try{const d=await api('/api/me/password',{method:'POST',body:JSON.stringify({currentPassword:$('currentPassword').value,newPassword:$('newPassword').value})});for(const id of ['currentPassword','newPassword','confirmPassword'])$(id).value='';location=d.redirectTo}catch(e){toast(e.message,true)}finally{$('changePasswordButton').disabled=false}}
function openLocalAccount(u,mode='create'){accountMode=mode;$('localAccountTitle').textContent=mode==='create'?'创建本地账号':mode==='reset'?'重置密码':'编辑本地账号';$('accountUsername').value=u?.username||'';$('accountDisplayName').value=u?.displayName||'';$('accountEmail').value=u?.email||'';$('accountAdmin').checked=u?.isSystemAdmin||false;$('accountPassword').value='';$('accountUsername').disabled=mode!=='create';for(const id of ['accountDisplayName','accountEmail','accountAdmin'])$(id).disabled=mode==='reset';$('accountPasswordLabel').style.display=mode==='edit'?'none':'block';$('accountPassword').required=mode!=='edit';$('accountFormNotice').textContent=mode==='reset'?'重置后该账号的所有本地会话失效。':'';$('localAccountDialog').classList.add('open')}
async function saveLocalAccount(){const username=$('accountUsername').value.trim().toLowerCase();if(accountMode==='create'&&localAccounts.some(u=>u.username===username)){toast('用户名已存在，请使用编辑或重置密码',true);return}if(accountMode==='reset'&&!confirm('重置密码并退出该账号的所有本地会话？'))return;$('saveLocalAccountButton').disabled=true;try{const path='/api/admin/local-users'+(accountMode==='create'?'':'/'+encodeURIComponent(username));const profile={displayName:$('accountDisplayName').value,email:$('accountEmail').value||null,isSystemAdmin:$('accountAdmin').checked};const body=accountMode==='reset'?{password:$('accountPassword').value}:accountMode==='create'?{...profile,email:profile.email||undefined,username,password:$('accountPassword').value}:profile;await api(path,{method:accountMode==='create'?'POST':accountMode==='reset'?'PUT':'PATCH',body:JSON.stringify(body)});$('accountPassword').value='';closeDialogs();await init();await loadSecurity();toast('账号已保存')}catch(e){toast(e.message,true)}finally{$('saveLocalAccountButton').disabled=false}}
async function localAccountAction(u,action){if(!confirm(action==='delete'?'删除 '+u.username+' 的本地登录凭据并退出所有本地会话？用户数据和 Agent Key 会保留。':'解锁 '+u.username+'？'))return;try{await api('/api/admin/local-users/'+encodeURIComponent(u.username)+(action==='unlock'?'/unlock':''),{method:action==='unlock'?'POST':'DELETE'});await loadSecurity();toast('操作完成')}catch(e){toast(e.message,true)}}
`;
