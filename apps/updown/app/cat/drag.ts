// Picking the cat up: the pointer state machine (pure; the overlay feeds it pointer events in viewport px).
// A press that moves beyond the slop becomes a drag (touch: only once the long-press has armed it, so a tap stays a
// tap and a swipe scrolls); a press released without moving is a click (a swat). Releasing a drag drops the cat.

export type DragPhase = 'idle' | 'pressed' | 'dragging';

export interface DragState {
  phase: DragPhase;
  /** the pointer being followed (-1 when idle) */
  id: number;
  /** 'mouse' | 'pen' | 'touch' */
  kind: string;
  /** touch: the long-press fired, so moving now drags */
  long: boolean;
  /** where the press started */
  x0: number;
  y0: number;
  /** the pointer now */
  x: number;
  y: number;
}

export const IDLE_DRAG: DragState = { phase: 'idle', id: -1, kind: '', long: false, x0: 0, y0: 0, x: 0, y: 0 };

/** px the pointer must move before a press turns into a drag */
export const DRAG_SLOP = 6;

/** Pointer down on the cat. Ignored while another pointer is already pressing or dragging. */
export function pressDrag(s: DragState, p: { id: number; x: number; y: number; kind: string }): DragState {
  if (s.phase !== 'idle') return s;
  return { phase: 'pressed', id: p.id, kind: p.kind, long: false, x0: p.x, y0: p.y, x: p.x, y: p.y };
}

/** Touch: the long-press fired for pointer `id`, so moving it now picks the cat up. */
export function armDrag(s: DragState, id: number): DragState {
  if (s.phase !== 'pressed' || s.id !== id) return s;
  return { ...s, long: true };
}

/** The pointer moved: a press past the slop starts dragging (touch: when armed); a drag follows it. */
export function moveDrag(s: DragState, p: { id: number; x: number; y: number }): DragState {
  if (s.phase === 'idle' || s.id !== p.id) return s;
  if (s.phase === 'dragging') return { ...s, x: p.x, y: p.y };
  if (s.kind === 'touch' && !s.long) return s;
  if (Math.hypot(p.x - s.x0, p.y - s.y0) < DRAG_SLOP) return s;
  return { ...s, phase: 'dragging', x: p.x, y: p.y };
}

/** The pointer was released or cancelled: a drag drops the cat, an unmoved press is a click, another pointer is noise. */
export function releaseDrag(s: DragState, id: number): { state: DragState; result: 'click' | 'drop' | 'none' } {
  if (s.phase === 'idle' || s.id !== id) return { state: s, result: 'none' };
  return { state: IDLE_DRAG, result: s.phase === 'dragging' ? 'drop' : 'click' };
}
