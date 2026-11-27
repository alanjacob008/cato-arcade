import { createFrameGate } from "./frameGate";

type Clock = {
  now: () => number; hidden: () => boolean;
  requestFrame: (callback: FrameRequestCallback) => number; cancelFrame: (id: number) => void;
  timeout: (callback: () => void, ms: number) => number; clearTimeout: (id: number) => void;
};
const browserClock = (): Clock => ({ now: () => performance.now(), hidden: () => document.hidden,
  requestFrame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id),
  timeout: (callback, ms) => window.setTimeout(callback, ms), clearTimeout: id => window.clearTimeout(id) });

/** Keep active rounds advancing without relying on a hidden tab's suspended RAF.
 * Replay elapsed time in small steps so draws, delivery and landing stay ordered. */
export function createMachineLoop(tick: (now: number, dt: number, render: boolean) => void, active: () => boolean, clock: Clock = browserClock()) {
  let running = false, frame: number | null = null, timer: number | null = null, previous = 0;
  const shouldRender = createFrameGate();
  function cancel() {
    if (frame !== null) clock.cancelFrame(frame);
    if (timer !== null) clock.clearTimeout(timer);
    frame = timer = null;
  }
  function schedule(backlog = false) {
    if (!running) return;
    if (backlog || clock.hidden()) timer = clock.timeout(pump, backlog ? 0 : 250);
    else frame = clock.requestFrame(pump);
  }
  function pump() {
    frame = timer = null;
    if (!running) return;
    const now = clock.now(), render = !clock.hidden();
    // Preserve the 60Hz render budget without discarding simulation time.
    if (render && !shouldRender(now)) { schedule(); return; }
    if (!active()) { tick(now, Math.min(.05, Math.max(0, now - previous) / 1000), render); previous = now; }
    else {
      let steps = 0;
      while (previous < now && active() && running && steps++ < 120) {
        const next = Math.min(now, previous + 50);
        tick(next, (next - previous) / 1000, render && next === now);
        previous = next;
      }
      // Once a round finishes, discard idle backlog instead of replaying it.
      if (running && !active() && previous < now) { tick(now, 0, render); previous = now; }
    }
    schedule(previous < now);
  }
  return {
    start() { if (running) return; running = true; previous = clock.now(); tick(previous, 0, !clock.hidden()); schedule(); },
    visibility() { if (!running) return; cancel(); pump(); },
    dispose() { running = false; cancel(); },
  };
}
