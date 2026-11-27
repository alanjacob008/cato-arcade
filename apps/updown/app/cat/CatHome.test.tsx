import { act, useEffect } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatHome } from './CatHome';
import { CatLayer } from './CatLayer';
import { CatMoodProvider, createCatMoodStore, useCatMood } from './CatMood';
import { catSupported, resetCatSupport } from './support';

const fake = vi.hoisted(() => ({ overlay: false }));
// The real chunk needs WebGL; jsdom has none. Tests that want the overlay to "work" swap in a stand-in that reports ready.
vi.mock('./CatOverlay', async (importOriginal) => {
  const real = await importOriginal<typeof import('./CatOverlay')>();
  function Stub({ onReady }: { onReady?: () => void }) {
    useEffect(() => onReady?.(), [onReady]);
    return <div data-testid="cato-overlay" className="nl-cat-overlay" />;
  }
  return { ...real, default: (props: Parameters<typeof real.default>[0]) => (fake.overlay ? <Stub {...props} /> : real.default(props)) };
});

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  resetCatSupport();
  fake.overlay = false;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as any).matchMedia;
  resetCatSupport();
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

describe('catSupported', () => {
  it('is false without WebGL (jsdom)', () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(catSupported()).toBe(false);
    expect(spy).toHaveBeenCalled();
  });
  it('is true with WebGL, false once the user prefers reduced motion', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as any);
    expect(catSupported()).toBe(true);
    (window as any).matchMedia = vi.fn().mockReturnValue({ matches: true });
    expect(catSupported()).toBe(false);
  });
});

describe('CatHome + CatLayer', () => {
  it('unsupported (no WebGL): the PNG pose sits in the anchor and there is no canvas or overlay', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    act(() => root.render(<CatMoodProvider><CatLayer /><CatHome pose="celebrate" /></CatMoodProvider>));
    const home = container.querySelector('.nl-cat-room');
    expect(home?.hasAttribute('data-cat-home')).toBe(true);
    expect(home?.getAttribute('data-mode')).toBe('static');
    expect(home?.getAttribute('data-pose')).toBe('celebrate');
    expect(home?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('img.nl-cat-room-img')?.getAttribute('src')).toBe('/updown/cato/celebrate.webp');
    expect(container.querySelector('canvas')).toBeNull();
    expect(container.querySelector('[data-testid="cato-overlay"]')).toBeNull();
    act(() => root.render(<CatMoodProvider><CatLayer /><CatHome pose="asleep" /></CatMoodProvider>));
    expect(container.querySelector('img.nl-cat-room-img')?.getAttribute('src')).toBe('/updown/cato/asleep.webp');
  });

  it('reduced motion: no overlay, the PNG pose in the anchor', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as any);
    (window as any).matchMedia = vi.fn().mockReturnValue({ matches: true });
    fake.overlay = true;
    act(() => root.render(<CatMoodProvider><CatLayer /><CatHome pose="wave" /></CatMoodProvider>));
    expect(container.querySelector('[data-testid="cato-overlay"]')).toBeNull();
    expect(container.querySelector('img.nl-cat-room-img')).not.toBeNull();
  });

  it('supported (fake WebGL): the overlay mounts once, the anchor drops the PNG and shows the spot', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as any);
    fake.overlay = true;
    act(() => root.render(<CatMoodProvider><CatLayer /><CatHome pose="wave" /></CatMoodProvider>));
    // the picture stays until the overlay reports its first frame
    expect(container.querySelector('.nl-cat-room')?.getAttribute('data-mode')).toBe('static');
    await act(async () => { await import('./CatOverlay'); });
    await flush();
    expect(container.querySelectorAll('[data-testid="cato-overlay"]')).toHaveLength(1);
    const home = container.querySelector('.nl-cat-room');
    expect(home?.getAttribute('data-mode')).toBe('overlay');
    expect(home?.hasAttribute('data-cat-home')).toBe(true);
    expect(container.querySelector('img.nl-cat-room-img')).toBeNull();
    expect(container.querySelector('.nl-cat-home-spot')).not.toBeNull();
  }, 30000);

  it('the renderer failing falls back to the picture in the anchor', async () => {
    // a fake WebGL context passes the probe; three.js then fails on it and the boundary unmounts the overlay
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => root.render(<CatMoodProvider><CatLayer /><CatHome pose="wave" /></CatMoodProvider>));
    await act(async () => {
      await import('./CatOverlay');
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(container.querySelector('.nl-cat-room')?.getAttribute('data-mode')).toBe('static');
    expect(container.querySelector('img.nl-cat-room-img')?.getAttribute('src')).toBe('/updown/cato/wave.webp');
    expect(container.querySelector('[data-testid="cato-overlay"]')).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  }, 30000);
});

describe('useCatMood', () => {
  it('pages push a pose; the store de-duplicates and notifies subscribers', () => {
    const store = createCatMoodStore();
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.get().pose));
    function Page({ pose }: { pose: 'wave' | 'alert' }) {
      const mood = useCatMood();
      useEffect(() => mood.set(pose), [mood, pose]);
      return <span data-pose={mood.pose} />;
    }
    act(() => root.render(<CatMoodProvider store={store}><Page pose="alert" /></CatMoodProvider>));
    expect(container.querySelector('span')?.getAttribute('data-pose')).toBe('alert');
    act(() => root.render(<CatMoodProvider store={store}><Page pose="alert" /></CatMoodProvider>));
    act(() => root.render(<CatMoodProvider store={store}><Page pose="wave" /></CatMoodProvider>));
    expect(seen).toEqual(['alert', 'wave']);
    expect(store.get().overlay).toBe('off');
  });

  it('works without a provider (the default store)', () => {
    function Page() {
      const mood = useCatMood();
      useEffect(() => mood.set('confused'), [mood]);
      return <span data-pose={mood.pose} />;
    }
    act(() => root.render(<Page />));
    expect(container.querySelector('span')?.getAttribute('data-pose')).toBe('confused');
  });
});
