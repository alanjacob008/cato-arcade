import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHART_H, CHART_W, CROSS_PULSE_MS, FADE_MS, PnlChart, PNL_UNIT_KEY, SENDING_TIMEOUT_MS, signedValue } from './PnlChart';
import type { PnlPoint } from './chart-series';

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });
const points: PnlPoint[] = [{ time: 0, net: -.03, percent: -.6 }, { time: 1000, net: .12, percent: 2.4 }, { time: 2000, net: .25, percent: 5 }];
const value = () => container.querySelector('.nl-pnl-value');
const lead = () => container.querySelector<HTMLElement>('.nl-pnl-lead')!;
const zero = () => container.querySelector('.nl-pnl-zero')!;
const unitButton = (unit: string) => [...container.querySelectorAll<HTMLButtonElement>('.nl-pnl-units button')].find(b => b.textContent === unit)!;
const layout = () => {
  const svg = container.querySelector('svg')!;
  return [svg.getAttribute('viewBox'), svg.getAttribute('preserveAspectRatio'), zero().getAttribute('y1'), zero().getAttribute('y2'), container.querySelector('.nl-pnl-plot')?.className, container.querySelector('.nl-pnl-head')?.childElementCount];
};

describe('PnlChart', () => {
  it('rides the latest net result on the leading dot in dollars, then in percent of the bet after the toggle', () => {
    act(() => root.render(<PnlChart phase="open" points={points} margin={5} now={2000} countdown="4m 05s"/>));
    expect(value()?.textContent).toBe('+$0.25');
    expect(value()?.className).toContain('nl-positive');
    expect(lead().className).toContain('nl-positive');
    expect(container.querySelector('.nl-pnl-countdown')?.textContent).toBe('4m 05s');
    expect(container.querySelector('.nl-pnl-area-profit')).not.toBeNull();
    expect(container.querySelector('.nl-pnl-area-loss')).not.toBeNull();
    // One smooth curve from the first sample to the last; the dot sits on the last sample, above the middle.
    const d = container.querySelector('.nl-pnl-line')?.getAttribute('d');
    expect(d).toMatch(/^M 0\.00 .* C /);
    expect(d).toMatch(/ 20\.00 [\d.]+$/);
    expect(d).not.toContain(' L ');
    expect(lead().style.left).toBe('3.33%');
    expect(parseFloat(lead().style.top)).toBeLessThan(50);
    expect(container.querySelector('.nl-pnl-final')).toBeNull();
    act(() => unitButton('%').click());
    expect(value()?.textContent).toBe('+5.00%');
    expect(unitButton('%').getAttribute('aria-pressed')).toBe('true');
    expect(unitButton('$').getAttribute('aria-pressed')).toBe('false');
    act(() => root.render(<PnlChart phase="open" points={[points[0]]} margin={5} now={0}/>));
    expect(value()?.textContent).toBe('-0.60%');
    expect(value()?.className).toContain('nl-negative');
    expect(lead().className).toContain('nl-negative');
    expect(parseFloat(lead().style.top)).toBeGreaterThan(50);
    // Alone, the opening fee sets the scale: three gaps tall each side, so the dip is a third of the way down.
    expect(container.querySelector('.nl-pnl-line')?.getAttribute('d')).toBe('M 0.00 ' + (110 + 94 * .03 / .09).toFixed(2));
  });
  it('keeps the zero line in the vertical middle whatever the series, and scales symmetrically around it', () => {
    const half = String(CHART_H / 2);
    const series: PnlPoint[][] = [[], [points[0]], points, [{ time: 0, net: 4, percent: 80 }, { time: 1000, net: 3.5, percent: 70 }], [{ time: 0, net: -.001, percent: -.02 }, { time: 1000, net: -9, percent: -180 }]];
    for (const s of series) {
      act(() => root.render(<PnlChart phase="open" points={s} margin={5} now={1000}/>));
      expect(zero().getAttribute('y1')).toBe(half);
      expect(zero().getAttribute('y2')).toBe(half);
      expect(container.querySelector('clipPath rect')?.getAttribute('height')).toBe(half);
    }
    // Opposite values sit the same distance from the middle; a flat start is held to the floor rather than blown up.
    act(() => root.render(<PnlChart phase="open" points={[{ time: 0, net: -.1, percent: -2 }, { time: 1000, net: 1, percent: 20 }]} margin={5} now={1000}/>));
    const up = parseFloat(lead().style.top);
    act(() => root.render(<PnlChart phase="open" points={[{ time: 0, net: -.1, percent: -2 }, { time: 1000, net: -1, percent: -20 }]} margin={5} now={1000}/>));
    expect(50 - up).toBeCloseTo(parseFloat(lead().style.top) - 50, 5);
    act(() => root.render(<PnlChart phase="open" points={[{ time: 0, net: .002, percent: .04 }]} margin={5} now={0}/>));
    // Floor is 0.5% of a $5 stake = $0.025: a 0.2 cent move stays within a few percent of the middle.
    expect(50 - parseFloat(lead().style.top)).toBeCloseTo(.002 / .025 * (50 - 16 / CHART_H * 100), 1);
  });
  it('flips the value pill to the left of the dot near the right edge', () => {
    const late: PnlPoint[] = [points[0], { ...points[2], time: 50000 }];
    act(() => root.render(<PnlChart phase="open" points={late} margin={5} now={50000} span={60000}/>));
    expect(lead().getAttribute('data-side')).toBe('left');
    expect(lead().style.left).toBe('83.33%');
    act(() => root.render(<PnlChart phase="open" points={late} margin={5} now={50000} span={120000}/>));
    expect(lead().getAttribute('data-side')).toBe('right');
    expect(lead().style.left).toBe('41.67%');
  });
  it('remembers the unit across mounts', () => {
    act(() => root.render(<PnlChart phase="open" points={points} margin={5} now={2000}/>));
    act(() => unitButton('%').click());
    expect(localStorage.getItem(PNL_UNIT_KEY)).toBe('%');
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<PnlChart phase="open" points={points} margin={5} now={2000}/>));
    expect(value()?.textContent).toBe('+5.00%');
    act(() => unitButton('$').click());
    expect(localStorage.getItem(PNL_UNIT_KEY)).toBe('$');
  });
  it('parks the dot and pill on the final result when closed, with the win or loss colour', () => {
    act(() => root.render(<PnlChart phase="closed" points={points} margin={5} now={9000} final={-.04}/>));
    expect(value()?.textContent).toBe('-$0.04');
    expect(value()?.className).toContain('nl-negative');
    expect(container.querySelector('.nl-pnl-final')?.textContent).toBe('Final');
    expect(container.querySelector('.nl-pnl-countdown')).toBeNull();
    // The dot sits at the final value (below the middle), not on the last optimistic sample.
    expect(parseFloat(lead().style.top)).toBeGreaterThan(50);
    act(() => unitButton('%').click());
    expect(value()?.textContent).toBe('-0.80%');
    act(() => root.render(<PnlChart phase="closed" points={points} margin={5} now={9000}/>));
    expect(value()?.textContent).toBe('Confirming result…');
    expect(container.querySelector('.nl-pnl-final')).toBeNull();
    expect(parseFloat(lead().style.top)).toBe(50);
  });
  it('walks through the order steps while sending, and says the fill is being finished after the maker window without inventing one', () => {
    const onCancel = vi.fn();
    const render = (now: number, progress?: string) => act(() => root.render(<PnlChart phase="sending" points={[]} sendingSince={100000} now={now} progress={progress} onCancel={onCancel}/>));
    render(100000);
    const steps = () => [...container.querySelectorAll('.nl-pnl-steps li')].map(li => [li.textContent, li.className]);
    expect(steps()).toEqual([['Placing your call…', 'active'], ['Waiting for a fill at the best price…', ''], ['Locked in!', '']]);
    expect(container.querySelector('.nl-pnl-fill-progress')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('.nl-pnl-cancel')!.click());
    expect(onCancel).toHaveBeenCalledOnce();
    expect([...container.querySelectorAll('.nl-pnl-step-dots i')].map(i => i.className)).toEqual(['lit', '', '']);
    // The origin dot waits on the zero line, without a number; the shimmer runs along the guide.
    expect(parseFloat(lead().style.left)).toBe(0);
    expect(parseFloat(lead().style.top)).toBe(50);
    expect(container.querySelector('.nl-pnl-pill')).toBeNull();
    expect(container.querySelector('.nl-pnl-shimmer')).not.toBeNull();
    expect(container.querySelector('.nl-pnl-value')).toBeNull();
    render(100000 + 3000, 'Filled 40%');
    expect(steps()).toEqual([['Placing your call…', 'done'], ['Waiting for a fill at the best price…', 'active'], ['Locked in!', '']]);
    expect(container.querySelector('.nl-pnl-fill-progress')?.textContent).toBe('Filled 40%');
    expect([...container.querySelectorAll('.nl-pnl-step-dots i')].map(i => i.className)).toEqual(['lit', 'lit', '']);
    expect(SENDING_TIMEOUT_MS).toBe(20000);
    render(100000 + SENDING_TIMEOUT_MS - 1);
    expect(container.textContent).not.toContain('Finishing the fill');
    render(100000 + SENDING_TIMEOUT_MS, 'Filled 40%');
    expect(container.querySelector('.nl-pnl-stalled')?.textContent).toBe('Finishing the fill…');
    expect(container.querySelector('.nl-pnl-steps')).toBeNull();
    expect(container.textContent).not.toContain('Locked in');
    expect(container.querySelector('.nl-pnl-fill-progress')?.textContent).toBe('Filled 40%');
    expect(container.querySelector('.nl-pnl-cancel')).not.toBeNull();
    // Without a cancel handler (the service already has the request) there is no link.
    act(() => root.render(<PnlChart phase="sending" points={[]} sendingSince={100000} now={100000}/>));
    expect(container.querySelector('.nl-pnl-cancel')).toBeNull();
  });
  it('never moves the canvas between phases: same viewBox, same zero line, same head, and the fill grows from the origin dot', () => {
    vi.useFakeTimers();
    act(() => root.render(<PnlChart phase="idle" points={[]} now={0} idle={<button className="cta">Up</button>}/>));
    const idle = layout();
    expect(idle[0]).toBe(`0 0 ${CHART_W} ${CHART_H}`);
    act(() => root.render(<PnlChart phase="sending" points={[]} now={1000} sendingSince={1000} idle={<button className="cta">Up</button>}/>));
    expect(layout()).toEqual(idle);
    // The call fades out under the sending state rather than vanishing, then is gone.
    expect(container.querySelector('.nl-pnl-call[data-leaving] .cta')).not.toBeNull();
    expect(container.querySelector('.nl-pnl-call[data-leaving]')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.nl-pnl-wait')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(FADE_MS); });
    expect(container.querySelector('.cta')).toBeNull();
    const origin = [lead().style.left, lead().style.top];
    act(() => root.render(<PnlChart phase="open" points={[{ time: 2000, net: 0, percent: 0 }]} margin={5} now={2000} span={60000} idle={<button className="cta">Up</button>}/>));
    expect(layout()).toEqual(idle);
    expect([lead().style.left, lead().style.top]).toEqual(origin);
    expect(container.querySelector('.cta')).toBeNull();
    expect(container.querySelector('.nl-pnl-wait')).toBeNull();
    act(() => root.render(<PnlChart phase="closed" points={[{ time: 2000, net: 0, percent: 0 }]} margin={5} now={9000} final={.2}/>));
    expect(layout()).toEqual(idle);
  });
  it('shows a flat zero line and the hint while idle, or the given call to action in its place', () => {
    act(() => root.render(<PnlChart phase="idle" points={[]} now={0}/>));
    expect(container.querySelector('.nl-pnl-hint')?.textContent).toBe('Pick Up or Down to play');
    expect(container.querySelector('.nl-pnl-zero')).not.toBeNull();
    expect(container.querySelector('.nl-pnl-line')).toBeNull();
    expect(container.querySelector('.nl-pnl-lead')).toBeNull();
    expect(container.querySelector('.nl-pnl-value')).toBeNull();
    act(() => root.render(<PnlChart phase="idle" points={[]} now={0} idle={<button className="cta">Up</button>}/>));
    expect(container.querySelector('.nl-pnl-plot .cta')?.textContent).toBe('Up');
    expect(container.querySelector('.nl-pnl-hint')).toBeNull();
    // Mounted straight into another phase, nothing of the call is shown.
    act(() => root.unmount()); root = createRoot(container);
    act(() => root.render(<PnlChart phase="sending" points={[]} now={0} sendingSince={0} idle={<button className="cta">Up</button>}/>));
    expect(container.querySelector('.cta')).toBeNull();
  });
  it('names the zero line break-even in every phase, and marks the first sample as fees until the line has moved on', () => {
    act(() => root.render(<PnlChart phase="idle" points={[]} now={0}/>));
    expect(container.querySelector('.nl-pnl-breakeven')?.textContent).toBe('Break-even');
    expect(container.querySelector('.nl-pnl-fee')).toBeNull();
    act(() => root.render(<PnlChart phase="sending" points={[]} now={0} sendingSince={0}/>));
    expect(container.querySelector('.nl-pnl-breakeven')?.textContent).toBe('Break-even');
    expect(container.querySelector('.nl-pnl-fee')).toBeNull();
    // A fresh round: only the fee gap. The marker sits on the first sample, under the middle, with its label.
    const start: PnlPoint = { time: 0, net: -.3, percent: -6 };
    act(() => root.unmount()); root = createRoot(container);
    act(() => root.render(<PnlChart phase="open" points={[start]} margin={5} now={0} span={300000}/>));
    expect(container.querySelector('.nl-pnl-breakeven')?.textContent).toBe('Break-even');
    const fee = () => container.querySelector<HTMLElement>('.nl-pnl-fee');
    expect(fee()?.textContent).toBe('Fees');
    expect(fee()?.hasAttribute('data-faded')).toBe(false);
    expect(parseFloat(fee()!.style.left)).toBe(0);
    expect(parseFloat(fee()!.style.top)).toBeCloseTo(parseFloat(lead().style.top), 5);
    // The gap sets the scale: three gaps each side of zero, so the dip is a third of the half-height, not a cliff.
    expect(parseFloat(fee()!.style.top)).toBeCloseTo(50 + (50 - 16 / CHART_H * 100) / 3, 2);
    // Twenty seconds in and only wobbling around the gap: still shown.
    act(() => root.render(<PnlChart phase="open" points={[start, { time: 20000, net: -.4, percent: -8 }]} margin={5} now={20000} span={300000}/>));
    expect(fee()?.hasAttribute('data-faded')).toBe(false);
    // Past two gaps from zero: faded, and it stays faded even if the line comes back.
    act(() => root.render(<PnlChart phase="open" points={[start, { time: 21000, net: .7, percent: 14 }, { time: 22000, net: -.2, percent: -4 }]} margin={5} now={22000} span={300000}/>));
    expect(fee()?.hasAttribute('data-faded')).toBe(true);
    // Or thirty seconds in, however little it moved.
    act(() => root.render(<PnlChart phase="open" points={[start, { time: 29000, net: -.3, percent: -6 }]} margin={5} now={29000} span={300000}/>));
    expect(fee()?.hasAttribute('data-faded')).toBe(false);
    act(() => root.render(<PnlChart phase="open" points={[start, { time: 30000, net: -.3, percent: -6 }]} margin={5} now={30000} span={300000}/>));
    expect(fee()?.hasAttribute('data-faded')).toBe(true);
    // Closed rounds never show it; a round that somehow starts on zero has no gap to mark.
    act(() => root.render(<PnlChart phase="closed" points={[start]} margin={5} now={9000} final={.2}/>));
    expect(fee()?.hasAttribute('data-faded')).toBe(true);
    act(() => root.render(<PnlChart phase="open" points={[{ time: 0, net: 0, percent: 0 }]} margin={5} now={0}/>));
    expect(fee()).toBeNull();
  });
  it('pulses the zero line once when the line first crosses break-even upward, and again only for a new round', () => {
    vi.useFakeTimers();
    const start: PnlPoint = { time: 0, net: -.3, percent: -6 };
    act(() => root.render(<PnlChart phase="open" points={[start]} margin={5} now={0}/>));
    expect(zero().classList.contains('nl-pnl-zero-cross')).toBe(false);
    expect(zero().hasAttribute('data-crossed')).toBe(false);
    act(() => root.render(<PnlChart phase="open" points={[start, { time: 1000, net: -.1, percent: -2 }]} margin={5} now={1000}/>));
    expect(zero().classList.contains('nl-pnl-zero-cross')).toBe(false);
    act(() => root.render(<PnlChart phase="open" points={[start, { time: 1000, net: -.1, percent: -2 }, { time: 2000, net: .05, percent: 1 }]} margin={5} now={2000}/>));
    expect(zero().classList.contains('nl-pnl-zero-cross')).toBe(true);
    expect(zero().hasAttribute('data-crossed')).toBe(true);
    act(() => { vi.advanceTimersByTime(CROSS_PULSE_MS); });
    expect(zero().classList.contains('nl-pnl-zero-cross')).toBe(false);
    expect(zero().hasAttribute('data-crossed')).toBe(true);
    // Dipping back under and recrossing later in the same round is not a first cross.
    act(() => root.render(<PnlChart phase="open" points={[start, { time: 2000, net: .05, percent: 1 }, { time: 3000, net: -.2, percent: -4 }, { time: 4000, net: .3, percent: 6 }]} margin={5} now={4000}/>));
    expect(zero().classList.contains('nl-pnl-zero-cross')).toBe(false);
    // A new round (new first sample) crossing again pulses again.
    act(() => root.render(<PnlChart phase="open" points={[{ time: 10000, net: -.3, percent: -6 }]} margin={5} now={10000}/>));
    expect(zero().classList.contains('nl-pnl-zero-cross')).toBe(false);
    act(() => root.render(<PnlChart phase="open" points={[{ time: 10000, net: -.3, percent: -6 }, { time: 11000, net: .1, percent: 2 }]} margin={5} now={11000}/>));
    expect(zero().classList.contains('nl-pnl-zero-cross')).toBe(true);
    // Mounting onto a round that had already crossed (a reload, the demo) is not the moment of crossing: no pulse.
    act(() => root.unmount()); root = createRoot(container);
    act(() => root.render(<PnlChart phase="open" points={[{ time: 20000, net: -.3, percent: -6 }, { time: 21000, net: .1, percent: 2 }]} margin={5} now={21000}/>));
    expect(zero().classList.contains('nl-pnl-zero-cross')).toBe(false);
    expect(zero().hasAttribute('data-crossed')).toBe(true);
  });
  it('formats signed values', () => {
    expect(signedValue(.12, '$')).toBe('+$0.12');
    expect(signedValue(-1.5, '$')).toBe('-$1.50');
    expect(signedValue(2.4, '%')).toBe('+2.40%');
    expect(signedValue(undefined, '$')).toBe('—');
  });
});
