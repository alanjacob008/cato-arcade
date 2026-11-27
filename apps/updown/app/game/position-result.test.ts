import { describe, expect, it } from 'vitest';
import { positionResult } from './position-result.mjs';

const round = { symbol: 'PERP_SOL_USDC', direction: 'UP', quantity: 2, margin: 10, entryPrice: 100,
  createdAt: 99000, openRequestedAt: 99500, openedAt: 100000, closedAt: 200000 };
const history = { position_id: 123, position_status: 'closed', type: 'liquidated', margin_mode: 'ISOLATED',
  symbol: round.symbol, side: 'LONG', max_position_qty: 2, closed_position_qty: 2,
  avg_open_price: 100, avg_close_price: 96, open_timestamp: 100000, close_timestamp: 199000,
  realized_pnl: -9, trading_fee: .06, accumulated_funding_fee: .01, liquidator_fee: .7, insurance_fund_fee: .3, liquidation_id: 42 };

describe('matching round outcomes to exchange position history', () => {
  it('uses the confirmed net loss, without assuming minus margin or double-counting liquidation fees', () => {
    expect(positionResult(round, [history])).toMatchObject({ status: 'closed', closeReason: 'liquidation',
      tradingPnl: -9.06, netPnl: -9.07, exitPrice: 96, closedAt: 199000, resultPending: false, liquidationId: 42 });
  });
  it('distinguishes a manual external close from a liquidation', () => {
    expect(positionResult(round, [{ ...history, type: 'trade' }])?.closeReason).toBe('external');
  });
  it('accepts the documented status alias, numeric isolated mode and short quantities', () => {
    const short = { ...history, position_status: undefined, status: 'closed', side: 'SHORT', margin_mode: 1,
      max_position_qty: -2, closed_position_qty: -2 };
    expect(positionResult({ ...round, direction: 'DOWN' }, [short])?.positionHistoryId).toBe(123);
  });
  it('never borrows another position result on the same ticker', () => {
    for (const changes of [{ symbol: 'PERP_BTC_USDC' }, { side: 'SHORT' }, { margin_mode: 'CROSS' }, { open_timestamp: 50000 },
      { open_timestamp: 150000 }, { close_timestamp: 300000 }, { max_position_qty: 3 }, { closed_position_qty: 1 },
      { avg_open_price: 101 }, { position_status: 'open' }]) {
      expect(positionResult(round, [{ ...history, ...changes }])).toBeUndefined();
    }
    expect(positionResult(round, [history, { ...history, position_id: 456 }])).toBeUndefined();
  });
  it('waits for all result fields instead of treating null or missing fees as zero', () => {
    for (const field of ['realized_pnl', 'trading_fee', 'accumulated_funding_fee', 'avg_close_price']) {
      for (const value of [null, undefined, '', NaN]) expect(positionResult(round, [{ ...history, [field]: value }])).toBeUndefined();
    }
    expect(positionResult(round, [])).toBeUndefined();
  });
});
