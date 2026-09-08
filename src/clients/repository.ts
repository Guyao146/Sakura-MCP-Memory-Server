import type { Database } from '../database.js';
import { clientKey, toClientView, type ClientIdentity, type ClientSessionRow, type ClientSessionView } from './types.js';

/**
 * Persistence for MCP client session tracking. See `./types.ts` for how a
 * stateless transport is mapped onto connection status.
 */
export class ClientSessionRepository {
  constructor(private readonly database: Database) {}

  /**
   * Records a request from a client, creating the session row on first sight.
   * `delta` adjusts the in-flight operation count so a long extraction shows as
   * uploading for its whole duration.
   */
  async touch(identity: ClientIdentity, options: {
    activity?: string; delta?: number; isWrite?: boolean; failed?: boolean;
  } = {}): Promise<void> {
    const delta = options.delta ?? 0;
    await this.database.query(
      `INSERT INTO mcp_client_sessions(client_key,user_id,agent_id,auth_source,client_name,client_version,
         protocol_version,remote_address,last_activity,active_operations,request_count,write_calls,error_count)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,GREATEST($10,0),1,$11,$12)
       ON CONFLICT(client_key) DO UPDATE SET
         last_seen_at=now(),
         disconnected_at=NULL,
         agent_id=COALESCE(EXCLUDED.agent_id,mcp_client_sessions.agent_id),
         client_version=COALESCE(EXCLUDED.client_version,mcp_client_sessions.client_version),
         protocol_version=COALESCE(EXCLUDED.protocol_version,mcp_client_sessions.protocol_version),
         remote_address=COALESCE(EXCLUDED.remote_address,mcp_client_sessions.remote_address),
         last_activity=COALESCE(EXCLUDED.last_activity,mcp_client_sessions.last_activity),
         active_operations=GREATEST(mcp_client_sessions.active_operations + $10,0),
         request_count=mcp_client_sessions.request_count + 1,
         write_calls=mcp_client_sessions.write_calls + $11,
         error_count=mcp_client_sessions.error_count + $12`,
      [clientKey(identity), identity.userId, identity.agentId ?? null, identity.authSource, identity.clientName,
        identity.clientVersion ?? null, identity.protocolVersion ?? null, identity.remoteAddress ?? null,
        options.activity ?? null, delta, options.isWrite ? 1 : 0, options.failed ? 1 : 0]);
  }

  /** Releases an in-flight operation without counting another request. */
  async release(identity: ClientIdentity, options: { failed?: boolean } = {}): Promise<void> {
    await this.database.query(
      `UPDATE mcp_client_sessions
       SET active_operations=GREATEST(active_operations-1,0), last_seen_at=now(),
           error_count=error_count + $2
       WHERE client_key=$1`, [clientKey(identity), options.failed ? 1 : 0]);
  }

  /** Marks a client as gone, e.g. when it sends an explicit transport DELETE. */
  async disconnect(identity: ClientIdentity): Promise<void> {
    await this.database.query(
      `UPDATE mcp_client_sessions SET disconnected_at=now(), active_operations=0 WHERE client_key=$1`,
      [clientKey(identity)]);
  }

  /**
   * Lists sessions visible to a user. System administrators see every client;
   * everyone else only sees their own, so one tenant cannot enumerate another's
   * agents.
   */
  async list(userId: string, options: { systemAdmin?: boolean; limit?: number } = {}): Promise<ClientSessionView[]> {
    const result = await this.database.query<ClientSessionRow>(
      `SELECT s.id,s.client_name,s.client_version,s.protocol_version,s.auth_source,s.agent_id,
         ac.name AS agent_name,s.remote_address,s.connected_at,s.last_seen_at,s.disconnected_at,
         s.active_operations,s.last_activity,s.request_count,s.write_calls,s.error_count
       FROM mcp_client_sessions s LEFT JOIN agent_credentials ac ON ac.id=s.agent_id
       WHERE ($1::boolean=true OR s.user_id=$2)
       ORDER BY s.last_seen_at DESC LIMIT $3`,
      [options.systemAdmin ?? false, userId, options.limit ?? 50]);
    return result.rows.map(row => toClientView(row));
  }

  /** Drops rows that have been silent for long enough to be uninteresting. */
  async prune(olderThanDays = 30): Promise<number> {
    const result = await this.database.query(
      `DELETE FROM mcp_client_sessions WHERE last_seen_at < now() - ($1 || ' days')::interval`,
      [olderThanDays]);
    return result.rowCount ?? 0;
  }
}
