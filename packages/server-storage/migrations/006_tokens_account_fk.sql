-- 006_tokens_account_fk.sql — link MCP tokens to web-UI accounts.
--
-- Adds an optional owner column to the `users` table (which holds MCP
-- bearer tokens; see 003_users.sql for the legacy naming note). NULL
-- means "no human owner" — yaml-imported tokens, admin-created service
-- tokens, and migration 003 rows all stay NULL until somebody re-assigns
-- them explicitly.
--
-- Slice 16c (self-service-tokens UI) will set account_id on every newly
-- created token so the Web-UI can scope token CRUD per account. The
-- ON DELETE SET NULL keeps tokens alive when an account is deleted —
-- operator decides whether to also revoke them; we don't cascade
-- destruction of MCP access from a UI action.

-- One ALTER, two clauses — the migration runner sends each file as a
-- single query (multipleStatements: false), so adjacent statements with
-- their own semicolons would 1064 on parse. Both IF NOT EXISTS clauses
-- keep this idempotent on re-runs.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS account_id BIGINT UNSIGNED NULL AFTER vault_id,
    ADD KEY IF NOT EXISTS ix_account_id (account_id);