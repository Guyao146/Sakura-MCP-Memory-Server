-- Tracks MCP client connections so the console can show which agents are
-- connected, uploading memories, or gone. The transport is stateless (one HTTP
-- request per exchange), so a "session" is keyed by the caller identity plus the
-- clientInfo it reported at initialize, and liveness is derived from last_seen_at
-- rather than from a held socket.
CREATE TABLE mcp_client_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_key text UNIQUE NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agent_credentials(id) ON DELETE SET NULL,
  auth_source text NOT NULL,
  client_name text NOT NULL,
  client_version text,
  protocol_version text,
  remote_address text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  -- Number of in-flight tool calls; > 0 renders as "uploading".
  active_operations integer NOT NULL DEFAULT 0 CHECK (active_operations >= 0),
  last_activity text,
  request_count bigint NOT NULL DEFAULT 0,
  write_calls bigint NOT NULL DEFAULT 0,
  error_count bigint NOT NULL DEFAULT 0
);

CREATE INDEX mcp_client_sessions_user_idx ON mcp_client_sessions(user_id, last_seen_at DESC);
CREATE INDEX mcp_client_sessions_seen_idx ON mcp_client_sessions(last_seen_at DESC);
