import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const modelFingerprint = createHash("sha256").update("coupled-ev-v2").update(await readFile(new URL(import.meta.url))).update((await Promise.all(["config","pile","rewards","daily","clawGrip","prizeGrip","prizeTransport","pickupPhysics"].map(name => readFile(new URL("../components/claw/"+name+".ts",import.meta.url))))).map(x=>x.toString()).join("\n")).digest("hex").slice(0,16);
const geometryDirectory = ".next/cache/claw-ev/"+modelFingerprint+"/geometry";
await mkdir(geometryDirectory,{recursive:true});

// Reuse the actual engine, including occlusion, tilt, target selection and 240-step
// post-pickup settling. No flat-box probability substitution or static-pile draws.
async function engine(inventory) {
  const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const url = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const modules = new Map();
  // Archived 180-USDC inventory; more-twos models the adopted 186-USDC inventory.
  const proposed = [
    {count:12,cents:100,peak:.9,color:'#f5f1fa'}, {count:24,cents:150,peak:.8,color:'#f5f1fa'}, {count:12,cents:200,peak:.8,color:'#f5f1fa'},
    {count:6,cents:300,peak:.7,color:'#ee9951'}, {count:6,cents:500,peak:.55,color:'#ee9951'},
    {count:2,cents:1000,peak:.38,color:'#7950b4'}, {count:2,cents:2000,peak:.22,color:'#7950b4'},
  ];
  const comparison = proposed.map(prize => ({ ...prize,
    count: inventory === 'more-twos' ? (prize.cents === 150 ? 12 : prize.cents === 200 ? 24 : prize.count) : prize.count,
  }));
  async function module(name) {
    if (modules.has(name)) return modules.get(name);
    let source = await readFile(new URL('../components/claw/'+name+'.ts', import.meta.url), 'utf8');
    if (name === 'config' && ['proposed', 'more-twos'].includes(inventory)) {
      const pattern = /export const PRIZE_INVENTORY = Object.freeze\(\[[\s\S]*?\]\.map\(\(entry\) => Object.freeze\(entry\)\)\);/;
      assert(pattern.test(source)); source = source.replace(pattern, 'export const PRIZE_INVENTORY = Object.freeze('+JSON.stringify(comparison)+'.map(entry => Object.freeze(entry)));');
    }
    source = compile(source);
    for (const match of [...source.matchAll(/from "([^"\n]+)"/g)]) {
      const dependency = match[1], target = dependency.startsWith('./') ? await module(dependency.slice(2)) : import.meta.resolve(dependency);
      source = source.replaceAll(JSON.stringify(dependency), JSON.stringify(target));
    }
    const result = url(source); modules.set(name,result); return result;
  }
  const api = Object.assign({}, ...await Promise.all(['config','pile','rewards','daily','clawGrip','prizeGrip','prizeTransport','pickupPhysics'].map(async name => import(await module(name)))));
  const THREE = await import('three');
  const travel = api.clawTravelBounds(api.curvedJawPoints(),new THREE.Quaternion(),api.MACHINE,[api.JAW_TRAVEL_ANGLE,api.JAW_TRAVEL_ANGLE,api.JAW_TRAVEL_ANGLE]);
  api.aimBounds = {minX:Math.max(api.ARENA.minX,travel.minX),maxX:Math.min(api.ARENA.maxX,travel.maxX),minZ:Math.max(api.ARENA.minZ,travel.minZ),maxZ:Math.min(api.ARENA.maxZ,travel.maxZ)};
  return api;
}

