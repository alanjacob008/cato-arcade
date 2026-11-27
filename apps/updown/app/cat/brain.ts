// Cato's behaviour state machine. Pure logic (no three.js): distances in metres, time in seconds.
// The cat lives on platforms (platforms.ts): the ground plus the top edges of the page's panels, one of them its home.
// It walks along the one it is on, jumps up/down to neighbours within reach, falls off bigger drops, and never floats:
// its feet are on a platform whenever it is not mid-leap, and a platform that vanishes under it drops it onto the
// nearest surface below. Keep-out zones (the page's buttons) are cut out of the platforms (platforms.ts): when one
// appears under the cat, it walks to the nearest piece of its floor that is left (hover, clicks and commands wait).
import {
  GROUND_ID, baseId, landingBelow, nearestAlong, neighbours, planHop, planRoute, walkRange,
  type Hop, type Platform, type Reach,
} from './platforms';

export type { Platform } from './platforms';

export const CLIPS = [
  'Idle', 'Walk', 'Run', 'SitIdle', 'LoafIdle', 'Sleep', 'Purr',
  'Wave', 'Sit', 'StandUp', 'LieDown', 'WakeUp', 'Swat', 'Jump', 'Stretch', 'Yawn', 'Groom', 'TailSwish', 'Pounce',
] as const;
export type CatClip = (typeof CLIPS)[number];

export const LOOPS = ['Idle', 'Walk', 'Run', 'SitIdle', 'LoafIdle', 'Sleep', 'Purr'] as const;
export const ONE_SHOTS = CLIPS.filter((c) => !(LOOPS as readonly string[]).includes(c));

export interface Leap { takeoff: number; land: number; distance: number }

export interface BrainOptions {
  x: number;
  durations: Record<CatClip, number>;
  walkSpeed: number;
  runSpeed: number;
  jump: Leap;
  pounce: Leap;
  /** seconds without interaction before the cat may go to sleep (the mood may override it per update) */
  sleepAfter?: number;
  rng?: () => number;
  /** the platform the cat starts on (default: the ground) and its height */
  platform?: string;
  y?: number;
  /** how high a jump reaches (m; bigger drops are falls), the widest gap it clears, and the margin kept from edges */
  reach?: Partial<Reach>;
  /** fall acceleration (m/s²): a cartoon value, softer than the real thing */
  gravity?: number;
  /** idle pauses between roaming decisions, seconds [min, max] */
  roamEvery?: [number, number];
}

/**
 * The mood: what the page wants the cat to do, given on every update. It replaces the autonomous roaming: the cat
 * travels home (the platform flagged `home`; with `here` it stays where it is, as it does when the page has no home)
 * and holds `loop` there, re-asking every few seconds. Lying down / waking up transitions are inserted around Sleep.
 * Hover, clicks and page commands still interrupt; afterwards the cat goes back to the mood.
 */
export interface HomeSpot {
  /** the clip held (a loop is re-asked; a one-shot plays once per ask) */
  loop: CatClip;
  /** one-shots sprinkled in now and then instead of the loop */
  extras?: CatClip[];
  /** hold the clip wherever the cat is instead of going home */
  here?: boolean;
}

export interface BrainInput {
  dt: number;
  hovered: boolean;
  clicked: boolean;
  /** pointer x in world metres, null when unknown/outside (the renderer only passes it when it is near the cat's floor) */
  pointerX: number | null;
  /** seconds since the pointer last moved */
  pointerIdle: number;
  /** the ground's x range (the viewport) */
  bounds: { min: number; max: number };
  reducedMotion: boolean;
  /** the mood, or null/undefined to roam freely */
  home?: HomeSpot | null;
  /** idle seconds before sleeping, overriding the option for this update */
  sleepAfter?: number;
  /** the page's platforms (metres), ground included. Omitted: the ground alone, spanning `bounds` */
  platforms?: Platform[];
}

export interface BrainOutput {
  clip: CatClip;
  loop: boolean;
  /** increments whenever a clip (re)starts, so the renderer can restart repeated one-shots */
  seq: number;
  x: number;
  /** feet height above the ground (m) */
  y: number;
  facing: 1 | -1;
  moving: boolean;
  sleeping: boolean;
  purr: boolean;
  /** whether the head may follow the cursor */
  track: boolean;
  /** the cat is on (or leaping onto) its home platform */
  atHome: boolean;
  /** the platform the cat stands on (or is leaping towards) */
  platform: string;
  /** mid-leap / falling: the feet are off the floor */
  airborne: boolean;
  /** picked up: dangling from the pointer */
  held: boolean;
}

