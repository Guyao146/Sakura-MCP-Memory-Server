-- Local (username + password) accounts, so the admin UI can be used without an
-- external OIDC provider like Authentik.
--
-- The credential row is keyed by the user it authenticates: users.oidc_subject
-- holds `local:<username>` for these accounts, and one user may have at most
-- one local password. Passwords are never stored in plaintext: the column
-- holds a PHC-style scrypt record (`scrypt$N$r$p$salt$hash`) verified in Node.
--
-- `failed_attempts` / `locked_until` implement a server-side lockout so a
-- brute-force attempt cannot farm the per-IP rate limit by rotating addresses.
-- `locked_until` defaults to now() so a fresh account is never locked.
CREATE TABLE local_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username text NOT NULL UNIQUE CHECK (char_length(username) BETWEEN 3 AND 60
    AND username ~ '^[A-Za-z0-9._-]+$'),
  password_hash text NOT NULL,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Which method created a web session, so logout and audit records report the
-- real source instead of assuming Authentik. Pre-existing rows keep 'authentik'.
ALTER TABLE web_sessions
  ADD COLUMN auth_source text NOT NULL DEFAULT 'authentik'
    CHECK (auth_source IN ('authentik', 'local'));
