import { describe, it, expect } from "vitest";
import type { BroadActivity, HolderStats, RevealPayload } from "@cato/shared";
import {
  buildWrappedScenes,
  classifyArchetype,
  NEWCOMER_MAX_HOLD_DAYS,
  OG_RANK_MAX,
} from "../wrappedModel";

const baseStats: HolderStats = {
  owner: "w",
  totalBought: 40000,
  totalSold: 5000,
  net: 35000,
  balance: 35000,
  firstTx: "2023-06-15T00:00:00Z",
  lastTx: "2025-04-10T00:00:00Z",
  holdDays: 700,
  acquisitionType: "bought",
  untouchedAirdrop: false,
  biggestBuy: 20000,
  biggestSell: 5000,
  rankLongest: 5000,
  pctBalance: 80,
  pctLoyalty: 50,
  source: "preindex",
  indexedAt: "2026-06-17T00:00:00Z",
};

function broad(over: Partial<BroadActivity> = {}): BroadActivity {
  return {
    walletAgeDays: 1300,
    firstTxMs: Date.UTC(2022, 5, 1),
    totalTxCount: 512,
    capped: false,
    activeDays: 200,
    failedTxCount: 5,
    txByDay: { "2023-01-15": 3 },
    sampleSize: 100,
    programsUsed: ["RAYDIUM", "JUPITER"],
    typeBreakdown: { SWAP: 10, TRANSFER: 5 },
    distinctTokens: 12,
    nftCount: 4,
    otherAirdrops: 2,
    feesPaidSol: 0.1,
    solVolume: 5,
    portfolio: { nftCount: 7, collectionCount: 3, tokenCount: 9, solBalance: 2.5, capped: false },
    degraded: false,
    ...over,
  };
}

function payload(stats: Partial<HolderStats> = {}, over: Partial<RevealPayload> = {}): RevealPayload {
  return {
    wallet: "w",
    stats: { ...baseStats, ...stats },
    recentTxs: [],
    bagUsd: 7.5,
    broad: broad(),
    ...over,
  };
}

describe("classifyArchetype", () => {
  it("flags genesis-era first CATO tx as OG", () => {
    expect(classifyArchetype({ ...baseStats, firstTx: "2022-12-31T00:00:00Z" })).toBe("og");
    // …but one day later (and no other OG signal) is not date-OG
    expect(
      classifyArchetype({ ...baseStats, firstTx: "2023-01-01T00:00:00Z", rankLongest: 5000, pctLoyalty: 50 }),
    ).toBe("mid");
  });

  it("untouched airdrop overrides a low holdDays", () => {
    expect(classifyArchetype({ ...baseStats, untouchedAirdrop: true, holdDays: 3, rankLongest: null })).toBe("og");
  });

  it("treats the rank boundary as inclusive", () => {
    expect(classifyArchetype({ ...baseStats, firstTx: "2024-01-01T00:00:00Z", rankLongest: OG_RANK_MAX, pctLoyalty: 10 })).toBe("og");
    expect(classifyArchetype({ ...baseStats, firstTx: "2024-01-01T00:00:00Z", rankLongest: OG_RANK_MAX + 1, pctLoyalty: 10 })).toBe("mid");
  });

  it("classifies short tenure / null rank / null firstTx as newcomer", () => {
    expect(classifyArchetype({ ...baseStats, firstTx: "2026-05-01T00:00:00Z", holdDays: NEWCOMER_MAX_HOLD_DAYS - 1, rankLongest: null, pctLoyalty: null })).toBe("newcomer");
    expect(classifyArchetype({ ...baseStats, firstTx: null, holdDays: 999, rankLongest: 2000, pctLoyalty: 10 })).toBe("newcomer");
    expect(classifyArchetype({ ...baseStats, firstTx: "2024-01-01T00:00:00Z", holdDays: 999, rankLongest: null, pctLoyalty: 10 })).toBe("newcomer");
  });

  it("holdDays exactly at the newcomer threshold is not a newcomer", () => {
    expect(classifyArchetype({ ...baseStats, firstTx: "2024-01-01T00:00:00Z", holdDays: NEWCOMER_MAX_HOLD_DAYS, rankLongest: 3000, pctLoyalty: 10 })).toBe("mid");
  });
});

describe("buildWrappedScenes", () => {
  it("orders the OG story loyalty-first", () => {
    const keys = buildWrappedScenes(payload({ pctLoyalty: 95 })).map((s) => s.kind);
    expect(keys).toEqual(["intro", "ogTimeline", "conviction", "rank", "bag", "solanaLife", "calendar", "share"]);
  });

  it("leads newcomers with Solana life and never includes rank", () => {
    const keys = buildWrappedScenes(payload({ firstTx: "2026-05-01T00:00:00Z", holdDays: 40, rankLongest: null, pctLoyalty: null })).map((s) => s.kind);
    expect(keys[1]).toBe("solanaLife");
    expect(keys).not.toContain("rank");
  });

  it("drops a newcomer's ogTimeline when firstTx is null", () => {
    const keys = buildWrappedScenes(payload({ firstTx: null, holdDays: 40, rankLongest: null, pctLoyalty: null })).map((s) => s.kind);
    expect(keys).not.toContain("ogTimeline");
  });

  it("skips solanaLife and calendar when broad is degraded, keeping CATO scenes", () => {
    const keys = buildWrappedScenes(payload({ pctLoyalty: 95 }, { broad: broad({ degraded: true, txByDay: {} }) })).map((s) => s.kind);
    expect(keys).not.toContain("solanaLife");
    expect(keys).not.toContain("calendar");
    expect(keys).toContain("ogTimeline");
    expect(keys[0]).toBe("intro");
    expect(keys[keys.length - 1]).toBe("share");
  });

  it("skips the rank scene only when every ranking is null", () => {
    const withRank = buildWrappedScenes(payload({ pctLoyalty: 95, rankLongest: null, pctBalance: 80 })).map((s) => s.kind);
    expect(withRank).toContain("rank");
    const noRank = buildWrappedScenes(payload({ pctLoyalty: null, rankLongest: null, pctBalance: null, untouchedAirdrop: true })).map((s) => s.kind);
    expect(noRank).not.toContain("rank");
  });

  it("flags holdsNone on intro + share when the wallet holds 0 CATO", () => {
    const none = buildWrappedScenes(payload({ balance: 0, firstTx: null, rankLongest: null, pctLoyalty: null }));
    const intro = none.find((s) => s.kind === "intro");
    const share = none.find((s) => s.kind === "share");
    expect(intro && "holdsNone" in intro && intro.holdsNone).toBe(true);
    expect(share && "holdsNone" in share && share.holdsNone).toBe(true);

    const held = buildWrappedScenes(payload({ balance: 35000 }));
    const heldIntro = held.find((s) => s.kind === "intro");
    expect(heldIntro && "holdsNone" in heldIntro && heldIntro.holdsNone).toBe(false);
  });

  it("always returns at least intro + share for a near-empty wallet", () => {
    const keys = buildWrappedScenes(
      payload(
        { firstTx: null, holdDays: 0, balance: 0, totalBought: 0, totalSold: 0, rankLongest: null, pctBalance: null, pctLoyalty: null, untouchedAirdrop: false },
        { bagUsd: null, broad: broad({ degraded: true, txByDay: {}, totalTxCount: 0 }) },
      ),
    ).map((s) => s.kind);
    expect(keys).toEqual(["intro", "share"]);
  });
});
