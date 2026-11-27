// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureMigrated, migrate, MIGRATIONS_DIR } from './migrate.mjs';

/** Minimal stand-in for a pg client: records statements and keeps a ledger. */
function fakeClient(applied: string[] = [], failOn?: RegExp) {
  const statements: string[] = [];
  const ledger = new Set(applied);
  let released = 0;
  const client = {
    async query(text: string, params: unknown[] = []) {
      statements.push(text);
      if (failOn?.test(text)) throw new Error('boom');
      if (text.startsWith('SELECT name FROM schema_migrations')) return { rows: [...ledger].map(name => ({ name })) };
      if (text.startsWith('SELECT 1 FROM schema_migrations')) return { rows: ledger.has(params[0] as string) ? [{}] : [] };
      if (text.startsWith('INSERT INTO schema_migrations')) ledger.add(params[0] as string);
      return { rows: [] };
    },
    release() { released++; },
  };
  return { client, statements, ledger, released: () => released };
}

describe('updown migrations', () => {
  it('ships the updown_rounds table as an idempotent migration', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0011_updown_rounds.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS updown_rounds');
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
  });

  it('ships the case-insensitive account index without failing on existing duplicates', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0013_updown_account_case.sql'), 'utf8');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS updown_rounds_account_lower_idx');
    expect(sql).toMatch(/IF NOT EXISTS \([\s\S]*HAVING count\(\*\) > 1[\s\S]*CREATE UNIQUE INDEX IF NOT EXISTS updown_rounds_one_active_lower_idx/);
  });

  it('ships the serverless lock and version migration', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0012_updown_round_locks.sql'), 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS version');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS updown_locks');
  });

  it('applies pending files once, each in a locked transaction, and records them', async () => {
    const db = fakeClient();
    expect(await migrate({ connect: async () => db.client })).toEqual({ applied: ['0011_updown_rounds.sql', '0012_updown_round_locks.sql', '0013_updown_account_case.sql'] });
    // Ledger table, then one transaction per file; every transaction takes the migration lock first.
    expect(db.statements.filter(s => s === 'BEGIN' || s === 'COMMIT')).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
    db.statements.forEach((s, i) => { if (s === 'BEGIN') expect(db.statements[i + 1]).toContain('pg_advisory_xact_lock'); });
    expect(db.ledger.has('0011_updown_rounds.sql')).toBe(true);
    expect(db.released()).toBe(1);
    expect(await migrate({ connect: async () => db.client })).toEqual({ applied: [] });
  });

  it('skips a file another instance applied after this one read the ledger', async () => {
    const db = fakeClient();
    const original = db.client.query;
    db.client.query = async (text: string, params: unknown[] = []) => {
      const result = await original(text, params);
      if (text.startsWith('SELECT name FROM schema_migrations')) { for (const name of ['0011_updown_rounds.sql', '0012_updown_round_locks.sql', '0013_updown_account_case.sql']) db.ledger.add(name); }
      return result;
    };
    expect(await migrate({ connect: async () => db.client })).toEqual({ applied: [] });
    expect(db.statements.some(s => s.includes('CREATE TABLE IF NOT EXISTS updown_rounds'))).toBe(false);
  });

  it('accepts bundled migration sources instead of a directory', async () => {
    const db = fakeClient();
    expect(await migrate({ connect: async () => db.client, files: [{ name: '0099_b.sql', sql: 'SELECT 2' }, { name: '0098_a.sql', sql: 'SELECT 1' }] })).toEqual({ applied: ['0098_a.sql', '0099_b.sql'] });
  });

  it('rolls back and reports a failing file', async () => {
    const db = fakeClient([], /CREATE TABLE IF NOT EXISTS updown_rounds/);
    await expect(migrate({ connect: async () => db.client })).rejects.toThrow('Migration 0011_updown_rounds.sql failed: boom');
    expect(db.statements).toContain('ROLLBACK');
    expect(db.ledger.size).toBe(0);
    expect(db.released()).toBe(1);
  });

  it('continues after a failed run only when the ledger already lists every migration', async () => {
    const files = [{ name: '0001_a.sql', sql: 'SELECT 1' }, { name: '0002_b.sql', sql: 'SELECT 2' }];
    const unreachable = async () => { throw new Error('connect ETIMEDOUT'); };
    const logged: string[] = [];
    const ledger = (names: string[]) => async () => ({ rows: names.map(name => ({ name })) });
    expect(await ensureMigrated({ connect: unreachable, query: ledger(['0001_a.sql', '0002_b.sql']), files, log: m => logged.push(m) })).toEqual({ applied: [], skipped: true });
    expect(logged[0]).toContain('connect ETIMEDOUT');
    // Something still pending, or the ledger unreadable: the original error stands.
    await expect(ensureMigrated({ connect: unreachable, query: ledger(['0001_a.sql']), files, log: () => {} })).rejects.toThrow('ETIMEDOUT');
    await expect(ensureMigrated({ connect: unreachable, query: async () => { throw new Error('relation does not exist'); }, files, log: () => {} })).rejects.toThrow('ETIMEDOUT');
    // A healthy run is just migrate().
    const db = fakeClient();
    expect(await ensureMigrated({ connect: async () => db.client, query: ledger([]), files })).toEqual({ applied: ['0001_a.sql', '0002_b.sql'] });
  });
});
