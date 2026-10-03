-- Canonical local usernames: never silently merge pre-existing collisions.
DO $$ BEGIN
  IF EXISTS (SELECT lower(username) FROM local_credentials GROUP BY lower(username) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Case-insensitive local username collision; resolve duplicate credentials before upgrading';
  END IF;
END $$;
UPDATE local_credentials SET username=lower(username);
ALTER TABLE local_credentials ADD CONSTRAINT local_username_canonical CHECK (username=lower(username));
ALTER TABLE local_credentials ADD COLUMN credential_version uuid NOT NULL DEFAULT gen_random_uuid();

-- Bind local sessions to the password version. Existing local sessions must reauthenticate.
ALTER TABLE web_sessions ADD COLUMN local_credential_version uuid;
UPDATE web_sessions SET revoked_at=now() WHERE auth_source='local' AND revoked_at IS NULL;
CREATE INDEX web_sessions_active_user_idx ON web_sessions(user_id,created_at DESC) WHERE revoked_at IS NULL;
