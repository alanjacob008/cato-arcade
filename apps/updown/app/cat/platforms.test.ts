import { describe, expect, it } from 'vitest';
import {
  GROUND_ID, baseId, extractPlatforms, landingBelow, neighbours, planHop, planRoute, platformsToMetres, segmentFloor,
  walkRange, type Platform, type Reach,
} from './platforms';

const VIEW = { w: 1440, h: 900 };
const SIZE = 140;

describe('extractPlatforms', () => {
  it('turns the top edge of every big rect into a platform, ground last, home flagged', () => {
    const out = extractPlatforms([
      { id: 'home', left: 1065, top: 527, right: 1409, bottom: 546, home: true },
      { id: 'p1', left: 24, top: 311, right: 1042, bottom: 1098 },
      { id: 'p2', left: 1064, top: 569, right: 1410, bottom: 1098 },
    ], VIEW, { size: SIZE });
    expect(out).toEqual([
      { id: 'home', x0: 1065, x1: 1409, y: 527, home: true },
      { id: 'p1', x0: 24, x1: 1042, y: 311, home: false },
      { id: 'p2', x0: 1064, x1: 1410, y: 569, home: false },
      { id: GROUND_ID, x0: 0, x1: 1440, y: 900, home: false },
    ]);
  });

  it('drops rects narrower than a cat, edges too close to the top to draw it on, and edges below the fold', () => {
    const out = extractPlatforms([
      { id: 'narrow', left: 100, top: 400, right: 250, bottom: 500 },
      { id: 'header', left: 0, top: 0, right: 1440, bottom: 65 },
      { id: 'low', left: 0, top: 120, right: 1440, bottom: 200 },
      { id: 'below', left: 0, top: 950, right: 1440, bottom: 1200 },
      { id: 'ok', left: 0, top: 160, right: 1440, bottom: 400 },
    ], VIEW, { size: SIZE });
    expect(out.map((p) => p.id)).toEqual(['ok', GROUND_ID]);
  });

  it('clips ranges to the viewport (and drops what is left too narrow)', () => {
    const out = extractPlatforms([
      { id: 'wide', left: -500, top: 400, right: 2000, bottom: 500 },
      { id: 'edge', left: 1400, top: 400, right: 1900, bottom: 500 },
    ], VIEW, { size: SIZE });
    expect(out.map((p) => [p.id, p.x0, p.x1])).toEqual([['wide', 0, 1440], [GROUND_ID, 0, 1440]]);
  });

  it('uses the footer top as the ground, dropping edges below it', () => {
    const out = extractPlatforms([
      { id: 'p1', left: 24, top: 311, right: 1042, bottom: 1098 },
      { id: 'low', left: 0, top: 880, right: 1440, bottom: 1000 },
    ], VIEW, { size: SIZE, groundY: 871 });
    expect(out.map((p) => [p.id, p.y])).toEqual([['p1', 311], [GROUND_ID, 871]]);
    expect(extractPlatforms([], VIEW, { size: SIZE, groundY: 2000 })[0].y).toBe(900);
  });

  describe('keep-out zones', () => {
    const SEG = { size: SIZE, pad: 70, minW: 168 };
    it('cuts a zone resting on the floor out of it, padded either side', () => {
      // the Connect-wallet button at 437..629 x 772..828, on the ground at 900
      expect(segmentFloor(0, 1440, 900, [{ left: 437, top: 772, right: 629, bottom: 828 }], SEG))
        .toEqual([{ x0: 0, x1: 367 }, { x0: 699, x1: 1440 }]);
    });
    it('ignores zones above a cat height over the floor, or below it, and merges overlapping cuts', () => {
      expect(segmentFloor(0, 1440, 900, [{ left: 400, top: 600, right: 600, bottom: 759 }], SEG)).toEqual([{ x0: 0, x1: 1440 }]);
      expect(segmentFloor(0, 1440, 311, [{ left: 400, top: 330, right: 600, bottom: 360 }], SEG)).toEqual([{ x0: 0, x1: 1440 }]);
      // behind the footer (the page scrolls on under it): not on the ground
      expect(segmentFloor(0, 1440, 871, [{ left: 1092, top: 881, right: 1382, bottom: 919 }], SEG)).toEqual([{ x0: 0, x1: 1440 }]);
      expect(segmentFloor(0, 1440, 900, [
        { left: 400, top: 800, right: 500, bottom: 850 }, { left: 450, top: 800, right: 700, bottom: 850 },
      ], SEG)).toEqual([{ x0: 0, x1: 330 }, { x0: 770, x1: 1440 }]);
    });
    it('drops pieces narrower than the minimum, and the whole floor when nothing is left', () => {
      expect(segmentFloor(0, 1440, 900, [{ left: 100, top: 800, right: 1300, bottom: 850 }], SEG)).toEqual([]);
      expect(segmentFloor(0, 1440, 900, [{ left: 50, top: 800, right: 200, bottom: 850 }], SEG)).toEqual([{ x0: 270, x1: 1440 }]);
    });
    it('extractPlatforms splits an edge into `id#n` segments carrying the full span, and keeps whole edges as they are', () => {
      // the Connect-wallet button on the ground, and a header link too high above p1 (its bottom clears 311 - 140)
      const keepOut = [{ left: 437, top: 772, right: 629, bottom: 828 }, { left: 1100, top: 100, right: 1200, bottom: 160 }];
      const out = extractPlatforms([
        { id: 'p1', left: 24, top: 311, right: 1042, bottom: 1098 },
        { id: 'home', left: 1065, top: 527, right: 1409, bottom: 546, home: true },
      ], VIEW, { size: SIZE, keepOut, avoidPad: 0.5 });
      expect(out).toEqual([
        { id: 'p1', x0: 24, x1: 1042, y: 311, home: false },
        { id: 'home', x0: 1065, x1: 1409, y: 527, home: true },
        { id: 'ground#0', x0: 0, x1: 367, y: 900, home: false, span: { x0: 0, x1: 1440 } },
        { id: 'ground#1', x0: 699, x1: 1440, y: 900, home: false, span: { x0: 0, x1: 1440 } },
      ]);
      expect(baseId('ground#1')).toBe(GROUND_ID);
      expect(baseId('p1')).toBe('p1');
      const m = platformsToMetres(out, VIEW, 100);
      expect(m[2].span).toEqual({ x0: -7.2, x1: 7.2 });
      expect(m[0].span).toBeUndefined();
    });
    it('never hops between two pieces of one edge (the zone between them is not leapt over)', () => {
      const l: Platform = { id: 'g#0', x0: -2.5, x1: -0.5, y: 0, home: false, span: { x0: -2.5, x1: 2.5 } };
      const r: Platform = { id: 'g#1', x0: 0, x1: 2.5, y: 0, home: false, span: { x0: -2.5, x1: 2.5 } };
      expect(planHop(l, r, -0.6, REACH)).toBeNull();
      expect(planHop(l, { ...r, id: 'other' }, -0.6, REACH)).not.toBeNull();
    });
    it('a fall over a zone lands on the nearest piece of the ground', () => {
      const l: Platform = { id: 'ground#0', x0: -2.5, x1: -0.5, y: 0, home: false };
      const r: Platform = { id: 'ground#1', x0: 0.3, x1: 2.5, y: 0, home: false };
      expect(landingBelow([l, r], -0.2, 1)!.id).toBe('ground#0');
      expect(landingBelow([l, r], 0.1, 1)!.id).toBe('ground#1');
      expect(landingBelow([l, r], 1, 1)!.id).toBe('ground#1');
    });
  });

  it("converts to the cat's metres: x from the centre, y up from the ground", () => {
    const k = 291.67;
    const [p, g] = platformsToMetres(extractPlatforms([{ id: 'p', left: 720, top: 608.33, right: 1440, bottom: 900 }], VIEW, { size: SIZE }), VIEW, k);
    expect(p.x0).toBeCloseTo(0, 5);
    expect(p.x1).toBeCloseTo(2.4685, 3);
    expect(p.y).toBeCloseTo(1, 3);
    expect(g).toMatchObject({ id: GROUND_ID, y: 0 });
    expect(g.x0).toBeCloseTo(-2.4685, 3);
  });
});

