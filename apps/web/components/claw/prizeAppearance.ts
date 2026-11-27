import * as THREE from "three";
import { surfaceTexture } from "./materialTextures";
import { prizeFaceTexture } from "./prizeModel";

export function createPrizeAppearance() {
  const materials = new Map<string, THREE.MeshPhysicalMaterial>();
  const packs = new Map<string, THREE.Material[]>();
  const paper = surfaceTexture("paper");
  function material(color: string) {
    if (!materials.has(color)) {
      const purple = color === "#7950b4";
      materials.set(color, new THREE.MeshPhysicalMaterial({ color,
        emissive: purple ? "#9945ff" : color === "#ee9951" ? "#ffc083" : "#bb83ff", emissiveIntensity: purple ? .04 : 0,
        bumpMap: paper, bumpScale: .0008, roughness: purple ? .23 : .46, metalness: purple ? .10 : .015,
        clearcoat: purple ? .9 : .25, specularIntensity: .5, clearcoatRoughness: purple ? .12 : .25 }));
    }
    return materials.get(color)!;
  }
  function packMaterials(color: string) {
    if (!packs.has(color)) {
      const purple = color === "#7950b4", gold = color === "#ee9951";
      const face = new THREE.MeshPhysicalMaterial({ color: "#ffffff", map: prizeFaceTexture(color), roughness: purple ? .25 : .35, metalness: .04, clearcoat: .8, clearcoatRoughness: .12 });
      const foil = new THREE.MeshStandardMaterial({ color: purple ? "#c3a0ff" : gold ? "#e4bd68" : "#bcb2cf", metalness: .85, roughness: .24, bumpMap: paper, bumpScale: .0002 });
      packs.set(color, [material(color), face, foil]);
    }
    return packs.get(color)!;
  }
  return { material, packMaterials, update: (power: number) => {
    materials.forEach((material, color) => { material.emissiveIntensity = color === "#7950b4" ? .04 + power * .06 : 0; });
  } };
}
