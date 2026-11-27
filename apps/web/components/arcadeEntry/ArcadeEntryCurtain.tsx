"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import ArcadeLoading from "../claw/ArcadeLoading";
import styles from "./arcadeEntry.module.css";
import {
  ARCADE_SHOWN_EVENT,
  CURTAIN_MAX_HOLD_MS,
  ENTRY_START_EVENT,
  ENTRY_STORAGE_KEY,
  isArcadeRoute,
  prefersReducedMotion,
  startArcadeVisit,
  type EntryStartDetail,
} from "./entry";

type Phase = "idle" | "closing" | "holding" | "leaving";

/** Bloom starts as the push-in gathers speed; the iris closes on the cabinet glass after it. */
const CLOSE_MS = 1000;
const BLOOM_FROM = 180;
const BLOOM_TO = 720;
const IRIS_FROM = 430;
const REDUCED_CLOSE_MS = 200;
const LEAVE_MS = 450;
const REDUCED_LEAVE_MS = 200;
/** If the client navigation has not committed by then (a slow first compile, a stalled fetch), finish it as a
 *  full page load: the visitor still lands in the arcade, never back on a half-zoomed home page. */
const NAVIGATION_SAFETY_MS = 8000;
/** How long the warm-up layers stay mounted (see the warm-up effect below). */
const WARM_MS = 900;
/** The links that play the entry: the home page's "Enter the arcade" and the header's Arcade link. */
const ENTRY_LINK = 'a[href^="/claw"]';

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/**
 * The entry curtain, mounted once in the root layout so it survives the client navigation from the
 * home page into the arcade. It blooms amber, closes an iris on the machine's glass, navigates,
 * holds a dark-amber frame and fades out when the arcade's loading screen announces its first paint.
 */
