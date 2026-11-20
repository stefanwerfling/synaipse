-- 012_note_changes.sql — change log behind vault_versions (plan A6).
--
-- One row per version: which note was written or deleted. Pruned after a
-- day; a process that falls further behind sees a gap and reloads fully.

CREATE TABLE IF NOT EXISTS note_changes (
    vault_id   BIGINT UNSIGNED NOT NULL,
    version    BIGINT UNSIGNED NOT NULL,
    note_path  VARCHAR(1024) NOT NULL,
    op         ENUM('write', 'delete') NOT NULL,
    changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (vault_id, version),
    KEY ix_changed_at (changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
