import { Pool } from "pg";
import { createHash } from "node:crypto";

/** All statements in a transaction use its checked-out connection. */
export function postgresStore(connectionString) {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw Error("invalid_claw_database_url");
  if(url.hostname.includes("-pooler.")||url.port==="6543"||url.searchParams.get("pgbouncer")==="true")throw Error("claw_coordinator_requires_direct_database_connection");
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
    && !["require", "verify-full", "verify-ca"].includes(url.searchParams.get("sslmode"))) throw Error("claw_database_tls_required");
  // query_timeout bounds every pooled query so a hung connection cannot stall signer-state saves indefinitely.
  const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, query_timeout: 30000 });
  // Do not print provider URLs, passwords or database messages to public logs.
  pool.on("error", () => {});
  let lease;
  return {
    query: (sql, values = []) => pool.query(sql, values),
    async transaction(work) {
      const client = await pool.connect();
      try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
    async acquireCoordinator(program, onLost) {
      if (lease) throw Error("claw_coordinator_already_acquired");
      const bytes = createHash("sha256").update("cato-devnet-vrf:" + program).digest();
      const client = await pool.connect();
      const result = await client.query("SELECT pg_try_advisory_lock($1::integer,$2::integer) AS locked", [bytes.readInt32LE(0), bytes.readInt32LE(4)]);
      if (!result.rows[0].locked) { client.release(); throw Error("claw_coordinator_in_use"); }
      lease = client; client.on("error", () => onLost?.());
      // The dedicated session must stay connected for the lifetime of the signer runtime.
      const heartbeat = setInterval(() => { pingWithin(() => client.query("SELECT 1"), 10000).catch(() => onLost?.()); }, 15000).unref();
      return () => { clearInterval(heartbeat); client.release(true); lease = null; };
    },
    async close() { if (lease) { lease.release(true); lease = null; } await pool.end(); },
  };
}

/** Resolves when the ping answers within timeoutMs; a half-open connection that never answers rejects. */
export function pingWithin(query, timeoutMs) {
  let timer;
  return Promise.race([Promise.resolve().then(query), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("claw_coordinator_heartbeat_timeout")), timeoutMs); })])
    .finally(() => clearTimeout(timer));
}

/** Retries only "lock held by another instance" for up to waitMs (rollout overlap); never proceeds without the lock. */
export async function acquireCoordinatorWithin(store, program, onLost, { waitMs = 0, intervalMs = 2000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const deadline = now() + waitMs;
  for (;;) {
    try { return await store.acquireCoordinator(program, onLost); }
    catch (error) { if (error?.message !== "claw_coordinator_in_use" || now() >= deadline) throw error; }
    await sleep(intervalMs);
  }
}

export const CLAW_SCHEMA = `
CREATE TABLE IF NOT EXISTS claw_players (
 namespace text NOT NULL, wallet text NOT NULL, state jsonb NOT NULL,
 PRIMARY KEY(namespace,wallet));
CREATE TABLE IF NOT EXISTS claw_challenges (
 namespace text NOT NULL, id text NOT NULL, wallet text NOT NULL, message text NOT NULL,
 expires bigint NOT NULL, used boolean NOT NULL DEFAULT false, PRIMARY KEY(namespace,id));
CREATE TABLE IF NOT EXISTS claw_sessions (
 namespace text NOT NULL, hash text NOT NULL, wallet text NOT NULL, expires bigint NOT NULL,
 start_entry bigint NOT NULL, PRIMARY KEY(namespace,hash));
CREATE TABLE IF NOT EXISTS claw_attempts (
 namespace text NOT NULL, id text NOT NULL, wallet text NOT NULL, request_id text NOT NULL,
 fingerprint text NOT NULL, pull jsonb NOT NULL, result jsonb, error text,
 PRIMARY KEY(namespace,id), UNIQUE(namespace,wallet,request_id),
 FOREIGN KEY(namespace,wallet) REFERENCES claw_players(namespace,wallet));
CREATE TABLE IF NOT EXISTS claw_entries (
 seq bigserial UNIQUE, namespace text NOT NULL, id text NOT NULL, wallet text NOT NULL,
 kind text NOT NULL, tier integer, quantity integer NOT NULL DEFAULT 0,
 cents bigint NOT NULL CHECK(cents>=0 AND cents<=1000000000000), created bigint NOT NULL,
 PRIMARY KEY(namespace,id), FOREIGN KEY(namespace,wallet) REFERENCES claw_players(namespace,wallet));
CREATE INDEX IF NOT EXISTS claw_entries_wallet ON claw_entries(namespace,wallet,seq);
CREATE TABLE IF NOT EXISTS claw_faucets (
 namespace text NOT NULL, wallet text NOT NULL, day text NOT NULL, quantity integer NOT NULL,
 PRIMARY KEY(namespace,wallet,day));
CREATE TABLE IF NOT EXISTS claw_purchases (
 namespace text NOT NULL, id text NOT NULL, wallet text NOT NULL, request_id text NOT NULL,
 tier integer NOT NULL, quantity integer NOT NULL, cents bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('quoted','submitted','credited')),
 wire jsonb, receipt jsonb, created bigint NOT NULL,
 PRIMARY KEY(namespace,id), UNIQUE(namespace,wallet,request_id),
 FOREIGN KEY(namespace,wallet) REFERENCES claw_players(namespace,wallet));
CREATE TABLE IF NOT EXISTS claw_withdrawals (
 namespace text NOT NULL, id text NOT NULL, wallet text NOT NULL, request_id text NOT NULL,
 session_hash text NOT NULL, scope text NOT NULL CHECK(scope IN ('session','all')),
 cents bigint NOT NULL CHECK(cents>0 AND cents<=1000000000000),
 session_cents bigint NOT NULL CHECK(session_cents>=0 AND session_cents<=cents),
 status text NOT NULL CHECK(status IN ('reserved','submitted','paid','failed')),
 wire jsonb, receipt jsonb, created bigint NOT NULL,
 PRIMARY KEY(namespace,id), UNIQUE(namespace,wallet,request_id),
 FOREIGN KEY(namespace,wallet) REFERENCES claw_players(namespace,wallet));
ALTER TABLE claw_purchases ADD COLUMN IF NOT EXISTS last_checked bigint;
ALTER TABLE claw_withdrawals ADD COLUMN IF NOT EXISTS last_checked bigint;`;
