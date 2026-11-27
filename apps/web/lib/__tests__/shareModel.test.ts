import { describe, it, expect } from "vitest";
import { buildCollectibleCard, buildShareCard, fallbackCard, shortWallet, formatUsd, ogSinceLabel, topPercentLabel } from "../shareModel";
import type { ShareData } from "@cato/shared";

const base: ShareData = {
  wallet: "5p2zjqCd1WJzAVgcEnjhb9zWDU7b9XVhFhx4usiyN7jB",
  ogSince: "2023-01-15T00:00:00Z",
  solanaSince: "2022-09-03T00:00:00Z",
  rankLongest: 42,
  pctBalance: 98.2,
  pctLoyalty: 91,
  untouchedAirdrop: false,
  balance: 302513,
  bagUsd: 12.34,
};

describe("formatting helpers", () => {
  it("shortens long wallets", () => {
    expect(shortWallet(base.wallet)).toBe("5p2z…N7jB");
  });
  it("formats USD and returns null when absent", () => {
    expect(formatUsd(12.34)).toBe("$12.34");
    expect(formatUsd(null)).toBeNull();
  });
  it("labels OG-since and not-a-cat", () => {
    expect(ogSinceLabel("2023-01-15T00:00:00Z")).toBe("OG since Jan 2023");
    expect(ogSinceLabel(null)).toBe("Not a cat yet");
  });
  it("derives top-percent from balance percentile", () => {
    expect(topPercentLabel(98.2)).toBe("Top 1.8% by balance");
    expect(topPercentLabel(null)).toBeNull();
  });
});

describe("buildShareCard", () => {
  it("includes holding, bag, loyalty, rank lines", () => {
    const card = buildShareCard(base);
    const labels = card.lines.map((l) => l.label);
    expect(labels).toContain("Holding");
    expect(labels).toContain("Bag value");
    expect(labels).toContain("Loyalty");
    expect(labels).toContain("Longest-holder rank");
    expect(card.badge).toBeNull();
  });

  it("shows the untouched-airdrop badge when flagged", () => {
    const card = buildShareCard({ ...base, untouchedAirdrop: true });
    expect(card.badge).toContain("Untouched OG Airdrop");
  });

  it("omits the bag line when price is unavailable", () => {
    const card = buildShareCard({ ...base, bagUsd: null });
    expect(card.lines.map((l) => l.label)).not.toContain("Bag value");
  });

  it("fallback card is generic and has no wallet", () => {
    const card = fallbackCard();
    expect(card.wallet).toBe("");
    expect(card.lines[0]?.value).toMatch(/unwrap/i);
  });
});

describe("buildCollectibleCard", () => {
  it("shows identity stats — Solana-since, OG-since, loyalty, top-%% — and no USD", () => {
    const card = buildCollectibleCard(base);
    const labels = card.stats.map((s) => s.label);
    expect(labels).toContain("On Solana since");
    expect(labels).toContain("$CATO OG since");
    expect(labels).toContain("More loyal than");
    expect(labels).toContain("By balance");
    expect(labels).not.toContain("Bag value");
    expect(card.stats.some((s) => s.value.startsWith("$"))).toBe(false);
    expect(card.stats.find((s) => s.label === "On Solana since")?.value).toBe("2022");
    expect(card.stats.find((s) => s.label === "By balance")?.value).toBe("Top 1.8%");
    expect(card.tier).toBe("OG CAT");
  });

  it("drops stats whose data is null", () => {
    const card = buildCollectibleCard({ ...base, solanaSince: null, pctLoyalty: null, rankLongest: null });
    const labels = card.stats.map((s) => s.label);
    expect(labels).not.toContain("On Solana since");
    expect(labels).not.toContain("More loyal than");
    expect(labels).not.toContain("Longest holder");
    expect(labels).toContain("$CATO held");
  });
});
