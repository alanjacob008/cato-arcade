/**
 * The home-to-arcade entry contract (docs/claw/plans/2026-11-27-blitz-ui-direction.md, "Entry curtain").
 *
 * - Before navigating, the curtain sets sessionStorage[ENTRY_STORAGE_KEY] = "1".
 * - The arcade dispatches ARCADE_SHOWN_EVENT when its loading screen (or ready scene) first paints;
 *   the curtain fades out on it, or after CURTAIN_MAX_HOLD_MS at most.
 * - Any route that is not /claw* clears the curtain at once.
 * - When the arcade is ready, its loading screen shows 100%, holds, then fades out
 *   (components/claw/ArcadeLoading.tsx). ARCADE_REVEAL_EVENT follows removal of the final cover.
 *
 * Presentation only: nothing here touches tokens, wallets, VRF or accounting.
 */

export const ENTRY_STORAGE_KEY = "cato-arcade-entry";
export const ARCADE_SHOWN_EVENT = "cato:arcade-shown";
/** Internal: a link asks the curtain (mounted once in the root layout) to run the entry. */
export const ENTRY_START_EVENT = "cato:arcade-entry-start";
export const CURTAIN_MAX_HOLD_MS = 2500;
/**
 * Contract with the scene (components/claw/createMachine.ts): fired once per arcade visit, when the loading
 * screen has finished fading out over the ready arcade. The scene waits for all
 * loading covers to leave before flickering its wall neon on; wallet zoom is separate.
 */
export const ARCADE_REVEAL_EVENT = "cato:arcade-reveal";

export interface EntryStartDetail {
  href: string;
  /** Viewport point the iris closes on (the cabinet glass), in CSS pixels. */
  x: number;
  y: number;
}

export function isArcadeRoute(pathname: string): boolean {
  return pathname === "/claw" || pathname.startsWith("/claw/");
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function requestArcadeEntry(detail: EntryStartDetail): void {
  window.dispatchEvent(new CustomEvent<EntryStartDetail>(ENTRY_START_EVENT, { detail }));
}

let revealed = false;
/** The route the visit's reveal was announced on. */
let revealedPath: string | null = null;

/** A new arcade visit (the route moved onto /claw*): the next reveal is announced again. */
export function startArcadeVisit(): void {
  revealed = false;
  revealedPath = null;
}

/** Called after the final loading cover leaves; at most once per visit. */
export function announceArcadeReveal(): void {
  if (revealed || typeof window === "undefined") return;
  revealed = true;
  revealedPath = window.location.pathname;
  window.dispatchEvent(new Event(ARCADE_REVEAL_EVENT));
}

/**
 * Whether this visit's reveal has already been announced, on the current route. A scene built after it (a day
 * rollover, a rebuild) gets no cue of its own, and the player has already watched the fly-in, so it lands at its
 * station at once instead of holding a dark opening shot for the fallback.
 */
export function arcadeRevealAnnounced(): boolean {
  return revealed && typeof window !== "undefined" && revealedPath === window.location.pathname;
}

/** Called by the arcade's loading screen on its first paint. */
export function announceArcadeShown(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(ARCADE_SHOWN_EVENT));
}

/** A plain left click with no modifier keys: the only click the curtain takes over. */
export function isPlainLeftClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
