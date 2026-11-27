import { ORIGINAL_AIRDROP_AMOUNT } from "./constants.js";
import type { AcquisitionType, CatoTx } from "./types.js";

/** Per-holder aggregate, before rankings are applied. */
export interface AggregatedStats {
  totalBought: number;
  totalSold: number;
  net: number;
  firstTx: string | null;
  lastTx: string | null;
  holdDays: number;
  acquisitionType: AcquisitionType;
  untouchedAirdrop: boolean;
  biggestBuy: number;
  biggestSell: number;
}

export interface AggregateOptions {
  /** Current CATO balance (whole CATO) from the holders snapshot. */
  balance: number;
  /** "now" in unix ms — injected for deterministic tests. */
  nowMs: number;
  /** The OG airdrop amount used for the untouched-airdrop badge. */
  airdropAmount?: number;
}

const DAY_MS = 86_400_000;

/** Lightweight per-holder stats derivable from signatures alone (no enhanced parse). */
export interface LightStats {
  balance: number;
  txCount: number;
  firstTx: string | null;
  lastTx: string | null;
  holdDays: number;
}

/**
 * Compute the cheap stats for a holder from just their CATO signature block times
 * + current balance — enough for rankings, "OG since", hold duration, and tx count
 * across the whole population without the expensive enhanced parse.
 */
export function computeLightStats(
  blockTimesSec: Array<number | null>,
  opts: { balance: number; nowMs: number },
): LightStats {
  const valid = blockTimesSec.filter((t): t is number => typeof t === "number" && t > 0).sort((a, b) => a - b);
  const firstMs = valid.length ? valid[0]! * 1000 : null;
  const lastMs = valid.length ? valid[valid.length - 1]! * 1000 : null;
  return {
    balance: opts.balance,
    txCount: blockTimesSec.length,
    firstTx: firstMs ? new Date(firstMs).toISOString() : null,
    lastTx: lastMs ? new Date(lastMs).toISOString() : null,
    holdDays: firstMs ? Math.max(0, Math.floor((opts.nowMs - firstMs) / DAY_MS)) : 0,
  };
}
/** Float tolerance when comparing CATO balances (9 decimals → tiny dust). */
const EPS = 0.5;

function acquisitionFromFirstInflow(sorted: CatoTx[]): AcquisitionType {
  const firstInflow = sorted.find(
    (t) => t.kind === "buy" || t.kind === "airdrop_in" || t.kind === "transfer_in",
  );
  if (!firstInflow) return "unknown";
  if (firstInflow.kind === "buy") return "bought";
  if (firstInflow.kind === "airdrop_in") return "airdropped";
  return "received";
}

/**
 * Aggregate a holder's classified CATO txs into stats. Pure: no I/O, no clock.
 * Rankings are applied separately (they need the whole population).
 */
export function aggregateHolder(txs: CatoTx[], opts: AggregateOptions): AggregatedStats {
  const airdropAmount = opts.airdropAmount ?? ORIGINAL_AIRDROP_AMOUNT;
  const sorted = [...txs].sort((a, b) => a.ts.localeCompare(b.ts));

  let totalBought = 0;
  let totalSold = 0;
  let inflow = 0;
  let outflow = 0;
  let biggestBuy = 0;
  let biggestSell = 0;
  let airdropIn = 0;

  for (const t of sorted) {
    switch (t.kind) {
      case "buy":
        totalBought += t.amount;
        inflow += t.amount;
        biggestBuy = Math.max(biggestBuy, t.amount);
        break;
      case "sell":
        totalSold += t.amount;
        outflow += t.amount;
        biggestSell = Math.max(biggestSell, t.amount);
        break;
      case "airdrop_in":
        airdropIn += t.amount;
        inflow += t.amount;
        break;
      case "transfer_in":
        inflow += t.amount;
        break;
      case "transfer_out":
        outflow += t.amount;
        break;
    }
  }

  const firstTx = sorted[0]?.ts ?? null;
  const lastTx = sorted[sorted.length - 1]?.ts ?? null;
  const holdDays = firstTx ? Math.max(0, Math.floor((opts.nowMs - Date.parse(firstTx)) / DAY_MS)) : 0;

  const untouchedAirdrop =
    airdropIn >= airdropAmount - EPS &&
    totalSold === 0 &&
    totalBought === 0 &&
    Math.abs(opts.balance - airdropAmount) <= EPS;

  return {
    totalBought,
    totalSold,
    net: inflow - outflow,
    firstTx,
    lastTx,
    holdDays,
    acquisitionType: acquisitionFromFirstInflow(sorted),
    untouchedAirdrop,
    biggestBuy,
    biggestSell,
  };
}
