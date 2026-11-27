import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const text = await readFile(new URL("../components/claw/rewards.ts", import.meta.url), "utf8");
const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const configUrl = dataUrl(compile(await readFile(new URL("../components/claw/config.ts", import.meta.url), "utf8")));
const { MACHINE, ARENA, POCKET, PILE_LAYOUT, OPERATING_MARGIN, PRIZE_INVENTORY, ENTRY_USD } = await import(configUrl);
const withConfig = (source) => source.replaceAll('"./config"', JSON.stringify(configUrl));
const pileText = await readFile(new URL("../components/claw/pile.ts", import.meta.url), "utf8");
const pileUrl = dataUrl(withConfig(compile(pileText)).replace('"cannon-es"', JSON.stringify(import.meta.resolve("cannon-es"))));
const dailyText = await readFile(new URL("../components/claw/daily.ts", import.meta.url), "utf8");
const dailyUrl = dataUrl(withConfig(compile(dailyText)));
const { dailyArrangement, needsDailyReset, canRotateDaily, validateArrangement, countdown, loadDemoPlayer, dailyStorageKey, saveDailyPile, restoreDailyPile } = await import(dailyUrl);
const compiled = withConfig(compile(text)).replaceAll('"./pile"', JSON.stringify(pileUrl)).replaceAll('"./daily"', JSON.stringify(dailyUrl));
const { createPile, boxTop, upwardFaceGripFactor, settlePile, highestSurfaceAt, exposedBoxes, parametersFor, pickupProbability, selectTarget, startingAim, entryPriceUsd, marginCappedPeak, seededRandom, resolvePull, createPickupProvider, simulatePickups, RULES_VERSION } = await import(dataUrl(compiled));
const stack = createPile(), top = exposedBoxes(stack);
assert.equal(stack.length, MACHINE.boxCount); assert.equal(MACHINE.boxCount, 64); assert(top.length > 0 && top.length < MACHINE.boxCount, "A mound has both exposed and buried boxes");
assert.deepEqual(stack, createPile(), "The loading seed must reproduce the same settled geometry");
assert.notDeepEqual(stack, createPile(7), "Another loading seed must change the mound");
assert.equal(OPERATING_MARGIN, .05);
assert.equal(MACHINE.clawMargin, .15, "Visual jaw geometry cannot narrow the original aiming range");
assert.deepEqual(ENTRY_USD, { USDC: [2, 4, 6] });
assert.deepEqual(PRIZE_INVENTORY.map(({count,cents}) => [count,cents]), [[12,100],[12,150],[24,200],[6,300],[6,500],[2,1000],[2,2000]], "Exact requested 64-box distribution");
for (const pile of [stack, createPile(7)]) {
  assert.equal(pile.reduce((sum, b) => sum + b.cents, 0), 18600);
  for (const prize of PRIZE_INVENTORY) {
    assert.equal(pile.filter((b) => b.cents === prize.cents && b.color === prize.color).length, prize.count);
  }
}
assert(Math.abs(marginCappedPeak(1, 2500, 1.5) - .057) < 1e-12);
assert.equal(marginCappedPeak(.2, 50, 2), .2, "The margin ceiling never raises existing odds");
for (const args of [[1, 0, 2], [1, 25.5, 2], [1, 2500, 0], [1, 2500, NaN], [1, 2500, 2, -.01], [1, 2500, 2, 1.01]]) assert.throws(() => marginCappedPeak(...args));
assert.throws(() => entryPriceUsd(3, "USDC")); assert.throws(() => entryPriceUsd(0, "OTHER")); assert.throws(() => entryPriceUsd(0, "CATO"));
const resetBoundary = Date.parse("2026-10-10T23:59:00.000Z");
const alice = dailyArrangement("alice", resetBoundary - 1), bob = dailyArrangement("bob", resetBoundary - 1);
assert.equal(alice.day, "2026-10-10"); assert.equal(alice.resetsAt, resetBoundary);
assert.deepEqual(alice, dailyArrangement("alice", Date.parse("2026-10-10T06:00:00+05:30")), "Same UTC day ignores local timezone");
assert.notEqual(alice.seed, bob.seed, "Different players receive different loading seeds");
assert.notEqual(alice.seed, dailyArrangement("alice", resetBoundary).seed, "23:59 UTC starts a new personal arrangement");
assert.equal(dailyArrangement("alice", resetBoundary).day, "2026-10-11");
assert.deepEqual(dailyArrangement("alice", resetBoundary), dailyArrangement("alice", Date.parse("2026-10-11T00:00:00Z")), "Midnight must not trigger a second reset");
assert.equal(needsDailyReset(alice, resetBoundary - 1), false); assert.equal(needsDailyReset(alice, resetBoundary), true);
assert.equal(canRotateDaily(alice, resetBoundary, true), false, "A grab crossing the reset boundary must finish first");
assert.equal(canRotateDaily(alice, resetBoundary, false), true, "Rotate immediately after the locked grab finishes");
assert.equal(canRotateDaily(alice, resetBoundary + 3 * 86400000, false), true, "Sleeping tabs skip missed days");
assert.equal(dailyArrangement("alice", Date.parse("2028-02-29T23:58:59.999Z")).resetsAt, Date.parse("2028-02-29T23:59:00Z"));
assert.equal(countdown(resetBoundary, resetBoundary - 1000), "00:00:01"); assert.equal(countdown(resetBoundary, resetBoundary + 1), "00:00:00");
validateArrangement(alice); assert.throws(() => validateArrangement({ ...alice, seed: alice.seed ^ 1 }));
const memory = new Map(), storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
let identities = 0;
assert.equal(loadDemoPlayer(storage, () => { identities++; return "player-one"; }), "player-one");
assert.equal(loadDemoPlayer(storage, () => { identities++; return "player-two"; }), "player-one"); assert.equal(identities, 1);
const remaining = stack.slice(1);
saveDailyPile(storage, alice, remaining);
const persisted = storage.getItem(dailyStorageKey(alice));
assert.deepEqual(restoreDailyPile(persisted, alice, stack), remaining, "Refresh preserves membership, poses, and grab points");
assert.equal(restoreDailyPile(persisted, bob, stack), null, "One player's progress cannot populate another pile");
assert.equal(restoreDailyPile(persisted, dailyArrangement("alice", resetBoundary), stack), null, "Yesterday's state cannot populate today's pile");
const corrupted = JSON.parse(persisted);
corrupted.boxes[0].cents = 99999999; corrupted.boxes[0].maxPickupProbability = 1;
assert.equal(restoreDailyPile(JSON.stringify(corrupted), alice, stack)[0].cents, stack[1].cents, "Stored prize values are ignored");
corrupted.boxes[0].rotation.w = 100; assert.equal(restoreDailyPile(JSON.stringify(corrupted), alice, stack), null);
assert.equal(restoreDailyPile("bad JSON", alice, stack), null);
assert.equal(restoreDailyPile(" ".repeat(100001), alice, stack), null, "Oversized storage is rejected before parsing");
const duplicate = JSON.parse(persisted); duplicate.boxes[1] = duplicate.boxes[0];
assert.equal(restoreDailyPile(JSON.stringify(duplicate), alice, stack), null, "Duplicate box IDs cannot restore duplicate prizes");
const extra = JSON.parse(persisted); extra.boxes[0].center.untrusted = "discard";
assert.equal(restoreDailyPile(JSON.stringify(extra), alice, stack)[0].center.untrusted, undefined, "Unknown stored pose fields are not copied");
saveDailyPile(storage, alice, []); assert.deepEqual(restoreDailyPile(storage.getItem(dailyStorageKey(alice)), alice, stack), [], "An empty machine stays empty until reset");
const alicePile = createPile(alice.seed), bobPile = createPile(bob.seed);
assert.notDeepEqual(alicePile, bobPile, "Personal seeds produce different physical piles");
assert.deepEqual(alicePile, createPile(alice.seed), "A personal day's starting pile is repeatable");
const layoutFixtures = [stack, alicePile, bobPile, ...[0, 1, 42, 0xffffffff].map(seed => createPile(seed))];
for (const pile of layoutFixtures) {
  const purple = pile.filter(box => box.cents >= PILE_LAYOUT.coveredPrizeMinCents);
  const reachable = new Set(exposedBoxes(pile).map(box => box.id));
  assert.equal(purple.length, 4, "The placement rule preserves the four purple prizes");
  assert(purple.every(box => !reachable.has(box.id)), "Every purple starts physically occluded");
  assert(pile.some(box => reachable.has(box.id) && box.cents < PILE_LAYOUT.coveredPrizeMinCents), "The covering pile remains playable");
  assert(selectTarget(startingAim(pile), pile, 0), "The initial claw position must use a reachable surface even when the center is blocked");
  assert.equal(pile.reduce((sum, box) => sum + box.cents, 0), 18600);
}
assert(layoutFixtures.some(pile => pile.some(box => box.cents >= PILE_LAYOUT.coveredPrizeMinCents && box.center.y > MACHINE.height * .25)), "Purple prizes also appear above the bottom quarter");
const reachableAim = point => ({x: Math.max(ARENA.minX, Math.min(ARENA.maxX, point.x)), z: Math.max(ARENA.minZ, Math.min(ARENA.maxZ, point.z))});
const originalPurple = stack.filter(box => box.cents >= PILE_LAYOUT.coveredPrizeMinCents);
let uncoveredPurple = settlePile(originalPurple).at(-1);
while (uncoveredPurple.length) {
  for (const box of uncoveredPurple) assert.equal(box.cents, originalPurple.find(original => original.id === box.id).cents, "Settling never changes a fixed prize");
  const target = exposedBoxes(uncoveredPurple).map(box => selectTarget(reachableAim(box.grabPoint), uncoveredPurple, 0)).find(Boolean);
  assert(target?.box.cents >= 1000, "Once uncovered, purple boxes can be picked normally until all four are collected");
  uncoveredPurple = settlePile(uncoveredPurple.filter(box => box.id !== target.box.id)).at(-1);
}
const legacyLayout = JSON.parse(persisted);
legacyLayout.arrangementId = alice.id.replace("v8-more-two-usdc-prizes", "v7-rebalanced-prizes");
assert.equal(restoreDailyPile(JSON.stringify(legacyLayout), alice, stack), null, "Previous reward inventories cannot restore into the rebalanced machine");
function assertClearPocket(boxes) {
  for (let ix = 0; ix <= 10; ix++) for (let iz = 0; iz <= 10; iz++) {
    const point = { x: POCKET.minX + .025 + ix * (POCKET.maxX - POCKET.minX - .05) / 10,
      z: POCKET.minZ + .025 + iz * (POCKET.maxZ - POCKET.minZ - .05) / 10 };
    assert.equal(highestSurfaceAt(point, boxes), null, "Rotated boxes must not overhang the reserved prize pocket");
  }
}
for (const pile of [stack, alicePile, bobPile]) assertClearPocket(pile);
const pocketAim = reachableAim({ x: (POCKET.minX + POCKET.maxX) / 2, z: (POCKET.minZ + POCKET.maxZ) / 2 });
assert.equal(selectTarget(pocketAim, stack, 2), null, "Aiming into the delivery bay cannot pick through its dividers");
for (const frame of settlePile(stack.filter((box) => box.id !== top[0].id))) assertClearPocket(frame);
for (const b of [...stack, ...alicePile, ...bobPile]) {
  assert(b.center.y - (boxTop(b) - b.center.y) >= MACHINE.floorY - .015, "Boxes stay above the floor");
  const { x, y, z, w } = b.rotation, half = b.size / 2;
  const extentX = half * (Math.abs(1 - 2 * (y * y + z * z)) + Math.abs(2 * (x * y - z * w)) + Math.abs(2 * (x * z + y * w)));
  const extentZ = half * (Math.abs(2 * (x * z - y * w)) + Math.abs(2 * (y * z + x * w)) + Math.abs(1 - 2 * (x * x + y * y)));
  assert(Math.abs(b.center.x) + extentX <= MACHINE.width / 2 + .015 && Math.abs(b.center.z) + extentZ <= MACHINE.depth / 2 + .015, "Rotated boxes stay inside the narrower collision walls");
  assert(boxTop(b) < MACHINE.height - .9, "The dense pile leaves room for the claw to lift");
  assert(Math.abs(Math.hypot(b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w) - 1) < 1e-9);
}
const box = { ...stack[1], id: "FIXTURE", cents: 100, maxPickupProbability: .8, center: { x: 0, y: .26, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, grabPoint: { x: 0, y: .5, z: 0 } };
const aim = { x: 0, z: 0 }, alignedBoxes = [box];
// Check every canonical box, every USDC tier at flat perfect aim,
// actual settled tilt, and offset aim; even maximum lab overrides obey the cap.
for (const b of stack) for (let tier = 0; tier < 3; tier++) for (const currency of ["USDC"]) {
  const price = entryPriceUsd(tier, currency), budget = (1 - OPERATING_MARGIN) * price;
  for (const pose of [b, { ...b, rotation: box.rotation }]) {
    const p = parametersFor(pose, tier, { [b.id]: { maxPickupProbability: 1, exposure: 1, gripSuitability: 1 } }, currency);
    for (const a of [p.grabPoint, { x: p.grabPoint.x + .1, z: p.grabPoint.z - .1 }]) {
      const payoutEV = pickupProbability(a, p) * b.cents / 100;
      assert(payoutEV <= budget + 1e-12, "Aim, tilt, tuning and tier cannot bypass the currency's 5% gross margin");
    }
  }
}
const purple = { ...box, cents: 2000, maxPickupProbability: .22 };
const usdcPurple = selectTarget(aim, [purple], 0, {}, "USDC");
assert(Math.abs(usdcPurple.probability - .095) < 1e-12);
for (let tier = 0; tier < 3; tier++) {
  const p = parametersFor(box, tier);
  assert.equal(pickupProbability(aim, p), p.maxPickupProbability);
  assert(Math.abs(pickupProbability({ x: aim.x + p.sigmaX, z: aim.z }, p) - p.maxPickupProbability * Math.exp(-.5)) < 1e-12);
  assert.equal(pickupProbability({ x: aim.x + p.maxReach + .0001, z: aim.z }, p), 0);
  assert.equal(pickupProbability(aim, { ...p, exposure: .5, gripSuitability: .5 }), p.maxPickupProbability * .25);
  for (const overrides of [{ sigmaX: 0 }, { sigmaZ: -1 }, { sigmaX: NaN }, { maxReach: -1 }, { maxPickupProbability: 1.1 }]) assert.throws(() => pickupProbability(aim, { ...p, ...overrides }));
}
assert(parametersFor(box, 2).sigmaX > parametersFor(box, 0).sigmaX);
const upper = { ...box, id: "UPPER", center: { x: 0, y: .74, z: 0 }, grabPoint: { x: 0, y: .98, z: 0 } };
assert.deepEqual(exposedBoxes([box, upper]).map((b) => b.id), ["UPPER"]);
assert.equal(selectTarget(aim, [box, upper], 0).box.id, "UPPER");
assert.equal(selectTarget(aim, [box], 0).box.id, "FIXTURE");
assert.equal(highestSurfaceAt(aim, [box, upper]).y, .98);
assert.equal(highestSurfaceAt({ x: 1, z: 1 }, [box, upper]), null);
// Surface eligibility is a box-area rule, not a visual-arm penalty or odds multiplier.
assert.equal(selectTarget({ x: .30, z: 0 }, [box], 0), null, "Empty space inside maxReach must not snap to a nearby prize");
const low = { ...box, id: "LOW-IN-GAP" };
const walls = [[.46, 0], [-.46, 0], [0, .46], [0, -.46]].map(([x, z], i) => ({
  ...box, id: 'HIGH-' + i, center: { x, y: 1.22, z }, grabPoint: { x, y: 1.46, z }
}));
assert(exposedBoxes([low, ...walls]).some(candidate => candidate.id === low.id), "A pinhole-clear grab point reproduces the old loophole");
assert.equal(highestSurfaceAt(aim, [low, ...walls]).box.id, low.id);
assert.equal(selectTarget(aim, [low, ...walls], 0), null, "A lower box in a narrow deep slot is not grabbable");
assert.equal(selectTarget(aim, [low], 0).box.id, low.id, "Removing blockers restores reachability without raising its odds");
const shallowNeighbors = walls.map(candidate => ({ ...candidate, center: { ...candidate.center, y: .46 }, grabPoint: { ...candidate.grabPoint, y: .70 } }));
assert.equal(selectTarget(aim, [low, ...shallowNeighbors], 0).box.id, low.id, "Small height differences remain forgiving");
const highBeside = { ...upper, id: "HIGH-BESIDE", center: { x: .8, y: 1.22, z: 0 }, grabPoint: { x: .8, y: 1.46, z: 0 } };
assert.equal(selectTarget(aim, [low, highBeside], 0).box.id, low.id, "An accessible lower outer box is allowed; this is not a global top-layer restriction");
for (const tier of [0, 1, 2]) {
  const eligible = selectTarget(aim, [low], tier);
  assert.equal(eligible.probability, pickupProbability(aim, parametersFor(low, tier)), "Grab-area eligibility adds no probability penalty");
  assert.equal(selectTarget(aim, [low, ...walls], tier), null, "A more expensive token cannot reach through a blocker");
}
const fallen = settlePile([upper]).at(-1)[0];
assert(Math.abs(fallen.center.y - .26) < .015, "Unsupported boxes fall after removal");
assert.equal(fallen.id, upper.id); assert.equal(fallen.cents, upper.cents);
const tilted = { ...box, rotation: { x: 0, y: 0, z: Math.sin(Math.PI / 8), w: Math.cos(Math.PI / 8) } };
assert(Math.abs(boxTop(tilted) - (.26 + .24 * Math.SQRT2)) < 1e-12);
assert(Math.abs(highestSurfaceAt(aim, [tilted]).y - boxTop(tilted)) < 1e-12, "Ray hits rotated geometry");
// World face normals, not Euler angles: a different face becomes the top
// after a quarter turn. Yaw never changes the inclination of a flat top.
for (const axis of ["x", "z"]) for (const [degrees, expected] of [[0, 1], [30, .75], [45, .5], [60, .75], [90, 1], [180, 1]]) {
  const radians = degrees * Math.PI / 180;
  const rotated = { ...box, rotation: { x: 0, y: 0, z: 0, w: Math.cos(radians / 2), [axis]: Math.sin(radians / 2) } };
  assert(Math.abs(upwardFaceGripFactor(rotated) - expected) < 1e-12, `${axis} ${degrees}° must use the most upward-facing surface`);
  for (let tier = 0; tier < 3; tier++) {
    const p = parametersFor(rotated, tier, { [box.id]: { exposure: .8, gripSuitability: .6 } });
    assert(Math.abs(pickupProbability(aim, p) - p.maxPickupProbability * .8 * .6 * expected) < 1e-12, "Tilt multiplies the base grip once in every bet tier");
    assert.equal(pickupProbability({ x: p.maxReach + .01, z: 0 }, p), 0, "Tilt cannot bypass maximum reach");
  }
}
const yawed = { ...box, rotation: { x: 0, y: Math.sin(.37), z: 0, w: Math.cos(.37) } };
assert.equal(upwardFaceGripFactor(yawed), 1, "World Y yaw does not make a flat top harder");
const cornerUp = { ...box, rotation: { x: Math.sin(Math.PI / 8), y: 0, z: Math.sin(Math.PI / 8), w: Math.sqrt(1 - 2 * Math.sin(Math.PI / 8) ** 2) } };
assert(upwardFaceGripFactor(cornerUp) < upwardFaceGripFactor(tilted), "Compound rotation can tilt all candidate faces further");
for (const b of stack) {
  const factor = upwardFaceGripFactor(b);
  assert(factor >= 1 / 3 - 1e-12 && factor <= 1, "A cube always has a face at least partly facing up");
  assert(Math.abs(parametersFor(b, 0).gripSuitability - factor) < 1e-12);
}
assert.equal(parametersFor(fallen, 0).gripSuitability, upwardFaceGripFactor(fallen), "Settled poses get a fresh factor for subsequent grabs");
for (const b of top) {
  const hit = highestSurfaceAt(b.grabPoint, stack);
  assert(!hit || hit.y <= b.grabPoint.y + .035, "Exposed grab points have an unobstructed descent");
}
assert.equal(selectTarget({ x: ARENA.maxX, z: ARENA.maxZ }, alignedBoxes, 0), null);
assert.throws(() => selectTarget({ x: ARENA.maxX + .01, z: 0 }, stack, 0), "Movement obeys the narrower arena limits");
const target = selectTarget(aim, alignedBoxes, 0);
const pull = Object.freeze({ id: "one-close-one-roll", rulesVersion: RULES_VERSION, aim, target, tier: 0, currency: "USDC", priceUsd: 2, arrangement: alice });
// Exercise the actual scene draw boundary without a browser/WebGL renderer.
// A blocked presentation rig must not change a frozen attempt or its single draw.
const machineText = await readFile(new URL("../components/claw/createMachine.ts", import.meta.url), "utf8");
const machineAst = ts.createSourceFile("createMachine.ts", machineText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
let requestDrawNode;
function findDraw(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === "requestDraw") requestDrawNode = node; ts.forEachChild(node, findDraw); }
findDraw(machineAst);assert(requestDrawNode);
const drawCode = compile(requestDrawNode.getText(machineAst));
for (const workerSettlement of [false, true, "prefetched"]) for (const roll of [target.probability - 1e-8, target.probability + 1e-8]) {
  const locked = Object.freeze({ ...pull, id: "renderer-independent-" + roll });
  const signature = JSON.stringify(locked), sent = [], attaches = [], errors = [], pileUpdates = [];let draws = 0;
  const rolls = createPickupProvider(() => { draws++; return roll; });
  const visual = { get gripping() { throw new Error("Renderer contact cannot determine odds"); }, update() { throw new Error("Renderer cannot veto a locked draw"); } };
  const other = { ...box, id: "OTHER" };
  const renderedBox = { position: { copy() {} } };
  let releaseSettlement, settlementJobs = 0;
  const context = { pull: locked, drawRequested: false, disposed: false, mode: "animating", waitingStart: 0, dropStart: 0,
    gripPlan: {}, transport: null, pickupFrames: null, pickupPlanning: null, planPrizeTransport: () => ({}), setup: workerSettlement ? { pickup: remaining => { settlementJobs++; return new Promise(done => { releaseSettlement = () => done([{atMs:0,boxes:remaining}]); }); } } : {}, clawModel: visual, picked: renderedBox, boxes: [box, other], result: null, settlement: null, settlementStart: 0,
    resolve: attempt => { sent.push(attempt); return rolls.resolve(attempt); }, phase() {}, performance: { now: () => 100 },
    claw: { attach: object => attaches.push(object) }, scene: { attach() {} }, original: {},
    settlePickup: remaining => [{atMs:0,boxes:remaining}], onPileChanged: remaining => pileUpdates.push(remaining), onError: error => errors.push(error),
    pickupProbability() { throw new Error("Presentation cannot recalculate the locked probability"); },
  };
  if (workerSettlement === "prefetched") context.pickupPlanning = context.setup.pickup([other]).then(frames => ({ transport: {}, frames }));
  const boundary = runInNewContext(drawCode + "\n({requestDraw, state:()=>({pull,result,boxes,mode})})", context);
  boundary.requestDraw(50);boundary.requestDraw(51);
  await new Promise(done => setImmediate(done));
  if (workerSettlement && (roll < locked.target.probability || workerSettlement === "prefetched")) {
    assert.equal(boundary.state().mode, roll < locked.target.probability ? "waiting" : "animating"); assert.equal(attaches.length, 0); assert.equal(settlementJobs, 1);
    boundary.requestDraw(52); releaseSettlement(); await new Promise(done => setImmediate(done));
    assert.equal(settlementJobs, 1, "Delayed physics cannot duplicate the job or reroll the draw");
  }
  assert.deepEqual(errors, []);assert.equal(sent.length, 1);assert.strictEqual(sent[0], locked);
  assert.strictEqual(boundary.state().pull, locked);assert.equal(JSON.stringify(locked), signature);
  assert.equal(draws, 1, "Blocked renderer cannot cancel a valid roll or cause a reroll");
  assert.equal(boundary.state().result.probability, locked.target.probability);
  assert.equal(boundary.state().result.success, roll < locked.target.probability);
  assert.equal(attaches.length, Number(roll < locked.target.probability), "Box attachment follows the single authoritative result");
  assert.equal(pileUpdates.length, attaches.length);assert.equal(boundary.state().mode, "animating");
}
console.log("PASS: visual jaw contacts cannot alter locked odds, single draw, win/miss results or payout; original aim range restored.");
let invalidSnapshotDraws = 0;
const unexpectedDraw = () => { invalidSnapshotDraws++; return 0; };
for (const probability of [NaN, Infinity, -Infinity, -1, 2, "0.8", null, undefined]) {
  assert.throws(() => resolvePull({ ...pull, target: { ...target, probability } }, unexpectedDraw), "Malformed snapshot odds fail before the draw");
}
for (const id of [0, "", " ", "x".repeat(101)]) {
  assert.throws(() => resolvePull({ ...pull, id }, unexpectedDraw));
  assert.throws(() => resolvePull({ ...pull, target: { ...target, box: { ...target.box, id } } }, unexpectedDraw));
}
assert.throws(() => resolvePull({ ...pull, target: { ...target, probability: target.probability / 2 } }, unexpectedDraw));
assert.equal(invalidSnapshotDraws, 0, "Invalid odds and identities cannot consume or cache a random draw");
const purplePull = { ...pull, id: "usdc-purple", target: usdcPurple };
assert.equal(resolvePull(purplePull, () => .05).cents, 2000, "The margin does not deduct from a winning prize");
let invalidEntryDraws = 0;
assert.throws(() => resolvePull({ ...purplePull, currency: "CATO", priceUsd: 1.5 }, () => { invalidEntryDraws++; return .01; }));
assert.throws(() => resolvePull({ ...purplePull, priceUsd: 3 }, () => { invalidEntryDraws++; return .01; }));
assert.throws(() => resolvePull({ ...purplePull, rulesVersion: "cato-position-pickup-demo-v8-usdc-top-view" }, () => { invalidEntryDraws++; return .01; }));
assert.equal(invalidEntryDraws, 0, "Removed currencies, incorrect prices and obsolete rules are rejected before drawing");
const tiltedTarget = selectTarget(aim, [tilted], 0);
const tiltedPull = Object.freeze({ ...pull, id: "locked-tilt", target: tiltedTarget });
assert(Object.isFrozen(tiltedTarget.parameters), "The pose-derived grip is frozen with the target");
// Model transport making the box upright. The pending grab retains its lower
// probability, while a new grab at the upright pose receives the flat factor.
const transportPose = { ...tiltedTarget.box, rotation: box.rotation };
assert(pickupProbability(aim, parametersFor(transportPose, 0)) > tiltedTarget.probability);
const midwayRoll = (target.probability + tiltedTarget.probability) / 2;
assert.equal(resolvePull(tiltedPull, () => midwayRoll).success, false, "Transport must not re-evaluate tilted odds as flat odds");
assert.equal(resolvePull(pull, () => midwayRoll).success, true);
let tiltedCalls = 0;
const tiltedProvider = createPickupProvider(() => { tiltedCalls++; return midwayRoll; });
const lockedTiltResult = await tiltedProvider.resolve(tiltedPull);
assert.strictEqual(await tiltedProvider.resolve(tiltedPull), lockedTiltResult);
assert.equal(tiltedCalls, 1, "Animation/retry must not roll again for a tilted target");
let calls = 0; const provider = createPickupProvider(() => { calls++; return .1; });
const first = await provider.resolve(pull), retry = await provider.resolve(pull);
assert.strictEqual(first, retry); assert.equal(calls, 1); assert.equal(first.success, true); assert.equal(first.cents, box.cents);
await assert.rejects(provider.resolve({ ...pull, tier: 1, priceUsd: 4 }));
await assert.rejects(provider.resolve({ ...pull, arrangement: bob }));
assert.throws(() => resolvePull({ ...pull, arrangement: { ...alice, seed: alice.seed ^ 1 } }, () => .1));
assert.equal(resolvePull({ ...pull, id: "miss" }, () => .99).success, false);
assert.equal(resolvePull({ ...pull, target: { ...target, parameters: { ...target.parameters, maxPickupProbability: 0 }, probability: 0 } }, () => 0).success, false);
assert.equal(resolvePull({ ...pull, target: null }, () => { throw new Error("Empty grabs must not draw"); }).roll, null);
for (const roll of [NaN, -1, 1]) assert.throws(() => resolvePull(pull, () => roll));
const a = seededRandom(42), b = seededRandom(42); for (let i = 0; i < 1000; i++) { const roll = a(); assert.equal(roll, b()); assert(roll >= 0 && roll < 1); }
let hits = 0; const random = seededRandom(42); for (let i = 0; i < 100000; i++) if (resolvePull(pull, random).success) hits++;
assert(Math.abs(hits / 100000 - target.probability) < .006, "Observed rate should match the configured peak");
assert.doesNotThrow(() => simulatePickups(42, 1000, stack, 0, {}, "aligned"), "Aligned debugging aims stay within the original arena");
const sim = simulatePickups(42, 10000, stack, 0, {}, "random");
assert.deepEqual(sim, simulatePickups(42, 10000, stack, 0, {}, "random"));
assert(Math.abs(sim.observedRate - sim.expectedRate) <= sim.tolerance);
console.log("PASS: tumbled geometry, seeded pile reproduction, rotated ray hits, occlusion, settling, alignment, Gaussian offsets, reach, modifiers, bet tiers, one-roll retries.");
console.log("PASS: narrower/taller pile, four purple prizes at varied covered depths across seven seeded layouts, natural access after uncovering, fixed prizes and old-layout invalidation.");
console.log("PASS: world-facing tilt factors, flat quarter turns, yaw, compound tilt, base grip tuning, all bet tiers, locked orientation odds and single-roll retries.");
console.log("PASS: 48/12/4 color tiers, $186 inventory, USDC-only prices, 5% gross margin across every prize/tier/currency/pose, override limits, locked cap validation and full fixed payouts.");
console.log("PASS: USDC-only prices and validation, unchanged payouts, rejected obsolete rules and locked retry signatures.");
console.log("PASS: personal daily seeds, 23:59 UTC/leap-day rollover, in-flight grab deferral, browser identity, persisted poses/removals, stale/corrupt saves, locked arrangement identity.");
console.log("PASS: prize pocket stays clear across seeded loading and every post-pickup settling frame; no target in bay.");
console.log("PASS: non-finite/forged snapshot odds and invalid IDs rejected before RNG; oversized/duplicate saves rejected and unknown pose fields discarded.");
console.log(`Pile: ${stack.length} boxes; ${top.length} exposed; ${Math.max(...stack.map(boxTop)).toFixed(2)} / ${MACHINE.height.toFixed(2)} height; chamber ${MACHINE.width} × ${MACHINE.depth}.`);
console.log(`100,000 aligned trials: ${(hits / 1000).toFixed(2)}% observed vs ${(target.probability * 100).toFixed(2)}% predicted.`);
console.log(`10,000 random aims: ${(sim.observedRate * 100).toFixed(2)}% observed vs ${(sim.expectedRate * 100).toFixed(2)}% predicted; 3σ ±${(sim.tolerance * 100).toFixed(2)}pp.`);



// Adaptive targeting or endless replenishment cannot exceed the per-attempt cap
// while payments are collected and the random draw is independent. Operating
// costs are separate and can erase the minimum gross margin.
let idealRevenue = 0, idealAttempts = 0, inventoryPayout = 0;
for (const entry of PRIZE_INVENTORY) {
  const flat = { ...box, cents: entry.cents, maxPickupProbability: entry.peak };
  const alternatives = [0, 1, 2].map(tier => {
    const probability = pickupProbability(aim, parametersFor(flat, tier));
    const entryUsd = entryPriceUsd(tier, 'USDC');
    assert(probability * entry.cents / 100 <= .95 * entryUsd + 1e-12);
    return { probability, entryUsd, costPerWin: entryUsd / probability };
  });
  const best = alternatives.reduce((a, b) => a.costPerWin <= b.costPerWin ? a : b);
  idealRevenue += entry.count * best.costPerWin; idealAttempts += entry.count / best.probability; inventoryPayout += entry.count * entry.cents / 100;
}
assert(idealRevenue > inventoryPayout);
const repeatedTarget = parametersFor(purple, 0);
const grossPerPlay = 2 - pickupProbability(aim, repeatedTarget) * (purple.cents / 100);
assert(Math.abs(grossPerPlay - .1) < 1e-12, 'Unlimited replenishment at the highest RTP still leaves 5% expected gross margin');
assert(grossPerPlay - .05 > 0); assert(grossPerPlay - .11 < 0, 'A cost above the buffer can make net EV negative');
console.log('PASS: optimal-target and unlimited-replenishment gross EV bound; operating-cost counterexample.');
console.log('Ideal flat 64-box clearance: expected entries ' + idealRevenue.toFixed(2) + ' USDC, prizes ' + inventoryPayout.toFixed(2) + ' USDC, gross house profit ' + (idealRevenue-inventoryPayout).toFixed(2) + ' USDC before costs.');
console.log('Expected attempts for the minimum-entry-cost flat strategy: ' + idealAttempts.toFixed(2) + '. This is an optimistic player model, not a finite-session profit guarantee.');

console.log("PASS: no empty-space snapping, narrow deep-gap rejection, first-surface targeting, shallow/outer lower prizes and access restored after blocker removal; unchanged eligible odds.");

// Every actual seeded selection must be the first physical surface, not a lower neighbor.
for (const pile of layoutFixtures) for (let ix = 0; ix <= 16; ix++) for (let iz = 0; iz <= 16; iz++) {
  const point = { x: ARENA.minX + (ARENA.maxX - ARENA.minX) * ix / 16,
    z: ARENA.minZ + (ARENA.maxZ - ARENA.minZ) * iz / 16 };
  const selected = selectTarget(point, pile, 0);
  if (selected) {
    assert.equal(selected.box.id, highestSurfaceAt(point, pile).box.id, "Actual pile targets cannot pass through the upper surface");
    assert.equal(selected.probability, pickupProbability(point, parametersFor(selected.box, 0)), "Selecting a real surface does not change its Gaussian odds");
  }
}
let clearing = stack, collected = 0;
while (clearing.length) {
  const point = startingAim(clearing), selected = selectTarget(point, clearing, 0);
  assert(selected, "Every nonempty settled state in a complete 64-box clearance has a reachable prize");
  clearing = settlePile(clearing.filter(candidate => candidate.id !== selected.box.id)).at(-1);
  collected++;
}
assert.equal(collected, 64);
console.log("PASS: first-surface selections over seven seeded aim grids and complete 64-box depletion with fresh settling; no unreachable remaining inventory.");
