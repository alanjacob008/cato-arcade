import {
  CATO_MINT,
  CLAIM_PROGRAM_ID,
  DEFAULT_MAX_SIG_PAGES,
  ORIGINAL_AIRDROP_AMOUNT,
  STAKE_CATO_MINT,
  STAKE_PROGRAM_ID,
} from "./constants.js";

/**
 * Validated runtime configuration. Fails fast with a clear message when a
 * required variable is missing, so misconfiguration never surfaces as a
 * confusing downstream error.
 */
export interface AppEnv {
  heliusApiKey: string;
  databaseUrl: string;
  catoMint: string;
  gateThreshold: number;
  broadScanMaxPages: number;
  broadScanDisplayCutoff: number;
  /** Per-ATA page cap for the indexer's signature sweep (bounds infra accounts). */
  indexerMaxSigPages: number;
  priceSource: string;
  apiPort: number;
  webOrigin: string;
  /** Total Helius credit budget for the event (for the burn progress bar). */
  heliusCreditBudget: number;
  /** Credits already spent before this process started (read off the Helius dashboard). */
  heliusCreditsUsedStart: number;
  /**
   * How often (in minutes) the in-process swap backfill loop runs.
   * Set to 0 to disable the loop (useful if running backfill as a standalone cron job).
   * Default: 10 minutes.
   */
  swapBackfillIntervalMin: number;
  /** Staking backend configuration (optional — crons no-op when admin key is unset). */
  staking: StakingEnv;
  /** Miniclip on-chain claim payout configuration. */
  claim: ClaimEnv;
}

/** Server-side stake-rewards worker configuration. */
export interface StakingEnv {
  rpcUrl: string;
  programId: string;
  catoMint: string;
  /** JSON byte array (`[1,2,3,...]`) for the admin signer; null disables crons. */
  adminSecretKey: string | null;
  /** Whole CATO moved from admin wallet → revenue vault each daily cron tick. */
  revenueTransferCato: number;
}

export interface ClaimEnv {
  rpcUrl: string;
  programId: string;
  catoMint: string;
  adminSecretKey: string | null;
}

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function intWithDefault(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Environment variable ${name} must be a number, got "${value}".`);
  }
  return n;
}

function floatWithDefault(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative number, got "${value}".`);
  }
  return n;
}

/** Resolve the Solana RPC URL used by staking workers. */
export function resolveStakeRpcUrl(source: NodeJS.ProcessEnv, heliusApiKey: string): string {
  const explicit = source.STAKE_RPC_URL?.trim();
  if (explicit) return explicit;

  const raw = source.HELIUS_API_KEY?.trim() ?? heliusApiKey;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;

  return heliusRpcUrl(raw);
}

/** Read + validate the environment. Call once at process startup. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const heliusApiKey = required("HELIUS_API_KEY", source.HELIUS_API_KEY);

  return {
    heliusApiKey,
    databaseUrl: required("DATABASE_URL", source.DATABASE_URL),
    catoMint: source.CATO_MINT?.trim() || CATO_MINT,
    gateThreshold: intWithDefault("GATE_THRESHOLD", source.GATE_THRESHOLD, ORIGINAL_AIRDROP_AMOUNT),
    broadScanMaxPages: intWithDefault("BROAD_SCAN_MAX_PAGES", source.BROAD_SCAN_MAX_PAGES, 10),
    broadScanDisplayCutoff: intWithDefault(
      "BROAD_SCAN_DISPLAY_CUTOFF",
      source.BROAD_SCAN_DISPLAY_CUTOFF,
      10_000,
    ),
    indexerMaxSigPages: intWithDefault(
      "INDEXER_MAX_SIG_PAGES",
      source.INDEXER_MAX_SIG_PAGES,
      DEFAULT_MAX_SIG_PAGES,
    ),
    priceSource: source.PRICE_SOURCE?.trim() || "jupiter",
    // Heroku (and most PaaS) inject the bind port as PORT; honor it when API_PORT is unset.
    apiPort: intWithDefault("API_PORT", source.API_PORT ?? source.PORT, 8080),
    webOrigin: source.WEB_ORIGIN?.trim() || "http://localhost:3000",
    heliusCreditBudget: intWithDefault("HELIUS_CREDIT_BUDGET", source.HELIUS_CREDIT_BUDGET, 10_000_000),
    heliusCreditsUsedStart: intWithDefault("HELIUS_CREDITS_USED_START", source.HELIUS_CREDITS_USED_START, 0),
    swapBackfillIntervalMin: intWithDefault("SWAP_BACKFILL_INTERVAL_MIN", source.SWAP_BACKFILL_INTERVAL_MIN, 10),
    staking: {
      rpcUrl: resolveStakeRpcUrl(source, heliusApiKey),
      programId: source.STAKE_PROGRAM_ID?.trim() || STAKE_PROGRAM_ID,
      catoMint: source.STAKE_CATO_MINT?.trim() || STAKE_CATO_MINT,
      adminSecretKey: source.STAKE_ADMIN_SECRET_KEY?.trim() || null,
      revenueTransferCato: floatWithDefault("STAKE_REVENUE_TRANSFER_CATO", source.STAKE_REVENUE_TRANSFER_CATO, 100),
    },
    claim: {
      // Prefer CLAIM_* overrides; fall back to staking RPC/mint/admin for local/dev convenience.
      rpcUrl: source.CLAIM_RPC_URL?.trim() || resolveStakeRpcUrl(source, heliusApiKey),
      programId: source.CLAIM_PROGRAM_ID?.trim() || CLAIM_PROGRAM_ID,
      catoMint: source.CLAIM_CATO_MINT?.trim() || source.STAKE_CATO_MINT?.trim() || STAKE_CATO_MINT,
      adminSecretKey:
        source.CLAIM_ADMIN_SECRET_KEY?.trim() || source.STAKE_ADMIN_SECRET_KEY?.trim() || null,
    },
  };
}

/** Build the Helius mainnet RPC URL from the API key. */
export function heliusRpcUrl(apiKey: string): string {
  return `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
}

/** Build the Helius devnet RPC URL from the API key. */
export function heliusDevnetRpcUrl(apiKey: string): string {
  return `https://devnet.helius-rpc.com/?api-key=${apiKey}`;
}
