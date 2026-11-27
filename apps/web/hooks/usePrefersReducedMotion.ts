"use client";

import { useEffect, useState } from "react";

/**
 * True when the user has asked the OS to reduce motion. SSR-safe: starts
 * `false` (matching the server render) and updates after mount, so callers can
 * disable tweens/transitions without a hydration mismatch.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
