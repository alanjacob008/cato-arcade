"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import machineFocus from "../../public/claw/art/hero-machine-focus.json";
import { EnterArcadeLink } from "../arcadeEntry/EnterArcadeLink";
import { prefersReducedMotion } from "../arcadeEntry/entry";
import { CLAW_URL } from "../../lib/links";
import styles from "./home.module.css";
import { HeroFinishControls, HeroFinishWash, useHeroFinish } from "./HeroMachineShowcase";

type Point = { x: number; y: number };
const STILL_FOCUS: Point = { x: machineFocus.x, y: machineFocus.y };
const PORTRAIT_FOCUS: Point = machineFocus.portrait;
const PORTRAIT_QUERY = "(max-aspect-ratio: 4/5)";
const PUSH_SCALE = 2.15;

const POSITION_KEYWORDS: Record<string, number> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };

/** One computed object-position component ("66%", "0px": Chrome writes 0% as 0px, "center"): the picture's offset in its free space. */
function placeAlong(value: string | undefined, free: number): number {
  if (!value) return free / 2;
  if (value.endsWith("%")) return (free * parseFloat(value)) / 100;
  if (value.endsWith("px")) return parseFloat(value);
  return free * (POSITION_KEYWORDS[value] ?? 0.5);
}

/** The drawn box of an object-fit picture (cover, or contain on portrait screens) inside its element (element pixels, untransformed). */
function coverBox(el: HTMLImageElement) {
  const iw = el.naturalWidth;
  const ih = el.naturalHeight;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  if (!iw || !ih || !w || !h) return null;
  const style = getComputedStyle(el);
  const s = style.objectFit === "contain" ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;
  const [px, py] = style.objectPosition.split(/\s+/);
  return { ox: placeAlong(px, w - dw), oy: placeAlong(py, h - dh), dw, dh, w, h };
}

/** Where a point of the picture lands on screen (transforms included). */
function coverPoint(el: HTMLImageElement, fx: number, fy: number): Point | null {
  const box = coverBox(el);
  const rect = el.getBoundingClientRect();
  if (!box || !rect.width || !rect.height) return null;
  // The element may be scaled (the settle, the film's start match): map through its on-screen rect.
  const kx = rect.width / box.w;
  const ky = rect.height / box.h;
  return { x: rect.left + (box.ox + fx * box.dw) * kx, y: rect.top + (box.oy + fy * box.dh) * ky };
}

export function ArcadeHero() {
  const pushRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [entering, setEntering] = useState(false);
  const [pushed, setPushed] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const finishes = useHeroFinish(entering, imageReady);
  useEffect(() => {
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) setImageReady(true);
  }, []);

  // Coming back from the arcade (or a restored page) always shows the hero at rest.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) { setEntering(false); setPushed(false); } };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  /** Follow the same sharp image through the opening zoom and entry iris. */
  const getFocus = useCallback((): Point | null => {
    const img = imgRef.current;
    if (!img) return null;
    const focus = window.matchMedia(PORTRAIT_QUERY).matches ? PORTRAIT_FOCUS : STILL_FOCUS;
    return coverPoint(img, focus.x, focus.y);
  }, []);

  const onEnter = useCallback(() => {
    // Freeze the camera while the entry iris follows the machine glass.
    const push = pushRef.current;
    const point = getFocus();
    if (push && point && !prefersReducedMotion()) {
      const r = push.getBoundingClientRect();
      push.style.transformOrigin = `${point.x - r.left}px ${point.y - r.top}px`;
      setPushed(true);
    }
    setEntering(true);
  }, [getFocus]);

  return (
    <section className={styles.hero} data-entering={entering ? "true" : undefined} aria-labelledby="arcade-hero-title">
      <div ref={pushRef} className={styles.heroPush} style={pushed ? { transform: `scale(${PUSH_SCALE})` } : undefined}>
        <div className={styles.heroSettle} data-ready={imageReady || undefined}>
          <picture>
            <source media={PORTRAIT_QUERY} srcSet="/claw/art/hero-keyart-portrait-1080.webp" type="image/webp" />
            <img
              ref={imgRef}
              className={styles.heroImg}
              src="/claw/art/hero-keyart-2560.webp"
              alt="A steel claw machine full of cream and amber cat boxes, glowing in a dark arcade"
              width={2560}
              height={1440}
              fetchPriority="high"
              decoding="async"
              onLoad={() => setImageReady(true)}
            />
          </picture>
          <HeroFinishWash mediaRef={imgRef} kind="still" finish={finishes.finish} shown />
        </div>
      </div>
      <HeroFinishControls {...finishes} hidden={entering || !imageReady} />
      <div className={styles.heroScrim} aria-hidden="true" />

      <div className={styles.heroWrap}>
        <div className={styles.heroTop}>
          <h1 id="arcade-hero-title" className={styles.heroTitle}>
            <span className={styles.word} style={{ ["--i" as string]: 0 }}><span>CATO</span></span>{" "}
            <span className={styles.word} style={{ ["--i" as string]: 1 }}><span className={styles.amber}>Arcade</span></span>
            {/* read as two sentences ("CATO Arcade. A claw machine on Solana"), shown as the name over its category */}
            <span className={styles.srOnly}>. </span>
            <span className={styles.titleKind}><span className={styles.word} style={{ ["--i" as string]: 2 }}><span>A claw machine on Solana</span></span></span>
          </h1>
          <p className={styles.heroLead} style={{ ["--i" as string]: 0 }}>
            Every grab is drawn by MagicBlock VRF on an Ephemeral Rollup, and the result comes back with its proof.
          </p>
        </div>
        <div className={styles.heroBottom}>
          <p className={styles.heroFact} style={{ ["--i" as string]: 1 }}>
            <span className={styles.liveDot} aria-hidden="true" />
            Live on Solana devnet. Plays in the browser, and test tokens are free.
          </p>
          <div className={styles.heroActions} style={{ ["--i" as string]: 2 }}>
            <EnterArcadeLink href={CLAW_URL} className={`${styles.btn} ${styles.btnPrimary}`} getFocus={getFocus} onEnter={onEnter}>
              Enter the arcade
            </EnterArcadeLink>
            <a href="#how-a-grab-is-drawn" className={`${styles.btn} ${styles.btnGhost}`}>
              See how a grab is drawn
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
