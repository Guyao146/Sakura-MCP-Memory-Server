-- External OpenID Connect provider "sakura" (SakuraID / Sakura-Auth-Server),
-- a lightweight OIDC IdP from the same ecosystem. It is a second, independent
-- provider alongside Authentik: both can be configured at once, and the login
-- page offers whichever are present.
--
-- A pending authorization-code transaction remembers which provider started
-- it, so the callback exchanges the code against the right token endpoint and
-- issues a session labelled with the real source. Existing rows predate the
-- column and belong to Authentik, the only provider that existed before.
ALTER TABLE oidc_login_attempts
  ADD COLUMN provider text NOT NULL DEFAULT 'authentik'
    CHECK (provider IN ('authentik', 'sakura'));

-- Web sessions created through the sakura provider. Existing rows keep
-- whatever source they were created with.
ALTER TABLE web_sessions DROP CONSTRAINT IF EXISTS web_sessions_auth_source_check;
ALTER TABLE web_sessions
  ADD CONSTRAINT web_sessions_auth_source_check CHECK (auth_source IN ('authentik', 'local', 'sakura'));
