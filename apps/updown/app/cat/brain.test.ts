import { describe, expect, it } from 'vitest';
import { CatBrain, type BrainInput, type BrainOutput, type CatClip, ONE_SHOTS } from './brain';

const durations: Record<CatClip, number> = {
  Idle: 4, Walk: 1.07, Run: 0.67, SitIdle: 3, LoafIdle: 4, Sleep: 4, Purr: 1,
  Wave: 1.5, Sit: 0.8, StandUp: 0.67, LieDown: 1.33, WakeUp: 1.67, Swat: 1.33, Jump: 1.2,
  Stretch: 2, Yawn: 1.5, Groom: 3, TailSwish: 1.33, Pounce: 1.5,
};

function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function make(rng = seeded()) {
  return new CatBrain({
    x: 0, durations, walkSpeed: 0.22, runSpeed: 0.62,
    jump: { takeoff: 0.4, land: 0.93, distance: 0.35 },
    pounce: { takeoff: 0.67, land: 1.0, distance: 0.3 },
    sleepAfter: 45, rng,
  });
}

const base: BrainInput = {
  dt: 1 / 60, hovered: false, clicked: false, pointerX: null, pointerIdle: 0,
  bounds: { min: -2, max: 2 }, reducedMotion: false,
};

function run(b: CatBrain, seconds: number, over: Partial<BrainInput> = {}): BrainOutput {
  let out = b.update({ ...base, ...over });
  for (let t = 0; t < seconds; t += base.dt) out = b.update({ ...base, ...over, clicked: false });
  return out;
}

