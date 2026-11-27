// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { ACKED_ORDER_NOT_FOUND_GRACE_MS, CONFIRMING_QUOTE_MESSAGE, MAKER_WINDOW_MS, MAKER_WINDOW_S, MAX_CLOSE_ATTEMPTS, MAX_ROUND_DURATION, needsTick, ORDER_NOT_FOUND_GRACE_MS, RoundEngine, ROUND_DURATIONS } from './engine.mjs';
import { createJournalStore } from './store.mjs';
import { createPostgresStore } from './postgres-store.mjs';
import { OrderlyError, orderQuantity, maxLeverage } from './orderly.mjs';
import { maxRoundDuration, roundDurations } from '../app/game/timing';

const accountId = '0x' + 'a'.repeat(64);
const input = { id: 'test-round-001', accountId, secretKey: 'test-only', symbol: 'PERP_BTC_USDC', direction: 'UP', duration: 300, margin: 10, leverage: 10, authorize: true };
function fixture() {
  let now = 100000;
  let journal: any[] = [];
  let position = 1;
  const orders = new Map<string, any>();
  const market = { symbol: input.symbol, status: 'ACTIVE', base_imr: .01, imr_factor: .000001, base_tick: .01, quote_tick: .1, base_min: .01, base_max: 10000, min_notional: 10 };
  // Top of the book: a quote for UP rests at the bid, for DOWN at the ask.
  let top = { bid: 100, ask: 100.1 };
  let resting = false;
  const book = () => ({ bids: [{ price: top.bid, quantity: 5 }], asks: [{ price: top.ask, quantity: 5 }], timestamp: now });
  const request = vi.fn(async (path: string, credential?: unknown, method = 'GET', body?: any): Promise<any> => {
    if (path === '/v1/client/info') return { account_id: accountId };
    if (path.startsWith('/v1/get_orderly_key?')) return { orderly_key: new URL(path, 'https://example.test').searchParams.get('orderly_key'), scope: 'read,trading', expiration: now + 86400000 };
    if (path === '/v1/positions' || path.includes('status=INCOMPLETE')) return { rows: [] };
    if (path.startsWith('/v1/position_history?')) return { rows: [] };
    if (path === '/v1/public/info') return { rows: [market] };
    if (path === '/v1/public/futures') return { rows: [{ symbol: input.symbol, mark_price: 100 }] };
    // Cap 10 keeps the forced (max) leverage equal to the fixture's historic 10x sizing.
    if (path === '/v1/public/leverage') return { max_futures_leverage: 10 };
    if (path.startsWith('/v1/orderbook/')) return book();
    if (path === '/v1/client/leverages') return {};
    if (path.startsWith('/v1/position/')) return { position_qty: position, mark_price: 101, margin_mode: 'ISOLATED' };
    if (path.startsWith('/v1/client/order/')) {
      const order = orders.get(decodeURIComponent(path.split('/').at(-1)!));
      if (!order) throw new OrderlyError('Order not found', true, -1006);
      return order;
    }
    if (path === '/v1/order' && method === 'POST') {
      // Journal must be durable BEFORE an order is sent.
      expect(journal[0].status).toBe(body.reduce_only ? 'closing' : 'opening');
      expect(body.client_order_id.length).toBeLessThanOrEqual(36);
      expect(body.margin_mode).toBe('ISOLATED');
      // The opening is a post-only quote at the top of the book; the fallback and every close are market orders.
      if (!body.reduce_only) expect(body.order_type).toBe(/-m\d*$/.test(body.client_order_id) ? 'MARKET' : 'POST_ONLY');
      // A quote snaps away from the spread: a bid down, an ask up, to quote_tick (.1).
      if (body.order_type === 'POST_ONLY') expect(body.order_price).toBeCloseTo(body.side === 'BUY' ? Math.floor(top.bid / .1 + 1e-9) * .1 : Math.ceil(top.ask / .1 - 1e-9) * .1, 10);
      // Resting mode: a quote sits on the book (NEW, nothing filled) until the test fills or cancels it.
      const rests = resting && body.order_type === 'POST_ONLY';
      orders.set(body.client_order_id, { status: rests ? 'NEW' : 'FILLED', total_executed_quantity: rests ? 0 : body.order_quantity, average_executed_price: rests ? 0 : body.reduce_only ? 101 : body.order_price ?? 100, total_fee: rests ? 0 : .03, updated_time: now, order_id: orders.size + 1 });
      if (body.reduce_only) position = 0;
      return { order_id: orders.size };
    }
    if (path.startsWith('/v1/client/order?') && method === 'DELETE') {
      const order = orders.get(new URL(path, 'https://example.test').searchParams.get('client_order_id')!);
      if (!order) throw new OrderlyError('Order not found', true, -1006);
      if (['FILLED', 'CANCELLED', 'REJECTED'].includes(order.status)) throw new OrderlyError('Order already closed', true, -1004);
      order.status = 'CANCELLED';
      return { status: 'CANCEL_SENT' };
    }
    throw new Error('Unexpected request: ' + path);
  });
  // The persisted journal; each create() is a fresh process that reloads it.
  const persistence = { load: () => structuredClone(journal), save: (rounds: any[]) => { journal = structuredClone(rounds); } };
  const create = () => new RoundEngine({ request, store: createJournalStore(persistence), network: 'testnet', brokerId: 'cato', now: () => now, maker: true });
  return { create, request, orders, persistence, journal: () => structuredClone(journal), setTime: (n: number) => { now = n; }, setPosition: (n: number) => { position = n; }, setTop: (bid: number, ask: number) => { top = { bid, ask }; }, setResting: (on: boolean) => { resting = on; }, market };
}
describe('timed rounds', () => {
  // Opening fill at 100000 + 300s round = deadline 400000. Time can be added at any point while the round is open.
  const deadline = 400000, nearEnd = 370000;
  const extension = { id: 'extension-001', seconds: 600, accountId, secretKey: '11111111111111111111111111111111' };
  it('only accepts 5, 10, 15 and 30 minute rounds', async () => {
    expect(ROUND_DURATIONS).toEqual([300, 600, 900, 1800]);
    expect(roundDurations.map(([seconds]) => seconds)).toEqual(ROUND_DURATIONS);
    for (const duration of [30, 60, 180, 120, 0, 3600, '300']) {
      const f = fixture();
      await expect(f.create().start({ ...input, duration } as any)).rejects.toThrow('Invalid round settings');
      expect(f.request).not.toHaveBeenCalled();
    }
    for (const duration of ROUND_DURATIONS) {
      const f = fixture(), e = f.create(); await e.start({ ...input, duration }); await e.tick();
      expect((await e.list(accountId))[0]).toMatchObject({ status: 'open', duration, deadline: 100000 + duration * 1000 });
    }
    const f = fixture(), e = f.create(); await e.start({ ...input, duration: 1800 }); await e.tick();
    f.setTime(1899999); await e.tick();
    expect((await e.list(accountId))[0].status).toBe('open');
    f.setTime(1900000); await e.tick();
    expect((await e.list(accountId))[0].status).toBe('closing');
  });
  it('accepts the real account-info shape without broker_id and still rejects mismatched or missing identity', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick(); f.setTime(nearEnd);
    const original = f.request.getMockImplementation()!;
    for (const info of [{}, { account_id: '0x' + 'b'.repeat(64) }, { account_id: accountId, broker_id: 'another-broker' }]) {
      f.request.mockImplementation(async (...args) => args[0] === '/v1/client/info' ? info : original(...args));
      await expect(e.extend(input.id, extension)).rejects.toThrow('Account authorization does not match');
      expect((await e.list(accountId))[0].deadline).toBe(deadline);
      expect((await e.list(accountId))[0].extensions).toBeUndefined();
    }
    f.request.mockImplementation(original);
    await e.extend(input.id, extension);
    expect((await e.list(accountId))[0]).toMatchObject({ deadline: 1000000, duration: 900 });
  });
  it('extends once per request ID, persists across restart and closes at the new deadline', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick(); f.setTime(nearEnd);
    await Promise.all([e.extend(input.id, extension), e.extend(input.id, extension)]);
    expect((await e.list(accountId))[0]).toMatchObject({ duration: 900, deadline: 1000000 });
    expect((await e.list(accountId))[0].extensions).toHaveLength(1);
    expect((await e.list(accountId))[0]).not.toHaveProperty('credential');
    const restarted = f.create();
    f.setTime(deadline); await restarted.tick();
    expect(f.request.mock.calls.filter(c => c[0] === '/v1/order')).toHaveLength(1);
    f.setTime(999999); await restarted.tick();
    expect((await restarted.list(accountId))[0].status).toBe('open');
    f.setTime(1000000); await restarted.tick();
    expect((await restarted.list(accountId))[0].status).toBe('closing');
    expect(f.request.mock.calls.filter(c => c[0] === '/v1/order')).toHaveLength(2);
  });
  it('adds time at any point while the round is open, repeatedly, up to a two-hour total', async () => {
    expect(MAX_ROUND_DURATION).toBe(7200);
    expect(maxRoundDuration).toBe(MAX_ROUND_DURATION);
    const f = fixture(), e = f.create(); await e.start({ ...input, duration: 600 }); await e.tick();
    // Right after the opening fill, with the full 10 minutes left.
    await e.extend(input.id, extension);
    expect((await e.list(accountId))[0]).toMatchObject({ duration: 1200, deadline: 1300000 });
    f.setTime(640000);
    await e.extend(input.id, { ...extension, id: 'extension-002', seconds: 1800 });
    f.setTime(1299999);
    await e.extend(input.id, { ...extension, id: 'extension-003', seconds: 1800 });
    expect((await e.list(accountId))[0]).toMatchObject({ duration: 4800, deadline: 700000 + 4200 * 1000 });
    expect((await e.list(accountId))[0].extensions).toHaveLength(3);
    expect(f.request.mock.calls.filter(c => c[0] === '/v1/order')).toHaveLength(1);
  });
  it('caps the total round length at two hours including added time, without touching the account', async () => {
    const f = fixture(), e = f.create(); await e.start({ ...input, duration: 1800 }); await e.tick();
    for (const [i, seconds] of [1800, 1800].entries()) await e.extend(input.id, { ...extension, id: `extension-cap-${i}`, seconds });
    expect((await e.list(accountId))[0].duration).toBe(5400);
    const before = f.request.mock.calls.length;
    // 5400 + 1800 = 7200 fits exactly; anything past it is refused before any authorization request.
    await e.extend(input.id, { ...extension, id: 'extension-cap-last', seconds: 1800 });
    expect((await e.list(accountId))[0]).toMatchObject({ duration: MAX_ROUND_DURATION, deadline: 100000 + MAX_ROUND_DURATION * 1000 });
    const full = f.request.mock.calls.length;
    await expect(e.extend(input.id, { ...extension, id: 'extension-over', seconds: 300 })).rejects.toThrow('at most 2 hours');
    expect(f.request.mock.calls.length).toBe(full);
    expect(before).toBeLessThan(full);
    expect((await e.list(accountId))[0].extensions).toHaveLength(3);
    // Repeating an accepted ID stays idempotent even at the cap.
    await e.extend(input.id, { ...extension, id: 'extension-cap-last', seconds: 1800 });
    expect((await e.list(accountId))[0].duration).toBe(MAX_ROUND_DURATION);
  });
  it('rejects wrong accounts, unsupported increments and expired or closing rounds', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick();
    await expect(e.extend(input.id, { ...extension, accountId: '0x' + 'b'.repeat(64) })).rejects.toThrow('connected account');
    for (const seconds of [30, 60, 180, 120, 3600]) await expect(e.extend(input.id, { ...extension, seconds })).rejects.toThrow('Invalid extension');
    f.setTime(deadline);
    await expect(e.extend(input.id, extension)).rejects.toThrow('expired');
    await e.tick();
    await expect(e.extend(input.id, extension)).rejects.toThrow('closing');
  });
  it('does not postpone a due close while extension authentication is pending', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick();
    const original = f.request.getMockImplementation()!;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.request.mockImplementation(async (...args) => { if (args[0] === '/v1/client/info') { entered(); await gate; } return original(...args); });
    f.setTime(nearEnd);
    const pending = e.extend(input.id, extension);
    const rejection = expect(pending).rejects.toThrow('closing');
    await started; f.setTime(deadline); await e.tick();
    expect((await e.list(accountId))[0].status).toBe('closing');
    release(); await rejection;
    expect((await e.list(accountId))[0].deadline).toBe(deadline);
  });
  it('checks trading scope and expiry and durably rotates a renewed credential', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick(); f.setTime(nearEnd);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => args[0].startsWith('/v1/get_orderly_key?') ? { ...await original(...args), expiration: 1000000 + 60000 } : original(...args));
    await expect(e.extend(input.id, extension)).rejects.toThrow('expires too soon');
    expect((await e.list(accountId))[0].deadline).toBe(deadline);
    f.request.mockImplementation(async (...args) => args[0].startsWith('/v1/get_orderly_key?') ? { ...await original(...args), scope: 'read,trading,asset' } : original(...args));
    await expect(e.extend(input.id, extension)).rejects.toThrow('dedicated');
    f.request.mockImplementation(original);
    await e.extend(input.id, extension);
    expect(f.journal()[0].credential.secretKey).toBe(extension.secretKey);
    expect(f.journal()[0].keyExpiration).toBe(nearEnd + 86400000);
  });
  it('rolls back a deadline update if the journal cannot persist it', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick(); f.setTime(nearEnd);
    vi.spyOn(f.persistence, 'save').mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    await expect(e.extend(input.id, extension)).rejects.toThrow('disk unavailable');
    expect((await e.list(accountId))[0]).toMatchObject({ duration: 300, deadline });
    expect((await e.store.get(input.id)).credential.secretKey).toBe('test-only');
    expect((await f.create().list(accountId))[0].deadline).toBe(deadline);
  });
  it('opens once, waits the round duration after fill, closes reduce-only, and reconciles fees', async () => {
    const f = fixture(), e = f.create();
    await e.start(input); await e.start(input); await e.tick();
    expect((await e.list(accountId))[0].status).toBe('open');
    expect(f.request.mock.calls.filter(c => c[0] === '/v1/order')).toHaveLength(1);
    f.setTime(deadline - 1); await e.tick();
    expect(f.request.mock.calls.filter(c => c[0] === '/v1/order')).toHaveLength(1);
    f.setTime(deadline); await e.tick(); await e.tick(); await e.tick(); await e.tick(); await e.tick();
    const close = f.request.mock.calls.filter(c => c[0] === '/v1/order')[1][3];
    expect(close).toMatchObject({ reduce_only: true, side: 'SELL', order_quantity: 1, margin_mode: 'ISOLATED' });
    expect((await e.list(accountId))[0]).toMatchObject({ status: 'closed', tradingPnl: .94 });
    expect((await e.store.get(input.id)).credential).toBeUndefined();
    expect((await e.list(accountId))[0]).not.toHaveProperty('credential');
  });
  it('recovers the persisted deadline on restart without another opening order', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick();
    const restarted = f.create(); f.setTime(deadline + 10000); await restarted.tick();
    expect(f.request.mock.calls.filter(c => c[0] === '/v1/order')).toHaveLength(2);
    expect((await restarted.list(accountId))[0].status).toBe('closing');
  });
  it('does not duplicate an opening order when the POST response was lost', async () => {
    const f = fixture(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => { const response = await original(...args); if (args[0] === '/v1/order') throw new Error('Connection lost'); return response; });
    const e = f.create(); await e.start(input); await e.tick();
    expect((await e.list(accountId))[0].status).toBe('open');
    expect(f.request.mock.calls.filter(c => c[0] === '/v1/order')).toHaveLength(1);
  });
  it('keeps an unresolved closing request pending rather than blindly resubmitting', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => { if (args[0] === '/v1/order') throw new Error('Unknown acceptance'); return original(...args); });
    f.setTime(deadline + 1000); await e.tick(); await e.tick(); await e.tick();
    expect((await e.list(accountId))[0].status).toBe('closing');
    expect(f.request.mock.calls.filter(c => c[0] === '/v1/order')).toHaveLength(2);
  });
  it('keeps the actually filled quantity when the fallback market order only partially fills', async () => {
    const f = fixture(), e = f.create(); f.setResting(true); await e.start(input);
    // The quote rests unfilled for the whole maker window; the market fallback for the remainder fills only .6.
    f.setTime(100000 + MAKER_WINDOW_MS); await e.tick(); await e.tick();
    const market = [...f.orders.values()][1]; market.status = 'CANCELLED'; market.total_executed_quantity = .6;
    f.setPosition(.6); await e.tick();
    expect((await e.list(accountId))[0]).toMatchObject({ status: 'open', quantity: .6, fill: { filledQuantity: .6, quantity: 1, quotes: 1, maker: false, fallback: true } });
    f.setTime(deadline + MAKER_WINDOW_MS + 1000); await e.tick();
    expect(f.request.mock.calls.filter(c => c[0] === '/v1/order').at(-1)![3]).toMatchObject({ reduce_only: true, order_quantity: .6 });
  });
  it('still finishes a round opened by the previous market-order flow with whatever that order filled', async () => {
    const f = fixture(), e = f.create(); await e.start(input);
    // A row journalled before maker quotes existed: one market order under openClientId, no attempts list.
    const legacy = f.journal()[0];
    delete legacy.openAttempts; delete legacy.openSeq; delete legacy.fill;
    legacy.openClientId = `${legacy.orderPrefix}-o`; legacy.openRequestedAt = 100000; legacy.openAckAt = 100000;
    f.orders.set(legacy.openClientId, { status: 'CANCELLED', total_executed_quantity: .6, average_executed_price: 100, total_fee: .018, updated_time: 100500, order_id: 77 });
    f.persistence.save([legacy]);
    const restarted = f.create(); f.setPosition(.6); await restarted.tick();
    expect((await restarted.list(accountId))[0]).toMatchObject({ status: 'open', quantity: .6, entryPrice: 100, openFee: .018, openedAt: 100500, deadline: 400500 });
    f.setTime(400500); await restarted.tick();
    expect(f.request.mock.calls.filter(c => c[0] === '/v1/order').at(-1)![3]).toMatchObject({ reduce_only: true, order_quantity: .6 });
  });
  it('blocks existing positions and concurrent rounds', async () => {
    const f = fixture(), e = f.create(); await e.start(input);
    await expect(e.start({ ...input, id: 'test-round-002' })).rejects.toThrow('active round');
    const f2 = fixture(); const original = f2.request.getMockImplementation()!;
    f2.request.mockImplementation(async (...args) => args[0] === '/v1/positions' ? { rows: [{ position_qty: 1 }] } : original(...args));
    await expect(f2.create().start(input)).rejects.toThrow('existing positions');
    expect(f2.request.mock.calls.some(c => c[0] === '/v1/order')).toBe(false);
  });
  it('never invents a payout when a position is liquidated or closed elsewhere', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick(); f.setPosition(0); f.setTime(105000);
    await e.tick(); await e.tick(); await e.tick();
    expect((await e.list(accountId))[0].status).toBe('ended_early');
    expect((await e.list(accountId))[0].tradingPnl).toBeUndefined();
    expect(f.request.mock.calls.filter(c => c[0] === '/v1/order')).toHaveLength(1);
  });
  it('recovers a legacy result using a supplied account key without keeping or returning that key', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick(); f.setPosition(0); f.setTime(105000);
    await e.tick(); await e.tick(); await e.tick();
    { const r = await e.store.get(input.id); delete r.credential; await e.save(r); }
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => args[0].startsWith('/v1/position_history?') ? { rows: [{
      position_id: 123, position_status: 'closed', type: 'liquidated', symbol: input.symbol, margin_mode: 'ISOLATED',
      side: 'LONG', max_position_qty: 1, closed_position_qty: 1, avg_open_price: 100, avg_close_price: 99,
      open_timestamp: 100000, close_timestamp: 104000, realized_pnl: -1.5, trading_fee: .03, accumulated_funding_fee: 0,
    }] } : original(...args));
    await expect(e.recoverResult(input.id, { accountId: 'wrong', secretKey: 'saved-device-key' })).rejects.toThrow('Connect the account');
    const result = await e.recoverResult(input.id, { accountId, secretKey: 'saved-device-key' });
    expect(result).toMatchObject({ closeReason: 'liquidation', netPnl: -1.53 });
    expect(JSON.stringify(result)).not.toContain('saved-device-key');
    expect((await e.store.get(input.id)).credential).toBeUndefined();
    expect((await f.create().list(accountId))[0].netPnl).toBe(-1.53);
    expect(f.request.mock.calls.filter(c => c[0] === '/v1/order')).toHaveLength(1);
  });
  it('reconciles a delayed liquidation result after restart without placing any more orders', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick(); f.setPosition(0); f.setTime(105000);
    await e.tick(); await e.tick(); await e.tick();
    expect((await e.list(accountId))[0]).toMatchObject({ status: 'ended_early', resultPending: true });
    expect((await e.store.get(input.id)).credential).toBeDefined();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => args[0].startsWith('/v1/position_history?') ? { rows: [{
      position_id: 123, position_status: 'closed', type: 'liquidated', symbol: input.symbol, margin_mode: 'ISOLATED',
      side: 'LONG', max_position_qty: 1, closed_position_qty: 1, avg_open_price: 100, avg_close_price: 99,
      open_timestamp: 100000, close_timestamp: 104000, realized_pnl: -1.5, trading_fee: .03, accumulated_funding_fee: 0,
    }] } : original(...args));
    const restarted = f.create(); f.setTime(115001); await restarted.tick();
    expect((await restarted.list(accountId))[0]).toMatchObject({ status: 'closed', closeReason: 'liquidation', netPnl: -1.53, resultPending: false });
    expect((await restarted.store.get(input.id)).credential).toBeUndefined();
    expect(f.request.mock.calls.filter(c => c[0] === '/v1/order')).toHaveLength(1);
  });
  it('does not accept a network change while a round is active', async () => {
    const f = fixture(), e = f.create(); await e.start(input);
    expect(() => new RoundEngine({ request: f.request, store: createJournalStore(f.persistence), network: 'mainnet', brokerId: 'cato' })).toThrow('another network');
  });
  it('rejects an amount below the market minimum and sizes to the quantity tick', () => {
    const f = fixture();
    expect(() => orderQuantity(.1, 1, 100, f.market)).toThrow('order-size');
    expect(orderQuantity(10.1234, 10, 100, f.market)).toBe(1.01);
    expect(maxLeverage(f.market, 10, 50)).toBe(50);
    expect(maxLeverage(f.market, 100000, 100)).toBeLessThan(100);
  });
  it('plays BTC only: any other symbol is refused before anything is read or sent', async () => {
    const f = fixture(), e = f.create();
    for (const symbol of ['PERP_SOL_USDC', 'PERP_ETH_USDC', '', undefined]) {
      await expect(e.start({ ...input, symbol } as any)).rejects.toThrow('Only BTC is playable.');
    }
    expect(f.request).not.toHaveBeenCalled();
    expect(f.journal()).toEqual([]);
  });
  it('forces the market\'s live maximum leverage for the amount, whatever the client sent', async () => {
    const f = fixture();
    // The exchange cap is the binding limit here (fixture market allows 100x at $10).
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path: string, ...rest: any[]) => path === '/v1/public/leverage' ? { max_futures_leverage: 25 } : original(path, ...rest));
    for (const [id, leverage] of [['test-round-lev-1', 3], ['test-round-lev-2', 1000], ['test-round-lev-3', 'max'], ['test-round-lev-4', undefined]] as const) {
      const e = f.create();
      const round = await e.start({ ...input, id, leverage } as any);
      expect(round).toMatchObject({ status: 'opening', leverage: 25, quantity: orderQuantity(10, 25, 100, f.market) });
      expect(f.request).toHaveBeenCalledWith('/v1/client/leverages', expect.anything(), 'POST', { symbol: 'PERP_BTC_USDC', leverage: 25, margin_mode: 'ISOLATED' });
      // Clear the journal between starts (one active round per account).
      f.persistence.save([]);
    }
  });
});

