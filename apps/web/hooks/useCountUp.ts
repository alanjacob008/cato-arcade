"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

/**
 * Animate a number from 0 to `target` with an ease-out tween once `play` is true
 * (typically when the scene scrolls into view). Returns the live value to format
 * per-frame. Honors reduced-motion by jumping straight to the final value.
 */
export function useCountUp(target: number, opts?: { play?: boolean; durationMs?: number }): number {
  const { play = true, durationMs = 1200 } = opts ?? {};
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced) {
      setValue(target);
      return;
    }
    if (!play) {
      setValue(0);
      return;
    }
    let start: number | null = null;
    const step = (ts: number) => {
      if (start === null) start = ts;
      const t = Math.min(1, (ts - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setValue(target * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(step);
      else setValue(target);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs, play, reduced]);

  return value;
}
