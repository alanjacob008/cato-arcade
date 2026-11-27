import * as THREE from "three";
import { curvedJawPoints, curvedJawPose, gripObstacle, pointBoxDistance, JAW_OPEN_ANGLE, JAW_LINK_RADIUS, JAW_TIP_RADIUS, type BoxPose, type GripObstacle } from "./clawGrip";
import { MACHINE } from "./config";

export type ClawPose = { position: THREE.Vector3; rotation: THREE.Quaternion; angles: number[] };
export type PrizeGripPlan = ClawPose & { approachAngles: number[]; contacts: number; sideContacts: number; neighboringContacts: number };
const points = curvedJawPoints();
const up = new THREE.Vector3(0, 1, 0);
const gap = .02;
const ease = (value: number) => { const t = THREE.MathUtils.clamp(value, 0, 1); return t * t * (3 - 2 * t); };

function pathAt(position: THREE.Vector3, rotation: THREE.Quaternion, finger: number, angle: number) {
  return curvedJawPose(points, finger * Math.PI * 2 / 3, angle).map(point => point.applyQuaternion(rotation).add(position));
}
function clearPath(path: THREE.Vector3[], target: GripObstacle) {
  for (let i = 0; i < path.length; i++) {
    const radius = i === 0 ? .052 : i === path.length - 1 ? JAW_TIP_RADIUS : JAW_LINK_RADIUS;
    const point = path[i];
    if (Math.abs(point.x) > MACHINE.width / 2 - radius - gap || Math.abs(point.z) > MACHINE.depth / 2 - radius - gap
      || point.y < MACHINE.floorY + radius || point.y > MACHINE.height - radius
      || pointBoxDistance(point, target) < radius + .00005) return false;
    if (i && pointBoxDistance(path[i - 1].clone().lerp(point, .5), target) < JAW_LINK_RADIUS + .00005) return false;
  }
  return true;
}
function contact(path: THREE.Vector3[], target: GripObstacle, outward: THREE.Vector3) {
  const tip = path.at(-1)!, distance = pointBoxDistance(tip, target);
  const local = tip.clone().sub(target.center).applyQuaternion(target.inverseRotation);
  const normal = local.clone().sub(local.clone().clampScalar(-target.half, target.half)).normalize().applyQuaternion(target.inverseRotation.clone().invert());
  return { hit: distance <= JAW_TIP_RADIUS + .009, side: distance <= JAW_TIP_RADIUS + .009 && normal.dot(outward) > .25, distance };
}

