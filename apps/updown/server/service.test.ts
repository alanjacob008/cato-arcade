// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createGameApi, HttpError } from './service.mjs';
import { RoundEngine } from './engine.mjs';
import { createJournalStore } from './store.mjs';
import { OrderlyError } from './orderly.mjs';

const mine = '0x' + 'a'.repeat(64), theirs = '0x' + 'b'.repeat(64);
function setup({ tickOnRead = false } = {}) {
  let now = 100000, position = 0;
  const orders = new Map<string, any>();
  const market = { symbol: 'PERP_BTC_USDC', status: 'ACTIVE', broker_id: null, base_imr: .01, imr_factor: .000001, base_tick: .01, base_min: .01, base_max: 10000, min_notional: 1, '24h_amount': 5 };
  const request = vi.fn(async (path: string, credential?: any, method = 'GET', body?: any): Promise<any> => {
    if (path === '/v1/client/info') return { account_id: credential.accountId };
    if (path === '/v1/positions' || path.includes('status=INCOMPLETE')) return { rows: [] };
    if (path === '/v1/public/info') return { rows: [market, { ...market, symbol: 'PERP_OTHER_USDC', broker_id: 'someone-else' }] };
    if (path === '/v1/public/futures') return { rows: [{ symbol: market.symbol, mark_price: 100 }] };
    if (path === '/v1/public/leverage') return { max_futures_leverage: 50 };
    if (path.startsWith('/v1/orderbook/')) return { bids: [{ price: 100, quantity: 5 }], asks: [{ price: 100.01, quantity: 5 }] };
    if (path === '/v1/public/query') return { rows: [{ close: 1 }] };
    if (path === '/v1/client/leverages') return {};
    if (path.startsWith('/v1/position/')) return { position_qty: position, mark_price: 100, margin_mode: 'ISOLATED' };
    if (path.startsWith('/v1/client/order/')) {
      const order = orders.get(decodeURIComponent(path.split('/').at(-1)!));
      if (!order) throw new OrderlyError('Order not found', true, -1006);
      return order;
    }
    if (path === '/v1/order' && method === 'POST') {
      orders.set(body.client_order_id, { status: 'FILLED', total_executed_quantity: body.order_quantity, average_executed_price: 100, total_fee: .01, updated_time: now, order_id: 1 });
      position = body.reduce_only ? 0 : body.order_quantity;
      return { order_id: 1 };
    }
    throw new Error('Unexpected request: ' + path);
  });
  const store = createJournalStore({ load: () => [], save: () => {} });
  const engine = new RoundEngine({ request, store, network: 'testnet', brokerId: 'cato', now: () => now, maker: true });
  const authorize = vi.fn(async (accountId: unknown) => { if (accountId !== mine) throw new HttpError(403, 'Not yours.'); });
  const api = createGameApi({ engine, request, brokerId: 'cato', health: async () => ({ ready: true }), tickOnRead });
  const call = (method: string, path: string, body?: unknown, auth: any = authorize) => {
    const url = new URL(path, 'http://x');
    return api({ method, pathname: url.pathname, searchParams: url.searchParams, readBody: async () => body, authorize: auth });
  };
  const start = (accountId: string, id = 'round-000001') => call('POST', '/game-api/rounds', { id, accountId, secretKey: 'k', symbol: 'PERP_BTC_USDC', direction: 'UP', duration: 300, margin: 10, leverage: 10, authorize: true });
  return { call, start, request, authorize, store, setTime: (t: number) => { now = t; }, sends: () => request.mock.calls.filter(c => c[0] === '/v1/order') };
}

