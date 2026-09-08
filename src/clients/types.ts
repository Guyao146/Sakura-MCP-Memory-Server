import { createHash } from 'node:crypto';
import type { Database } from '../database.js';

/**
 * Tracks MCP client connections for the management console.
 *
 * The Streamable HTTP transport is stateless: every exchange is its own HTTP
 * request and no socket is held open, so "connected" cannot be observed
 * directly. Instead each request touches a row keyed by the caller identity plus
 * the client name it reported at `initialize`, and the status is derived:
 *
 * - `uploading` — at least one tool call is in flight
 * - `connected` — seen within the liveness window
 * - `idle`      — seen recently but past the liveness window
 * - `disconnected` — explicitly closed, or silent past the stale window
 *
 * Counters are incremented in the same statement as `last_seen_at` so a burst of
 * concurrent calls cannot lose updates.
 */

/** A client is considered live if seen within this many seconds. */
export const LIVE_WINDOW_SECONDS = 90;
/** Past this many seconds of silence a client is reported as disconnected. */
export const STALE_WINDOW_SECONDS = 15 * 60;

export type ClientStatus = 'uploading' | 'connected' | 'idle' | 'disconnected';

export interface ClientSessionRow {
  id: string;
  client_name: string;
  client_version: string | null;
  protocol_version: string | null;
  auth_source: string;
  agent_id: string | null;
  agent_name: string | null;
  remote_address: string | null;
  connected_at: string;
  last_seen_at: string;
  disconnected_at: string | null;
  active_operations: number;
  last_activity: string | null;
  request_count: string;
  write_calls: string;
  error_count: string;
}

export interface ClientSessionView extends Omit<ClientSessionRow, 'request_count' | 'write_calls' | 'error_count'> {
  status: ClientStatus;
  requestCount: number;
  writeCalls: number;
  errorCount: number;
}

export interface ClientIdentity {
  userId: string;
  agentId?: string;
  authSource: string;
  clientName: string;
  clientVersion?: string;
  protocolVersion?: string;
  remoteAddress?: string;
}

/**
 * Stable identity for a logical client. Hashed so that a client name chosen by a
 * remote caller can never collide with, or impersonate, another user's row.
 */
export function clientKey(identity: ClientIdentity): string {
  return createHash('sha256')
    .update(`${identity.userId}\u0000${identity.agentId ?? ''}\u0000${identity.clientName}`)
    .digest('hex');
}

export function deriveStatus(row: Pick<ClientSessionRow, 'active_operations' | 'last_seen_at' | 'disconnected_at'>,
  now = Date.now()): ClientStatus {
  if (row.disconnected_at) return 'disconnected';
  const silentSeconds = (now - new Date(row.last_seen_at).getTime()) / 1000;
  if (silentSeconds > STALE_WINDOW_SECONDS) return 'disconnected';
  if (row.active_operations > 0) return 'uploading';
  return silentSeconds <= LIVE_WINDOW_SECONDS ? 'connected' : 'idle';
}

export function toClientView(row: ClientSessionRow, now = Date.now()): ClientSessionView {
  const { request_count, write_calls, error_count, ...rest } = row;
  return {
    ...rest,
    status: deriveStatus(row, now),
    requestCount: Number(request_count),
    writeCalls: Number(write_calls),
    errorCount: Number(error_count)
  };
}
