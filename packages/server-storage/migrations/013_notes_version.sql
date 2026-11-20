-- 013_notes_version.sql — vault version of a note's last write (plan A6).
--
-- Lets a process tell its own writes from foreign ones when it applies the
-- change log. 0 = written before versioning existed.

ALTER TABLE notes ADD COLUMN IF NOT EXISTS version BIGINT UNSIGNED NOT NULL DEFAULT 0;
