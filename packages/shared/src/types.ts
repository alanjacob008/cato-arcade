/** How a single CATO transfer is classified for a given wallet. */
export type TxKind =
  | "buy"
  | "sell"
  | "airdrop_in"
  | "transfer_in"
  | "transfer_out";

export const TX_KINDS: readonly TxKind[] = [
  "buy",
  "sell",
  "airdrop_in",
  "transfer_in",
  "transfer_out",
] as const;

/** How a wallet first acquired CATO. */
export type AcquisitionType = "bought" | "airdropped" | "received" | "unknown";

/** Whether a holder row came from the pre-index or an on-demand reveal. */
export type StatsSource = "preindex" | "ondemand";

/** A row in `holders`: a CATO token account snapshot. */
export interface Holder {
  owner: string;
  ata: string;
  /** Balance in whole CATO at snapshot time. */
  balance: number;
  snapshotAt: string; // ISO timestamp
}

/** A classified CATO transaction for one wallet. */
export interface CatoTx {
  sig: string;
  owner: string;
  ts: string; // ISO timestamp
  kind: TxKind;
  /** Amount in whole CATO (positive). */
  amount: number;
  counterparty: string | null;
}

/** Aggregated per-holder stats + rankings. */
export interface HolderStats {
  owner: string;
  totalBought: number;
  totalSold: number;
  net: number;
  balance: number;
  firstTx: string | null; // ISO
  lastTx: string | null; // ISO
  holdDays: number;
  acquisitionType: AcquisitionType;
  untouchedAirdrop: boolean;
  biggestBuy: number;
  biggestSell: number;
  rankLongest: number | null;
  pctBalance: number | null; // percentile 0..100
  pctLoyalty: number | null;
  source: StatsSource;
  indexedAt: string; // ISO
  /** Total CATO transactions for this wallet (known from the cheap signature scan). */
  txCount?: number;
  /**
   * Whether the expensive enhanced-parse has run. Light pre-indexed wallets are
   * `false` (balance + tx metadata only) until a visit upgrades them to a full parse.
   */
  fullyParsed?: boolean;
}

/** Result of the live gate check. */
export type GateResult =
  | { status: "pass"; balance: number }
  | { status: "below"; balance: number; needed: number }
  | { status: "never"; balance: 0 };

/** Broad Solana-life metrics (capped). */
/** Current on-chain footprint from the Helius DAS API (assets the wallet holds now). */
export interface WalletPortfolio {
  nftCount: number;
  collectionCount: number;
  tokenCount: number;
  solBalance: number | null;
  /** True if the asset list hit the page limit, so counts are floors. */
  capped: boolean;
}

export interface BroadActivity {
  // — Lifetime, from the signature history (full within the page cap) —
  walletAgeDays: number | null;
  /** Epoch ms of the wallet's first-ever transaction (for "OG since"). */
  firstTxMs: number | null;
  totalTxCount: number;
  /** True when the scan hit its page cap and totalTxCount is a floor, not exact. */
  capped: boolean;
  /** Distinct days with at least one transaction. */
  activeDays: number;
  failedTxCount: number;
  /** Per-day tx counts (YYYY-MM-DD -> count) for the GitHub-style activity calendar. */
  txByDay: Record<string, number>;

  // — Recent-activity profile, from an enhanced-parse sample of recent txs —
  /** How many txs were enhanced-parsed for the profile below (it's a sample). */
  sampleSize: number;
  programsUsed: string[];
  /** Count of txs by Helius type (SWAP, NFT_SALE, TRANSFER, STAKE, …) within the sample. */
  typeBreakdown: Record<string, number>;
  distinctTokens: number;
  nftCount: number;
  otherAirdrops: number;
  /** SOL spent on fees within the sample. */
  feesPaidSol: number;
  /** SOL moved (native transfers involving the wallet) within the sample. */
  solVolume: number;

  // — Current footprint, from the Helius DAS API (one extra call) —
  portfolio: WalletPortfolio | null;

  degraded: boolean; // true if the scan failed/partial; CATO stats still render
}

/** Minimal headline payload for the server-generated share image (design D9). */
export interface ShareData {
  wallet: string;
  ogSince: string | null; // first CATO tx (ISO)
  solanaSince: string | null; // first-ever Solana tx (ISO) — "active on Solana since"
  rankLongest: number | null;
  pctBalance: number | null;
  pctLoyalty: number | null;
  untouchedAirdrop: boolean;
  balance: number;
  bagUsd: number | null;
}

/** One holder on the leaderboard (only wallets that have used CATO Wrapped). */
export interface LeaderboardEntry {
  wallet: string;
  balance: number;
  holdDays: number;
  firstTx: string | null; // ISO
  pctLoyalty: number | null;
  untouchedAirdrop: boolean;
}

/** Leaderboard of cats who've checked their Wrapped (gate-passing holders only). */
export interface Leaderboard {
  totalCats: number; // distinct qualifying holders who have scanned
  entries: LeaderboardEntry[]; // ordered by balance desc; the page derives each board
}

/** The full payload the frontend renders. */
export interface RevealPayload {
  wallet: string;
  stats: HolderStats;
  recentTxs: CatoTx[];
  bagUsd: number | null; // null when price source unavailable
  broad: BroadActivity;
}

/** Staker row mirrored from the on-chain UserPda account. */
export interface StakerRecord {
  publicKey: string;
  deposited: string;
  withdrawn: string;
  earned: string;
  claimed: string;
  lastDistributedAt: number;
  lastDepositedAt: number;
  lastDepositedAmount: string;
}

/** Response for the live on-chain staker count endpoint. */
export interface StakerCountResult {
  count: number;
}
