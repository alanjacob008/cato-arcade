-- Up Down: Orderly account IDs are case-insensitive hex. The round service now
-- stores them lowercase and looks them up by lower(account_id), so "0xAB…" and
-- "0xab…" can never be two accounts (and never two active rounds).
--
-- The expression index serves those lookups. The case-insensitive one-active-
-- round index is created only when no account already has two active rounds
-- that differ by case (it would fail to build); the service enforces the rule
-- either way, under the account lease.

CREATE INDEX IF NOT EXISTS updown_rounds_account_lower_idx
    ON updown_rounds (network, lower(account_id), created_at DESC);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM updown_rounds
        WHERE status NOT IN ('closed', 'ended_early', 'failed')
        GROUP BY network, lower(account_id)
        HAVING count(*) > 1
    ) THEN
        CREATE UNIQUE INDEX IF NOT EXISTS updown_rounds_one_active_lower_idx
            ON updown_rounds (network, lower(account_id))
            WHERE status NOT IN ('closed', 'ended_early', 'failed');
    END IF;
END
$$;
