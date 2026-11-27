// Mounts the roaming cat once, at the app shell (it survives route changes). Decides whether the browser can run it
// (WebGL, not reduced motion), lazy-loads the three.js chunk and reports the outcome to the mood store, so the home
// anchor shows the static picture whenever the overlay isn't on. Renders nothing itself when unsupported or failed.
import { Component, Suspense, lazy, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { useCatMoodStore } from './CatMood';
import { catSupported } from './support';
import type { CatOverlayProps } from './CatOverlay';

export const CatOverlay = lazy(() => import('./CatOverlay'));

class CatErrorBoundary extends Component<{ onError: (e: unknown) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError(error);
    void info;
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export type CatLayerProps = Omit<CatOverlayProps, 'onReady'> & {
  /** Mount the cat at all. Default true. */
  enabled?: boolean;
};

export function CatLayer({ enabled = true, ...overlay }: CatLayerProps) {
  const store = useCatMoodStore();
  const [supported] = useState(() => catSupported());
  const [failed, setFailed] = useState(false);
  const live = enabled && supported && !failed;
  useEffect(() => {
    store.setOverlay(live ? 'loading' : failed ? 'failed' : 'off');
    return () => store.setOverlay('off');
  }, [store, live, failed]);
  if (!live) return null;
  return (
    <CatErrorBoundary
      onError={(e) => {
        console.warn('[cat] 3D Cato unavailable, showing the picture instead:', e);
        setFailed(true);
      }}
    >
      <Suspense fallback={null}>
        <CatOverlay {...overlay} onReady={() => store.setOverlay('on')} />
      </Suspense>
    </CatErrorBoundary>
  );
}
