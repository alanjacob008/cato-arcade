import * as CANNON from "cannon-es";
import * as THREE from "three";
import { physics, snapshot } from "./pile";
import { curvedJawPoints, curvedJawPose, JAW_LINK_RADIUS, JAW_TIP_RADIUS } from "./clawGrip";
import { prizeTransportPose, type PrizeTransport } from "./prizeTransport";
import type { PrizeBox } from "./rewards";
import { MACHINE, POCKET } from "./config";

/** Powered extraction can create impulses large enough to cross a thin wall in
 * one solver step. Project the intact cube back into the physical enclosure. */
export function containPrize(body: CANNON.Body, size: number) {
  const { x, y, z, w } = body.quaternion, half = size / 2;
  const ex = half * (Math.abs(1 - 2 * (y*y + z*z)) + Math.abs(2 * (x*y - w*z)) + Math.abs(2 * (x*z + w*y)));
  const ey = half * (Math.abs(2 * (x*y + w*z)) + Math.abs(1 - 2 * (x*x + z*z)) + Math.abs(2 * (y*z - w*x)));
  const ez = half * (Math.abs(2 * (x*z - w*y)) + Math.abs(2 * (y*z + w*x)) + Math.abs(1 - 2 * (x*x + y*y)));
  function move(axis: "x" | "y" | "z", next: number) {
    if (Math.abs(next - body.position[axis]) < .005) return;
    body.position[axis] = next; body.velocity[axis] = 0; body.aabbNeedsUpdate = true; body.wakeUp();
  }
  move("x", Math.max(-MACHINE.width / 2 + ex, Math.min(MACHINE.width / 2 - ex, body.position.x)));
  move("y", Math.max(MACHINE.floorY + ey, Math.min(MACHINE.height - ey, body.position.y)));
  move("z", Math.max(-MACHINE.depth / 2 + ez, Math.min(MACHINE.depth / 2 - ez, body.position.z)));
  if (body.position.x - ex < POCKET.maxX && body.position.z + ez > POCKET.minZ) {
    const dx = POCKET.maxX + ex - body.position.x, dz = body.position.z - POCKET.minZ + ez;
    if (dx < dz) move("x", body.position.x + dx); else move("z", body.position.z - dz);
  }
}

export type PickupFrame = { atMs: number; boxes: PrizeBox[] };
/** The powered rig displaces neighboring packages instead of getting pinned by a
 * second, independent collision gate. The fingers never change shape or grip. */
export function settlePickup(boxes: readonly PrizeBox[], transport: PrizeTransport): PickupFrame[] {
  const { world, bodies } = physics(boxes);
  world.addBody(new CANNON.Body({ mass: 0, position: new CANNON.Vec3(0, MACHINE.height + .05, 0),
    shape: new CANNON.Box(new CANNON.Vec3(MACHINE.width / 2, .05, MACHINE.depth / 2)) }));
  const carrier = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC });
  const b = transport.box, q = b.rotation;
  carrier.addShape(new CANNON.Box(new CANNON.Vec3(b.size / 2, b.size / 2, b.size / 2)), new CANNON.Vec3(b.center.x, b.center.y, b.center.z), new CANNON.Quaternion(q.x, q.y, q.z, q.w));
  carrier.addShape(new CANNON.Cylinder(.11, .11, .16, 12));
  const points = curvedJawPoints();
  for (let finger = 0; finger < 3; finger++) {
    const path = curvedJawPose(points, finger * Math.PI * 2 / 3, transport.angles[finger]);
    for (let i = 0; i < path.length; i += 3) {
      const a = path[i], radius = i === path.length - 1 ? JAW_TIP_RADIUS : JAW_LINK_RADIUS;
      carrier.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(a.x, a.y, a.z));
      if (!i) continue;
      const from = path[i - 3], direction = a.clone().sub(from), midpoint = from.clone().lerp(a, .5);
      const orientation = new CANNON.Quaternion(); orientation.setFromVectors(new CANNON.Vec3(0, 1, 0), new CANNON.Vec3(direction.x, direction.y, direction.z).unit());
      carrier.addShape(new CANNON.Cylinder(JAW_LINK_RADIUS, JAW_LINK_RADIUS, direction.length(), 8), new CANNON.Vec3(midpoint.x, midpoint.y, midpoint.z), orientation);
    }
  }
  const initial = prizeTransportPose(transport, 0); carrier.position.set(initial.position.x, initial.position.y, initial.position.z);
  carrier.quaternion.set(initial.rotation.x, initial.rotation.y, initial.rotation.z, initial.rotation.w); world.addBody(carrier);
  const frames: PickupFrame[] = [{ atMs: 0, boxes: [...boxes] }];
  const steps = Math.ceil(transport.durationMs * 120 / 1000), dt = transport.durationMs / steps / 1000;
  for (let i = 1; i <= steps; i++) {
    const next = prizeTransportPose(transport, i * dt * 1000);
    carrier.velocity.set((next.position.x - carrier.position.x) / dt, (next.position.y - carrier.position.y) / dt, (next.position.z - carrier.position.z) / dt);
    const delta = next.rotation.clone().multiply(new THREE.Quaternion(carrier.quaternion.x, carrier.quaternion.y, carrier.quaternion.z, carrier.quaternion.w).invert());
    if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
    const sin = Math.hypot(delta.x, delta.y, delta.z), angle = 2 * Math.atan2(sin, delta.w), factor = sin > 1e-8 ? angle / (sin * dt) : 0;
    carrier.angularVelocity.set(delta.x * factor, delta.y * factor, delta.z * factor);
    world.step(dt);
    bodies.forEach((body, i) => containPrize(body, boxes[i].size));
    carrier.position.set(next.position.x, next.position.y, next.position.z); carrier.quaternion.set(next.rotation.x, next.rotation.y, next.rotation.z, next.rotation.w); carrier.aabbNeedsUpdate = true;
    if (i % 6 === 0 || i === steps) frames.push({ atMs: i * dt * 1000, boxes: snapshot(boxes, bodies) });
  }
  world.removeBody(carrier);
  // Let displaced packages settle fully, presenting these last four seconds in 1.4s.
  for (let i = 1; i <= 240; i++) { world.step(1 / 60); bodies.forEach((body, index) => containPrize(body, boxes[index].size)); if (i % 8 === 0) frames.push({ atMs: transport.durationMs + i / 240 * 1400, boxes: snapshot(boxes, bodies) }); }
  return frames;
}
