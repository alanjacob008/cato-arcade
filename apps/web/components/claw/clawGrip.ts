import * as THREE from "three";

export type BoxPose = { id?: string; center: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number }; size: number };
export const GRIP_CLEARANCE = .42;
export const JAW_LINK_RADIUS = .030, JAW_TIP_RADIUS = .036;
export const JAW_OPEN_ANGLE = .72, JAW_CLOSED_ANGLE = 0;
/** Folded travel pose; the permanent metal geometry is unchanged. */
export const JAW_TRAVEL_ANGLE = .12;
export const JAW_ROOT_RADIUS = .075, JAW_ROOT_Y = -.09;
export type GripObstacle = { center: THREE.Vector3; inverseRotation: THREE.Quaternion; half: number; radius: number };

/** One immutable curved steel finger, in its hinge's XY plane. */
export function curvedJawPoints() {
  return new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(.095, -.15, 0),
    new THREE.Vector3(.18, -.32, 0), new THREE.Vector3(.16, -.46, 0),
    new THREE.Vector3(.09, -.55, 0), new THREE.Vector3(.02, -.60, 0),
  ], false, "centripetal").getPoints(24);
}

/** The only animated joint is the shoulder hinge. All points share its rotation. */
export function curvedJawPose(points: readonly THREE.Vector3[], azimuth: number, hingeAngle: number) {
  const c = Math.cos(hingeAngle), s = Math.sin(hingeAngle);
  const outward = new THREE.Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
  return points.map(point => outward.clone().multiplyScalar(JAW_ROOT_RADIUS + point.x * c - point.y * s)
    .setY(JAW_ROOT_Y + point.x * s + point.y * c));
}

export function gripObstacle(box: BoxPose): GripObstacle {
  return { center: new THREE.Vector3(box.center.x, box.center.y, box.center.z), inverseRotation: new THREE.Quaternion(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w).invert(), half: box.size / 2, radius: box.size * Math.sqrt(3) / 2 };
}

/** Conservative capsule/OBB test. Touching is allowed; entering the expanded box is not. */
export function jawSegmentHitsBox(start: THREE.Vector3, end: THREE.Vector3, radius: number, box: GripObstacle) {
  const delta = end.clone().sub(start), nearest = start.clone().addScaledVector(delta, THREE.MathUtils.clamp(box.center.clone().sub(start).dot(delta) / Math.max(1e-12, delta.lengthSq()), 0, 1));
  if (nearest.distanceToSquared(box.center) > (box.radius + radius) ** 2) return false;
  const a = start.clone().sub(box.center).applyQuaternion(box.inverseRotation), b = end.clone().sub(box.center).applyQuaternion(box.inverseRotation);
  const span = b.sub(a), half = box.half + radius - 1e-5;
  let near = 0, far = 1;
  for (const axis of ["x", "y", "z"] as const) {
    if (Math.abs(span[axis]) < 1e-10) { if (Math.abs(a[axis]) >= half) return false; }
    else {
      const lo = (-half - a[axis]) / span[axis], hi = (half - a[axis]) / span[axis];
      near = Math.max(near, Math.min(lo, hi)); far = Math.min(far, Math.max(lo, hi));
      if (near > far) return false;
    }
  }
  return far >= 0 && near <= 1;
}


/** Euclidean distance to the actual oriented surface, including edges and corners. */
export function pointBoxDistance(point: THREE.Vector3, box: GripObstacle) {
  const local = point.clone().sub(box.center).applyQuaternion(box.inverseRotation);
  return local.distanceTo(local.clone().clampScalar(-box.half, box.half));
}

/** Visual-only clearance for every shoulder angle; never changes logical aim or odds. */
export function clawTravelBounds(points: readonly THREE.Vector3[], rotation: THREE.Quaternion, cabinet: { width: number; depth: number; height: number; floorY: number }, angles?: readonly number[]) {
  const min = new THREE.Vector3(-.14, -.14, -.14), max = new THREE.Vector3(.14, .14, .14);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rotation);
  for (let finger = 0; finger < 3; finger++) {
    const azimuth = finger * Math.PI * 2 / 3;
    const outward = new THREE.Vector3(Math.cos(azimuth), 0, Math.sin(azimuth)).applyQuaternion(rotation);
    points.forEach((point, i) => {
      const radius = i === 0 ? .052 : i === points.length - 1 ? JAW_TIP_RADIUS : JAW_LINK_RADIUS;
      for (const axis of ["x", "y", "z"] as const) {
        const base = JAW_ROOT_RADIUS * outward[axis] + JAW_ROOT_Y * up[axis];
        const a = point.x * outward[axis] + point.y * up[axis], b = -point.y * outward[axis] + point.x * up[axis];
        const phase = Math.atan2(b, a);
        // Extrema of a*cos(theta)+b*sin(theta), including interior hinge angles.
        const low = angles?.[finger] ?? JAW_CLOSED_ANGLE, high = angles?.[finger] ?? JAW_OPEN_ANGLE;
        for (const angle of [low, high, phase, phase + Math.PI, phase - Math.PI]) {
          if (angle < low || angle > high) continue;
          const value = base + a * Math.cos(angle) + b * Math.sin(angle);
          min[axis] = Math.min(min[axis], value - radius); max[axis] = Math.max(max[axis], value + radius);
        }
      }
    });
  }
  const gap = .02;
  return Object.freeze({ minX: -cabinet.width / 2 + gap - min.x, maxX: cabinet.width / 2 - gap - max.x,
    minZ: -cabinet.depth / 2 + gap - min.z, maxZ: cabinet.depth / 2 - gap - max.z,
    minY: cabinet.floorY + gap - min.y, maxY: cabinet.height - gap - max.y });
}

/** Reconstruct the cable from the actual claw pose so its bearing never separates or flips. */
export function clawCablePose(position: THREE.Vector3, rotation: THREE.Quaternion, ceilingY: number) {
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rotation);
  const length = Math.max(.01, (ceilingY - position.y) / Math.max(.1, up.y));
  return { anchor: position.clone().addScaledVector(up, length), length };
}
