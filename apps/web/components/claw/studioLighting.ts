import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

/** Warm cream softboxes, so the steel, glass and enamel reflect the arcade's light instead of a cold white studio. */
export const ENVIRONMENT_TINT = new THREE.Color(1, .62, .32);

/** Tint every light in the studio room (its point light and its emissive softbox panels). */
export function warmEnvironment<T extends THREE.Object3D>(room: T, tint: THREE.Color = ENVIRONMENT_TINT): T {
  room.traverse(object => {
    if (object instanceof THREE.Light) object.color.multiply(tint);
    else if (object instanceof THREE.Mesh && !Array.isArray(object.material) && "emissive" in object.material && object.material.emissive instanceof THREE.Color) object.material.emissive.multiply(tint);
  });
  return room;
}

/** The studio room's PMREM: blur, near and far planes, and size. */
const PMREM = { sigma: .02, near: .1, far: 20, size: 256 } as const;

function applyEnvironment(scene: THREE.Scene, target: THREE.WebGLRenderTarget) {
  scene.environment = target.texture;
  scene.environmentIntensity = .75;
  return () => { scene.environment = null; target.dispose(); };
}

/** Softbox reflections provide a physical environment for glass, metal and clearcoat. */
export function studioEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
  const room = warmEnvironment(new RoomEnvironment()), generator = new THREE.PMREMGenerator(renderer);
  const target = generator.fromScene(room, PMREM.sigma, PMREM.near, PMREM.far, { size: PMREM.size });
  room.dispose(); generator.dispose();
  return applyEnvironment(scene, target);
}

/** The private parts of three's PMREMGenerator (r186) that hold its filter programs. Absent in another version, in
 * which case the environment is simply built the synchronous way. */
type PmremInternals = { _setSize?: (size: number) => void; _allocateTargets?: () => THREE.WebGLRenderTarget; _blurMaterial?: THREE.Material | null; _ggxMaterial?: THREE.Material | null };

/**
 * The same environment as studioEnvironment, but its shader programs (the room, the blur and the GGX filter) link in
 * parallel first (KHR_parallel_shader_compile, via compileAsync), so building it never blocks the main thread on
 * them: on a cold shader cache the GGX filter alone took ~450 ms, frozen, inside fromScene. Resolves to the dispose
 * function; with `cancelled()` true by then, builds nothing and resolves to a no-op.
 */
export async function studioEnvironmentAsync(renderer: THREE.WebGLRenderer, scene: THREE.Scene, cancelled: () => boolean = () => false) {
  const room = warmEnvironment(new RoomEnvironment()), generator = new THREE.PMREMGenerator(renderer);
  // Stand-in for the generator's own backdrop box (a plain back-faced basic material), kept until fromScene has used
  // the program it warms.
  const backdrop = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false }));
  const plane = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  try {
    const internals = generator as unknown as PmremInternals, pending: Promise<unknown>[] = [];
    if (typeof internals._setSize === "function" && typeof internals._allocateTargets === "function") {
      const previous = renderer.getRenderTarget();
      let scratch: THREE.WebGLRenderTarget | null = null;
      try {
        // Allocate the generator's targets and filter materials as fromScene will (same size: it reuses them), and
        // compile with a target bound, where every PMREM pass draws (no tone mapping, linear output).
        internals._setSize(PMREM.size); scratch = internals._allocateTargets();
        renderer.setRenderTarget(scratch);
        const cube = new THREE.PerspectiveCamera(90, 1, PMREM.near, PMREM.far), flat = new THREE.OrthographicCamera();
        pending.push(renderer.compileAsync(room, cube), renderer.compileAsync(backdrop, cube));
        // A program's key includes whether the geometry has positions, so compile on a mesh shaped like the filter's own
        // planes (an empty geometry, as three's own precompile uses, builds a different program).
        for (const material of [internals._blurMaterial, internals._ggxMaterial]) if (material) pending.push(renderer.compileAsync(new THREE.Mesh(plane, material), flat));
      } catch { /* fromScene compiles whatever is missing */ }
      finally { renderer.setRenderTarget(previous); }
      await Promise.all(pending);
      scratch?.dispose();
    }
    if (cancelled()) return () => {};
    return applyEnvironment(scene, generator.fromScene(room, PMREM.sigma, PMREM.near, PMREM.far, { size: PMREM.size }));
  } finally {
    room.dispose(); generator.dispose(); backdrop.geometry.dispose(); backdrop.material.dispose(); plane.dispose();
  }
}
