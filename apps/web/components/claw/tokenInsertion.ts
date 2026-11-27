import * as THREE from "three";

export const TOKEN_SCALE = .4;
/** Rotate outside the fascia, then feed straight through the slot below the control deck. */
export function tokenInsertionPose(slot: THREE.Vector3, progress: number) {
  const t = THREE.MathUtils.clamp(progress, 0, 1);
  const turn = Math.min(1, t / .25), slide = Math.max(0, (t - .25) / .75);
  const ease = (v: number) => v * v * (3 - 2 * v);
  return { position: new THREE.Vector3(slot.x, slot.y, slot.z + .34 - .44 * ease(slide)), rotationY: Math.PI / 2 * ease(turn) };
}
