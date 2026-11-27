import type { ChartPhase } from './PnlChart';
import type { PnlPoint } from './chart-series';

/** Dev-only chart harness: `?chartDemo=sending|fresh|winning|losing|closed` (or `1` for winning) feeds the result chart a synthetic
 * round so its phases can be looked at without placing a trade. Game.tsx only consults it under import.meta.env.DEV. */
export type ChartDemo = { phase: ChartPhase; points: PnlPoint[]; margin: number; span: number; sendingSince?: number; countdown?: string; final?: number };

const MARGIN = 5, SPAN = 5 * 60000;

/** A deterministic, noisy drift towards `end` over `seconds` samples, starting at the fees paid to open. */
function drift(start: number, end: number, seconds: number, t0: number, wobble = 1): PnlPoint[] {
  const points: PnlPoint[] = [];
  let noise = 0;
  for (let i = 0; i <= seconds; i++) {
    noise = noise * .9 + (Math.sin(i * .37) * .018 + Math.cos(i * .11) * .012 + Math.sin(i * 1.3) * .006) * wobble;
    const net = start + (end - start) * (i / seconds) + noise;
    points.push({ time: t0 + i * 1000, net, percent: net / MARGIN * 100 });
  }
  return points;
}

export function chartDemo(search: string, now: number): ChartDemo | undefined {
  const mode = new URLSearchParams(search).get('chartDemo');
  if (!mode) return undefined;
  const t0 = now - 150000;
  switch (mode) {
    case 'sending': return { phase: 'sending', points: [], margin: MARGIN, span: SPAN, sendingSince: now - 2000 };
    // Ten seconds in: nothing but the fee gap, so the dip under break-even and its "Fees" marker can be judged.
    case 'fresh': return { phase: 'open', points: drift(-.3, -.3, 10, now - 10000, .1), margin: MARGIN, span: SPAN, countdown: '4m 50s' };
    case 'losing': return { phase: 'open', points: drift(-.3, -1.1, 150, t0), margin: MARGIN, span: SPAN, countdown: '2m 30s' };
    case 'closed': return { phase: 'closed', points: drift(-.3, .82, 300, now - 300000), margin: MARGIN, span: SPAN, final: .82 };
    default: return { phase: 'open', points: drift(-.3, .64, 150, t0), margin: MARGIN, span: SPAN, countdown: '2m 30s' };
  }
}