type Move = 'walk' | 'run' | 'leap' | 'fall';

interface Step {
  clip: CatClip;
  /** loops: how long to stay; one-shots: their clip duration */
  dur: number;
  user?: boolean;
  /** the hover purr: ends as soon as the pointer leaves */
  hover?: boolean;
  move?: Move;
  targetX?: number;
  /** leap / fall: where to land */
  to?: { pid: string; x: number };
  /** a fall with no take-off (the floor vanished) */
  instant?: boolean;
  /** resolved when the step starts (it may follow a trip): a walk to a random spot, or a hop along the platform */
  random?: boolean;
  inPlace?: { dir?: 1 | -1 };
  /** the walk off a keep-out zone that appeared under the cat: nothing interrupts it */
  evac?: boolean;
}

const MAX_DT = 0.25;
const CLICK_WINDOW = 4;
const LOOP_CLIPS = new Set<string>(LOOPS);
const ROAMING = new Set<CatClip>(['Walk', 'Run', 'Jump', 'Pounce']);
const NO_TRACK = new Set<CatClip>(['Sleep', 'LieDown', 'Groom', 'Yawn', 'Stretch', 'WakeUp']);
/** metres: closer than this to a target counts as being there */
export const ARRIVE = 0.1;
/** metres: run instead of walk to a target further away than this */
const TROT_RUN_AFTER = 2.5;
/** chance that a re-ask of the mood plays one of its extras instead of the loop */
const EXTRA_CHANCE = 0.3;
/** how far a leap's apex clears the higher of its two floors (m) */
const ARC = 0.2;
/** dropped with the feet this far (m) below a ledge's top, the cat is set onto the ledge rather than falling past it */
const DROP_SNAP = 0.3;
/** default reach: ~3 cat heights up, a cat-length gap, a whisker from the edges */
export const DEFAULT_REACH: Reach = { up: 1.4, gap: 0.6, margin: 0.16 };
// --- roaming tuning: together these put the cat home about 40% of the time on a page with a few platforms
/** destination weights when roaming: home, a neighbour (one hop away), anything else reachable */
const DEST_WEIGHT = { home: 3, neighbour: 1.5, far: 0.7 };
/** weight of "go somewhere else" among the idle options, at home and away (the others sum to ~9) */
const WANDER_WEIGHT = { home: 3.0, away: 3.0 };
/** chance that bedtime away from home means going home to sleep first */
const BEDTIME_HOME = 0.3;

export class CatBrain {
  private o: Required<Omit<BrainOptions, 'reach'>> & { reach: Reach };
  private x: number;
  private y: number;
  private pid: string;
  private facing: 1 | -1 = 1;
  private queue: Step[] = [];
  private cur: Step;
  private t = 0;
  private seq = 0;
  private clicks: number[] = [];
  private clock = 0;
  private lastInteraction = 0;
  private commands: CatClip[] = [];
  private homeVisits: CatClip[][] = [];
  private resettle = false;
  private bounds = { min: -1, max: 1 };
  private reduced = false;
  private last: BrainInput | null = null;
  private platforms: Platform[] = [];
  /** leap / fall bookkeeping */
  private from = { x: 0, y: 0 };
  private vy = 0;
  private landed = false;
  /** walking off a keep-out zone: x may sit outside the platform's range until the walk ends */
  private evac = false;
  /** picked up: where the pointer holds the cat (metres), the brain idles until it is dropped */
  private held: { x: number; y: number } | null = null;

  constructor(opts: BrainOptions) {
    this.o = {
      sleepAfter: 45, rng: Math.random, platform: GROUND_ID, y: 0, gravity: 7, roamEvery: [4, 9], ...opts,
      reach: { ...DEFAULT_REACH, ...opts.reach },
    };
    this.x = opts.x;
    this.y = this.o.y;
    this.pid = this.o.platform;
    this.cur = this.oneShot('Wave');
    this.seq = 1;
  }

  /** Ask the cat to do something (from the page). Several clips play in order. Takes effect on the next update. */
  command(...clips: CatClip[]): void {
    this.commands.push(...clips);
  }

