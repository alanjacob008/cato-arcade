"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Image from "next/image";
import { announceArcadeReveal, announceArcadeShown, isArcadeRoute, prefersReducedMotion } from "../arcadeEntry/entry";
import styles from "./onboarding.module.css";

const SIGN = "CATO ARCADE";
const SIGN_LETTERS = SIGN.replace(/ /g, "").length;
const BULBS = 7;
/** A full-screen loading screen that leaves fades out over the arcade it reveals, instead of cutting. */
const EXIT_MS = 560;
const REDUCED_EXIT_MS = 200;
/** Make genuine completion readable before the curtain starts to fade. */
const COMPLETE_HOLD_MS = 500;
/** A loading screen that follows another one within this time carries on from it (no second power-on). */
const CONTINUE_MS = 2000;

/**
 * The sign's payoff: at 100% the screen stays up for one beat with every letter lit, long enough for the last
 * letter's power-on (powerOn in onboarding.module.css: .46 s, steady from 72%), before it leaves. Under reduced
 * motion nothing flickers; the full sign shows for a moment before the usual crossfade.
 */
const PAYOFF_MS = 450;
const REDUCED_PAYOFF_MS = 200;

/**
 * True once `complete` has stayed true for the payoff beat. The beat is counted in painted frames from the first
 * one after the 100% commit, so a long first frame (shader compile) cannot use it up before the full sign is seen.
 * A hidden tab paints nothing and skips the beat.
 */
