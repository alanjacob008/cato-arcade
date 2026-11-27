/** Keep static shadows cached; coalesce moving-shadow refreshes to at most 30 Hz. */
export function createShadowBudget() {
  let previous: readonly number[] = [], dirty = true, lastUpdate = -Infinity;
  return (now: number, pose: readonly number[], pileChanged = false) => {
    dirty ||= pileChanged || pose.length !== previous.length || pose.some((value, i) => Math.abs(value - previous[i]) > .0001);
    if (!dirty || now - lastUpdate < 1000 / 30) return false;
    previous = [...pose]; dirty = false; lastUpdate = now; return true;
  };
}
