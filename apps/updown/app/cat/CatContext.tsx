// Tiny context so pages can command the cat without importing three.js (the overlay is lazy).
import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import type { CatClip } from './brain';

type Listener = (clip: CatClip) => void;

export interface CatApi {
  /** Play a clip (with the transitions it needs), e.g. cat.do('Wave'). */
  do(clip: CatClip): void;
}

interface Bus extends CatApi {
  subscribe(fn: Listener): () => void;
}

const Ctx = createContext<Bus | null>(null);

export function CatProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const bus = useMemo<Bus>(() => ({
    do: (clip) => listeners.current.forEach((fn) => fn(clip)),
    subscribe: (fn) => {
      listeners.current.add(fn);
      return () => listeners.current.delete(fn);
    },
  }), []);
  return <Ctx.Provider value={bus}>{children}</Ctx.Provider>;
}

export function useCat(): CatApi {
  const bus = useContext(Ctx);
  if (!bus) throw new Error('useCat() must be used inside <CatProvider>');
  return bus;
}

/** Internal: the overlay listens for page commands. */
export function useCatBus(): Bus | null {
  return useContext(Ctx);
}
