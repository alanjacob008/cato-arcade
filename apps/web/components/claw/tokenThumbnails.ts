import * as THREE from "three";
import { createTokenModel } from "./createTokenModel";
import { loadPrizeLogo, prizeLogoTexture } from "./prizeModel";
import { studioEnvironment } from "./studioLighting";

/**
 * Source of the token pictures in public/claw/tokens/ (silver, gold, diamond .webp, 160x144). Nothing imports
 * this at runtime: the tray and the shop show those static files (TokenPreview), so the arcade never opens a
 * second WebGL context or links shaders while it loads or flies in.
 *
 * To regenerate after a token's model or colour changes: bundle this module for the browser (esbuild), load it in
 * a page on the site's origin (the box-face logo is fetched from /claw/...), call renderTokenThumbnails(), save
 * each data URL as PNG, convert it to lossless WebP (sharp: `.webp({ lossless: true })`) and check the decoded
 * pixels match the PNG.
 */
export const TOKEN_THUMBNAIL_FILL = "#d9ccff";

export async function renderTokenThumbnails(fillColor: THREE.ColorRepresentation = TOKEN_THUMBNAIL_FILL): Promise<readonly string[]> {
  await loadPrizeLogo();
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
  const scene = new THREE.Scene();
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  let disposeEnvironment: (() => void) | undefined;
  try {
    renderer.setPixelRatio(1); renderer.setSize(160, 144);
    renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
    disposeEnvironment = studioEnvironment(renderer, scene); scene.environmentIntensity = 1;
    const camera = new THREE.OrthographicCamera(-.5 * 160 / 144, .5 * 160 / 144, .5, -.5, .1, 8); camera.position.set(0, 0, 3);
    scene.add(new THREE.HemisphereLight("#ffffff", "#46516b", .6));
    const key = new THREE.DirectionalLight("#ffffff", 1.5); key.position.set(-1, 2, 3); scene.add(key);
    const fill = new THREE.DirectionalLight(fillColor, .6); fill.position.set(2, -1, 3); scene.add(fill);
    const artwork = prizeLogoTexture(); textures.add(artwork);
    const images: string[] = [];
    for (const tier of [0, 1, 2]) {
      const model = createTokenModel(tier, artwork); model.rotation.set(-.22, -.38, -.12); scene.add(model);
      model.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        geometries.add(object.geometry);
        (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => {
          materials.add(material); Object.values(material).forEach(value => { if (value instanceof THREE.Texture) textures.add(value); });
        });
      });
      renderer.render(scene, camera); images.push(renderer.domElement.toDataURL("image/png")); scene.remove(model);
    }
    return Object.freeze(images);
  } finally {
    geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose()); textures.forEach(texture => texture.dispose());
    disposeEnvironment?.(); renderer.dispose(); renderer.forceContextLoss();
  }
}
