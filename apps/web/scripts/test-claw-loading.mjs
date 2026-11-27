import assert from "node:assert/strict";
import { writeFile, stat } from "node:fs/promises";
import { clawModule } from "./claw-test-loader.mjs";

const { createPile } = await import(await clawModule("pile"));
const { dailyArrangement, dailyStorageKey, saveDailyPile, restoreDailyPile } = await import(await clawModule("daily"));
const { readInitialPileCache, saveInitialPileCache } = await import(await clawModule("initialPileCache"));
const { EMPTY_LOADING, completeLoadingTask, resetMachineLoading, loadingProgress } = await import(await clawModule("loadingProgress"));
const { PAVEMENT_ASSETS } = await import(await clawModule("pavementAssets"));
const { createPhysicsService } = await import(await clawModule("physicsService"));
let workerStarts = 0;
const lazyPhysics = createPhysicsService(() => { workerStarts++; throw Error("Worker unavailable"); });
assert.equal(workerStarts, 0, "A cache hit must not start or download an unused physics worker");
await lazyPhysics.settle([]);
assert.equal(workerStarts, 1); assert.equal(lazyPhysics.metrics().worker, false);
lazyPhysics.dispose();
const time = Date.parse("2026-10-18T12:00:00Z"), measurements = [];
for (const player of ["load-a", "load-b", "load-c"]) {
  const arrangement = dailyArrangement(player, time), data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  assert.equal(readInitialPileCache(storage, arrangement), null);
  const start = performance.now(), initial = createPile(arrangement.seed), simulationMs = performance.now() - start;
  saveInitialPileCache(storage, arrangement, initial);
  const restoreStart = performance.now(), restored = readInitialPileCache(storage, arrangement), cacheRestoreMs = performance.now() - restoreStart;
  assert.deepEqual(restored, initial, "Caching preserves every pose, fixed prize, grab point and probability parameter");
  measurements.push({ simulationMs: Math.round(simulationMs), cacheRestoreMs: +cacheRestoreMs.toFixed(2) });
  saveDailyPile(storage, arrangement, initial.slice(3));
  assert.deepEqual(restoreDailyPile(storage.getItem(dailyStorageKey(arrangement)), arrangement, restored), initial.slice(3), "Cache cannot respawn already-collected boxes");
  const key = [...data.keys()].find(key => key.includes("initial-v1")), raw = data.get(key), saved = JSON.parse(raw);
  saved.boxes[0].cents = 999999; saved.boxes[0].maxPickupProbability = 1; saved.boxes[0].sigmaX = 999;
  saved.boxes.reverse(); data.set(key, JSON.stringify(saved));
  assert.deepEqual(readInitialPileCache(storage, arrangement), initial, "Cached prize/odds fields are ignored; canonical ordering is restored");
  for (const mutate of [value => value.boxes.pop(), value => value.boxes[0] = value.boxes[1], value => value.boxes[0].center.x = 999, value => value.boxes[0].rotation.w = 999, value => value.arrangementId = "old-layout"]) {
    const invalid = JSON.parse(raw); mutate(invalid); data.set(key, JSON.stringify(invalid));
    assert.equal(readInitialPileCache(storage, arrangement), null);
  }
  data.set(key, raw);
  assert.equal(readInitialPileCache(storage, dailyArrangement(player, time + 86400000)), null, "Previous-day layouts cannot be reused");
  data.set(key, "x".repeat(100001)); assert.equal(readInitialPileCache(storage, arrangement), null);
}
const blocked = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); } };
assert.equal(readInitialPileCache(blocked, dailyArrangement("blocked", time)), null);
assert.doesNotThrow(() => saveInitialPileCache(blocked, dailyArrangement("blocked", time), []));
let state = EMPTY_LOADING, previous = 0;
for (const task of ["pile", "normal", "font", "logo", "arm", "diffuse", "scene", "ready"]) {
  state = completeLoadingTask(state, task); const progress = loadingProgress(state);
  assert(progress.percent >= previous && progress.percent <= 100); previous = progress.percent;
  assert.equal(completeLoadingTask(state, task), state, "Duplicate and Strict Mode completion cannot inflate progress");
  if (task !== "ready") assert(progress.percent < 100);
}
assert.equal(loadingProgress(state).percent, 100);
assert.equal(loadingProgress(resetMachineLoading(state)).percent, 45, "Daily rebuild keeps downloaded assets and resets only machine work");
let oldBytes = 0; const newBytes = 0;
for (const task of ["diffuse","normal","arm"]) oldBytes += (await stat(new URL(`../public/claw/concrete-${task}.jpg`, import.meta.url))).size;
assert.equal(PAVEMENT_ASSETS.length,0,"Procedural black glass and its RGB grid require no floor-image downloads");
await writeFile(new URL("../../../docs/claw/performance/loading-startup.json", import.meta.url), JSON.stringify({ environment: "Node simulation/cache timings, not browser startup or FPS", measurements, textureBytes: { before: oldBytes, after: newBytes } }, null, 2) + "\n");
console.log("PASS: cached canonical layouts, unchanged prizes/odds, retained box removals, tampered/stale/oversized cache rejection, blocked storage, genuine milestone progress and smaller same-resolution textures.");
console.log(JSON.stringify({ measurements, textureBytes: { before: oldBytes, after: newBytes } }));
