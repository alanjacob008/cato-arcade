import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { loadClawRules } from "./vrf-game.mjs";

// Canonical geometry is computed away from the HTTP/VRF event loop.
if (!isMainThread) {
  const rules = await loadClawRules();
  parentPort.on("message", ({ id, kind, seed, boxes }) => {
    try { parentPort.postMessage({ id, boxes: kind === "create" ? rules.createPile(seed) : rules.settlePile(boxes).at(-1) }); }
    catch { parentPort.postMessage({ id, error: "canonical_physics_failed" }); }
  });
}

/** New-wallet piles waiting or running at once; more sign-ups get a retryable busy error. */
export const NEW_WALLET_PILE_LIMIT = 4;

// One worker runs one job at a time, highest priority first (0 before 1). Only the order
// changes: every job runs the same canonical code on the same input.
function createLane(spawn) {
  const worker = spawn(), queues = [[], []]; let running = null, sequence = 0, failed = false;
  const pump = () => {
    if (running || failed) return;
    running = queues[0].shift() ?? queues[1].shift() ?? null;
    if (running) worker.postMessage(running.message);
  };
  worker.on("message", ({ id, boxes, error }) => {
    const job = running; if (!job || job.message.id !== id) return; running = null;
    if (error) job.reject(Error(error)); else job.resolve(boxes);
    pump();
  });
  function fail() {
    failed = true;
    for (const job of [running, ...queues.flat()]) job?.reject(Error("canonical_physics_unavailable"));
    running = null; for (const queue of queues) queue.length = 0;
  }
  worker.on("error", fail); worker.on("exit", fail);
  return {
    size: () => queues[0].length + queues[1].length + (running ? 1 : 0),
    run: (payload, priority) => new Promise((resolve, reject) => {
      if (failed) { reject(Error("canonical_physics_unavailable")); return; }
      queues[priority].push({ message: { ...payload, id: ++sequence }, resolve, reject }); pump();
    }),
    close: () => worker.terminate(),
  };
}

// Settlement of reserved attempts never waits behind new-wallet pile creation: free
// sign-ups use their own worker and a bounded queue. Existing players' settlements run
// before their daily pile rotations on the main worker.
export function createLedgerPhysics({ spawn = () => new Worker(new URL(import.meta.url)), newWalletLimit = NEW_WALLET_PILE_LIMIT } = {}) {
  const main = createLane(spawn), signups = createLane(spawn);
  return {
    create(seed, { newWallet = false } = {}) {
      if (!newWallet) return main.run({ kind: "create", seed }, 1);
      if (signups.size() >= newWalletLimit) return Promise.reject(Error("claw_service_busy_retry"));
      return signups.run({ kind: "create", seed }, 0);
    },
    settle: boxes => main.run({ kind: "settle", boxes }, 0),
    close: () => Promise.all([main.close(), signups.close()]),
  };
}
