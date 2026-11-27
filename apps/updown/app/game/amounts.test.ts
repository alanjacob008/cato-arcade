import { describe, expect, it } from 'vitest';
import { Market } from './api';
import { amountQuote, maximumAmount, minimumAmount, percentAmount, isolatedAvailableBalance, AmountContext, STAKE_PERCENTS } from './amounts';

const market = { symbol: 'PERP_SOL_USDC', maxLeverage: 100, base_imr: .01, imr_factor: .000001,
  base_min: .01, base_tick: .01, base_max: 100000, min_notional: 10, mark_price: 100 } as Market;
const context: AmountContext = { market, price: 100, freeCollateral: 10, feeRate: .0003, leverageOverride: null, accountReady: true };

describe('round amount affordability', () => {
  it('reserves both market-order costs and leaves unaffordable presets disabled', () => {
    expect(amountQuote(5, context).affordable).toBe(true);
    expect(amountQuote(10, context).affordable).toBe(false);
    expect(maximumAmount(context)).toBe(9.04);
    expect(amountQuote(9.04, context).affordable).toBe(true);
    expect(amountQuote(9.05, context).affordable).toBe(false);
    const lowerBalance = { ...context, freeCollateral: 9.36 };
    expect(maximumAmount(lowerBalance)).toBe(8.46);
    expect(amountQuote(maximumAmount(lowerBalance), lowerBalance).affordable).toBe(true);
  });

  it('uses the user leverage selection but still reserves isolated frozen margin for zero-fee accounts', () => {
    const manual = { ...context, leverageOverride: 20 };
    expect(maximumAmount(manual)).toBe(9.04);
    expect(amountQuote(9.04, manual).leverage).toBe(20);
    expect(maximumAmount({ ...context, feeRate: 0 })).toBe(9.04);
    expect(amountQuote(10, { ...context, feeRate: 0 }).affordable).toBe(false);
  });

  it('caps isolated funding to USDC holdings and leaves execution headroom at the order reference price', () => {
    expect(isolatedAvailableBalance(9.36, 7, 6.5)).toBe(6.5);
    expect(isolatedAvailableBalance(9.36, undefined, 6.5)).toBeUndefined();
    const isolated = { ...context, freeCollateral: isolatedAvailableBalance(9.36, 7, 6.5), orderReferencePrice: 101 };
    const maximum = maximumAmount(isolated);
    expect(maximum).toBe(5.82);
    expect(amountQuote(8, isolated).affordable).toBe(false);
    expect(amountQuote(maximum, isolated).affordable).toBe(true);
    const frozenAtAsk = maximum * 1.01 * 1.1;
    expect(frozenAtAsk).toBeLessThan(6.5 * .995);
  });

  it('covers the larger observed isolated allocation behind both rejected mainnet Max attempts', () => {
    for (const [balance, rejected, expectedMaximum] of [[9.361514, 8.69, 8.46], [8.678146, 8, 7.84]]) {
      const current = { ...context, freeCollateral: balance };
      expect(amountQuote(rejected, current).affordable).toBe(false);
      expect(maximumAmount(current)).toBe(expectedMaximum);
      expect(amountQuote(expectedMaximum, current).affordable).toBe(true);
      expect(expectedMaximum * 1.1).toBeLessThan(balance * .995);
    }
  });

  it('respects the account-specific notional limit and higher broker fees', () => {
    const restricted = { ...context, accountMaxNotional: 550 };
    expect(maximumAmount(restricted)).toBe(5.5);
    expect(amountQuote(6, restricted).affordable).toBe(false);
    expect(maximumAmount({ ...context, accountMaxNotional: 0 })).toBe(0);
    expect(maximumAmount({ ...context, feeRate: .001 })).toBeLessThan(maximumAmount(context));
  });

  it('does not offer a maximum with missing account, invalid inputs, or no usable funds', () => {
    for (const invalid of [{ accountReady: false }, { pricingReady: false }, { freeCollateral: undefined }, { freeCollateral: NaN },
      { freeCollateral: 0 }, { freeCollateral: -.5 }, { feeRate: NaN }, { feeRate: -.1 },
      { price: undefined }, { market: undefined }, { leverageOverride: NaN }]) {
      expect(maximumAmount({ ...context, ...invalid })).toBe(0);
    }
    expect(amountQuote(NaN, context).affordable).toBe(false);
    expect(amountQuote(-10, context).affordable).toBe(false);
    expect(maximumAmount({ ...context, freeCollateral: .05 })).toBe(0);
  });

  it('accepts custom amounts below five when the rounded order meets market minimums', () => {
    expect(amountQuote(.1, context).affordable).toBe(true);
    expect(amountQuote(.09, context).affordable).toBe(false);
    expect(amountQuote(.199, { ...context, market: { ...market, base_min: .2 } }).affordable).toBe(false);
  });

  it('names the smallest playable stake from the market minimums', () => {
    expect(minimumAmount(context)).toBe(.1);
    expect(amountQuote(.1, context).enoughSize).toBe(true);
    expect(amountQuote(.09, context).enoughSize).toBe(false);
    expect(minimumAmount({ ...context, market: { ...market, base_min: .2 } })).toBe(.2);
    expect(minimumAmount({ ...context, market: { ...market, min_notional: 25 } })).toBe(.25);
    for (const invalid of [{ accountReady: false }, { price: undefined }, { market: undefined }]) expect(minimumAmount({ ...context, ...invalid })).toBe(0);
  });

  it('turns the share chips into cent amounts of the maximum, never above it', () => {
    expect(STAKE_PERCENTS).toEqual([10, 25, 50, 75, 100]);
    expect(STAKE_PERCENTS.map(percent => percentAmount(context, percent))).toEqual([.9, 2.26, 4.52, 6.78, 9.04]);
    for (const percent of STAKE_PERCENTS) expect(amountQuote(percentAmount(context, percent), context).affordable).toBe(true);
    expect(percentAmount({ ...context, freeCollateral: 0 }, 50)).toBe(0);
  });

  it('limits Max to the largest cent amount whose tick-rounded quantity fits base_max', () => {
    const capped = { ...context, market: { ...market, base_max: 2.05 } };
    expect(maximumAmount(capped)).toBe(2.05);
    expect(amountQuote(2.05, capped).quantity).toBe(2.04); // Same floating-point tick rounding as worker.
    expect(amountQuote(2.06, capped).affordable).toBe(false);
    expect(amountQuote(5, capped).withinMaxSize).toBe(false);
  });

  it('finds the true affordable maximum around discontinuous dynamic leverage thresholds', () => {
    for (const balance of [9.36, 10, 24.75, 51.21]) {
      for (const override of [null, 10, 25]) {
        const dynamic = { ...context, freeCollateral: balance, market: { ...market, imr_factor: .0008 }, leverageOverride: override };
        let bruteForceMax = 0;
        for (let cents = 1; cents <= Math.floor(balance * 100); cents++) {
          if (amountQuote(cents / 100, dynamic).affordable) bruteForceMax = cents / 100;
        }
        expect(maximumAmount(dynamic)).toBe(bruteForceMax);
        expect(amountQuote(maximumAmount(dynamic), dynamic).affordable).toBe(true);
      }
    }
  });
});
