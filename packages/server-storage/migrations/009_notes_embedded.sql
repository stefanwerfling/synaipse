-- 009_notes_embedded.sql — track what is actually in the vector store.
--
-- `hash` is the content hash of the last write. Until now the service
-- also used it as "already embedded" marker, so in server mode a note
-- whose embed failed (embedder down) or a wiped/fresh Qdrant collection
-- was never repaired: hash always matched itself.
--
-- embedded_hash / embed_model are set only after a successful vector
-- upsert. Existing rows start as NULL on purpose → the next start embeds
-- every note once and from then on only the ones that actually changed.

ALTER TABLE notes
    ADD COLUMN IF NOT EXISTS embedded_hash CHAR(40)     NULL,
    ADD COLUMN IF NOT EXISTS embed_model   VARCHAR(255) NULL;
