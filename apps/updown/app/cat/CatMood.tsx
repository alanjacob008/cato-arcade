// Cato's mood: a tiny store pages write (`useCatMood().set(pose)`) and the roaming overlay reads. Also carries whether
// the overlay is running, so the home anchor knows when to show the static picture instead. No three.js here.
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { CatPose } from '../game/cat-pose';

/** 'off': no WebGL / reduced motion; 'loading': chunk + glb on the way; 'on': the cat roams; 'failed': renderer error */
export type CatOverlayStatus = 'off' | 'loading' | 'on' | 'failed';

export interface CatMoodState {
  pose: CatPose;
  overlay: CatOverlayStatus;
}

export interface CatMoodStore {
  get(): CatMoodState;
  set(pose: CatPose): void;
  setOverlay(status: CatOverlayStatus): void;
  subscribe(fn: () => void): () => void;
}

export function createCatMoodStore(initial: Partial<CatMoodState> = {}): CatMoodStore {
  let state: CatMoodState = { pose: 'asleep', overlay: 'off', ...initial };
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());
  return {
    get: () => state,
    set: (pose) => {
      if (state.pose === pose) return;
      state = { ...state, pose };
      emit();
    },
    setOverlay: (overlay) => {
      if (state.overlay === overlay) return;
      state = { ...state, overlay };
      emit();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// A module-level store is the default, so `useCatMood()` works in tests and pages rendered without the provider.
const Ctx = createContext<CatMoodStore>(createCatMoodStore());

export function CatMoodProvider({ children, store }: { children: ReactNode; store?: CatMoodStore }) {
  const own = useMemo(() => store ?? createCatMoodStore(), [store]);
  return <Ctx.Provider value={own}>{children}</Ctx.Provider>;
}

/** Internal: the raw store (overlay + anchor). */
export function useCatMoodStore(): CatMoodStore {
  return useContext(Ctx);
}

export interface CatMoodApi {
  /** The current pose. */
  pose: CatPose;
  /** Whether the roaming overlay is showing the cat. */
  overlay: CatOverlayStatus;
  /** Push a pose (what the cat is doing / where it goes). */
  set(pose: CatPose): void;
}

/** The page side of the cat: `const mood = useCatMood(); useEffect(() => mood.set(pose), [pose])`. */
export function useCatMood(): CatMoodApi {
  const store = useContext(Ctx);
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  return useMemo(() => ({ pose: state.pose, overlay: state.overlay, set: store.set }), [state, store]);
}
