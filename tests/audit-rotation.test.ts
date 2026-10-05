import { describe,it,expect } from 'vitest';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLogger } from '../src/audit.js';

describe('audit rotation',()=>{
  it('rotates at 10 MiB without losing concurrent new records',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'sakura-audit-rotation-'));
    try{
      const path=join(dir,'audit.jsonl');await writeFile(path,'x'.repeat(10*1024*1024));
      const audit=new AuditLogger(path);
      await Promise.all([1,2,3].map(n=>audit.record({action:'test.'+n,result:'success'})));
      expect((await readFile(path+'.1','utf8')).length).toBe(10*1024*1024);
      const lines=(await readFile(path,'utf8')).trim().split('\n').map(x=>JSON.parse(x));
      expect(lines.map(x=>x.action)).toEqual(['test.1','test.2','test.3']);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
});
