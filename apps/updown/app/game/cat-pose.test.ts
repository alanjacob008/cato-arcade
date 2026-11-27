import { describe, expect, it } from 'vitest';
import { LOOPS, ONE_SHOTS } from '../cat/brain';
import { ASLEEP_AFTER_S, CAT_POSES, CAT_REACTION_MS, catMoodFor, catPose, catPoseSrc } from './cat-pose';

describe('catPose', () => {
  const now = 1_000_000;
  it('sleeps when disconnected, is alert or confused during a round', () => {
    expect(catPose({ connected: false, active: true, now })).toBe('asleep');
    expect(catPose({ connected: true, active: true, now })).toBe('alert');
    expect(catPose({ connected: true, active: true, liveResult: 0.5, now })).toBe('alert');
    expect(catPose({ connected: true, active: true, liveResult: -0.5, now })).toBe('confused');
  });
  it('reacts to the last round for a minute, then waves', () => {
    expect(catPose({ connected: true, active: false, last: { tradingPnl: 2, closedAt: now - 1000 }, now })).toBe('celebrate');
    expect(catPose({ connected: true, active: false, last: { tradingPnl: -2, closedAt: now - 1000 }, now })).toBe('confused');
    expect(catPose({ connected: true, active: false, last: { tradingPnl: 2, closedAt: now - CAT_REACTION_MS - 1 }, now })).toBe('wave');
    expect(catPose({ connected: true, active: false, now })).toBe('wave');
  });
  it('maps poses to the PNG fallbacks', () => {
    expect(catPoseSrc('celebrate')).toBe('/updown/cato/celebrate.webp');
  });
});

describe('catMoodFor', () => {
  it('sends the cat home and holds the mood there, or lets it roam the page', () => {
    expect(catMoodFor('alert')).toEqual({ where: 'spot', loop: 'Purr', extras: ['Stretch'] });
    expect(catMoodFor('confused')).toEqual({ where: 'spot', loop: 'LoafIdle' });
    expect(catMoodFor('celebrate')).toEqual({ where: 'roam', enter: ['Jump', 'Pounce'] });
    expect(catMoodFor('wave')).toEqual({ where: 'roam' });
  });
  it('no wallet does not pin the cat: it roams, just sleepier', () => {
    expect(catMoodFor('asleep')).toEqual({ where: 'roam', sleepAfter: ASLEEP_AFTER_S });
    expect(ASLEEP_AFTER_S).toBeGreaterThanOrEqual(20);
    expect(ASLEEP_AFTER_S).toBeLessThanOrEqual(45);
    for (const pose of CAT_POSES) if (pose !== 'asleep') expect(catMoodFor(pose).sleepAfter).toBeUndefined();
  });
  it('holds a looping clip whenever it is not roaming, and only enters/sprinkles one-shots', () => {
    for (const pose of CAT_POSES) {
      const { where, loop, enter = [], extras = [] } = catMoodFor(pose);
      if (where === 'roam') expect(loop).toBeUndefined();
      else expect(LOOPS).toContain(loop);
      for (const c of [...enter, ...extras]) expect(ONE_SHOTS).toContain(c);
    }
  });
});
