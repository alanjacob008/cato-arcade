import type { PrizeBox } from "./rewards";
import { MACHINE } from "./config";

export const DAILY_LAYOUT_VERSION = "cato-personal-pile-v8-more-two-usdc-prizes";
export const PLAYER_STORAGE_KEY = "cato-claw-demo-player-v1";
const DAY_MS = 86_400_000;
const RESET_OFFSET_MS = 60_000;
export type DailyArrangement = Readonly<{ id: string; playerId: string; day: string; seed: number; resetsAt: number }>;
export type DemoStorage = Pick<Storage, "getItem" | "setItem">;

/** Public layout seed only. Never use this hash as prize randomness. */
export function dailyArrangement(playerId: string, now: number): DailyArrangement {
  if (!playerId.trim() || playerId.length > 200 || !Number.isFinite(now) || now < 0 || now > 8.64e15 - DAY_MS - RESET_OFFSET_MS) throw new Error("Invalid daily identity or time");
  // The daily period starts one minute before midnight, at 23:59 UTC.
  const dayBoundary = Math.floor((now + RESET_OFFSET_MS) / DAY_MS) * DAY_MS;
  const startsAt = dayBoundary - RESET_OFFSET_MS, day = new Date(dayBoundary).toISOString().slice(0, 10);
  const id = `${DAILY_LAYOUT_VERSION}:${playerId}:${day}`;
  let seed = 2166136261;
  for (const byte of new TextEncoder().encode(id)) { seed ^= byte; seed = Math.imul(seed, 16777619) >>> 0; }
  return Object.freeze({ id, playerId, day, seed, resetsAt: startsAt + DAY_MS });
}
export function needsDailyReset(arrangement: DailyArrangement, now: number): boolean {
  return dailyArrangement(arrangement.playerId, now).id !== arrangement.id;
}
export function canRotateDaily(arrangement: DailyArrangement, now: number, grabInFlight: boolean): boolean {
  return !grabInFlight && needsDailyReset(arrangement, now);
}
export function validateArrangement(arrangement: DailyArrangement): void {
  const expected = dailyArrangement(arrangement.playerId, Date.parse(`${arrangement.day}T00:00:00.000Z`));
  if (expected.id !== arrangement.id || expected.seed !== arrangement.seed || expected.resetsAt !== arrangement.resetsAt) throw new Error("Invalid daily arrangement");
}
export function countdown(resetsAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((resetsAt - now) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, "0")).join(":");
}
export function loadDemoPlayer(storage: DemoStorage | null, makeId: () => string): string {
  const existing = storage?.getItem(PLAYER_STORAGE_KEY);
  if (existing && /^[a-zA-Z0-9-]{1,100}$/.test(existing)) return existing;
  const id = makeId(); storage?.setItem(PLAYER_STORAGE_KEY, id); return id;
}
export function dailyStorageKey(arrangement: DailyArrangement): string { return `${DAILY_LAYOUT_VERSION}:${arrangement.playerId}`; }
export function saveDailyPile(storage: DemoStorage, arrangement: DailyArrangement, boxes: readonly PrizeBox[]): void {
  // Persist poses and membership; prize values and odds always come from canonical box definitions.
  storage.setItem(dailyStorageKey(arrangement), JSON.stringify({ arrangementId: arrangement.id,
    boxes: boxes.map(({ id, center, rotation, grabPoint }) => ({ id, center, rotation, grabPoint })) }));
}
export function restoreDailyPile(raw: string | null, arrangement: DailyArrangement, initial: readonly PrizeBox[]): PrizeBox[] | null {
  // A 64-box pose save is about 20 KB; reject oversized local data before parsing.
  if (!raw || raw.length > 100_000) return null;
  try {
    const saved = JSON.parse(raw);
    if (saved.arrangementId !== arrangement.id || !Array.isArray(saved.boxes) || saved.boxes.length > initial.length) return null;
    const ids = new Set<string>(), byId = new Map(initial.map((box) => [box.id, box]));
    const restored: PrizeBox[] = [];
    for (const pose of saved.boxes) {
      const canonical = byId.get(pose.id);
      if (!canonical || ids.has(pose.id)) return null;
      ids.add(pose.id);
      for (const point of [pose.center, pose.grabPoint]) {
        if (!point || ![point.x, point.y, point.z].every(Number.isFinite) || Math.abs(point.x) > MACHINE.width / 2 + .02 || Math.abs(point.z) > MACHINE.depth / 2 + .02 || point.y < -.02 || point.y > MACHINE.height) return null;
      }
      const q = pose.rotation;
      if (!q || ![q.x, q.y, q.z, q.w].every(Number.isFinite) || Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) > .001) return null;
      const point = (value: { x: number; y: number; z: number }) => Object.freeze({ x: value.x, y: value.y, z: value.z });
      restored.push(Object.freeze({ ...canonical, center: point(pose.center), rotation: Object.freeze({ x: q.x, y: q.y, z: q.z, w: q.w }), grabPoint: point(pose.grabPoint) }));
    }
    return restored;
  } catch { return null; }
}
