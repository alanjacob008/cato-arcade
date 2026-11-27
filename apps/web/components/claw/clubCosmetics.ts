import { TOKEN_TYPES, type TokenTier } from "./tokens";

export type ClubTheme = "violet" | "afterglow" | "solar";
export type ClubProgress = Readonly<{ plays: number; catches: number; rareCatches: number }>;
export const CLUB_THEMES = Object.freeze([
  { id: "violet", name: "Violet", accent: "#b78aff", enamel: "#4b236e", requirement: "Your original club room" },
  { id: "afterglow", name: "Afterglow", accent: "#74e3d0", enamel: "#38225c", requirement: "Unlock with your first catch" },
  { id: "solar", name: "Solar", accent: "#ffc66d", enamel: "#4d2462", requirement: "Unlock with a 10+ USDC catch" },
] as const);

export function clubProgress(used: Readonly<Record<string, { prizeCents: number }>>): ClubProgress {
  const plays = Object.values(used);
  return { plays: plays.length, catches: plays.filter(play => play.prizeCents > 0).length, rareCatches: plays.filter(play => play.prizeCents >= 1000).length };
}
export function themeUnlocked(theme: ClubTheme, progress: ClubProgress) {
  return theme === "violet" || (theme === "afterglow" ? progress.catches > 0 : progress.rareCatches > 0);
}
export function themeAppearance(theme: ClubTheme) { return CLUB_THEMES.find(item => item.id === theme)!; }

export type ClubReceipt = Readonly<{ id: string; tier: TokenTier; entryCents: number; prizeCents: number; netCents: number }>;
export function clubReceipts(used: Readonly<Record<string, { tier: TokenTier; prizeCents: number }>>): ClubReceipt[] {
  return Object.entries(used).slice(-50).reverse().map(([id, play]) => ({ id, tier: play.tier, entryCents: TOKEN_TYPES[play.tier].priceCents,
    prizeCents: play.prizeCents, netCents: play.prizeCents - TOKEN_TYPES[play.tier].priceCents }));
}
