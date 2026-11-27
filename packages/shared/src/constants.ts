import BN from "bn.js"

export const CATO_MINT = "5p2zjqCd1WJzAVgcEnjhb9zWDU7b9XVhFhx4usiyN7jB";

/** CATO has 9 decimals. UI amounts are whole CATO; on-chain amounts are base units. */
export const CATO_DECIMALS = 9;

/** 10^9 — base units per 1 CATO. */
export const CATO_BASE_UNITS = 10 ** CATO_DECIMALS;

/**
 * The original May-2021 airdrop allocation per supporter. Doubles as the default
 * gate threshold (lore-perfect) and the "untouched OG airdrop" detection value.
 */
export const ORIGINAL_AIRDROP_AMOUNT = 19_417;

/** Convert a base-unit bigint/number to whole CATO. */
export function toCato(baseUnits: bigint | number| BN): number {
  return Number(baseUnits) / CATO_BASE_UNITS;
}

/** Convert whole CATO to base units (bigint). */
export function toBaseUnits(cato: number): bigint {
  return BigInt(Math.round(cato * CATO_BASE_UNITS));
}

/** Signatures per page from `getSignaturesForAddress` (Solana RPC max). */
export const SIG_PAGE_SIZE = 1000;

/**
 * Default per-ATA page cap for the signature sweep (~pages × SIG_PAGE_SIZE sigs).
 * A genuine holder has a handful of CATO txs; only infrastructure accounts blow
 * past this, so the cap bounds the run and flags those accounts. Tunable via
 * INDEXER_MAX_SIG_PAGES.
 */
export const DEFAULT_MAX_SIG_PAGES = 20;

/**
 * Known CATO infrastructure addresses — exchanges, AMM pools, distributors.
 * These are NOT real holders: they carry hundreds of thousands of signatures
 * (which hang the signature sweep) and huge balances (which poison top-percentile
 * rankings), so they are excluded from indexing entirely. Maintained by hand
 * alongside the automatic ≥50-recipient distributor heuristic, which does not
 * catch pools or CEX hot wallets. Each entry may be an owner address or a CATO
 * token-account (vault) address — `isInfraAddress` is checked against both during
 * enumeration and signature collection.
 */
export const KNOWN_INFRA_ADDRESSES: ReadonlyMap<string, string> = new Map([
  ["7RmkMNQerKaVioRnmqZsHM5Gm8F3gngQG8umLNoK97q4", "Bitrue (exchange)"],
  ["EjoLNSDggfWWE7BxwoL4tJHBEg1cFpdiyKeYTYCec2o2", "Orca pool"],
  ["5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", "Raydium pool"],
]);

/** CATO mint pinned by the stake-rewards program + staking web UI (mainnet). */
export const STAKE_CATO_MINT = CATO_MINT;

/** @deprecated Use STAKE_CATO_MINT — kept as an alias during the mainnet cutover. */
export const STAKE_DEVNET_CATO_MINT = STAKE_CATO_MINT;

/** Default stake-rewards program id. */
export const STAKE_PROGRAM_ID = "DEM7gtr1zbcUiHT7KkDpNaYgarNcMqYKiHLhXHZYxtgL";

/** Miniclip claim vault program (localnet / deploy id from claim/Anchor.toml). */
export const CLAIM_PROGRAM_ID = "E1CFByzaKHZyakwJ4d9HfrCcyQhLMij4Urzm1FcWH3Fy";

/** On-chain cooldown between per-user reward distributions / deposit vesting. */
export const STAKE_DISTRIBUTION_COOLDOWN_SECONDS = 80_000;

/**
 * Daily staking schedule, in UTC. The API cron moves the day's revenue into
 * the reward vault, then distributes it an hour later. The web app reads the
 * same values to show the next payout in each visitor's local time.
 */
export const STAKE_SEND_REVENUE_UTC = { hour: 18, minute: 30 } as const;
export const STAKE_PAYOUT_UTC = { hour: 19, minute: 30 } as const;

/** Next payout time after `from`, following STAKE_PAYOUT_UTC. */
export function nextStakePayout(from: Date = new Date()): Date {
  const next = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      STAKE_PAYOUT_UTC.hour,
      STAKE_PAYOUT_UTC.minute,
    ),
  );
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Anchor account discriminator for `UserPda`. */
export const USER_PDA_DISCRIMINATOR = Buffer.from([
  182, 179, 144, 178, 135, 99, 143, 249,
]);

/** Current on-chain `UserPda` account size: discriminator + owner + 7 × u64. */
export const USER_PDA_ACCOUNT_SIZE = 8 + 32 + 56;

/** True if `address` is a known infrastructure account (exchange/pool/distributor). */
export function isInfraAddress(address: string): boolean {
  return KNOWN_INFRA_ADDRESSES.has(address);
}
