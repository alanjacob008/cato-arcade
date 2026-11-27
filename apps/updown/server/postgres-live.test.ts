// @vitest-environment node
// Real-Postgres checks of the serverless concurrency guarantees. Skipped unless
// UPDOWN_TEST_DATABASE_URL is set (e.g. a local throwaway database). Everything
// runs inside a fresh schema that is dropped afterwards; no other tables are touched.
// Orderly is mocked: no network requests, no orders.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createPostgresPool } from './pg-pool.mjs';
import { createPostgresStore } from './postgres-store.mjs';
import { migrate } from './migrate.mjs';
import { ORDER_NOT_FOUND_GRACE_MS, RoundEngine } from './engine.mjs';
import { createNetworkSweeper } from './sweeper.mjs';
import { OrderlyError } from './orderly.mjs';

const url = process.env.UPDOWN_TEST_DATABASE_URL;
const schema = `updown_test_${randomBytes(4).toString('hex')}`;
const key = randomBytes(32);
const accountId = '0x' + 'c'.repeat(64);
const pools: any[] = [];
const newPool = async () => {
  const pool = await createPostgresPool(url!, { max: 4, options: `-c search_path=${schema}` });
  pools.push(pool);
  return pool;
};

function exchange(account = accountId, { lostSends = new Set<string>() } = {}) {
  let position = 1;
  const orders = new Map<string, any>();
  const market = { symbol: 'PERP_BTC_USDC', status: 'ACTIVE', base_imr: .01, imr_factor: .000001, base_tick: .001, base_min: .001, base_max: 10000, min_notional: 1 };
  const request = vi.fn(async (path: string, _credential?: unknown, method = 'GET', body?: any): Promise<any> => {
    if (path === '/v1/client/info') return { account_id: account };
    if (path === '/v1/positions' || path.includes('status=INCOMPLETE')) return { rows: [] };
    if (path === '/v1/public/info') return { rows: [market] };
    if (path === '/v1/public/futures') return { rows: [{ symbol: market.symbol, mark_price: 2000 }] };
    if (path === '/v1/public/leverage') return { max_futures_leverage: 10 };
    if (path.startsWith('/v1/orderbook/')) return { bids: [{ price: 2000, quantity: 5 }], asks: [{ price: 2000.1, quantity: 5 }] };
    if (path === '/v1/client/leverages') return {};
    if (path.startsWith('/v1/position/')) return { position_qty: position, mark_price: 2001, margin_mode: 'ISOLATED' };
    if (path.startsWith('/v1/client/order/')) {
      const order = orders.get(decodeURIComponent(path.split('/').at(-1)!));
      if (!order) throw new OrderlyError('Order not found', true, -1006);
      return order;
    }
    if (path === '/v1/order' && method === 'POST') {
      // A send that never reaches Orderly (e.g. 'fetch failed').
      if ([...lostSends].some(suffix => body.client_order_id.endsWith(suffix))) throw new TypeError('fetch failed');
      await new Promise(resolve => setTimeout(resolve, 20));
      orders.set(body.client_order_id, { status: 'FILLED', total_executed_quantity: body.order_quantity, average_executed_price: 2000, total_fee: .01, updated_time: 100000, order_id: orders.size + 1 });
      if (body.reduce_only) position = 0; else position = body.side === 'BUY' ? body.order_quantity : -body.order_quantity;
      return { order_id: orders.size };
    }
    throw new Error('Unexpected request: ' + path);
  });
  return { request, sends: () => request.mock.calls.filter(c => c[0] === '/v1/order').map(c => c[3]) };
}

