type EntranceClock = {
  hidden: () => boolean;
  frame: (callback: () => void) => number;
  cancel: (id: number) => void;
  visibility: (callback: () => void) => () => void;
};
const browserClock = (): EntranceClock => ({
  hidden: () => document.hidden || document.querySelector("dialog[open]") !== null,
  frame: callback => requestAnimationFrame(callback), cancel: id => cancelAnimationFrame(id),
  visibility(callback) {
    document.addEventListener("visibilitychange", callback); document.addEventListener("close", callback, true);
    return () => { document.removeEventListener("visibilitychange", callback); document.removeEventListener("close", callback, true); };
  },
});

/** Reveal a dim paint before powering, never behind a loader, native modal or hidden tab. */
export function revealWalletLights(turnOn: () => void, clock: EntranceClock = browserClock()) {
  let active = true, pending: number | null = null, paints = 0;
  const cancelFrame = () => { if (pending !== null) clock.cancel(pending); pending = null; };
  function schedule() {
    if (!active || clock.hidden() || pending !== null) return;
    pending = clock.frame(() => {
      pending = null;
      if (!active || clock.hidden()) { paints = 0; return; }
      if (++paints < 2) schedule();
      else { active = false; unsubscribe(); turnOn(); }
    });
  }
  const unsubscribe = clock.visibility(() => {
    if (clock.hidden()) { cancelFrame(); paints = 0; } else schedule();
  });
  schedule();
  return () => { active = false; cancelFrame(); unsubscribe(); };
}
