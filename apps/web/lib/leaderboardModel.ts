import type { Leaderboard, LeaderboardEntry } from "@cato/shared";
import { formatCato, ogSinceLabel, shortWallet } from "./shareModel";

export interface BoardRow {
  rank: number;
  wallet: string; // shortened
  value: string;
  sub?: string;
  highlight?: boolean; // untouched OG airdrop — gets a 💎
}
export interface Board {
  key: string;
  title: string;
  blurb: string;
  rows: BoardRow[];
}

const TOP = 10;

function ogSub(e: LeaderboardEntry): string | undefined {
  return e.firstTx ? ogSinceLabel(e.firstTx) : undefined;
}

function row(i: number, e: LeaderboardEntry, value: string, sub?: string): BoardRow {
  return { rank: i + 1, wallet: shortWallet(e.wallet), value, sub, highlight: e.untouchedAirdrop };
}

/**
 * Derive the three leaderboard boards from the (balance-ordered) entries.
 * Pure so it's unit-testable; the page just renders the result.
 */
export function buildBoards(lb: Leaderboard): Board[] {
  const e = lb.entries;
  const byHold = [...e].sort((a, b) => b.holdDays - a.holdDays || b.balance - a.balance).slice(0, TOP);
  const byBag = [...e].sort((a, b) => b.balance - a.balance).slice(0, TOP);
  const byLoyal = e
    .filter((x) => x.pctLoyalty !== null)
    .sort((a, b) => (b.pctLoyalty ?? 0) - (a.pctLoyalty ?? 0) || b.holdDays - a.holdDays)
    .slice(0, TOP);

  return [
    {
      key: "longest",
      title: "Longest holding",
      blurb: "OG cats who've held the longest",
      rows: byHold.map((x, i) => row(i, x, `${x.holdDays.toLocaleString()} days`, ogSub(x))),
    },
    {
      key: "bag",
      title: "Biggest bags",
      blurb: "The chunkiest $CATO stacks",
      rows: byBag.map((x, i) => row(i, x, formatCato(x.balance), ogSub(x))),
    },
    {
      key: "loyal",
      title: "Most loyal",
      blurb: "Diamond paws by loyalty score",
      rows: byLoyal.map((x, i) => row(i, x, `${Math.round(x.pctLoyalty ?? 0)}%`, `${x.holdDays.toLocaleString()} days held`)),
    },
  ];
}
