export const FEEDBACK_DURATION = 2800;
export const CABINET_FEEDBACK_DURATION = 2000;
export const MARQUEE_SWEEP_PERIOD = 4000;
export function marqueeSweep(now: number, index: number, count: number, reducedMotion = false) {
  if (reducedMotion) return .25;
  const phase = ((now % MARQUEE_SWEEP_PERIOD) + MARQUEE_SWEEP_PERIOD) % MARQUEE_SWEEP_PERIOD;
  if (phase > 2400) return 0;
  const distance = index - phase / 2400 * (count - 1);
  return Math.exp(-.5 * (distance / .7) ** 2);
}
export type ArcadeCue = "insert" | "press" | "win" | "jackpot" | "miss" | "motor" | "grab" | "joystick" | "impact";
export type Note = Readonly<{ midi: number; at: number; duration: number; gain: number; wave?: OscillatorType; slide?: number }>;
/** Short pulse-channel melodies and triangle bass; movement intentionally has no sound. */
export const CUES: Readonly<Record<ArcadeCue, readonly Note[]>> = Object.freeze({
  insert: [
    { midi: 83, at: 0, duration: .045, gain: .075, wave: "square" },
    { midi: 95, at: .055, duration: .13, gain: .055, wave: "square" },
  ],
  // A physical plastic switch sample is synthesized separately, without a musical beep.
  press: [], joystick: [], motor: [],
  grab: [
    { midi: 79, at: 0, duration: .035, gain: .045, wave: "square" },
    { midi: 72, at: .045, duration: .055, gain: .045, wave: "square" },
  ],
  impact: [
    { midi: 43, at: 0, duration: .085, gain: .10, wave: "triangle" },
    { midi: 55, at: .035, duration: .045, gain: .035, wave: "square" },
  ],
  win: [
    ...[72, 76, 79, 84, 88, 84].map((midi, i) => ({ midi, at: i * .07, duration: i === 5 ? .19 : .055, gain: .065, wave: "square" as const })),
    ...[48, 55, 60].map((midi, i) => ({ midi, at: i * .14, duration: .105, gain: .085, wave: "triangle" as const })),
  ],
  jackpot: [
    ...[79, 84, 88, 91, 88, 91, 96, 91, 96].map((midi, i) => ({ midi, at: i * .075, duration: i === 8 ? .29 : .06, gain: .06, wave: "square" as const })),
    ...[48, 55, 60, 55, 60].map((midi, i) => ({ midi, at: i * .15, duration: .115, gain: .085, wave: "triangle" as const })),
  ],
  miss: [
    { midi: 67, at: 0, duration: .085, gain: .045, wave: "square" },
    { midi: 63, at: .105, duration: .085, gain: .04, wave: "square" },
    { midi: 60, at: .21, duration: .16, gain: .045, wave: "square" },
    { midi: 48, at: .21, duration: .16, gain: .06, wave: "triangle" },
  ],
});
export const outcomeCue = (success: boolean, cents: number): ArcadeCue => success ? cents >= 1000 ? "jackpot" : "win" : "miss";
export const noteFrequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** Four short bursts over two seconds, capped at two flashes/sec; reduced motion stays steady. */
export function cabinetFeedback(power: number, success: boolean | null, elapsed: number, reducedMotion = false) {
  const level = Math.max(0, Math.min(1, power));
  const active = success !== null && elapsed >= 0 && elapsed < CABINET_FEEDBACK_DURATION;
  const pulse = active ? reducedMotion ? .65 : .08 + .92 * Math.max(0, Math.sin(elapsed / 500 * Math.PI * 2)) ** 2 : 0;
  return { color: active ? success ? "#39ff88" : "#ff3355" : "#FEA911", active, intensity: active ? 2 + pulse * 4 : level * 1.8, halo: active ? .16 + pulse * .22 : level * .16, light: active ? 2 + pulse * 5 : level * 2.2 };
}
