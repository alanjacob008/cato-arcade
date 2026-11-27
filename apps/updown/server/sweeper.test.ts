// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { RoundEngine } from './engine.mjs';
import { createJournalStore } from './store.mjs';
import { createNetworkSweeper } from './sweeper.mjs';
import { OrderlyError } from './orderly.mjs';

const accountId = '0x' + 'f'.repeat(64);

/** A mocked Orderly network (no requests leave the test) with one filled opening order. */
function exchange() {
  let position = 1;
  const orders = new Map<string, any>();
  const request = vi.fn(async (path: string, _credential?: unknown, method = 'GET', body?: any): Promise<any> => {
    if (path.startsWith('/v1/position/')) return { position_qty: position, mark_price: 100, margin_mode: 'ISOLATED' };
    if (path.startsWith('/v1/client/order/')) {
      const order = orders.get(decodeURIComponent(path.split('/').at(-1)!));
      if (!order) throw new OrderlyError('Order not found', true, -1006);
      return order;
    }
    if (path === '/v1/order' && method === 'POST') {
      orders.set(body.client_order_id, { status: 'FILLED', total_executed_quantity: body.order_quantity, average_executed_price: 101, total_fee: .01, updated_time: 1 });
      position = 0;
      return { order_id: 2 };
    }
    throw new Error('Unexpected request: ' + path);
  });
  return { request, sends: () => request.mock.calls.filter(c => c[0] === '/v1/order') };
}

/** An open mainnet round whose deadline has passed, left in a store now played on testnet. */
function strandedMainnetRound() {
  const rounds = [{
    id: 'mainnet-round-1', accountId, network: 'mainnet', symbol: 'PERP_ETH_USDC', direction: 'UP', duration: 300, margin: 10, leverage: 10,
    quantity: 1, status: 'open', createdAt: 1, openedAt: 1, deadline: 2, entryPrice: 100, openFee: .01, closeAttempts: [],
    orderPrefix: 'nl-test', credential: { accountId, secretKey: 'test-only' },
  }];
  // Postgres-like: no assertNetwork, so engines for both networks can share it.
  const { assertNetwork, ...store } = createJournalStore({ load: () => rounds, save: () => {} });
  return store;
}

describe('network sweeper', () => {
  it('keeps closing rounds left on the previous network with that network\'s exchange', async () => {
    const store = strandedMainnetRound();
    const testnet = exchange(), mainnet = exchange();
    let now = 10_000;
    const primary = new RoundEngine({ request: testnet.request, store, network: 'testnet', brokerId: 'cato', now: () => now });
    const engineFor = vi.fn((network: string) => new RoundEngine({ request: mainnet.request, store, network, brokerId: 'cato', now: () => now }));
    const log = vi.fn();
    const sweeper = createNetworkSweeper({ store, primary, engineFor, log });
    expect(await store.activeNetworks()).toEqual(['mainnet']);
    expect(await sweeper.tick()).toBe(1);
    expect(engineFor).toHaveBeenCalledWith('mainnet');
    expect(mainnet.sends()).toHaveLength(1);
    expect(mainnet.sends()[0][3]).toMatchObject({ reduce_only: true, client_order_id: 'nl-test-c0' });
    expect(testnet.request).not.toHaveBeenCalled();
    for (let i = 0; i < 6; i++) { now += 1000; await sweeper.tick(); }
    expect(await store.get('mainnet-round-1')).toMatchObject({ status: 'closed' });
    expect((await store.get('mainnet-round-1')).credential).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('still closing rounds left on mainnet'));
  });

  it('skips a network the deployment may not touch, and stops when the time budget is spent', async () => {
    const store = strandedMainnetRound();
    const testnet = exchange(), mainnet = exchange();
    const primary = new RoundEngine({ request: testnet.request, store, network: 'testnet', brokerId: 'cato', now: () => 10_000 });
    const engineFor = vi.fn((network: string) => new RoundEngine({ request: mainnet.request, store, network, brokerId: 'cato', now: () => 10_000 }));
    const vetoed = createNetworkSweeper({ store, primary, engineFor, allowNetwork: n => n !== 'mainnet', log: () => {} });
    expect(await vetoed.tick()).toBe(0);
    const outOfTime = createNetworkSweeper({ store, primary, engineFor, log: () => {} });
    await outOfTime.tick({ continueWhile: () => false });
    expect(engineFor).not.toHaveBeenCalled();
    expect(mainnet.request).not.toHaveBeenCalled();
  });
});
