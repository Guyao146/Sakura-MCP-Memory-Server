ALTER TABLE web_sessions ADD COLUMN verified_email text;
-- Serialize quota checks with all writes to a space; defaults preserve existing deployments.
ALTER TABLE spaces ADD COLUMN max_memories integer CHECK (max_memories > 0),
  ADD COLUMN max_content_bytes bigint CHECK (max_content_bytes > 0),
  ADD COLUMN max_provider_calls_daily integer CHECK (max_provider_calls_daily > 0),
  ADD COLUMN memory_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN content_bytes bigint NOT NULL DEFAULT 0;
UPDATE spaces s SET memory_count=(SELECT count(*) FROM memories m WHERE m.space_id=s.id AND m.deleted_at IS NULL),
  content_bytes=(SELECT coalesce(sum(octet_length(content)),0) FROM memories m WHERE m.space_id=s.id AND m.deleted_at IS NULL);
CREATE TABLE provider_usage (
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  day date NOT NULL DEFAULT CURRENT_DATE,
  calls integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  duration_ms bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(space_id, day)
);
CREATE FUNCTION enforce_memory_quota() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE count_delta bigint; bytes_delta bigint; target uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    target=OLD.space_id;
    count_delta=CASE WHEN OLD.deleted_at IS NULL THEN -1 ELSE 0 END;
    bytes_delta=CASE WHEN OLD.deleted_at IS NULL THEN -octet_length(OLD.content) ELSE 0 END;
  ELSIF TG_OP='INSERT' THEN
    target=NEW.space_id;
    count_delta=CASE WHEN NEW.deleted_at IS NULL THEN 1 ELSE 0 END;
    bytes_delta=CASE WHEN NEW.deleted_at IS NULL THEN octet_length(NEW.content) ELSE 0 END;
  ELSE
    IF NEW.space_id<>OLD.space_id THEN RAISE EXCEPTION 'Moving memories across spaces is unsupported'; END IF;
    target=NEW.space_id;
    count_delta=(CASE WHEN NEW.deleted_at IS NULL THEN 1 ELSE 0 END)-(CASE WHEN OLD.deleted_at IS NULL THEN 1 ELSE 0 END);
    bytes_delta=(CASE WHEN NEW.deleted_at IS NULL THEN octet_length(NEW.content) ELSE 0 END)-(CASE WHEN OLD.deleted_at IS NULL THEN octet_length(OLD.content) ELSE 0 END);
  END IF;
  -- Atomic increments, not COUNT under a stale MVCC snapshot: concurrent writers cannot exceed limits.
  UPDATE spaces SET memory_count=memory_count+count_delta,content_bytes=content_bytes+bytes_delta WHERE id=target
    AND (count_delta<=0 OR max_memories IS NULL OR memory_count+count_delta<=max_memories)
    AND (bytes_delta<=0 OR max_content_bytes IS NULL OR content_bytes+bytes_delta<=max_content_bytes);
  IF NOT FOUND AND EXISTS(SELECT 1 FROM spaces WHERE id=target) THEN RAISE EXCEPTION 'Space memory or content byte quota exceeded'; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER memories_quota AFTER INSERT OR DELETE OR UPDATE OF content,deleted_at,space_id ON memories
  FOR EACH ROW EXECUTE FUNCTION enforce_memory_quota();
CREATE INDEX memories_export_cursor_idx ON memories(space_id,created_at,id) WHERE deleted_at IS NULL;
CREATE INDEX memories_trash_idx ON memories(space_id,deleted_at,id) WHERE deleted_at IS NOT NULL;
CREATE TABLE import_items (
  job_id uuid NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  position integer NOT NULL,
  record jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed','skipped')),
  memory_id uuid REFERENCES memories(id) ON DELETE SET NULL,
  error text,
  PRIMARY KEY(job_id,position)
);
ALTER TABLE space_invitations ADD COLUMN revoked_at timestamptz;
-- Legacy synchronous imports cannot be replayed: they did not persist their payload.
UPDATE ingestion_jobs SET status='failed',error='Legacy import interrupted; submit the original file again.',updated_at=now()
  WHERE job_type='memory_import' AND status IN ('pending','processing');
