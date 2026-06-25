-- 004_user_expiry.sql — optional passive token expiry.
--
-- Adds expires_at to the users table so tokens can be issued with a
-- predefined lifetime instead of relying solely on manual revoke.
-- NULL = no expiry (backwards compatible with rows from migration 003).
-- findByToken filters with `expires_at IS NULL OR expires_at > NOW()`.
--
-- Status priority in user list: revoked_at > expires_at < NOW() > active.

ALTER TABLE users ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP NULL AFTER revoked_at;