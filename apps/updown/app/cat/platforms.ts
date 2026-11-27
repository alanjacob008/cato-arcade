// The cat's world, read off the page: the top edge of every big panel is a floor it can walk on ("platforms"), the
// viewport bottom is the ground, and Cato's spot (the `[data-cat-home]` anchor floor) is the platform flagged `home`.
// Pure geometry (no DOM, no three.js): the overlay feeds it rects, the brain plans over the result. Two spaces:
// viewport px (y down) for extraction, the cat's metres (x from the viewport centre, y up from the ground) for the brain.

/** A measured element: a viewport-px rect. A `home` rect's `top` is the spot's floor line. */
export interface PlatformRect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  home?: boolean;
}

/** A keep-out zone (viewport px): something the cat must never stand on or cover, e.g. a button. */
export interface KeepOutRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A walkable edge in viewport px (y down). */
export interface PlatformPx {
  id: string;
  x0: number;
  x1: number;
  y: number;
  home: boolean;
  /** set on a segment of an edge split round keep-out zones: the full extent of the element's edge */
  span?: { x0: number; x1: number };
}

/** A walkable edge in the cat's metres: x from the viewport centre, y up from the ground (0). */
export interface Platform {
  id: string;
  x0: number;
  x1: number;
  y: number;
  home: boolean;
  /** segments only: the full extent of the edge they were cut from (there is floor, but off-limits, between them) */
  span?: { x0: number; x1: number };
}

export const GROUND_ID = 'ground';

/** Elements whose top edges are floors by default (plus anything marked `data-cat-platform`). */
export const PLATFORM_SELECTORS = [
  '[data-cat-platform]', '.nl-market-panel', '.nl-play-panel', '.nl-cat-panel', '.cato-header',
  '.nl-balance-bar', '.nl-live-round', '.nl-portfolio-content', '.nl-stat-tile',
];

/**
 * Elements the cat keeps off by default (plus anything marked `data-cat-avoid`): the page's controls. The idle
 * chart's call-to-action is covered by its buttons and its `data-cat-avoid` text, not its box: that box spans the
 * whole chart and would leave no ground at all at 1440×900.
 */
export const KEEPOUT_SELECTORS = ['[data-cat-avoid]', 'button', 'a', 'input', '[role=button]'];

/** A segment keeps its element's id when the whole edge is walkable; otherwise it is `<id>#<n>` (left to right). */
export function baseId(id: string): string {
  const i = id.indexOf('#');
  return i < 0 ? id : id.slice(0, i);
}

export interface ExtractOptions {
  /** cat height in px: platforms narrower than ~a cat are dropped, and so are edges too close to the top to draw it on */
  size: number;
  /** minimum platform width, in cat heights (a cat is about one height long). Default 1.2 */
  minWidth?: number;
  /** clearance needed above a platform, in cat heights. Default 1.1 */
  headroom?: number;
  /** zones (viewport px) no platform may run under: their x range, padded, is cut out of any edge they sit on */
  keepOut?: KeepOutRect[];
  /** how far the cut extends beyond a zone's sides, in cat heights (the cat is about a height long). Default 0.55 */
  avoidPad?: number;
  /** the ground line (viewport px, y down): the top of a fixed footer bar. Default (and cap): the viewport bottom */
  groundY?: number;
}

/** Elements whose top edge is the ground when present (the fixed footer bar), plus anything marked `data-cat-ground`. */
export const GROUND_SELECTORS = ['[data-cat-ground]', '.oui-scaffold-footer'];

/**
 * The walkable x ranges of a floor line at `y` spanning [x0, x1], once the keep-out zones resting on it are cut out.
 * A zone rests on the floor when it reaches into the cat height above it; one wholly below the line is inside (or
 * behind) the element the cat stands on. The cut is padded by `pad` either side so the cat's body clears the zone
 * too; pieces narrower than `minW` are dropped.
 */
