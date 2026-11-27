import * as CANNON from "cannon-es";
import { MACHINE, POCKET, PILE_LAYOUT, PRIZE_INVENTORY } from "./config";
import type { Aim, Point, PrizeBox } from "./rewards";

export type Rotation = Readonly<{ x: number; y: number; z: number; w: number }>;
const geometry = new WeakMap<PrizeBox, { axes: CANNON.Vec3[]; top: number }>();
function shape(box: PrizeBox) {
  let cached = geometry.get(box);
  if (!cached) {
    const q = new CANNON.Quaternion(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w);
    const axes = [new CANNON.Vec3(1, 0, 0), new CANNON.Vec3(0, 1, 0), new CANNON.Vec3(0, 0, 1)].map((axis) => q.vmult(axis));
    cached = { axes, top: box.center.y + box.size / 2 * axes.reduce((sum, axis) => sum + Math.abs(axis.y), 0) };
    geometry.set(box, cached);
  }
  return cached;
}
export function boxTop(box: PrizeBox): number { return shape(box).top; }

function upwardFaceAxis(box: PrizeBox): number {
  const axes = shape(box).axes;
  return axes.reduce((best, axis, i) => Math.abs(axis.y) > Math.abs(axes[best].y) ? i : best, 0);
}

/** cos²(tilt) of the most upward-facing cube face, in world space. */
export function upwardFaceGripFactor(box: PrizeBox): number {
  const normal = shape(box).axes[upwardFaceAxis(box)];
  // Opposite faces share the same squared vertical component. Quarter turns
  // simply choose another face, so a cube lying flat still receives factor 1.
  return Math.max(0, Math.min(1, normal.y ** 2));
}

/** Exact vertical-ray intersection with the oriented collision box. */
export function surfaceAt(aim: Aim, box: PrizeBox): number | null {
  const half = box.size / 2;
  let low = -Infinity, high = Infinity;
  for (const axis of shape(box).axes) {
    const offset = (aim.x - box.center.x) * axis.x + (aim.z - box.center.z) * axis.z;
    if (Math.abs(axis.y) < 1e-9) { if (Math.abs(offset) > half) return null; continue; }
    const a = (-half - offset) / axis.y, b = (half - offset) / axis.y;
    low = Math.max(low, Math.min(a, b)); high = Math.min(high, Math.max(a, b));
    if (low > high) return null;
  }
  return box.center.y + high;
}
export function highestSurfaceAt(aim: Aim, boxes: readonly PrizeBox[]): { box: PrizeBox; y: number } | null {
  let hit: { box: PrizeBox; y: number } | null = null;
  for (const box of boxes) { const y = surfaceAt(aim, box); if (y !== null && (!hit || y > hit.y)) hit = { box, y }; }
  return hit;
}
/** Box-sized descent area, independent of rendered finger dimensions.
 * Lower edge prizes remain reachable, but a deep slot between taller prizes does not.
 * This is a sampled clearance approximation, not a rigid-body claw simulation.
 */
