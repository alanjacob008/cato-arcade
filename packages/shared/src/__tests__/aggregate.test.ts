import { describe, it, expect } from "vitest";
import { aggregateHolder } from "../aggregate.js";
import type { CatoTx } from "../types.js";

const NOW = Date.parse("2026-06-17T00:00:00Z");

function ctx(kind: CatoTx["kind"], amount: number, ts: string, counterparty: string | null = null): CatoTx {
  return { sig: `${kind}-${ts}`, owner: "o", ts, kind, amount, counterparty };
}

describe("aggregateHolder", () => {
  it("sums buys, sells, net and biggest trades", () => {
    const txs = [
      ctx("buy", 1000, "2023-01-01T00:00:00Z"),
      ctx("buy", 3000, "2023-02-01T00:00:00Z"),
      ctx("sell", 500, "2023-03-01T00:00:00Z"),
    ];
    const agg = aggregateHolder(txs, { balance: 3500, nowMs: NOW });
    expect(agg.totalBought).toBe(4000);
    expect(agg.totalSold).toBe(500);
    expect(agg.net).toBe(3500);
    expect(agg.biggestBuy).toBe(3000);
    expect(agg.biggestSell).toBe(500);
    expect(agg.acquisitionType).toBe("bought");
    expect(agg.firstTx).toBe("2023-01-01T00:00:00Z");
    expect(agg.lastTx).toBe("2023-03-01T00:00:00Z");
    expect(agg.holdDays).toBeGreaterThan(1000);
  });

  it("flags an untouched 19,417 airdrop", () => {
    const txs = [ctx("airdrop_in", 19417, "2021-05-21T00:00:00Z", "dist")];
    const agg = aggregateHolder(txs, { balance: 19417, nowMs: NOW, airdropAmount: 19417 });
    expect(agg.untouchedAirdrop).toBe(true);
    expect(agg.acquisitionType).toBe("airdropped");
  });

  it("does not flag untouched airdrop when some was sold", () => {
    const txs = [
      ctx("airdrop_in", 19417, "2021-05-21T00:00:00Z", "dist"),
      ctx("sell", 1, "2024-01-01T00:00:00Z"),
    ];
    const agg = aggregateHolder(txs, { balance: 19416, nowMs: NOW, airdropAmount: 19417 });
    expect(agg.untouchedAirdrop).toBe(false);
  });

  it("classifies acquisition by the earliest inflow", () => {
    const txs = [
      ctx("transfer_in", 10, "2022-01-01T00:00:00Z"),
      ctx("buy", 100, "2023-01-01T00:00:00Z"),
    ];
    const agg = aggregateHolder(txs, { balance: 110, nowMs: NOW });
    expect(agg.acquisitionType).toBe("received");
  });

  it("returns zeroes for a holder with no txs", () => {
    const agg = aggregateHolder([], { balance: 0, nowMs: NOW });
    expect(agg.firstTx).toBeNull();
    expect(agg.holdDays).toBe(0);
    expect(agg.acquisitionType).toBe("unknown");
  });
});
