import * as THREE from "three";

/** Longest stretch of synchronous compile work (building shader sources, queueing compiles) between two frames. The GPU
 * process translates each queued shader on its own main thread too, so a small slice also keeps its frames coming. */
const SLICE_MS = 16;
/** A program that never reports completion (a lost context) stops the wait after this long; the first frame then links
 * whatever is left, as it would have without the warm-up. */
const WAIT_LIMIT_MS = 20000;
/** The next frame (or a short timeout, so a hidden tab still finishes), then a fresh task. */
export const yieldFrame = () => new Promise<void>(resolve => {
  let done = false;
  const go = () => { if (!done) { done = true; setTimeout(resolve, 0); } };
  requestAnimationFrame(go); setTimeout(go, 50);
});

/**
 * The parts of `root` that compile() can take one at a time. compile(part, camera, scene) counts the part's own lights
 * on top of the scene's, so a part holds no light: a subtree with one is split into its children.
 */
export function compileParts(root: THREE.Object3D, parts: THREE.Object3D[] = []) {
  let lit = false;
  root.traverse(object => { if ((object as THREE.Light).isLight) lit = true; });
  if (!lit) parts.push(root);
  else for (const child of root.children) compileParts(child, parts);
  return parts;
}

/**
 * Compile every program `scene` needs, for the screen and for each render target in `targets` (null is the screen),
 * through the parallel path (KHR_parallel_shader_compile), and resolve once they have all linked. Three builds
 * separate programs for a bound render target (no tone mapping, linear output; WebGLPrograms.getParameters reads the
 * target while compile() runs), so each target is bound around its compile calls and restored at once. The
 * synchronous part is cut into slices of about SLICE_MS, a frame apart, so the page keeps painting throughout.
 * Like compileAsync, it then polls each program's completion (isReady(): COMPLETION_STATUS_KHR), but every program
 * it compiled, not only each material's latest one.
 */
export async function warmScene(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, targets: readonly (THREE.WebGLRenderTarget | null)[], cancelled: () => boolean = () => false) {
  const parts: THREE.Object3D[] = [];
  for (const child of scene.children) compileParts(child, parts);
  const programs = new Set<{ isReady(): boolean }>();
  for (const target of targets) {
    let slice = performance.now();
    for (const part of parts) {
      if (performance.now() - slice > SLICE_MS) { await yieldFrame(); if (cancelled()) return; slice = performance.now(); }
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      try {
        for (const material of renderer.compile(part, camera, scene)) {
          const program = (renderer.properties.get(material) as { currentProgram?: { isReady?: () => boolean } }).currentProgram;
          if (typeof program?.isReady === "function") programs.add(program as { isReady(): boolean });
        }
      } finally { renderer.setRenderTarget(previous); }
    }
    await yieldFrame(); if (cancelled()) return;
  }
  const giveUp = performance.now() + WAIT_LIMIT_MS;
  while (programs.size > 0 && performance.now() < giveUp) {
    for (const program of programs) if (program.isReady()) programs.delete(program);
    if (programs.size > 0) await new Promise(resolve => setTimeout(resolve, 10));
    if (cancelled()) return;
  }
}
