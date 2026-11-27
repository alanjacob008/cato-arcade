import * as THREE from "three";
import { MACHINE, POCKET } from "./config";
import { clawTravelBounds, curvedJawPoints, type BoxPose } from "./clawGrip";
import type { ClawPose } from "./prizeGrip";

export type TransportKey = { atMs: number; position: BoxPose["center"]; rotation: BoxPose["rotation"] };
export type PrizeTransport = { box: BoxPose; angles: number[]; keys: TransportKey[]; durationMs: number };
const vector = (p: BoxPose["center"]) => new THREE.Vector3(p.x, p.y, p.z);
const quaternion = (q: BoxPose["rotation"]) => new THREE.Quaternion(q.x, q.y, q.z, q.w);
const key = (atMs: number, position: THREE.Vector3, rotation: THREE.Quaternion): TransportKey => ({ atMs,
  position: { x: position.x, y: position.y, z: position.z }, rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w } });

/** Fixed fingers and prize travel as one assembly. No reward rules or random draws. */
export function planPrizeTransport(box: BoxPose, contact: ClawPose): PrizeTransport {
  const inverse = contact.rotation.clone().invert();
  const center = vector(box.center).sub(contact.position).applyQuaternion(inverse), rotation = inverse.clone().multiply(quaternion(box.rotation));
  // Worker messages must contain plain quaternion fields; Three's getters do not clone.
  const localBox: BoxPose = { id: box.id, size: box.size, center: { x: center.x, y: center.y, z: center.z },
    rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w } };
  const startBounds = clawTravelBounds(curvedJawPoints(), contact.rotation, MACHINE, contact.angles);
  const cruiseY = startBounds.maxY;
  let destination: { position: THREE.Vector3; rotation: THREE.Quaternion; score: number } | null = null;
  for (let i = 0; i < 72; i++) {
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * Math.PI / 36);
    const bounds = clawTravelBounds(curvedJawPoints(), rotation, MACHINE, contact.angles);
    const offset = vector(localBox.center).applyQuaternion(rotation), boxRotation = rotation.clone().multiply(quaternion(localBox.rotation));
    const extent = new THREE.Vector3();
    for (const axis of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]) {
      axis.applyQuaternion(boxRotation); extent.x += Math.abs(axis.x) * box.size / 2; extent.z += Math.abs(axis.z) * box.size / 2;
    }
    const minX = Math.max(bounds.minX, POCKET.minX + extent.x + .025 - offset.x), maxX = Math.min(bounds.maxX, POCKET.maxX - extent.x - .025 - offset.x);
    const minZ = Math.max(bounds.minZ, POCKET.minZ + extent.z + .025 - offset.z), maxZ = Math.min(bounds.maxZ, POCKET.maxZ - extent.z - .025 - offset.z);
    if (minX > maxX || minZ > maxZ) continue;
    const position = new THREE.Vector3(THREE.MathUtils.clamp((POCKET.minX + POCKET.maxX) / 2 - offset.x, minX, maxX), Math.min(cruiseY, bounds.maxY),
      THREE.MathUtils.clamp((POCKET.minZ + POCKET.maxZ) / 2 - offset.z, minZ, maxZ));
    const score = contact.rotation.angleTo(rotation);
    if (!destination || score < destination.score) destination = { position, rotation, score };
  }
  if (!destination) throw new Error("No glass-safe prize delivery pose");
  const raised = contact.position.clone().setY(cruiseY);
  const direct: PrizeTransport = { box: localBox, angles: [...contact.angles], durationMs: 1350,
    keys: [key(0, contact.position, contact.rotation), key(700, raised, contact.rotation), key(1350, destination.position, destination.rotation)] };
  // Turn while travelling directly to the chute, unless that turn would hit glass.
  const points = curvedJawPoints();
  let clear = true;
  for (let t = 700; t <= direct.durationMs; t += 10) {
    const pose = prizeTransportPose(direct, t), bounds = clawTravelBounds(points, pose.rotation, MACHINE, contact.angles);
    if (pose.position.x < bounds.minX - 1e-8 || pose.position.x > bounds.maxX + 1e-8 || pose.position.z < bounds.minZ - 1e-8 || pose.position.z > bounds.maxZ + 1e-8) { clear = false; break; }
    const center = vector(localBox.center).applyQuaternion(pose.rotation).add(pose.position), rotation = pose.rotation.clone().multiply(quaternion(localBox.rotation));
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      const corner = new THREE.Vector3(x, y, z).multiplyScalar(box.size / 2).applyQuaternion(rotation).add(center);
      // Settled Cannon poses can already touch the glass within solver tolerance.
      if (Math.abs(corner.x) > MACHINE.width / 2 + .005 || Math.abs(corner.z) > MACHINE.depth / 2 + .005) clear = false;
    }
    if (!clear) break;
  }
  if (clear) return direct;
  const central = new THREE.Vector3(0, cruiseY, 0);
  return { ...direct, durationMs: 1750, keys: [direct.keys[0], direct.keys[1], key(900, central, contact.rotation),
    key(1100, central, destination.rotation), key(1750, destination.position, destination.rotation)] };
}

export function prizeTransportPose(transport: PrizeTransport, elapsedMs: number): ClawPose {
  const keys = transport.keys, end = keys.findIndex(k => k.atMs >= elapsedMs);
  if (end <= 0) { const k = end === 0 ? keys[0] : keys.at(-1)!; return { position: vector(k.position), rotation: quaternion(k.rotation), angles: [...transport.angles] }; }
  const a = keys[end - 1], b = keys[end], t = THREE.MathUtils.clamp((elapsedMs - a.atMs) / (b.atMs - a.atMs), 0, 1), mix = t * t * (3 - 2 * t);
  return { position: vector(a.position).lerp(vector(b.position), mix), rotation: quaternion(a.rotation).slerp(quaternion(b.rotation), mix), angles: [...transport.angles] };
}

/** Release is allowed only when the whole intact prize fits over the chute. */
export function isPrizeOverBay(box: BoxPose) {
  const rotation = quaternion(box.rotation), center = vector(box.center);
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    const p = new THREE.Vector3(x, y, z).multiplyScalar(box.size / 2).applyQuaternion(rotation).add(center);
    if (p.x < POCKET.minX || p.x > POCKET.maxX || p.z < POCKET.minZ || p.z > POCKET.maxZ) return false;
  }
  return true;
}

/** Advance by rendered time so a stalled or background tab cannot skip delivery. */
export function advanceDropClock(elapsedMs: number, dt: number, speed: number) {
  return elapsedMs + Math.min(.05, Math.max(0, dt)) * 1000 / speed;
}
