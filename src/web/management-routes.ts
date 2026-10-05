import { AgentRepository } from '../agents/repository.js';
import { z } from 'zod/v4';
import type { Hono, Context } from 'hono';
import type { Database } from '../database.js';
import type { WebIdentity } from './session.js';
import { MemoryManagement,browseSchema } from '../memory/management.js';
import { MemberManagement } from '../spaces/management.js';
import { SpaceRepository } from '../spaces/repository.js';
import { ImportQueue } from '../transfer/queue.js';
import { OperationsService,quotaSchema } from '../maintenance/service.js';

type Api=(context:Context,write:boolean,handler:(identity:WebIdentity)=>Promise<unknown>)=>Promise<Response>;
const uuid=(c:Context,key='id')=>z.uuid().parse(c.req.param(key));
const page=(c:Context)=>z.coerce.number().int().min(1).max(100000).default(1).parse(c.req.query('page'));
const system=(identity:WebIdentity)=>{if(!identity.isSystemAdmin)throw new Error('System administrator permission is required.');};
export function registerManagementRoutes(app:Hono,database:Database,api:Api,workerEnabled:()=>boolean){
  const agents=new AgentRepository(database);
  app.get('/api/admin/agent-page',c=>api(c,false,i=>agents.page(i.userId,page(c))));
  app.delete('/api/admin/agents/:id/grants/:space',c=>api(c,true,async i=>{await agents.revokeGrant(i.userId,uuid(c),uuid(c,'space'));return {revoked:true};}));
  const memory=new MemoryManagement(database),members=new MemberManagement(database),spaces=new SpaceRepository(database);
  const imports=new ImportQueue(database),operations=new OperationsService(database);
  app.get('/api/admin/library',c=>api(c,false,i=>memory.browse(i.userId,browseSchema.parse(c.req.query()))));
  app.get('/api/admin/library/:id',c=>api(c,false,i=>memory.detail(i.userId,uuid(c))));
  app.get('/api/admin/library/:id/history',c=>api(c,false,i=>memory.history(i.userId,uuid(c),page(c))));
  app.get('/api/admin/library/:id/versions/:version',c=>api(c,false,i=>memory.version(i.userId,uuid(c),z.coerce.number().int().positive().parse(c.req.param('version')))));
  app.post('/api/admin/library/batch',c=>api(c,true,async i=>{
    const b=z.object({space_id:z.uuid(),ids:z.array(z.uuid()).min(1).max(100),action:z.enum(['archive','delete','restore','purge']),version:z.number().int().positive().optional()}).parse(await c.req.json());
    return memory.change(i.userId,b.space_id,b.ids,b.action,b.version);
  }));
  app.get('/api/admin/spaces/:id/member-page',c=>api(c,false,i=>members.list(i.userId,uuid(c),page(c))));
  app.patch('/api/admin/spaces/:id/members/:user',c=>api(c,true,async i=>{
    const b=z.object({role:z.enum(['admin','editor','contributor','viewer','remove','transfer'])}).parse(await c.req.json());
    return members.change(i.userId,uuid(c),uuid(c,'user'),b.role);
  }));
  app.get('/api/admin/spaces/:id/invitations',c=>api(c,false,i=>members.invitations(i.userId,uuid(c))));
  app.delete('/api/admin/spaces/:id/invitations/:invitation',c=>api(c,true,i=>members.revoke(i.userId,uuid(c),uuid(c,'invitation'))));
  app.post('/api/admin/invitations/accept',c=>api(c,true,async i=>{
    const b=z.object({token:z.string().min(20).max(200)}).parse(await c.req.json());
    if(!i.verifiedEmail)throw new Error('Sign in again with an OIDC-verified email to accept an email invitation. Local profile email is not proof of ownership.');
    return spaces.accept(i.userId,i.verifiedEmail,b.token);
  }));
  const input=z.object({space_id:z.uuid(),format:z.enum(['json','markdown']),content:z.string().min(1).max(5000000),duplicates:z.enum(['skip','keep']).default('skip')});
  app.post('/api/admin/import-queue/preview',c=>api(c,true,async i=>{const b=input.parse(await c.req.json());return imports.preview(i.userId,b.space_id,b.format,b.content);}));
  app.post('/api/admin/import-queue',c=>api(c,true,async i=>{
    if(!workerEnabled())throw new Error('Background worker is disabled. Enable it before queuing an import.');
    const b=input.parse(await c.req.json());return imports.enqueue(i.userId,b.space_id,b.format,b.content,b.duplicates);
  }));
  app.get('/api/admin/import-queue/:id/items',c=>api(c,false,i=>imports.details(i.userId,uuid(c))));
  app.get('/api/admin/spaces/:id/usage',c=>api(c,false,i=>operations.space(i.userId,uuid(c))));
  app.put('/api/admin/spaces/:id/quota',c=>api(c,true,async i=>{
    system(i);return operations.quota(i.userId,uuid(c),quotaSchema.parse(await c.req.json()));
  }));
  app.get('/api/admin/operations',c=>api(c,false,async i=>{system(i);return operations.system();}));
  app.post('/api/admin/operations/cleanup',c=>api(c,true,async i=>{
    system(i);const b=z.object({days:z.number().int().min(30).max(3650),confirm:z.literal('DELETE_EXPIRED_RECORDS')}).parse(await c.req.json());return operations.cleanup(b.days);
  }));
}