describe('CatBrain', () => {
  it('waves on first load', () => {
    expect(make().update(base).clip).toBe('Wave');
  });

  it('purrs within one update when hovered while awake', () => {
    const b = make();
    run(b, 3);
    expect(b.update({ ...base, hovered: true }).clip).toBe('Purr');
  });

  it('stops purring when hover ends', () => {
    const b = make();
    run(b, 3, { hovered: true });
    const out = run(b, 0.2);
    expect(out.clip).not.toBe('Purr');
  });

  it('swats on click and keeps the swat when hover continues', () => {
    const b = make();
    run(b, 3);
    const out = b.update({ ...base, hovered: true, clicked: true });
    expect(out.clip).toBe('Swat');
    expect(run(b, 0.5, { hovered: true }).clip).toBe('Swat');
    expect(run(b, 1.2, { hovered: true }).clip).toBe('Purr');
  });

  it('gets annoyed after 3 clicks within 4 s: TailSwish then Run', () => {
    const b = make();
    run(b, 3);
    b.update({ ...base, clicked: true });
    run(b, 0.3);
    b.update({ ...base, clicked: true });
    run(b, 0.3);
    expect(b.update({ ...base, clicked: true }).clip).toBe('TailSwish');
    const seen = new Set<string>();
    for (let t = 0; t < 4; t += base.dt) seen.add(b.update(base).clip);
    expect(seen.has('Run')).toBe(true);
  });

  it('stays asleep when hovered while sleeping, with purr flag', () => {
    const b = make();
    b.command('Sleep');
    let out = run(b, 2);
    expect(out.clip).toBe('Sleep');
    out = run(b, 0.5, { hovered: true });
    expect(out.clip).toBe('Sleep');
    expect(out.sleeping).toBe(true);
    expect(out.purr).toBe(true);
  });

  it('falls asleep after long inactivity', () => {
    const b = make(seeded(7));
    const seen = new Set<string>();
    for (let t = 0; t < 200; t += 0.05) seen.add(b.update({ ...base, dt: 0.05 }).clip);
    expect(seen.has('Sleep')).toBe(true);
  });

  it('never stays in a one-shot longer than its duration (fuzz)', () => {
    const rng = seeded(42);
    const b = make(rng);
    let cur = '';
    let since = 0;
    for (let i = 0; i < 20000; i++) {
      const out = b.update({
        ...base,
        dt: 0.05,
        hovered: rng() < 0.3,
        clicked: rng() < 0.02,
        pointerX: rng() < 0.5 ? rng() * 4 - 2 : null,
        pointerIdle: rng() * 5,
      });
      if (out.clip !== cur) { cur = out.clip; since = 0; }
      since += 0.05;
      if ((ONE_SHOTS as readonly string[]).includes(cur)) expect(since).toBeLessThan(10);
      expect(out.x).toBeGreaterThanOrEqual(-2);
      expect(out.x).toBeLessThanOrEqual(2);
    }
  });

  it('clamps x when bounds shrink (window resize)', () => {
    const b = make();
    b.command('Walk');
    run(b, 1);
    const out = b.update({ ...base, bounds: { min: -0.1, max: 0.1 } });
    expect(Math.abs(out.x)).toBeLessThanOrEqual(0.1);
  });

  it('clamps huge dt (tab was hidden)', () => {
    const b = make();
    run(b, 3);
    const before = b.update(base).x;
    const out = b.update({ ...base, dt: 120 });
    expect(Math.abs(out.x - before)).toBeLessThan(0.3);
  });

  it('never roams with reduced motion', () => {
    const b = make(seeded(3));
    const moving: CatClip[] = ['Walk', 'Run', 'Jump', 'Pounce'];
    for (let t = 0; t < 300; t += 0.05) {
      const out = b.update({ ...base, dt: 0.05, reducedMotion: true, clicked: Math.random() < 0.01 });
      expect(moving).not.toContain(out.clip);
    }
  });

  it('ignores roaming page commands with reduced motion', () => {
    const b = make();
    run(b, 3, { reducedMotion: true });
    b.command('Run');
    expect(b.update({ ...base, reducedMotion: true }).clip).not.toBe('Run');
  });

  it('a Purr command survives while not hovered', () => {
    const b = make();
    run(b, 3);
    b.command('Purr');
    expect(run(b, 1).clip).toBe('Purr');
  });

  it('hover does not cancel a page command', () => {
    const b = make();
    run(b, 3);
    b.command('Groom');
    expect(run(b, 0.5, { hovered: true }).clip).toBe('Groom');
  });

  it('goes straight from Swat to Purr while hovered (no one-frame flicker)', () => {
    const b = make();
    run(b, 3);
    b.update({ ...base, hovered: true, clicked: true });
    const clips: string[] = [];
    for (let t = 0; t < 2; t += base.dt) clips.push(b.update({ ...base, hovered: true }).clip);
    const distinct = clips.filter((c, k) => k === 0 || c !== clips[k - 1]);
    expect(distinct).toEqual(['Swat', 'Purr']);
  });

  it('does not flicker through a placeholder clip when hover ends', () => {
    const b = make();
    run(b, 2, { hovered: true });
    const first = b.update(base);
    const second = b.update(base);
    expect(first.clip).not.toBe('Purr');
    expect(second.seq).toBe(first.seq);
  });

  it('a walk retargets when the viewport shrinks mid-walk', () => {
    const b = make();
    run(b, 3);
    b.command('Walk');
    b.update(base);
    const small = { min: -0.05, max: 0.05 };
    const out = run(b, 1.5, { bounds: small });
    expect(out.clip).not.toBe('Walk');
  });

  it('runs page commands', () => {
    const b = make();
    run(b, 3);
    b.command('Yawn');
    expect(b.update(base).clip).toBe('Yawn');
  });
});

// The world: platforms (metres, y up from the ground). The ledge is one hop from the ground, the high shelf only from
// the ledge; home sits above the ground to the right.
const GROUND = { id: 'ground', x0: -2.5, x1: 2.5, y: 0, home: false };
const HOME = { id: 'home', x0: 1.0, x1: 2.2, y: 1.2, home: true };
const LEDGE = { id: 'p1', x0: -2.4, x1: 0.6, y: 1.0, home: false };
const SHELF = { id: 'p2', x0: -2.4, x1: 0.5, y: 2.2, home: false };
const WORLD = [HOME, LEDGE, SHELF, GROUND];
const world: Partial<BrainInput> = { bounds: { min: -2.5, max: 2.5 }, platforms: WORLD };

function trace(b: CatBrain, seconds: number, over: Partial<BrainInput> = {}) {
  const seen: CatClip[] = [];
  const platforms: string[] = [];
  let out: BrainOutput | null = null;
  for (let t = 0; t < seconds; t += 0.05) {
    out = b.update({ ...base, ...world, ...over, dt: 0.05 });
    if (seen[seen.length - 1] !== out.clip) seen.push(out.clip);
    if (!out.airborne && platforms[platforms.length - 1] !== out.platform) platforms.push(out.platform);
  }
  return { seen, platforms, out: out! };
}

