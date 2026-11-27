"use client";

import { useEffect, useRef } from "react";

/**
 * The taste kit's diagram (public/kit/diagrams, copied unchanged from the skill's assets/diagrams),
 * layout "lanes". Loaded as a plain browser module, exactly as diagrams.md mounts it; only the
 * spec, the palette tokens around it, the scale and the icon folder are ours.
 */
const DIAGRAM_URL = "/kit/diagrams/diagram.js";

/** The two-column split (home.module.css): the panel is nearly square there, so the lanes run top to bottom. */
const SPLIT_QUERY = "(min-width: 1024px)";
/** The kit lays the drawing out in a box about this size; a larger panel scales it up (larger nodes and labels). */
const FIT_WIDTH = 480;
const FIT_HEIGHT = 400;
const MAX_SCALE = 1.5;

/** Only true things: four lanes are live on the hosted devnet pool (CLAW_BACKEND_HANDOFF.md). */
const SPEC = {
  layout: "lanes",
  alt: "Your grab goes to MagicBlock VRF on an Ephemeral Rollup, which draws it on one of four parallel lanes, and the result comes back with its proof.",
  curve: "curve",
  ground: "glow",
  size: [680, 520],
  coreTone: "plain",
  // Grab and Result keep their second line (a card); a phone draws them as tiles with their names below.
  input: { label: "Grab", icon: "ui:joystick", sub: "Insert & Drop", kind: "card", kindCompact: "tile" },
  core: { label: "MagicBlock VRF", icon: "/claw/brand/magicblock-mark.svg", sub: "Ephemeral Rollup" },
  // Each lane draws its own grab: no lane is ticked off for this one; the tick is the result's, with its proof.
  lanes: [
    { label: "Lane 1", icon: "ui:dices" },
    { label: "Lane 2", icon: "ui:dices" },
    { label: "Lane 3", icon: "ui:dices" },
    { label: "Lane 4", icon: "ui:dices" },
  ],
  output: { label: "Result", icon: "ui:shield-check", sub: "With its proof", done: true, kind: "card", kindCompact: "tile" },
  motion: { cycle: 3.2 },
};

interface DiagramHandle { destroy?: () => void }
interface DiagramApi { mount: (el: Element, spec: unknown, opts?: { iconBase?: string }) => DiagramHandle }

export function LanesDiagram() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const panel = el?.parentElement;
    if (!el || !panel) return;
    let api: DiagramApi | undefined;
    let handle: DiagramHandle | undefined;
    let cancelled = false;
    const split = window.matchMedia(SPLIT_QUERY);

    // The panel over the drawing's own box, never under 1: a phone draws at true size.
    const fit = () => {
      const k = Math.max(1, Math.min(MAX_SCALE, panel.clientWidth / FIT_WIDTH, panel.clientHeight / FIT_HEIGHT));
      panel.style.setProperty("--dg-k", k.toFixed(3));
    };
    const mount = () => {
      if (!api || cancelled) return;
      // mount() replaces the diagram already on this element.
      handle = api.mount(el, { ...SPEC, orient: split.matches ? "v" : "auto" }, { iconBase: "/kit/icons/" });
    };

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(panel);
    split.addEventListener("change", mount);
    const url = DIAGRAM_URL;
    import(/* webpackIgnore: true */ url)
      .then((mod: { default: DiagramApi }) => { api = mod.default; mount(); })
      .catch(() => { /* the panel keeps its ground; the facts beside it still say it all */ });
    return () => {
      cancelled = true;
      ro.disconnect();
      split.removeEventListener("change", mount);
      handle?.destroy?.();
    };
  }, []);

  return (
    <>
      <link rel="stylesheet" href="/kit/diagrams/diagram.css" precedence="default" />
      {/* diagram.js gives the element role="img" and the spec's alt as its name, and adds the pause disc to the panel. */}
      <div ref={ref} className="dg" />
    </>
  );
}
