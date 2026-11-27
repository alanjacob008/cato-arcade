"use client";

import { useRef, type ReactNode } from "react";
import { useInView } from "../../hooks/useInView";

/**
 * Full-bleed scene container. Owns the universal concerns — viewport-height
 * sizing, the ambient glow, and the scroll-in reveal — so each scene body only
 * worries about its own content. Children get `inView` so count-up animations
 * can start when the scene scrolls into view.
 */
export function SceneShell({
  glow,
  children,
}: {
  glow?: string;
  children: (inView: boolean) => ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref);

  return (
    <section ref={ref} className="scene">
      <div
        aria-hidden
        className="scene-glow"
        style={{
          background: glow ?? "radial-gradient(60% 50% at 50% 38%, rgba(254,169,17,0.12), transparent 70%)",
          opacity: inView ? 1 : 0.2,
        }}
      />
      <div className={`reveal ${inView ? "reveal--in" : ""}`}>{children(inView)}</div>

      <style jsx>{`
        .scene {
          position: relative;
          width: 100%;
          min-height: 100vh;
          min-height: 100dvh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 96px 24px;
          overflow: hidden;
          box-sizing: border-box;
          /* Snap point: a fast scroll is caught at each section (WrappedStory
             arms scroll-snap-type on the page) instead of flying past. */
          scroll-snap-align: start;
          scroll-snap-stop: always;
        }
        .scene-glow {
          position: absolute;
          inset: 0;
          pointer-events: none;
          transition: opacity 800ms ease;
        }
        .reveal {
          position: relative;
          z-index: 1;
          width: 100%;
          max-width: 760px;
          text-align: center;
          opacity: 0;
          transform: translateY(28px);
          transition: opacity 700ms ease, transform 700ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        .reveal--in {
          opacity: 1;
          transform: none;
        }
        @media (prefers-reduced-motion: reduce) {
          .reveal {
            opacity: 1 !important;
            transform: none !important;
            transition: none !important;
          }
          .scene-glow {
            transition: none !important;
          }
        }
      `}</style>
    </section>
  );
}
