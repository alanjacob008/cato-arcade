// React face of the engine: mount <SfxProvider> once at the app shell (installs the gesture / visibility listeners and
// warms the cache after the first gesture); `useSfx()` plays sounds and reads / sets the mute flag.
import { createContext, useCallback, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { sfx as defaultEngine, type PlayOptions, type SfxEngine, type SfxName } from './sfx';

const Ctx = createContext<SfxEngine>(defaultEngine);

export function SfxProvider({ children, engine = defaultEngine }: { children: ReactNode; engine?: SfxEngine }) {
  useEffect(() => {
    const uninstall = engine.install();
    engine.preload();
    return uninstall;
  }, [engine]);
  return <Ctx.Provider value={engine}>{children}</Ctx.Provider>;
}

export interface SfxApi {
  play(name: SfxName, options?: PlayOptions): void;
  muted: boolean;
  setMuted(muted: boolean): void;
  toggle(): void;
  engine: SfxEngine;
}

export function useSfx(): SfxApi {
  const engine = useContext(Ctx);
  const muted = useSyncExternalStore(
    useCallback((cb: () => void) => engine.subscribe(cb), [engine]),
    () => engine.muted,
    () => false,
  );
  return {
    engine,
    muted,
    play: useCallback((name: SfxName, options?: PlayOptions) => engine.play(name, options), [engine]),
    setMuted: useCallback((m: boolean) => engine.setMuted(m), [engine]),
    toggle: useCallback(() => { engine.unlock(); engine.toggleMuted(); }, [engine]),
  };
}
