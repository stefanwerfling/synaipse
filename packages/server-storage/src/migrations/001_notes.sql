-- 001_notes.sql — initial schema for the MariaDBNoteAdapter.
--
-- Scope of this migration: the notes table only. Chat sessions, users,
-- tokens, acl_rules, note_vectors, and pending_commits follow in later
-- migrations as the matching Phase-2/3/4 adapters land
-- (see Memory/synaipse/decisions/2026-06-23-server-mode-architecture.md).
--
-- The id column is BIGINT so future ACL tables can join cheaply; the
-- adapter exposes only the string NoteId (vault-relative path) at the
-- port boundary, so callers never see the surrogate key.

CREATE TABLE IF NOT EXISTS notes (
    id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    vault_id      BIGINT UNSIGNED NOT NULL DEFAULT 1,
    note_path     VARCHAR(1024) NOT NULL,
    title         VARCHAR(512) NOT NULL DEFAULT '',
    frontmatter   JSON NOT NULL,
    body          MEDIUMTEXT NOT NULL,
    hash          CHAR(40) NOT NULL,
    mtime_ms      BIGINT NOT NULL,
    access_count  INT UNSIGNED NOT NULL DEFAULT 0,
    last_accessed BIGINT NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_vault_path (vault_id, note_path(700)),
    -- MariaDB's built-in FULLTEXT works for whitespace-separated languages.
    -- Multilingual / CJK support comes later: either Mroonga storage engine
    -- (ALTER TABLE ENGINE=Mroonga) or an external FTS layer. MySQL's
    -- `WITH PARSER ngram` is not portable to MariaDB.
    FULLTEXT KEY ft_title_body (title, body)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;