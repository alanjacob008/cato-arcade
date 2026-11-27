import assert from "node:assert/strict";
import { pacedRpcFetch, singleFlightCache, safeRpcError } from "./lib/vrf-rpc-transport.mjs";

let time = 0;
const starts = [];
const pacing = pacedRpcFetch({ now: () => time, sleep: async ms => { time += ms; }, spacingMs: 220,
  fetcher: async (_url, init) => { assert.equal(init.redirect, "error"); starts.push(time); return Response.json({ ok: true }); } });
await Promise.all(Array.from({ length: 16 }, () => pacing("https://devnet.helius-rpc.com/")));
assert.equal(starts.length, 16);
for (let index = 1; index < starts.length; index++) assert(starts[index] - starts[index - 1] >= 220);

// Slow responses overlap, but the third request waits for a free worker and
// every actual network start still uses the same 220 ms rate budget.
let poolClock = 0, peak = 0, active = 0;
const releases = [], poolStarts = [];
const pooled = pacedRpcFetch({ now: () => poolClock, sleep: async ms => { poolClock += ms; },
  fetcher: async () => {
    poolStarts.push(poolClock); peak = Math.max(peak, ++active);
    return new Promise(resolve => releases.push(() => { active--; resolve(Response.json({ ok: true })); }));
  } });
const requests = Array.from({ length: 3 }, () => pooled("https://devnet.helius-rpc.com/"));
const flushUntil = async count => { for (let i = 0; i < 100 && releases.length < count; i++) await Promise.resolve(); assert.equal(releases.length, count); };
await flushUntil(2); assert.equal(peak, 2); assert.equal(poolStarts.length, 2);
releases[0](); await flushUntil(3); releases[1](); releases[2](); await Promise.all(requests);
assert.equal(peak, 2); assert.equal(active, 0);
for (let i = 1; i < poolStarts.length; i++) assert(poolStarts[i] - poolStarts[i - 1] >= 220);
assert.throws(() => pacedRpcFetch({ concurrency: 0 }), /invalid_rpc_concurrency/);
time = 0; let attempts = 0;
const retryStarts = [];
const retrying = pacedRpcFetch({ now: () => time, sleep: async ms => { time += ms; }, fetcher: async () => {
  retryStarts.push(time); return attempts++ < 2 ? new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } }) : Response.json({ ok: true });
} });
assert((await retrying("https://devnet.helius-rpc.com/")).ok);
assert.deepEqual(retryStarts, [0, 2000, 4000]);
attempts = 0;
const limited = pacedRpcFetch({ now: () => time, sleep: async ms => { time += ms; }, fetcher: async () => { attempts++; return new Response("secret", { status: 429 }); } });
await assert.rejects(limited("https://devnet.helius-rpc.com/?api-key=secret"), { message: "devnet_rpc_rate_limited" });
assert.equal(attempts, 4);
const failing = pacedRpcFetch({ sleep: async () => {}, fetcher: async url => { throw Error(url); } });
await assert.rejects(failing("https://devnet.helius-rpc.com/?api-key=secret"), { message: "devnet_rpc_unavailable" });
assert.equal(safeRpcError(Error("failed to get account: devnet_rpc_rate_limited")), "devnet_rpc_rate_limited");
assert.equal(safeRpcError(Error("secret https://example.com/key")), "devnet_action_failed_check_status");
assert.equal(safeRpcError({ message: "private RPC details", logs: ["Program was deployed in this block already"] }), "program_slot_pending_retry_same_step");

let reads = 0, clock = 0;
const cache = singleFlightCache(async () => ++reads, 5000, () => clock);
assert.deepEqual(await Promise.all([cache.get(), cache.get(), cache.get()]), [1, 1, 1]);
assert.equal(reads, 1); clock = 4000; assert.equal(await cache.get(), 1);
clock = 5001; assert.equal(await cache.get(), 2);
cache.invalidate(); assert.equal(await cache.get(), 3);
let resolveOld;
const race = singleFlightCache(() => ++reads === 4 ? new Promise(resolve => { resolveOld = resolve; }) : "fresh", 5000, () => clock);
const old = race.get(); await Promise.resolve(); race.invalidate();
assert.equal(await race.get(), "fresh"); resolveOld("stale"); await old; assert.equal(await race.get(), "fresh");
let failures = 0;
const recovery = singleFlightCache(async () => { if (!failures++) throw Error("temporary"); return "recovered"; }, 5000);
await assert.rejects(recovery.get()); assert.equal(await recovery.get(), "recovered");
console.log("PASS: globally paced upload RPCs, bounded Retry-After retries, redacted errors, multi-tab status coalescing and cache invalidation races.");
