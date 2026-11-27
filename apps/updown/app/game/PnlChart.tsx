import { ReactNode, useEffect, useId, useRef, useState } from 'react';
import { dollars } from './api';
import { crossedBreakEven, feeGap, monotonePath, PnlPoint, PnlUnit, pointValue, rangeFloor, symmetricRange } from './chart-series';

export type ChartPhase = 'idle' | 'sending' | 'open' | 'closed';
/** The opening quote's maker window (server MAKER_WINDOW_S): past it the service is finishing the fill with a market order. */
export const SENDING_TIMEOUT_MS = 20000;
/** The order's first step lasts this long before the label moves on to waiting for the fill. */
export const SENDING_STEP_MS = 1500;
export const SENDING_STEPS = ['Placing your call…', 'Waiting for a fill at the best price…', 'Locked in!'] as const;
export const PNL_UNIT_KEY = 'updown.pnl-unit';
/** The idle call to action keeps fading out this long after a direction is chosen. */
export const FADE_MS = 320;
/** The "Fees" start marker fades once the line has moved this many fee gaps from zero, or this long into the round. */
export const FEE_MARK_MOVE = 2, FEE_MARK_MS = 30000;
/** One soft pulse of the zero line when the round first turns to profit; the class is dropped again after this long. */
export const CROSS_PULSE_MS = 1400;

