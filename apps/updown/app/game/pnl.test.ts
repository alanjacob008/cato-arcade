import { describe, expect, it } from 'vitest';
import type { Round } from './api';
import { roundPnl, roundResult } from './pnl';

const round: Round = { id: 'test', accountId: 'test', symbol: 'PERP_SOL_USDC', direction: 'UP', duration: 30, margin: 1, leverage: 100, quantity: .9, status: 'open', createdAt: 1, entryPrice: 110.118, openFee: .029732 };
describe('round PnL', () => {
  it('shows a correct UP call losing after costs, using the actual entry fee', () => {
    const result = roundPnl(round, 110.141, .0003)!;
    expect(result.gross).toBeCloseTo(.0207, 8);
    expect(result.paidFees).toBe(.029732);
    expect(result.exitFee).toBeCloseTo(.02973807, 8);
    expect(result.net).toBeCloseTo(-.03877007, 8);
    expect(roundPnl(round, result.breakEven, .0003)!.net).toBeCloseTo(0, 8);
  });
  it('uses the correct sign and break-even for DOWN', () => {
    const down = { ...round, direction: 'DOWN' as const };
    expect(roundPnl(down, 110, .0003)!.gross).toBeCloseTo(.1062);
    expect(roundPnl(down, roundPnl(down, 110, .0003)!.breakEven, .0003)!.net).toBeCloseTo(0, 8);
  });
  it('combines confirmed partial closes with the remaining position without double-counting fees', () => {
    const partial = { ...round, quantity: 2, entryPrice: 100, openFee: .06, positionQuantity: 1, closeAttempts: [{ terminal: true, quantity: 1, price: 101, fee: .0303 }] };
    const result = roundPnl(partial, 102, .0003)!;
    expect(result.gross).toBe(3);
    expect(result.paidFees).toBeCloseTo(.0903);
    expect(result.exitFee).toBeCloseTo(.0306);
    expect(result.net).toBeCloseTo(2.8791);
  });
  it('does not invent PnL before entry or while a closing fill is still being reconciled', () => {
    expect(roundPnl({ ...round, entryPrice: undefined }, 110, .0003)).toBeUndefined();
    expect(roundPnl({ ...round, positionQuantity: 0 }, 110, .0003)).toBeUndefined();
    expect(roundPnl(round, undefined, .0003)).toBeUndefined();
  });
  it('separates final direction from net result, with recorded fees', () => {
    const result = roundResult({ ...round, status: 'closed', exitPrice: 110.141, fees: .059471, tradingPnl: -.038771 })!;
    expect(result.correct).toBe(true);
    expect(result.feesErasedGain).toBe(true);
    expect(result.gross).toBeCloseTo(.0207, 8);
    expect(roundResult(round)).toBeUndefined();
  });
});