/** feet on the floor of the platform they claim, whenever not mid-leap */
function expectGrounded(out: BrainOutput, platforms = WORLD) {
  if (out.airborne) return;
  const p = platforms.find((q) => q.id === out.platform)!;
  expect(p).toBeDefined();
  expect(Math.abs(out.y - p.y)).toBeLessThan(1e-6);
  expect(out.x).toBeGreaterThanOrEqual(p.x0 - 1e-6);
  expect(out.x).toBeLessThanOrEqual(p.x1 + 1e-6);
}

describe('CatBrain on platforms', () => {
  it('starts on the ground when told nothing, and on the platform it is given', () => {
    expect(make().update({ ...base, ...world })).toMatchObject({ platform: 'ground', y: 0, atHome: false });
    const b = new CatBrain({
      x: 1.6, y: 1.2, platform: 'home', durations, walkSpeed: 0.22, runSpeed: 0.62,
      jump: { takeoff: 0.4, land: 0.93, distance: 0.35 }, pounce: { takeoff: 0.67, land: 1.0, distance: 0.3 },
    });
    expect(b.update({ ...base, ...world })).toMatchObject({ clip: 'Wave', platform: 'home', y: 1.2, atHome: true });
  });

  it('alert: walks to the edge, jumps onto home and purrs / stretches there, never roaming or sleeping', () => {
    const b = make(seeded(5));
    const home = { loop: 'Purr' as CatClip, extras: ['Stretch' as CatClip] };
    const { seen, platforms, out } = trace(b, 120, { home });
    expect(seen.slice(0, 3)).toEqual(['Wave', 'Walk', 'Jump']);
    expect(platforms).toEqual(['ground', 'home']);
    expect(out).toMatchObject({ platform: 'home', atHome: true, y: 1.2 });
    const after = seen.slice(3);
    expect(new Set(after)).toEqual(new Set(['Purr', 'Stretch']));
  });

  it('is airborne only during the leap, and the feet are always on a platform otherwise', () => {
    const b = make(seeded(5));
    let airborne = 0;
    for (let t = 0; t < 20; t += 0.05) {
      const out = b.update({ ...base, ...world, dt: 0.05, home: { loop: 'Purr' } });
      expectGrounded(out);
      if (out.airborne) {
        airborne++;
        expect(out.clip).toBe('Jump');
        expect(out.platform).toBe('home');
      }
    }
    expect(airborne).toBeGreaterThan(5);
    expect(airborne).toBeLessThan(25);
  });

  it('a leap arcs up and lands exactly on the destination floor', () => {
    const b = make();
    let apex = 0;
    let lastY = 0;
    for (let t = 0; t < 15; t += 0.02) {
      const out = b.update({ ...base, ...world, dt: 0.02, home: { loop: 'Purr' } });
      if (out.airborne) apex = Math.max(apex, out.y);
      lastY = out.y;
    }
    expect(apex).toBeGreaterThan(1.2);
    expect(lastY).toBe(1.2);
  });

  it('routes through the ledge to the shelf (beyond a single jump from the ground)', () => {
    const b = make();
    trace(b, 2);
    const w = [{ ...SHELF, home: true }, LEDGE, GROUND];
    const { platforms, out } = trace(b, 60, { platforms: w, home: { loop: 'Purr' } });
    expect(platforms).toEqual(['ground', 'p1', 'p2']);
    expect(out.platform).toBe('p2');
    expect(out.y).toBe(2.2);
  });

  it('falls onto the ground when its platform vanishes (route change), through an airborne Jump', () => {
    const b = make();
    trace(b, 30, { home: { loop: 'Purr' } });
    expect(b.update({ ...base, ...world }).platform).toBe('home');
    const { platforms, out, seen } = trace(b, 4, { platforms: [LEDGE, GROUND], home: { loop: 'Purr' } });
    expect(seen[0]).toBe('Jump');
    expect(platforms.slice(-1)).toEqual(['ground']);
    expect(out.y).toBe(0);
    expect(out.airborne).toBe(false);
  });

  it('follows its platform up and down the screen (scroll) and never floats', () => {
    const b = make();
    trace(b, 30, { home: { loop: 'Purr' } });
    const moved = [{ ...HOME, y: 0.6 }, LEDGE, SHELF, GROUND];
    const out = b.update({ ...base, ...world, platforms: moved });
    expect(out.y).toBe(0.6);
    expectGrounded(out, moved);
  });

  it('a wandering cat visits at least two platforms, comes home, and is home a fair share of the time', () => {
    const b = make(seeded(11));
    const visited = new Set<string>();
    let home = 0; let n = 0; let returns = 0; let last = '';
    for (let t = 0; t < 900; t += 0.05) {
      const out = b.update({ ...base, ...world, dt: 0.05 });
      expectGrounded(out);
      n++;
      if (out.airborne) continue;
      visited.add(out.platform);
      if (out.atHome) home++;
      if (out.platform === 'home' && last !== 'home' && last) returns++;
      last = out.platform;
    }
    expect(visited.size).toBeGreaterThanOrEqual(3);
    expect(returns).toBeGreaterThanOrEqual(1);
    expect(home / n).toBeGreaterThan(0.2);
    expect(home / n).toBeLessThan(0.7);
  });

  it('celebrate: visitHome(Jump, Pounce) travels home, plays the clips there, then roams', () => {
    const b = make(seeded(2));
    trace(b, 3);
    b.visitHome('Jump', 'Pounce');
    const flags = new Map<CatClip, boolean>();
    const seen: CatClip[] = [];
    for (let t = 0; t < 8; t += 0.05) {
      const out = b.update({ ...base, ...world, dt: 0.05 });
      if (seen[seen.length - 1] !== out.clip) seen.push(out.clip);
      flags.set(out.clip, out.atHome);
    }
    expect(seen.slice(0, 3)).toEqual(['Walk', 'Jump', 'Pounce']); // the hop onto home and the Jump command run together
    expect(flags.get('Walk')).toBe(false);
    expect(flags.get('Pounce')).toBe(true);
  });

  it('asleep (no wallet): roams freely and dozes off after ~30 s without attention', () => {
    const b = make(seeded(4));
    const first = trace(b, 25, { sleepAfter: 30 });
    expect(first.seen).not.toContain('Sleep');
    const { seen } = trace(b, 120, { sleepAfter: 30 });
    expect(seen).toContain('Sleep');
    expect(trace(make(seeded(4)), 145, { sleepAfter: 1000 }).seen).not.toContain('Sleep');
  });

  it('here: holds the clip wherever it is, and keeps the platform', () => {
    const b = make();
    const { seen, out } = trace(b, 20, { home: { loop: 'LoafIdle', here: true } });
    expect(seen).toEqual(['Wave', 'LoafIdle']);
    expect(out.platform).toBe('ground');
  });

  it('holds the clip in place when there is no home on the page', () => {
    const b = make();
    const { seen } = trace(b, 10, { platforms: [LEDGE, GROUND], home: { loop: 'Purr' } });
    expect(seen).toEqual(['Wave', 'Purr']);
  });

  it('wakes up before leaving sleep when the mood changes (settle)', () => {
    const b = make();
    trace(b, 10, { home: { loop: 'Sleep', here: true } });
    b.settle();
    expect(trace(b, 6, { home: { loop: 'LoafIdle', here: true } }).seen.slice(0, 2)).toEqual(['WakeUp', 'LoafIdle']);
  });

  it('hover purr and a swat on home stay on home; then it goes back to the mood clip', () => {
    const b = make();
    trace(b, 30, { home: { loop: 'LoafIdle' } });
    let out = b.update({ ...base, ...world, home: { loop: 'LoafIdle' }, hovered: true });
    expect(out).toMatchObject({ clip: 'Purr', atHome: true });
    out = b.update({ ...base, ...world, home: { loop: 'LoafIdle' }, hovered: true, clicked: true });
    expect(out).toMatchObject({ clip: 'Swat', atHome: true });
    expect(trace(b, 4, { home: { loop: 'LoafIdle' } }).seen.slice(-1)).toEqual(['LoafIdle']);
  });

  it('annoyed: runs away along the platform it is on, never off it', () => {
    const b = make();
    trace(b, 30, { home: { loop: 'Purr' } });
    for (let k = 0; k < 3; k++) {
      b.update({ ...base, ...world, clicked: true });
      trace(b, 0.2);
    }
    const { seen, out } = trace(b, 3);
    expect(seen).toContain('Run');
    expect(out.platform).toBe('home');
    expect(out.x).toBeGreaterThanOrEqual(HOME.x0);
    expect(out.x).toBeLessThanOrEqual(HOME.x1);
  });

  it('pounces at a resting cursor only on its own platform', () => {
    const on = make(seeded(8));
    trace(on, 30, { home: { loop: 'Purr' } });
    on.settle();
    // alone on its home platform (nothing to travel to): a cursor resting just ahead of it on the platform gets
    // pounced at, one resting beside the platform never
    const seen = new Set<CatClip>();
    let x = on.update({ ...base, ...world, platforms: [HOME] }).x;
    for (let t = 0; t < 120; t += 0.05) {
      const out = on.update({ ...base, ...world, platforms: [HOME], dt: 0.05, pointerX: Math.min(x + 0.3, HOME.x1 - 0.2), pointerIdle: 5, sleepAfter: 1000 });
      seen.add(out.clip);
      x = out.x;
      expect(out.platform).toBe('home');
    }
    expect(seen).toContain('Pounce');
    const off = make(seeded(8));
    trace(off, 30, { home: { loop: 'Purr' } });
    off.settle();
    const away = trace(off, 200, { platforms: [HOME], pointerX: HOME.x0 - 0.3, pointerIdle: 5 });
    expect(away.seen).not.toContain('Pounce');
    expect(away.out.platform).toBe('home');
  });

  it('with reduced motion the home is never travelled to: the clip plays where the cat is, grounded', () => {
    const b = make(seeded(3));
    const { seen, out } = trace(b, 30, { home: { loop: 'Purr' }, reducedMotion: true });
    expect(seen).not.toContain('Walk');
    expect(seen).not.toContain('Jump');
    expect(seen).toContain('Purr');
    expect(out).toMatchObject({ x: 0, platform: 'ground', y: 0 });
  });

  it('visitHome() plays the clips in place with reduced motion', () => {
    const b = make();
    trace(b, 3, { reducedMotion: true });
    b.visitHome('Jump', 'Pounce', 'Groom');
    const { seen, out } = trace(b, 4, { reducedMotion: true });
    expect(seen[0]).toBe('Groom');
    expect(seen).not.toContain('Walk');
    expect(out.x).toBe(0);
  });

  it('settle() interrupts the idle activity but not a page command', () => {
    const b = make();
    trace(b, 3, { home: { loop: 'SitIdle', here: true } });
    b.command('Groom');
    expect(b.update({ ...base, ...world, home: { loop: 'SitIdle', here: true } }).clip).toBe('Groom');
    b.settle();
    expect(b.update({ ...base, ...world, home: { loop: 'SitIdle', here: true } }).clip).toBe('Groom');
  });

  describe('keep-out zones', () => {
    // the ground cut round a button under x in [-0.6, 0.4]
    const SPAN = { x0: -2.5, x1: 2.5 };
    const G_L = { id: 'ground#0', x0: -2.5, x1: -0.6, y: 0, home: false, span: SPAN };
    const G_R = { id: 'ground#1', x0: 0.4, x1: 2.5, y: 0, home: false, span: SPAN };
    const CUT = [HOME, LEDGE, SHELF, G_L, G_R];
    const inSegment = (out: BrainOutput, platforms = CUT) => {
      const p = platforms.find((q) => q.id === out.platform)!;
      return p && out.x >= p.x0 - 1e-6 && out.x <= p.x1 + 1e-6;
    };

    it('a zone appearing under the cat makes it walk to the nearest piece left, then it settles there', () => {
      const b = make();
      const first = b.update({ ...base, ...world, home: { loop: 'LoafIdle', here: true } });
      expect(first).toMatchObject({ platform: 'ground', x: 0 });
      const { seen, out } = trace(b, 6, { platforms: CUT, home: { loop: 'LoafIdle', here: true } });
      expect(seen[0]).toBe('Walk');
      expect(seen).not.toContain('Jump'); // walked, no teleport and no fall
      expect(out.platform).toBe('ground#1'); // 0.4 is nearer than -0.6
      expect(inSegment(out)).toBe(true);
      expect(out.y).toBe(0);
      expect(seen.slice(-1)).toEqual(['LoafIdle']);
    });

    it('never swats, purrs or takes commands while walking off a zone, and the walk ends in the segment', () => {
      const b = make();
      b.update({ ...base, ...world });
      b.command('Groom');
      const clips = new Set<CatClip>();
      let out = b.update({ ...base, ...world, platforms: CUT });
      for (let t = 0; t < 2; t += 0.05) {
        out = b.update({ ...base, ...world, platforms: CUT, dt: 0.05, hovered: true, clicked: t < 0.3 });
        clips.add(out.clip);
        if (out.clip === 'Walk') expect(['ground', 'ground#1']).toContain(out.platform);
      }
      expect(clips.has('Swat')).toBe(false);
      expect(clips.has('Purr')).toBe(false);
      expect(inSegment(out)).toBe(true);
      // the command ran once he was off the zone
      const after = trace(b, 4, { platforms: CUT });
      expect([...clips, ...after.seen]).toContain('Groom');
    });

    it('a sleeping cat wakes up first; with reduced motion it is set straight onto the segment', () => {
      const b = make();
      trace(b, 5, { home: { loop: 'Sleep', here: true } });
      const { seen, out } = trace(b, 8, { platforms: CUT, home: { loop: 'Sleep', here: true } });
      expect(seen.slice(0, 2)).toEqual(['WakeUp', 'Walk']);
      expect(inSegment(out)).toBe(true);
      const r = make();
      r.update({ ...base, ...world, reducedMotion: true });
      const snap = r.update({ ...base, ...world, platforms: CUT, reducedMotion: true });
      expect(snap.platform).toBe('ground#1');
      expect(inSegment(snap)).toBe(true);
    });

    it('a cut that heals hands the cat back to the whole edge where it stands', () => {
      const b = make();
      b.update({ ...base, ...world });
      trace(b, 6, { platforms: CUT, home: { loop: 'LoafIdle', here: true } });
      const out = b.update({ ...base, ...world, home: { loop: 'LoafIdle', here: true } });
      expect(out.platform).toBe('ground');
      expect(out.clip).toBe('LoafIdle');
    });

    it('roams the cut world without ever standing on the zone, and routes round it (never leaps it)', () => {
      const b = make(seeded(11));
      let onR = 0; let onL = 0;
      for (let t = 0; t < 600; t += 0.05) {
        const out = b.update({ ...base, ...world, platforms: CUT, dt: 0.05 });
        // walking off the zone (the start, x = 0) is the one time the feet may be outside the segment: on its span
        const walkingOff = (out.clip === 'Walk' || out.clip === 'Run') && out.platform.startsWith('ground#') && out.y === 0
          && out.x >= SPAN.x0 && out.x <= SPAN.x1;
        if (!walkingOff) expectGrounded(out, CUT);
        if (out.airborne) continue;
        if (out.platform === 'ground#0') onL++;
        if (out.platform === 'ground#1') onR++;
      }
      expect(onR).toBeGreaterThan(0);
      expect(onL).toBeGreaterThan(0);
    });
  });

  describe('picked up and dropped', () => {
    const SPAN = { x0: -2.5, x1: 2.5 };
    const G_L = { id: 'ground#0', x0: -2.5, x1: -0.6, y: 0, home: false, span: SPAN };
    const G_R = { id: 'ground#1', x0: 0.4, x1: 2.5, y: 0, home: false, span: SPAN };
    const CUT = [HOME, LEDGE, SHELF, G_L, G_R];

    it('held: dangles where the pointer puts it, ignores hover, clicks and commands, and is not asleep', () => {
      const b = make();
      trace(b, 2);
      b.pickUp();
      b.hold(1.5, 1.8);
      b.command('Groom');
      const out = b.update({ ...base, ...world, hovered: true, clicked: true });
      expect(out).toMatchObject({ held: true, airborne: true, clip: 'Idle', x: 1.5, y: 1.8, sleeping: false, moving: false });
      expect(b.update({ ...base, ...world, clicked: true }).clip).toBe('Idle');
    });

    it('dropped above the ledge: falls onto it with a Jump, lands exactly, then roams on from there', () => {
      const b = make();
      trace(b, 2);
      b.pickUp();
      b.hold(-1, 1.6);
      b.update({ ...base, ...world });
      b.drop();
      let out = b.update({ ...base, ...world, dt: 0.05 });
      expect(out).toMatchObject({ clip: 'Jump', airborne: true, held: false, platform: 'p1' });
      let frames = 0;
      while (out.airborne && frames++ < 100) out = b.update({ ...base, ...world, dt: 0.05 });
      expect(out).toMatchObject({ platform: 'p1', y: 1, airborne: false });
      expect(out.x).toBeCloseTo(-1, 5);
      expect(trace(b, 20).platforms.length).toBeGreaterThanOrEqual(1); // roams on
    });

    it('dropped with the feet just under a ledge (the body over it) is set onto the ledge instead of falling past', () => {
      const b = make();
      trace(b, 2);
      b.pickUp();
      b.hold(-1, 2.0); // the shelf is at 2.2
      b.update({ ...base, ...world });
      b.drop();
      const out = b.update({ ...base, ...world, dt: 0.05 });
      expect(out).toMatchObject({ platform: 'p2', y: 2.2, airborne: false, held: false });
      expect(out.clip).not.toBe('Jump');
    });

    it('dropped over a keep-out zone: drifts to the nearest allowed spot while falling', () => {
      const b = make();
      trace(b, 2);
      b.pickUp();
      b.hold(0.3, 1.5);
      const open = [HOME, G_L, G_R]; // nothing but the cut ground under x = 0.3
      b.update({ ...base, ...world, platforms: open });
      b.drop();
      let out: BrainOutput | null = null;
      for (let t = 0; t < 3; t += 0.05) {
        out = b.update({ ...base, ...world, platforms: open, dt: 0.05 });
        if (!out.airborne) expectGrounded(out, open);
      }
      expect(out!.platform).toBe('ground#1');
      expect(out!.x).toBeGreaterThanOrEqual(G_R.x0);
      expect(out!.y).toBe(0);
    });

    it('dropped level with the floor but over a zone: walks off it; level on the floor: just stands', () => {
      const b = make();
      trace(b, 2);
      b.pickUp();
      b.hold(0, 0);
      b.update({ ...base, ...world, platforms: CUT });
      b.drop();
      const { seen, out } = trace(b, 4, { platforms: CUT });
      expect(seen[0]).toBe('Walk');
      expect(seen).not.toContain('Jump');
      expect(out.platform).toBe('ground#1');
      const c = make();
      trace(c, 2);
      c.pickUp();
      c.hold(1, 0);
      c.update({ ...base, ...world });
      c.drop();
      expect(c.update({ ...base, ...world })).toMatchObject({ clip: 'Idle', x: 1, y: 0, platform: 'ground', airborne: false });
    });

    it('picking up mid-leap or mid-sleep is fine; dropping outside everything lands on the nearest ground piece', () => {
      const b = make();
      trace(b, 5, { home: { loop: 'Sleep', here: true } });
      b.pickUp();
      expect(b.update({ ...base, ...world }).sleeping).toBe(false);
      b.hold(-0.1, 3);
      b.update({ ...base, ...world, platforms: [G_L, G_R] });
      b.drop();
      const { out } = trace(b, 4, { platforms: [G_L, G_R] });
      expect(out.platform).toBe('ground#0');
      expect(out.x).toBeLessThanOrEqual(G_L.x1);
      expect(out.y).toBe(0);
    });
  });

  it('fuzz: never floats, never leaves its platform, one-shots end (platforms coming and going)', () => {
    const rng = seeded(77);
    const b = make(rng);
    let cur = ''; let since = 0;
    for (let i = 0; i < 20000; i++) {
      const platforms = rng() < 0.002 ? [LEDGE, GROUND] : rng() < 0.002 ? [HOME, GROUND] : WORLD;
      const out = b.update({
        ...base, ...world, platforms, dt: 0.05,
        hovered: rng() < 0.2, clicked: rng() < 0.01,
        pointerX: rng() < 0.5 ? rng() * 4 - 2 : null, pointerIdle: rng() * 5,
        home: rng() < 0.001 ? { loop: 'Purr' } : null,
      });
      expectGrounded(out, platforms);
      if (out.clip !== cur) { cur = out.clip; since = 0; }
      since += 0.05;
      if ((ONE_SHOTS as readonly string[]).includes(cur)) expect(since).toBeLessThan(10);
    }
  });
});

