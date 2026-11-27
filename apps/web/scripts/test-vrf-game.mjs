import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { loadClawRules, gameThreshold, createGameService } from "./lib/vrf-game.mjs";
import { requestProbe } from "./lib/vrf-deployment.mjs";

const rules = await loadClawRules();
for (const probability of [0, 1, .5, .37123456789, .00000000001, .9999999999]) {
  const cutoff = Number(gameThreshold(probability));
  for (const roll of [0, cutoff - 1, cutoff, 2 ** 32 - 1].filter(n => n >= 0 && n < 2 ** 32)) {
    assert.equal(BigInt(roll) < BigInt(cutoff), roll / 2 ** 32 < probability, "VRF threshold preserves every original discrete boundary");
  }
}
assert.throws(() => gameThreshold(NaN)); assert.throws(() => gameThreshold(-1)); assert.throws(() => gameThreshold(1.01));
const manifest = JSON.parse(await readFile(new URL("../onchain/deployment.devnet.json", import.meta.url), "utf8"));
const boxes = rules.createPile(42);
const aim = rules.startingAim(boxes), target = rules.selectTarget(aim, boxes, 0);
assert(target);
const pull = { id: "vrf-game-regression-1", rulesVersion: rules.RULES_VERSION, aim, target, tier: 0, currency: "USDC", priceUsd: 2 };
// Actual failed ER pose: Math.exp produced a final-bit difference between the
// browser's locked chance and the server's recomputation. Keep the locked value.
const precisionPull = { ...pull, id: "vrf-final-bit-regression", aim: { x: 0.9273259493185704, z: 0.2391435716592047 },
  target: { box: { ...target.box, id: "BOX-63", cents: 200 }, probability: 0.46235737012248757,
    parameters: { grabPoint: { x: 0.8461606798631343, y: 2.629777806434292, z: 0.44099986883642206 },
      sigmaX: .26, sigmaZ: .26, maxPickupProbability: .8, maxReach: .7, exposure: 1, gripSuitability: .8202289338461269 } } };
assert.equal(rules.resolvePull(precisionPull, () => .58, "magicblock-vrf").probability, precisionPull.target.probability,
  "Valid precision differences must never trip the animation's exact locked-probability guard");
const boundaryPull = { ...precisionPull, id: "vrf-locked-cutoff-boundary", aim: { x: 0, z: 0 },
  target: { ...precisionPull.target, probability: .5 + Number.EPSILON,
    parameters: { ...precisionPull.target.parameters, grabPoint: { x: 0, y: 2, z: 0 }, maxPickupProbability: .5, gripSuitability: 1 } } };
const boundaryDraw = rules.resolvePull(boundaryPull, () => .5, "magicblock-vrf");
assert.equal(boundaryDraw.probability, boundaryPull.target.probability); assert.equal(boundaryDraw.success, true);
assert.equal(gameThreshold(boundaryDraw.probability), "2147483649", "Keep the original onchain cutoff, including its u32 boundary");
assert.throws(() => rules.resolvePull({ ...precisionPull, target: { ...precisionPull.target, probability: .9 } }, () => .58), /Invalid target snapshot/);
const precisionSession = { attempts: [] };
const precisionGame = createGameService({ session: precisionSession, rules, manifest, requestProbe,
  save: async () => {}, deployed: async () => true, prepare: async () => ({ id: "boundary-plan" }),
  refreshAttempt: async locked => { locked.callbackSignature = "verified-boundary-receipt"; locked.result = { status: "fulfilled", roll: 2147483648, success: true }; } });
await precisionGame.plan(boundaryPull);
assert.equal(precisionSession.attempts[0].threshold, "2147483649");
assert.deepEqual((await precisionGame.state(boundaryPull.id)).result, boundaryDraw);
const sequentialSession = { attempts: [] }; let nextReads = 0;
const sequential = createGameService({ session: sequentialSession, rules, manifest, requestProbe,
  nextNonce: async () => { nextReads++; return "0"; }, save: async () => {}, deployed: async () => true,
  refreshAttempt: async () => {}, prepare: async () => ({ id: "sequential" }) });
await sequential.plan(pull); await sequential.plan(pull);
assert.equal(sequentialSession.attempts[0].nonce, "0"); assert.equal(nextReads, 1, "Reload/retry never chooses a second ER nonce");
const session = { attempts: [] }, plans = [];
const service = createGameService({ session, rules, manifest, requestProbe, save: async () => {}, deployed: async () => true,
  refreshAttempt: async locked => { locked.result ??= { status: "not_submitted" }; },
  prepare: async (...args) => { plans.push(args); return { id: "fixed-plan" }; } });
