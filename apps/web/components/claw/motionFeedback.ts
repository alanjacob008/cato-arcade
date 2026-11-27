export type MotionKind = "aim" | "hoist";

/** Observe the resolved rig; wall presses and a stationary VRF wait stay silent. */
export function createMotionFeedback(report: (speed: number, kind: MotionKind) => void) {
  let x = 0, y = 0, z = 0, initialized = false, previous = 0, last = -Infinity, kind: MotionKind = "aim";
  return {
    sample(position: { x: number; y: number; z: number }, dt: number, now: number, next: MotionKind, hidden = false) {
      let speed = initialized && dt > 0 ? Math.min(1, Math.hypot(position.x-x, position.y-y, position.z-z) / dt / 2.2) : 0;
      x = position.x; y = position.y; z = position.z; initialized = true;
      if (hidden || !Number.isFinite(speed) || speed < .012) speed = 0;
      if (next !== kind || (speed === 0) !== (previous === 0) || speed > 0 && now - last >= 80) {
        report(speed, next); last = now; previous = speed;
      }
      kind = next;
    },
    stop() { initialized = false; previous = 0; report(0, kind); },
  };
}
