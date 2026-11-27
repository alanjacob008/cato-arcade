-- Up Down on serverless functions: many short-lived invocations (players' polls
-- and the once-a-minute cron sweep) share the round journal instead of one
-- long-running worker holding it in memory.
--
-- `version` makes every journal write a compare-and-set: an invocation only
-- persists a state change (and only then sends an order) if nobody changed the
-- round since it read it. Two invocations can never both record and send the
-- same close.
--
-- `updown_locks` holds short leases ("round:<id>", "account:<network>:<id>",
-- "sweep") so normally one invocation works on a round at a time and others skip
-- it. A lease expires if its holder dies. Leases are rows rather than advisory
-- locks because session advisory locks do not survive transaction-mode connection
-- pooling (Neon's pooled DATABASE_URL), and orders must be sent outside any
-- transaction so their intent is committed first.

ALTER TABLE updown_rounds ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS updown_locks (
    name        TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL
);
