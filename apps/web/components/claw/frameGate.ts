/** Schedule at 60 Hz on high-refresh displays without slowing lower-FPS devices. */
export function createFrameGate() {
  let deadline = -Infinity;
  return (now: number) => {
    if (now + .25 < deadline) return false;
    deadline = Number.isFinite(deadline) ? Math.max(now, deadline + 1000 / 60) : now + 1000 / 60;
    return true;
  };
}
