-- 005_accounts.sql — Web-UI login accounts (server-mode only).
--
-- Establishes the "real user" concept: a human who logs into the Web-UI
-- with email + password. Separate from the existing `users` table, which
-- despite its name holds MCP bearer tokens (1 row = 1 token, see
-- 003_users.sql). The legacy name stays for now because the migration
-- churn of renaming `users` → `tokens` is not worth the semantic win at
-- this stage; the distinction is clear from the presence of `accounts`.
--
-- Backlog #16, Slice 16a — foundation only. No session layer, no
-- HTTP-Endpoint, no UI yet. The Bootstrap-CLI (`npm run admin bootstrap`)
-- creates the first admin row directly; subsequent admins go through the
-- UI in Slice 16d.
--
-- Password hashing reuses scrypt from packages/core/src/TokenHash.ts so we
-- don't pull in bcrypt/argon2 as a dependency. Same cost params, same
-- {hash, salt} pair as MCP tokens — see `packages/core/src/PasswordHash.ts`.

CREATE TABLE IF NOT EXISTS accounts (
    id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    vault_id        BIGINT UNSIGNED NOT NULL DEFAULT 1,
    email           VARCHAR(255) NOT NULL,
    password_hash   CHAR(128) NOT NULL,
    password_salt   CHAR(32) NOT NULL,
    is_admin        TINYINT(1) NOT NULL DEFAULT 0,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at   TIMESTAMP NULL,
    disabled_at     TIMESTAMP NULL,
    UNIQUE KEY uk_vault_email (vault_id, email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;