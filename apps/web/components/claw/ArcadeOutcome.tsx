"use client";
import { useEffect, useState, type CSSProperties } from "react";
import { FEEDBACK_DURATION } from "./feedback";
import UsdcAmount from "./UsdcAmount";
import styles from "./player.module.css";
import hud from "./hud.module.css";

/** Today's rule for a rare win: a prize of 10 USDC or more. */
export const isRareWin = (success: boolean, cents: number) => success && cents >= 1000;
const prize = (cents: number) => (cents / 100).toFixed(2);

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Count the delivered prize up quickly; keep the final amount accessible throughout. */
function PrizeAmount({ cents, rare }: { cents: number; rare: boolean }) {
  const [shown, setShown] = useState(() => typeof window === "undefined" || reducedMotion() ? cents : 0);
  useEffect(() => {
    if (reducedMotion()) { setShown(cents); return; }
    setShown(0);
    const start = performance.now(), duration = rare ? 1300 : 900;
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - start) / duration));
      setShown(Math.round(cents * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [cents, rare]);
  return <span className={hud.prizeCount} aria-hidden="true"><UsdcAmount value={`+${prize(shown)}`} /></span>;
}

export function OutcomeToast({ success, cents = 0, error = false, noTarget = false }: { success: boolean; cents?: number; error?: boolean; noTarget?: boolean }) {
  const [visible, setVisible] = useState(true), rare = isRareWin(success, cents);
  useEffect(() => { const timer = window.setTimeout(() => setVisible(false), FEEDBACK_DURATION); return () => window.clearTimeout(timer); }, [success, cents]);
  if (!visible) return null;
  if (error) return <div className={`${styles.outcomeText} ${hud.plate}`} data-kind="error"><strong>Please try again</strong></div>;
  if (!success) return <div className={`${styles.outcomeText} ${hud.plate}`} data-kind="miss" data-win="false">
    <img className={hud.cat} src="/cato/confused.webp" alt="" width={108} height={132} decoding="async" />
    {/* With no box under the claw nothing was drawn, so the plate does not call it a near miss. */}
    <span className={hud.plateText}><strong className={hud.plateTitle}>{noTarget ? "NO BOX HERE" : "SO CLOSE"}</strong><span className={hud.plateNote}>{noTarget ? "Aim over a box and try again" : "Better luck next time"}</span></span>
  </div>;
  return <div className={`${styles.outcomeText} ${hud.plate}`} data-kind="win" data-win="true" data-rare={rare}>
    <img className={hud.cat} src="/cato/celebrate.webp" alt="" width={108} height={132} decoding="async" />
    <span className={hud.plateText}>
      <strong className={hud.plateTitle}>{rare ? "BIG WIN" : "YOU WON"}</strong>
      <span className={styles.screenReaderOnly}>You won {prize(cents)} USDC</span>
      <PrizeAmount cents={cents} rare={rare} />
    </span>
  </div>;
}

const WIN_PIXELS = ["#FEA911", "#FFEDCD", "#D3601E"], RARE_PIXELS = ["#FEA911", "#FFEDCD", "#ED2939", "#D3601E"];

/** A bounded CSS-only burst after the delivered, verified outcome; never during grip. */
export function ResultEffects({ success, cents }: { success: boolean; cents: number }) {
  const [visible, setVisible] = useState(true), rare = isRareWin(success, cents);
  useEffect(() => { const timer = window.setTimeout(() => setVisible(false), rare ? 1900 : 1500); return () => window.clearTimeout(timer); }, [rare]);
  if (!visible) return null;
  const count = success ? rare ? 18 : 10 : 0, palette = rare ? RARE_PIXELS : WIN_PIXELS;
  return <div className={`${styles.resultEffects} ${hud.effects}`} data-win={success} data-rare={rare} aria-hidden="true">
    <div className={`${styles.resultGlow} ${hud.bloom}`} />
    {rare && <div className={hud.marquee} />}
    {Array.from({ length: count }, (_, index) => {
      const angle = (index / count) * Math.PI * 2 + (index % 2) * .17, radius = (rare ? 190 : 125) + (index % 3) * 22;
      return <i key={index} className={styles.pixelPrize} style={{ "--dx": `${Math.cos(angle) * radius}px`, "--dy": `${Math.sin(angle) * radius * .78 - 40}px`, "--delay": `${index % 3 * .04}s`, "--turn": `${90 + index * 37}deg`, "--pixel": palette[index % palette.length] } as CSSProperties} />;
    })}
  </div>;
}