const REACH: Reach = { up: 1.4, gap: 0.6, margin: 0.16 };
const G: Platform = { id: 'g', x0: -2.5, x1: 2.5, y: 0, home: false };
const A: Platform = { id: 'a', x0: -2, x1: 0, y: 1, home: false };
const B: Platform = { id: 'b', x0: 0.3, x1: 2, y: 1.2, home: true };
const HIGH: Platform = { id: 'h', x0: -2, x1: 0, y: 2.3, home: false };
const FAR: Platform = { id: 'f', x0: 1, x1: 2, y: 2.3, home: false };

describe('planHop', () => {
  it('jumps straight up onto an overlapping platform within reach, with a small forward hop', () => {
    const hop = planHop(G, A, -1, REACH)!;
    expect(hop).toMatchObject({ from: 'g', to: 'a', fall: false });
    expect(hop.takeoffX).toBe(-1);
    expect(Math.abs(hop.landX - hop.takeoffX)).toBeCloseTo(0.25, 5);
    expect(hop.landX).toBeGreaterThanOrEqual(A.x0 + REACH.margin);
    expect(hop.landX).toBeLessThanOrEqual(A.x1 - REACH.margin);
  });
  it('moves to the overlap first when standing beside it', () => {
    const hop = planHop(G, A, 2, REACH)!;
    expect(hop.takeoffX).toBeCloseTo(A.x1 - REACH.margin, 5);
  });
  it('refuses a rise beyond reach, and too wide a gap', () => {
    expect(planHop(G, HIGH, -1, REACH)).toBeNull();
    expect(planHop(A, FAR, 0, REACH)).toBeNull();
  });
  it('jumps across a small gap between edges', () => {
    const hop = planHop(A, B, -1, REACH)!;
    expect(hop.takeoffX).toBeCloseTo(A.x1 - REACH.margin, 5);
    expect(hop.landX).toBeCloseTo(B.x0 + REACH.margin, 5);
    expect(hop.fall).toBe(false);
  });
  it('marks a deep drop as a fall, a shallow one as a jump down', () => {
    expect(planHop(HIGH, G, -1, REACH)!.fall).toBe(true);
    expect(planHop(A, G, -1, REACH)!.fall).toBe(false);
  });
  it('is never a hop onto itself', () => {
    expect(planHop(A, A, -1, REACH)).toBeNull();
  });
});

