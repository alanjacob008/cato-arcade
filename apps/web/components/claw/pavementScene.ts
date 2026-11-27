import * as THREE from "three";
import { Reflector } from "three/addons/objects/Reflector.js";
import type { LoadingTask } from "./loadingProgress";
import { createReflectionBudget } from "./reflectionBudget";

export const PAVEMENT_Y = -1.605;

/** Retain existing loading milestones; the generated floor needs no image fetches. */
export function loadPavementTexture(onLoaded?: (task: LoadingTask) => void): Promise<void> {
  for (const task of ["diffuse", "normal", "arm"] as const) onLoaded?.(task);
  return Promise.resolve();
}

/** Polished black stone that catches the warm station light and the machines' reflections. */
export function createPavement(scene: THREE.Scene, stations: readonly number[] = [-6.5, 0, 6.5]) {
  const material = new THREE.MeshPhysicalMaterial({ color: "#000000", roughness: .095, metalness: .05,
    ior: 1.5, clearcoat: 1, clearcoatRoughness: .045, envMapIntensity: .025 });
  const geometry = new THREE.PlaneGeometry(400, 400), poolColor = new THREE.Color("#ff9a3c");
  const reflection = new Reflector(geometry, { textureWidth: 384, textureHeight: 384, multisample: 0, clipBias: .003 });
  // A compact LDR target also works on mobile devices without float render targets.
  reflection.getRenderTarget().texture.type = THREE.UnsignedByteType;
  const reflectionMaterial = reflection.material as THREE.ShaderMaterial;
  const reflectionUniforms = reflectionMaterial.uniforms, reflectionReady = { value: 0 }, budget = createReflectionBudget();
  let reflectionFailed = false;
  material.name = "Polished black floor with warm station pools";
  const pools = stations.map(x => `catoFloorPool(catoFloorPosition, ${x.toFixed(3)})`).join(" + ");
  material.onBeforeCompile = shader => {
    shader.uniforms.catoPoolColor = { value: poolColor };
    shader.uniforms.catoReflection = reflectionUniforms.tDiffuse;
    shader.uniforms.catoReflectionMatrix = reflectionUniforms.textureMatrix;
    shader.uniforms.catoReflectionReady = reflectionReady;
    shader.vertexShader = "uniform mat4 catoReflectionMatrix;\nvarying vec4 catoReflectionUv;\nvarying vec2 catoFloorPosition;\n" + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\ncatoFloorPosition = (modelMatrix * vec4(transformed, 1.0)).xz;\ncatoReflectionUv = catoReflectionMatrix * vec4(position, 1.0);");
    shader.fragmentShader = `uniform vec3 catoPoolColor;\nuniform sampler2D catoReflection;\nuniform float catoReflectionReady;\nvarying vec4 catoReflectionUv;\nvarying vec2 catoFloorPosition;
float catoFloorPool(vec2 p, float x) { vec2 d = (p - vec2(x, .9)) / vec2(3.4, 2.6); return exp(-dot(d, d)); }
` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
      // Warm light from each station's downlight pooling on the stone.
      float catoPool = ${pools};
      totalEmissiveRadiance += catoPoolColor * catoPool * .030;
    `);
    shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", `
      vec2 reflectionUv = catoReflectionUv.xy / max(catoReflectionUv.w, .0001);
      vec2 blurStep = vec2(.0014);
      vec3 reflectionColor = texture2D(catoReflection, reflectionUv).rgb * .40
        + texture2D(catoReflection, reflectionUv + vec2(blurStep.x, 0.0)).rgb * .15
        + texture2D(catoReflection, reflectionUv - vec2(blurStep.x, 0.0)).rgb * .15
        + texture2D(catoReflection, reflectionUv + vec2(0.0, blurStep.y)).rgb * .15
        + texture2D(catoReflection, reflectionUv - vec2(0.0, blurStep.y)).rgb * .15;
      outgoingLight = max(vec3(0.0), outgoingLight - totalEmissiveRadiance) * .04 + totalEmissiveRadiance;
      // Under each machine the stone is a touch glossier and its reflection carries the warm downlight.
      float catoNear = clamp(catoPool, 0.0, 1.0);
      float glassFresnel = (.055 + .19 * pow(1.0 - clamp(dot(normal, geometryViewDir), 0.0, 1.0), 3.0)) * (1.0 + .45 * catoNear);
      outgoingLight = mix(outgoingLight, reflectionColor * mix(vec3(1.0), vec3(1.0, .88, .72), catoNear * .7), glassFresnel * catoReflectionReady);
      #include <opaque_fragment>
    `);
  };
  material.customProgramCacheKey = () => `cato-warm-stone-reflection-v4-${stations.join(",")}`;
  const floor = new THREE.Mesh(geometry, material);
  floor.name = "Polished black arcade floor";
  floor.rotation.x = -Math.PI / 2; floor.position.y = PAVEMENT_Y; floor.receiveShadow = true; scene.add(floor);
  // A small contact patch grounds each cabinet over its soft planar reflection.
  const contactGeometry = new THREE.PlaneGeometry(4.8, 4.6), contactMaterial = new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
    vertexShader: "varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
    fragmentShader: "varying vec2 vUv; void main(){ vec2 d=max(abs(vUv-.5)-vec2(.28,.27),0.); float a=(1.-smoothstep(0.,.17,length(d)))*.20; gl_FragColor=vec4(0.,0.,0.,a); }" });
  for (const x of stations) {
    const contact = new THREE.Mesh(contactGeometry, contactMaterial);
    contact.rotation.x = -Math.PI / 2; contact.position.set(x, PAVEMENT_Y + .002, 0); scene.add(contact);
  }
  return Object.assign(floor, {
    poolColor,
    /** The floor reflection's render target. The start-up warm-up compiles with it bound, so the programs the reflection
     * pass needs (three builds separate ones for any bound render target: no tone mapping, linear output) are ready
     * before the first frame instead of linking synchronously inside it. */
    reflectionTarget: reflection.getRenderTarget(),
    invalidateReflection() { budget.invalidate(); },
    captureReflection(renderer: THREE.WebGLRenderer, camera: THREE.Camera, now: number, moving: boolean, enabled = true) {
      if (!enabled || reflectionFailed) { reflectionReady.value = 0; return; }
      if (!budget.capture(now, moving)) return;
      floor.updateWorldMatrix(true, false); reflection.matrixWorld.copy(floor.matrixWorld);
      const visible = floor.visible, target = renderer.getRenderTarget(), xr = renderer.xr.enabled, shadows = renderer.shadowMap.autoUpdate;
      floor.visible = false;
      try {
        reflection.onBeforeRender(renderer, scene, camera, geometry, reflectionMaterial, null!);
        reflectionReady.value = 1;
      } catch { reflectionFailed = true; reflectionReady.value = 0; }
      finally { floor.visible = visible; renderer.xr.enabled = xr; renderer.shadowMap.autoUpdate = shadows; renderer.setRenderTarget(target); }
    },
    disposeReflection() { reflection.dispose(); },
  });
}
