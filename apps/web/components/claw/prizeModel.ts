import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { MACHINE } from "./config";

export const CATO_OBJECT_LOGO = "/claw/cato-mascot-transparent.png";
let brandLogo: HTMLImageElement | null = null, pendingLogo: Promise<void> | null = null;
export function loadPrizeLogo(): Promise<void> {
  if (!pendingLogo) pendingLogo = new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => { brandLogo = image; resolve(); };
    image.onerror = () => reject(new Error("CATO box-face logo could not load"));
    image.src = CATO_OBJECT_LOGO;
  });
  return pendingLogo;
}

/** Each scene owns its GPU texture; the decoded source image is shared. */
export function prizeLogoTexture(): THREE.Texture {
  if (!brandLogo) throw new Error("Load the supplied CATO logo before building coin faces");
  const texture = new THREE.Texture(brandLogo); texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4; texture.needsUpdate = true; return texture;
}

/** Shared collector-pack geometry: separate fitted lid, six inset faces and metal frames. */
export function createPrizeGeometry(): THREE.BufferGeometry {
  const size = MACHINE.boxSize, parts: THREE.BufferGeometry[] = [];
  const body = new RoundedBoxGeometry(size - .014, .376, size - .014, 2, .008).translate(0, -.047, 0);
  const lid = new RoundedBoxGeometry(size - .012, .094, size - .012, 2, .008).translate(0, .19, 0);
  const shell = mergeGeometries([body, lid], false)!; body.dispose(); lid.dispose(); parts.push(shell);
  const panels: THREE.BufferGeometry[] = [], trims: THREE.BufferGeometry[] = [];
  const faceTransforms = [
    new THREE.Matrix4(), new THREE.Matrix4().makeRotationY(Math.PI),
    new THREE.Matrix4().makeRotationY(Math.PI / 2), new THREE.Matrix4().makeRotationY(-Math.PI / 2),
    new THREE.Matrix4().makeRotationX(-Math.PI / 2), new THREE.Matrix4().makeRotationX(Math.PI / 2),
  ];
  for (const transform of faceTransforms) {
    panels.push(new THREE.PlaneGeometry(.372, .372).toNonIndexed().translate(0, 0, size / 2 - .0025).applyMatrix4(transform));
    // Raised foil frames sit within the physical .48 cube envelope.
    for (const width of [.424, .387]) {
      const line = width === .424 ? .014 : .004;
      for (const side of [-1, 1]) {
        trims.push(new THREE.BoxGeometry(width, line, .002).toNonIndexed().translate(0, side * (width - line) / 2, size / 2 - .001).applyMatrix4(transform));
        trims.push(new THREE.BoxGeometry(line, width - line * 2, .002).toNonIndexed().translate(side * (width - line) / 2, 0, size / 2 - .001).applyMatrix4(transform));
      }
    }
  }
  parts.push(mergeGeometries(panels, false)!, mergeGeometries(trims, false)!);
  const geometry = mergeGeometries(parts, true)!;
  [...panels, ...trims, ...parts].forEach(part => part.dispose());
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

/** Original CATO face artwork, not Beezie's hexagon or branding. */
export function prizeFaceTexture(color: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 512;
  const ctx = canvas.getContext("2d")!, purple = color === "#7950b4", gold = color === "#ee9951";
  const fill = ctx.createLinearGradient(0, 0, 512, 512);
  if (purple) { fill.addColorStop(0, "#b181e9"); fill.addColorStop(.6, "#7341b1"); fill.addColorStop(1, "#a474db"); }
  else { fill.addColorStop(0, gold ? "#e9b756" : "#f7f4ee"); fill.addColorStop(.6, gold ? "#be7e23" : "#dfdce8"); fill.addColorStop(1, gold ? "#f0c872" : "#f3eef7"); }
  ctx.fillStyle = fill; ctx.fillRect(0, 0, 512, 512);
  const ink = purple ? "#e9d8ff" : gold ? "#fff4d1" : "#502d71";
  ctx.strokeStyle = ink; ctx.lineWidth = 3; ctx.strokeRect(17, 17, 478, 478);
  ctx.globalAlpha = .25; ctx.lineWidth = 1; ctx.strokeRect(25, 25, 462, 462); ctx.globalAlpha = 1;
  if (!brandLogo) throw new Error("Load the supplied CATO cat logo before building package textures");
  ctx.drawImage(brandLogo, 80, 70, 352, 352);
  ctx.fillStyle = ink;
  // Fine print bars and corner registration marks make this read as manufactured packaging.
  ctx.globalAlpha = .42;
  for (let i = 0; i < 9; i++) ctx.fillRect(183 + i * 17, 425, i % 3 === 0 ? 8 : 4, 13);
  ctx.fillRect(196, 449, 120, 3); ctx.globalAlpha = 1;
  for (const x of [44, 458]) for (const y of [44, 458]) { ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4; return texture;
}
