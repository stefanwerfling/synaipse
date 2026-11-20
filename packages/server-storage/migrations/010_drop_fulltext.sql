-- 010_drop_fulltext.sql — remove the unused FULLTEXT index (plan A6).
--
-- Nothing ever queried ft_title_body: search runs on the service's
-- in-memory BM25 index in both storage modes (same tokenizer, scoring and
-- scope filters as local mode, which MariaDB's FULLTEXT cannot match).
-- The index only cost write time and space on every note write.
-- Fresh installs no longer create it (001_notes.sql).

ALTER TABLE notes DROP INDEX IF EXISTS ft_title_body;
