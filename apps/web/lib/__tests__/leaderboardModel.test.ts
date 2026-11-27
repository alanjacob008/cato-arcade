import { describe, it, expect } from "vitest";
import type { Leaderboard, LeaderboardEntry } from "@cato/shared";
import { buildBoards } from "../leaderboardModel";

function entry(over: Partial<LeaderboardEntry>): LeaderboardEntry {
  return {
    wallet: "5p2zjqCd1WJzAVgcEnjhb9zWDU7b9XVhFhx4usiyN7jB",
    balance: 100000,
    holdDays: 500,
    firstTx: "2023-01-15T00:00:00Z",
    pctLoyalty: 50,
    untouchedAirdrop: false,
    ...over,
  };
}

const lb: Leaderboard = {
  totalCats: 3,
  entries: [
    entry({ wallet: "AAAA", balance: 900, holdDays: 100, pctLoyalty: 10 }),
    entry({ wallet: "BBBB", balance: 100, holdDays: 900, pctLoyalty: 99, untouchedAirdrop: true }),
    entry({ wallet: "CCCC", balance: 500, holdDays: 500, pctLoyalty: null }),
  ],
};

describe("buildBoards", () => {
  it("returns the three boards", () => {
    expect(buildBoards(lb).map((b) => b.key)).toEqual(["longest", "bag", "loyal"]);
  });

  it("ranks longest by holdDays, biggest by balance", () => {
    const [longest, bag] = buildBoards(lb);
    expect(longest!.rows[0]!.value).toBe("900 days"); // BBBB
    expect(bag!.rows[0]!.value).toContain("900"); // AAAA, biggest balance
    expect(longest!.rows[0]!.rank).toBe(1);
  });

  it("excludes null-loyalty entries from the loyal board", () => {
    const loyal = buildBoards(lb).find((b) => b.key === "loyal")!;
    expect(loyal.rows).toHaveLength(2); // CCCC (null) dropped
    expect(loyal.rows[0]!.value).toBe("99%");
    expect(loyal.rows[0]!.highlight).toBe(true); // BBBB has untouched airdrop
  });
});