describe('stateless scheduling', () => {
  const deadline = 400000;
  const orderCalls = (f: ReturnType<typeof fixture>) => f.request.mock.calls.filter(c => c[0] === '/v1/order');
  it('sends one close when many schedulers tick the same round at once', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick();
    // Several "invocations" sharing one store, as the sweep and players' polls do.
    const store = (e as any).store;
    const engines = Array.from({ length: 5 }, () => new RoundEngine({ request: f.request, store, network: 'testnet', brokerId: 'cato', now: () => deadline, maker: true }));
    f.setTime(deadline);
    await Promise.all(engines.map(x => x.tick()));
    await Promise.all(engines.map(x => x.tickRound(input.id)));
    expect(orderCalls(f)).toHaveLength(2);
    expect(orderCalls(f)[1][3]).toMatchObject({ reduce_only: true, client_order_id: expect.stringMatching(/-c0$/) });
  });
  it('throttles repeated ticks to minTickMs and persists the tick time in the round', async () => {
    const f = fixture();
    const persistence = f.persistence;
    const e = new RoundEngine({ request: f.request, store: createJournalStore(persistence), network: 'testnet', brokerId: 'cato', now: () => 100000, minTickMs: 900, maker: true });
    await e.start(input);
    await e.tick();
    expect(f.journal()[0]).toMatchObject({ status: 'open', tickedAt: 100000 });
    const reads = f.request.mock.calls.length;
    await e.tick(); await e.tickRound(input.id);
    expect(f.request.mock.calls.length).toBe(reads);
    await e.tickRound(input.id, { force: true });
    expect(f.request.mock.calls.length).toBeGreaterThan(reads);
  });
  it('closes early right away for the owner only', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick();
    await expect(e.close(input.id, '0x' + 'b'.repeat(64))).rejects.toThrow('No active round');
    expect(orderCalls(f)).toHaveLength(1);
    const closing = await e.close(input.id, accountId);
    expect(closing.status).toBe('closing');
    expect(orderCalls(f)).toHaveLength(2);
    expect(closing).not.toHaveProperty('credential');
  });
  it('does not fail a round that is still being started, but fails an abandoned preparing round', async () => {
    const f = fixture(), e = f.create();
    const original = f.request.getMockImplementation()!;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    f.request.mockImplementation(async (...args) => { if (args[0] === '/v1/client/leverages') { entered(); await gate; } return original(...args); });
    const starting = e.start(input);
    await reached;
    expect(f.journal()[0].status).toBe('preparing');
    await e.tick();
    expect(f.journal()[0].status).toBe('preparing');
    release(); await starting;
    expect(f.journal()[0].status).toBe('opening');
    // A starter that died after its insert leaves a 'preparing' row with no lock.
    const g = fixture();
    g.persistence.save([{ ...f.journal()[0], status: 'preparing', id: 'abandoned-001' }]);
    const restarted = g.create(); await restarted.tick();
    expect(g.journal()[0]).toMatchObject({ status: 'failed' });
    expect(g.journal()[0]).not.toHaveProperty('credential');
    expect(orderCalls(g)).toHaveLength(0);
  });
});

