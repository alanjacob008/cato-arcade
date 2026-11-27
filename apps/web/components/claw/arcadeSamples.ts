import type { MotorKind } from "./arcadeSound";

export const SAMPLE_MUTE_KEY = "cato-claw-sample-sfx-muted-v1";
export const ARCADE_SAMPLES = {
  button: { file: "arcade-button.mp3", volume: .4 },
  silver: { file: "coin-select-silver.mp3", volume: .005 },
  gold: { file: "coin-select-gold.mp3", volume: .005 },
  diamond: { file: "coin-select-diamond.mp3", volume: .005 },
  win: { file: "win.mp3", volume: .02 },
  lose: { file: "lose.mp3", volume: .02 },
} as const;
export type SampleCue = keyof typeof ARCADE_SAMPLES;
export const isSampleCue = (value: string): value is SampleCue => Object.hasOwn(ARCADE_SAMPLES, value);

/** Six small shared players, never a new audio element for each click/frame. */
export function createArcadeSamples(makeAudio = (src: string) => new Audio(src), now = () => performance.now()) {
  const players = new Map<SampleCue, HTMLAudioElement>(), last = new Map<SampleCue, number>();
  let activated = false, muted = false, hidden = false, disposed = false;
  for (const cue of Object.keys(ARCADE_SAMPLES) as SampleCue[]) {
    const audio = makeAudio(`/claw/sfx/${ARCADE_SAMPLES[cue].file}`);
    audio.preload = "auto"; audio.volume = ARCADE_SAMPLES[cue].volume; audio.load(); players.set(cue, audio);
  }
  const allowed = () => activated && !muted && !hidden && !disposed;
  function stopOne(cue: SampleCue) {
    const audio = players.get(cue)!; audio.pause(); audio.loop = false;
    try { audio.currentTime = 0; } catch { /* A failed download must not interrupt play. */ }
  }
  function start(audio: HTMLAudioElement) {
    try { void audio.play().catch(() => {}); } catch { /* Unsupported or blocked audio remains silent. */ }
  }
  function stop() { players.forEach((_audio, cue) => stopOne(cue)); }
  return {
    activate() { if (!disposed) activated = true; },
    play(cue: SampleCue) {
      if (!allowed() || now() - (last.get(cue) ?? -Infinity) < 50) return;
      last.set(cue, now());
      if (["silver", "gold", "diamond"].includes(cue)) for (const selection of ["silver", "gold", "diamond"] as const) stopOne(selection);
      if (cue === "win" || cue === "lose") { stopOne("win"); stopOne("lose"); }
      const audio = players.get(cue)!; stopOne(cue); audio.volume = ARCADE_SAMPLES[cue].volume; start(audio);
    },
    motion(_speed: number, _kind: MotorKind) {},
    setMuted(value: boolean) { muted = value; if (value) stop(); },
    setHidden(value: boolean) { hidden = value; if (value) stop(); },
    stop,
    dispose() { if (disposed) return; disposed = true; stop(); players.forEach(audio => { audio.removeAttribute("src"); audio.load(); }); },
  };
}
