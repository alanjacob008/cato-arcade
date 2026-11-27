import * as THREE from "three";

/** Deterministic surface detail. Never consumes the game's random source. */
export function surfaceTexture(kind: "paper" | "metal" | "floor") {
  const size = 64, bytes = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const noise = ((x * 137 + y * 73 + x * y * 19) % 31) / 31;
    const value = kind === "metal" ? 130 + Math.sin(y * 2.4) * 22 + noise * 14 : kind === "floor" ? 155 + noise * 18 : 140 + noise * 45;
    bytes.set([value, value, value, 255], (y * size + x) * 4);
  }
  const texture = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.repeat.set(kind === "paper" ? 3 : 5, kind === "paper" ? 3 : 5); texture.needsUpdate = true;
  return texture;
}
