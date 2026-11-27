import { afterEach, describe, expect, it } from 'vitest';
import type { Round } from './api';
import { appendPnlPoint, clearSeries, crossedBreakEven, FEE_GAP_FLOOR, feeGap, firstBreakEvenCross, MAX_SERIES_POINTS, pnlPoint, monotonePath, pointValue, rangeFloor, recordPnl, roundSeries, symmetricRange } from './chart-series';

const round: Round = { id: 'r1', accountId: 'a', symbol: 'PERP_BTC_USDC', direction: 'UP', duration: 300, margin: 5, leverage: 100, quantity: .005, status: 'open', createdAt: 0, entryPrice: 100000, openFee: .15 };

afterEach(clearSeries);

describe('result series', () => {
  it('samples the net result after fees in dollars and as a share of the bet', () => {
    // Gross: (100100 - 100000) * .005 = 0.5. Fees: 0.15 paid + exit 100100 * .005 * .0003 = 0.15015. Net = 0.19985.
    const point = pnlPoint(round, 100100, .0003, 1000)!;
    expect(point.time).toBe(1000);
    expect(point.net).toBeCloseTo(.19985, 8);
    expect(point.percent).toBeCloseTo(.19985 / 5 * 100, 8);
    expect(pointValue(point, '$')).toBe(point.net);
    expect(pointValue(point, '%')).toBe(point.percent);
    const down = pnlPoint({ ...round, direction: 'DOWN' }, 100100, .0003, 1000)!;
    expect(down.net).toBeCloseTo(-.5 - .15 - .15015, 8);
    expect(down.percent).toBeLessThan(0);
  });
  it('has no sample before the fill, without a price, or while the position reconciles', () => {
    expect(pnlPoint({ ...round, entryPrice: undefined }, 100100, .0003, 1)).toBeUndefined();
    expect(pnlPoint(round, undefined, .0003, 1)).toBeUndefined();
    expect(pnlPoint({ ...round, positionQuantity: 0 }, 100100, .0003, 1)).toBeUndefined();
    expect(pnlPoint({ ...round, margin: 0 }, 100100, .0003, 1)).toBeUndefined();
  });
  it('keeps at most one point per second, in order, capped at two hours', () => {
    let points = appendPnlPoint([], { time: 1000, net: 1, percent: 20 });
    points = appendPnlPoint(points, { time: 1400, net: 2, percent: 40 });
    points = appendPnlPoint(points, { time: 2000, net: 3, percent: 60 });
    expect(points.map(p => p.net)).toEqual([2, 3]);
    // A sample from the past never rewrites history.
    expect(appendPnlPoint(points, { time: 1500, net: 9, percent: 9 }).map(p => p.net)).toEqual([9]);
    expect(appendPnlPoint(points, { time: 3000, net: NaN, percent: 0 })).toBe(points);
    let long: ReturnType<typeof appendPnlPoint> = [];
    for (let i = 0; i < MAX_SERIES_POINTS + 5; i++) long = appendPnlPoint(long, { time: i * 1000, net: i, percent: i });
    expect(long).toHaveLength(MAX_SERIES_POINTS);
    expect(long[0].net).toBe(5);
  });
  it('stores series per round in memory', () => {
    expect(roundSeries('r1')).toEqual([]);
    expect(roundSeries(undefined)).toEqual([]);
    recordPnl('r1', { time: 1000, net: 1, percent: 20 });
    recordPnl('r2', { time: 1000, net: -1, percent: -20 });
    expect(recordPnl('r1', { time: 2000, net: 2, percent: 40 })).toHaveLength(2);
    expect(roundSeries('r1').map(p => p.net)).toEqual([1, 2]);
    expect(roundSeries('r2').map(p => p.net)).toEqual([-1]);
  });
  it('centres the scale on zero with headroom, never under the floor', () => {
    expect(symmetricRange([], .5)).toBe(.5);
    expect(symmetricRange([.1, -.2], .5)).toBe(.5);
    expect(symmetricRange([.1, -2], .5)).toBeCloseTo(2.5, 8);
    expect(symmetricRange([4, -2, NaN], .5)).toBeCloseTo(5, 8);
    expect(rangeFloor('%', 5)).toBe(.5);
    expect(rangeFloor('$', 5)).toBe(.025);
    expect(rangeFloor('$', 1)).toBe(.01);
    expect(rangeFloor('$', undefined)).toBe(.01);
  });
  it('keeps the scale at least a few fee gaps tall, so a fresh round is a small dip rather than a cliff', () => {
    expect(FEE_GAP_FLOOR).toBeGreaterThanOrEqual(2.5);
    const fresh = [pnlPoint(round, 100000, .0003, 1000)!];
    // Opening at the entry price: the gap is the open fee plus the close fee, about 6% of a $5 stake.
    expect(fresh[0].net).toBeCloseTo(-.3, 8);
    expect(feeGap(fresh, '$')).toBeCloseTo(.3, 8);
    expect(feeGap(fresh, '%')).toBeCloseTo(6, 8);
    expect(feeGap([], '$')).toBe(0);
    expect(feeGap([{ time: 0, net: .2, percent: 4 }], '$')).toBe(0);
    expect(rangeFloor('$', 5, feeGap(fresh, '$'))).toBeCloseTo(.3 * FEE_GAP_FLOOR, 8);
    expect(rangeFloor('%', 5, 6)).toBeCloseTo(6 * FEE_GAP_FLOOR, 8);
    // The gap is a size, whatever its sign; a missing or broken gap leaves the unit floor alone.
    expect(rangeFloor('$', 5, -.3)).toBeCloseTo(.3 * FEE_GAP_FLOOR, 8);
    expect(rangeFloor('$', 5, NaN)).toBe(.025);
    expect(rangeFloor('$', 5, .001)).toBe(.025);
    // On the plot the dip then takes no more than 1 / FEE_GAP_FLOOR of the half-height, even with the swing headroom.
    const range = symmetricRange(fresh.map(p => p.net), rangeFloor('$', 5, feeGap(fresh, '$')));
    expect(Math.abs(fresh[0].net) / range).toBeLessThanOrEqual(1 / FEE_GAP_FLOOR + 1e-9);
    expect(Math.abs(fresh[0].net) / range).toBeLessThan(.4);
  });
  it('detects the first upward crossing of break-even', () => {
    const start = { time: 0, net: -.3, percent: -6 };
    expect(firstBreakEvenCross([])).toBeUndefined();
    expect(firstBreakEvenCross([start])).toBeUndefined();
    expect(crossedBreakEven([start, { time: 1000, net: -.01, percent: -.2 }])).toBe(false);
    const cross = { time: 2000, net: 0, percent: 0 };
    const series = [start, { time: 1000, net: -.01, percent: -.2 }, cross, { time: 3000, net: -.5, percent: -10 }, { time: 4000, net: .4, percent: 8 }];
    expect(firstBreakEvenCross(series)).toBe(cross);
    expect(crossedBreakEven(series)).toBe(true);
    // Starting on or above zero (no fees to earn back) is not a crossing; only a later dip and return is.
    expect(crossedBreakEven([{ time: 0, net: .1, percent: 2 }, { time: 1000, net: .5, percent: 10 }])).toBe(false);
    expect(firstBreakEvenCross([{ time: 0, net: .1, percent: 2 }, { time: 1000, net: -.1, percent: -2 }, { time: 2000, net: .2, percent: 4 }])?.time).toBe(2000);
  });
  it('draws one smooth monotone curve through the samples without overshooting them', () => {
    expect(monotonePath([])).toBe('');
    expect(monotonePath([{ x: 0, y: 5 }])).toBe('M 0.00 5.00');
    const d = monotonePath([{ x: 0, y: 10 }, { x: 10, y: 20 }, { x: 20, y: 20 }, { x: 30, y: 0 }]);
    expect(d).toMatch(/^M 0\.00 10\.00 C /);
    expect(d).toMatch(/ 30\.00 0\.00$/);
    expect(d.match(/ C /g)).toHaveLength(3);
    // The flat segment stays flat: its control points sit on y = 20.
    expect(d).toContain('C 13.33 20.00 16.67 20.00 20.00 20.00');
    // Zero-width steps fall back to a straight join.
    expect(monotonePath([{ x: 0, y: 0 }, { x: 0, y: 5 }])).toBe('M 0.00 0.00 L 0.00 5.00');
  });
});
