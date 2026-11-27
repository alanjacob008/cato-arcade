"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { RevealPayload } from "@cato/shared";
import { fetchReveal } from "../lib/api";
import { WrappedStory } from "./wrapped/WrappedStory";
import { catPoseSrc, type CatPose } from "./cat/catPose";
import w from "./wrapped/wrapped.module.css";

/** Thin data boundary: fetch the reveal, then hand off to the scrollytelling story. */
export function Reveal({ wallet }: { wallet: string }) {
  const [payload, setPayload] = useState<RevealPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Demo-only override (?demo=newcomer|degraded) so the adaptive paths are viewable.
  const demoVariant = useSearchParams()?.get("demo") ?? undefined;

  useEffect(() => {
    let active = true;
    fetchReveal(wallet, demoVariant)
      .then((p) => active && setPayload(p))
      .catch(() => active && setError("Couldn't load your Wrapped. Please try again."));
    return () => {
      active = false;
    };
  }, [wallet, demoVariant]);

  if (error) return <Status pose="confused">{error}</Status>;
  if (!payload) return <Status pose="waiting">Unwrapping your year. This can take a few seconds.</Status>;

  return <WrappedStory payload={payload} />;
}

function Status({ pose, children }: { pose: CatPose; children: React.ReactNode }) {
  return (
    <main className={`${w.root} ${w.status}`} aria-live="polite">
      <img src={catPoseSrc(pose)} alt="" width={1080} height={1320} />
      <p>{children}</p>
    </main>
  );
}