function candidateTargets(api, boxes, tier) {
  const candidates = new Map();
  const add = point => {
    const aim = { x: Math.max(api.aimBounds.minX, Math.min(api.aimBounds.maxX, point.x)), z: Math.max(api.aimBounds.minZ, Math.min(api.aimBounds.maxZ, point.z)) };
    const target = api.selectTarget(aim, boxes, tier);
    if (target && target.probability > (candidates.get(target.box.id)?.probability ?? 0)) candidates.set(target.box.id, { ...target, aim });
  };
  for (const box of api.exposedBoxes(boxes)) add(box.grabPoint);
  // A purple's vertical column can expose a clear patch of its covering box.
  for (const box of boxes.filter(box => box.cents >= 1000)) add(box.grabPoint);
  if (!candidates.size) for (let x = 0; x <= 12; x++) for (let z = 0; z <= 12; z++) {
    add({ x: api.aimBounds.minX + x / 12 * (api.aimBounds.maxX - api.aimBounds.minX), z: api.aimBounds.minZ + z / 12 * (api.aimBounds.maxZ - api.aimBounds.minZ) });
  }
  if (!candidates.size) for (let x = 0; x <= 96; x++) for (let z = 0; z <= 96; z++) {
    add({ x: api.aimBounds.minX + x / 96 * (api.aimBounds.maxX - api.aimBounds.minX), z: api.aimBounds.minZ + z / 96 * (api.aimBounds.maxZ - api.aimBounds.minZ) });
  }
  return [...candidates.values()];
}

function chooseTarget(api, boxes, tier, policy) {
  const candidates = candidateTargets(api, boxes, tier);
  assert(candidates.length, "A non-empty pile must have a tested reachable target");
  const prizeEV = target => target.probability * target.box.cents / 100;
  const greedy = list => list.sort((a, b) => prizeEV(b) - prizeEV(a) || b.box.cents - a.box.cents || a.box.id.localeCompare(b.box.id))[0];
  if (policy === "greedy") return greedy(candidates);
  const purple = boxes.filter(box => box.cents >= 1000);
  const accessiblePurple = candidates.filter(target => target.box.cents >= 1000);
  if (accessiblePurple.length) return greedy(accessiblePurple);
  if (!purple.length) return greedy(candidates);
  const blockers = purple.map(box => api.highestSurfaceAt(box.grabPoint, boxes)?.box.id);
  const blocks = target => blockers.filter(id => id === target.box.id).length;
  const immediate = candidates.filter(target => blocks(target) > 0);
  const cost = target => api.entryPriceUsd(tier, "USDC") / target.probability - target.box.cents / 100;
  if (immediate.length) return immediate.sort((a, b) => blocks(b) - blocks(a) || cost(a) - cost(b) || a.box.id.localeCompare(b.box.id))[0];
  const distance = target => Math.min(...purple.map(box => (box.grabPoint.x - target.box.grabPoint.x) ** 2 + (box.grabPoint.z - target.box.grabPoint.z) ** 2));
  return candidates.sort((a, b) => distance(a) - distance(b) || cost(a) - cost(b) || a.box.id.localeCompare(b.box.id))[0];
}

function prefixEV(path, end, perAttemptCost) {
  let attempts = 0, entries = 0, payouts = 0;
  for (const step of path.slice(0, end)) {
    attempts += 1 / step.probability;
    entries += step.entry / step.probability;
    payouts += step.prize;
  }
  return { boxesWon: end, attempts, entries, payouts, operatingCost: attempts * perAttemptCost, houseEV: entries - payouts - attempts * perAttemptCost };
}

function fixedAttemptsEV(path, count, perAttemptCost) {
  let distribution = Array(path.length + 1).fill(0); distribution[0] = 1;
  let paidAttempts = 0, entries = 0, payouts = 0;
  for (let attempt = 0; attempt < count; attempt++) {
    const next = Array(path.length + 1).fill(0); next[path.length] = distribution[path.length];
    for (let index = 0; index < path.length; index++) {
      const { probability, entry, prize } = path[index], weight = distribution[index];
      paidAttempts += weight; entries += weight * entry; payouts += weight * probability * prize;
      next[index] += weight * (1 - probability); next[index + 1] += weight * probability;
    }
    distribution = next;
    assert(Math.abs(distribution.reduce((sum, value) => sum + value, 0) - 1) < 1e-10);
  }
  return { attemptLimit: count, paidAttempts, entries, payouts, operatingCost: paidAttempts * perAttemptCost, houseEV: entries - payouts - paidAttempts * perAttemptCost };
}

