/** Bound screen-sized render buffers while retaining full-resolution material textures. */
export function renderPixelRatio(width: number, height: number, deviceRatio: number) {
  const pixels = Math.max(1, width * height);
  return Math.min(Math.max(1, deviceRatio), width < 700 ? 1.5 : 2, Math.sqrt(2_500_000 / pixels));
}