/** Deterministic presentation planning only: never reads odds, randomness, tiers or payment. */
export function planPrizeGrip(box: BoxPose, obstacles: readonly BoxPose[] = [], grabPoint?: { x: number; y: number; z: number }): PrizeGripPlan | null {
  const target = gripObstacle(box), neighbors = obstacles.filter(other => other.id !== box.id).map(gripObstacle);
  const center = target.center, rotation = new THREE.Quaternion(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w);
  const axes = [new THREE.Vector3(1, 0, 0), up.clone(), new THREE.Vector3(0, 0, 1)].map(axis => axis.applyQuaternion(rotation));
  const topAxis = axes.reduce((best, axis, i) => Math.abs(axis.y) > Math.abs(axes[best].y) ? i : best, 0);
  const normal = axes[topAxis].clone().multiplyScalar(Math.sign(axes[topAxis].y));
  let best: PrizeGripPlan | null = null, bestScore = -Infinity;
  function evaluate(position: THREE.Vector3, yaw: number, fixed?: { finger: number; angle: number }) {
    if (position.y < MACHINE.floorY + .16 || position.y > MACHINE.height - .16 || Math.abs(position.x) > MACHINE.width / 2 - .16 || Math.abs(position.z) > MACHINE.depth / 2 - .16) return false;
    const q = new THREE.Quaternion().setFromAxisAngle(up, yaw), angles: number[] = [], paths: THREE.Vector3[][] = [];
    let hits = 0, sides = 0;
    for (let finger = 0; finger < 3; finger++) {
      const outward = new THREE.Vector3(Math.cos(finger * Math.PI * 2 / 3), 0, Math.sin(finger * Math.PI * 2 / 3)).applyQuaternion(q);
      let selected: { angle: number; path: THREE.Vector3[]; hit: boolean; side: boolean; score: number } | null = null;
      const samples = fixed?.finger === finger ? [fixed.angle] : Array.from({ length: 61 }, (_, i) => JAW_OPEN_ANGLE * i / 60);
      for (const angle of samples) {
        const path = pathAt(position, q, finger, angle), info = contact(path, target, outward);
        const score = Number(info.side) * 10 + Number(info.hit) * 5 - info.distance;
        if ((!selected || score > selected.score) && clearPath(path, target)) selected = { angle, path, ...info, score };
      }
      if (!selected) return false;
      // Refine the terminal contact without altering any arm vertices or dimensions.
      if (selected.hit && fixed?.finger !== finger) {
        const initial = selected.angle;
        for (let step = -12; step <= 12; step++) {
          const angle = THREE.MathUtils.clamp(initial + step * .001, 0, JAW_OPEN_ANGLE);
          const path = pathAt(position, q, finger, angle), info = contact(path, target, outward);
          const score = Number(info.side) * 10 + Number(info.hit) * 5 - info.distance;
          if (score > selected.score && clearPath(path, target)) selected = { angle, path, ...info, score };
        }
      }
      angles.push(selected.angle); paths.push(selected.path); hits += Number(selected.hit); sides += Number(selected.side);
    }
    if (!hits) return false;
    // A rigid vertical approach must stay outside the selected prize all the way down.
    for (const raise of [.12, .30, .55]) for (let finger = 0; finger < 3; finger++) {
      const raised = paths[finger].map(point => point.clone().addScaledVector(up, raise));
      if (raised.some((point, i) => pointBoxDistance(point, target) < (i === raised.length - 1 ? JAW_TIP_RADIUS : JAW_LINK_RADIUS) + .00005)) return false;
    }
    let neighboringContacts = 0;
    for (const other of neighbors) {
      if (other.center.distanceToSquared(position) > 1.6) continue;
      if (paths.some(path => path.some((point, i) => pointBoxDistance(point, other) < (i === path.length - 1 ? JAW_TIP_RADIUS : JAW_LINK_RADIUS)))) neighboringContacts++;
    }
    const score = sides * 100 + hits * 20 - neighboringContacts * 1000 - position.distanceTo(center.clone().setY(position.y)) * 5 - Math.abs(yaw);
    if (score > bestScore) {
      const approachAngles = angles.map((angle, finger) => {
        const opened = Math.min(JAW_OPEN_ANGLE, angle + .055);
        for (let step = 1; step <= 8; step++) {
          const path = pathAt(position, q, finger, THREE.MathUtils.lerp(angle, opened, step / 8));
          if (!clearPath(path, target) || [.12, .30, .55].some(raise => path.some((point, i) => pointBoxDistance(point.clone().addScaledVector(up, raise), target) < (i === path.length - 1 ? JAW_TIP_RADIUS : JAW_LINK_RADIUS) + .00005))) return angle;
        }
        return opened;
      });
      best = { position: position.clone(), rotation: q, angles, approachAngles, contacts: hits, sideContacts: sides, neighboringContacts }; bestScore = score;
    }
    return neighboringContacts === 0 && sides === 3;
  }
  const yaws = [0, Math.PI / 9, -Math.PI / 9, Math.PI / 3, -Math.PI / 3];
  const towardX = -Math.sign(center.x), towardZ = -Math.sign(center.z);
  for (const offset of [0, .10, .20]) for (const yaw of yaws) for (const height of [.66, .72, .60]) {
    if (evaluate(new THREE.Vector3(center.x + towardX * offset, center.y + height, center.z + towardZ * offset), yaw)) return best;
  }
  // Higher side contacts and asymmetric offsets avoid surrounding packages in dense piles.
  for (const offsetX of [0, .10, .20]) for (const offsetZ of [0, .10, .20]) for (const yaw of yaws) for (const height of [.76, .82]) {
    if (evaluate(new THREE.Vector3(center.x + towardX * offsetX, center.y + height, center.z + towardZ * offsetZ), yaw)) return best;
  }
  // Crowded or wall-adjacent prizes can be hooked at an exposed face patch. Prefer
  // an actual terminal contact over attaching a distant, floating box.
  const face = center.clone().addScaledVector(normal, box.size / 2);
  const patches = grabPoint ? [new THREE.Vector3(grabPoint.x, grabPoint.y, grabPoint.z), face] : [face];
  for (const axis of axes.filter((_, i) => i !== topAxis)) for (const sign of [-1, 1]) patches.push(face.clone().addScaledVector(axis, box.size * .30 * sign));
  for (const patch of patches) for (const yaw of yaws) for (let finger = 0; finger < 3; finger++) for (const angle of [0, .18, .36, .54, .72]) {
    const q = new THREE.Quaternion().setFromAxisAngle(up, yaw), tip = curvedJawPose(points, finger * Math.PI * 2 / 3, angle).at(-1)!.applyQuaternion(q);
    const position = patch.clone().addScaledVector(normal, JAW_TIP_RADIUS + .0001).sub(tip);
    if (evaluate(position, yaw, { finger, angle })) return best;
  }
  return best;
}

/** Approach first, then close at contact. The world-space prize stays still until attachment. */
export function prizeGripPose(origin: ClawPose, plan: PrizeGripPlan, elapsedMs: number): ClawPose {
  const align = ease(elapsedMs / 350), descend = ease((elapsedMs - 350) / 750), close = ease((elapsedMs - 1100) / 450);
  const position = origin.position.clone().lerp(plan.position, align);
  const hoverY = Math.max(origin.position.y, Math.min(MACHINE.height - .16, plan.position.y + .12));
  position.y = elapsedMs < 350 ? THREE.MathUtils.lerp(origin.position.y, hoverY, align) : THREE.MathUtils.lerp(hoverY, plan.position.y, descend);
  return { position, rotation: origin.rotation.clone().slerp(plan.rotation, align), angles: origin.angles.map((angle, i) =>
    elapsedMs < 1100 ? THREE.MathUtils.lerp(angle, plan.approachAngles[i], align) : THREE.MathUtils.lerp(plan.approachAngles[i], plan.angles[i], close)) };
}
