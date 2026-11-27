export const MAX_SWING_ANGLE = .26;
/** Smooth the real gantry instead of teleporting it between pointer-event positions. */
export const smoothGantryPosition = (current: number, target: number, dt: number) => target + (current - target) * Math.exp(-12 * Math.max(0, dt));

/** Velocity impulses preserve short drags; acceleration clipping used to cancel them out. */
export function createClawSwing(x: number, z: number) {
  let previousX = x, previousZ = z, vx = 0, vz = 0, angleX = 0, angleZ = 0, speedX = 0, speedZ = 0;
  const clamp = (n: number, limit: number) => Math.max(-limit, Math.min(limit, n));
  return (nextX: number, nextZ: number, dt: number, reducedMotion = false) => {
    const step = Math.max(.001, Math.min(.05, dt));
    const nextVx = (nextX - previousX) / step, nextVz = (nextZ - previousZ) / step;
    const changeVx = clamp(nextVx - vx, 10), changeVz = clamp(nextVz - vz, 10);
    previousX = nextX; previousZ = nextZ; vx = nextVx; vz = nextVz;
    if (reducedMotion) { angleX = angleZ = speedX = speedZ = 0; return { x: 0, z: 0 }; }
    speedX = clamp(speedX - changeVx * .48, 3);
    speedZ = clamp(speedZ - changeVz * .48, 3);
    speedX += (-14 * angleX - 1.6 * speedX) * step;
    speedZ += (-14 * angleZ - 1.6 * speedZ) * step;
    angleX = clamp(angleX + speedX * step, MAX_SWING_ANGLE); angleZ = clamp(angleZ + speedZ * step, MAX_SWING_ANGLE);
    return { x: angleX, z: angleZ };
  };
}

/** Relative input must release a visual wall immediately, without draining invisible overshoot. */
export function releaseWallOvershoot(current: number, requested: number, visual: number, min: number, max: number) {
  const delta = requested - current;
  const leavingHigh = current > max && visual >= max - 1e-5 && delta < 0;
  const leavingLow = current < min && visual <= min + 1e-5 && delta > 0;
  if (!leavingHigh && !leavingLow) return { target: requested, visual };
  const atWall = Math.max(min, Math.min(max, visual));
  // Reset only hidden input/smoothing state; the visible position is already at this wall.
  return { target: atWall + delta, visual: atWall };
}
