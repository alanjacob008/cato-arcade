import type { Round } from './api';
import { roundPnl } from './pnl';

/** One second of a round: unrealised net result after fees, in dollars and as a share of the bet. */
export type PnlPoint = { time: number; net: number; percent: number };
export type PnlUnit = '$' | '%';

/** At most one point per second, capped at two hours of play. */
export const MAX_SERIES_POINTS = 2 * 60 * 60;
const MAX_ROUNDS = 12;

/** The estimate right now, or undefined while the fill is unknown or the position is reconciling. */
export function pnlPoint(round: Round, mark: number | undefined, feeRate: number, time: number): PnlPoint | undefined {
  if (!(round.margin > 0)) return undefined;
  const pnl = roundPnl(round, mark, feeRate);
  if (!pnl || !Number.isFinite(pnl.net)) return undefined;
  return { time, net: pnl.net, percent: pnl.net / round.margin * 100 };
}

/** Appends a sample, replacing an earlier sample from the same second, keeping time order and the cap. */
export function appendPnlPoint(points: PnlPoint[], point: PnlPoint): PnlPoint[] {
  if (!Number.isFinite(point.time) || !Number.isFinite(point.net) || !Number.isFinite(point.percent)) return points;
  const second = Math.floor(point.time / 1000);
  const kept = points.filter(p => p.time < point.time && Math.floor(p.time / 1000) !== second);
  return [...kept, point].slice(-MAX_SERIES_POINTS);
}

export const pointValue = (point: PnlPoint, unit: PnlUnit) => unit === '%' ? point.percent : point.net;

// Series live in memory for this page session only: no credentials, no cross-account data.
const series = new Map<string, PnlPoint[]>();
export function roundSeries(roundId: string | undefined): PnlPoint[] {
  return roundId ? series.get(roundId) || [] : [];
}
export function recordPnl(roundId: string, point: PnlPoint): PnlPoint[] {
  const points = appendPnlPoint(series.get(roundId) || [], point);
  series.delete(roundId);
  series.set(roundId, points);
  while (series.size > MAX_ROUNDS) series.delete(series.keys().next().value!);
  return points;
}
/** Tests only. */
export function clearSeries() { series.clear(); }

/** Half-height of a scale centred on zero: the largest swing with headroom, never under the floor, so the baseline sits in
 * the middle of the plot and a flat start is not blown up into noise. */
export function symmetricRange(values: number[], floor: number, headroom = 1.25) {
  let peak = 0;
  for (const v of values) if (Number.isFinite(v)) peak = Math.max(peak, Math.abs(v));
  return Math.max(floor, peak * headroom);
}
/** The scale is at least this many fee gaps tall on each side of zero, so a round's opening cost (the close fee already
 * counted) reads as a small dip under break-even rather than a cliff down the whole plot. */
export const FEE_GAP_FLOOR = 3;
/** The scale floor for a unit: half a percent of the bet in dollars (at least a cent), or half a percent; never under
 * FEE_GAP_FLOOR times the starting fee gap (`gap`, in the unit, as a positive size). */
export const rangeFloor = (unit: PnlUnit, margin: number | undefined, gap = 0) =>
  Math.max(unit === '%' ? .5 : Math.max(.01, (margin || 0) * .005), Number.isFinite(gap) ? Math.abs(gap) * FEE_GAP_FLOOR : 0);
/** How far under break-even the round started: the fees already paid or owed at the first sample, as a positive size in
 * the unit. Zero without samples or when the first sample is not below zero. */
export const feeGap = (points: PnlPoint[], unit: PnlUnit) => {
  const first = points[0];
  if (!first) return 0;
  const value = pointValue(first, unit);
  return Number.isFinite(value) && value < 0 ? -value : 0;
};

/** The first sample at or above break-even after an earlier one below it: the moment the round turned from paying its
 * fees to being in profit. Undefined until it happens (a series that starts on or above zero has nothing to cross). */
export function firstBreakEvenCross(points: PnlPoint[]): PnlPoint | undefined {
  let below = false;
  for (const p of points) {
    if (p.net < 0) below = true;
    else if (below && p.net >= 0) return p;
  }
  return undefined;
}
/** Whether the round's line has crossed break-even upward at least once (for the chart's one-off highlight, and later
 * a sound cue in Game.tsx). */
export const crossedBreakEven = (points: PnlPoint[]) => firstBreakEvenCross(points) !== undefined;

export type XY = { x: number; y: number };
const f = (n: number) => n.toFixed(2);
/** Monotone cubic (Fritsch-Carlson) path through the points: one smooth line that never overshoots a sample. */
export function monotonePath(points: XY[]): string {
  const n = points.length;
  if (!n) return '';
  if (n === 1) return `M ${f(points[0].x)} ${f(points[0].y)}`;
  const dx: number[] = [], slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1].x - points[i].x);
    slope.push(dx[i] > 0 ? (points[i + 1].y - points[i].y) / dx[i] : 0);
  }
  const m: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) m.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  m.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i], b = m[i + 1] / slope[i], h = Math.hypot(a, b);
    if (h > 3) { m[i] = 3 * a / h * slope[i]; m[i + 1] = 3 * b / h * slope[i]; }
  }
  let d = `M ${f(points[0].x)} ${f(points[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i], p1 = points[i + 1], third = dx[i] / 3;
    d += dx[i] > 0
      ? ` C ${f(p0.x + third)} ${f(p0.y + m[i] * third)} ${f(p1.x - third)} ${f(p1.y - m[i + 1] * third)} ${f(p1.x)} ${f(p1.y)}`
      : ` L ${f(p1.x)} ${f(p1.y)}`;
  }
  return d;
}
