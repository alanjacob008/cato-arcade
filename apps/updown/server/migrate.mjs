import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Not the literal `new URL('…', import.meta.url)` form: bundlers (the website's
// webpack build) would try to bundle the directory as an asset.
const here = import.meta.url;
export const MIGRATIONS_DIR = fileURLToPath(new URL('../db/', here));
// Transaction-scoped advisory lock (safe through transaction-mode poolers) so
// concurrent cold starts of the website never apply the same file twice.
const LOCK = 'SELECT pg_advisory_xact_lock(7307728866345611776)';

/**
 * Apply every .sql file in db/ in lexical order, once each. Uses the same
 * schema_migrations ledger (keyed by file name) as cato-wrapped's packages/db
 * migrator, so a table created by either one is never re-applied by the other.
 * `connect` returns a pg client ({ query, release }). Each file runs in its own
 * transaction together with its ledger row, under a migration lock, and is
 * re-checked against the ledger inside that transaction. The SQL is idempotent too.
 * `files` overrides the directory listing (the website bundles the SQL text).
 *
 * @param {{ connect: () => Promise<any>, directory?: string, files?: { name: string, sql: string }[] }} options
 */
export async function migrate({ connect, directory = MIGRATIONS_DIR, files = undefined }) {
  const client = await connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(LOCK);
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
    const sources = files || await Promise.all((await readdir(directory)).filter(f => f.endsWith('.sql')).sort()
      .map(async name => ({ name, sql: await readFile(join(directory, name), 'utf8') })));
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map(r => r.name));
    const applied = [];
    for (const { name, sql } of [...sources].sort((a, b) => a.name.localeCompare(b.name))) {
      if (done.has(name)) continue;
      try {
        await client.query('BEGIN');
        await client.query(LOCK);
        const again = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
        if (again.rows.length) { await client.query('COMMIT'); continue; }
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        applied.push(name);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${name} failed: ${error.message}`);
      }
    }
    return { applied };
  } finally {
    client.release?.();
  }
}

/**
 * migrate(), but a failure is not fatal when the ledger already lists every
 * known migration: e.g. the migration connection (DATABASE_URL_UNPOOLED) is
 * briefly unreachable on a cold start while the tables are long in place. Then
 * the failure is logged and the caller carries on. If anything is still pending,
 * or the ledger cannot be read, the original error is thrown.
 *
 * @param {{ connect: () => Promise<any>, query: (text: string) => Promise<{ rows: any[] }>, directory?: string,
 *   files?: { name: string, sql: string }[], log?: (message: string) => void }} options
 *   `query` reads the ledger over the regular connection.
 */
export async function ensureMigrated({ connect, query, directory = MIGRATIONS_DIR, files = undefined, log = console.error }) {
  try {
    return await migrate({ connect, directory, files });
  } catch (error) {
    let applied;
    try {
      applied = new Set((await query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    } catch {
      throw error;
    }
    const names = files ? files.map(f => f.name) : (await readdir(directory)).filter(f => f.endsWith('.sql'));
    if (!names.every(name => applied.has(name))) throw error;
    log(`Up Down: migration check failed, but every migration is already applied; continuing. (${error.message})`);
    return { applied: [], skipped: true };
  }
}
