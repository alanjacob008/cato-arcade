import type { AcquisitionType, BroadActivity, GateResult, RevealPayload } from "@cato/shared";
import { formatCato, formatUsd, ogSinceLabel, topPercentLabel } from "./shareModel";

/** The original May-2021 CATO airdrop amount (mirrors ORIGINAL_AIRDROP_AMOUNT in @cato/shared). */
const ORIGINAL_AIRDROP_AMOUNT = 19_417;

export interface GateView {
  kind: GateResult["status"];
  headline: string;
  detail: string;
  /** Optional call-to-action shown under the message (e.g. swap into CATO). */
  cta?: { label: string; href: string };
}

const SWAP_CTA = { label: "Swap into $CATO 🐈", href: "/swap" } as const;

/** Map a gate result to the message the home screen shows (design §7.1). */
export function buildGateView(result: GateResult): GateView {
  switch (result.status) {
    case "pass":
      return {
        kind: "pass",
        headline: "You're a certified cat 🐈",
        detail: `Holding ${formatCato(result.balance)}. Unwrapping your year…`,
      };
    case "below": {
      // Gate = hold the original 2021 airdrop stash. Show the exact target (balance + needed)
      // so the copy stays correct even if the threshold is ever retuned.
      const threshold = result.balance + result.needed;
      return {
        kind: "below",
        headline: "Almost a cat 🐈",
        detail:
          `To see your CATO Wrapped you need to hold the original 2021 airdrop stash of ${formatCato(threshold)}. ` +
          `You're holding ${formatCato(result.balance)}, so you're ${formatCato(result.needed)} short.`,
        cta: SWAP_CTA,
      };
    }
    case "never":
      return {
        kind: "never",
        headline: "Not a cat yet 🙀",
        detail:
          `This wallet has never held CATO. You need to hold the original 2021 airdrop amount ` +
          `(${formatCato(ORIGINAL_AIRDROP_AMOUNT)}) to unlock your Wrapped.`,
        cta: SWAP_CTA,
      };
  }
}

export interface RevealCard {
  key: string;
  title: string;
  items: Array<{ label: string; value: string }>;
  note?: string;
}

function acquisitionLabel(t: AcquisitionType): string {
  switch (t) {
    case "bought":
      return "Bought on a DEX";
    case "airdropped":
      return "Airdropped to you";
    case "received":
      return "Received via transfer";
    default:
      return "Unknown";
  }
}

function yearFromMs(ms: number | null): string | null {
  return ms === null ? null : String(new Date(ms).getUTCFullYear());
}

function formatSol(n: number): string {
  if (n <= 0) return "0 SOL";
  return `${n < 1 ? n.toFixed(4) : n.toFixed(2)} SOL`;
}

/** Prettify a Helius tx type (e.g. NFT_SALE -> "Nft sale") for display. */
function prettyType(t: string): string {
  const s = t.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** All the broad / "years on Solana" panels (each its own card so we can keep/cut later). */
function buildBroadCards(b: BroadActivity): RevealCard[] {
  if (b.degraded) {
    return [
      {
        key: "solanaLife",
        title: "Your Solana Life",
        items: [],
        note: "Couldn't load your broad Solana activity right now. Your CATO stats above are all here.",
      },
    ];
  }

  const solanaLife: RevealCard = {
    key: "solanaLife",
    title: "Your Solana Life",
    items: [
      ...(yearFromMs(b.firstTxMs) ? [{ label: "On Solana since", value: yearFromMs(b.firstTxMs)! }] : []),
      { label: "Wallet age", value: b.walletAgeDays !== null ? `${b.walletAgeDays.toLocaleString()} days` : "unknown" },
      { label: "Total transactions", value: b.capped ? `${b.totalTxCount.toLocaleString()}+` : b.totalTxCount.toLocaleString() },
      { label: "Active days", value: b.activeDays.toLocaleString() },
      { label: "Failed transactions", value: b.failedTxCount.toLocaleString() },
    ],
  };

  const topTypes = Object.entries(b.typeBreakdown)
    .sort((a, c) => c[1] - a[1])
    .slice(0, 5)
    .map(([t, n]) => ({ label: prettyType(t), value: n.toLocaleString() }));

  const activityProfile: RevealCard = {
    key: "activityProfile",
    title: "Recent Activity Profile",
    note: b.sampleSize > 0 ? `Based on your ${b.sampleSize.toLocaleString()} most recent transactions.` : undefined,
    items: [
      { label: "Apps / DEXs used", value: b.programsUsed.length ? b.programsUsed.slice(0, 6).join(", ") : "None" },
      ...topTypes,
      { label: "Distinct tokens touched", value: b.distinctTokens.toLocaleString() },
      { label: "NFT actions", value: b.nftCount.toLocaleString() },
      { label: "Other airdrops caught", value: b.otherAirdrops.toLocaleString() },
      { label: "SOL spent on fees", value: formatSol(b.feesPaidSol) },
      { label: "SOL moved", value: formatSol(b.solVolume) },
    ],
  };

  const cards = [solanaLife, activityProfile];

  if (b.portfolio) {
    const pf = b.portfolio;
    const plus = pf.capped ? "+" : "";
    cards.push({
      key: "portfolio",
      title: "Current Footprint (holdings)",
      items: [
        { label: "NFTs held", value: `${pf.nftCount.toLocaleString()}${plus}` },
        { label: "NFT collections", value: `${pf.collectionCount.toLocaleString()}${plus}` },
        { label: "Tokens held", value: `${pf.tokenCount.toLocaleString()}${plus}` },
        ...(pf.solBalance !== null ? [{ label: "SOL balance", value: formatSol(pf.solBalance) }] : []),
      ],
    });
  }

  return cards;
}

/** Build the four progressive reveal cards from a reveal payload (design §8). */
export function buildRevealCards(p: RevealPayload): RevealCard[] {
  const s = p.stats;
  const usd = formatUsd(p.bagUsd);

  const acquisition: RevealCard = {
    key: "acquisition",
    title: "Acquisition & Trading",
    items: [
      { label: "Total bought", value: formatCato(s.totalBought) },
      { label: "Total sold", value: formatCato(s.totalSold) },
      { label: "Net position", value: formatCato(s.net) },
      { label: "Current bag", value: usd ? `${formatCato(s.balance)} (${usd})` : formatCato(s.balance) },
      { label: "Biggest buy", value: formatCato(s.biggestBuy) },
      { label: "How you got in", value: acquisitionLabel(s.acquisitionType) },
    ],
  };

  const loyalty: RevealCard = {
    key: "loyalty",
    title: "Loyalty & OG Status",
    items: [
      { label: "Status", value: ogSinceLabel(s.firstTx) },
      { label: "Days holding", value: s.holdDays.toLocaleString() },
      ...(s.untouchedAirdrop
        ? [{ label: "Badge", value: "💎 Never touched your 19,417 OG airdrop" }]
        : []),
    ],
  };

  const rankings: RevealCard = {
    key: "rankings",
    title: "Rankings vs all CATO holders",
    items: [
      ...(s.rankLongest !== null ? [{ label: "Longest-holder rank", value: `#${s.rankLongest.toLocaleString()}` }] : []),
      ...(topPercentLabel(s.pctBalance) ? [{ label: "By balance", value: topPercentLabel(s.pctBalance)! }] : []),
      ...(s.pctLoyalty !== null ? [{ label: "More loyal than", value: `${s.pctLoyalty.toFixed(0)}% of cats` }] : []),
    ],
  };

  return [acquisition, loyalty, rankings, ...buildBroadCards(p.broad)];
}
