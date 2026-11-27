import { describe, it, expect } from "vitest";
import { buildShareMetadata } from "../metadata";
import type { ShareData } from "@cato/shared";

const data: ShareData = {
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

describe("buildShareMetadata", () => {
  it("points the OG + Twitter image at the wallet's opengraph-image route", () => {
    const m = buildShareMetadata(data, "https://cato.example.com");
    const expected = `https://cato.example.com/w/${data.wallet}/opengraph-image`;
    expect(m.openGraph.images).toEqual([expected]);
    expect(m.twitter.images).toEqual([expected]);
    expect(m.twitter.card).toBe("summary_large_image");
  });

  it("trims a trailing slash on the base URL", () => {
    const m = buildShareMetadata(data, "https://cato.example.com/");
    expect(m.openGraph.images[0]).toBe(`https://cato.example.com/w/${data.wallet}/opengraph-image`);
  });

  it("builds a human description from the headline stats", () => {
    const m = buildShareMetadata(data, "https://x.com");
    expect(m.description).toContain("OG since Jan 2023");
    expect(m.description).toContain("Top 1.8% by balance");
  });
});