await service.plan(pull); await service.plan(pull);
assert.equal(session.attempts.length, 1); assert.equal(plans[0][4].nonce, plans[1][4].nonce); assert.equal(plans[0][4].seed, plans[1][4].seed);
assert.equal(plans[0][5], true, "Game requests use durable nonce approvals");
assert.equal(session.attempts[0].threshold, gameThreshold(target.probability));
await assert.rejects(service.plan({ ...pull, tier: 1, priceUsd: 4 }), /game_attempt_inputs_changed|Invalid target snapshot/);
await assert.rejects(service.plan({ ...pull, id: "another-attempt" }), /previous_callback_pending/);
const locked = session.attempts[0]; locked.requestSignature = "request-receipt"; locked.result = { status: "pending" };
const pendingPlan = await service.plan(pull); assert.equal(pendingPlan.pending, true); assert.equal(pendingPlan.submitted, true); assert.equal(plans.length, 2);
locked.result = { status: "fulfilled", roll: 0, success: true, requestedSlot: "100", fulfilledSlot: "103" };
assert.equal((await service.state(pull.id)).result, null, "Callback proof verification is required before revealing a result");
locked.callbackSignature = "callback-receipt";
const verified = await service.state(pull.id); assert.equal(verified.result.source, "magicblock-vrf"); assert.equal(verified.result.cents, target.box.cents);
const finished = Date.now();
await service.recordTiming(pull.id, { pressed: finished - 5000, waiting: finished - 3000, lifting: finished - 2000, finished });
assert.equal(locked.presentationTiming.waiting, finished - 3000);
await assert.rejects(service.recordTiming(pull.id, { finished: -1 }), /invalid_presentation_timing/);
await assert.rejects(service.recordTiming(pull.id, { lifting: finished + 1000, finished }), /invalid_presentation_timing/);
assert.deepEqual((await service.plan(pull)).result, verified.result, "Repeated requests reuse the exact verified result");
assert.equal((await service.state(null)).gameId, pull.id, "Reload can recover the latest locked game attempt");
let sponsoredSends = 0, freshReads = 0;
const sponsoredSession = { attempts: [] };
const sponsored = createGameService({ session: sponsoredSession, rules, manifest, requestProbe,
  requestAuthority: "test-sponsor", save: async () => {}, deployed: async () => true,
  prepare: async () => { throw Error("No per-drop wallet plan may be created"); },
  refreshAttempt: async a => { freshReads++; a.result ??= { status: "not_submitted" }; },
  sendSponsored: async a => { assert.equal(freshReads, 0, "A new unsent attempt needs no preliminary account lookup"); sponsoredSends++; a.requestSignature = "sponsored-request"; a.result = { status: "pending" }; } });
assert.equal((await sponsored.plan(pull)).sponsored, true);
assert.equal(freshReads, 0, "Broadcast response must not wait for a redundant preliminary account poll");
assert.equal((await sponsored.plan(pull)).submitted, true);
assert.equal(sponsoredSends, 1); assert.equal(sponsoredSession.attempts[0].requestAuthority, "test-sponsor");

let setupClock = 100;
const slowSetup = createGameService({ session: { attempts: [] }, rules, manifest, requestProbe, now: () => setupClock,
  save: async () => {}, deployed: async () => { setupClock += 900; return true; },
  refreshAttempt: async () => {}, prepare: async () => ({ id: "setup-plan" }) });
await slowSetup.plan(pull);
const setupTiming = (await slowSetup.state(pull.id)).timings;
assert.equal(setupTiming.preparationStartedAt, 100); assert.equal(setupTiming.lockedAt, 1000,
  "Preparation telemetry must include deployment checks before the attempt lock");

