// The sound effects engine: Web Audio, one lazily created AudioContext (unlocked by the first user gesture, as the
// autoplay policy requires), decoded-buffer cache, a master gain, and a mute flag persisted in localStorage
// (`updown.sfx.muted`; sound is ON by default). Nothing plays while the page is hidden. The engine is a plain
// module singleton (`sfx`) so plain handlers can use it without React context; `SfxProvider` / `useSfx()` are the
// React face of it. Only the game itself makes noise (calls, fills, results, the countdown); the cat is silent.
import { withBasePath } from '@/utils/base-path';

export const SFX_NAMES = [
  'call-up', 'call-down', 'filled', 'win', 'win-big', 'loss', 'tick', 'tick-final', 'close', 'ui-click',
] as const;
export type SfxName = (typeof SFX_NAMES)[number];

export const MUTED_KEY = 'updown.sfx.muted';
/** the user gestures that may unlock audio (pointerdown fires before click, so the click's own sound still plays) */
const GESTURES = ['pointerdown', 'keydown', 'touchstart'] as const;
/** a one-shot still decoding this long after it was asked for is dropped rather than played late */
const LATE_MS = 300;

export interface PlayOptions {
  /** linear gain, 1 = the file's own level */
  gain?: number;
  /** playback rate, 1 = as recorded (pitch follows) */
  rate?: number;
  /** stereo position, -1 (left) … 1 (right) */
  pan?: number;
}

export interface LoopHandle {
  /** fade out over `ms` (default 120) and stop */
  stop(ms?: number): void;
  readonly playing: boolean;
}

/** The subset of AudioContext the engine uses: tests inject a fake. */
export type SfxContext = Pick<AudioContext, 'state' | 'currentTime' | 'destination' | 'createGain' | 'createBufferSource' | 'decodeAudioData' | 'resume' | 'suspend'>
  & { createStereoPanner?: AudioContext['createStereoPanner'] };