export function segmentFloor(
  x0: number, x1: number, y: number, keepOut: KeepOutRect[], opts: { size: number; pad: number; minW: number },
): { x0: number; x1: number }[] {
  const cuts: [number, number][] = [];
  for (const r of keepOut) {
    if (!(r.right > r.left) || !(r.bottom > r.top)) continue;
    if (r.bottom <= y - opts.size || r.top >= y) continue;
    cuts.push([r.left - opts.pad, r.right + opts.pad]);
  }
  cuts.sort((a, b) => a[0] - b[0]);
  const out: { x0: number; x1: number }[] = [];
  let start = x0;
  for (const [l, r] of cuts) {
    if (r <= start) continue;
    if (l > start) out.push({ x0: start, x1: Math.min(l, x1) });
    start = Math.max(start, r);
    if (start >= x1) break;
  }
  if (start < x1) out.push({ x0: start, x1 });
  return out.filter((s) => s.x1 - s.x0 >= opts.minW);
}

/**
 * Rects (viewport px) -> platforms (viewport px), ground last. Narrow, off-screen and head-bumping edges are dropped;
 * ranges are clipped to the viewport and cut round keep-out zones (an edge with a zone on it becomes `<id>#<n>`
 * segments carrying the edge's full `span`). Rects are reported in order; the ground is last, when any of it is left.
 */
export function extractPlatforms(rects: PlatformRect[], viewport: { w: number; h: number }, opts: ExtractOptions): PlatformPx[] {
  const minW = opts.size * (opts.minWidth ?? 1.2);
  const minTop = opts.size * (opts.headroom ?? 1.1);
  const keepOut = opts.keepOut ?? [];
  const groundY = Math.min(viewport.h, opts.groundY ?? viewport.h);
  const seg = { size: opts.size, pad: opts.size * (opts.avoidPad ?? 0.55), minW };
  const out: PlatformPx[] = [];
  const add = (id: string, x0: number, x1: number, y: number, home: boolean) => {
    const segs = segmentFloor(x0, x1, y, keepOut, seg);
    if (segs.length === 1 && segs[0].x0 === x0 && segs[0].x1 === x1) {
      out.push({ id, x0, x1, y, home });
      return;
    }
    segs.forEach((s, n) => out.push({ id: `${id}#${n}`, x0: s.x0, x1: s.x1, y, home, span: { x0, x1 } }));
  };
  for (const r of rects) {
    const x0 = Math.max(0, r.left);
    const x1 = Math.min(viewport.w, r.right);
    if (x1 - x0 < minW) continue;
    if (!(r.top >= minTop) || r.top > groundY - 4) continue;
    add(r.id, x0, x1, r.top, !!r.home);
  }
  add(GROUND_ID, 0, viewport.w, groundY, false);
  return out;
}

/** px -> metres (k px per metre). x is measured from the viewport centre, y up from the viewport bottom. */
export function platformsToMetres(px: PlatformPx[], viewport: { w: number; h: number }, k: number): Platform[] {
  const mx = (x: number) => (x - viewport.w / 2) / k;
  return px.map((p) => ({
    id: p.id, home: p.home,
    x0: mx(p.x0), x1: mx(p.x1), y: (viewport.h - p.y) / k,
    ...(p.span ? { span: { x0: mx(p.span.x0), x1: mx(p.span.x1) } } : {}),
  }));
}

/** How far the cat can leap (metres). Larger drops are a fall. */
export interface Reach {
  /** max rise of a jump */
  up: number;
  /** max horizontal gap between two edges */
  gap: number;
  /** metres kept clear of a platform's ends */
  margin: number;
}

/** One hop: where to take off (on `from`) and where to land (on `to`). `fall` when the drop is beyond a jump. */
export interface Hop {
  from: string;
  to: string;
  takeoffX: number;
  landX: number;
  fall: boolean;
}

/** Walkable x range of a platform (margin kept clear of its ends; never empty). */
export function walkRange(p: Platform, margin: number): { min: number; max: number } {
  const mid = (p.x0 + p.x1) / 2;
  return { min: Math.min(mid, p.x0 + margin), max: Math.max(mid, p.x1 - margin) };
}

/**
 * The hop from `a` to `b`, planned from x `fromX`, or null when `b` is out of reach: too high, or too far sideways.
 * Overlapping ranges jump straight up/down (with a small forward hop, so the Jump clip reads as a leap); edges within
 * `reach.gap` of each other jump across. Drops deeper than `reach.up` are a fall (hop off, land below).
 */
