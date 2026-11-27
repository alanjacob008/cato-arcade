/** One lap of the marquee bulbs while a machine waits for a player. */
export const MARQUEE_LAP_MS = 1200;
/** Every bulb keeps this warm glow while the machine waits; the chase peaks on top of it. */
export const MARQUEE_BASE_GLOW = .4;
export type MarqueeState = "waiting" | "playing" | "resting";

/** Brightness 0..1 of bulb `index` of `count`: all bulbs glow warm and a lit head runs the row once a lap with a short tail.
 * During a play every bulb settles on; under reduced motion they rest at one steady level. */
export function marqueeChase(now: number, index: number, count: number, state: MarqueeState) {
  if (state === "resting") return .6;
  if (state === "playing") return 1;
  const head = ((now % MARQUEE_LAP_MS) + MARQUEE_LAP_MS) % MARQUEE_LAP_MS / MARQUEE_LAP_MS * count;
  const behind = ((head - index) % count + count) % count;
  return MARQUEE_BASE_GLOW + (1 - MARQUEE_BASE_GLOW) * Math.exp(-behind * 1.05);
}
