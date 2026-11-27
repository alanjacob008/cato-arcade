"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MotorKind } from "./arcadeSound";
import type { ArcadeCue } from "./feedback";
import { createArcadeSamples, isSampleCue, SAMPLE_MUTE_KEY, type SampleCue } from "./arcadeSamples";

/** User-supplied samples; background music has its own independent player. */
export function useArcadeAudio() {
  const player = useRef<ReturnType<typeof createArcadeSamples> | null>(null), mutedRef = useRef(false);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    try { mutedRef.current = localStorage.getItem(SAMPLE_MUTE_KEY) === "1"; } catch { /* Use this visit's preference. */ }
    setMuted(mutedRef.current);
    const sound = createArcadeSamples(); player.current = sound; sound.setMuted(mutedRef.current); sound.setHidden(document.hidden);
    const visibility = () => sound.setHidden(document.hidden);
    const click = (event: Event) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
      if (!button?.closest("[data-claw-audio]") || button.disabled || button.getAttribute("aria-disabled") === "true" || button.hasAttribute("data-sfx-control")) return;
      const cue = button.dataset.arcadeSound;
      if (!cue || !isSampleCue(cue)) return;
      sound.activate(); sound.play(cue);
    };
    document.addEventListener("click", click, true); document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("click", click, true); document.removeEventListener("visibilitychange", visibility); sound.dispose(); player.current = null; };
  }, []);
  const activate = useCallback(() => player.current?.activate(), []);
  const playCue = useCallback((cue: ArcadeCue) => {
    const sample: SampleCue | null = cue === "press" ? "button" : cue === "win" || cue === "jackpot" ? "win" : cue === "miss" ? "lose" : null;
    if (sample) player.current?.play(sample);
  }, []);
  const motion = useCallback((speed: number, kind: MotorKind) => player.current?.motion(speed, kind), []);
  const stop = useCallback(() => player.current?.stop(), []);
  const toggleMuted = useCallback(() => {
    mutedRef.current = !mutedRef.current; setMuted(mutedRef.current); player.current?.setMuted(mutedRef.current);
    if (!mutedRef.current) player.current?.activate();
    try { localStorage.setItem(SAMPLE_MUTE_KEY, mutedRef.current ? "1" : "0"); } catch { /* Use this visit's preference. */ }
  }, []);
  return { activate, playCue, motion, stop, muted, enabled: true, toggleMuted };
}