describe.skipIf(!url)('live Postgres round journal', () => {
  let admin: any;
  beforeAll(async () => {
    admin = await createPostgresPool(url!, { max: 2 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    // Every test needs the tables; the race test below re-runs migrate against them.
    const pool = await newPool();
    await migrate({ connect: () => pool.connect() });
  });
  afterAll(async () => {
    await Promise.all(pools.map(p => p.end()));
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it('applies the migrations once even when several cold starts race', async () => {
    // Fresh schema for this check, so the racing migrators have work to do.
    const fresh = `${schema}_m`;
    await admin.query(`CREATE SCHEMA ${fresh}`);
    try {
      const results = await Promise.all([1, 2, 3].map(async () => {
        const pool = await createPostgresPool(url!, { max: 2, options: `-c search_path=${fresh}` });
        pools.push(pool);
        return migrate({ connect: () => pool.connect() });
      }));
      expect(results.flatMap(r => r.applied).sort()).toEqual(['0011_updown_rounds.sql', '0012_updown_round_locks.sql', '0013_updown_account_case.sql']);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
    }
    const pool = await newPool();
    const { rows } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'updown_rounds' AND column_name = 'version'`, [schema]);
    expect(rows).toHaveLength(1);
  });

  it('runs a whole round across invocations and never double-sends a close under concurrent sweeps', async () => {
    const x = exchange();
    const input = { id: `live-${randomBytes(6).toString('hex')}`, accountId, secretKey: 'test-only', symbol: 'PERP_BTC_USDC', direction: 'UP', duration: 300, margin: 10, leverage: 10, authorize: true };
    // Every invocation: its own pool and store, like separate serverless instances.
    const invocation = async (now: number) => new RoundEngine({ request: x.request, store: createPostgresStore({ pool: await newPool(), key }), network: 'testnet', brokerId: 'cato', now: () => now, minTickMs: 900, maker: true });
    expect((await (await invocation(100000)).start(input)).status).toBe('opening');
    // A second start for the same account is refused by the lease or the unique index.
    await expect((await invocation(100000)).start({ ...input, id: input.id + 'x' })).rejects.toThrow('active round');
    await (await invocation(101000)).tick();
    const reader = await newPool();
    const status = async () => (await reader.query('SELECT status, version, credential FROM updown_rounds WHERE id = $1', [input.id])).rows[0];
    expect((await status()).status).toBe('open');
    // Deadline: six instances tick at once.
    const sweepers = await Promise.all(Array.from({ length: 6 }, () => invocation(400000)));
    await Promise.all(sweepers.map(s => s.tick()));
    expect(x.sends().filter(o => o.reduce_only)).toHaveLength(1);
    for (let t = 401000; t <= 405000; t += 1000) await Promise.all([(await invocation(t)).tick(), (await invocation(t)).tick()]);
    const final = await status();
    expect(final.status).toBe('closed');
    expect(final.credential).toBeNull();
    expect(x.sends()).toHaveLength(2);
    const { rows } = await reader.query('SELECT count(*)::int AS n FROM updown_locks');
    expect(rows[0].n).toBe(0);
  });

  it('the version check alone stops a second close when leases are bypassed', async () => {
    const input = { id: `live-${randomBytes(6).toString('hex')}`, accountId: '0x' + 'd'.repeat(64), secretKey: 'test-only', symbol: 'PERP_BTC_USDC', direction: 'DOWN', duration: 300, margin: 10, leverage: 10, authorize: true };
    const x = exchange(input.accountId);
    const store = async () => createPostgresStore({ pool: await newPool(), key });
    await new RoundEngine({ request: x.request, store: await store(), network: 'testnet', brokerId: 'cato', now: () => 100000, maker: true }).start(input);
    await new RoundEngine({ request: x.request, store: await store(), network: 'testnet', brokerId: 'cato', now: () => 101000 }).tick();
    const unlocked = async () => { const s = await store(); return { ...s, withLock: async (_n: string[], fn: () => Promise<unknown>) => ({ acquired: true, value: await fn() }) }; };
    const racers = await Promise.all(Array.from({ length: 6 }, async () => new RoundEngine({ request: x.request, store: await unlocked(), network: 'testnet', brokerId: 'cato', now: () => 400000 })));
    await Promise.all(racers.map(r => r.tickRound(input.id)));
    expect(x.sends().filter(o => o.reduce_only)).toHaveLength(1);
    const reader = await newPool();
    const { rows } = await reader.query('SELECT data FROM updown_rounds WHERE id = $1', [input.id]);
    expect(rows[0].data.closeAttempts).toHaveLength(1);
  });

  it('leases exclude across connections and expire', async () => {
    const watcher = await newPool();
    const a = createPostgresStore({ pool: await newPool(), key });
    const b = createPostgresStore({ pool: await newPool(), key });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = a.withLock(['sweep'], () => gate);
    await vi.waitFor(async () => expect((await watcher.query(`SELECT 1 FROM updown_locks WHERE name = 'sweep'`)).rows).toHaveLength(1));
    expect((await b.withLock(['sweep'], async () => 1)).acquired).toBe(false);
    release(); await holding;
    expect((await b.withLock(['sweep'], async () => 1)).acquired).toBe(true);
    // A dead holder's lease is reclaimable after it expires.
    const pool = await newPool();
    await pool.query(`INSERT INTO updown_locks (name, owner, expires_at) VALUES ('round:dead', 'gone', now() + interval '200 milliseconds')`);
    expect((await b.withLock(['round:dead'], async () => 1)).acquired).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 250));
    expect((await b.withLock(['round:dead'], async () => 1)).acquired).toBe(true);
  });

  it('closes a round whose close POST never reached Orderly, across invocations', async () => {
    const input = { id: `live-${randomBytes(6).toString('hex')}`, accountId: '0x' + '1'.repeat(64), secretKey: 'test-only', symbol: 'PERP_BTC_USDC', direction: 'UP', duration: 300, margin: 10, leverage: 10, authorize: true };
    const x = exchange(input.accountId, { lostSends: new Set(['-c0']) });
    const invocation = async (now: number) => new RoundEngine({ request: x.request, store: createPostgresStore({ pool: await newPool(), key }), network: 'testnet', brokerId: 'cato', now: () => now });
    await (await invocation(100000)).start(input);
    await (await invocation(101000)).tick();
    await (await invocation(400000)).tick();
    const reader = await newPool();
    const row = async () => (await reader.query('SELECT status, credential, data FROM updown_rounds WHERE id = $1', [input.id])).rows[0];
    expect(await row()).toMatchObject({ status: 'closing', data: { error: 'fetch failed' } });
    // The lookup says "not found" for the whole grace period; nothing is resent.
    await (await invocation(400000 + ORDER_NOT_FOUND_GRACE_MS - 1)).tick();
    expect(x.sends()).toHaveLength(2);
    for (let t = 400000 + ORDER_NOT_FOUND_GRACE_MS; t <= 400000 + ORDER_NOT_FOUND_GRACE_MS + 8000; t += 1000) await (await invocation(t)).tick();
    const final = await row();
    expect(final.status).toBe('closed');
    expect(final.credential).toBeNull();
    expect(final.data.closeAttempts.map((c: any) => [c.clientId.slice(-3), c.abandoned ?? false])).toEqual([['-c0', true], ['-c1', false]]);
    expect(x.sends().map(o => o.reduce_only ?? false)).toEqual([false, true, true]);
  });

  it('treats account IDs case-insensitively, including rows stored before lowercasing', async () => {
    const upper = '0x' + 'E'.repeat(64);
    const x = exchange(upper.toLowerCase());
    const engine = async () => new RoundEngine({ request: x.request, store: createPostgresStore({ pool: await newPool(), key }), network: 'testnet', brokerId: 'cato', now: () => 100000 });
    const input = { id: `live-${randomBytes(6).toString('hex')}`, accountId: upper, secretKey: 'test-only', symbol: 'PERP_BTC_USDC', direction: 'UP', duration: 300, margin: 10, leverage: 10, authorize: true };
    expect(await (await engine()).start(input)).toMatchObject({ accountId: upper.toLowerCase() });
    await expect((await engine()).start({ ...input, id: input.id + 'b', accountId: upper.toLowerCase() })).rejects.toThrow('active round');
    expect(await (await engine()).list(upper)).toHaveLength(1);
    // The database itself refuses a second active row that differs only by case.
    const pool = await newPool();
    const legacy = { id: 'legacy-mixed', network: 'testnet', account_id: upper };
    await expect(pool.query(
      `INSERT INTO updown_rounds (id, network, account_id, symbol, direction, status, margin, leverage, duration_s, created_at, data)
       VALUES ($1, $2, $3, 'PERP_BTC_USDC', 'UP', 'open', 10, 10, 300, now(), '{}')`, [legacy.id, legacy.network, legacy.account_id],
    )).rejects.toMatchObject({ code: '23505', constraint: 'updown_rounds_one_active_lower_idx' });
  });

  it('a testnet deployment keeps sweeping a live mainnet round to a close', async () => {
    const id = `live-${randomBytes(6).toString('hex')}`;
    const owner = '0x' + '2'.repeat(64);
    const store = createPostgresStore({ pool: await newPool(), key });
    await store.insert({ id, accountId: owner, network: 'mainnet', symbol: 'PERP_BTC_USDC', direction: 'UP', duration: 300, margin: 10, leverage: 10,
      quantity: 1, status: 'open', createdAt: 1, openedAt: 1, deadline: 2, entryPrice: 2000, openFee: .01, closeAttempts: [], orderPrefix: 'nl-live',
      credential: { accountId: owner, secretKey: 'test-only' } });
    expect(await store.activeNetworks()).toContain('mainnet');
    const testnet = exchange(owner), mainnet = exchange(owner);
    let now = 10_000;
    const primary = new RoundEngine({ request: testnet.request, store, network: 'testnet', brokerId: 'cato', now: () => now });
    const sweeper = createNetworkSweeper({ store, primary, log: () => {},
      engineFor: network => new RoundEngine({ request: mainnet.request, store, network, brokerId: 'cato', now: () => now }) });
    for (let i = 0; i < 6; i++) { await sweeper.tick(); now += 1000; }
    expect(await store.get(id)).toMatchObject({ status: 'closed' });
    expect(mainnet.sends()).toHaveLength(1);
    expect(testnet.sends()).toHaveLength(0);
  });

  it('no round without pending work keeps a credential', async () => {
    const reader = await newPool();
    const { rows } = await reader.query(`SELECT id, status, data->>'resultPending' AS pending FROM updown_rounds
      WHERE credential IS NOT NULL AND NOT (status NOT IN ('closed', 'ended_early', 'failed') OR (status = 'ended_early' AND data->>'resultPending' = 'true'))`);
    expect(rows).toEqual([]);
    const { rows: terminal } = await reader.query(`SELECT count(*)::int AS n FROM updown_rounds WHERE status IN ('closed', 'failed')`);
    expect(terminal[0].n).toBeGreaterThan(0);
  });
});
