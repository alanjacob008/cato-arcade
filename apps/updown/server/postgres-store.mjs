import { randomUUID } from 'node:crypto';
import { createSealer } from './store.mjs';
import { ConflictError, needsTick, normalizeAccountId, publicRound } from './engine.mjs';

const INSERT = `
INSERT INTO updown_rounds
  (id, network, account_id, symbol, direction, status, margin, leverage, duration_s, trading_pnl,
   created_at, opened_at, closed_at, data, credential, updated_at, version)
VALUES
  ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
   to_timestamp($11 / 1000.0), to_timestamp($12 / 1000.0), to_timestamp($13 / 1000.0), $14, $15, now(), 0)`;

// Compare-and-set: the write only lands if nobody else changed the row since
// this invocation read it. A lost race throws ConflictError before any order.
const UPDATE = `
UPDATE updown_rounds SET
  status = $2, duration_s = $3, trading_pnl = $4,
  opened_at = to_timestamp($5 / 1000.0), closed_at = to_timestamp($6 / 1000.0),
  data = $7, credential = $8, updated_at = now(), version = version + 1
WHERE id = $1 AND version = $9
RETURNING version`;

const ACTIVE = `status NOT IN ('closed', 'ended_early', 'failed')`;
const DUE = `(${ACTIVE} OR (credential IS NOT NULL AND data->>'resultPending' = 'true'))`;
// The one-active-round unique indexes (0011, and 0013's case-insensitive one).
const ONE_ACTIVE = ['updown_rounds_one_active_idx', 'updown_rounds_one_active_lower_idx'];
// Account IDs are stored lowercase; lower() also matches rows written before that
// (served by 0013's expression index).
const ACCOUNT = 'lower(account_id)';

// A lease is a row that expires: claimed atomically, released by its owner, and
// reclaimable once expired if its holder died. Unlike session advisory locks it
// works through transaction-mode poolers (Neon's pooled DATABASE_URL), and unlike
// a transaction-scoped lock it needs no connection held open while orders are sent.
const ACQUIRE = `
INSERT INTO updown_locks (name, owner, expires_at)
VALUES ($1, $2, now() + ($3::int * interval '1 millisecond'))
ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
WHERE updown_locks.expires_at <= now()
RETURNING owner`;

const millis = value => (Number.isFinite(value) ? value : null);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The sealed credential column. A round with no work left never keeps one, even
 * if a caller forgot to drop it: terminal rows are credential-free by construction.
 */
const sealedCredential = (round, sealer) => (round.credential && needsTick(round) ? sealer.seal(round.credential) : null);

/** Map a round to INSERT parameters. The credential is sealed, never stored in `data`. */
export function rowParams(round, sealer) {
  const data = publicRound(round);
  return [
    round.id, round.network, round.accountId, round.symbol, round.direction, round.status,
    round.margin, round.leverage, round.duration, Number.isFinite(round.tradingPnl) ? round.tradingPnl : null,
    millis(round.createdAt), millis(round.openedAt), millis(round.closedAt),
    JSON.stringify(data), sealedCredential(round, sealer),
  ];
}

function updateParams(round, sealer, version) {
  return [
    round.id, round.status, round.duration, Number.isFinite(round.tradingPnl) ? round.tradingPnl : null,
    millis(round.openedAt), millis(round.closedAt),
    JSON.stringify(publicRound(round)), sealedCredential(round, sealer), version,
  ];
}

/**
 * Durable, multi-process round store in the website database (tables
 * updown_rounds and updown_locks; db/*.sql). Implements the engine's store
 * contract (engine.mjs) so any number of serverless invocations can share it:
 *
 * - Every save is committed before it resolves, so "intent before send" holds.
 * - Every save is a compare-and-set on the row version: two invocations that
 *   decided from the same state can never both persist (and then send) an order.
 * - withLock() takes database leases, so normally only one invocation works on a
 *   round at a time and the others skip it. Leases expire (leaseMs) if a holder
 *   dies; the compare-and-set still protects against a holder that outlives it.
 *
 * `pool` is a pg.Pool (or anything with query(text, params) -> { rows }).
 */