export function readPnlUnit(): PnlUnit {
  try { return localStorage.getItem(PNL_UNIT_KEY) === '%' ? '%' : '$'; } catch { return '$'; }
}
function savePnlUnit(unit: PnlUnit) {
  try { localStorage.setItem(PNL_UNIT_KEY, unit); } catch { /* Private mode: the toggle still works for this page. */ }
}
function reducedMotion() {
  try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** "+$0.12" / "-$1.0400" / "+2.40%": the sign is always spelled out so a result never reads as a price. */
export function signedValue(value: number | undefined, unit: PnlUnit) {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return unit === '%' ? `${sign}${value.toFixed(2)}%` : `${sign}${dollars(value, 2)}`;
}
const tone = (value: number | undefined) => value == null || !Number.isFinite(value) || value === 0 ? '' : value > 0 ? 'nl-positive' : 'nl-negative';

/** One canvas for every phase: the zero line is always at H / 2, so nothing moves when a phase changes. */
export const CHART_W = 600, CHART_H = 220;
const W = CHART_W, H = CHART_H, PAD = 16, ZERO = H / 2;
/** Past this share of the width the value pill sits on the left of the dot so it never leaves the plot. */
const FLIP_AT = .72;

type Props = {
  phase: ChartPhase;
  /** The round's samples, oldest first (open and closed phases). */
  points: PnlPoint[];
  /** The bet, so a final dollar result can also read as a percentage and the scale floor knows the stake. */
  margin?: number;
  /** When the player clicked (sending phase). */
  sendingSince?: number;
  /** Sending phase: how much of the call has filled so far ("Filled 40%"), once the service reports a partial fill. */
  progress?: string;
  /** Sending phase: cancel the opening (the service pulls the quote; anything filled is closed). */
  onCancel?: () => void;
  now: number;
  /** Time axis span in ms (opening to deadline); the line grows left to right across it. */
  span?: number;
  /** Countdown text pinned top right (open phase). */
  countdown?: string;
  /** Closed phase: the confirmed trading result in dollars, or undefined while unreconciled. */
  final?: number;
  /** Extra copy beside the countdown (e.g. "Closing…"). */
  note?: string;
  /** Idle phase: what sits over the empty plot (the call to action). Without it, a one-line hint. */
  idle?: ReactNode;
};

/** The scale grows with a round's swing, eased so a new high never snaps the line. It shrinks at once, and a new round or
 * unit (a new `key`) starts from its own scale. */
function useEasedRange(target: number, key: string) {
  const [shown, setShown] = useState(target);
  const keyed = useRef(key);
  const snap = target < shown || keyed.current !== key;
  useEffect(() => {
    keyed.current = key;
    if (shown === target) return;
    if (snap || reducedMotion() || typeof requestAnimationFrame !== 'function') { setShown(target); return; }
    const frame = requestAnimationFrame(() => setShown(s => target - s < target * .003 ? target : s + (target - s) * .16));
    return () => cancelAnimationFrame(frame);
  }, [shown, target, key, snap]);
  return snap ? target : shown;
}

export function PnlChart({ phase, points, margin, sendingSince, progress, onCancel, now, span, countdown, final, note, idle }: Props) {
  const [unit, setUnit] = useState<PnlUnit>(readPnlUnit);
  const id = useId().replaceAll(':', '');
  const choose = (next: PnlUnit) => { setUnit(next); savePnlUnit(next); };
  const live = phase === 'open' || phase === 'closed';
  const values = live ? points.map(p => pointValue(p, unit)) : [];
  const last = live ? points.at(-1) : undefined;
  const finalValue = final == null ? undefined : unit === '%' ? margin && margin > 0 ? final / margin * 100 : undefined : final;
  const pinned = phase === 'closed' ? finalValue : last ? pointValue(last, unit) : undefined;
  const t0 = points[0]?.time ?? now;
  // The round starts under break-even by the fees it pays. The scale is at least a few gaps tall, so that opening cost
  // is a small dip in the middle, and the first sample carries a "Fees" marker until the line has moved on.
  const gap = live ? feeGap(points, unit) : 0;
  const range = useEasedRange(symmetricRange(pinned == null ? values : [...values, pinned], rangeFloor(unit, margin, gap)), `${unit}:${phase === 'idle' ? '' : t0}`);
  const swing = values.reduce((peak, v) => Number.isFinite(v) ? Math.max(peak, Math.abs(v)) : peak, 0);
  const feeMark = live && gap > 0;
  const feeMarkFaded = feeMark && (phase === 'closed' || swing > gap * FEE_MARK_MOVE || (last!.time - t0) >= FEE_MARK_MS);
  // The zero line pulses once when the line first crosses it upward in a round: on the change, so a chart mounted onto a
  // round that had already crossed stays quiet. A new round (new t0) may pulse again.
  const crossed = live && crossedBreakEven(points);
  const [pulse, setPulse] = useState(false);
  const seen = useRef<{ t0: number; crossed: boolean }>();
  useEffect(() => {
    const before = seen.current;
    seen.current = { t0, crossed };
    if (!crossed || !before || before.t0 !== t0 || before.crossed) return;
    setPulse(true);
    const timer = setTimeout(() => setPulse(false), CROSS_PULSE_MS);
    return () => { clearTimeout(timer); setPulse(false); };
  }, [crossed, t0]);
  const y = (v: number) => ZERO - v / range * (ZERO - PAD);
  const width = Math.max(span || 0, (last?.time ?? t0) - t0, 60000);
  const x = (t: number) => Math.min(W, Math.max(0, (t - t0) / width * W));
  const line = monotonePath(points.map(p => ({ x: x(p.time), y: y(pointValue(p, unit)) })));
  const area = points.length > 1 ? `${line} L ${x(last!.time).toFixed(2)} ${ZERO} L ${x(t0).toFixed(2)} ${ZERO} Z` : '';
  // The leading dot: the origin while sending, the latest sample while open, the confirmed result once closed.
  const leadX = last ? x(last.time) : 0;
  const leadY = pinned == null ? ZERO : Math.min(H - PAD, Math.max(PAD, y(pinned)));
  const elapsed = sendingSince != null ? now - sendingSince : 0;
  const stalled = phase === 'sending' && elapsed >= SENDING_TIMEOUT_MS;
  const step = phase === 'sending' ? elapsed < SENDING_STEP_MS ? 0 : 1 : -1;
  const label = phase === 'idle' ? 'No round in play.' : phase === 'sending' ? 'Placing your call.' : `Round result ${signedValue(pinned, unit)}${phase === 'closed' ? ', final' : ''}.`;
  // Leaving idle, the call to action lingers (inert, still live so its buttons read as disabled) and fades under the
  // sending state: a crossfade rather than a cut.
  const idleNode = idle ?? <p className="nl-pnl-hint">Pick Up or Down to play</p>;
  const previous = useRef(phase);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const wasIdle = previous.current === 'idle';
    previous.current = phase;
    if (phase === 'idle' || !wasIdle || reducedMotion()) { setLeaving(false); return; }
    setLeaving(true);
    const timer = setTimeout(() => setLeaving(false), FADE_MS);
    return () => { clearTimeout(timer); setLeaving(false); };
  }, [phase]);
  return <div className={`nl-pnl-chart nl-pnl-${phase}`} data-phase={phase}>
    <div className="nl-pnl-head">
      <div className="nl-pnl-legend"><i className="nl-pnl-key-profit"/> Profit <i className="nl-pnl-key-loss"/> Loss <span className="nl-pnl-caption">Estimated after fees</span></div>
      <div className="nl-pnl-pinned" aria-live="polite">
        {note && <small className="nl-pnl-note">{note}</small>}
        {phase === 'open' && countdown && <span className="nl-pnl-countdown">{countdown}</span>}
      </div>
      <div className="nl-pnl-units" role="group" aria-label="Result unit">{(['$', '%'] as const).map(u => <button key={u} type="button" aria-pressed={unit === u} onClick={() => choose(u)}>{u}</button>)}</div>
    </div>
    <div className="nl-pnl-plot">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        <defs>
          <clipPath id={`${id}-above`}><rect x="0" y="0" width={W} height={ZERO}/></clipPath>
          <clipPath id={`${id}-below`}><rect x="0" y={ZERO} width={W} height={ZERO}/></clipPath>
        </defs>
        {[.25, .75].map(f => <line key={f} className="nl-pnl-grid" x1="0" x2={W} y1={H * f} y2={H * f}/>)}
        <line className={`nl-pnl-zero${pulse ? ' nl-pnl-zero-cross' : ''}`} data-crossed={crossed ? '' : undefined} x1="0" x2={W} y1={ZERO} y2={ZERO}/>
        {area && <>
          <path className="nl-pnl-area-profit" d={area} clipPath={`url(#${id}-above)`}/>
          <path className="nl-pnl-area-loss" d={area} clipPath={`url(#${id}-below)`}/>
        </>}
        {live && points.length > 0 && <path className="nl-pnl-line" d={line} fill="none" vectorEffect="non-scaling-stroke"/>}
      </svg>
      <span className="nl-pnl-breakeven" aria-hidden="true">Break-even</span>
      {feeMark && <div className="nl-pnl-fee" data-faded={feeMarkFaded ? '' : undefined} aria-hidden="true" style={{ left: `${(x(t0) / W * 100).toFixed(2)}%`, top: `${(Math.min(H - PAD, y(-gap)) / H * 100).toFixed(2)}%` }}>
        <i/><small>Fees</small>
      </div>}
      {phase === 'sending' && <i className="nl-pnl-shimmer" aria-hidden="true"/>}
      {phase !== 'idle' && <div className={`nl-pnl-lead ${tone(pinned)}`} data-side={leadX / W > FLIP_AT ? 'left' : 'right'} style={{ left: `${(leadX / W * 100).toFixed(2)}%`, top: `${(leadY / H * 100).toFixed(2)}%` }}>
        <i className="nl-pnl-dot" aria-hidden="true"/>
        {live && <div className="nl-pnl-pill">
          <strong className={`nl-pnl-value ${tone(pinned)}`} data-unit={unit}>{pinned == null ? phase === 'closed' ? 'Confirming result…' : 'Waiting for fill…' : signedValue(pinned, unit)}</strong>
          {phase === 'closed' && pinned != null && <small className="nl-pnl-final">Final</small>}
        </div>}
      </div>}
      {phase === 'idle' && <div className="nl-pnl-call">{idleNode}</div>}
      {phase !== 'idle' && leaving && <div className="nl-pnl-call" data-leaving="" aria-hidden="true" {...{ inert: '' }}>{idleNode}</div>}
      {phase === 'sending' && <div className="nl-pnl-wait" role="status">
        {stalled ? <span className="nl-pnl-stalled">Finishing the fill…</span>
          : <div className="nl-pnl-progress">
            <ol className="nl-pnl-steps" aria-label="Round progress">{SENDING_STEPS.map((name, i) => <li key={name} className={i < step ? 'done' : i === step ? 'active' : ''} aria-current={i === step ? 'step' : undefined}>{name}</li>)}</ol>
            <span className="nl-pnl-step-dots" aria-hidden="true">{SENDING_STEPS.map((name, i) => <i key={name} className={i <= step ? 'lit' : ''}/>)}</span>
          </div>}
        {progress && <span className="nl-pnl-fill-progress">{progress}</span>}
        {onCancel && <button type="button" className="nl-pnl-cancel" onClick={onCancel}>Cancel</button>}
      </div>}
    </div>
  </div>;
}
