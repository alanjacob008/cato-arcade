// Can this browser show the 3D cat? Pure DOM checks, no three.js (this module is in the main bundle).

let cached: boolean | null = null;

function hasWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const attrs = { failIfMajorPerformanceCaveat: true } as WebGLContextAttributes;
    return Boolean(canvas.getContext('webgl2', attrs) ?? canvas.getContext('webgl', attrs));
  } catch {
    return false;
  }
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** WebGL available and the user has not asked for reduced motion. The WebGL probe is cached. */
export function catSupported(): boolean {
  if (prefersReducedMotion()) return false;
  if (cached === null) cached = hasWebGL();
  return cached;
}

/** Test hook: forget the cached WebGL probe. */
export function resetCatSupport(): void {
  cached = null;
}
