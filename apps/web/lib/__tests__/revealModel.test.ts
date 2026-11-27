import { describe, it, expect } from "vitest";
import { buildGateView, buildRevealCards } from "../revealModel";
import { isValidWallet } from "../walletValidation";
import type { BroadActivity, HolderStats, RevealPayload } from "@cato/shared";

const stats: HolderStats = {
  owner: "w", totalBought: 40000, totalSold: 5000, net: 35000, balance: 35000, firstTx: "2023-01-15T00:00:00Z",
  lastTx: "2025-04-10T00:00:00Z", holdDays: 1200, acquisitionType: "bought", untouchedAirdrop: false,
  biggestBuy: 20000, biggestSell: 5000, rankLongest: 42, pctBalance: 98.2, pctLoyalty: 95, source: "preindex", indexedAt: "2026-06-17T00:00:00Z",
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

function payload(over: Partial<RevealPayload> = {}): RevealPayload {
  return {
    wallet: "w",
    stats,
    recentTxs: [],
    bagUsd: 7.5,
    broad: broad(),
    ...over,
  };
}

describe("buildGateView", () => {
  it("below threshold references the airdrop target, the shortfall, and offers a swap CTA", () => {
    const v = buildGateView({ status: "below", balance: 1000, needed: 18417 });
    expect(v.kind).toBe("below");
    expect(v.detail).toContain("18,417"); // shortfall
    expect(v.detail).toContain("19,417"); // target = balance + needed (the airdrop stash)
    expect(v.detail).toMatch(/airdrop/i);
    expect(v.cta).toEqual({ label: "Swap into $CATO 🐈", href: "/swap" });
  });
  it("never-held cites the airdrop amount and offers a swap CTA", () => {
    const v = buildGateView({ status: "never", balance: 0 });
    expect(v.kind).toBe("never");
    expect(v.detail).toMatch(/never held/i);
    expect(v.detail).toContain("19,417");
    expect(v.cta?.href).toBe("/swap");
  });
  it("pass acknowledges, proceeds, and has no CTA", () => {
    const v = buildGateView({ status: "pass", balance: 50000 });
    expect(v.kind).toBe("pass");
    expect(v.cta).toBeUndefined();
  });
});

describe("buildRevealCards", () => {
  it("returns the CATO + broad/Solana card families", () => {
    const cards = buildRevealCards(payload());
    expect(cards.map((c) => c.key)).toEqual([
      "acquisition",
      "loyalty",
      "rankings",
      "solanaLife",
      "activityProfile",
      "portfolio",
    ]);
  });

  it("adds the untouched-airdrop badge when flagged", () => {
    const cards = buildRevealCards(payload({ stats: { ...stats, untouchedAirdrop: true } }));
    const loyalty = cards.find((c) => c.key === "loyalty")!;
    expect(loyalty.items.some((i) => i.value.includes("19,417"))).toBe(true);
  });

  it("surfaces an 'On Solana since' year from the first tx", () => {
    const cards = buildRevealCards(payload({ broad: broad({ firstTxMs: Date.UTC(2021, 0, 1) }) }));
    const life = cards.find((c) => c.key === "solanaLife")!;
    expect(life.items.find((i) => i.label === "On Solana since")?.value).toBe("2021");
  });

  it("drops the portfolio card when DAS data is unavailable", () => {
    const cards = buildRevealCards(payload({ broad: broad({ portfolio: null }) }));
    expect(cards.find((c) => c.key === "portfolio")).toBeUndefined();
  });

  it("renders a graceful note when the broad block is degraded", () => {
    const cards = buildRevealCards(payload({ broad: broad({ degraded: true }) }));
    const life = cards.find((c) => c.key === "solanaLife")!;
    expect(life.items).toHaveLength(0);
    expect(life.note).toMatch(/couldn't load/i);
    expect(cards.find((c) => c.key === "activityProfile")).toBeUndefined();
  });

  it("marks a capped transaction count with a +", () => {
    const cards = buildRevealCards(payload({ broad: broad({ capped: true, totalTxCount: 10000 }) }));
    const life = cards.find((c) => c.key === "solanaLife")!;
    expect(life.items.find((i) => i.label === "Total transactions")?.value).toBe("10,000+");
  });
});

describe("isValidWallet", () => {
  it("accepts a real base58 address and rejects junk", () => {
    expect(isValidWallet("5p2zjqCd1WJzAVgcEnjhb9zWDU7b9XVhFhx4usiyN7jB")).toBe(true);
    expect(isValidWallet("not a wallet")).toBe(false);
    expect(isValidWallet("0OIl000")).toBe(false);
  });
});