describe('game API routes', () => {
  it('serves exactly the BTC market row and no price routes', async () => {
    const s = setup();
    const markets = await s.call('GET', '/game-api/markets');
    expect(markets.status).toBe(200);
    expect(markets.body.rows).toHaveLength(1);
    expect(markets.body.rows[0]).toMatchObject({ symbol: 'PERP_BTC_USDC', mark_price: 100, maxLeverage: 50 });
    for (const path of ['/game-api/marks?symbol=PERP_BTC_USDC', '/game-api/candles?symbol=PERP_BTC_USDC', '/game-api/nope']) {
      expect(await s.call('GET', path)).toMatchObject({ status: 404, body: { error: 'Not found.' } });
    }
    expect(s.request.mock.calls.filter(c => c[0] === '/v1/public/query')).toHaveLength(0);
    // Cached: one load of the three public endpoints.
    expect(await s.call('GET', '/game-api/markets')).toMatchObject({ status: 200 });
    expect(s.request.mock.calls.filter(c => c[0] === '/v1/public/info')).toHaveLength(1);
  });

  it('lists no market while BTC is not active for this broker', async () => {
    const s = setup();
    const original = s.request.getMockImplementation()!;
    s.request.mockImplementation(async (path: string, ...rest: any[]) => path === '/v1/public/info' ? { rows: [{ symbol: 'PERP_BTC_USDC', status: 'ACTIVE', broker_id: 'someone-else' }, { symbol: 'PERP_SOL_USDC', status: 'ACTIVE' }] } : original(path, ...rest));
    expect(await s.call('GET', '/game-api/markets')).toMatchObject({ status: 200, body: { rows: [] } });
  });

  it('refuses rounds on any market but BTC', async () => {
    const s = setup();
    expect(await s.call('POST', '/game-api/rounds', { id: 'round-000002', accountId: mine, secretKey: 'k', symbol: 'PERP_SOL_USDC', direction: 'UP', duration: 300, margin: 10, authorize: true })).toMatchObject({ status: 400, body: { error: 'Only BTC is playable.' } });
    expect(s.sends()).toHaveLength(0);
  });

  it('runs every round read and operation through authorize', async () => {
    const s = setup();
    expect(await s.call('GET', `/game-api/rounds?accountId=${theirs}`)).toMatchObject({ status: 403 });
    expect(await s.start(theirs)).toMatchObject({ status: 403 });
    expect(s.sends()).toHaveLength(0);
    expect(await s.start(mine)).toMatchObject({ status: 200, body: { status: 'opening' } });
    // The owner is checked from the stored round, whatever the body claims.
    const deny = vi.fn(async () => { throw new HttpError(403, 'Not yours.'); });
    for (const verb of ['close', 'extend', 'reconcile', 'cancel']) {
      expect(await s.call('POST', `/game-api/rounds/round-000001/${verb}`, { accountId: mine, id: 'ext-000001', seconds: 300, secretKey: 'k' }, deny)).toMatchObject({ status: 403 });
    }
    expect(deny).toHaveBeenCalledWith(mine);
    expect(s.sends()).toHaveLength(1);
    expect(await s.call('POST', '/game-api/rounds/missing-round/close', {})).toMatchObject({ status: 400, body: { error: 'No active round found.' } });
  });

  it('cancels a round only while it is opening, through the engine for the stored owner', async () => {
    const s = setup({ tickOnRead: true });
    expect(await s.call('POST', '/game-api/rounds/missing-round/cancel', {})).toMatchObject({ status: 400, body: { error: 'No active round found.' } });
    expect(await s.start(mine)).toMatchObject({ status: 200, body: { status: 'opening', fill: { filledQuantity: 0, quantity: 5, quotes: 1, maker: true, fallback: false } } });
    // The stand-in fills the quote at once, so the cancel finds a fill: it is closed reduce-only and the round ends early.
    const cancelled = await s.call('POST', '/game-api/rounds/round-000001/cancel', {});
    expect(cancelled.status).toBe(200);
    expect(['closing', 'ended_early']).toContain(cancelled.body.status);
    expect(cancelled.body).toMatchObject({ openCancelRequested: true, cancelledOpening: true });
    expect(cancelled.body).not.toHaveProperty('credential');
    expect(s.sends().map(c => c[3].reduce_only ?? false)).toEqual([false, true]);
    s.setTime(104000);
    for (let i = 0; i < 4; i++) await s.call('GET', `/game-api/rounds?accountId=${mine}`);
    expect(await s.call('POST', '/game-api/rounds/round-000001/cancel', {})).toMatchObject({ status: 400, body: { error: 'No active round found.' } });
    const t = setup({ tickOnRead: true });
    await t.start(mine); t.setTime(101000); await t.call('GET', `/game-api/rounds?accountId=${mine}`);
    expect(await t.call('POST', '/game-api/rounds/round-000001/cancel', {})).toMatchObject({ status: 400, body: { error: expect.stringContaining('still opening') } });
    expect(t.sends()).toHaveLength(1);
  });

  it('advances due rounds on a rounds read only when tickOnRead is on', async () => {
    const off = setup();
    await off.start(mine); off.setTime(101000);
    expect((await off.call('GET', `/game-api/rounds?accountId=${mine}`)).body.rows[0].status).toBe('opening');
    const on = setup({ tickOnRead: true });
    await on.start(mine); on.setTime(101000);
    expect((await on.call('GET', `/game-api/rounds?accountId=${mine}`)).body.rows[0].status).toBe('open');
  });
});