describe('planRoute / neighbours / landingBelow', () => {
  const W = [G, A, B, HIGH];
  it('finds a chain of hops when one jump is not enough', () => {
    const route = planRoute(W, 'g', 'h', 2, REACH)!;
    expect(route.map((h) => h.to)).toEqual(['a', 'h']);
    expect(route[0].landX).toBeCloseTo(route[1].takeoffX, 5);
  });
  it('is empty on the spot and null when unreachable', () => {
    expect(planRoute(W, 'a', 'a', 0, REACH)).toEqual([]);
    expect(planRoute([G, FAR], 'g', 'f', 0, REACH)).toBeNull();
    expect(planRoute(W, 'g', 'nope', 0, REACH)).toBeNull();
  });
  it('lists one-hop neighbours', () => {
    expect(neighbours(W, G, -1, REACH).map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(neighbours(W, A, -1, REACH).map((p) => p.id).sort()).toEqual(['b', 'g', 'h']);
  });
  it('lands on the highest surface under the cat, the ground when there is none', () => {
    expect(landingBelow(W, -1, 2.4)!.id).toBe('h');
    expect(landingBelow(W, -1, 2.3)!.id).toBe('h'); // level counts: a vanished floor's twin keeps the feet put
    expect(landingBelow(W, -1, 2.2)!.id).toBe('a');
    expect(landingBelow(W, 1.5, 2.4)!.id).toBe('b');
    expect(landingBelow(W, 2.4, 2.4)!.id).toBe('g');
    expect(landingBelow([A], 5, 2.4)!.id).toBe('a');
  });
  it('walkRange keeps a margin from the ends and never inverts', () => {
    expect(walkRange(A, 0.16)).toEqual({ min: -1.84, max: -0.16 });
    expect(walkRange({ ...A, x0: 0, x1: 0.2 }, 0.16)).toEqual({ min: 0.1, max: 0.1 });
  });
});
