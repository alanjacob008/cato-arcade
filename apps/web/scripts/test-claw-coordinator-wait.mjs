import assert from "node:assert/strict";
import { acquireCoordinatorWithin } from "./lib/claw-postgres.mjs";

// During a hosted rollout the old instance holds the coordinator lock until it stops (up to Vercel's 30 s grace).
// The new instance waits for it instead of exiting; it never runs signers without the lock.
let clock = 0;
const sleep = async ms => { clock += ms; };
function storeFreeAfter(ms) {
  let attempts = 0;
  return { attempts: () => attempts, async acquireCoordinator() { attempts++; if (clock < ms) throw Error("claw_coordinator_in_use"); return () => {}; } };
}

const later = storeFreeAfter(31000);
const release = await acquireCoordinatorWithin(later, "Prog", () => {}, { waitMs: 60000, intervalMs: 2000, sleep, now: () => clock });
assert.equal(typeof release, "function");
assert(later.attempts() > 1 && clock >= 31000 && clock <= 33000, "retries until the old instance lets go");

clock = 0;
const never = storeFreeAfter(Infinity);
await assert.rejects(acquireCoordinatorWithin(never, "Prog", () => {}, { waitMs: 10000, intervalMs: 2000, sleep, now: () => clock }), /claw_coordinator_in_use/);
assert(clock >= 10000 && clock <= 12000, "gives up after the wait budget");

// Any other failure is not retried.
clock = 0;
let calls = 0;
await assert.rejects(acquireCoordinatorWithin({ async acquireCoordinator() { calls++; throw Error("claw_database_tls_required"); } }, "Prog", () => {},
  { waitMs: 60000, intervalMs: 2000, sleep, now: () => clock }), /claw_database_tls_required/);
assert.equal(calls, 1);

// Default wait of zero keeps the old behaviour: one attempt.
clock = 0;
const once = storeFreeAfter(Infinity);
await assert.rejects(acquireCoordinatorWithin(once, "Prog", () => {}, { sleep, now: () => clock }), /claw_coordinator_in_use/);
assert.equal(once.attempts(), 1);
console.log("PASS: a new coordinator waits for the previous instance's lock within a bounded time and never proceeds without it.");

// Heartbeat on the lock's own connection: a half-open connection (query never answers) counts as a lost lock.
const { pingWithin } = await import("./lib/claw-postgres.mjs");
await pingWithin(async () => ({ rows: [{ "?column?": 1 }] }), 50);
await assert.rejects(pingWithin(() => new Promise(() => {}), 50), /claw_coordinator_heartbeat_timeout/);
await assert.rejects(pingWithin(async () => { throw Error("connection terminated"); }, 50), /connection terminated/);
console.log("PASS: lock heartbeat treats an unanswered ping as a lost lock.");