// leaseMs: a round's lease. Long enough for the slowest tick (a position read, an
// order lookup and an order, each with a 10s timeout, plus journal writes) so a
// live holder is not overtaken; engine.mjs's ORDER_NOT_FOUND_GRACE_MS must exceed it.
export function createPostgresStore({ pool, key, leaseMs = 90000, waitMs = 20000 }) {
  const sealer = createSealer(key);
  const versions = new WeakMap();
  const written = new WeakMap();
  const parse = data => (typeof data === 'string' ? JSON.parse(data) : data);
  const hydrate = row => {
    const round = parse(row.data);
    if (row.credential) round.credential = sealer.open(Buffer.from(row.credential));
    versions.set(round, Number(row.version));
    written.set(round, JSON.stringify(round));
    return round;
  };
  return {
    async get(id) {
      const { rows } = await pool.query('SELECT data, credential, version FROM updown_rounds WHERE id = $1', [id]);
      return rows[0] ? hydrate(rows[0]) : undefined;
    },
    async listAccount(network, accountId) {
      const { rows } = await pool.query(
        `SELECT data FROM updown_rounds WHERE network = $1 AND ${ACCOUNT} = $2 ORDER BY created_at DESC, id DESC LIMIT 1000`,
        [network, normalizeAccountId(accountId)],
      );
      return rows.map(row => parse(row.data));
    },
    async dueIds(network, accountId) {
      const params = [network];
      let sql = `SELECT id FROM updown_rounds WHERE network = $1 AND ${DUE}`;
      if (accountId !== undefined) { params.push(normalizeAccountId(accountId)); sql += ` AND ${ACCOUNT} = $2`; }
      const { rows } = await pool.query(sql + ' ORDER BY created_at', params);
      return rows.map(row => row.id);
    },
    /**
     * Networks with rounds that still have work. The sweep ticks every one of
     * them with that network's Orderly base, so switching VITE_DEPLOYMENT_ENV
     * never strands a live round on the previous network.
     */
    async activeNetworks() {
      const { rows } = await pool.query(`SELECT DISTINCT network FROM updown_rounds WHERE ${DUE}`);
      return rows.map(row => row.network);
    },
    async insert(round) {
      try {
        await pool.query(INSERT, rowParams(round, sealer));
      } catch (error) {
        if (error.code === '23505') {
          throw new Error(ONE_ACTIVE.includes(error.constraint) ? 'Finish the active round before starting another.' : 'Round ID is already in use.');
        }
        throw error;
      }
      versions.set(round, 0);
      written.set(round, JSON.stringify(round));
    },
    async save(round) {
      const serialized = JSON.stringify(round);
      if (written.get(round) === serialized) return;
      if (!versions.has(round)) throw new Error('Round was not loaded from the journal.');
      const { rows } = await pool.query(UPDATE, updateParams(round, sealer, versions.get(round)));
      if (!rows.length) throw new ConflictError();
      versions.set(round, Number(rows[0].version));
      written.set(round, serialized);
    },
    /**
     * Run fn while holding every named lease. Without `wait`, returns
     * { acquired: false } as soon as one is held elsewhere; with it, retries for
     * up to waitMs. Names are taken in sorted order, so waiters cannot deadlock.
     */
    async withLock(names, fn, { wait = false, ttlMs = leaseMs } = {}) {
      const owner = randomUUID();
      const held = [];
      const giveUp = Date.now() + waitMs;
      try {
        for (const name of [...new Set(names)].sort()) {
          for (;;) {
            const { rows } = await pool.query(ACQUIRE, [name, owner, ttlMs]);
            if (rows.length) { held.push(name); break; }
            if (!wait) return { acquired: false };
            if (Date.now() > giveUp) throw new Error('This round is busy. Try again in a moment.');
            await sleep(150);
          }
        }
        return { acquired: true, value: await fn() };
      } finally {
        if (held.length) await pool.query('DELETE FROM updown_locks WHERE name = ANY($1) AND owner = $2', [held, owner]).catch(() => {});
      }
    },
    /** Remove leases whose holders died long ago (they are reclaimable anyway). */
    async pruneLocks() {
      await pool.query(`DELETE FROM updown_locks WHERE expires_at < now() - interval '1 hour'`);
    },
  };
}