async function analyze({ seed, tier, policy, perAttemptCost, inventory }) {
  const api = await engine(inventory);
  let boxes = api.createPile(seed);
  assert.equal(boxes.filter(box => box.cents >= 1000).length, 4);
  assert.equal(api.exposedBoxes(boxes).filter(box => box.cents >= 1000).length, 0);
  const path = [], prizesById = new Map(boxes.map(box => [box.id, box.cents]));
  while (boxes.length) {
    let target;
    try { target = chooseTarget(api, boxes, tier, policy); } catch (error) {
      await writeFile(new URL('../../../docs/claw/claw-ev-unreachable-'+inventory+'-'+seed+'-'+tier+'-'+policy+'.json',import.meta.url),JSON.stringify({seed,tier,policy,inventory,path,boxes},null,2)); throw error;
    }
    const probability = target.probability;
    assert(probability > 0 && probability <= 1);
    assert.equal(api.selectTarget(target.aim, boxes, tier)?.box.id, target.box.id);
    assert.equal(target.box.cents, prizesById.get(target.box.id));
    const entry = api.entryPriceUsd(tier, "USDC"), prize = target.box.cents / 100;
    assert(probability * prize <= .95 * entry + 1e-10);
    path.push({ id: target.box.id, prize, probability, entry, exposedPurples: api.exposedBoxes(boxes).filter(box => box.cents >= 1000).length });
    const geometryKey = createHash("sha256").update(JSON.stringify([target.box.id,target.parameters.grabPoint,boxes.map(b=>[b.id,b.size,b.center,b.rotation])])).digest("hex");
    const geometryFile = geometryDirectory+"/"+geometryKey+".json";
    let poses; try { poses = JSON.parse(await readFile(geometryFile,"utf8")); } catch { /* New physical transition. */ }
    const remaining = boxes.filter(box => box.id !== target.box.id);
    if (!poses) {
      const plan = api.planPrizeGrip(target.box,boxes,target.parameters.grabPoint); assert(plan);
      const transport = api.planPrizeTransport(target.box,plan);
      const settled = api.settlePickup(remaining,transport).at(-1).boxes;
      poses = settled.map(({id,center,rotation,grabPoint})=>({id,center,rotation,grabPoint}));
      await writeFile(geometryFile,JSON.stringify(poses));
    }
    boxes = remaining.map((box,index) => { assert.equal(box.id,poses[index].id); return Object.freeze({...box,...poses[index]}); });
    assert.equal(boxes.length, 64 - path.length);
    for (const box of boxes) assert.equal(box.cents, prizesById.get(box.id));
  }
  assert.equal(path.reduce((sum, step) => sum + step.prize, 0), api.PRIZE_INVENTORY.reduce((sum, prize) => sum + prize.count * prize.cents / 100, 0));
  const firstPurple = path.findIndex(step => step.prize >= 10) + 1;
  const allPurple = path.findLastIndex(step => step.prize >= 10) + 1;
  const prefixes = path.map((_, index) => prefixEV(path, index + 1, perAttemptCost));
  return {
    inventory, seed, tier, entry: api.entryPriceUsd(tier, "USDC"), policy, layoutVersion: api.DAILY_LAYOUT_VERSION,
    prizeInventory: api.PRIZE_INVENTORY,
    startingPurpleCount: 4, startingExposedPurpleCount: 0,
    firstPurple: prefixEV(path, firstPurple, perAttemptCost),
    allPurple: prefixEV(path, allPurple, perAttemptCost),
    clearance: prefixEV(path, path.length, perAttemptCost),
    sixtyFourAttempts: fixedAttemptsEV(path, 64, perAttemptCost),
    worstSuccessPrefix: prefixes.reduce((a, b) => a.houseEV <= b.houseEV ? a : b),
    worstOnePlayEV: Math.min(...path.map(step => step.entry - step.probability * step.prize - perAttemptCost)),
    path,
  };
}