  /**
   * Go home (walk, jump, run when far), then play the clips there, in order. A page command: it interrupts the
   * autonomous activity and is not interrupted by hover. With reduced motion (or no home) the clips play in place.
   */
  visitHome(...clips: CatClip[]): void {
    this.homeVisits.push(clips);
  }

  /**
   * Drop whatever autonomous activity is in progress and re-choose (used when the mood changes).
   * Page commands and the hover purr are left alone. Takes effect on the next update.
   */
  settle(): void {
    this.resettle = true;
  }

  /**
   * Pick the cat up (a drag): whatever it was doing stops, it dangles at `hold()`'s position and nothing else
   * happens until `drop()`. Takes effect at once.
   */
  pickUp(): void {
    if (this.held) return;
    this.held = { x: this.x, y: Math.max(0, this.y) };
    this.queue = [];
    this.evac = false;
    this.cur = { clip: 'Idle', dur: Infinity, user: true };
    this.t = 0;
    this.seq++;
    this.landed = false;
    this.lastInteraction = this.clock;
  }

  /** Move the held cat (metres: x from the centre, y up from the ground). */
  hold(x: number, y: number): void {
    if (this.held) this.held = { x, y: Math.max(0, y) };
  }

  /**
   * Let go: the cat falls onto the highest platform under it (else the nearest piece of the ground). Dropped over a
   * keep-out zone it drifts to the nearest allowed spot while falling; dropped level with its floor it just walks off
   * the zone. Then it roams on from there.
   */
  drop(): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    this.x = held.x;
    this.y = held.y;
    this.lastInteraction = this.clock;
    // the platform under x nearest the feet, a ledge a little above them included (the body was over it): the
    // highest one below otherwise, which is never a keep-out zone
    let onto: Platform | null = null;
    for (const p of this.platforms) {
      if (this.x < p.x0 || this.x > p.x1 || p.y > this.y + DROP_SNAP) continue;
      if (!onto || Math.abs(p.y - this.y) < Math.abs(onto.y - this.y)) onto = p;
    }
    onto ??= landingBelow(this.platforms, this.x, this.y);
    if (onto && onto.y > this.y) this.y = onto.y;
    if (!onto) {
      this.start([this.loop('Idle', 0.5, 1)], true);
      return;
    }
    const r = walkRange(onto, this.o.reach.margin);
    const landX = clamp(this.x, r.min, r.max);
    if (Math.abs(onto.y - this.y) < 1e-3 || this.reduced) {
      this.pid = onto.id;
      this.y = onto.y;
      if (Math.abs(landX - this.x) > 1e-3 && !this.reduced) this.evacuate(landX);
      else {
        this.x = landX;
        this.start([this.loop('Idle', 0.5, 1)], true);
      }
      return;
    }
    this.pid = onto.id;
    this.start([
      { ...this.oneShot('Jump'), move: 'fall', instant: true, to: { pid: onto.id, x: landX } },
      this.loop('Idle', 0.6, 1.2),
    ], true);
  }

  update(i: BrainInput): BrainOutput {
    const dt = Math.min(Math.max(i.dt, 0), MAX_DT);
    this.clock += dt;
    this.bounds = i.bounds;
    this.reduced = i.reducedMotion;
    this.last = i;
    this.platforms = i.platforms?.length ? i.platforms : [{ id: GROUND_ID, x0: i.bounds.min, x1: i.bounds.max, y: 0, home: false }];
    if (this.held) {
      // dangling from the pointer: nothing else happens
      this.x = clamp(this.held.x, i.bounds.min, i.bounds.max);
      this.y = this.held.y;
      this.lastInteraction = this.clock;
      return {
        clip: 'Idle', loop: true, seq: this.seq, x: this.x, y: this.y, facing: this.facing, moving: false,
        sleeping: false, purr: false, track: true, atHome: false, platform: this.pid, airborne: true, held: true,
      };
    }
    const asleep = this.isAsleep();

    // --- the floor under the feet: follow the platform (it scrolls); fall when it is gone; walk off a keep-out zone
    if (!this.airborne()) {
      const p = this.platform(this.pid) ?? this.relocate();
      if (p) {
        this.y = p.y;
        if (!this.evac) {
          const r = this.range(p);
          this.x = clamp(this.x, r.min, r.max);
        }
      } else {
        this.dropOnto(landingBelow(this.platforms, this.x, this.y));
      }
    }

    // --- page commands (all pending visits and commands form one sequence)
    if (this.evac) {
      // getting off a keep-out zone: commands wait, clicks and hover are ignored (no swatting / purring on a button)
    } else if (this.commands.length || this.homeVisits.length) {
      const steps = this.homeVisits.splice(0)
        .flatMap((clips) => this.travelHome(i.reducedMotion).concat(clips.flatMap((c) => this.filterReduced(this.plan(c), i.reducedMotion))))
        .concat(this.commands.splice(0).flatMap((c) => this.filterReduced(this.plan(c), i.reducedMotion)))
        .map((st) => ({ ...st, user: true }));
      if (steps.length) this.start(steps, true);
    }
    if (this.resettle && !this.evac) {
      this.resettle = false;
      if (!this.cur.user && !this.airborne()) this.start([], true);
    }

    // --- clicks
    if (i.clicked && !this.evac) {
      this.lastInteraction = this.clock;
      this.clicks = this.clicks.filter((c) => this.clock - c < CLICK_WINDOW);
      this.clicks.push(this.clock);
      if (this.airborne()) {
        // can't swat mid-air; the click still counts towards being annoyed
      } else if (this.clicks.length >= 3 && this.cur.clip !== 'TailSwish' && this.cur.clip !== 'Run') {
        this.clicks = [];
        this.start(this.annoyed(), true);
      } else if (this.cur.clip !== 'Swat' && this.cur.clip !== 'TailSwish' && this.cur.clip !== 'Run') {
        this.start(asleep ? [this.oneShot('WakeUp', true), this.oneShot('Swat', true)] : [this.oneShot('Swat', true)], true);
      }
    }

    // --- hover
    if (i.hovered) this.lastInteraction = this.clock;
    const busyWithUser = this.cur.user && !this.cur.hover;
    if (i.hovered && !busyWithUser && !this.isAsleep() && !this.cur.hover && !this.airborne() && !this.evac) {
      this.start([this.hoverPurr()], true);
    } else if (!i.hovered && this.cur.hover) {
      this.start([], true);
    }

    // --- advance current step (targets follow the platform if it shrank)
    if ((this.cur.move === 'walk' || this.cur.move === 'run') && this.cur.targetX !== undefined) {
      const r = this.range();
      this.cur.targetX = clamp(this.cur.targetX, r.min, r.max);
    }
    this.t += dt;
    this.applyMotion(dt);
    if (this.stepDone()) this.advance();

    const sleeping = this.isAsleep();
    const toPid = this.airborne() && this.cur.to ? this.cur.to.pid : this.pid;
    return {
      clip: this.cur.clip,
      loop: LOOP_CLIPS.has(this.cur.clip),
      seq: this.seq,
      x: this.x,
      y: this.y,
      facing: this.facing,
      moving: !!this.cur.move,
      sleeping,
      purr: this.cur.clip === 'Purr' || (sleeping && i.hovered),
      track: !NO_TRACK.has(this.cur.clip),
      atHome: !!this.platform(toPid)?.home,
      platform: toPid,
      airborne: this.airborne(),
      held: false,
    };
  }

  // ------------------------------------------------------------------ internals
  private airborne() {
    const m = this.cur.move;
    return (m === 'leap' || m === 'fall') && !this.landed;
  }

  private platform(id: string): Platform | undefined {
    return this.platforms.find((p) => p.id === id);
  }

  private homePlatform(): Platform | undefined {
    return this.platforms.find((p) => p.home);
  }

  /** walkable x range of a platform (default: the one the cat is on), within the ground's bounds */
  private range(p = this.platform(this.pid)): { min: number; max: number } {
    const r = p ? walkRange(p, this.o.reach.margin) : { min: this.bounds.min, max: this.bounds.max };
    const min = Math.max(r.min, this.bounds.min);
    const max = Math.min(r.max, this.bounds.max);
    return max >= min ? { min, max } : { min: clamp(this.x, this.bounds.min, this.bounds.max), max: clamp(this.x, this.bounds.min, this.bounds.max) };
  }

  /**
   * The platform's id is gone: find the piece of the same edge the cat is on (it was cut round keep-out zones, or the
   * cut healed). Over a cut-out part, the floor is still there but off-limits: walk to the nearest piece (snap with
   * reduced motion). Beyond the edge's extent (it shrank) the cat is set back onto the nearest piece, as a resize
   * always did. Undefined when no piece of the edge remains (the floor really vanished: fall).
   */
  private relocate(): Platform | undefined {
    const base = baseId(this.pid);
    const pieces = this.platforms.filter((p) => baseId(p.id) === base);
    if (!pieces.length) return undefined;
    const under = pieces.find((p) => this.x >= p.x0 && this.x <= p.x1);
    if (under) {
      this.pid = under.id;
      return under;
    }
    const nearest = nearestAlong(pieces, this.x)!;
    this.pid = nearest.id;
    this.y = nearest.y;
    const overFloor = !!nearest.span && this.x >= nearest.span.x0 && this.x <= nearest.span.x1;
    const r = walkRange(nearest, this.o.reach.margin);
    if (!overFloor || this.reduced) {
      this.x = clamp(this.x, r.min, r.max);
      return nearest;
    }
    this.evacuate(clamp(this.x, r.min, r.max));
    return nearest;
  }

  /** Walk (stand up / wake up first) to `toX` on the current platform, off a keep-out zone; nothing interrupts it. */
  private evacuate(toX: number) {
    const steps: Step[] = [];
    if (this.isAsleep()) steps.push(this.oneShot('WakeUp'));
    else if (this.cur.clip === 'Sit' || this.cur.clip === 'SitIdle') steps.push(this.oneShot('StandUp'));
    const run = Math.abs(toX - this.x) > TROT_RUN_AFTER;
    steps.push({ clip: run ? 'Run' : 'Walk', dur: 0, move: run ? 'run' : 'walk', targetX: toX, evac: true });
    this.start(steps.map((s) => ({ ...s, user: true, evac: true })), true);
    this.evac = true;
  }

  /** The floor vanished: drop onto `onto` (snap when it is level, instantly with reduced motion). */
  private dropOnto(onto: Platform | null) {
    if (!onto) return;
    if (Math.abs(onto.y - this.y) < 1e-3 || this.reduced) {
      this.pid = onto.id;
      this.y = onto.y;
      return;
    }
    const r = walkRange(onto, this.o.reach.margin);
    this.start([{ ...this.oneShot('Jump'), move: 'fall', instant: true, to: { pid: onto.id, x: clamp(this.x, r.min, r.max) } }], true);
  }

  private hoverPurr(): Step {
    return { clip: 'Purr', dur: Infinity, user: true, hover: true };
  }

  private isAsleep() {
    return this.cur.clip === 'Sleep' || this.cur.clip === 'LieDown';
  }

  private oneShot(clip: CatClip, user = false): Step {
    return { clip, dur: this.o.durations[clip], user };
  }

  private loop(clip: CatClip, min: number, max: number): Step {
    return { clip, dur: min + (max - min) * this.o.rng() };
  }

  private pause(): Step {
    return this.loop('Idle', this.o.roamEvery[0], this.o.roamEvery[1]);
  }

  private start(steps: Step[], interrupt: boolean) {
    if (interrupt) {
      this.queue = [];
      this.evac = false;
    }
    this.queue.push(...steps);
    this.advance();
  }

  private advance() {
    let nextStep = this.queue.shift();
    if (this.evac && !nextStep?.evac) this.evac = false;
    if (!nextStep) {
      // nothing queued: purr if the pointer is on us, otherwise pick something to do
      const i = this.last;
      if (i?.hovered && !this.isAsleep()) {
        nextStep = this.hoverPurr();
      } else {
        this.queue = i ? this.choose(i) : [this.loop('Idle', 2, 4)];
        nextStep = this.queue.shift() ?? this.loop('Idle', 2, 4);
      }
    }
    this.cur = nextStep;
    this.t = 0;
    this.seq++;
    this.landed = false;
    if (this.cur.random) this.cur.targetX = this.randomTarget();
    if (this.cur.inPlace) {
      const leap = this.leap();
      const r = this.range();
      let dir = this.cur.inPlace.dir ?? this.facing;
      if (this.x + dir * leap.distance > r.max || this.x + dir * leap.distance < r.min) dir = (-dir) as 1 | -1;
      this.cur.to = { pid: this.pid, x: clamp(this.x + dir * leap.distance, r.min, r.max) };
    }
    if (this.cur.move === 'walk' || this.cur.move === 'run') {
      const r = this.range();
      const tx = clamp(this.cur.targetX ?? this.x, r.min, r.max);
      this.cur.targetX = tx;
      if (Math.abs(tx - this.x) > 1e-3) this.facing = tx > this.x ? 1 : -1;
    }
    if (this.cur.move === 'leap' || this.cur.move === 'fall') {
      const to = this.cur.to;
      const dest = to && this.platform(to.pid);
      if (!to || !dest) {
        // the destination is gone: forget the trip and re-choose from here
        this.queue = [];
        this.cur = this.loop('Idle', 0.3, 0.6);
        return;
      }
      if (this.cur.move === 'leap' && dest.y - this.y > this.o.reach.up + 0.05) {
        // it moved out of reach (resize / scroll) since the plan was made
        this.queue = [];
        this.cur = this.loop('Idle', 0.3, 0.6);
        return;
      }
      this.from = { x: this.x, y: this.y };
      this.vy = 0;
      const dx = to.x - this.x;
      if (Math.abs(dx) > 0.02) this.facing = dx > 0 ? 1 : -1;
      if (this.cur.move === 'fall') {
        const takeoff = this.cur.instant ? 0 : this.leap().takeoff;
        const drop = Math.max(0, this.y - dest.y);
        this.cur.dur = takeoff + Math.sqrt((2 * drop) / this.o.gravity) + 0.2;
      }
    }
  }

  private leap(): Leap {
    return this.cur.clip === 'Pounce' ? this.o.pounce : this.o.jump;
  }

  private stepDone(): boolean {
    const s = this.cur;
    if (s.move === 'walk' || s.move === 'run') {
      return Math.abs((s.targetX ?? this.x) - this.x) < 0.005 || this.t > 30;
    }
    if (s.move === 'fall') return this.landed && this.t >= s.dur;
    return this.t >= s.dur;
  }

  private applyMotion(dt: number) {
    const s = this.cur;
    if (s.move === 'walk' || s.move === 'run') {
      const speed = s.move === 'run' ? this.o.runSpeed : this.o.walkSpeed;
      const d = (s.targetX ?? this.x) - this.x;
      this.x += Math.sign(d) * Math.min(Math.abs(d), speed * dt);
    } else if (s.move === 'leap' && s.to) {
      if (this.landed) return;
      const dest = this.platform(s.to.pid);
      if (!dest) {
        // the landing spot vanished mid-air: fall from here onto whatever is below
        this.landed = true;
        this.dropOnto(landingBelow(this.platforms, this.x, this.y));
        return;
      }
      const leap = this.leap();
      const p = clamp((this.t - leap.takeoff) / (leap.land - leap.takeoff), 0, 1);
      const dy = dest.y - this.from.y;
      // a parabola through both floors whose apex clears the higher one by about ARC
      const bulge = 4 * ARC + 2 * Math.abs(dy);
      this.x = this.from.x + (s.to.x - this.from.x) * p;
      this.y = this.from.y + dy * p + bulge * p * (1 - p);
      if (p >= 1 && !this.landed) {
        this.landed = true;
        this.pid = dest.id;
        this.y = dest.y;
      }
    } else if (s.move === 'fall' && s.to) {
      const dest = this.platform(s.to.pid) ?? landingBelow(this.platforms, this.x, this.y);
      const takeoff = s.instant ? 0 : this.leap().takeoff;
      if (this.landed || this.t < takeoff) return;
      const air = Math.max(0.05, s.dur - takeoff - 0.2);
      this.x = this.from.x + (s.to.x - this.from.x) * clamp((this.t - takeoff) / air, 0, 1);
      this.vy -= this.o.gravity * dt;
      this.y += this.vy * dt;
      const floor = dest ? dest.y : 0;
      if (this.y <= floor) {
        this.y = floor;
        this.landed = true;
        if (dest) {
          this.pid = dest.id;
          const r = walkRange(dest, this.o.reach.margin);
          this.x = clamp(this.x, r.min, r.max);
        }
      }
    }
  }

  /** Steps for an explicit command, with the transitions it needs. */
  private plan(clip: CatClip): Step[] {
    switch (clip) {
      case 'Walk': return [{ clip: 'Walk', dur: 0, move: 'walk', random: true }];
      case 'Run': return [{ clip: 'Run', dur: 0, move: 'run', random: true }];
      case 'Jump': return [this.hopInPlace('Jump')];
      case 'Pounce': return [this.hopInPlace('Pounce')];
      case 'Sit':
      case 'SitIdle': return [this.oneShot('Sit'), this.loop('SitIdle', 4, 9), this.oneShot('StandUp')];
      case 'Sleep':
      case 'LieDown': return this.sleepSteps();
      case 'LoafIdle': return [this.loop('LoafIdle', 6, 12)];
      case 'Idle': return [this.loop('Idle', 2, 5)];
      case 'Purr': return [{ clip: 'Purr', dur: 3 }];
      default: return [this.oneShot(clip, true)];
    }
  }

  /** A jump / pounce along the platform the cat is on when it starts (turning round at the platform's end). */
  private hopInPlace(clip: 'Jump' | 'Pounce', targetX?: number): Step {
    const dir: 1 | -1 | undefined = targetX !== undefined ? (targetX >= this.x ? 1 : -1) : undefined;
    return { ...this.oneShot(clip), move: 'leap', inPlace: { dir } };
  }

  private sleepSteps(): Step[] {
    return [this.oneShot('LieDown'), this.loop('Sleep', 20, 60), this.oneShot('WakeUp'), this.oneShot('Yawn')];
  }

  private annoyed(): Step[] {
    const r = this.range();
    const mid = (r.min + r.max) / 2;
    const margin = Math.min(0.3, (r.max - r.min) / 4);
    const far = this.x < mid ? r.max - margin : r.min + margin;
    const steps: Step[] = [this.oneShot('TailSwish', true)];
    if (!this.reduced) steps.push({ clip: 'Run', dur: 0, move: 'run', targetX: far, user: true });
    steps.push(this.loop('Idle', 1, 2));
    return steps;
  }

  private randomTarget(): number {
    const { min, max } = this.range();
    const span = max - min;
    for (let k = 0; k < 6; k++) {
      const tx = min + this.o.rng() * span;
      if (Math.abs(tx - this.x) > Math.min(0.25, span * 0.2)) return tx;
    }
    return this.x > (min + max) / 2 ? min + span * 0.2 : max - span * 0.2;
  }

  /** Weighted autonomous choice when nothing is queued. */
  private choose(i: BrainInput): Step[] {
    if (i.home) return this.homeSteps(i.home, i);
    const here = this.platform(this.pid);
    const atHome = !!here?.home;
    const idleFor = this.clock - this.lastInteraction;
    const sleepAfter = i.sleepAfter ?? this.o.sleepAfter;
    if (idleFor > sleepAfter && this.o.rng() < 0.5) {
      // bedtime: half the time go home to sleep, otherwise doze off right here. The idle timer restarts at wake-up.
      const goHome = !atHome && !i.reducedMotion && this.homePlatform() && this.o.rng() < BEDTIME_HOME;
      const nap = this.sleepSteps();
      this.lastInteraction = this.clock + nap.reduce((s, st) => s + st.dur, 0);
      return (goHome ? this.travelHome(false) : []).concat(nap);
    }
    const r = this.range();
    const near = i.pointerX !== null && Math.abs(i.pointerX - this.x) > 0.12 && Math.abs(i.pointerX - this.x) < 0.6
      && i.pointerX >= r.min && i.pointerX <= r.max;
    const options: [number, () => Step[]][] = [
      [2.0, () => [this.pause()]],
      [1.5, () => this.plan('Sit')],
      [1.0, () => [this.loop('LoafIdle', 6, 12)]],
      [1.0, () => [this.oneShot('Groom'), this.pause()]],
      [0.8, () => [this.oneShot('Stretch'), this.pause()]],
      [0.5, () => [this.oneShot('Yawn'), this.pause()]],
    ];
    if (!i.reducedMotion) {
      options.push(
        [2.0, () => this.plan('Walk').concat(this.pause())],
        [1.0, () => this.plan('Jump')],
        [0.3, () => this.plan('Run').concat(this.pause())],
        [atHome ? WANDER_WEIGHT.home : WANDER_WEIGHT.away, () => this.wander()],
      );
      if (near && i.pointerIdle > 1.5) {
        options.push([3.0, () => [this.hopInPlace('Pounce', i.pointerX!)]]);
      }
    }
    const total = options.reduce((s, [w]) => s + w, 0);
    let rr = this.o.rng() * total;
    for (const [w, make] of options) {
      rr -= w;
      if (rr <= 0) return this.filterReduced(make(), i.reducedMotion);
    }
    return [this.loop('Idle', 2, 4)];
  }

  /** Pick a destination platform (home most, neighbours next) and go there; nothing when there is nowhere to go. */
  private wander(): Step[] {
    const here = this.platform(this.pid);
    if (!here) return [this.pause()];
    const near = new Set(neighbours(this.platforms, here, this.x, this.o.reach).map((p) => p.id));
    const choices: [number, Platform][] = [];
    for (const p of this.platforms) {
      if (p.id === here.id) continue;
      const w = p.home ? DEST_WEIGHT.home : near.has(p.id) ? DEST_WEIGHT.neighbour : DEST_WEIGHT.far;
      choices.push([w, p]);
    }
    const total = choices.reduce((s, [w]) => s + w, 0);
    let rr = this.o.rng() * total;
    for (const [w, p] of choices) {
      rr -= w;
      if (rr <= 0) {
        const steps = this.travelTo(p.id);
        if (steps.length) return steps.concat(this.plan('Walk'), this.pause());
        break;
      }
    }
    return this.plan('Walk').concat(this.pause());
  }

  /** The way home (walk, jump, run when far), or, once there, the mood's clip. */
  private homeSteps(home: HomeSpot, i: BrainInput): Step[] {
    const asleep = this.isAsleep();
    const target = home.here ? undefined : this.homePlatform();
    if (target && target.id !== this.pid && !i.reducedMotion) {
      const trip = this.travelTo(target.id);
      if (trip.length) return (asleep ? [this.oneShot('WakeUp')] : []).concat(trip);
    }
    const extras = home.extras ?? [];
    const clip = extras.length && this.o.rng() < EXTRA_CHANCE ? extras[Math.floor(this.o.rng() * extras.length)] : home.loop;
    if (clip === 'Sleep' || clip === 'LieDown') {
      return asleep ? [this.loop('Sleep', 3, 6)] : [this.oneShot('LieDown'), this.loop('Sleep', 3, 6)];
    }
    const steps: Step[] = [];
    if (asleep) steps.push(this.oneShot('WakeUp'));
    const seated = this.cur.clip === 'Sit' || this.cur.clip === 'SitIdle';
    if (clip === 'SitIdle' && !seated) steps.push(this.oneShot('Sit'));
    steps.push(LOOP_CLIPS.has(clip) ? this.loop(clip, 3, 6) : this.oneShot(clip));
    return steps;
  }

  /** Travel to the home platform and its middle. Nothing with reduced motion or without a home. */
  private travelHome(reduced: boolean): Step[] {
    if (reduced) return [];
    const home = this.homePlatform();
    if (!home) return [];
    const trip = this.travelTo(home.id);
    if (home.id !== this.pid && !trip.length) return [];
    const r = walkRange(home, this.o.reach.margin);
    const mid = clamp((home.x0 + home.x1) / 2, r.min, r.max);
    const lastX = trip.length ? trip[trip.length - 1].to!.x : this.x;
    if (Math.abs(mid - lastX) > 0.4) trip.push({ clip: 'Walk', dur: 0, move: 'walk', targetX: mid });
    return trip;
  }

  /** Walk to each hop's take-off point and leap (or fall) across, until on platform `pid`. [] when unreachable. */
  private travelTo(pid: string): Step[] {
    if (pid === this.pid) return [];
    const route = planRoute(this.platforms, this.pid, pid, this.x, this.o.reach);
    if (!route) return [];
    const steps: Step[] = [];
    let x = this.x;
    for (const hop of route) {
      steps.push(...this.walkSteps(x, hop.takeoffX), this.hopStep(hop));
      x = hop.landX;
    }
    return steps;
  }

  private walkSteps(fromX: number, toX: number): Step[] {
    const d = toX - fromX;
    if (Math.abs(d) <= 0.02) return [];
    const run = Math.abs(d) > TROT_RUN_AFTER;
    return [{ clip: run ? 'Run' : 'Walk', dur: 0, move: run ? 'run' : 'walk', targetX: toX }];
  }

  private hopStep(hop: Hop): Step {
    return { ...this.oneShot('Jump'), move: hop.fall ? 'fall' : 'leap', to: { pid: hop.to, x: hop.landX } };
  }

  private filterReduced(steps: Step[], reduced: boolean): Step[] {
    return reduced ? steps.filter((s) => !ROAMING.has(s.clip)) : steps;
  }
}

/** Whether `b` is one hop from `a` for a cat standing at x (exported for tests / tooling). */
export function canHop(a: Platform, b: Platform, x: number, reach: Reach = DEFAULT_REACH): boolean {
  return planHop(a, b, x, reach) !== null;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