describe('orders that never reach Orderly', () => {
  const deadline = 400000;
  const grace = ORDER_NOT_FOUND_GRACE_MS;
  const sends = (f: ReturnType<typeof fixture>) => f.request.mock.calls.filter(c => c[0] === '/v1/order' && c[2] === 'POST').map(c => c[3]);
  const round = async (e: RoundEngine) => (await e.store.get(input.id)) as any;
  /** No row without pending work keeps a credential. */
  const noStaleCredential = (f: ReturnType<typeof fixture>) => {
    for (const r of f.journal()) if (!needsTick(r)) expect(r).not.toHaveProperty('credential');
  };
  const history = (overrides: Record<string, unknown> = {}) => ({ rows: [{
    position_id: 7, position_status: 'closed', type: 'manual', symbol: input.symbol, margin_mode: 'ISOLATED', side: 'LONG',
    max_position_qty: 1, closed_position_qty: 1, avg_open_price: 100, avg_close_price: 101,
    open_timestamp: 100000, close_timestamp: 401000, realized_pnl: 1, trading_fee: .06, accumulated_funding_fee: 0, ...overrides,
  }] });
  /** Wrap the fixture's exchange: `send` sees each order POST first and may throw instead of letting it through. */
  const intercept = (f: ReturnType<typeof fixture>, send: (body: any) => void, extra: (path: string) => any = () => undefined) => {
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args: any[]) => {
      if (args[0] === '/v1/order' && args[2] === 'POST') send(args[3]);
      const replaced = extra(args[0]);
      if (replaced !== undefined) return replaced;
      return original(...(args as [string]));
    });
  };

  it('finishes a close whose POST failed in transit with a second reduce-only close after the grace period', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick();
    intercept(f, body => { if (body.client_order_id.endsWith('-c0')) throw new TypeError('fetch failed'); });
    f.setTime(deadline); await e.tick();
    expect(await round(e)).toMatchObject({ status: 'closing', error: 'fetch failed', closeAttempts: [{ terminal: false, sendFailedAt: deadline }] });
    // Orderly has no such order. Within the grace period nothing else is sent.
    f.setTime(deadline + grace - 1); await e.tick(); await e.tick();
    expect(sends(f)).toHaveLength(2);
    f.setTime(deadline + grace); await e.tick();
    expect((await round(e)).closeAttempts[0]).toMatchObject({ terminal: true, abandoned: true, quantity: 0 });
    expect(sends(f)).toHaveLength(2);
    await e.tick();
    expect(sends(f)).toHaveLength(3);
    expect(sends(f)[2]).toMatchObject({ reduce_only: true, side: 'SELL', order_quantity: 1, client_order_id: expect.stringMatching(/-c1$/) });
    f.setTime(deadline + grace + 5000);
    for (let i = 0; i < 5; i++) await e.tick();
    expect(await round(e)).toMatchObject({ status: 'closed', tradingPnl: .94 });
    expect((await round(e)).closeAttempts[0]).toMatchObject({ rechecked: true, quantity: 0 });
    expect(sends(f)).toHaveLength(3);
    noStaleCredential(f);
  });

  it('counts an abandoned close that arrived late with its real fill', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick();
    let visible = false;
    // c0 reaches Orderly and partly fills, but neither its fill nor the order is visible for a while.
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args: any[]) => {
      const path = String(args[0]);
      if (path === '/v1/order' && args[3]?.client_order_id.endsWith('-c0')) {
        f.orders.set(args[3].client_order_id, { status: 'FILLED', total_executed_quantity: .4, average_executed_price: 101, total_fee: .012, updated_time: deadline });
        return { order_id: 9 };
      }
      if (path.startsWith('/v1/client/order/') && path.endsWith('-c0') && !visible) throw new OrderlyError('Order not found', true, -1006);
      return original(...(args as [string]));
    });
    f.setTime(deadline); await e.tick();
    // Orderly acknowledged it, so the wait before giving up on it is longer.
    f.setTime(deadline + grace); await e.tick();
    expect((await round(e)).closeAttempts[0]).toMatchObject({ terminal: false, ackAt: deadline });
    f.setTime(deadline + ACKED_ORDER_NOT_FOUND_GRACE_MS); await e.tick();
    expect((await round(e)).closeAttempts[0]).toMatchObject({ abandoned: true, quantity: 0 });
    f.setPosition(.6); await e.tick();
    // The next close is reduce-only for what is actually left.
    expect(sends(f).at(-1)).toMatchObject({ reduce_only: true, order_quantity: .6, client_order_id: expect.stringMatching(/-c1$/) });
    visible = true;
    f.setTime(deadline + ACKED_ORDER_NOT_FOUND_GRACE_MS + 5000); for (let i = 0; i < 5; i++) await e.tick();
    const r = await round(e);
    expect(r).toMatchObject({ status: 'closed', exitPrice: 101 });
    expect(r.tradingPnl).toBeCloseTo(1 - (.03 + .012 + .03), 10);
    expect(r.closeAttempts[0]).toMatchObject({ abandoned: true, rechecked: true, lateFill: true, quantity: .4 });
    expect(sends(f)).toHaveLength(3);
  });

  it('fails an opening whose orders never reached Orderly once the account shows no position, never resending blindly', async () => {
    const f = fixture(); f.setPosition(0);
    intercept(f, body => { if (!body.reduce_only) throw new TypeError('fetch failed'); });
    const e = f.create();
    const started = await e.start(input);
    expect(started).toMatchObject({ status: 'opening', error: 'fetch failed' });
    expect(started.openAttempts[0]).toMatchObject({ type: 'POST_ONLY', sendFailedAt: 100000, terminal: false });
    await e.tick();
    f.setTime(100000 + grace - 1); await e.tick();
    expect((await round(e)).status).toBe('opening');
    expect(sends(f)).toHaveLength(1);
    // Past the grace with no position, the quote is abandoned (and a cancel sent for safety); the maker window is
    // long gone, so the replacement is the market fallback, which also never arrives.
    f.setTime(100000 + grace); await e.tick();
    expect((await round(e)).openAttempts[0]).toMatchObject({ terminal: true, abandoned: true, filled: 0, cancel: { reason: 'abandoned' } });
    await e.tick();
    expect(sends(f)).toHaveLength(2);
    expect(sends(f)[1]).toMatchObject({ order_type: 'MARKET', order_quantity: 1, client_order_id: expect.stringMatching(/-m$/) });
    f.setTime(100000 + 2 * grace); await e.tick();
    expect(await round(e)).toMatchObject({ status: 'failed', error: expect.stringContaining('No position was opened') });
    expect((await round(e)).credential).toBeUndefined();
    expect(sends(f)).toHaveLength(2);
    // The account is free again.
    expect(await e.start({ ...input, id: 'test-round-002' })).toMatchObject({ status: 'opening' });
  });

  it('adopts the position of an opening order it could not find, closes it on time and confirms the result from history', async () => {
    const f = fixture(); // position_qty 1 = this round's planned quantity
    let closedHistory = false;
    intercept(f, body => { if (!body.reduce_only) throw new TypeError('fetch failed'); }, path =>
      path.startsWith('/v1/position_history?') ? (closedHistory ? history() : { rows: [] }) : undefined);
    const wrapped = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args: any[]) => {
      const result = await wrapped(...(args as [string]));
      return String(args[0]).startsWith('/v1/position/') ? { ...result, average_open_price: 100 } : result;
    });
    const e = f.create(); await e.start(input);
    f.setTime(100000 + grace); await e.tick();
    expect(await round(e)).toMatchObject({ status: 'open', adopted: true, quantity: 1, entryPrice: 100, openedAt: 100000 + grace, deadline });
    f.setTime(deadline); await e.tick();
    expect(sends(f).at(-1)).toMatchObject({ reduce_only: true, side: 'SELL', order_quantity: 1 });
    closedHistory = true;
    f.setTime(deadline + 5000);
    for (let i = 0; i < 5; i++) await e.tick();
    expect(await round(e)).toMatchObject({ status: 'closed', resultSource: 'position_history', tradingPnl: .94 });
    expect((await round(e)).closeReason).toBeUndefined();
    expect(sends(f).filter(o => !o.reduce_only)).toHaveLength(1);
    noStaleCredential(f);
  });

  it("leaves a position that is not this round's alone when the opening order is missing", async () => {
    const f = fixture(); f.setPosition(-1);
    intercept(f, body => { if (!body.reduce_only) throw new TypeError('fetch failed'); });
    const e = f.create(); await e.start(input);
    f.setTime(100000 + grace); await e.tick();
    expect(await round(e)).toMatchObject({ status: 'failed', error: expect.stringContaining('left untouched') });
    expect(sends(f)).toHaveLength(1);
    noStaleCredential(f);
  });

  it('finalises a round flattened by hand while its close never reached Orderly', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick();
    intercept(f, body => { if (body.reduce_only) throw new TypeError('fetch failed'); }, path =>
      path.startsWith('/v1/position_history?') ? history({ close_timestamp: 400500 }) : undefined);
    f.setTime(deadline); await e.tick();
    f.setPosition(0); // closed in Portfolio
    f.setTime(deadline + 1000); for (let i = 0; i < 4; i++) await e.tick();
    // Flat is detected, but the unresolved attempt gets its grace period first.
    expect(await round(e)).toMatchObject({ status: 'closing', flatChecks: 4 });
    f.setTime(deadline + grace); await e.tick();
    expect(await round(e)).toMatchObject({ status: 'closed', closeReason: 'external', resultSource: 'position_history', tradingPnl: .94 });
    expect(sends(f)).toHaveLength(2);
    noStaleCredential(f);
  });

  it('backs off after definitive close rejections and keeps the stored attempts bounded', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick();
    intercept(f, body => { if (body.reduce_only) throw new OrderlyError('orderly key error', true, -1002); });
    f.setTime(deadline); await e.tick();
    expect(await round(e)).toMatchObject({ status: 'closing', closeFailures: 1, closeRetryAt: deadline + 2000, error: expect.stringContaining('Orderly rejected the closing order (orderly key error)') });
    f.setTime(deadline + 1999); await e.tick();
    expect(sends(f)).toHaveLength(2);
    f.setTime(deadline + 2000); await e.tick();
    expect(sends(f)).toHaveLength(3);
    expect((await round(e)).closeRetryAt).toBe(deadline + 2000 + 4000);
    // Hours of rejections: the wait caps at 5 minutes and the journal stays small.
    for (let i = 0; i < 40; i++) { f.setTime((await round(e)).closeRetryAt); await e.tick(); }
    const r = await round(e);
    expect(r.closeAttempts.length).toBeLessThanOrEqual(MAX_CLOSE_ATTEMPTS);
    expect(r.closeFailures).toBe(42);
    expect(r.droppedCloseAttempts).toBe(42 - r.closeAttempts.length);
    const ids = sends(f).slice(1).map(o => o.client_order_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.closeAttempts.at(-1).clientId).toMatch(/-c41$/);
    expect(r.error).toContain('Retrying in 300s');
    expect(r.credential).toBeDefined();
    // The player's own Close request tries once more right away.
    const before = sends(f).length;
    await e.close(input.id, accountId);
    expect(sends(f)).toHaveLength(before + 1);
  });

  it('backs off a round whose reads keep failing definitively, but not an explicit close', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args: any[]) => {
      if (String(args[0]).startsWith('/v1/position/')) throw new OrderlyError('orderly key error', true, -1002);
      return original(...(args as [string]));
    });
    f.setTime(200000); await e.tick();
    expect(await round(e)).toMatchObject({ errorCount: 1, retryAt: 201000, error: 'orderly key error' });
    const reads = f.request.mock.calls.length;
    await e.tick();
    expect(f.request.mock.calls.length).toBe(reads);
    f.setTime(201000); await e.tick();
    expect(await round(e)).toMatchObject({ errorCount: 2, retryAt: 203000 });
    f.request.mockImplementation(original);
    await e.tickRound(input.id, { force: true });
    expect(await round(e)).not.toHaveProperty('retryAt');
  });

  it('treats account IDs case-insensitively everywhere', async () => {
    const f = fixture(), e = f.create();
    const upper = '0x' + 'A'.repeat(64);
    expect(await e.start({ ...input, accountId: upper })).toMatchObject({ accountId });
    await expect(e.start({ ...input, id: 'test-round-002', accountId })).rejects.toThrow('active round');
    await expect(e.start({ ...input, id: 'test-round-003', accountId: '0x' + 'aA'.repeat(32) })).rejects.toThrow('active round');
    expect(await e.list(upper)).toHaveLength(1);
    await e.tick({ accountId: upper });
    expect((await e.list(accountId))[0].status).toBe('open');
    expect(f.request.mock.calls.find(c => c[0] === '/v1/order')![1]).toMatchObject({ accountId });
    expect((await e.close(input.id, upper)).status).toBe('closing');
  });

  it('records closeNow without waiting when another invocation holds the round', async () => {
    const f = fixture(), e = f.create(); await e.start(input); await e.tick();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = e.store.withLock([`round:${input.id}`], () => gate);
    const closing = await e.close(input.id, accountId);
    expect(closing).toMatchObject({ closeNow: true, status: 'open' });
    release(); await holding;
    await e.tick();
    expect((await round(e)).status).toBe('closing');
  });
});

