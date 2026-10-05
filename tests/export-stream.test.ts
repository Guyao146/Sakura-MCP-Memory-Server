import { describe,it,expect,vi } from 'vitest';
import { streamingExport } from '../src/transfer/stream.js';
import { operationContext } from '../src/operations.js';

describe('streaming downloads',()=>{
  it('streams portable JSON and keeps the exact cursor without accumulating a file',async()=>{
    let pages=0;
    const query=vi.fn(async(sql:string)=>{
      if(sql.includes('SELECT sm.role'))return {rows:[{role:'viewer'}]};
      if(sql.includes('FROM spaces WHERE'))return {rows:[{name:'Space',description:''}]};
      pages++;return {rows:[{id:'memory',content:'hello',summary:'test',type:'fact',tags:[],created_at:'2026-01-01 00:00:00.123456+00'}]};
    });
    const output=await streamingExport({query} as never,'u','s','json');
    const json=await new Response(output.stream).json();
    expect(json.memories).toHaveLength(1);expect(json.truncated).toBe(false);expect(pages).toBe(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('LIMIT $4'),['s',null,null,16]);
  });
  it('aborts an export when its request is cancelled',async()=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('SELECT sm.role')?[{role:'viewer'}]:[{name:'Space'}]}));
    const controller=new AbortController();
    const output=await operationContext.run({signal:controller.signal,pending:new Set()},()=>streamingExport({query} as never,'u','s','json'));
    controller.abort(new Error('cancelled'));
    await expect(new Response(output.stream).text()).rejects.toThrow('cancelled');
  });
});
