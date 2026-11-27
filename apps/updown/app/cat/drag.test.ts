import { describe, expect, it } from 'vitest';
import { armDrag, DRAG_SLOP, IDLE_DRAG, moveDrag, pressDrag, releaseDrag } from './drag';

describe('drag state machine', () => {
  it('mouse: a press that moves past the slop drags, releasing drops', () => {
    let s = pressDrag(IDLE_DRAG, { id: 1, x: 100, y: 100, kind: 'mouse' });
    expect(s.phase).toBe('pressed');
    s = moveDrag(s, { id: 1, x: 103, y: 102 });
    expect(s.phase).toBe('pressed');
    s = moveDrag(s, { id: 1, x: 100 + DRAG_SLOP, y: 100 });
    expect(s.phase).toBe('dragging');
    s = moveDrag(s, { id: 1, x: 300, y: 250 });
    expect([s.x, s.y]).toEqual([300, 250]);
    const r = releaseDrag(s, 1);
    expect(r.result).toBe('drop');
    expect(r.state).toBe(IDLE_DRAG);
  });

  it('a press released without moving is a click', () => {
    const s = moveDrag(pressDrag(IDLE_DRAG, { id: 1, x: 100, y: 100, kind: 'mouse' }), { id: 1, x: 102, y: 101 });
    expect(releaseDrag(s, 1)).toEqual({ state: IDLE_DRAG, result: 'click' });
  });

  it('touch: moving only drags once the long-press armed it (a swipe is a scroll, not a drag)', () => {
    let s = pressDrag(IDLE_DRAG, { id: 7, x: 10, y: 10, kind: 'touch' });
    s = moveDrag(s, { id: 7, x: 60, y: 10 });
    expect(s.phase).toBe('pressed');
    s = armDrag(s, 7);
    expect(s.long).toBe(true);
    s = moveDrag(s, { id: 7, x: 61, y: 10 });
    expect(s.phase).toBe('dragging');
    expect(releaseDrag(s, 7).result).toBe('drop');
  });

  it('other pointers are ignored, a second press does not steal the drag, idle release is noise', () => {
    let s = pressDrag(IDLE_DRAG, { id: 1, x: 0, y: 0, kind: 'mouse' });
    expect(pressDrag(s, { id: 2, x: 5, y: 5, kind: 'touch' })).toBe(s);
    expect(moveDrag(s, { id: 2, x: 50, y: 50 })).toBe(s);
    expect(armDrag(s, 2)).toBe(s);
    expect(releaseDrag(s, 2).result).toBe('none');
    s = moveDrag(s, { id: 1, x: 50, y: 50 });
    expect(releaseDrag(s, 2)).toEqual({ state: s, result: 'none' });
    expect(releaseDrag(IDLE_DRAG, 1).result).toBe('none');
  });
});
