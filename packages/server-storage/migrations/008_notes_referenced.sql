-- 008_notes_referenced.sql — explicit "actually used" journal for notes.
--
-- Distinct from access_count/last_accessed (001_notes.sql), which bump on
-- every retrieval regardless of relevance. referenced_count/last_referenced
-- bump only when a note is named in a synaipse_log_session `references`
-- list — i.e. Claude said this note was actually used for the session's
-- outcome, not merely retrieved.

ALTER TABLE notes
    ADD COLUMN IF NOT EXISTS referenced_count INT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_referenced  BIGINT NULL;
