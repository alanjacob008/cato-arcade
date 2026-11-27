/** Outbound site links — header nav, socials, and the docs page. */

export const DOCS_URL = "https://docs.ogcato.com/";

/** Miniclip archery game — separate Vite app on miniclip.ogcato.com. */
export const MINICLIP_URL =
  process.env.NEXT_PUBLIC_MINICLIP_URL ?? "http://localhost:5173";

/** Claw goes to the real devnet game once NEXT_PUBLIC_CLAW_PLAY=1, otherwise the browser demo. */
export function clawHref(flag: string | undefined): string {
  return flag === "1" ? "/claw/play" : "/claw";
}

export const CLAW_URL = clawHref(process.env.NEXT_PUBLIC_CLAW_PLAY);

export interface GameLink {
  label: string;
  href: string;
  /** Short badge shown on the right of the menu item. */
  tag: string;
}

/** Header "Games" menu. Up Down keeps its VIP sign-in at /play. */
export const GAMES_LINKS: readonly GameLink[] = [
  { label: "Claw", href: CLAW_URL, tag: "Devnet" },
  { label: "Up Down", href: "/play", tag: "VIP" },
];

const GAME_ROUTES = ["/play", "/updown", "/claw"];

/** True on any game route, so the Games button is highlighted there. */
export function gamesActive(pathname: string): boolean {
  return GAME_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/** Header: "Staking" is active on /staking only (the home page now opens on the arcade). */
export const STAKING_URL = "/staking";

export function stakingActive(pathname: string): boolean {
  return pathname === STAKING_URL || pathname.startsWith(`${STAKING_URL}/`);
}

export interface SocialLink {
  label: string;
  href: string;
  /** Short glyph shown next to the label in the dropdown. */
  icon: string;
}

export const SOCIAL_LINKS: readonly SocialLink[] = [
  { label: "X (Twitter)", href: "https://x.com/SolanaCATO", icon: "𝕏" },
  { label: "Telegram", href: "https://t.me/SolanaCAT", icon: "✈" },
  { label: "Discord", href: "https://discord.gg/solanascato", icon: "💬" },
  { label: "GitHub", href: "https://github.com/SOL-CAT", icon: "⌥" },
] as const;
