"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Returns true once the page has scrolled past most of the hero element's
 * height. The trigger is the hero's measured full height (captured once at
 * mount so the value doesn't flap as the banner itself shrinks), times `factor`.
 * rAF-throttled, passive listeners, SSR-safe initial `false`.
 */
export function useShrinkOnScroll(heroRef: RefObject<HTMLElement | null>, factor = 0.6): boolean {
  const [shrunk, setShrunk] = useState(false);
  const triggerRef = useRef<number | null>(null);

  useEffect(() => {
    let raf = 0;
    const compute = () => {
      raf = 0;
      if (triggerRef.current === null) {
        const h = heroRef.current?.offsetHeight ?? 0;
        if (h > 0) triggerRef.current = h * factor;
      }
      const trigger = triggerRef.current ?? Number.POSITIVE_INFINITY;
      setShrunk(window.scrollY > trigger);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    compute();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [heroRef, factor]);

  return shrunk;
}