export function hasClearGrabArea(aim: Aim, box: PrizeBox, boxes: readonly PrizeBox[]): boolean {
  const hit = highestSurfaceAt(aim, boxes);
  if (!hit || hit.box.id !== box.id) return false;
  const radius = box.size / 2, permittedStep = box.size / 2;
  for (let ring = 1; ring <= 2; ring++) for (let i = 0; i < 16; i++) {
    const angle = i * Math.PI / 8;
    const point = { x: aim.x + Math.cos(angle) * radius * ring / 2,
      z: aim.z + Math.sin(angle) * radius * ring / 2 };
    const neighbor = highestSurfaceAt(point, boxes);
    if (neighbor && neighbor.box.id !== box.id && neighbor.y > hit.y + permittedStep + .035) return false;
  }
  return true;
}
export function hasClearGrabPoint(box: PrizeBox, boxes: readonly PrizeBox[]): boolean {
  return !boxes.some((other) => other.id !== box.id && (surfaceAt(box.grabPoint, other) ?? -Infinity) > box.grabPoint.y + .035);
}
function facePoints(box: PrizeBox): Point[] {
  const axes = shape(box).axes;
  const topAxis = upwardFaceAxis(box);
  const up = axes[topAxis], half = box.size / 2, sign = Math.sign(up.y);
  const face = { x: box.center.x + up.x * half * sign, y: box.center.y + up.y * half * sign, z: box.center.z + up.z * half * sign };
  const points = [face];
  // A partly covered box can still be reached at an uncovered patch of its upper face.
  for (const axis of axes.filter((_, i) => i !== topAxis)) for (const direction of [-1, 1]) {
    points.push({ x: face.x + axis.x * half * .55 * direction, y: face.y + axis.y * half * .55 * direction, z: face.z + axis.z * half * .55 * direction });
  }
  return points;
}
export function snapshot(templates: readonly PrizeBox[], bodies: readonly CANNON.Body[]): PrizeBox[] {
  const poses = templates.map((box, i) => {
    const body = bodies[i];
    const pose = { ...box, center: Object.freeze({ x: body.position.x, y: body.position.y, z: body.position.z }),
      rotation: Object.freeze({ x: body.quaternion.x, y: body.quaternion.y, z: body.quaternion.z, w: body.quaternion.w }) };
    return Object.freeze({ ...pose, grabPoint: Object.freeze(facePoints(pose)[0]) });
  });
  return poses.map((box) => {
    const point = facePoints(box).find((grabPoint) => hasClearGrabPoint({ ...box, grabPoint }, poses)) ?? box.grabPoint;
    return Object.freeze({ ...box, grabPoint: Object.freeze(point) });
  });
}
export function physics(boxes: readonly PrizeBox[]) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0), allowSleep: true });
  (world.solver as CANNON.GSSolver).iterations = 18;
  world.defaultContactMaterial.friction = .65;
  world.defaultContactMaterial.restitution = .015;
  world.defaultContactMaterial.contactEquationStiffness = 1e7;
  world.defaultContactMaterial.contactEquationRelaxation = 4;
  const floor = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
  floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0); floor.position.y = MACHINE.floorY; world.addBody(floor);
  // Invisible collision walls match the rendered chamber's inner boundary.
  const halfWidth = MACHINE.width / 2, halfDepth = MACHINE.depth / 2, loadingHeight = MACHINE.boxCount * .85 + 6;
  for (const [x, z, sx, sz] of [[-halfWidth - .05, 0, .05, halfDepth + .1], [halfWidth + .05, 0, .05, halfDepth + .1], [0, -halfDepth - .05, halfWidth + .1, .05], [0, halfDepth + .05, halfWidth + .1, .05]]) {
    // Walls extend up through the offscreen loading stream so falling boxes cannot escape.
    world.addBody(new CANNON.Body({ mass: 0, position: new CANNON.Vec3(x, loadingHeight / 2, z), shape: new CANNON.Box(new CANNON.Vec3(sx, loadingHeight / 2, sz)) }));
  }
  // Reserve the entire vertical drop corridor, including overhanging rotated boxes.
  // This static exclusion also runs after every pickup, so the bay stays clear.
  world.addBody(new CANNON.Body({ mass: 0,
    position: new CANNON.Vec3((POCKET.minX + POCKET.maxX) / 2, loadingHeight / 2, (POCKET.minZ + POCKET.maxZ) / 2),
    shape: new CANNON.Box(new CANNON.Vec3((POCKET.maxX - POCKET.minX) / 2, loadingHeight / 2, (POCKET.maxZ - POCKET.minZ) / 2)) }));
  const bodies = boxes.map((box) => {
    const body = new CANNON.Body({ mass: 1, shape: new CANNON.Box(new CANNON.Vec3(box.size / 2, box.size / 2, box.size / 2)),
      position: new CANNON.Vec3(box.center.x, box.center.y, box.center.z), linearDamping: .25, angularDamping: .35,
      sleepSpeedLimit: .035, sleepTimeLimit: .6 });
    body.quaternion.set(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w); world.addBody(body); return body;
  });
  return { world, bodies };
}

