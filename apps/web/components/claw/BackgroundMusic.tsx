"use client";
import { useEffect, useId, useRef, useState } from "react";
import { HiOutlineMusicalNote, HiOutlineSpeakerWave, HiOutlineSpeakerXMark } from "react-icons/hi2";
import { createBackgroundMusic, MUSIC_STORAGE_KEY } from "./musicPlayback";
import styles from "./audioControls.module.css";

export default function BackgroundMusic({ effectsMuted, onToggleEffects }: { effectsMuted: boolean; onToggleEffects: () => void }) {
  const player = useRef<ReturnType<typeof createBackgroundMusic> | null>(null), mutedRef = useRef(false);
  const element = useRef<HTMLAudioElement>(null);
  const [muted, setMuted] = useState(false), [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState(false), [pinned, setPinned] = useState(false);
  const dock = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panelId = useId();
  const open = hovered || pinned, allOn = !muted && !effectsMuted, mixed = muted !== effectsMuted;
  useEffect(() => {
    try { mutedRef.current = localStorage.getItem(MUSIC_STORAGE_KEY) === "1"; setMuted(mutedRef.current); } catch { /* Keep an in-memory preference. */ }
    const music = createBackgroundMusic(() => element.current!, setFailed); player.current = music;
    music.setMuted(mutedRef.current); music.setHidden(document.hidden);
    const start = (event: Event) => { if (!(event.target instanceof Element && event.target.closest("[data-audio-control]"))) music.activate(); };
    const visibility = () => music.setHidden(document.hidden);
    document.addEventListener("pointerdown", start, { passive: true }); document.addEventListener("keydown", start);
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("pointerdown", start); document.removeEventListener("keydown", start); document.removeEventListener("visibilitychange", visibility); music.dispose(); player.current = null; };
  }, []);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !dock.current?.contains(event.target)) { setPinned(false); setHovered(false); } };
    document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside);
  }, []);
  function setMusicMuted(value: boolean) {
    mutedRef.current = value; setMuted(value); player.current?.setMuted(value);
    try { localStorage.setItem(MUSIC_STORAGE_KEY, mutedRef.current ? "1" : "0"); } catch { /* Keep this visit's choice. */ }
    if (!mutedRef.current) player.current?.activate();
  }
  function toggleMusic() {
    if (failed && !mutedRef.current) { setFailed(false); player.current?.activate(); return; }
    setMusicMuted(!mutedRef.current);
  }
  function toggleAll() {
    setMusicMuted(allOn);
    if (effectsMuted !== allOn) onToggleEffects();
  }
  return <><audio ref={element} preload="none" hidden aria-hidden="true" />
    <div ref={dock} className={styles.dock} data-audio-control="true" onPointerEnter={event => { if (event.pointerType !== "touch") setHovered(true); }} onPointerLeave={() => setHovered(false)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setPinned(false); setHovered(false); } }}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setPinned(false); setHovered(false); trigger.current?.focus(); } }}>
      <button ref={trigger} type="button" className={styles.trigger} aria-label={`Audio settings: music ${muted ? "off" : "on"}, sound effects ${effectsMuted ? "off" : "on"}`}
        aria-expanded={open} aria-controls={panelId} onClick={() => setPinned(value => !value)}>
        {!muted ? <HiOutlineMusicalNote aria-hidden="true" /> : !effectsMuted ? <HiOutlineSpeakerWave aria-hidden="true" /> : <HiOutlineSpeakerXMark aria-hidden="true" />}
      </button>
      <div id={panelId} className={styles.panel} role="group" aria-label="Audio options" hidden={!open}>
        <button type="button" aria-pressed={!muted} onClick={toggleMusic}><span>Music</span><strong>{failed && !muted ? "Retry" : muted ? "Off" : "On"}</strong></button>
        <button type="button" aria-pressed={!effectsMuted} onClick={onToggleEffects}><span>Sound effects</span><strong>{effectsMuted ? "Off" : "On"}</strong></button>
        <button type="button" aria-pressed={mixed ? "mixed" : allOn} onClick={toggleAll}><span>Music + SFX</span><strong>{mixed ? "Mixed" : allOn ? "On" : "Off"}</strong></button>
      </div>
    </div>
  </>;
}
