/** A small planar reflection refreshes at 10 Hz in play and 2 Hz when idle. */
export function createReflectionBudget() {
  let last = -Infinity;
  return {
    capture(now: number, moving: boolean) {
      if (now - last < (moving ? 100 : 500)) return false;
      last = now; return true;
    },
    invalidate() { last = -Infinity; },
  };
}