if (!isMainThread) {
  parentPort.postMessage(await analyze(workerData));
} else {
  const args = process.argv.slice(2), option = (name, fallback) => args.find(value => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
  const seeds = option("seeds", "2026,7,42").split(",").map(Number);
  const concurrency = Number(option("concurrency", "3")); assert(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 8);
  const inventories = option("inventories", "current").split(","); assert(inventories.every(value => ["current", "proposed", "more-twos"].includes(value)));
  const tiers = option("tiers", "0,1,2").split(",").map(Number);
  const policies = option("policies", "greedy,purple-hunt").split(",");
  const solUsd = Number(option("sol-usd", "108")), vrfSol = .0005, recordRentSol = .0012446;
  const extraCostUsd = Number(option("extra-cost-usd", "0"));
  assert(seeds.every(seed => Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff));
  assert(tiers.every(tier => [0, 1, 2].includes(tier)));
  assert(policies.every(policy => ["greedy", "purple-hunt"].includes(policy)));
  assert(Number.isFinite(solUsd) && solUsd > 0 && Number.isFinite(extraCostUsd) && extraCostUsd >= 0);
  const perAttemptCost = (vrfSol + recordRentSol) * solUsd + extraCostUsd;
  // Check the expectation machinery independently of the geometry/policy heuristic.
  const fixture = [{ probability: .5, entry: 2, prize: 1 }, { probability: 1, entry: 2, prize: 2 }];
  assert.equal(prefixEV(fixture, 2, .1).houseEV, 2.7);
  assert.equal(fixedAttemptsEV(fixture, 1, .1).houseEV, 1.4);
  assert.equal(fixedAttemptsEV(fixture, 2, .1).houseEV, 2.05);
  assert.equal(fixedAttemptsEV([fixture[1]], 64, .1).paidAttempts, 1, "An empty machine cannot keep charging plays");
  const tasks = inventories.flatMap(inventory => seeds.flatMap(seed => tiers.flatMap(tier => policies.map(policy => ({ inventory, seed, tier, policy, perAttemptCost })))));
  const results = [];
  const cacheDirectory = ".next/cache/claw-ev/"+modelFingerprint+"/results-"+perAttemptCost; await mkdir(cacheDirectory, {recursive:true});
  let next = 0;
  const run = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      const cacheFile = cacheDirectory+'/'+task.inventory+'-'+task.seed+'-'+task.tier+'-'+task.policy+'.json';
      let result; try { result = JSON.parse(await readFile(cacheFile,'utf8')); } catch { /* Fresh deterministic path. */ }
      if (!result) result = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: task });
        worker.once("message", resolve); worker.once("error", error => reject(new Error(JSON.stringify(task)+": "+error.message)));
        worker.once("exit", code => { if (code !== 0) reject(new Error(`EV worker exited ${code}`)); });
      });
      await writeFile(cacheFile,JSON.stringify(result,null,2)+"\n");
      results.push(result);
      console.log(JSON.stringify({ inventory: result.inventory, seed: result.seed, entry: result.entry, policy: result.policy,
        ev64: result.sixtyFourAttempts.houseEV, evClear: result.clearance.houseEV,
        evFirstPurple: result.firstPurple.houseEV, evAllPurple: result.allPurple.houseEV,
        attemptsClear: result.clearance.attempts, paidBoxesBeforeFirstPurple: result.firstPurple.boxesWon - 1,
        worstSuccessPrefixEV: result.worstSuccessPrefix.houseEV, worstOnePlayEV: result.worstOnePlayEV }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, run));
  results.sort((a, b) => a.inventory.localeCompare(b.inventory) || a.seed - b.seed || a.tier - b.tier || a.policy.localeCompare(b.policy));
  assert.equal(new Set(results.map(result => result.layoutVersion)).size, 1, "Do not mix different layout rules in one analysis");
  const report = { modelFingerprint, generatedAt: new Date().toISOString(), solUsd, vrfSol, recordRentSol, extraCostUsd, perAttemptCost,
    layoutVersion: results[0].layoutVersion,
    method: "Exact geometric waiting-time and finite-horizon Markov expectations along deterministic success-removal paths using the current physics engine.",
    limitations: "Specified aiming/clearing heuristics on sampled layouts, not a global optimal-strategy proof or a population EV. Uses current compact travel bounds and collision-coupled extraction. Proposed inventory retains the corresponding base probability peaks. Excludes network/API fees unless extra-cost-usd is supplied and excludes deployment rent. Early stopping after arbitrary loss counts is not modeled.",
    results };
  const out = option("out", fileURLToPath(new URL("../../../docs/claw/claw-ev-results.json", import.meta.url)));
  await writeFile(out, JSON.stringify(report, null, 2) + "\n");
  console.log(`Saved ${results.length} evaluated paths to ${out}`);
}