export function useLoadingPayoff(complete: boolean): boolean {
  const [held, setHeld] = useState(false);
  if (!complete && held) setHeld(false);
  useEffect(() => {
    if (!complete) return;
    const beat = prefersReducedMotion() ? REDUCED_PAYOFF_MS : PAYOFF_MS;
    let first: number | null = null, frame = 0;
    const tick = () => {
      const now = performance.now();
      first ??= now;
      if (now - first >= beat) setHeld(true); else frame = requestAnimationFrame(tick);
    };
    const hidden = () => { if (document.hidden) setHeld(true); };
    frame = requestAnimationFrame(tick);
    document.addEventListener("visibilitychange", hidden);
    hidden();
    return () => { cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", hidden); };
  }, [complete]);
  return complete && held;
}

/** When the last full-screen loading screen left (performance.now()), so the next one can carry on. */
let lastExitAt = -Infinity;
/** Loading screens in the page right now, full and compact: when the last one leaves, the arcade is revealed. */
const live = { full: 0, compact: 0 };
/** Screens that left in this commit: their still copies, shown (or not) once the commit is done. */
let leaving: { copy: HTMLElement; compact: boolean }[] = [];
/** The entry curtain's stand-in copy is up: the arcade's own screen takes over from it without a second power-on. */
let standInLive = false;
/** The progress the arcade's full screen up right now shows, so a screen that replaces it lights only what is new. */
let litPercent = 0;

/** A still copy of the screen's last frame, where it was, ready to fade out over the arcade. */
function stillCopy(el: HTMLElement, compact: boolean) {
  const copy = el.cloneNode(true) as HTMLElement;
  copy.setAttribute("aria-hidden", "true");
  if (compact) {
    // The compact screen sits in the machine's stage: pin the copy over the same box.
    const r = el.getBoundingClientRect();
    Object.assign(copy.style, { position: "fixed", inset: "auto", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, zIndex: "90" });
  }
  copy.style.animationDuration = `${prefersReducedMotion() ? REDUCED_EXIT_MS : EXIT_MS}ms`;
  for (const node of Array.from(copy.querySelectorAll("[role], [aria-live]"))) { node.removeAttribute("role"); node.removeAttribute("aria-live"); }
  return copy;
}

function fadeOut(copy: HTMLElement, complete = false, finished = () => {}) {
  document.body.appendChild(copy);
  if (complete) {
    copy.dataset.complete = "true";
    copy.querySelectorAll<HTMLElement>("[data-loading-letter]").forEach(letter => { letter.dataset.lit = "true"; letter.dataset.steady = "true"; });
    const count = copy.querySelector<HTMLElement>("[data-loading-count]"); if (count) count.textContent = "100%";
    const label = copy.querySelector<HTMLElement>("[data-loading-label]"); if (label) label.textContent = "Arcade ready";
    const bar = copy.querySelector<HTMLElement>("[data-loading-track] > span"); if (bar) bar.style.width = "100%";
    const track = copy.querySelector<HTMLElement>("[data-loading-track]");
    if (track) { track.setAttribute("aria-valuenow", "100"); track.setAttribute("aria-valuetext", "100% · Arcade ready"); }
  }
  let removed = false;
  const remove = () => { if (removed) return; removed = true; copy.remove(); finished(); };
  copy.addEventListener("animationend", (e) => { if (e.target === copy && copy.dataset.exit) remove(); });
  const fade = () => {
    copy.dataset.exit = "true";
    window.setTimeout(remove, (prefersReducedMotion() ? REDUCED_EXIT_MS : EXIT_MS) + 400);
  };
  if (complete && !prefersReducedMotion()) window.setTimeout(fade, COMPLETE_HOLD_MS);
  else fade();
}

/**
 * After the commit in which loading screens left: with another full screen still up, nothing needs a
 * copy (it covers the page); else the full screens that left fade out (a compact one under them adds
 * nothing), or, with none, the compact ones fade out in place. With no loading screen left, the arcade
 * is ready under them: show 100%, then fade, then announce the visible scene.
 */
function settleExits() {
  const batch = leaving;
  leaving = [];
  const onArcade = isArcadeRoute(window.location.pathname);
  if (onArcade && live.full === 0) {
    const fullLeft = batch.some((b) => !b.compact);
    const covers = batch.filter(b => fullLeft ? !b.compact : live.compact === 0);
    const complete = live.full + live.compact === 0 && covers.every(b => !b.copy.dataset.failed);
    let remaining = covers.length;
    for (const b of covers) fadeOut(b.copy, complete, () => {
      if (--remaining === 0 && complete && live.full + live.compact === 0 && isArcadeRoute(window.location.pathname)) announceArcadeReveal();
    });
  }
}

/**
 * The arcade loading screen: a neon "CATO ARCADE" marquee whose letters power on with the real
 * startup progress, the cat on top of the sign, the real label and percent, and one credit line for
 * MagicBlock VRF. Its night frame is the entry curtain's last frame (components/arcadeEntry), and its
 * first paint tells the curtain to hand over. A screen that takes over from another one (the arcade
 * swaps loading screens as it starts) keeps the letters already lit steady, and the full screen fades
 * out over the arcade when it leaves.
 *
 * `draw` says who draws the grabs on this page: "vrf" (the devnet arcade, MagicBlock VRF) or "local"
 * (the offline demo, drawn in the browser), so the credit line only claims what is true here.
 * `standIn` is the entry curtain's copy (components/arcadeEntry), shown from the moment its iris has
 * closed: it announces nothing and leaves nothing behind; the arcade's own screen carries on from it.
 */
export default function ArcadeLoading({ compact = false, progress = 0, label = "Preparing your arcade", failed = false, draw = "vrf", standIn = false }: { compact?: boolean; progress?: number; label?: string; failed?: boolean; draw?: "vrf" | "local"; standIn?: boolean }) {
  const percent = Math.max(0, Math.min(100, Math.round(progress)));
  const rootRef = useRef<HTMLDivElement>(null);
  // Letters already lit when this screen appears stay steady; only the ones the progress lights from here flicker on.
  // A full screen that swaps in for another one still up (the arcade's early screen, then its HUD's) keeps the
  // letters that one had lit, and powers on the ones its later progress adds instead of showing them lit at once.
  const [mountPercent] = useState(() => !standIn && !compact && live.full > 0 ? Math.min(percent, litPercent) : percent);
  useEffect(() => { if (!standIn && !compact) litPercent = percent; }, [percent, standIn, compact]);

  useEffect(() => {
    if (standIn) return;
    const frame = requestAnimationFrame(() => announceArcadeShown());
    return () => cancelAnimationFrame(frame);
  }, [standIn]);

  // Before the first paint: a screen that takes over from one that just left carries on (no second
  // cat peek). The cleanup runs while the screen is still in the page, just before React removes it: it
  // takes a still copy, and once the commit is done settleExits() fades it out over the arcade and
  // announces the reveal ("cato:arcade-reveal", the scene's cue for its intro flight; entry.ts).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (standIn) {
      standInLive = true;
      return () => { standInLive = false; lastExitAt = performance.now(); };
    }
    if (compact) live.compact++; else live.full++;
    if (el && !compact && (standInLive || performance.now() - lastExitAt < CONTINUE_MS)) el.dataset.continued = "true";
    return () => {
      if (compact) live.compact--; else { live.full--; lastExitAt = performance.now(); }
      if (el?.isConnected) leaving.push({ copy: stillCopy(el, compact), compact });
      if (leaving.length <= 1) queueMicrotask(settleExits);
    };
  }, [compact, standIn]);

  let letter = 0;
  return <div ref={rootRef} className={styles.loading} data-arcade-loading="true" data-compact={compact} data-failed={failed || undefined}>
    <div className={styles.marquee} aria-hidden="true">
      <Image className={styles.loadingLogo} src="/claw/cato-mascot-transparent.png" width={160} height={160} alt="" priority unoptimized />
      <div className={styles.marqueeBox}>
        <div className={styles.bulbs}>{Array.from({ length: BULBS }, (_, i) => <span key={i} style={{ ["--b" as string]: i }} />)}</div>
        <div className={styles.sign}>
          {[...SIGN].map((ch, i) => {
            if (ch === " ") return <span key={i} className={styles.signGap} />;
            const threshold = ((letter + 0.5) / SIGN_LETTERS) * 100;
            const lit = !failed && percent >= threshold;
            const steady = lit && mountPercent >= threshold;
            const index = letter++;
            return <span key={i} className={styles.signLetter} data-loading-letter="true" data-lit={lit || undefined} data-steady={steady || undefined} style={{ ["--l" as string]: index }}>{ch}</span>;
          })}
        </div>
      </div>
    </div>
    <p className={styles.loadingStatus} role={failed ? "alert" : "status"}>{failed ? "Arcade couldn’t load" : "Arcade loading..."}</p>
    {!failed && <div className={styles.loadingProgress}>
      <div className={styles.loadingTrack} data-loading-track="true" role="progressbar" aria-label="Arcade startup" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${percent}% · ${label}`}><span style={{ width: `${percent}%` }} /></div>
      <div className={styles.loadingCaption}><span data-loading-label="true">{label}</span><strong data-loading-count="true">{percent}%</strong></div>
    </div>}
    {failed && <span className={styles.loadingError}>Refresh the page to try again.</span>}
    <p className={styles.loadingCredit}>
      <span>{draw === "vrf" ? "Every grab is verified by" : "In the devnet arcade every grab is verified by"}</span>
      <Image className={styles.creditLogo} src="/claw/brand/magicblock-logo.svg" width={1134} height={205} alt="MagicBlock" unoptimized />
    </p>
  </div>;
}
