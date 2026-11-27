// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createPostgresStore } from './postgres-store.mjs';
import { createSealer, databaseJournalKey, resolveJournalKey } from './store.mjs';
import { ConflictError, RoundEngine } from './engine.mjs';
import { OrderlyError } from './orderly.mjs';

const key = randomBytes(32);
const accountId = '0x' + 'a'.repeat(64);
const round = (overrides: Record<string, unknown> = {}): Record<string, any> => ({
  id: 'round-00000001', accountId, network: 'testnet', symbol: 'PERP_BTC_USDC',
  direction: 'UP', duration: 300, margin: 25, leverage: 5, quantity: 1, status: 'preparing', createdAt: 1_700_000_000_000,
  credential: { accountId, secretKey: 'sensitive-test-value' }, closeAttempts: [], ...overrides,
});

/**
 * In-memory stand-in for the two tables, answering exactly the statements
 * postgres-store.mjs issues: unique constraints, version compare-and-set and
 * expiring leases. A real-database version of the concurrency checks is in
 * postgres-live.test.ts.
 */
function fakeDatabase() {
  const rows = new Map<string, any>();
  const locks = new Map<string, { owner: string; expiresAt: number }>();
  const calls: { text: string; params: any[] }[] = [];
  let clock = 0;
  const active = (r: any) => !['closed', 'ended_early', 'failed'].includes(r.status);
  const query = vi.fn(async (text: string, params: any[] = []): Promise<{ rows: any[] }> => {
    calls.push({ text, params });
    await Promise.resolve();
    const sql = text.trim();
    if (sql.startsWith('INSERT INTO updown_rounds')) {
      if (rows.has(params[0])) throw Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'updown_rounds_pkey' });
      if ([...rows.values()].some(r => r.network === params[1] && r.account_id === params[2] && active(r)) && active({ status: params[5] })) {
        throw Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'updown_rounds_one_active_idx' });
      }
      rows.set(params[0], { id: params[0], network: params[1], account_id: params[2], status: params[5], trading_pnl: params[9], closed_at: params[12], created_at: params[10], data: JSON.parse(params[13]), credential: params[14], version: 0 });
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE updown_rounds')) {
      const row = rows.get(params[0]);
      if (!row || row.version !== params[8]) return { rows: [] };
      Object.assign(row, { status: params[1], trading_pnl: params[3], closed_at: params[5], data: JSON.parse(params[6]), credential: params[7], version: row.version + 1 });
      return { rows: [{ version: String(row.version) }] };
    }
    if (sql.startsWith('SELECT data, credential, version FROM updown_rounds WHERE id')) {
      const row = rows.get(params[0]);
      return { rows: row ? [{ data: structuredClone(row.data), credential: row.credential, version: String(row.version) }] : [] };
    }
    if (sql.startsWith('SELECT data FROM updown_rounds')) {
      return { rows: [...rows.values()].filter(r => r.network === params[0] && r.account_id === params[1]).reverse().map(r => ({ data: structuredClone(r.data) })) };
    }
    if (sql.startsWith('SELECT id FROM updown_rounds')) {
      return { rows: [...rows.values()].filter(r => r.network === params[0] && (params[1] === undefined || r.account_id === params[1])
        && (active(r) || (r.credential && r.data.resultPending === true))).map(r => ({ id: r.id })) };
    }
    if (sql.startsWith('INSERT INTO updown_locks')) {
      const held = locks.get(params[0]);
      if (held && held.expiresAt > clock) return { rows: [] };
      locks.set(params[0], { owner: params[1], expiresAt: clock + params[2] });
      return { rows: [{ owner: params[1] }] };
    }
    if (sql.startsWith('DELETE FROM updown_locks WHERE name = ANY')) {
      for (const name of params[0]) if (locks.get(name)?.owner === params[1]) locks.delete(name);
      return { rows: [] };
    }
    throw new Error('Unexpected SQL: ' + sql.slice(0, 60));
  });
  return { pool: { query }, query, calls, rows, locks, advance: (ms: number) => { clock += ms; } };
}

