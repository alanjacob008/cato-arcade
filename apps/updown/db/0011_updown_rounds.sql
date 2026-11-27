-- Up Down (the Up / Down game) round journal. One row per round.
--
-- Orderly is the source of truth for fills, fees, balances and transfers; none of
-- that is copied here. This table holds only what Orderly cannot derive: that two
-- orders were one "round", the player's call and chosen duration, the lifecycle
-- and reconciliation state, and the single net result the player is shown.
--
-- Hot query columns are real columns. Everything else about the round (close
-- attempts, extensions, fees, errors, verification snapshot) lives in `data`,
-- which is the full public round object the worker already journals, written
-- whole on every state change. `credential` is the round's delegated trading key
-- sealed with AES-256-GCM under the worker's journal key (UPDOWN_JOURNAL_KEY);
-- it is NULL once the round no longer needs it. A database leak alone does not
-- reveal keys.

CREATE TABLE IF NOT EXISTS updown_rounds (
    id           TEXT PRIMARY KEY,                       -- client-generated; retries are idempotent
    network      TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet')),
    account_id   TEXT NOT NULL,                          -- Orderly account id (0x…)
    symbol       TEXT NOT NULL,                          -- e.g. PERP_SOL_USDC
    direction    TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN')),
    status       TEXT NOT NULL CHECK (status IN ('preparing', 'opening', 'open', 'closing', 'closed', 'ended_early', 'failed')),
    margin       NUMERIC NOT NULL CHECK (margin > 0),    -- the bet, USDC
    leverage     INTEGER NOT NULL CHECK (leverage >= 1),
    duration_s   INTEGER NOT NULL CHECK (duration_s > 0),-- base duration plus accepted extensions
    trading_pnl  NUMERIC,                                -- the one result shown to the player, net of fees; NULL until verified
    created_at   TIMESTAMPTZ NOT NULL,
    opened_at    TIMESTAMPTZ,                            -- opening fill time
    closed_at    TIMESTAMPTZ,
    data         JSONB NOT NULL,                         -- full public round; never contains the credential
    credential   BYTEA,                                  -- iv(12) | tag(16) | ciphertext, AES-256-GCM
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "My rounds", newest first.
CREATE INDEX IF NOT EXISTS updown_rounds_account_idx
    ON updown_rounds (network, account_id, created_at DESC);

-- One active round per account, enforced by the database and not only by the worker.
CREATE UNIQUE INDEX IF NOT EXISTS updown_rounds_one_active_idx
    ON updown_rounds (network, account_id)
    WHERE status NOT IN ('closed', 'ended_early', 'failed');

-- Completed rounds by time, for stats and a future leaderboard.
CREATE INDEX IF NOT EXISTS updown_rounds_closed_idx
    ON updown_rounds (network, closed_at DESC)
    WHERE status = 'closed';
