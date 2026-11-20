-- 011_vault_versions.sql — one change counter per vault (plan A6).
--
-- Every note write/delete bumps it in the same transaction and logs the
-- change in note_changes (012). Other processes sharing the vault poll
-- this single row and reload only what changed. The row lock also gives
-- writes a total order, so a later version never commits before an
-- earlier one (no holes for a poller to miss).

CREATE TABLE IF NOT EXISTS vault_versions (
    vault_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    version  BIGINT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB;
