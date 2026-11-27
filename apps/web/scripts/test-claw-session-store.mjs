import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createSaveQueue, fileSessionStore, pgSessionStore } from "./lib/claw-session-store.mjs";

// The signer session (keys, in-flight draws, receipts) must survive a restart wherever the backend runs.
const session = { program: "Prog111", authority: "Auth111", bufferKey: [1, 2, 3], attempts: [{ id: "a1", nonce: 7 }] };
const key = "ab".repeat(32);

// File store keeps today's behaviour: one JSON file, nothing until the first save.
const directory = await mkdtemp(join(tmpdir(), "claw-session-"));
try {
  const file = fileSessionStore(new URL("er-signing-session.json", pathToFileURL(directory + "/")), pathToFileURL(directory + "/"));
  assert.equal(await file.load(), null);
  await file.save(session);
  assert.deepEqual(await file.load(), session);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "er-signing-session.json"), "utf8")), session);
} finally { await rm(directory, { recursive: true, force: true }); }

// Postgres store: same contract, sealed with AES-256-GCM, scoped to the program.
const database = new PGlite(), store = { query: (...args) => database.query(...args) };
const pg = await pgSessionStore(store, { program: "Prog111", key });
assert.equal(await pg.load(), null);
await pg.save(session);
assert.deepEqual(await pg.load(), session);
session.attempts.push({ id: "a2", nonce: 8 });
await pg.save(session);
assert.deepEqual((await pg.load()).attempts.map(a => a.id), ["a1", "a2"], "a later save replaces the earlier one");

// A restarted process with the same key and program reads the same session.
assert.deepEqual(await (await pgSessionStore(store, { program: "Prog111", key })).load(), session);

// Stored bytes are not readable JSON: key material never sits in the database in the clear.
const { rows } = await database.query("SELECT sealed FROM claw_signer_state WHERE program = $1", ["Prog111"]);
assert.equal(rows.length, 1);
assert(!rows[0].sealed.includes("bufferKey") && !rows[0].sealed.includes("Auth111"));

// Wrong key, or another program's row, cannot be opened.
await assert.rejects((await pgSessionStore(store, { program: "Prog111", key: "cd".repeat(32) })).load(), /claw_state_unreadable/);
assert.equal(await (await pgSessionStore(store, { program: "Other222", key })).load(), null);
await database.query("UPDATE claw_signer_state SET program = 'Other222' WHERE program = 'Prog111'");
await assert.rejects((await pgSessionStore(store, { program: "Other222", key })).load(), /claw_state_unreadable/, "a row moved to another program fails authentication");

// Fencing: each load claims a new generation. A writer from an earlier generation (an instance that lost its lock
// but is still running) can no longer overwrite the row, so persisted attempts cannot disappear and be re-planned.
const fence = new PGlite(), fenceStore = { query: (...args) => fence.query(...args) };
const first = await pgSessionStore(fenceStore, { program: "Prog111", key });
assert.equal(await first.load(), null);
await first.save({ attempts: ["a1"] });
const second = await pgSessionStore(fenceStore, { program: "Prog111", key });
assert.deepEqual(await second.load(), { attempts: ["a1"] });
await assert.rejects(first.save({ attempts: [] }), /claw_state_superseded/);
assert.deepEqual(await (await pgSessionStore(fenceStore, { program: "Prog111", key })).load(), { attempts: ["a1"] }, "stale write did not land");

// A table from before fencing (no generation column) is upgraded in place and its session still loads.
const legacy = new PGlite(), legacyStore = { query: (...args) => legacy.query(...args) };
const seeded = await pgSessionStore(legacyStore, { program: "Prog111", key });
await seeded.load(); await seeded.save({ attempts: ["old"] });
await legacy.query("ALTER TABLE claw_signer_state DROP COLUMN generation");
assert.deepEqual(await (await pgSessionStore(legacyStore, { program: "Prog111", key })).load(), { attempts: ["old"] });

// Save queue: writes run in call order, a failed write is reported to its caller only, and later saves still run.
let calls = 0, fail = true;
const flaky = { async save(value) { calls++; if (fail) { fail = false; throw Error("network blip"); } this.last = value; } };
const superseded = [];
const enqueue = createSaveQueue(flaky, () => superseded.push(true));
await assert.rejects(enqueue({ n: 1 }), /network blip/);
await enqueue({ n: 2 });
assert.equal(calls, 2); assert.deepEqual(flaky.last, { n: 2 });
const snapshot = { n: 3 }, pending = enqueue(snapshot); snapshot.n = 99; await pending;
assert.deepEqual(flaky.last, { n: 3 }, "each save writes the state as it was when save() was called");
// A superseded write stops the runtime (it must not keep signing without its lock).
await assert.rejects(createSaveQueue({ async save() { throw Error("claw_state_superseded"); } }, () => superseded.push(true))({}), /claw_state_superseded/);
assert.equal(superseded.length, 1);

// The key must be 64 hex characters.
await assert.rejects(pgSessionStore(store, { program: "Prog111", key: "short" }), /claw_state_key_required/);
console.log("PASS: signer session store round-trips through a file or sealed Postgres row, survives restart, and rejects wrong keys or programs.");
