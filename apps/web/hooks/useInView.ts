"use client";

import { useEffect, useState, type RefObject } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

/**
 * Reveal-on-scroll: returns true once `ref` enters the viewport, then stays true.
 * SSR-safe (no observer until mount). Elements already at/above the viewport on
 * load (reload-scrolled or deep-linked) reveal immediately, and reduced-motion
 * users get an instant `true` with no observer.
 */
export function useInView<T extends Element>(
  ref: RefObject<T | null>,
  opts?: { rootMargin?: string; threshold?: number },
): boolean {
  const reduced = usePrefersReducedMotion();
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;

    if (reduced || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }

    // Already within/above the viewport (e.g. a scrolled reload) → reveal now.
    if (el.getBoundingClientRect().top < window.innerHeight) {
      setInView(true);
      return;
    }

    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { rootMargin: opts?.rootMargin ?? "0px 0px -10% 0px", threshold: opts?.threshold ?? 0.15 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [ref, reduced, inView, opts?.rootMargin, opts?.threshold]);

  return inView;
}