describe('postgres round journal', () => {
  it('inserts one row per round with hot columns, public data and a sealed credential', async () => {
    const db = fakeDatabase();
    const store = createPostgresStore({ pool: db.pool, key });
    await store.insert(round());
    const insert = db.calls.find(c => c.text.includes('INSERT INTO updown_rounds'))!;
    const p = insert.params;
    expect(p.slice(0, 10)).toEqual(['round-00000001', 'testnet', accountId, 'PERP_BTC_USDC', 'UP', 'preparing', 25, 5, 300, null]);
    expect(p[10]).toBe(1_700_000_000_000); expect(p[11]).toBeNull(); expect(p[12]).toBeNull();
    expect(JSON.parse(p[13])).not.toHaveProperty('credential');
    expect(Buffer.isBuffer(p[14])).toBe(true);
    expect(p[14].includes(Buffer.from('sensitive-test-value'))).toBe(false);
    expect(createSealer(key).open(p[14])).toEqual({ accountId, secretKey: 'sensitive-test-value' });
    const loaded = await store.get('round-00000001');
    expect(loaded).toEqual(round());
  });

  it('enforces unique ids and one active round per account with clear errors', async () => {
    const db = fakeDatabase();
    const store = createPostgresStore({ pool: db.pool, key });
    await store.insert(round());
    await expect(store.insert(round({ accountId: '0x' + 'b'.repeat(64) }))).rejects.toThrow('Round ID is already in use.');
    await expect(store.insert(round({ id: 'round-00000002' }))).rejects.toThrow('Finish the active round');
  });

  it('only rewrites changed rounds, compare-and-sets the version, and clears the credential column', async () => {
    const db = fakeDatabase();
    const store = createPostgresStore({ pool: db.pool, key });
    await store.insert(round());
    const a = (await store.get('round-00000001'))!;
    await store.save(a);
    const updates = () => db.calls.filter(c => c.text.includes('UPDATE updown_rounds')).length;
    expect(updates()).toBe(0);
    a.status = 'closed'; a.closedAt = 1_700_000_300_000; a.tradingPnl = -0.42; delete a.credential;
    await store.save(a);
    expect(updates()).toBe(1);
    const row = db.rows.get('round-00000001');
    expect(row).toMatchObject({ status: 'closed', trading_pnl: -0.42, closed_at: 1_700_000_300_000, credential: null, version: 1 });
  });

  it('never keeps a credential on a row with no work left, even if the round still carries one', async () => {
    const db = fakeDatabase();
    const store = createPostgresStore({ pool: db.pool, key });
    await store.insert(round({ status: 'open' }));
    const r = (await store.get('round-00000001'))!;
    for (const [status, extra, kept] of [
      ['ended_early', { resultPending: true }, true],
      ['ended_early', { resultPending: false }, false],
      ['failed', {}, false],
      ['closed', {}, false],
    ] as const) {
      Object.assign(r, { status, ...extra });
      await store.save(r);
      expect(Buffer.isBuffer(db.rows.get('round-00000001').credential)).toBe(kept);
    }
  });

  it('looks accounts up case-insensitively and reports networks with pending work', async () => {
    const db = fakeDatabase();
    const store = createPostgresStore({ pool: db.pool, key });
    await store.listAccount('testnet', '0x' + 'A'.repeat(64));
    await store.dueIds('testnet', '0x' + 'A'.repeat(64));
    const reads = db.calls.filter(c => c.text.includes('lower(account_id) = $2'));
    expect(reads).toHaveLength(2);
    expect(reads.map(c => c.params[1])).toEqual([accountId, accountId]);
    db.query.mockResolvedValueOnce({ rows: [{ network: 'mainnet' }, { network: 'testnet' }] });
    expect(await store.activeNetworks()).toEqual(['mainnet', 'testnet']);
    expect(db.query.mock.calls.at(-1)![0]).toMatch(/SELECT DISTINCT network FROM updown_rounds WHERE/);
  });

  it('maps the case-insensitive one-active-round index to the same clear error', async () => {
    const db = fakeDatabase();
    const store = createPostgresStore({ pool: db.pool, key });
    db.query.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'updown_rounds_one_active_lower_idx' }));
    await expect(store.insert(round())).rejects.toThrow('Finish the active round');
  });

  it('rejects a write based on a stale read (another invocation won the race)', async () => {
    const db = fakeDatabase();
    const first = createPostgresStore({ pool: db.pool, key });
    const second = createPostgresStore({ pool: db.pool, key });
    await first.insert(round({ status: 'open' }));
    const mine = (await first.get('round-00000001'))!, theirs = (await second.get('round-00000001'))!;
    mine.closeAttempts.push({ clientId: 'x-c0' }); theirs.closeAttempts.push({ clientId: 'x-c0' });
    await second.save(theirs);
    await expect(first.save(mine)).rejects.toBeInstanceOf(ConflictError);
    expect(db.rows.get('round-00000001').version).toBe(1);
  });

  it('surfaces a failed write to the caller', async () => {
    const db = fakeDatabase();
    const store = createPostgresStore({ pool: db.pool, key });
    await store.insert(round());
    const r = (await store.get('round-00000001'))!;
    r.status = 'opening';
    db.query.mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.save(r)).rejects.toThrow('connection lost');
    await expect(store.save(r)).resolves.toBeUndefined();
    expect(db.rows.get('round-00000001').status).toBe('opening');
  });

  it('leases: skip when held, wait when asked, release afterwards, reclaim after expiry', async () => {
    const db = fakeDatabase();
    const store = createPostgresStore({ pool: db.pool, key, leaseMs: 60000, waitMs: 5000 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = store.withLock(['round:a'], async () => { await gate; return 'first'; });
    await vi.waitFor(() => expect(db.locks.has('round:a')).toBe(true));
    expect(await store.withLock(['round:a', 'round:b'], async () => 'never')).toEqual({ acquired: false });
    // A failed multi-name attempt gives back what it took.
    expect(db.locks.has('round:b')).toBe(false);
    const waiter = store.withLock(['round:a'], async () => 'second', { wait: true });
    release();
    expect(await holder).toEqual({ acquired: true, value: 'first' });
    expect(await waiter).toEqual({ acquired: true, value: 'second' });
    expect(db.locks.size).toBe(0);
    // A holder that died leaves its lease behind until it expires.
    db.locks.set('round:c', { owner: 'dead', expiresAt: 60000 });
    expect((await store.withLock(['round:c'], async () => 1)).acquired).toBe(false);
    db.advance(60001);
    expect(await store.withLock(['round:c'], async () => 1)).toEqual({ acquired: true, value: 1 });
  });
});

