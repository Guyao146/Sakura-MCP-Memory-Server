-- Serialize embedding writes with content updates and invalidate all derived vectors.
ALTER TABLE memories ADD COLUMN embedding_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE memory_embeddings ADD COLUMN request_id uuid;

CREATE FUNCTION bump_memory_embedding_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.content,NEW.summary,NEW.tags) IS DISTINCT FROM (OLD.content,OLD.summary,OLD.tags) THEN
    NEW.embedding_revision := OLD.embedding_revision + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memory_embedding_revision BEFORE UPDATE ON memories
FOR EACH ROW EXECUTE FUNCTION bump_memory_embedding_revision();

CREATE FUNCTION invalidate_memory_embedding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.embedding_revision <> OLD.embedding_revision THEN
    DELETE FROM memory_embeddings WHERE memory_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memory_embedding_invalidation AFTER UPDATE ON memories
FOR EACH ROW EXECUTE FUNCTION invalidate_memory_embedding();