describe('maker opening', () => {
  const deadline = 400000;
  const grace = ORDER_NOT_FOUND_GRACE_MS;
  const sends = (f: ReturnType<typeof fixture>) => f.request.mock.calls.filter(c => c[0] === '/v1/order' && c[2] === 'POST').map(c => c[3]);
  const cancels = (f: ReturnType<typeof fixture>) => f.request.mock.calls.filter(c => c[2] === 'DELETE').map(c => new URL(String(c[0]), 'https://example.test').searchParams.get('client_order_id'));
  const round = async (e: RoundEngine) => (await e.store.get(input.id)) as any;
  const order = (f: ReturnType<typeof fixture>, suffix: string) => f.orders.get([...f.orders.keys()].find(k => k.endsWith(suffix))!);
  /** Orderly reports (more of) a fill on a resting or cancelled order. */
  const fill = (f: ReturnType<typeof fixture>, suffix: string, quantity: number, price: number, fee: number, time: number, status = 'FILLED') =>
    Object.assign(order(f, suffix), { status, total_executed_quantity: quantity, average_executed_price: price, total_fee: fee, updated_time: time });

  it('opens with one post-only quote at the best bid for UP, at the best ask for DOWN, snapped to the quote tick', async () => {
    expect(MAKER_WINDOW_S).toBe(20);
    const f = fixture(), e = f.create();
    const started = await e.start(input);
    expect(sends(f)).toEqual([expect.objectContaining({ order_type: 'POST_ONLY', side: 'BUY', order_price: 100, order_quantity: 1, margin_mode: 'ISOLATED', client_order_id: `${started.orderPrefix}-q0` })]);
    expect(started.fill).toEqual({ filledQuantity: 0, quantity: 1, quotes: 1, maker: true, fallback: false });
    expect(started).not.toHaveProperty('credential');
    await e.tick();
    expect(await round(e)).toMatchObject({ status: 'open', entryPrice: 100, openFee: .03, quantity: 1, openedAt: 100000, deadline, fill: { filledQuantity: 1, quantity: 1, quotes: 1, maker: true, fallback: false } });
    // DOWN sells at the ask (the fixture's book is 100 / 100.1).
    const g = fixture(); g.setPosition(-1);
    const down = g.create(); await down.start({ ...input, direction: 'DOWN' }); await down.tick();
    expect(sends(g)[0]).toMatchObject({ order_type: 'POST_ONLY', side: 'SELL', order_price: 100.1 });
    expect((await down.list(accountId))[0]).toMatchObject({ status: 'open', entryPrice: 100.1 });
    // Off-tick levels snap to quote_tick (.1) away from the spread: a bid down, an ask up, so the snap never crosses.
    const h = fixture(); h.setTop(100.06, 100.08);
    const narrow = h.create(); await narrow.start(input);
    expect(sends(h)).toEqual([expect.objectContaining({ side: 'BUY', order_price: 100 })]);
    const k = fixture(); k.setTop(100.06, 100.08); k.setPosition(-1);
    const narrowDown = k.create(); await narrowDown.start({ ...input, direction: 'DOWN' });
    expect(sends(k)).toEqual([expect.objectContaining({ side: 'SELL', order_price: 100.1 })]);
  });

  it('runs the maker window from the opening intent while the book is unusable, then falls back or fails', async () => {
    // A crossed (or empty) book places nothing; the window still runs from the opening intent.
    const f = fixture(); f.setTop(100.1, 100); f.setPosition(0);
    const e = f.create(); await e.start(input);
    expect(sends(f)).toHaveLength(0);
    expect(await round(e)).toMatchObject({ status: 'opening', error: expect.stringContaining('order book') });
    f.setTime(100000 + MAKER_WINDOW_MS - 1); await e.tick();
    expect(sends(f)).toHaveLength(0);
    expect((await round(e)).status).toBe('opening');
    // Still unusable after the window: no market order goes into such a book; the round fails and frees the account.
    f.setTime(100000 + MAKER_WINDOW_MS); await e.tick();
    const failed = await round(e);
    expect(failed).toMatchObject({ status: 'failed', error: 'No usable order book. Nothing was traded.' });
    expect(failed.credential).toBeUndefined();
    expect(sends(f)).toHaveLength(0);
    expect(await e.start({ ...input, id: 'test-round-002' })).toMatchObject({ status: 'opening' });
    // Usable again only once the window is over: the fallback market order, as usual.
    const g = fixture(); g.setTop(100.1, 100);
    const late = g.create(); await late.start(input);
    g.setTop(100, 100.1); g.setTime(100000 + MAKER_WINDOW_MS); await late.tick();
    expect(sends(g)).toEqual([expect.objectContaining({ order_type: 'MARKET', order_quantity: 1, client_order_id: expect.stringMatching(/-m$/) })]);
    await late.tick();
    expect(await round(late)).toMatchObject({ status: 'open', fill: { maker: false, fallback: true, quotes: 0 } });
  });

  it('pulls the quote when the top moves away, and only quotes again once Orderly confirms the cancel', async () => {
    const f = fixture(), e = f.create(); f.setResting(true);
    await e.start(input);
    f.setTime(101000); await e.tick();
    expect(cancels(f)).toHaveLength(0);
    // A better bid appears above ours: we are no longer first in line.
    f.setTop(100.2, 100.3); f.setTime(102000); await e.tick();
    const r1 = await round(e);
    expect(r1.openAttempts[0]).toMatchObject({ terminal: false, cancel: { requestedAt: 102000, reason: 'moved', ackAt: 102000 } });
    expect(cancels(f)).toEqual([r1.openAttempts[0].clientId]);
    expect(sends(f)).toHaveLength(1);
    // The next tick sees it CANCELLED with nothing filled and requotes at the new top with a fresh client ID.
    f.setTime(103000); await e.tick();
    expect(sends(f)).toHaveLength(2);
    expect(sends(f)[1]).toMatchObject({ order_type: 'POST_ONLY', order_price: 100.2, order_quantity: 1, client_order_id: expect.stringMatching(/-q1$/) });
    expect((await round(e)).openAttempts.filter((a: any) => !a.terminal)).toHaveLength(1);
    fill(f, '-q1', 1, 100.2, .03, 103500);
    f.setTime(104000); await e.tick();
    expect(await round(e)).toMatchObject({ status: 'open', entryPrice: 100.2, openFee: .03, openedAt: 103500, deadline: 403500, fill: { filledQuantity: 1, quotes: 2, maker: true, fallback: false } });
  });

  it('carries a partial fill into the next quote and opens on the volume-weighted entry with the summed fees', async () => {
    const f = fixture(), e = f.create(); f.setResting(true);
    await e.start(input);
    fill(f, '-q0', .4, 100, .012, 100800, 'PARTIAL_FILLED');
    f.setTime(101000); await e.tick();
    expect((await round(e)).fill).toEqual({ filledQuantity: .4, quantity: 1, quotes: 1, maker: true, fallback: false });
    expect((await round(e)).status).toBe('opening');
    f.setTop(100.2, 100.3); f.setTime(102000); await e.tick();
    fill(f, '-q0', .4, 100, .012, 100800, 'CANCELLED');
    f.setTime(103000); await e.tick();
    expect(sends(f)[1]).toMatchObject({ order_type: 'POST_ONLY', order_price: 100.2, order_quantity: .6, client_order_id: expect.stringMatching(/-q1$/) });
    fill(f, '-q1', .6, 100.2, .018, 103400);
    f.setTime(104000); await e.tick();
    const r = await round(e);
    expect(r).toMatchObject({ status: 'open', quantity: 1, openedAt: 103400, deadline: 403400, fill: { filledQuantity: 1, quotes: 2, maker: true, fallback: false } });
    expect(r.entryPrice).toBeCloseTo(100.12, 10);
    expect(r.openFee).toBeCloseTo(.03, 10);
    // The close and the result use the blended entry and the summed opening fee.
    f.setTime(r.deadline); await e.tick(); f.setTime(r.deadline + 5000); for (let i = 0; i < 4; i++) await e.tick();
    expect(sends(f).at(-1)).toMatchObject({ reduce_only: true, order_quantity: 1 });
    expect((await round(e)).tradingPnl).toBeCloseTo((101 - 100.12) * 1 - .06, 10);
  });

  it('treats a refused post-only quote as a non-fill and quotes again on the next tick', async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args: any[]) => {
      if (args[0] === '/v1/order' && args[3]?.client_order_id.endsWith('-q0')) throw new OrderlyError('post only order would take', true, -1104);
      return original(...(args as [string]));
    });
    const e = f.create();
    const started = await e.start(input);
    expect(started).toMatchObject({ status: 'opening', openRejections: 1, error: expect.stringContaining('Requoting') });
    expect(started.openAttempts[0]).toMatchObject({ terminal: true, rejectedAt: 100000, filled: 0 });
    f.setTime(101000); await e.tick();
    expect(sends(f).map(o => o.client_order_id.slice(-3))).toEqual(['-q0', '-q1']);
    expect((await round(e)).status).toBe('opening');
    f.setTime(102000); await e.tick();
    expect(sends(f)).toHaveLength(2);
    expect(await round(e)).toMatchObject({ status: 'open', entryPrice: 100, fill: { quotes: 2, maker: true } });
  });

  it('sends a market order for the remainder after the maker window and keeps what the quote filled', async () => {
    const f = fixture(), e = f.create(); f.setResting(true);
    await e.start(input);
    fill(f, '-q0', .3, 100, .009, 100500, 'PARTIAL_FILLED');
    f.setTime(100000 + MAKER_WINDOW_MS - 1); await e.tick();
    expect(cancels(f)).toHaveLength(0);
    f.setTime(100000 + MAKER_WINDOW_MS); await e.tick();
    expect((await round(e)).openAttempts[0].cancel).toMatchObject({ reason: 'fallback' });
    expect(sends(f)).toHaveLength(1);
    // Confirmed cancelled with .3 filled: the fallback is a market order for .7, under its own client ID.
    f.setTime(100000 + MAKER_WINDOW_MS + 1000); await e.tick();
    expect(sends(f)[1]).toMatchObject({ order_type: 'MARKET', side: 'BUY', order_quantity: .7, client_order_id: expect.stringMatching(/-m$/) });
    expect(sends(f)[1]).not.toHaveProperty('reduce_only');
    fill(f, '-m', .7, 100.5, .03, 100000 + MAKER_WINDOW_MS + 1200);
    f.setTime(100000 + MAKER_WINDOW_MS + 2000); await e.tick();
    const r = await round(e);
    expect(r).toMatchObject({ status: 'open', quantity: 1, openedAt: 100000 + MAKER_WINDOW_MS + 1200, deadline: 100000 + MAKER_WINDOW_MS + 1200 + 300000, fill: { filledQuantity: 1, quantity: 1, quotes: 1, maker: false, fallback: true } });
    expect(r.entryPrice).toBeCloseTo(.3 * 100 + .7 * 100.5, 10);
    expect(r.openFee).toBeCloseTo(.039, 10);
  });

  it('recovers a cancel whose send was lost by looking the quote up first, never placing a second quote while one may rest', async () => {
    const f = fixture(); f.setResting(true);
    let lostCancel = true;
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args: any[]) => {
      if (args[2] === 'DELETE') {
        // The cancel intent is on the journal before the request leaves.
        expect(f.journal()[0].openAttempts[0].cancel).toMatchObject({ reason: 'moved' });
        if (lostCancel) { lostCancel = false; throw new TypeError('fetch failed'); }
      }
      return original(...(args as [string]));
    });
    const e = f.create(); await e.start(input);
    f.setTop(100.2, 100.3); f.setTime(102000); await e.tick();
    expect((await round(e)).openAttempts[0]).toMatchObject({ terminal: false, cancel: { requestedAt: 102000, sendFailedAt: 102000 } });
    expect(order(f, '-q0').status).toBe('NEW');
    // The process dies here. A fresh one finds the intent, sees the quote still resting, and sends the cancel again.
    const restarted = f.create();
    f.setTime(103000); await restarted.tick();
    expect(cancels(f)).toHaveLength(2);
    expect(sends(f)).toHaveLength(1);
    expect(order(f, '-q0').status).toBe('CANCELLED');
    f.setTime(104000); await restarted.tick();
    expect(sends(f)).toHaveLength(2);
    expect(sends(f)[1]).toMatchObject({ order_price: 100.2, client_order_id: expect.stringMatching(/-q1$/) });
    // An acknowledged cancel the order does not reflect yet is simply sent again after a moment.
    const g = fixture(); g.setResting(true);
    const stubborn = g.request.getMockImplementation()!;
    g.request.mockImplementation(async (...args: any[]) => { if (args[2] === 'DELETE') return { status: 'CANCEL_SENT' }; return stubborn(...(args as [string])); });
    const e2 = g.create(); await e2.start(input);
    g.setTop(100.2, 100.3); g.setTime(102000); await e2.tick();
    g.setTime(103000); await e2.tick();
    g.setTime(104000); await e2.tick();
    expect(cancels(g)).toHaveLength(2);
    expect(sends(g)).toHaveLength(1);
  });

  it('finds a quote whose acknowledgement was lost by its client ID and carries on with it', async () => {
    const f = fixture(); f.setResting(true);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args: any[]) => { const response = await original(...(args as [string])); if (args[0] === '/v1/order') throw new TypeError('fetch failed'); return response; });
    const e = f.create();
    expect((await e.start(input)).openAttempts[0]).toMatchObject({ sendFailedAt: 100000, terminal: false });
    const restarted = f.create();
    f.setTime(101000); await restarted.tick();
    expect(sends(f)).toHaveLength(1);
    expect((await round(restarted)).openAttempts[0]).toMatchObject({ terminal: false, orderStatus: 'NEW', filled: 0 });
    fill(f, '-q0', 1, 100, .03, 101500);
    f.setTime(102000); await restarted.tick();
    expect(await round(restarted)).toMatchObject({ status: 'open', entryPrice: 100, fill: { quotes: 1 } });
    expect(sends(f)).toHaveLength(1);
  });

  it('lets the player cancel while opening: a partial fill is closed reduce-only and the round ends early with its result', async () => {
    const f = fixture(), e = f.create(); f.setResting(true);
    await e.start(input);
    fill(f, '-q0', .4, 100, .012, 100500, 'PARTIAL_FILLED'); f.setPosition(.4);
    await expect(e.cancelOpening(input.id, '0x' + 'b'.repeat(64))).rejects.toThrow('No active round');
    f.setTime(104000);
    const cancelled = await e.cancelOpening(input.id, accountId);
    expect(cancelled).toMatchObject({ status: 'opening', openCancelRequested: true });
    expect(cancelled).not.toHaveProperty('credential');
    expect(cancels(f)).toHaveLength(1);
    expect((await round(e)).openAttempts[0].cancel).toMatchObject({ reason: 'player' });
    // Confirmed cancelled with .4: that part is closed at once, reduce-only; no further opening order is sent.
    f.setTime(105000); await e.tick();
    expect(sends(f)).toHaveLength(2);
    expect(sends(f)[1]).toMatchObject({ reduce_only: true, side: 'SELL', order_quantity: .4, client_order_id: expect.stringMatching(/-c0$/) });
    for (let i = 0; i < 4; i++) await e.tick();
    const r = await round(e);
    expect(r).toMatchObject({ status: 'ended_early', closeReason: 'cancelled', resultPending: false, quantity: .4, entryPrice: 100, fill: { filledQuantity: .4, quantity: 1 } });
    expect(r.exitPrice).toBeCloseTo(101, 10);
    expect(r.tradingPnl).toBeCloseTo((101 - 100) * .4 - (.012 + .03), 10);
    expect(r.credential).toBeUndefined();
    expect(needsTick(r)).toBe(false);
    // Asking again is harmless; a round that is already open must use the close route instead.
    await expect(e.cancelOpening(input.id, accountId)).rejects.toThrow('No active round');
    const g = fixture(), open = g.create(); await open.start(input); await open.tick();
    await expect(open.cancelOpening(input.id, accountId)).rejects.toThrow('still opening');
    expect(sends(g)).toHaveLength(1);
  });

  it('fails a round the player cancelled before anything filled, with no position and no credential', async () => {
    const f = fixture(), e = f.create(); f.setResting(true);
    await e.start(input);
    const cancelled = await e.cancelOpening(input.id, accountId);
    expect(cancels(f)).toHaveLength(1);
    expect(cancelled.status).toBe('opening');
    await e.tick();
    const r = await round(e);
    expect(r).toMatchObject({ status: 'failed', error: 'Cancelled before fill', fill: { filledQuantity: 0 } });
    expect(r.credential).toBeUndefined();
    expect(sends(f)).toHaveLength(1);
    expect(await e.start({ ...input, id: 'test-round-002' })).toMatchObject({ status: 'opening' });
  });

  it('keeps polling a partly filled quote Orderly temporarily cannot find: never abandoned, never adopted, its fill kept', async () => {
    const f = fixture(), e = f.create(); f.setResting(true);
    await e.start(input);
    fill(f, '-q0', .4, 100, .012, 100800, 'PARTIAL_FILLED'); f.setPosition(.4);
    f.setTime(101000); await e.tick();
    expect((await round(e)).openAttempts[0].filled).toBe(.4);
    // The order drops out of lookups (and cancels answer "not found") for longer than the (acknowledged-order) grace.
    let hidden = true;
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args: any[]) => {
      const path = String(args[0]);
      if (hidden && path.includes('-q0') && (path.startsWith('/v1/client/order/') || args[2] === 'DELETE')) throw new OrderlyError('Order not found', true, -1006);
      return original(...(args as [string]));
    });
    const t = 100000 + ACKED_ORDER_NOT_FOUND_GRACE_MS;
    f.setTime(t); await e.tick();
    let r = await round(e);
    // Not abandoned (that would have zeroed a real fill and over-quoted next): cancelled in case it turns up, and still pending.
    expect(r.openAttempts[0]).toMatchObject({ terminal: false, filled: .4, cancel: { reason: 'missing', rejectedAt: t } });
    expect(r.openAttempts[0].abandoned).toBeUndefined();
    expect(r).toMatchObject({ status: 'opening', error: expect.stringContaining('partly filled'), fill: { filledQuantity: .4 } });
    expect(cancels(f)).toEqual([r.openAttempts[0].clientId]);
    expect(sends(f)).toHaveLength(1);
    // A larger position meanwhile does not make it "adopted" either (it may still be resting); the cancel is repeated every 2s.
    f.setPosition(1); f.setTime(t + 1000); await e.tick();
    expect(cancels(f)).toHaveLength(1);
    f.setTime(t + 2000); await e.tick();
    r = await round(e);
    expect(cancels(f)).toHaveLength(2);
    expect(r.openAttempts[0]).toMatchObject({ terminal: false, filled: .4 });
    expect(r.adopted).toBeUndefined();
    expect(sends(f)).toHaveLength(1);
    // It shows again, cancelled with its .4: only the remainder is ordered (the window is long over: the market fallback).
    hidden = false; fill(f, '-q0', .4, 100, .012, 100800, 'CANCELLED'); f.setPosition(.4);
    f.setTime(t + 3000); await e.tick();
    expect(sends(f)).toHaveLength(2);
    expect(sends(f)[1]).toMatchObject({ order_type: 'MARKET', order_quantity: .6, client_order_id: expect.stringMatching(/-m$/) });
    fill(f, '-m', .6, 100.5, .018, t + 3500); f.setPosition(1);
    f.setTime(t + 4000); await e.tick();
    r = await round(e);
    expect(r).toMatchObject({ status: 'open', quantity: 1, fill: { filledQuantity: 1, quantity: 1 } });
    expect(r.entryPrice).toBeCloseTo(100.3, 10);
    f.setTime(t + 5000); await e.tick();
    expect((await round(e)).status).toBe('open');
  });

  it('adopts a missing follow-up quote only for the position beyond what the earlier quotes filled', async () => {
    const f = fixture(), e = f.create(); f.setResting(true);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args: any[]) => {
      if (args[0] === '/v1/order' && args[3]?.client_order_id.endsWith('-q1')) throw new TypeError('fetch failed');
      const result = await original(...(args as [string]));
      return String(args[0]).startsWith('/v1/position/') ? { ...result, average_open_price: 100.1 } : result;
    });
    await e.start(input);
    fill(f, '-q0', .4, 100, .012, 100800, 'PARTIAL_FILLED'); f.setPosition(.4);
    f.setTop(100.2, 100.3); f.setTime(102000); await e.tick();
    fill(f, '-q0', .4, 100, .012, 100800, 'CANCELLED');
    f.setTime(103000); await e.tick();
    expect((await round(e)).openAttempts[1]).toMatchObject({ type: 'POST_ONLY', quantity: .6, sendFailedAt: 103000, terminal: false });
    // q1 is never found, but the position grew to the planned size: q1 executed for the .6 beyond q0's .4.
    f.setPosition(1); f.setTime(103000 + grace); await e.tick();
    const r = await round(e);
    expect(r.openAttempts[1]).toMatchObject({ terminal: true, adopted: true, filled: .6 });
    expect(r).toMatchObject({ status: 'open', adopted: true, quantity: 1, entryPrice: 100.1, fill: { filledQuantity: 1 } });
    expect(sends(f)).toHaveLength(2);
  });

  it('places nothing after an abandoned quote until Orderly confirms its cancel, and cancels it if it turns up late', async () => {
    const f = fixture(), e = f.create(); f.setResting(true); f.setPosition(0);
    let failCancels = 2;
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args: any[]) => {
      // q0's POST fails in transit, and the first cancels sent for it are lost too (ambiguous).
      if (args[0] === '/v1/order' && args[3]?.client_order_id.endsWith('-q0')) throw new TypeError('fetch failed');
      if (args[2] === 'DELETE' && failCancels-- > 0) throw new TypeError('fetch failed');
      return original(...(args as [string]));
    });
    await e.start(input);
    f.setTime(100000 + grace); await e.tick();
    let r = await round(e);
    expect(r.openAttempts[0]).toMatchObject({ terminal: true, abandoned: true, filled: 0, cancel: { reason: 'abandoned', sendFailedAt: 100000 + grace } });
    // Unconfirmed cancel: the cancel is sent again, nothing else is placed.
    f.setTime(100000 + grace + 1000); await e.tick();
    expect(cancels(f)).toHaveLength(2);
    expect(sends(f)).toHaveLength(1);
    expect(await round(e)).toMatchObject({ status: 'opening', error: expect.stringContaining('Confirming its cancel') });
    // The lost quote arrives after all and rests: it is found by the recheck, cancelled, and still nothing else is placed.
    f.orders.set(r.openAttempts[0].clientId, { status: 'NEW', total_executed_quantity: 0, average_executed_price: 0, total_fee: 0, updated_time: 100000 + grace + 1500, order_id: 42 });
    f.setTime(100000 + grace + 2000); await e.tick();
    expect(cancels(f)).toHaveLength(3);
    expect(sends(f)).toHaveLength(1);
    expect(order(f, '-q0').status).toBe('CANCELLED');
    expect((await round(e)).openAttempts[0].cancel).toMatchObject({ ackAt: 100000 + grace + 2000 });
    // Cancelled with a late partial fill: that counts, and only the remainder is ordered (the window is over: market).
    fill(f, '-q0', .4, 100, .012, 100000 + grace + 1800, 'CANCELLED'); f.setPosition(.4);
    f.setTime(100000 + grace + 3000); await e.tick();
    expect(sends(f)).toHaveLength(2);
    expect(sends(f)[1]).toMatchObject({ order_type: 'MARKET', order_quantity: .6, client_order_id: expect.stringMatching(/-m$/) });
    r = await round(e);
    expect(r.openAttempts[0]).toMatchObject({ abandoned: true, rechecked: true, lateFill: true, filled: .4 });
    fill(f, '-m', .6, 100.5, .018, 100000 + grace + 3200); f.setPosition(1);
    f.setTime(100000 + grace + 4000); await e.tick();
    r = await round(e);
    expect(r).toMatchObject({ status: 'open', quantity: 1, fill: { filledQuantity: 1, quantity: 1, quotes: 1, fallback: true } });
    expect(r.entryPrice).toBeCloseTo(100.3, 10);
    expect(r.openFee).toBeCloseTo(.03, 10);
    expect(r.openAttempts.filter((a: any) => !a.terminal)).toHaveLength(0);
  });

  it('counts an abandoned quote that filled late in the entry instead of pausing the round as an outside position', async () => {
    const f = fixture(), e = f.create(); f.setResting(true); f.setPosition(0);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args: any[]) => {
      if (args[0] === '/v1/order' && args[3]?.client_order_id.endsWith('-q0')) throw new TypeError('fetch failed');
      return original(...(args as [string]));
    });
    await e.start(input);
    // Orderly knows nothing of q0 and refuses its cancel as unknown: a confirmed cancel, so the fallback goes out.
    f.setTime(100000 + grace); await e.tick();
    expect((await round(e)).openAttempts[0].cancel).toMatchObject({ reason: 'abandoned', rejectedAt: 100000 + grace });
    f.setTime(100000 + grace + 1000); await e.tick();
    expect(sends(f)).toHaveLength(2);
    expect(sends(f)[1]).toMatchObject({ order_type: 'MARKET', order_quantity: 1 });
    // Then q0 turns up filled after all (the fixture's market order filled at once): both fills open the round.
    const q0 = (await round(e)).openAttempts[0].clientId;
    f.orders.set(q0, { status: 'FILLED', total_executed_quantity: .4, average_executed_price: 99.9, total_fee: .012, updated_time: 100000 + grace + 1200, order_id: 43 });
    f.setPosition(1.4);
    f.setTime(100000 + grace + 2000); await e.tick();
    const r = await round(e);
    expect(r).toMatchObject({ status: 'open', quantity: 1.4, fill: { filledQuantity: 1.4, quantity: 1 } });
    expect(r.openAttempts[0]).toMatchObject({ abandoned: true, rechecked: true, lateFill: true, filled: .4 });
    expect(r.entryPrice).toBeCloseTo((.4 * 99.9 + 1 * 100) / 1.4, 10);
    expect(r.openFee).toBeCloseTo(.042, 10);
    // The position matches the round's fills: no "changed outside this round" pause, and the close is for all of it.
    f.setTime(100000 + grace + 3000); await e.tick();
    expect(await round(e)).toMatchObject({ status: 'open' });
    expect((await round(e)).error).toBeUndefined();
    f.setTime(r.deadline); await e.tick();
    expect(sends(f).at(-1)).toMatchObject({ reduce_only: true, order_quantity: 1.4 });
  });

  it('cancels a quote Orderly cannot find yet as soon as the player cancels or the window ends, and says so', async () => {
    const f = fixture(), e = f.create(); f.setResting(true);
    let hidden = true;
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args: any[]) => {
      if (hidden && String(args[0]).startsWith('/v1/client/order/') && String(args[0]).endsWith('-q0')) throw new OrderlyError('Order not found', true, -1006);
      return original(...(args as [string]));
    });
    await e.start(input);
    // Acknowledged but not yet visible: within the grace nothing is sent while nobody wants it gone.
    f.setTime(101000); await e.tick();
    expect(cancels(f)).toHaveLength(0);
    expect((await round(e)).error).toBeUndefined();
    f.setTime(102000);
    const cancelled = await e.cancelOpening(input.id, accountId);
    expect(cancelled).toMatchObject({ status: 'opening', openCancelRequested: true, error: CONFIRMING_QUOTE_MESSAGE });
    expect(cancels(f)).toHaveLength(1);
    expect(order(f, '-q0').status).toBe('CANCELLED');
    expect((await round(e)).openAttempts[0]).toMatchObject({ terminal: false, cancel: { reason: 'player', ackAt: 102000, sentAt: 102000 } });
    // Still polled; the cancel repeats every 2s while the quote stays unseen, and nothing new is placed.
    f.setTime(103000); await e.tick();
    expect(cancels(f)).toHaveLength(1);
    f.setTime(104000); await e.tick();
    expect(cancels(f)).toHaveLength(2);
    expect(sends(f)).toHaveLength(1);
    hidden = false;
    f.setTime(105000); await e.tick();
    expect(await round(e)).toMatchObject({ status: 'failed', error: 'Cancelled before fill' });
    expect(sends(f)).toHaveLength(1);
    // The same when the maker window ends on a quote that cannot be found.
    const g = fixture(), e2 = g.create(); g.setResting(true);
    const original2 = g.request.getMockImplementation()!;
    g.request.mockImplementation(async (...args: any[]) => {
      if (String(args[0]).startsWith('/v1/client/order/') && String(args[0]).endsWith('-q0')) throw new OrderlyError('Order not found', true, -1006);
      return original2(...(args as [string]));
    });
    await e2.start(input);
    g.setTime(100000 + MAKER_WINDOW_MS - 1); await e2.tick();
    expect(cancels(g)).toHaveLength(0);
    g.setTime(100000 + MAKER_WINDOW_MS); await e2.tick();
    expect(cancels(g)).toHaveLength(1);
    expect(await round(e2)).toMatchObject({ status: 'opening', error: CONFIRMING_QUOTE_MESSAGE });
    expect((await round(e2)).openAttempts[0]).toMatchObject({ terminal: false, cancel: { reason: 'fallback' } });
    expect(sends(g)).toHaveLength(1);
  });

  it('sends no cancel for a pending market fallback when the player cancels; it waits for its terminal state', async () => {
    const f = fixture(), e = f.create(); f.setResting(true);
    await e.start(input);
    f.setTime(100000 + MAKER_WINDOW_MS); await e.tick();
    f.setTime(100000 + MAKER_WINDOW_MS + 1000); await e.tick();
    expect(sends(f)[1]).toMatchObject({ order_type: 'MARKET', order_quantity: 1 });
    expect(cancels(f)).toHaveLength(1);
    // The market order is still working on Orderly when the player cancels.
    Object.assign(order(f, '-m'), { status: 'NEW', total_executed_quantity: 0, average_executed_price: 0, total_fee: 0 });
    f.setTime(100000 + MAKER_WINDOW_MS + 2000);
    const cancelled = await e.cancelOpening(input.id, accountId);
    expect(cancelled).toMatchObject({ status: 'opening', openCancelRequested: true });
    expect(cancels(f)).toHaveLength(1);
    expect((await round(e)).openAttempts[1].cancel).toBeUndefined();
    fill(f, '-m', 1, 100.5, .03, 100000 + MAKER_WINDOW_MS + 2500);
    f.setTime(100000 + MAKER_WINDOW_MS + 3000); await e.tick();
    expect(cancels(f)).toHaveLength(1);
    expect(await round(e)).toMatchObject({ cancelledOpening: true, closeNow: true, quantity: 1 });
    expect(['open', 'closing']).toContain((await round(e)).status);
  });

  it('gives a round lease long enough for the slowest tick, and waits longer than that before calling an order lost', () => {
    const ttls: number[] = [];
    const pool = { query: async (text: string, params: any[]) => { if (text.includes('INSERT INTO updown_locks')) { ttls.push(params[2]); return { rows: [{ owner: params[1] }] }; } return { rows: [] }; } };
    const store = createPostgresStore({ pool, key: Buffer.alloc(32, 1) });
    return store.withLock(['round:x'], async () => undefined).then(() => {
      expect(ttls).toEqual([90000]);
      // Lease plus the 10s request timeout: an invocation that may have sent the order is gone by then.
      expect(ORDER_NOT_FOUND_GRACE_MS).toBeGreaterThanOrEqual(90000 + 10000);
    });
  });

  it('never has two quotes out when many invocations tick the same opening round at once', async () => {
    const f = fixture(), e = f.create(); f.setResting(true);
    await e.start(input);
    const store = (e as any).store;
    let now = 102000;
    const engines = Array.from({ length: 5 }, () => new RoundEngine({ request: f.request, store, network: 'testnet', brokerId: 'cato', now: () => now, maker: true }));
    f.setTop(100.2, 100.3);
    await Promise.all(engines.map(x => x.tickRound(input.id)));
    expect(cancels(f)).toHaveLength(1);
    now = 103000;
    await Promise.all(engines.map(x => x.tickRound(input.id)));
    await Promise.all(engines.map(x => x.tick()));
    expect(sends(f)).toHaveLength(2);
    expect((await round(e)).openAttempts.filter((a: any) => !a.terminal)).toHaveLength(1);
  });
});
