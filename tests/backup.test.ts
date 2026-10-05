import { describe,it,expect } from 'vitest';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Operational scripts intentionally run directly in Node.
import { digest,verify,connectionEnv,main } from '../scripts/backup.mjs';

describe('offline backup safety',()=>{
  it('verifies files and rejects tampering and path traversal',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'sakura-backup-test-'));
    try {
      const file=join(dir,'database.dump');await writeFile(file,'fixture');
      const manifest={schema:'sakura-database-backup/v1',file:'database.dump',bytes:7,sha256:await digest(file)};
      await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
      await expect(verify(dir)).resolves.toMatchObject({manifest});
      await writeFile(file,'changed');await expect(verify(dir)).rejects.toThrow('checksum');
      await writeFile(join(dir,'manifest.json'),JSON.stringify({...manifest,file:'../database.dump'}));
      await expect(verify(dir)).rejects.toThrow('Invalid backup manifest');
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('uses environment credentials and requires a recognized operation',async()=>{
    expect(connectionEnv('postgresql://user:p%40ss@localhost:5433/db?sslmode=require')).toMatchObject({PGUSER:'user',PGPASSWORD:'p@ss',PGPORT:'5433',PGDATABASE:'db',PGSSLMODE:'require'});
    expect(()=>connectionEnv('https://example.com')).toThrow('PostgreSQL');
    await expect(main(['drop','unused'])).rejects.toThrow('Usage');
  });
});
