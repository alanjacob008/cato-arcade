/* eslint-disable react/no-unknown-property -- react-three-fiber JSX (args, position, intensity, object) */
// The page-roaming Cato: a fixed, full-viewport, click-through layer with a small canvas that follows the cat around
// the page. The cat's world is read off the DOM every few frames: the top edge of every big panel is a floor it can
// walk and jump between (platforms.ts), the viewport bottom is the ground, and its spot (the `[data-cat-home]` anchor
// floor) is home. Hovering the cat purrs, clicking swats, three clicks annoy it; it walks, jumps, sits, grooms,
// pounces at a resting cursor and sleeps when left alone (brain.ts). Ported from cato-3d's CatOverlay; lazy-loaded
// through CatLayer.
import { Suspense, useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { Canvas } from '@react-three/fiber';
import { withBasePath } from '../utils/base-path';
import CatModel, { type CatInputs } from './CatModel';
import { useCatBus } from './CatContext';
import { useCatMoodStore } from './CatMood';
import { armDrag, IDLE_DRAG, moveDrag, pressDrag, releaseDrag, type DragState } from './drag';
import {
  extractPlatforms, GROUND_SELECTORS, KEEPOUT_SELECTORS, PLATFORM_SELECTORS, type KeepOutRect, type PlatformRect,
} from './platforms';
import { prefersReducedMotion } from './support';

export interface CatOverlayProps {
  /** Cat height in CSS pixels. Default 140. */
  size?: number;
  /** Stacking order of the layer: above the page, below the header menu (40) and dialogs. Default 35. */
  zIndex?: number;
  /** URL of the glb. Default withBasePath('/cato.glb'). */
  src?: string;
  /** Called once, after the first rendered frame. */
  onReady?: () => void;
}

const LONG_PRESS_MS = 450;
/** How often the page's platforms are measured (ms); also on resize and scroll. */
const PLATFORM_POLL_MS = 200;
/** The spot's floor, as a fraction of the anchor's height from its bottom (matches .nl-cat-room-img's bottom:8%). */
const ANCHOR_FLOOR = 0.08;

// stable ids for the elements the cat walks on (the brain tracks platforms by id across sweeps)
const platformIds = new WeakMap<Element, string>();
let nextPlatformId = 1;
function platformId(el: Element): string {
  let id = platformIds.get(el);
  if (!id) {
    id = `p${nextPlatformId++}`;
    platformIds.set(el, id);
  }
  return id;
}

/** Sweep the DOM for the cat's floors: the home anchor's floor line plus the top edges of the platform elements. */
export function measurePlatformRects(doc: Document): PlatformRect[] {
  const rects: PlatformRect[] = [];
  const home = doc.querySelector<HTMLElement>('[data-cat-home]');
  if (home) {
    const r = home.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      rects.push({ id: 'home', left: r.left, right: r.right, top: r.bottom - r.height * ANCHOR_FLOOR, bottom: r.bottom, home: true });
    }
  }
  const seen = new Set<Element>();
  for (const el of doc.querySelectorAll<HTMLElement>(PLATFORM_SELECTORS.join(','))) {
    if (seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    rects.push({ id: platformId(el), left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  }
  return rects;
}

/** The ground line: the top of the fixed footer bar when it is on screen, else undefined (the viewport bottom). */
export function measureGroundY(doc: Document): number | undefined {
  for (const el of doc.querySelectorAll<HTMLElement>(GROUND_SELECTORS.join(','))) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) continue;
    return r.top;
  }
  return undefined;
}

/** Sweep the DOM for the cat's keep-out zones: the visible controls (and anything marked `data-cat-avoid`). */
export function measureKeepOutRects(doc: Document): KeepOutRect[] {
  const rects: KeepOutRect[] = [];
  for (const el of doc.querySelectorAll<HTMLElement>(KEEPOUT_SELECTORS.join(','))) {
    if (el.closest('.nl-cat-overlay')) continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  return rects;
}

export default function CatOverlay({ size = 140, zIndex = 35, src = withBasePath('/cato.glb'), onReady }: CatOverlayProps) {
  const store = useCatMoodStore();
  const inputs = useRef<CatInputs>({
    hovered: false, clicked: false, pointer: null, pointerMovedAt: 0, pointerKind: '',
    viewport: { w: typeof window === 'undefined' ? 1024 : window.innerWidth, h: typeof window === 'undefined' ? 768 : window.innerHeight },
    reducedMotion: prefersReducedMotion(), commands: [], platforms: [], keepOut: [], drag: null,
    pose: store.get().pose, poseChanged: false,
  });
  const hitbox = useRef<HTMLDivElement | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  const bus = useCatBus();

  // page commands via useCat() (optional)
  useEffect(() => bus?.subscribe((clip) => inputs.current.commands.push(clip)), [bus]);

  // the mood: pose changes are handled in the frame loop (they may need the anchor's position)
  useEffect(() => store.subscribe(() => {
    const { pose } = store.get();
    if (pose === inputs.current.pose) return;
    inputs.current.pose = pose;
    inputs.current.poseChanged = true;
  }), [store]);

  // pointer position anywhere on the page (for head tracking / pounce), and the drag once the cat is picked up:
  // its pointer is followed window-wide, as the hitbox lets events through while he dangles
  const drag = useRef<DragState>(IDLE_DRAG);
  const suppressClick = useRef(false);
  const setDrag = (next: DragState) => {
    drag.current = next;
    inputs.current.drag = next.phase === 'dragging' ? { x: next.x, y: next.y } : null;
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      inputs.current.pointer = { x: e.clientX, y: e.clientY };
      inputs.current.pointerMovedAt = performance.now();
      inputs.current.pointerKind = e.pointerType === 'pen' ? 'mouse' : e.pointerType;
      if (drag.current.phase !== 'idle') {
        const next = moveDrag(drag.current, { id: e.pointerId, x: e.clientX, y: e.clientY });
        if (next.phase === 'dragging' && drag.current.phase !== 'dragging') {
          inputs.current.hovered = false;
          // the pointer sweeps the page while he is carried: no text selection (a selection's native drag would
          // cancel the next pick-up)
          document.getSelection()?.removeAllRanges();
          document.documentElement.style.userSelect = 'none';
        }
        setDrag(next);
      }
    };
    const up = (e: PointerEvent) => {
      if (drag.current.phase === 'idle') return;
      const { state, result } = releaseDrag(drag.current, e.pointerId);
      if (result === 'none') return;
      setDrag(state);
      if (result === 'drop') {
        document.documentElement.style.userSelect = '';
        suppressClick.current = true; // the click that may follow a drag is not a swat
        window.setTimeout(() => { suppressClick.current = false; }, 400);
      }
    };
    const leave = () => { inputs.current.pointer = null; };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    document.documentElement.addEventListener('pointerleave', leave);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.documentElement.removeEventListener('pointerleave', leave);
    };
  }, []);

  // page size (the canvas itself is small and follows the cat)
  useEffect(() => {
    const sync = () => { inputs.current.viewport = { w: window.innerWidth, h: window.innerHeight }; };
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  // the platforms: where the panels and Cato's spot are on screen right now (polled: they scroll, resize and come and
  // go with routes). Published on the layer for tooling / live checks.
  const layerEl = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const measure = () => {
      const { w, h } = inputs.current.viewport;
      const keepOut = measureKeepOutRects(document);
      const platforms = extractPlatforms(measurePlatformRects(document), { w, h }, { size, keepOut, groundY: measureGroundY(document) });
      inputs.current.platforms = platforms;
      inputs.current.keepOut = keepOut;
      if (layerEl.current) {
        layerEl.current.dataset.platforms = JSON.stringify(platforms.map((p) => [p.id, Math.round(p.x0), Math.round(p.x1), Math.round(p.y), p.home ? 1 : 0]));
        layerEl.current.dataset.keepout = String(keepOut.length);
      }
    };
    measure();
    const id = window.setInterval(measure, PLATFORM_POLL_MS);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true, capture: true });
    return () => {
      window.clearInterval(id);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, { capture: true });
    };
  }, [size]);

  // reduced motion preference (the layer is not mounted when it is set at load; honour a change while running)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => { inputs.current.reducedMotion = mq.matches; };
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, []);

  // stop rendering while the tab is hidden
  useEffect(() => {
    const sync = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  // hit-box interaction: mouse hover = purr, click/tap = swat, touch long-press = purr; press and move (touch: after
  // the long-press) picks the cat up
  const press = useRef<{ id: number; timer: number; long: boolean } | null>(null);
  const onPointerEnter = (e: RPointerEvent) => {
    if (e.pointerType === 'mouse' || e.pointerType === 'pen') inputs.current.hovered = true;
  };
  const onPointerLeave = (e: RPointerEvent) => {
    if (e.pointerType === 'mouse' || e.pointerType === 'pen') inputs.current.hovered = false;
  };
  const onPointerDown = (e: RPointerEvent) => {
    inputs.current.pointerKind = e.pointerType === 'pen' ? 'mouse' : e.pointerType;
    if (e.button !== 0 && e.pointerType !== 'touch') return;
    // no text selection / native drag from a press on the cat (it would cancel the pointer mid-drag)
    if (e.pointerType !== 'touch') e.preventDefault();
    setDrag(pressDrag(drag.current, { id: e.pointerId, x: e.clientX, y: e.clientY, kind: e.pointerType }));
    if (e.pointerType !== 'touch' || press.current) return; // ignore extra fingers
    const p = { id: e.pointerId, timer: 0, long: false };
    p.timer = window.setTimeout(() => {
      p.long = true;
      inputs.current.hovered = true;
      setDrag(armDrag(drag.current, p.id));
    }, LONG_PRESS_MS);
    press.current = p;
  };
  const endTouch = (e: RPointerEvent) => {
    const p = press.current;
    if (e.pointerType !== 'touch' || !p || p.id !== e.pointerId) return;
    window.clearTimeout(p.timer);
    if (p.long) {
      inputs.current.hovered = false;
      suppressClick.current = true; // the click that follows a long-press is not a swat
      window.setTimeout(() => { suppressClick.current = false; }, 400);
    }
    press.current = null;
  };
  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    inputs.current.clicked = true;
  };
  useEffect(() => () => {
    if (press.current) window.clearTimeout(press.current.timer);
  }, []);

  const layer: CSSProperties = { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex, overflow: 'hidden' };
  // A canvas a few cat-sizes wide that follows the cat: cheap enough to supersample (2-3x) for crisp edges.
  const stageW = Math.round(size * 3.4);
  const stageH = Math.round(size * 1.75);
  const dpr = typeof window === 'undefined' ? 2 : Math.min(3, Math.max(2, window.devicePixelRatio || 1));
  return (
    <div ref={layerEl} style={layer} className="nl-cat-overlay" aria-hidden="true" data-testid="cato-overlay">
      <div
        ref={stage}
        style={{ position: 'absolute', left: 0, top: 0, width: stageW, height: stageH, pointerEvents: 'none', willChange: 'transform' }}
      >
        <Canvas
          orthographic
          flat
          dpr={dpr}
          frameloop={visible ? 'always' : 'never'}
          gl={{ alpha: true, antialias: true, powerPreference: 'low-power' }}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          camera={{ position: [0, 0, 10], zoom: 100 }}
        >
          <hemisphereLight args={['#FFF3E2', '#B07A52', 1.35]} />
          <directionalLight position={[-1.2, 2.6, 3]} intensity={1.9} color="#FFF8EE" />
          <Suspense fallback={null}>
            <CatModel src={src} size={size} inputs={inputs} hitbox={hitbox} stage={stage} onReady={onReady} />
          </Suspense>
        </Canvas>
      </div>
      {/* the cat's hit area: decorative, aria-hidden with the layer, mouse/touch only (no keyboard affordance by design) */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        ref={hitbox}
        className="nl-cat-hitbox"
        data-testid="cato-hitbox"
        data-clip=""
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerDown={onPointerDown}
        onPointerUp={endTouch}
        onPointerCancel={endTouch}
        onClick={onClick}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          position: 'absolute', left: 0, top: 0, width: 0, height: 0,
          pointerEvents: 'auto', cursor: 'grab', touchAction: 'none',
          WebkitTapHighlightColor: 'transparent', borderRadius: '40%',
        }}
      />
    </div>
  );
}