export function planHop(a: Platform, b: Platform, fromX: number, reach: Reach): Hop | null {
  if (a.id === b.id) return null;
  // segments of one edge: the floor between them is a keep-out zone, never leapt over
  if (baseId(a.id) === baseId(b.id)) return null;
  const dy = b.y - a.y;
  if (dy > reach.up) return null;
  const fall = dy < -reach.up;
  const ra = walkRange(a, reach.margin);
  const rb = walkRange(b, reach.margin);
  const lo = Math.max(ra.min, rb.min);
  const hi = Math.min(ra.max, rb.max);
  if (lo <= hi) {
    const takeoffX = clamp(fromX, lo, hi);
    const dir = takeoffX < (lo + hi) / 2 ? 1 : -1;
    const landX = clamp(takeoffX + dir * 0.25, rb.min, rb.max);
    return { from: a.id, to: b.id, takeoffX, landX, fall };
  }
  // no overlap: jump across the gap between the edges, from and to the margin point on each
  if (b.x0 >= a.x1 && b.x0 - a.x1 <= reach.gap) return { from: a.id, to: b.id, takeoffX: ra.max, landX: rb.min, fall };
  if (a.x0 >= b.x1 && a.x0 - b.x1 <= reach.gap) return { from: a.id, to: b.id, takeoffX: ra.min, landX: rb.max, fall };
  return null;
}

/** Breadth-first route of hops from platform `from` (standing at x) to `to`; null when unreachable. */
export function planRoute(platforms: Platform[], from: string, to: string, x: number, reach: Reach): Hop[] | null {
  if (from === to) return [];
  const byId = new Map(platforms.map((p) => [p.id, p]));
  const start = byId.get(from);
  if (!start || !byId.has(to)) return null;
  const prev = new Map<string, { hop: Hop; x: number }>();
  const queue: { id: string; x: number }[] = [{ id: from, x }];
  const seen = new Set([from]);
  while (queue.length) {
    const cur = queue.shift()!;
    const a = byId.get(cur.id)!;
    for (const b of platforms) {
      if (seen.has(b.id)) continue;
      const hop = planHop(a, b, cur.x, reach);
      if (!hop) continue;
      seen.add(b.id);
      prev.set(b.id, { hop, x: hop.landX });
      if (b.id === to) {
        const route: Hop[] = [];
        for (let id = to; id !== from;) {
          const p = prev.get(id)!;
          route.unshift(p.hop);
          id = p.hop.from;
        }
        return route;
      }
      queue.push({ id: b.id, x: hop.landX });
    }
  }
  return null;
}

/** Platforms reachable in one hop from `from` standing at x. */
export function neighbours(platforms: Platform[], from: Platform, x: number, reach: Reach): Platform[] {
  return platforms.filter((p) => planHop(from, p, x, reach) !== null);
}

/**
 * The surface a cat at (x, y) falls onto: the highest platform under it (else the nearest piece of the ground, else
 * the lowest one). Keep-out zones are not platforms, so a fall never lands on one.
 */
export function landingBelow(platforms: Platform[], x: number, y: number, margin = 0): Platform | null {
  let best: Platform | null = null;
  let lowest: Platform | null = null;
  for (const p of platforms) {
    if (!lowest || p.y < lowest.y) lowest = p;
    if (p.y > y + 1e-6) continue;
    if (x < p.x0 - margin || x > p.x1 + margin) continue;
    if (!best || p.y > best.y) best = p;
  }
  return best ?? nearestAlong(platforms.filter((p) => baseId(p.id) === GROUND_ID), x) ?? lowest;
}

/** Horizontal distance from x to a platform's extent (0 when above it). */
export function distanceAlong(p: Platform, x: number): number {
  return x < p.x0 ? p.x0 - x : x > p.x1 ? x - p.x1 : 0;
}

/** The platform closest to x sideways, or null when there is none. */
export function nearestAlong(platforms: Platform[], x: number): Platform | null {
  let best: Platform | null = null;
  for (const p of platforms) if (!best || distanceAlong(p, x) < distanceAlong(best, x)) best = p;
  return best;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
