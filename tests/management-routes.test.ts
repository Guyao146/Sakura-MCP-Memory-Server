import { describe,it,expect,vi } from 'vitest';
import { Hono } from 'hono';
import { registerManagementRoutes } from '../src/web/management-routes.js';
import { WebSessionService } from '../src/web/session.js';
import type { WebIdentity } from '../src/web/session.js';
const identity:WebIdentity={sessionId:'session',userId:'user',subject:'local:user',email:'admin@example.test',displayName:'User',avatarUrl:null,isSystemAdmin:false,expiresAt:'2099-01-01',authSource:'local'};
function fixture(){
  const app=new Hono(),query=vi.fn().mockResolvedValue({rows:[{role:'viewer'}]}),database={query};
  const gates:boolean[]=[];
  registerManagementRoutes(app,database as never,async(c,write,handler)=>{
    gates.push(write);
    if(!c.req.header('authorization'))return c.json({error:'unauthorized'},401);
    if(write&&c.req.header('x-csrf-token')!=='fixture')return c.json({error:'csrf'},403);
    try{return c.json(await handler(identity));}catch(error){return c.json({error:(error as Error).message},400);}
  },()=>false);
  return {app,query,gates};
}
describe('management route boundaries',()=>{
  it('requires authentication and CSRF on writes',async()=>{
    const {app,query}=fixture();
    expect((await app.request('/api/admin/library')).status).toBe(401);
    expect((await app.request('/api/admin/library/batch',{method:'POST',headers:{authorization:'fixture'}})).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
  it('denies system data and maintenance to ordinary users',async()=>{
    const {app,query}=fixture();
    const headers={authorization:'fixture','x-csrf-token':'fixture'};
    expect((await app.request('/api/admin/operations',{headers})).status).toBe(400);
    expect((await app.request('/api/admin/operations/cleanup',{method:'POST',headers})).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
  it('never accepts local profile email as invitation proof',async()=>{
    const {app,query}=fixture();
    const response=await app.request('/api/admin/invitations/accept',{method:'POST',headers:{authorization:'fixture','x-csrf-token':'fixture','content-type':'application/json'},body:JSON.stringify({token:'a'.repeat(43)})});
    expect((await response.json()).error).toContain('OIDC-verified');expect(query).not.toHaveBeenCalled();
  });
  it('does not enqueue unrecoverable work while worker is disabled',async()=>{
    const {app,query}=fixture();
    const response=await app.request('/api/admin/import-queue',{method:'POST',headers:{authorization:'fixture','x-csrf-token':'fixture'}});
    expect((await response.json()).error).toContain('disabled');expect(query).not.toHaveBeenCalled();
  });
  it('stores invitation trust on the session, not the mutable user profile',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[]});
    const service=new WebSessionService({query} as never,()=>({publicBaseUrl:'https://mcp.example.test'} as never));
    await service.issueSession('u','/admin','authentik',undefined,'verified@example.test');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('verified_email'),['u',expect.any(String),'authentik','verified@example.test']);
  });
});
