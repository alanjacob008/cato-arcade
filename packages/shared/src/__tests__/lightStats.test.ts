import { describe, it, expect } from "vitest";
import { computeLightStats } from "../aggregate.js";

const NOW = Date.parse("2026-06-17T00:00:00Z");
const JAN_2023 = Math.floor(Date.parse("2023-01-15T00:00:00Z") / 1000);
const APR_2025 = Math.floor(Date.parse("2025-04-10T00:00:00Z") / 1000);

describe("computeLightStats", () => {
  it("derives first/last/count/holdDays from signature block times", () => {
    const s = computeLightStats([APR_2025, JAN_2023, 1_700_000_000], { balance: 50000, nowMs: NOW });
    expect(s.txCount).toBe(3);
    expect(s.balance).toBe(50000);
    expect(Date.parse(s.firstTx!)).toBe(JAN_2023 * 1000);
    expect(Date.parse(s.lastTx!)).toBe(APR_2025 * 1000);
    expect(s.holdDays).toBeGreaterThan(1000);
  });

  it("counts sigs with null block time but ignores them for dates", () => {
    const s = computeLightStats([JAN_2023, null], { balance: 1, nowMs: NOW });
    expect(s.txCount).toBe(2);
    expect(Date.parse(s.firstTx!)).toBe(JAN_2023 * 1000);
  });

  it("handles a holder with no signatures", () => {
    const s = computeLightStats([], { balance: 184, nowMs: NOW });
    expect(s.txCount).toBe(0);
    expect(s.firstTx).toBeNull();
    expect(s.holdDays).toBe(0);
  });
});
