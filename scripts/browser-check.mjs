import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { safeAdminPage,scriptPolicy } from '../dist/security/pages.js';
import { APP_VERSION } from '../dist/version.js';
import { managementScript } from '../dist/web/management-script.js';
const browser=process.env.BROWSER_PATH;
if(!browser)throw Error('Set BROWSER_PATH to Edge or Chrome. Build the project first.');
const profile=await mkdtemp(join(tmpdir(),'sakura-browser-'));
const sid='11111111-1111-4111-8111-111111111111';let admin=false,child,socket;
const mid='22222222-2222-4222-8222-222222222222';
const requests=[];
const errors=[];
const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/admin'){res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'self'; "+scriptPolicy+"; style-src 'self' 'unsafe-inline'");res.end(safeAdminPage);return;}
  if(path==='/assets/management.js'){res.setHeader('Content-Type','application/javascript');res.end(managementScript);return;}
  if(path==='/favicon.ico'){res.writeHead(204);res.end();return;}
  requests.push({method:req.method,path});
  const fixtures={
    '/api/admin/bootstrap':{csrf:'test',version:APP_VERSION,authEnabled:true,me:{displayName:'Fixture',isSystemAdmin:admin},spaces:[{id:sid,name:'Fixture space',role:'owner'}],agents:[]},
    '/api/admin/providers':{openaiCompatible:{configured:false},ollama:{configured:false}},
    '/api/admin/authentik':{configured:false},'/api/admin/sakura':{configured:false},'/api/admin/version':{currentVersion:APP_VERSION,latestVersion:APP_VERSION},
    '/api/admin/library':{memories:[{id:mid,type:'fact',summary:'Fixture <img src=x onerror=alert(1)>',content_preview:'Example',status:'active'}],total:1,page:1,limit:30},'/api/admin/jobs':{jobs:[]},
    ['/api/admin/library/'+mid]:{id:mid,space_id:sid,type:'fact',content:'Current text',summary:'Current',tags:[],status:'active'},
    ['/api/admin/library/'+mid+'/history']:{versions:[{version:1,reason:'created'}]},
    ['/api/admin/library/'+mid+'/versions/1']:{version:1,snapshot:{content:'Original text',summary:'Original',tags:[],type:'fact',status:'active'}},
    '/api/admin/import-queue/preview':{total:1,items:[{index:0,valid:true,duplicate:false}]},
    ['/api/admin/spaces/'+sid+'/member-page']:{members:[],page:1},
    ['/api/admin/spaces/'+sid+'/usage']:{quota:{max_memories:null,max_content_bytes:null,max_provider_calls_daily:null},usage:{memories:0},provider:[]}
  };
  if(!(path in fixtures))errors.push('Unexpected request '+path);
  res.writeHead(path in fixtures?200:404,{'Content-Type':'application/json'});res.end(JSON.stringify(fixtures[path]??{}));
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  child=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let port;
  for(let i=0;i<100;i++){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await sleep(100);}}
  if(!port)throw Error('Browser startup timed out');
  const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  socket=new WebSocket(targets.find(x=>x.type==='page').webSocketDebuggerUrl);await once(socket,'open');
  let sequence=0;const pending=new Map();
  socket.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(m.method==='Log.entryAdded'&&m.params.entry.level==='error')errors.push(m.params.entry.text);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>reject(Error('CDP timeout '+method)),8000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const waitFor=async(expression)=>{for(let attempt=0;attempt<100;attempt++){if(await evaluate(expression))return;await sleep(50);}throw Error('Browser condition timed out: '+expression);};
  await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Log.enable');
  for(const reduced of [false,true])for(const role of [false,true])for(const width of [320,390,1280]){
    await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]});
    admin=role;await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await cdp('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/admin'});
    await waitFor(`document.getElementById('aboutVersion')?.textContent==='v${APP_VERSION}'&&document.readyState==='complete'`);
    await evaluate(`document.querySelector('[data-view="management"]').click()`);
    await waitFor(`document.getElementById('manageMemories').children.length===1&&document.getElementById('managePage').textContent.includes('1')`);
    assert.equal(await evaluate(`document.getElementById('manageSpace').value`),sid);
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('manageOperations')).display!=='none'`),role);
    assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),true,'horizontal overflow at '+width);
    assert.equal(await evaluate(`document.getElementById('managePage').textContent.includes('1')`),true);
    assert.equal(await evaluate(`document.querySelectorAll('#manageMemories img').length`),0);
    await evaluate(`document.querySelector('#manageMemories .item button:last-child').click()`);
    await waitFor(`document.querySelector('#manageVersions button')!==null`);
    await evaluate(`document.querySelector('#manageVersions button').click()`);
    await waitFor(`document.getElementById('manageOld').textContent.includes('Original text')`);
    assert.equal(await evaluate(`document.getElementById('manageOld').textContent.includes('Original text')`),true);
    await evaluate(`document.getElementById('manageImport').value='[{"content":"fixture"}]';document.getElementById('managePreview').click()`);await sleep(150);
    await waitFor(`document.getElementById('manageImportResult').textContent.includes('duplicate')`);
    assert.equal(await evaluate(`document.getElementById('manageImportResult').textContent.includes('duplicate')`),true);
    await cdp('Page.bringToFront');
    await cdp('Emulation.setFocusEmulationEnabled',{enabled:true});
    await evaluate(`document.querySelector('[data-view="about"]').focus()`);
    assert.equal(await evaluate(`document.activeElement.dataset.view`),'about');
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await waitFor(`document.querySelector('section.active').id==='about'`);
    assert.equal(await evaluate(`document.querySelector('section.active').id`),'about');
    console.log(JSON.stringify({role:role?'admin':'user',width,reduced,management:true,csp:true,keyboard:true,history:true,preview:true}));
  }
  assert.deepEqual(errors,[]);
}finally{if(socket)socket.close();if(child)child.kill();server.closeAllConnections();server.close();await sleep(300);await rm(profile,{recursive:true,force:true,maxRetries:3}).catch(()=>{});}
