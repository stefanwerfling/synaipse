-- 007_schedules.sql — persistent job schedules for SYNAIPSE_MODE=server.
--
-- Server-mode counterpart to LocalScheduleStore's JSON sidecar. Same
-- shape as the Schedule interface in @synaipse/core/Adapter.ts:
-- opaque jobType + jobParams strings (the runner in
-- packages/web/server/scheduler.ts casts them at fire-time), a small
-- cron grammar ("every Nh" | "daily HH:MM"), plus runtime state
-- (last_run, last_result, next_run) that the scheduler advances after
-- every tick.
--
-- id is a client-side UUID (mirror of LocalScheduleStore.create()) so a
-- future admin export/import doesn't renumber rows. vault_id follows
-- the same multi-vault sharding pattern as users/accounts.

CREATE TABLE IF NOT EXISTS schedules (
    id             CHAR(36) NOT NULL,
    vault_id       BIGINT UNSIGNED NOT NULL DEFAULT 1,
    name           VARCHAR(255) NOT NULL,
    job_type       VARCHAR(64) NOT NULL,
    job_params     JSON NOT NULL,
    cron_spec      VARCHAR(64) NOT NULL,
    enabled        TINYINT(1) NOT NULL DEFAULT 1,
    created_at     BIGINT NOT NULL,
    last_run       BIGINT NULL,
    last_result    VARCHAR(16) NULL,
    next_run       BIGINT NULL,
    PRIMARY KEY (id),
    KEY ix_vault_created (vault_id, created_at),
    KEY ix_vault_next_run (vault_id, next_run)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;