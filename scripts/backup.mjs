import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir,readFile,writeFile,stat,chmod } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';

export async function digest(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export function connectionEnv(value){
  const url=new URL(value);
  if(!['postgres:','postgresql:'].includes(url.protocol))throw Error('DATABASE_URL must be PostgreSQL.');
  const ssl={sslmode:'PGSSLMODE',sslrootcert:'PGSSLROOTCERT',sslcert:'PGSSLCERT',sslkey:'PGSSLKEY',sslcrl:'PGSSLCRL',connect_timeout:'PGCONNECT_TIMEOUT'};
  const options={};
  for(const [key,item] of url.searchParams){if(!(key in ssl))throw Error('Unsupported database URL option for backup: '+key);options[ssl[key]]=item;}
  return {...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:decodeURIComponent(url.pathname.slice(1)),...options};
}
async function run(command,args,env){await new Promise((done,fail)=>{const child=spawn(command,args,{env,stdio:['ignore','ignore','pipe'],shell:false});let error='';child.stderr.on('data',b=>{error=(error+b.toString()).slice(-2000);});child.on('error',fail);child.on('exit',code=>code===0?done():fail(Error(command+' failed ('+code+'). Check PostgreSQL client/server compatibility and credentials.')));});}
export async function verify(directory){
  const folder=resolve(directory),manifest=JSON.parse(await readFile(join(folder,'manifest.json'),'utf8'));
  if(manifest.schema!=='sakura-database-backup/v1'||manifest.file!=='database.dump'||!(/^[a-f0-9]{64}$/).test(manifest.sha256))throw Error('Invalid backup manifest.');
  const file=join(folder,'database.dump');
  if((await stat(file)).size!==manifest.bytes||await digest(file)!==manifest.sha256)throw Error('Backup checksum or size mismatch.');
  return {folder,file,manifest};
}
export async function main(args){
  const [command,directory,confirmation]=args;
  if(!['create','verify','restore'].includes(command)||!directory)throw Error('Usage: node scripts/backup.mjs create|verify|restore ABSOLUTE_BACKUP_DIR [RESTORE_INTO_EMPTY_DATABASE]. DATABASE_URL is required for create/restore; use PG_DUMP/PG_RESTORE for executable paths.');
  if(command==='verify'){const b=await verify(directory);console.log(JSON.stringify(b.manifest,null,2));return;}
  if(!process.env.DATABASE_URL)throw Error('Set DATABASE_URL without printing it or putting it in command arguments.');
  const env=connectionEnv(process.env.DATABASE_URL);
  if(command==='create'){
    const folder=resolve(directory);await mkdir(folder,{recursive:false,mode:0o700});
    const file=join(folder,'database.dump');
    const files=await import('node:fs/promises');
    const output=await files.open(file,'wx',0o600);await output.close();
    await run(process.env.PG_DUMP||'pg_dump',['--no-password','--format=custom','--no-owner','--no-acl','--file',file],env);
    await chmod(file,0o600);
    const manifest={schema:'sakura-database-backup/v1',createdAt:new Date().toISOString(),file:'database.dump',bytes:(await stat(file)).size,sha256:await digest(file),keyBackupRequired:true};
    await writeFile(join(folder,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log('Backup created and checksummed. Store CONFIG_ENCRYPTION_KEY, runtime secrets and deployment configuration separately offline. Backup contains private data and is NOT encrypted.');return;
  }
  if(confirmation!=='RESTORE_INTO_EMPTY_DATABASE')throw Error('Explicit RESTORE_INTO_EMPTY_DATABASE confirmation is required.');
  const backup=await verify(directory);
  const client=new pg.Client({connectionString:process.env.DATABASE_URL});
  try {
    await client.connect();
    if(/^pg_|^template[01]$/.test(env.PGDATABASE))throw Error('System database cannot be a restore target.');
    const other=await client.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() LIMIT 1');
    if(other.rowCount)throw Error('Restore refused: target has other database connections.');
    const rows=await client.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f') LIMIT 1`);
    if(rows.rowCount)throw Error('Restore refused: target database is not empty. Use a new isolated database with all application processes stopped.');
  }finally{await client.end();}
  await run(process.env.PG_RESTORE||'pg_restore',['--no-password','--exit-on-error','--single-transaction','--no-owner','--no-acl','--dbname',env.PGDATABASE,backup.file],env);
  console.log('Restore completed. Validate schema/data and restore the original encryption key before starting the app.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