export interface SfxEngineOptions {
  createContext?: () => SfxContext | null;
  fetchFile?: (url: string) => Promise<ArrayBuffer>;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** where the files live (default: the app's /sfx/) */
  base?: string;
  /** the file extension to use, chosen by what the browser can decode */
  ext?: 'ogg' | 'mp3' | 'wav';
  document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> | null;
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
}

export interface SfxEngine {
  /** Play a one-shot. Silently does nothing before the first gesture, while muted, or while the page is hidden. */
  play(name: SfxName, options?: PlayOptions): void;
  /** Start a looping sound; returns a handle to stop it. Loops survive mute toggles (the master gain handles it). */
  loop(name: SfxName, options?: PlayOptions): LoopHandle;
  /** Fetch and decode ahead of time (needs an unlocked context; otherwise it waits for the first gesture). */
  preload(names?: readonly SfxName[]): void;
  readonly muted: boolean;
  setMuted(muted: boolean): void;
  toggleMuted(): boolean;
  /** notified on every mute change */
  subscribe(listener: (muted: boolean) => void): () => void;
  /** true once a user gesture has created the AudioContext */
  readonly unlocked: boolean;
  /** Called from the gesture listeners; exposed so an explicit gesture handler (a button) can unlock too. */
  unlock(): void;
  /** Install the gesture / visibility listeners (idempotent). Returns the uninstaller. */
  install(): () => void;
  /** Tear down the context (tests). */
  dispose(): void;
}

function pickExtension(): 'ogg' | 'mp3' {
  if (typeof Audio === 'undefined') return 'ogg';
  try {
    const probe = new Audio();
    return probe.canPlayType('audio/ogg; codecs="vorbis"') ? 'ogg' : 'mp3';
  } catch {
    return 'mp3';
  }
}

export function createSfxEngine(options: SfxEngineOptions = {}): SfxEngine {
  const doc = options.document === undefined ? (typeof document === 'undefined' ? null : document) : options.document;
  const win = options.window === undefined ? (typeof window === 'undefined' ? null : window) : options.window;
  const storage = options.storage === undefined ? safeStorage() : options.storage;
  const createContext = options.createContext ?? defaultContextFactory;
  const fetchFile = options.fetchFile ?? ((url: string) => fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.arrayBuffer();
  }));
  const base = options.base ?? withBasePath('/sfx/');
  const ext = options.ext ?? pickExtension();

  let ctx: SfxContext | null = null;
  let master: GainNode | null = null;
  let muted = readMuted(storage);
  const listeners = new Set<(muted: boolean) => void>();
  const buffers = new Map<SfxName, AudioBuffer>();
  const loading = new Map<SfxName, Promise<AudioBuffer | null>>();
  const pendingPreload = new Set<SfxName>();
  let installed = false;
  let uninstall: (() => void) | null = null;

  const hidden = () => Boolean(doc && doc.visibilityState === 'hidden');

  function applyMaster() {
    if (!master || !ctx) return;
    master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.02);
  }

  function unlock() {
    if (ctx) {
      if (ctx.state === 'suspended' && !hidden()) void ctx.resume().catch(() => {});
      return;
    }
    const created = createContext();
    if (!created) return;
    ctx = created;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    if (pendingPreload.size) {
      const names = [...pendingPreload];
      pendingPreload.clear();
      names.forEach((n) => void load(n));
    }
  }

  function load(name: SfxName): Promise<AudioBuffer | null> {
    const cached = buffers.get(name);
    if (cached) return Promise.resolve(cached);
    const inFlight = loading.get(name);
    if (inFlight) return inFlight;
    if (!ctx) return Promise.resolve(null);
    const c = ctx;
    const p = fetchFile(`${base}${name}.${ext}`)
      .then((bytes) => c.decodeAudioData(bytes.slice(0)))
      .then((buffer) => {
        buffers.set(name, buffer);
        return buffer;
      })
      .catch(() => null)
      .finally(() => loading.delete(name));
    loading.set(name, p);
    return p;
  }

  function source(buffer: AudioBuffer, opts: PlayOptions, loop: boolean) {
    if (!ctx || !master) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = loop;
    if (opts.rate && opts.rate > 0) src.playbackRate.value = opts.rate;
    const gain = ctx.createGain();
    gain.gain.value = opts.gain ?? 1;
    let tail: AudioNode = gain;
    if (opts.pan && ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, opts.pan));
      gain.connect(pan);
      tail = pan;
    }
    tail.connect(master);
    src.connect(gain);
    return { src, gain };
  }

  function play(name: SfxName, opts: PlayOptions = {}) {
    if (!ctx || muted || hidden()) return;
    const buffer = buffers.get(name);
    if (buffer) { source(buffer, opts, false)?.src.start(); return; }
    // not decoded yet (the provider preloads, so this is rare): play it when it arrives, unless that is too late to
    // still feel like a response to what just happened
    const asked = Date.now();
    void load(name).then((b) => {
      if (b && Date.now() - asked < LATE_MS && !muted && !hidden()) source(b, opts, false)?.src.start();
    });
  }

  function loop(name: SfxName, opts: PlayOptions = {}): LoopHandle {
    let stopped = false;
    let live: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
    const handle = {
      get playing() { return Boolean(live) && !stopped; },
      stop(ms = 120) {
        stopped = true;
        if (!live || !ctx) { live = null; return; }
        const { src, gain } = live;
        live = null;
        const t = ctx.currentTime;
        try {
          gain.gain.setValueAtTime(gain.gain.value, t);
          gain.gain.linearRampToValueAtTime(0, t + ms / 1000);
          src.stop(t + ms / 1000 + 0.01);
        } catch { /* already ended */ }
      },
    };
    if (!ctx || hidden()) return handle;
    void load(name).then((buffer) => {
      if (!buffer || stopped || hidden()) return;
      const s = source(buffer, opts, true);
      if (!s) return;
      live = s;
      s.src.start();
    });
    return handle;
  }

  function setMuted(next: boolean) {
    if (next === muted) return;
    muted = next;
    try { storage?.setItem(MUTED_KEY, next ? '1' : '0'); } catch { /* storage unavailable */ }
    applyMaster();
    listeners.forEach((fn) => fn(muted));
  }

  function onVisibility() {
    if (!ctx) return;
    if (hidden()) void ctx.suspend().catch(() => {});
    else if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  }

  function onStorage(e: StorageEvent) {
    if (e.key === MUTED_KEY) setMuted(e.newValue === '1');
  }

  function install() {
    if (installed) return uninstall!;
    installed = true;
    const onGesture = () => unlock();
    GESTURES.forEach((ev) => doc?.addEventListener(ev, onGesture, { passive: true, capture: true }));
    doc?.addEventListener('visibilitychange', onVisibility);
    win?.addEventListener('storage', onStorage as EventListener);
    uninstall = () => {
      installed = false;
      GESTURES.forEach((ev) => doc?.removeEventListener(ev, onGesture, { capture: true }));
      doc?.removeEventListener('visibilitychange', onVisibility);
      win?.removeEventListener('storage', onStorage as EventListener);
    };
    return uninstall;
  }

  return {
    play, loop, setMuted, unlock, install,
    preload(names = SFX_NAMES) {
      if (!ctx) { names.forEach((n) => pendingPreload.add(n)); return; }
      names.forEach((n) => void load(n));
    },
    get muted() { return muted; },
    toggleMuted() { setMuted(!muted); return muted; },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    get unlocked() { return ctx !== null; },
    dispose() {
      uninstall?.();
      buffers.clear();
      const c = ctx as (SfxContext & { close?: () => Promise<void> }) | null;
      ctx = null; master = null;
      void c?.close?.().catch(() => {});
    },
  };
}

function readMuted(storage: SfxEngineOptions['storage']): boolean {
  try { return storage?.getItem(MUTED_KEY) === '1'; } catch { return false; }
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function defaultContextFactory(): SfxContext | null {
  const Ctor = typeof window === 'undefined' ? undefined
    : (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctor) return null;
  try { return new Ctor({ latencyHint: 'interactive' }); } catch { return null; }
}

/** The app's engine. `SfxProvider` installs its listeners; anything may call `sfx.play()`. */
export const sfx: SfxEngine = createSfxEngine();
