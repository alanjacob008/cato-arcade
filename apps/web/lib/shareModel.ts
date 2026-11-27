import type { ShareData } from "@cato/shared";

/**
 * CATO theme — "Phantom Dark" brand system (see design.md).
 * Warm amber accents on a cinematic near-black stage, with cream filled CTAs.
 */
export const THEME = {
  bg: "#121212", // neutral — the dark hero canvas
  fg: "#f5f5f5", // light copy on the dark stage
  accent: "#FEA911", // primary amber — brand emphasis, icons, glow
  accentStrong: "#D3601E", // primary-strong — deeper burnt orange for pressed/weighted accents
  cream: "#FFEDCD", // secondary — pale warm cream for the main filled CTA
  espresso: "#1C0D00", // tertiary — near-black espresso, text on light/amber surfaces
  surface: "#1A1A1A", // layered dark surface
  surfaceElevated: "#161616", // elevated card surface
  border: "#E37A26", // warm orange border for cards/dividers
  muted: "#A8A096", // warm grey for secondary copy
  error: "#ED2939"
} as const;

export interface ShareCard {
  title: string;
  wallet: string;
  lines: Array<{ label: string; value: string }>;
  badge: string | null;
}

export function shortWallet(w: string): string {
  return w.length > 12 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}

export function formatCato(n: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n)} CATO`;
}

export function formatUsd(n: number | null): string | null {
  if (n === null) return null;
  const digits = n > 0 && n < 1 ? 4 : 2;
  return `$${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits }).format(n)}`;
}

export function ogSinceLabel(firstTx: string | null): string {
  if (!firstTx) return "Not a cat yet";
  const d = new Date(firstTx);
  return `OG since ${d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}`;
}

export function topPercentLabel(pctBalance: number | null): string | null {
  if (pctBalance === null) return null;
  const top = Math.max(0.1, 100 - pctBalance);
  return `Top ${top.toFixed(1)}% by balance`;
}

/** Build the display model for the share card from API share data. */
export function buildShareCard(data: ShareData): ShareCard {
  const lines: ShareCard["lines"] = [{ label: "Holding", value: formatCato(data.balance) }];

  const bag = formatUsd(data.bagUsd);
  if (bag) lines.push({ label: "Bag value", value: bag });

  lines.push({ label: "Loyalty", value: ogSinceLabel(data.ogSince) });

  if (data.rankLongest !== null) {
    lines.push({ label: "Longest-holder rank", value: `#${data.rankLongest}` });
  }
  const pct = topPercentLabel(data.pctBalance);
  if (pct) lines.push({ label: "Rank", value: pct });

  return {
    title: "$CATO Wrapped",
    wallet: shortWallet(data.wallet),
    lines,
    badge: data.untouchedAirdrop ? "💎 Untouched OG Airdrop" : null,
  };
}

/** Generic card for an invalid/empty wallet. */
export function fallbackCard(): ShareCard {
  return {
    title: "$CATO Wrapped",
    wallet: "",
    lines: [{ label: "", value: "Enter your wallet to unwrap your CATO year." }],
    badge: null,
  };
}

// ── Collectible card (the shareable "trading card" surface) ──────────────────

/** The structured model both the on-site card and the social image render. */
export interface CollectibleCard {
  tier: string; // "OG CAT" | "CATO HOLDER" | "NEW CAT" | "CATO"
  wallet: string; // shortened for display
  fullWallet: string;
  ogSince: string | null; // "Jan 2023"
  stats: Array<{ label: string; value: string }>; // up to 4 headline stats
  untouchedAirdrop: boolean;
}

function monthYear(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** A short tier label for the collectible card, derived from share data. */
function shareTier(data: ShareData): string {
  const year = data.ogSince ? new Date(data.ogSince).getUTCFullYear() : null;
  const isOg =
    data.untouchedAirdrop ||
    (year !== null && year <= 2022) ||
    (data.rankLongest !== null && data.rankLongest <= 1000);
  if (isOg) return "OG CAT";
  return data.balance > 0 ? "CATO HOLDER" : "NEW CAT";
}

/** Build the collectible "cat card" model — identity & nostalgia stats, no USD. */
export function buildCollectibleCard(data: ShareData): CollectibleCard {
  const ogSince = monthYear(data.ogSince);
  const solYear = data.solanaSince ? new Date(data.solanaSince).getUTCFullYear() : null;

  const stats: CollectibleCard["stats"] = [];
  if (solYear !== null) stats.push({ label: "On Solana since", value: String(solYear) });
  if (ogSince) stats.push({ label: "$CATO OG since", value: ogSince });
  stats.push({ label: "$CATO held", value: data.balance.toLocaleString("en-US") });
  if (data.pctBalance !== null) stats.push({ label: "By balance", value: `Top ${Math.max(0.1, 100 - data.pctBalance).toFixed(1)}%` });
  if (data.pctLoyalty !== null) stats.push({ label: "More loyal than", value: `${data.pctLoyalty.toFixed(0)}% of cats` });
  if (data.rankLongest !== null) stats.push({ label: "Longest holder", value: `#${data.rankLongest.toLocaleString()}` });

  return {
    tier: shareTier(data),
    wallet: shortWallet(data.wallet),
    fullWallet: data.wallet,
    ogSince,
    stats: stats.slice(0, 6),
    untouchedAirdrop: data.untouchedAirdrop,
  };
}

/** Generic collectible for an invalid/unreachable wallet. */
export function fallbackCollectible(): CollectibleCard {
  return { tier: "CATO", wallet: "", fullWallet: "", ogSince: null, stats: [], untouchedAirdrop: false };
}

/** Prefilled X (Twitter) intent URL for sharing a collectible card. */
export function shareTweetUrl(card: CollectibleCard, pageUrl: string): string {
  const holding = card.stats.find((s) => s.label === "Holding")?.value;
  const bits = [card.ogSince ? `OG since ${card.ogSince}` : null, holding].filter(Boolean);
  const text = `My $CATO Wrapped 🐈${bits.length ? `: ${bits.join(" · ")}` : ""}`;
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(pageUrl)}`;
}