function shuffledPrizes(seed: number) {
  const prizes = PRIZE_INVENTORY.flatMap((entry) => Array.from({ length: entry.count }, () => entry));
  if (prizes.length !== MACHINE.boxCount) throw new Error("Prize inventory must match the machine box count");
  let prizeState = (seed ^ 0xc470b0) >>> 0;
  for (let i = prizes.length - 1; i > 0; i--) {
    prizeState = (Math.imul(prizeState, 1664525) + 1013904223) >>> 0;
    const j = Math.floor(prizeState / 4294967296 * (i + 1));
    [prizes[i], prizes[j]] = [prizes[j], prizes[i]];
  }
  return { prizes, prizeState };
}

/** Cheap canonical templates for validating a cached initial pose set. */
export function pileBlueprint(seed: number): PrizeBox[] {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const { prizes } = shuffledPrizes(seed);
  const boxes = Array.from({ length: MACHINE.boxCount }, (_, index) => {
    const q = new CANNON.Quaternion(); q.setFromEuler(random() * Math.PI, random() * Math.PI, random() * Math.PI);
    const center = { x: (random() - random()) * .75, y: 2.7 + index * .85, z: (random() - random()) * .65 };
    const prize = prizes[index];
    return Object.freeze({ id: `BOX-${String(index + 1).padStart(2, "0")}`, cents: prize.cents, color: prize.color,
      center: Object.freeze(center), rotation: Object.freeze({ x: q.x, y: q.y, z: q.z, w: q.w }), size: MACHINE.boxSize,
      grabPoint: Object.freeze({ ...center }), sigmaX: .26, sigmaZ: .26, maxPickupProbability: prize.peak, maxReach: .7, exposure: 1, gripSuitability: 1 });
  });
  return boxes;
}

/** Reapply the exact seeded prize assignment; never trust cached prize values or odds. */
export function assignInitialPrizes(settled: readonly PrizeBox[], seed: number): PrizeBox[] {
  const shuffled = shuffledPrizes(seed), prizes = shuffled.prizes;
  let prizeState = shuffled.prizeState;
  const coveredPrizes = prizes.filter((prize) => prize.cents >= PILE_LAYOUT.coveredPrizeMinCents);
  const otherPrizes = prizes.filter((prize) => prize.cents < PILE_LAYOUT.coveredPrizeMinCents);
  // Identical cubes have identical physics. Assign the fixed prizes to their settled
  // positions before the machine becomes playable. Purple prizes can occur at any
  // covered depth; exclude only the initially exposed, grabbable top surface.
  // Natural occlusion controls access; never add an invisible pickup restriction.
  const covered = settled.filter((box) => !hasClearGrabPoint(box, settled));
  for (let i = covered.length - 1; i > 0; i--) {
    prizeState = (Math.imul(prizeState, 1664525) + 1013904223) >>> 0;
    const j = Math.floor(prizeState / 4294967296 * (i + 1));
    [covered[i], covered[j]] = [covered[j], covered[i]];
  }
  if (covered.length < coveredPrizes.length) throw new Error("The starting pile needs covered positions for its purple prizes");
  const coveredIds = new Set(covered.slice(0, coveredPrizes.length).map((box) => box.id));
  let coveredIndex = 0, otherIndex = 0;
  return settled.map((box) => {
    const prize = coveredIds.has(box.id) ? coveredPrizes[coveredIndex++] : otherPrizes[otherIndex++];
    return Object.freeze({ ...box, cents: prize.cents, color: prize.color, maxPickupProbability: prize.peak });
  });
}

/** Seed controls the loading pattern, independently of the reward RNG. */
export function createPile(seed = 2026): PrizeBox[] {
  const boxes = pileBlueprint(seed);
  const { world, bodies } = physics(boxes);
  for (let i = 0; i < 900; i++) world.step(1 / 60);
  return assignInitialPrizes(snapshot(boxes, bodies), seed);
}

/** A deterministic collision-resolved trajectory for the pile after a box is removed. */
export function settlePile(boxes: readonly PrizeBox[]): PrizeBox[][] {
  const { world, bodies } = physics(boxes), frames = [[...boxes]];
  for (let i = 1; i <= 240; i++) {
    world.step(1 / 60);
    if (i % 8 === 0) frames.push(snapshot(boxes, bodies));
  }
  return frames;
}