export function ArcadeEntryCurtain() {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const [phase, setPhase] = useState<Phase>("idle");
  const [reduced, setReduced] = useState(false);
  // Who draws the grabs where the visitor is going: the devnet arcade (MagicBlock VRF) or the offline demo.
  const [draw, setDraw] = useState<"vrf" | "local">("vrf");
  // Warm-up: the bloom and the iris frame drawn once, invisibly, before the click (see below).
  const [warm, setWarm] = useState(false);
  const warmedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const bloomRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const timersRef = useRef<number[]>([]);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  const clearTimers = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    for (const id of timersRef.current) window.clearTimeout(id);
    timersRef.current = [];
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    timersRef.current.push(window.setTimeout(fn, ms));
  }, []);

  const leave = useCallback(() => {
    if (phaseRef.current !== "holding" && phaseRef.current !== "closing") return;
    clearTimers();
    setPhase("leaving");
    later(() => setPhase("idle"), prefersReducedMotion() ? REDUCED_LEAVE_MS : LEAVE_MS);
  }, [clearTimers, later]);

  // A link asked for the entry.
  useEffect(() => {
    const onStart = (event: Event) => {
      const detail = (event as CustomEvent<EntryStartDetail>).detail;
      if (!detail || phaseRef.current !== "idle") return;
      const rm = prefersReducedMotion();
      setReduced(rm);
      setDraw(detail.href.startsWith("/claw/play") ? "vrf" : "local");
      setPhase("closing");

      const navigate = () => {
        try { window.sessionStorage.setItem(ENTRY_STORAGE_KEY, "1"); } catch { /* storage blocked: the entry still works */ }
        setPhase("holding");
        router.push(detail.href);
        later(() => { if (!isArcadeRoute(window.location.pathname)) window.location.assign(detail.href); }, NAVIGATION_SAFETY_MS);
      };

      if (rm) {
        later(navigate, REDUCED_CLOSE_MS);
        return;
      }

      // Drive the bloom and the iris from one clock, so a slow frame never desyncs them.
      const { x, y } = detail;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const reach = Math.hypot(Math.max(x, w - x), Math.max(y, h - y)) + 48;
      const start = performance.now();
      const tick = (now: number) => {
        const t = now - start;
        const bloom = easeOut(clamp01((t - BLOOM_FROM) / (BLOOM_TO - BLOOM_FROM)));
        const iris = easeInOut(clamp01((t - IRIS_FROM) / (CLOSE_MS - IRIS_FROM)));
        const r = Math.max(0, reach * (1 - iris));
        const bloomEl = bloomRef.current;
        const frameEl = frameRef.current;
        if (bloomEl) {
          bloomEl.style.opacity = String(bloom);
          bloomEl.style.setProperty("--x", `${x}px`);
          bloomEl.style.setProperty("--y", `${y}px`);
        }
        if (frameEl) {
          const mask = r <= 0.5 ? "none" : `radial-gradient(circle at ${x}px ${y}px, transparent ${r.toFixed(1)}px, #000 ${(r + 36).toFixed(1)}px)`;
          frameEl.style.maskImage = mask;
          frameEl.style.setProperty("-webkit-mask-image", mask);
          frameEl.style.opacity = t < IRIS_FROM ? "0" : "1";
        }
        if (t < CLOSE_MS) rafRef.current = requestAnimationFrame(tick);
        else navigate();
      };
      rafRef.current = requestAnimationFrame(tick);
    };
    window.addEventListener(ENTRY_START_EVENT, onStart);
    return () => window.removeEventListener(ENTRY_START_EVENT, onStart);
  }, [later, leave, router]);

  // The arcade's loading screen painted: hand over. Listening from mount (not from the "holding"
  // commit) means a loading screen that paints in the same frame as the route change is never missed.
  useEffect(() => {
    const onShown = () => { if (phaseRef.current === "holding") leave(); };
    window.addEventListener(ARCADE_SHOWN_EVENT, onShown);
    return () => window.removeEventListener(ARCADE_SHOWN_EVENT, onShown);
  }, [leave]);

  // Route changes: on the arcade, a new visit (its reveal is announced again) and the curtain holds at most
  // CURTAIN_MAX_HOLD_MS; anywhere else, clear at once, and a close still running (its frame loop or the
  // reduced-motion timer) is cancelled before it navigates.
  useEffect(() => {
    if (isArcadeRoute(pathname)) {
      startArcadeVisit();
      if (phaseRef.current === "holding") later(() => leave(), CURTAIN_MAX_HOLD_MS);
      return;
    }
    try { window.sessionStorage.removeItem(ENTRY_STORAGE_KEY); } catch { /* ignore */ }
    if (phaseRef.current !== "idle") {
      clearTimers();
      setPhase("idle");
    }
  }, [pathname, later, leave, clearTimers]);

  // A browser's first paint of the bloom (a full-screen screen blend) and of the iris frame (a radial mask) compiles
  // GPU pipelines, about 90 ms each on a cold cache, which showed as two hitches in the 1 s push-in. Pay it before
  // the click: when a mouse pointer or keyboard focus reaches an entry link, draw both layers once at an invisible
  // opacity, then unmount them. That stalls a static page for a moment instead of the push-in, so it waits for the
  // home film to end (or pause) rather than freeze it. Touch is left alone: a finger lands only ~70 ms before the
  // click, and the stall would then delay the push-in's start. Once per page; never under reduced motion. Only on the
  // home page, where entering the arcade is the main action: elsewhere (a live /updown round, say) a pointer crossing
  // the header's Arcade link must not freeze what the visitor is watching.
  useEffect(() => {
    if (pathname !== "/" || warmedRef.current) return;
    let timer = 0;
    let film: HTMLVideoElement | null = null;
    // A tap also focuses the link; that focus is a touch, not a keyboard user arriving early.
    let touchedAt = -Infinity;
    const onPointerDown = (event: PointerEvent) => { if (event.pointerType === "touch") touchedAt = event.timeStamp; };
    const startWarm = () => {
      if (warmedRef.current || phaseRef.current !== "idle") return;
      warmedRef.current = true;
      remove();
      setWarm(true);
      timer = window.setTimeout(() => setWarm(false), WARM_MS);
    };
    const onIntent = (event: Event) => {
      if (warmedRef.current || film || phaseRef.current !== "idle" || prefersReducedMotion()) return;
      if (event instanceof PointerEvent && event.pointerType === "touch") return;
      if (event.type === "focusin" && event.timeStamp - touchedAt < 1000) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(ENTRY_LINK)) return;
      // The phone menu focuses its first link (Arcade) as it opens: that is not a visitor heading for the arcade,
      // and a stall then would hitch the sheet's open animation.
      if (event.type === "focusin" && target.closest("#site-menu")) return;
      const playing = Array.from(document.querySelectorAll("video")).find((v) => !v.paused && !v.ended);
      if (!playing) { startWarm(); return; }
      film = playing;
      film.addEventListener("ended", startWarm, { once: true });
      film.addEventListener("pause", startWarm, { once: true });
    };
    const remove = () => {
      document.removeEventListener("pointerover", onIntent);
      document.removeEventListener("focusin", onIntent);
      document.removeEventListener("pointerdown", onPointerDown, true);
      film?.removeEventListener("ended", startWarm);
      film?.removeEventListener("pause", startWarm);
    };
    document.addEventListener("pointerover", onIntent, { passive: true });
    document.addEventListener("focusin", onIntent);
    document.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
    return () => { remove(); if (timer) { window.clearTimeout(timer); setWarm(false); } };
  }, [pathname]);

  // A page restored from the back-forward cache never keeps a curtain up.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) { clearTimers(); setPhase("idle"); } };
    window.addEventListener("pageshow", onShow);
    return () => { window.removeEventListener("pageshow", onShow); clearTimers(); };
  }, [clearTimers]);

  if (phase === "idle" && !warm) return null;
  const warming = phase === "idle";
  return (
    <div
      ref={rootRef}
      className={styles.curtain}
      data-phase={warming ? "warm" : phase}
      data-reduced={reduced && !warming ? "true" : undefined}
      aria-hidden="true"
    >
      {(warming || !reduced) && <div ref={bloomRef} className={styles.bloom} />}
      <div ref={frameRef} className={styles.frame} />
      {/* Once the iris has closed, the arcade's loading screen stands in, so the marquee is up even while
          the arcade is still busy starting; the arcade's own screen takes over from it unchanged. */}
      {(phase === "holding" || phase === "leaving") && <div className={styles.standIn}><ArcadeLoading standIn draw={draw} /></div>}
    </div>
  );
}
