import { CATO_MINT } from "./constants.js";
import type { CatoTx, TxKind } from "./types.js";

/** Minimal shape of a Helius enhanced transaction that the classifier needs. */
export interface TokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  mint?: string;
  tokenAmount?: number;
}

export interface ParsedTx {
  signature: string;
  timestamp: number; // unix seconds
  type?: string;
  source?: string;
  tokenTransfers?: TokenTransfer[];
}

/**
 * Helius `source` values that indicate a DEX swap. CATO arriving via one of
 * these (or a tx typed SWAP) is a buy; leaving via one is a sell (design §6).
 */
export const DEX_SOURCES = new Set<string>([
  "RAYDIUM",
  "ORCA",
  "JUPITER",
  "SERUM",
  "OPENBOOK",
  "ALDRIN",
  "SABER",
  "PHOENIX",
  "METEORA",
  "LIFINITY",
  "STEP",
  "CROPPER",
  "PUMP_FUN",
]);

function isSwap(tx: ParsedTx): boolean {
  if (tx.type === "SWAP") return true;
  return tx.source !== undefined && DEX_SOURCES.has(tx.source);
}

export interface ClassifyOptions {
  owner: string;
  /** Addresses known to be the canonical CATO airdrop distributor(s). */
  distributors?: ReadonlySet<string>;
  mint?: string;
}

/**
 * Classify a single parsed transaction into a CATO tx for `owner`, or null when
 * the tx moves no CATO for that owner. Pure and deterministic.
 */
export function classifyCatoTx(tx: ParsedTx, opts: ClassifyOptions): CatoTx | null {
  const mint = opts.mint ?? CATO_MINT;
  const transfers = (tx.tokenTransfers ?? []).filter((t) => t.mint === mint);
  if (transfers.length === 0) return null;

  let inAmount = 0;
  let outAmount = 0;
  let inCounterparty: string | null = null;
  let outCounterparty: string | null = null;

  for (const t of transfers) {
    const amt = t.tokenAmount ?? 0;
    if (amt <= 0) continue;
    if (t.toUserAccount === opts.owner) {
      inAmount += amt;
      inCounterparty = t.fromUserAccount ?? inCounterparty;
    } else if (t.fromUserAccount === opts.owner) {
      outAmount += amt;
      outCounterparty = t.toUserAccount ?? outCounterparty;
    }
  }

  if (inAmount === 0 && outAmount === 0) return null;

  const swap = isSwap(tx);
  const ts = new Date(tx.timestamp * 1000).toISOString();
  const received = inAmount >= outAmount;
  const amount = received ? inAmount : outAmount;
  const counterparty = received ? inCounterparty : outCounterparty;

  let kind: TxKind;
  if (received) {
    if (swap) kind = "buy";
    else if (counterparty && opts.distributors?.has(counterparty)) kind = "airdrop_in";
    else kind = "transfer_in";
  } else {
    kind = swap ? "sell" : "transfer_out";
  }

  return { sig: tx.signature, owner: opts.owner, ts, kind, amount, counterparty };
}
