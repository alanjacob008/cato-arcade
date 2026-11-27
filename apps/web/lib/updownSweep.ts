/**
 * The cron sweep: Vercel Cron calls /api/updown/sweep every minute. One sweep at a
 * time (a database lease named "sweep"); it advances every round with pending
 * work, sleeps ~1s, and repeats until ~55s have passed or nothing is left. So an
 * abandoned round still closes within a few seconds of its deadline, and an idle
 * minute costs one short invocation.
 *
 * Time budget (the route's maxDuration is SWEEP_MAX_DURATION_S): passes start only
 * within budgetMs, and no new round is started after stopStartingMs, which leaves
 * SWEEP_SAFETY_MARGIN_MS for the slowest single round (a position read, an order
 * lookup and a close, each with a 10s timeout, plus journal writes). An order is
 * therefore never the last thing in flight when the platform kills the function.
 */
import { timingSafeEqual } from "node:crypto";

export const SWEEP_MAX_DURATION_S = 120;
export const SWEEP_SAFETY_MARGIN_MS = 45_000;
const STOP_STARTING_MS = SWEEP_MAX_DURATION_S * 1000 - SWEEP_SAFETY_MARGIN_MS;

interface SweepEngine {
  tick(options?: { continueWhile?: () => boolean }): Promise<number>;
}
interface SweepStore {
  withLock<T>(names: string[], fn: () => Promise<T>, options?: { wait?: boolean; ttlMs?: number }): Promise<{ acquired: boolean; value?: T }>;
  pruneLocks?: () => Promise<void>;
}

export interface SweepResult {
  skipped?: string;
  iterations?: number;
  maxDue?: number;
  elapsedMs: number;
}

export async function runSweep({
  engine,
  store,
  budgetMs = 55_000,
  stopStartingMs = STOP_STARTING_MS,
  intervalMs = 1_000,
  leaseMs = SWEEP_MAX_DURATION_S * 1000 + 10_000,
  now = Date.now,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: {
  engine: SweepEngine;
  store: SweepStore;
  budgetMs?: number;
  stopStartingMs?: number;
  intervalMs?: number;
  leaseMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SweepResult> {
  const started = now();
  const held = await store.withLock(
    ["sweep"],
    async () => {
      await store.pruneLocks?.().catch(() => {});
      let iterations = 0;
      let maxDue = 0;
      for (;;) {
        const due = await engine.tick({ continueWhile: () => now() - started < stopStartingMs });
        iterations++;
        maxDue = Math.max(maxDue, due);
        // Idle: stop at once. Otherwise keep going while another pass fits the budget.
        if (due === 0 || now() - started + intervalMs >= budgetMs) break;
        await sleep(intervalMs);
      }
      return { iterations, maxDue };
    },
    // The lease outlives the function's maxDuration, so a dead sweep blocks the next for at most one run.
    { wait: false, ttlMs: leaseMs },
  );
  if (!held.acquired) return { skipped: "Another sweep is running.", elapsedMs: now() - started };
  return { ...held.value, elapsedMs: now() - started };
}

/** Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`. No secret configured means no access. */
export function cronAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret?.trim() || !header) return false;
  const expected = Buffer.from(`Bearer ${secret.trim()}`);
  const supplied = Buffer.from(header);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
