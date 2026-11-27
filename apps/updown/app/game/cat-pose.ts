import type { Round } from './api';
import { withBasePath } from '../utils/base-path';
import type { CatClip } from '../cat/brain';

export type CatPose = 'asleep' | 'wave' | 'alert' | 'confused' | 'celebrate';
export const CAT_POSES: readonly CatPose[] = ['asleep', 'wave', 'alert', 'confused', 'celebrate'];
/** How long Cato reacts to a finished round before going back to waving. */
export const CAT_REACTION_MS = 60000;

export type CatState = {
  /** Wallet connected with trading enabled. */
  connected: boolean;
  /** True while a round is opening, open or closing. */
  active: boolean;
  /** Live estimated net result of the active round, when it is known. */
  liveResult?: number;
  /** The most recent finished round, if any. */
  last?: Pick<Round, 'tradingPnl' | 'closedAt'>;
  now: number;
};

/** Which pose Cato shows on the play screen. Pure so it can be unit-tested. */
export function catPose({ connected, active, liveResult, last, now }: CatState): CatPose {
  if (!connected) return 'asleep';
  if (active) return liveResult != null && liveResult < 0 ? 'confused' : 'alert';
  const pnl = last?.tradingPnl;
  if (pnl != null && last?.closedAt != null && now - last.closedAt >= 0 && now - last.closedAt <= CAT_REACTION_MS) {
    if (pnl > 0) return 'celebrate';
    if (pnl < 0) return 'confused';
  }
  return 'wave';
}

export const catPoseSrc = (pose: CatPose) => withBasePath(`/cato/${pose}.webp`);

/** What the roaming 3D cat does for a pose. */
export type CatMood = {
  /**
   * 'spot': go home (Cato's spot, the `[data-cat-home]` anchor on the play screen) and hold `loop` there;
   * 'here': hold `loop` wherever the cat is; 'roam': free roam over the page's platforms (the brain's own idle
   * behaviour, home most of the time).
   */
  where: 'spot' | 'here' | 'roam';
  /** The clip held while the pose lasts (a looping clip). Not used when roaming. */
  loop?: CatClip;
  /** One-shots played in order at home when the pose is entered (the cat travels there first), then `where` applies. */
  enter?: CatClip[];
  /** One-shots sprinkled in now and then between repeats of the loop. */
  extras?: CatClip[];
  /** Roaming: idle seconds before the cat dozes off wherever it is (default: the brain's 45 s). */
  sleepAfter?: number;
};

/** No wallet: the cat is free, just sleepier (dozes off after this long without attention). */
export const ASLEEP_AFTER_S = 30;

const MOOD_FOR: Record<CatPose, CatMood> = {
  asleep: { where: 'roam', sleepAfter: ASLEEP_AFTER_S },
  wave: { where: 'roam' },
  alert: { where: 'spot', loop: 'Purr', extras: ['Stretch'] },
  confused: { where: 'spot', loop: 'LoafIdle' },
  celebrate: { where: 'roam', enter: ['Jump', 'Pounce'] },
};

/** Mood mapping for the roaming 3D cat. Pure so it can be unit-tested. */
export function catMoodFor(pose: CatPose): CatMood {
  return MOOD_FOR[pose];
}