/** Orderly stand-in: fills every order instantly; a reduce-only fill flattens the position. Never touches the network. */
function exchange() {
  let position = 1;
  const orders = new Map<string, any>();
  const market = { symbol: 'PERP_BTC_USDC', status: 'ACTIVE', base_imr: .01, imr_factor: .000001, base_tick: .01, base_min: .01, base_max: 10000, min_notional: 1 };
  const request = vi.fn(async (path: string, _credential?: unknown, method = 'GET', body?: any): Promise<any> => {
    if (path === '/v1/client/info') return { account_id: accountId };
    if (path === '/v1/positions' || path.includes('status=INCOMPLETE')) return { rows: [] };
    if (path === '/v1/public/info') return { rows: [market] };
    if (path === '/v1/public/futures') return { rows: [{ symbol: market.symbol, mark_price: 100 }] };
    if (path === '/v1/public/leverage') return { max_futures_leverage: 10 };
    if (path.startsWith('/v1/orderbook/')) return { bids: [{ price: 100, quantity: 5 }], asks: [{ price: 100.01, quantity: 5 }] };
    if (path === '/v1/client/leverages') return {};
    if (path.startsWith('/v1/position/')) return { position_qty: position, mark_price: 101, margin_mode: 'ISOLATED' };
    if (path.startsWith('/v1/client/order/')) {
      const order = orders.get(decodeURIComponent(path.split('/').at(-1)!));
      if (!order) throw new OrderlyError('Order not found', true, -1006);
      return order;
    }
    if (path === '/v1/order' && method === 'POST') {
      // Let concurrent invocations interleave around the send.
      await new Promise(resolve => setTimeout(resolve, 5));
      orders.set(body.client_order_id, { status: 'FILLED', total_executed_quantity: body.order_quantity, average_executed_price: 100, total_fee: .01, updated_time: 100000, order_id: orders.size + 1 });
      if (body.reduce_only) position = 0;
      return { order_id: orders.size };
    }
    throw new Error('Unexpected request: ' + path);
  });
  return { request, sends: () => request.mock.calls.filter(c => c[0] === '/v1/order').map(c => c[3]) };
}

