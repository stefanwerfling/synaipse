-- 002_chats.sql — chat-session storage for MariaDBChatAdapter.
--
-- ChatSession.createdAt/updatedAt are typed as ISO-8601 strings; we
-- keep them verbatim in VARCHAR columns rather than TIMESTAMP so the
-- payload round-trips without precision conversion. ISO-8601 sorts
-- lexically, so the (vault_id, updated_at_iso) index still serves the
-- "most-recent-first" list query.
--
-- payload holds the full ChatSession (turns + sources) as JSON; the
-- surface columns (title, last_model, turn_count, …) duplicate fields
-- from payload so list() can build summaries without parsing every row.

CREATE TABLE IF NOT EXISTS chat_sessions (
    id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    vault_id        BIGINT UNSIGNED NOT NULL DEFAULT 1,
    session_id      VARCHAR(255) NOT NULL,
    title           VARCHAR(512) NOT NULL DEFAULT '',
    last_model      VARCHAR(128) NULL,
    created_at_iso  VARCHAR(64) NOT NULL,
    updated_at_iso  VARCHAR(64) NOT NULL,
    turn_count      INT UNSIGNED NOT NULL DEFAULT 0,
    payload         JSON NOT NULL,
    UNIQUE KEY uk_vault_session (vault_id, session_id),
    KEY k_vault_updated (vault_id, updated_at_iso)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;