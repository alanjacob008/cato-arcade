import type { AcquisitionType, RevealPayload, HolderStats } from "@cato/shared";

/**
 * Adaptive scene model for the CATO Wrapped scrollytelling reveal.
 *
 * Pure + React-free so it can be unit-tested without a DOM. Scenes carry RAW
 * numbers (not formatted strings) so the count-up animation can tween them;
 * formatting happens at render time via the helpers in `shareModel.ts`.
 */

/** CATO was minted on 2021-05-16 — the nostalgia anchor for the OG timeline ribbon. */
export const CATO_GENESIS_ISO = "2021-05-16";

// Archetype thresholds (exported so tests assert on behavior at the boundaries).
export const OG_FIRST_TX_CUTOFF_ISO = "2022-12-31"; // first CATO tx on/before this ⇒ genesis-era OG
export const OG_RANK_MAX = 1000; // top longest-holder rank ⇒ OG
export const OG_LOYALTY_PCT = 90; // pctLoyalty ≥ this ⇒ OG
export const NEWCOMER_MAX_HOLD_DAYS = 90; // held < this ⇒ newcomer

export type Archetype = "og" | "mid" | "newcomer";

export type SceneKind =
  | "intro"
  | "ogTimeline"
  | "bag"
  | "conviction"
  | "rank"
  | "solanaLife"
  | "calendar"
  | "share";

export interface IntroScene {
  kind: "intro";
  key: string;
  archetype: Archetype;
  wallet: string;
  firstTxIso: string | null;
  holdDays: number;
  holdsNone: boolean; // wallet currently holds 0 CATO — gets a playful tease
}
export interface OgTimelineScene {
  kind: "ogTimeline";
  key: string;
  firstTxIso: string; // guaranteed non-null (inclusion predicate guards it)
  holdDays: number;
  pctLoyalty: number | null;
  genesisIso: string;
}
export interface BagScene {
  kind: "bag";
  key: string;
  balance: number;
  bagUsd: number | null;
  net: number;
}
export interface ConvictionScene {
  kind: "conviction";
  key: string;
  totalBought: number;
  totalSold: number;
  net: number;
  biggestBuy: number;
  untouchedAirdrop: boolean;
  acquisitionType: AcquisitionType;
}
export interface RankScene {
  kind: "rank";
  key: string;
  rankLongest: number | null;
  pctBalance: number | null;
  pctLoyalty: number | null;
}
export interface SolanaLifeScene {
  kind: "solanaLife";
  key: string;
  firstTxMs: number | null;
  walletAgeDays: number | null;
  totalTxCount: number;
  capped: boolean;
  activeDays: number;
  programsUsed: string[];
  distinctTokens: number;
  nftCount: number;
}
export interface CalendarScene {
  kind: "calendar";
  key: string;
  txByDay: Record<string, number>;
}
export interface ShareScene {
  kind: "share";
  key: string;
  wallet: string;
  untouchedAirdrop: boolean;
  holdsNone: boolean;
}

export type Scene =
  | IntroScene
  | OgTimelineScene
  | BagScene
  | ConvictionScene
  | RankScene
  | SolanaLifeScene
  | CalendarScene
  | ShareScene;

/** Lead with the holder's strongest story, always end on share. */
const ORDER: Record<Archetype, SceneKind[]> = {
  og: ["intro", "ogTimeline", "conviction", "rank", "bag", "solanaLife", "calendar", "share"],
  mid: ["intro", "ogTimeline", "bag", "rank", "conviction", "solanaLife", "calendar", "share"],
  // Newcomers: no rank, ogTimeline never leads (and drops out entirely if firstTx is null).
  newcomer: ["intro", "solanaLife", "bag", "conviction", "ogTimeline", "calendar", "share"],
};

/**
 * Classify a holder. OG wins on any strong loyalty signal; newcomer is the
 * "short tenure / no rank / never bought CATO before" case the design wants to
 * steer toward Solana-life metrics instead of empty loyalty rows.
 */
export function classifyArchetype(stats: HolderStats): Archetype {
  const isOg =
    stats.untouchedAirdrop ||
    (stats.firstTx !== null && stats.firstTx.slice(0, 10) <= OG_FIRST_TX_CUTOFF_ISO) ||
    (stats.rankLongest !== null && stats.rankLongest <= OG_RANK_MAX) ||
    (stats.pctLoyalty !== null && stats.pctLoyalty >= OG_LOYALTY_PCT);
  if (isOg) return "og";

  const isNewcomer =
    stats.holdDays < NEWCOMER_MAX_HOLD_DAYS || stats.firstTx === null || stats.rankLongest === null;
  return isNewcomer ? "newcomer" : "mid";
}

/** A scene is dropped when its core data is null/empty/degraded. */
function includable(kind: SceneKind, p: RevealPayload): boolean {
  const s = p.stats;
  const b = p.broad;
  switch (kind) {
    case "intro":
    case "share":
      return true; // always present ⇒ a near-empty wallet still gets a coherent page
    case "ogTimeline":
      return s.firstTx !== null;
    case "bag":
      return s.balance > 0;
    case "conviction":
      return s.totalBought > 0 || s.totalSold > 0 || s.untouchedAirdrop;
    case "rank":
      return s.rankLongest !== null || s.pctBalance !== null || s.pctLoyalty !== null;
    case "solanaLife":
      return !b.degraded && b.totalTxCount > 0;
    case "calendar":
      return !b.degraded && Object.keys(b.txByDay).length > 0;
  }
}

function makeScene(kind: SceneKind, p: RevealPayload, archetype: Archetype): Scene {
  const s = p.stats;
  const b = p.broad;
  switch (kind) {
    case "intro":
      return { kind, key: kind, archetype, wallet: p.wallet, firstTxIso: s.firstTx, holdDays: s.holdDays, holdsNone: s.balance <= 0 };
    case "ogTimeline":
      return {
        kind,
        key: kind,
        firstTxIso: s.firstTx!, // guarded by includable()
        holdDays: s.holdDays,
        pctLoyalty: s.pctLoyalty,
        genesisIso: CATO_GENESIS_ISO,
      };
    case "bag":
      return { kind, key: kind, balance: s.balance, bagUsd: p.bagUsd, net: s.net };
    case "conviction":
      return {
        kind,
        key: kind,
        totalBought: s.totalBought,
        totalSold: s.totalSold,
        net: s.net,
        biggestBuy: s.biggestBuy,
        untouchedAirdrop: s.untouchedAirdrop,
        acquisitionType: s.acquisitionType,
      };
    case "rank":
      return { kind, key: kind, rankLongest: s.rankLongest, pctBalance: s.pctBalance, pctLoyalty: s.pctLoyalty };
    case "solanaLife":
      return {
        kind,
        key: kind,
        firstTxMs: b.firstTxMs,
        walletAgeDays: b.walletAgeDays,
        totalTxCount: b.totalTxCount,
        capped: b.capped,
        activeDays: b.activeDays,
        programsUsed: b.programsUsed,
        distinctTokens: b.distinctTokens,
        nftCount: b.nftCount,
      };
    case "calendar":
      return { kind, key: kind, txByDay: b.txByDay };
    case "share":
      return { kind, key: kind, wallet: p.wallet, untouchedAirdrop: s.untouchedAirdrop, holdsNone: s.balance <= 0 };
  }
}

/** Build the ordered, archetype-adaptive list of scenes for the reveal. */
export function buildWrappedScenes(p: RevealPayload): Scene[] {
  const archetype = classifyArchetype(p.stats);
  return ORDER[archetype].filter((kind) => includable(kind, p)).map((kind) => makeScene(kind, p, archetype));
}
