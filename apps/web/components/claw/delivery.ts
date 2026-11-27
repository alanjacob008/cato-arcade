import * as THREE from "three";
import { MACHINE, POCKET } from "./config";

/** The intact box keeps its rotation; its lowest corner must clear the pocket floor. */
export function boxDeliveryHeight({ x, y, z, w }: { x: number; y: number; z: number; w: number }) {
  const verticalExtent = MACHINE.boxSize / 2 * (Math.abs(2 * (x * y + w * z)) + Math.abs(1 - 2 * (x * x + z * z)) + Math.abs(2 * (y * z - w * x)));
  return POCKET.floorY + verticalExtent;
}

/** Align the nearest cube face to the floor, retaining its yaw. */
export function restingBoxRotation(rotation: THREE.Quaternion) {
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map(axis => axis.applyQuaternion(rotation));
  axes.sort((a, b) => Math.abs(b.y) - Math.abs(a.y));
  const up = axes[0].multiplyScalar(Math.sign(axes[0].y));
  return new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(0, 1, 0)).multiply(rotation);
}

/** Free fall under gravity, one low cardboard bounce, then damped contact settling. */
export function boxDropMotion(startY: number, landingY: number, seconds: number) {
  const gravity = 9.81, restitution = .12, height = Math.max(0, startY - landingY);
  const hitTime = Math.sqrt(2 * height / gravity), elapsed = Math.max(0, seconds);
  if (elapsed < hitTime) return { y: startY - .5 * gravity * elapsed * elapsed, contact: false, settle: 0, done: false };
  const afterHit = elapsed - hitTime, reboundSpeed = gravity * hitTime * restitution;
  const bounceTime = 2 * reboundSpeed / gravity, settleTime = Math.max(.32, bounceTime + .10);
  const bounce = afterHit < bounceTime ? Math.max(0, reboundSpeed * afterHit - .5 * gravity * afterHit * afterHit) : 0;
  const p = Math.min(1, afterHit / settleTime), settle = p * p * (3 - 2 * p);
  return { y: landingY + bounce, contact: true, settle, done: p >= 1 };
}
