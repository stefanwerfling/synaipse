-- 003_users.sql — token-based auth for the MCP HTTP transport.
--
-- Replaces the yaml-configured `config.server.tokens[]` when running in
-- mode=server. Each row carries a scrypt-hashed token plus the ACL scope
-- that was previously inline in yaml: read/write flags, path-prefix
-- restrictions, and an optional tool whitelist. Plain tokens are never
-- stored — `npm run user create` prints the token once on stdout and only
-- the hash + salt land in this table.
--
-- The `label` column doubles as a human-readable handle and the unique
-- key for `npm run user revoke --label=...`.
--
-- token_hint stores the first 8 chars of the plain token so audit/list
-- output can show *which* token without exposing the secret.

CREATE TABLE IF NOT EXISTS users (
    id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    vault_id       BIGINT UNSIGNED NOT NULL DEFAULT 1,
    label          VARCHAR(255) NOT NULL,
    token_hash     CHAR(128) NOT NULL,
    token_salt     CHAR(32) NOT NULL,
    token_hint     CHAR(8) NOT NULL,
    can_read       TINYINT(1) NOT NULL DEFAULT 1,
    can_write      TINYINT(1) NOT NULL DEFAULT 0,
    path_prefixes  JSON NOT NULL,
    tools          JSON NOT NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at   TIMESTAMP NULL,
    revoked_at     TIMESTAMP NULL,
    UNIQUE KEY uk_vault_label (vault_id, label),
    KEY ix_hint (token_hint)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;