describe('serverless invocations over one database', () => {
  const input = { id: 'round-00000001', accountId, secretKey: 'test-only', symbol: 'PERP_BTC_USDC', direction: 'UP', duration: 300, margin: 10, leverage: 10, authorize: true };
  // Each "invocation" has its own store object (own version tracking), as separate lambdas would.
  const invocation = (db: ReturnType<typeof fakeDatabase>, x: ReturnType<typeof exchange>, now: number, store?: any) =>
    new RoundEngine({ request: x.request, store: store ?? createPostgresStore({ pool: db.pool, key }), network: 'testnet', brokerId: 'cato', maker: true, now: () => now, minTickMs: 900 });

  it('persists the opening intent before the order and refuses to trade when the insert fails', async () => {
    const db = fakeDatabase(), x = exchange();
    const original = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (text: string, params?: any[]) => { if (text.includes('INSERT INTO updown_rounds')) throw new Error('database unavailable'); return original(text, params); });
    await expect(invocation(db, x, 100000).start(input)).rejects.toThrow('database unavailable');
    expect(x.sends()).toHaveLength(0);
  });

  it('two concurrent sweeps at the deadline send exactly one close', async () => {
    const db = fakeDatabase(), x = exchange();
    await invocation(db, x, 100000).start(input);
    await invocation(db, x, 101000).tick();
    expect(db.rows.get(input.id).status).toBe('open');
    await Promise.all([invocation(db, x, 400000).tick(), invocation(db, x, 400000).tick(), invocation(db, x, 400000).tickRound(input.id)]);
    expect(x.sends()).toHaveLength(2);
    expect(x.sends()[1]).toMatchObject({ reduce_only: true, side: 'SELL' });
  });

  it('even without leases, the version check alone stops a second close', async () => {
    const db = fakeDatabase(), x = exchange();
    await invocation(db, x, 100000).start(input);
    await invocation(db, x, 101000).tick();
    const unlocked = () => {
      const store = createPostgresStore({ pool: db.pool, key });
      return { ...store, withLock: async (_names: string[], fn: () => Promise<unknown>) => ({ acquired: true, value: await fn() }) };
    };
    await Promise.all(Array.from({ length: 4 }, () => invocation(db, x, 400000, unlocked()).tickRound(input.id)));
    expect(x.sends()).toHaveLength(2);
    expect(db.rows.get(input.id).data.closeAttempts).toHaveLength(1);
  });

  it('even without leases, the version check alone stops a second opening quote', async () => {
    const db = fakeDatabase(), x = exchange();
    // Quotes rest; the first one is pulled by the player, so every racer wants to send the cancel, then a close.
    const original = x.request.getMockImplementation()!;
    let moved = false;
    x.request.mockImplementation(async (path: string, credential?: unknown, method = 'GET', body?: any) => {
      if (path === '/v1/order' && method === 'POST' && body.order_type === 'POST_ONLY') {
        await new Promise(resolve => setTimeout(resolve, 5));
        const order = { status: 'NEW', total_executed_quantity: 0, average_executed_price: 0, total_fee: 0, updated_time: 100000, order_id: 9 };
        (x as any).resting = order;
        return { order_id: 9 };
      }
      if (path.startsWith('/v1/client/order/') && path.endsWith('-q0')) return (x as any).resting;
      if (path.startsWith('/v1/client/order?') && method === 'DELETE') { await new Promise(resolve => setTimeout(resolve, 5)); (x as any).resting.status = 'CANCELLED'; return {}; }
      if (path.startsWith('/v1/orderbook/') && moved) return { bids: [{ price: 100.5, quantity: 1 }], asks: [{ price: 100.6, quantity: 1 }] };
      return original(path, credential, method, body);
    });
    await invocation(db, x, 100000).start(input);
    expect(x.sends()).toEqual([expect.objectContaining({ order_type: 'POST_ONLY', order_price: 100 })]);
    const unlocked = () => {
      const store = createPostgresStore({ pool: db.pool, key });
      return { ...store, withLock: async (_names: string[], fn: () => Promise<unknown>) => ({ acquired: true, value: await fn() }) };
    };
    // The top moved: every racer decides to cancel, only one cancel intent lands; then only one requote.
    moved = true;
    await Promise.all(Array.from({ length: 4 }, () => invocation(db, x, 102000, unlocked()).tickRound(input.id)));
    expect(x.request.mock.calls.filter(c => c[2] === 'DELETE')).toHaveLength(1);
    await Promise.all(Array.from({ length: 4 }, () => invocation(db, x, 103000, unlocked()).tickRound(input.id)));
    expect(x.sends()).toHaveLength(2);
    expect(x.sends()[1]).toMatchObject({ order_type: 'POST_ONLY', order_price: 100.5, client_order_id: expect.stringMatching(/-q1$/) });
    expect(db.rows.get(input.id).data.openAttempts.filter((a: any) => !a.terminal)).toHaveLength(1);
  });

  it('opening → open → deadline → closing → closed across separate invocations', async () => {
    const db = fakeDatabase(), x = exchange();
    expect((await invocation(db, x, 100000).start(input)).status).toBe('opening');
    let t = 101000;
    await invocation(db, x, t).tick();
    expect(db.rows.get(input.id).data).toMatchObject({ status: 'open', deadline: 400000 });
    for (t = 400000; t < 406000; t += 1000) await invocation(db, x, t).tick();
    const row = db.rows.get(input.id);
    expect(row.status).toBe('closed');
    expect(row.credential).toBeNull();
    expect(row.data.tradingPnl).toBeCloseTo(-0.02);
    expect(x.sends()).toHaveLength(2);
    expect(await invocation(db, x, t).tick()).toBe(0);
  });
});

describe('journal key', () => {
  it('prefers UPDOWN_JOURNAL_KEY and validates its shape', () => {
    const hex = key.toString('hex');
    expect(resolveJournalKey({ UPDOWN_JOURNAL_KEY: hex }, '.unused')).toEqual(key);
    expect(() => resolveJournalKey({ UPDOWN_JOURNAL_KEY: 'short' }, '.unused')).toThrow('64 hex');
  });

  it('never seals a shared database with the local machine key', () => {
    expect(() => databaseJournalKey({ DATABASE_URL: 'postgres://x' })).toThrow('UPDOWN_JOURNAL_KEY is not');
    expect(() => databaseJournalKey({ UPDOWN_JOURNAL_KEY: '  ' })).toThrow('UPDOWN_JOURNAL_KEY is not');
    expect(databaseJournalKey({ UPDOWN_JOURNAL_KEY: key.toString('hex') })).toEqual(key);
  });
});
