import { hasClearGrabPoint, hasClearGrabArea, highestSurfaceAt, upwardFaceGripFactor, type Rotation } from "./pile";
import { validateArrangement, type DailyArrangement } from "./daily";
import { ARENA, POCKET, INITIAL_AIM, ENTRY_USD, OPERATING_MARGIN, MIN_PRIZE_CENTS, MAX_PRIZE_CENTS } from "./config";
export { ARENA, MACHINE } from "./config";
export { createPile, boxTop, settlePile, highestSurfaceAt, upwardFaceGripFactor } from "./pile";

export type Aim = Readonly<{ x: number; z: number }>;
export type Point = Readonly<{ x: number; y: number; z: number }>;
export type PaymentCurrency = "USDC";
export const RULES_VERSION = "cato-position-pickup-demo-v12-more-two-usdc-prizes";
export type GrabParameters = Readonly<{
  grabPoint: Point; sigmaX: number; sigmaZ: number; maxPickupProbability: number;
  maxReach: number; exposure?: number; gripSuitability?: number;
}>;
export type PrizeBox = GrabParameters & Readonly<{ id: string; cents: number; color: string; center: Point; rotation: Rotation; size: number }>;
export type Overrides = Readonly<Record<string, Partial<GrabParameters>>>;
export const BET_TIERS = Object.freeze([
  { peakMultiplier: 1, widthMultiplier: 1 }, { peakMultiplier: 1.65, widthMultiplier: 1.2 }, { peakMultiplier: 2.4, widthMultiplier: 1.45 },
]);
const exposureCache = new WeakMap<readonly PrizeBox[], PrizeBox[]>();
export function entryPriceUsd(tier: number, currency: PaymentCurrency): number {
  if (!Number.isInteger(tier) || tier < 0 || tier > 2 || currency !== "USDC") throw new Error("Invalid entry option");
  return ENTRY_USD[currency][tier];
}
export function marginCappedPeak(peak: number, cents: number, revenueUsd: number, margin = OPERATING_MARGIN): number {
  if (![peak, cents, revenueUsd, margin].every(Number.isFinite) || peak < 0 || peak > 1
    || !Number.isInteger(cents) || cents <= 0 || revenueUsd <= 0 || margin < 0 || margin > 1) throw new Error("Invalid margin inputs");
  return Math.min(peak, (1 - margin) * revenueUsd / (cents / 100));
}
export function exposedBoxes(boxes: readonly PrizeBox[]): PrizeBox[] {
  let exposed = exposureCache.get(boxes);
  if (!exposed) { exposed = boxes.filter((box) => hasClearGrabPoint(box, boxes)); exposureCache.set(boxes, exposed); }
  return exposed;
}
export function validateParameters(p: GrabParameters): void {
  if (![p.grabPoint.x, p.grabPoint.y, p.grabPoint.z, p.sigmaX, p.sigmaZ, p.maxReach, p.maxPickupProbability, p.exposure ?? 1, p.gripSuitability ?? 1].every(Number.isFinite)
    || p.sigmaX <= 0 || p.sigmaZ <= 0 || p.maxReach < 0
    || [p.maxPickupProbability, p.exposure ?? 1, p.gripSuitability ?? 1].some((value) => value < 0 || value > 1)) throw new Error("Invalid grab parameters");
}
export function parametersFor(box: PrizeBox, tier: number, overrides: Overrides = {}, currency: PaymentCurrency = "USDC"): GrabParameters {
  const priceUsd = entryPriceUsd(tier, currency);
  const base = { ...box, ...overrides[box.id] }; validateParameters(base);
  const bet = BET_TIERS[tier];
  return Object.freeze({ grabPoint: Object.freeze({ ...base.grabPoint }), sigmaX: base.sigmaX * bet.widthMultiplier,
    sigmaZ: base.sigmaZ * bet.widthMultiplier,
    maxPickupProbability: marginCappedPeak(Math.min(1, base.maxPickupProbability * bet.peakMultiplier), box.cents, priceUsd),
    // Snapshot the pose-derived factor here; pickupProbability and resolvePull
    // use this locked scalar, never a mesh's animated rotation.
    maxReach: base.maxReach, exposure: base.exposure ?? 1,
    gripSuitability: (base.gripSuitability ?? 1) * upwardFaceGripFactor(box) });
}
export function pickupProbability(aim: Aim, p: GrabParameters): number {
  validateParameters(p);
  if (![aim.x, aim.z].every(Number.isFinite)) throw new Error("Invalid aim");
  const dx = aim.x - p.grabPoint.x, dz = aim.z - p.grabPoint.z;
  if (Math.hypot(dx, dz) > p.maxReach) return 0;
  const positionFactor = Math.exp(-0.5 * ((dx / p.sigmaX) ** 2 + (dz / p.sigmaZ) ** 2));
  return Math.max(0, Math.min(1, p.maxPickupProbability * positionFactor * (p.exposure ?? 1) * (p.gripSuitability ?? 1)));
}
export type Target = Readonly<{ box: PrizeBox; parameters: GrabParameters; probability: number }>;
export function selectTarget(aim: Aim, boxes: readonly PrizeBox[], tier: number, overrides: Overrides = {}, currency: PaymentCurrency = "USDC"): Target | null {
  if (![aim.x, aim.z].every(Number.isFinite) || aim.x < ARENA.minX || aim.x > ARENA.maxX || aim.z < ARENA.minZ || aim.z > ARENA.maxZ) throw new Error("Aim outside arena");
  if (aim.x < POCKET.maxX && aim.z > POCKET.minZ) return null;
  // Select the first physical box under the aim, never a nearby lower prize through a gap.
  const surface = highestSurfaceAt(aim, boxes);
  if (!surface || !hasClearGrabPoint(surface.box, boxes) || !hasClearGrabArea(aim, surface.box, boxes)) return null;
  const parameters = parametersFor(surface.box, tier, overrides, currency);
  const distance = Math.hypot(aim.x - parameters.grabPoint.x, aim.z - parameters.grabPoint.z);
  if (distance > parameters.maxReach) return null;
  return { box: surface.box, parameters, probability: pickupProbability(aim, parameters) };
}
/** Start above a reachable surface when the fixed center is blocked in this pile. */
export function startingAim(boxes: readonly PrizeBox[]): Aim {
  if (selectTarget(INITIAL_AIM, boxes, 0)) return INITIAL_AIM;
  const candidates = exposedBoxes(boxes).map(box => ({
    x: Math.max(ARENA.minX, Math.min(ARENA.maxX, box.grabPoint.x)),
    z: Math.max(ARENA.minZ, Math.min(ARENA.maxZ, box.grabPoint.z)),
  })).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
  return candidates.find(aim => selectTarget(aim, boxes, 0)) ?? INITIAL_AIM;
}
export type LockedPull = Readonly<{ id: string; rulesVersion: string; aim: Aim; target: Target | null; tier: number; currency: PaymentCurrency; priceUsd: number; arrangement?: DailyArrangement }>;
export type PullResult = Readonly<{ pullId: string; targetId: string | null; probability: number; roll: number | null; success: boolean; cents: number; source: "seeded-debug" | "browser-demo" | "magicblock-vrf" }>;
export type RandomSource = () => number;
export function seededRandom(seed: number): RandomSource {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Seed must be an unsigned 32-bit integer");
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let n = Math.imul(state ^ state >>> 15, 1 | state); n ^= n + Math.imul(n ^ n >>> 7, 61 | n); return ((n ^ n >>> 14) >>> 0) / 4294967296; };
}
export const browserRandom: RandomSource = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
export function resolvePull(pull: LockedPull, random: RandomSource, source: PullResult["source"] = "seeded-debug"): PullResult {
  // A locked grab is allowed to resolve after its UTC day ends.
  if (pull.arrangement) validateArrangement(pull.arrangement);
  if (typeof pull.id !== "string" || !pull.id.trim() || pull.id.length > 100 || pull.rulesVersion !== RULES_VERSION || !Number.isInteger(pull.tier) || pull.tier < 0 || pull.tier > 2 || pull.currency !== "USDC"
    || pull.priceUsd !== entryPriceUsd(pull.tier, pull.currency) || ![pull.aim.x, pull.aim.z].every(Number.isFinite)
    || pull.aim.x < ARENA.minX || pull.aim.x > ARENA.maxX || pull.aim.z < ARENA.minZ || pull.aim.z > ARENA.maxZ) throw new Error("Invalid locked pull");
  const recalculated = pull.target ? pickupProbability(pull.aim, pull.target.parameters) : 0;
  if (pull.target && (!Number.isFinite(pull.target.probability) || pull.target.probability < 0 || pull.target.probability > 1
    || typeof pull.target.box.id !== "string" || !pull.target.box.id.trim() || pull.target.box.id.length > 100
    || Math.abs(recalculated - pull.target.probability) > 1e-12 || !Number.isInteger(pull.target.box.cents)
    || pull.target.box.cents < MIN_PRIZE_CENTS || pull.target.box.cents > MAX_PRIZE_CENTS
    || pull.target.parameters.maxPickupProbability > marginCappedPeak(1, pull.target.box.cents, pull.priceUsd) + 1e-12)) throw new Error("Invalid target snapshot");
  // Math.exp can differ by a final bit across browser/server runtimes. Validate
  // the geometry above, then resolve with the exact probability locked before
  // drawing. This is also the value used to build the onchain integer cutoff.
  const probability = pull.target?.probability ?? 0;
  const roll = pull.target ? random() : null;
  if (roll !== null && (!Number.isFinite(roll) || roll < 0 || roll >= 1)) throw new Error("Random source must return [0, 1)");
  const success = roll !== null && roll < probability;
  return Object.freeze({ pullId: pull.id, targetId: pull.target?.box.id ?? null, probability, roll, success, cents: success ? pull.target!.box.cents : 0, source });
}
export interface PickupProvider { resolve(pull: LockedPull): Promise<PullResult> }
export function createPickupProvider(random: RandomSource, source: PullResult["source"] = "seeded-debug"): PickupProvider {
  const results = new Map<string, { signature: string; result: PullResult }>();
  return { async resolve(pull) {
    const signature = JSON.stringify(pull), cached = results.get(pull.id);
    if (cached) { if (cached.signature !== signature) throw new Error("Attempt ID reused with different inputs"); return cached.result; }
    const result = resolvePull(pull, random, source); results.set(pull.id, { signature, result });
    return result;
  } };
}
export type Simulation = Readonly<{ attempts: number; successes: number; expectedRate: number; observedRate: number; tolerance: number; noTarget: number; seed: number }>;
export function simulatePickups(seed: number, attempts: number, boxes: readonly PrizeBox[], tier: number, overrides: Overrides, mode: "random" | "aligned", currency: PaymentCurrency = "USDC"): Simulation {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 100000) throw new Error("Invalid simulation count");
  const aimRandom = seededRandom((seed ^ 0xa5a5a5a5) >>> 0), rollRandom = seededRandom(seed);
  const available = exposedBoxes(boxes); let successes = 0, sum = 0, variance = 0, noTarget = 0;
  for (let i = 0; i < attempts; i++) {
    const box = available.length ? available[Math.floor(aimRandom() * available.length)] : null;
    const requested = mode === "aligned" && box ? parametersFor(box, tier, overrides, currency).grabPoint : { x: ARENA.minX + aimRandom() * (ARENA.maxX - ARENA.minX), z: ARENA.minZ + aimRandom() * (ARENA.maxZ - ARENA.minZ) };
    // Clamp debugging aims to the original logical arena, independent of rendered jaw dimensions.
    const aim = { x: Math.max(ARENA.minX, Math.min(ARENA.maxX, requested.x)), z: Math.max(ARENA.minZ, Math.min(ARENA.maxZ, requested.z)) };
    const target = selectTarget(aim, boxes, tier, overrides, currency);
    const pull: LockedPull = { id: `simulation-${i}`, rulesVersion: RULES_VERSION, aim, target, tier, currency, priceUsd: entryPriceUsd(tier, currency) };
    const result = resolvePull(pull, rollRandom); if (result.success) successes++; if (!target) noTarget++;
    sum += result.probability; variance += result.probability * (1 - result.probability);
  }
  return Object.freeze({ attempts, successes, expectedRate: sum / attempts, observedRate: successes / attempts, tolerance: 3 * Math.sqrt(variance) / attempts, noTarget, seed });
}
