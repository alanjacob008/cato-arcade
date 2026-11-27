type Point = { id: number; x: number; y: number };
type Pointer = { pointerId: number; clientX: number; clientY: number; button: number; isPrimary: boolean };

/** One captured pointer drives aiming, for mouse, pen and touch alike. */
export function createAimGesture() {
  let point: Point | null = null;
  return {
    start(event: Pointer, enabled: boolean): boolean {
      if (!enabled || event.button !== 0 || !event.isPrimary || point) return false;
      point = { id: event.pointerId, x: event.clientX, y: event.clientY };
      return true;
    },
    move(event: Pointer, enabled: boolean, width: number, height: number): { x: number; y: number } | null {
      if (!point || point.id !== event.pointerId) return null;
      const previous = point;
      point = { id: event.pointerId, x: event.clientX, y: event.clientY };
      if (!enabled || width <= 0 || height <= 0) return null;
      return { x: (point.x - previous.x) / width, y: (point.y - previous.y) / height };
    },
    end(pointerId: number) { if (point?.id === pointerId) point = null; },
  };
}
