import { CUES, noteFrequency, type ArcadeCue } from "./feedback";

export type MotorKind = "aim" | "hoist";
export const SOUND_STORAGE_KEY = "cato-claw-sound-muted-v1";
const MASTER_VOLUME = .48;
const VOICE_LIMIT = 24;

/** Original pulse/triangle chiptunes and a dry plastic button switch. No asset downloads. */
export function createArcadeSound(context: AudioContext, offline = false) {
  const master = context.createGain(), limiter = context.createDynamicsCompressor();
  master.gain.value = MASTER_VOLUME;
  limiter.threshold.value = -12; limiter.knee.value = 6; limiter.ratio.value = 8;
  limiter.attack.value = .002; limiter.release.value = .08;
  master.connect(limiter); limiter.connect(context.destination);

  // A damped hollow-shell knock, with a quieter spring return 29 ms later.
  // Synthesized once and shared by every button; deliberately no pitched UI beep.
  const plastic = context.createBuffer(1, Math.ceil(context.sampleRate * .075), context.sampleRate);
  const plasticSamples = plastic.getChannelData(0);
  let seed = 0x4341544f, previous = 0;
  for (let i = 0; i < plasticSamples.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 2147483648 - 1, high = noise - previous; previous = noise;
    const time = i / context.sampleRate;
    const strike = (t: number) => t < 0 ? 0 : Math.min(1, t / .0007) * (
      .32 * high * Math.exp(-t / .0025) +
      (.27 * Math.sin(2 * Math.PI * 720 * t) + .18 * Math.sin(2 * Math.PI * 1480 * t)) * Math.exp(-t / .007)
    );
    plasticSamples[i] = strike(time) + .38 * strike(time - .029);
  }
  // A short 15-bit shift-register burst supplies the retro landing texture.
  const noise = context.createBuffer(1, Math.ceil(context.sampleRate * .065), context.sampleRate), samples = noise.getChannelData(0);
  let register = 1, held = 0;
  const step = Math.max(1, Math.round(context.sampleRate / 7000));
  for (let i = 0; i < samples.length; i++) {
    if (i % step === 0) { register = (register >>> 1) | (((register ^ (register >>> 1)) & 1) << 14); held = (register & 1) ? 1 : -1; }
    samples[i] = held;
  }
  const voices = new Map<AudioScheduledSourceNode, AudioNode[]>(), lastCue = new Map<ArcadeCue, number>();
  let muted = false, hidden = false, disposed = false;
  const allowed = () => !disposed && !muted && !hidden && (context.state === "running" || offline);
  function release(source: AudioScheduledSourceNode) {
    const nodes = voices.get(source); if (!nodes) return;
    voices.delete(source); source.disconnect(); nodes.forEach(node => node.disconnect());
  }
  function track(source: AudioScheduledSourceNode, nodes: AudioNode[]) {
    if (voices.size >= VOICE_LIMIT) { const oldest = voices.keys().next().value!; oldest.stop(); release(oldest); }
    voices.set(source, nodes); source.onended = () => release(source);
  }
  function envelope(at: number, duration: number, gain: number, gated = false) {
    const node = context.createGain();
    node.gain.setValueAtTime(0, at); node.gain.linearRampToValueAtTime(gain, at + .002);
    if (gated) node.gain.setValueAtTime(gain, at + duration * .65);
    node.gain.exponentialRampToValueAtTime(.0001, at + duration);
    return node;
  }
  function tone(midi: number, at: number, duration: number, gain: number, wave: OscillatorType = "square") {
    const source = context.createOscillator(), amp = envelope(at, duration, gain, wave === "square"), filter = context.createBiquadFilter();
    source.type = wave; source.frequency.setValueAtTime(noteFrequency(midi), at);
    // Keep the pulse harmonics crisp without an abrasive high-frequency edge.
    filter.type = "lowpass"; filter.frequency.value = 5400; filter.Q.value = .5;
    source.connect(filter); filter.connect(amp); amp.connect(master);
    track(source, [filter, amp]); source.start(at); source.stop(at + duration + .005);
  }
  function sample(buffer: AudioBuffer, at: number, duration: number, gain: number, frequency: number) {
    const source = context.createBufferSource(), filter = context.createBiquadFilter(), amp = envelope(at, duration, gain);
    if (buffer === plastic) {
      // The sample already decays; retain its small return click rather than fading it twice.
      amp.gain.cancelScheduledValues(at); amp.gain.setValueAtTime(0, at);
      amp.gain.linearRampToValueAtTime(gain, at + .001);
      amp.gain.setValueAtTime(gain, at + duration - .005);
      amp.gain.linearRampToValueAtTime(0, at + duration);
    }
    source.buffer = buffer; filter.type = "lowpass"; filter.frequency.value = frequency; filter.Q.value = .6;
    source.connect(filter); filter.connect(amp); amp.connect(master);
    track(source, [filter, amp]); source.start(at); source.stop(at + duration);
  }
  function silence() { for (const source of voices.keys()) { source.stop(); release(source); } }
  function play(cue: ArcadeCue) {
    if (cue === "motor" || cue === "joystick" || !allowed()) return;
    const now = context.currentTime;
    // Capture and play handlers can fire for the same physical press; sound it once.
    if (now - (lastCue.get(cue) ?? -Infinity) < .04) return;
    lastCue.set(cue, now);
    const start = now + .004;
    if (cue === "press") sample(plastic, start, .075, .85, 4300);
    else {
      CUES[cue].forEach(note => tone(note.midi, start + note.at, note.duration, note.gain, note.wave));
      if (cue === "impact") sample(noise, start, .04, .045, 1800);
    }
  }
  return {
    play,
    // Preserve the machine's event interface while keeping every movement path silent.
    motion(_speed: number, _kind: MotorKind) {},
    setMuted(value: boolean) { muted = value; if (value) silence(); master.gain.setTargetAtTime(value || hidden ? 0 : MASTER_VOLUME, context.currentTime, .015); },
    setHidden(value: boolean) { hidden = value; if (value) silence(); master.gain.setTargetAtTime(value || muted ? 0 : MASTER_VOLUME, context.currentTime, .015); },
    stop: silence,
    dispose() { if (disposed) return; silence(); disposed = true; master.disconnect(); limiter.disconnect(); },
  };
}
