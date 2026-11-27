"use client";

import { useEffect, useRef } from "react";
import type { RevealPayload } from "@cato/shared";
import { buildWrappedScenes } from "../../lib/wrappedModel";
import { StickyCatBanner } from "./StickyCatBanner";
import { SceneShell } from "./SceneShell";
import { SceneView } from "./scenes";
import w from "./wrapped.module.css";

/**
 * The full-screen, archetype-adaptive Wrapped story. Renders the shrinking cat
 * banner, then one full-bleed scene per entry from `buildWrappedScenes`.
 */
export function WrappedStory({ payload }: { payload: RevealPayload }) {
  const scenes = buildWrappedScenes(payload);
  const firstSceneRef = useRef<HTMLDivElement>(null);

  // After a fresh search the page lands at the hero; show the cat for a beat,
  // then glide down to the first scene ("you've been a cat since…"). We skip
  // this if the user arrived already scrolled (e.g. a deep-linked reload).
  useEffect(() => {
    if (window.scrollY > 20) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(() => {
      firstSceneRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    }, 900);
    return () => clearTimeout(t);
  }, []);

  // Gentle scroll-snap so a fast flick settles on the next scene rather than
  // skipping the whole story. Scoped to this page (reverted on unmount) and
  // disabled for reduced-motion. `proximity` keeps it soft; the per-scene
  // `scroll-snap-stop: always` is what catches a fast scroll.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = document.documentElement;
    const prev = root.style.scrollSnapType;
    root.style.scrollSnapType = "y proximity";
    return () => {
      root.style.scrollSnapType = prev;
    };
  }, []);

  return (
    <div className={w.root}>
      <StickyCatBanner wallet={payload.wallet} />
      <div ref={firstSceneRef} />
      {scenes.map((scene) => (
        <SceneShell key={scene.key}>{(inView) => <SceneView scene={scene} inView={inView} />}</SceneShell>
      ))}
    </div>
  );
}
