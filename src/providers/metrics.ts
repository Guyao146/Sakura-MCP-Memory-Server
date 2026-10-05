import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from '../database.js';

export const providerScope = new AsyncLocalStorage<{database:Database;spaceId:string}>();
export const providerMetrics = {calls:0,failures:0,durationMs:0,inFlight:0};
export async function reserveProviderCall() {
  const scope=providerScope.getStore();
  if(!scope) return;
  const client=await scope.database.pool.connect();
  try {
    await client.query('BEGIN');
    const space=await client.query('SELECT max_provider_calls_daily FROM spaces WHERE id=$1 FOR UPDATE',[scope.spaceId]);
    const limit=space.rows[0]?.max_provider_calls_daily;
    const usage=await client.query<{calls:number;day:string}>(`INSERT INTO provider_usage(space_id,calls) VALUES($1,1)
      ON CONFLICT(space_id,day) DO UPDATE SET calls=provider_usage.calls+1 RETURNING calls,day::text`,[scope.spaceId]);
    if(limit!=null&&usage.rows[0].calls>limit) throw new Error('Daily Provider quota exceeded.');
    await client.query('COMMIT');
    return usage.rows[0].day;
  } catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function recordProviderCall(failed: boolean,duration: number,day?:string) {
  const scope=providerScope.getStore();
  if(scope && day) await scope.database.query(`UPDATE provider_usage SET failures=failures+$2,duration_ms=duration_ms+$3
    WHERE space_id=$1 AND day=$4::date`,[scope.spaceId,failed?1:0,duration,day]).catch(()=>undefined);
}