// Run the actual client adapter with a delayed callback. It must never ask the
// player wallet to sign a gameplay transaction or load the browser signing SDK.
const source = ts.transpileModule(await readFile(new URL("../components/claw/devnetVrf.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
let signatures = 0, submissions = 0, polls = 0, planned = 0, cachedPlan = null, sponsorActive = true;
const events = [], returned = { ...verified, requestSignature: "request-receipt", callbackSignature: "callback-receipt" };
const context = vm.createContext({ exports: {}, require: name => { assert.equal(name, "./rewards"); return rules; },
  location: { hostname: "127.0.0.1", port: "4321", hash: `#session=${"a".repeat(64)}` }, URLSearchParams, AbortSignal,
  Uint8Array, atob, btoa, Date, setTimeout: fn => { queueMicrotask(fn); },
  window: { solanaWeb3: { VersionedTransaction: { deserialize: () => ({ serialize: () => new Uint8Array([1, 2, 3]) }) } },
    phantom: { solana: { isPhantom: true, publicKey: { toBase58: () => manifest.adminAuthority }, connect: async () => {},
      signTransaction: async tx => { signatures++; return tx; } } } },
  fetch: async (url, options) => {
    const data = value => ({ ok: true, json: async () => value });
    if (url === "/api/game/availability") return data({ cluster: "devnet", execution: "base", deployed: true, authority: manifest.adminAuthority, sponsor: { ready: sponsorActive, remaining: sponsorActive ? 3 : 0, expiresAt: Date.now() / 1000 + 3600 } });
    if (url === "/api/game/plan") { planned++; if (cachedPlan) return data(cachedPlan); assert.equal(JSON.parse(options.body).pull.id, pull.id); return data({ sponsored: true, submitted: true, pending: true }); }
    if (url === "/api/submit") { submissions++; throw Error("transport timeout after possible broadcast"); }
    assert(url.startsWith("/api/game/result?id=")); polls++;
    assert(!events.some(event => event.phase === "request-confirmed"), "Broadcast acknowledgement alone must not emit confirmed");
    return data(polls < 3 ? { ...returned, timings: { ...returned.timings, confirmedAt: null }, pending: true, result: null }
      : { ...returned, timings: { ...returned.timings, confirmedAt: Date.now() } });
  },
});
vm.runInContext(source, context);
const client = context.exports.createDevnetVrf(event => events.push(event));
await assert.rejects(context.exports.createDevnetVrf(() => {}, "er").connect(), /port 4322/);
await client.connect();
const a = client.resolve(pull), b = client.resolve(pull); assert.equal(a, b);
assert.deepEqual(JSON.parse(JSON.stringify(await a)), verified.result);
assert.equal(planned, 1); assert.equal(signatures, 0); assert.equal(submissions, 0); assert.equal(polls, 3);
assert(events.some(event => event.phase === "sponsored")); assert(events.some(event => event.phase === "result-ready"));
assert.equal(events.filter(event => event.phase === "request-confirmed").length, 1);
await assert.rejects(client.resolve({ ...pull, aim: { x: 1, z: 1 } }), /Attempt inputs changed/);
const empty = { ...pull, id: "empty-target", target: null };
const miss = await client.resolve(empty); assert.equal(miss.roll, null); assert.equal(miss.success, false); assert.equal(planned, 1);
cachedPlan = { ...returned, gameId: precisionPull.id, pull: precisionPull, result: rules.resolvePull(precisionPull, () => .58, "magicblock-vrf") };
const recoveredClient = context.exports.createDevnetVrf(() => {}); await recoveredClient.connect();
assert.deepEqual(JSON.parse(JSON.stringify(await recoveredClient.resolve(precisionPull))), cachedPlan.result);
assert.equal(polls, 3, "A cached verified result needs no new callback poll, draw or signature");
cachedPlan = { ...cachedPlan, callbackSignature: null };
const invalidRecovery = context.exports.createDevnetVrf(() => {}); await invalidRecovery.connect();
await assert.rejects(invalidRecovery.resolve(precisionPull), /does not match/);
sponsorActive = false;
await assert.rejects(context.exports.createDevnetVrf(() => {}).connect(), /sponsor is not active/);
const readOnlyPlayer = context.exports.createDevnetVrf(() => {}, "base", true); await readOnlyPlayer.connect();
assert.equal((await readOnlyPlayer.availability()).sponsor.remaining, 0);
cachedPlan = { ...cachedPlan, callbackSignature: "existing-callback" };
assert.deepEqual(JSON.parse(JSON.stringify(await readOnlyPlayer.resolve(precisionPull))), cachedPlan.result,
  "Exhausted sponsorship still allows recovery of the same verified result without a new request");
assert.equal(signatures, 0); assert.equal(submissions, 0);
console.log("PASS: shared claw odds, exact integer cutoffs, immutable attempts, pending/reload recovery, cached verified results, ZERO wallet transaction signatures across delayed sponsored callbacks, and empty-target handling.");
