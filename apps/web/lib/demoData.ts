import type { GateResult, RevealPayload, ShareData } from "@cato/shared";

/**
 * Sample data for demo mode (NEXT_PUBLIC_DEMO=1) so the full UX is viewable
 * without the backend running. Numbers mirror the design-doc test wallet.
 */
const DEMO_STATS = {
  owner: "demo",
  totalBought: 340000,
  totalSold: 37487,
  net: 302513,
  balance: 302513,
  firstTx: "2023-01-15T00:00:00Z",
  lastTx: "2025-04-10T00:00:00Z",
  holdDays: 1248,
  acquisitionType: "bought" as const,
  untouchedAirdrop: false,
  biggestBuy: 120000,
  biggestSell: 25000,
  rankLongest: 167,
  pctBalance: 98.2,
  pctLoyalty: 91,
  source: "preindex" as const,
  indexedAt: "2026-06-17T00:00:00Z",
};

/** Deterministic demo activity over a date range so the calendar renders in demo mode. */
function demoTxByDay(startMs: number, endMs: number): Record<string, number> {
  const out: Record<string, number> = {};
  let seed = 7;
  for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const r = seed % 100;
    if (r < 62) continue; // ~38% of days have activity
    out[new Date(ms).toISOString().slice(0, 10)] = 1 + (seed % 14);
  }
  return out;
}

export function demoGate(_wallet: string): GateResult {
  return { status: "pass", balance: DEMO_STATS.balance };
}

/** A recently-arrived holder — exercises the newcomer (Solana-life-led) path. */
const DEMO_NEWCOMER_STATS = {
  ...DEMO_STATS,
  totalBought: 24000,
  totalSold: 0,
  net: 24000,
  balance: 24000,
  firstTx: "2026-05-08T00:00:00Z",
  lastTx: "2026-06-14T00:00:00Z",
  holdDays: 41,
  acquisitionType: "bought" as const,
  biggestBuy: 24000,
  biggestSell: 0,
  rankLongest: null,
  pctBalance: 38.0,
  pctLoyalty: null,
};

export function demoReveal(wallet: string, variant?: string): RevealPayload {
  if (variant === "newcomer") {
    return {
      wallet,
      stats: { ...DEMO_NEWCOMER_STATS, owner: wallet },
      recentTxs: [],
      bagUsd: 5.09,
      broad: {
        walletAgeDays: 180,
        firstTxMs: Date.UTC(2025, 11, 20),
        totalTxCount: 240,
        capped: false,
        activeDays: 58,
        failedTxCount: 4,
        txByDay: demoTxByDay(Date.UTC(2025, 11, 20), Date.UTC(2026, 5, 15)),
        sampleSize: 100,
        programsUsed: ["JUPITER", "RAYDIUM", "TENSOR"],
        typeBreakdown: { SWAP: 28, TRANSFER: 14, NFT_MINT: 3 },
        distinctTokens: 12,
        nftCount: 3,
        otherAirdrops: 1,
        feesPaidSol: 0.0512,
        solVolume: 14.2,
        portfolio: { nftCount: 3, collectionCount: 2, tokenCount: 9, solBalance: 1.13, capped: false },
        degraded: false,
      },
    };
  }

  if (variant === "none") {
    // Holds zero CATO but has a real Solana history — exercises the playful
    // non-holder tease + the Solana-life-led report.
    return {
      wallet,
      stats: {
        ...DEMO_NEWCOMER_STATS,
        owner: wallet,
        totalBought: 0,
        totalSold: 0,
        net: 0,
        balance: 0,
        firstTx: null,
        biggestBuy: 0,
        pctBalance: null,
      },
      recentTxs: [],
      bagUsd: null,
      broad: {
        walletAgeDays: 980,
        firstTxMs: Date.UTC(2023, 7, 12),
        totalTxCount: 1875,
        capped: false,
        activeDays: 211,
        failedTxCount: 17,
        txByDay: demoTxByDay(Date.UTC(2023, 7, 12), Date.UTC(2026, 5, 15)),
        sampleSize: 100,
        programsUsed: ["JUPITER", "RAYDIUM", "ORCA", "MAGIC_EDEN"],
        typeBreakdown: { SWAP: 38, TRANSFER: 21, NFT_SALE: 6 },
        distinctTokens: 29,
        nftCount: 8,
        otherAirdrops: 4,
        feesPaidSol: 0.231,
        solVolume: 64.7,
        portfolio: { nftCount: 9, collectionCount: 4, tokenCount: 18, solBalance: 3.04, capped: false },
        degraded: false,
      },
    };
  }

  if (variant === "degraded") {
    // OG CATO stats render; the broad Solana block failed to load.
    return {
      wallet,
      stats: { ...DEMO_STATS, owner: wallet },
      recentTxs: [],
      bagUsd: 64.13,
      broad: {
        walletAgeDays: null,
        firstTxMs: null,
        totalTxCount: 0,
        capped: false,
        activeDays: 0,
        failedTxCount: 0,
        txByDay: {},
        sampleSize: 0,
        programsUsed: [],
        typeBreakdown: {},
        distinctTokens: 0,
        nftCount: 0,
        otherAirdrops: 0,
        feesPaidSol: 0,
        solVolume: 0,
        portfolio: null,
        degraded: true,
      },
    };
  }

  return {
    wallet,
    stats: { ...DEMO_STATS, owner: wallet },
    recentTxs: [],
    bagUsd: 64.13,
    broad: {
      walletAgeDays: 1280,
      firstTxMs: Date.UTC(2023, 0, 10),
      totalTxCount: 5516,
      capped: false,
      activeDays: 412,
      failedTxCount: 38,
      txByDay: demoTxByDay(Date.UTC(2023, 0, 10), Date.UTC(2026, 5, 15)),
      sampleSize: 100,
      programsUsed: ["RAYDIUM", "JUPITER", "ORCA", "MAGIC_EDEN", "TENSOR"],
      typeBreakdown: { SWAP: 41, TRANSFER: 33, NFT_SALE: 12, NFT_MINT: 8, STAKE: 6 },
      distinctTokens: 37,
      nftCount: 12,
      otherAirdrops: 7,
      feesPaidSol: 0.4213,
      solVolume: 128.55,
      portfolio: {
        nftCount: 14,
        collectionCount: 6,
        tokenCount: 23,
        solBalance: 4.82,
        capped: false,
      },
      degraded: false,
    },
  };
}

export function demoShare(wallet: string): ShareData {
  return {
    wallet,
    ogSince: DEMO_STATS.firstTx,
    solanaSince: new Date(Date.UTC(2022, 8, 3)).toISOString(),
    rankLongest: DEMO_STATS.rankLongest,
    pctBalance: DEMO_STATS.pctBalance,
    pctLoyalty: DEMO_STATS.pctLoyalty,
    untouchedAirdrop: DEMO_STATS.untouchedAirdrop,
    balance: DEMO_STATS.balance,
    bagUsd: 64.13,
  };
}
