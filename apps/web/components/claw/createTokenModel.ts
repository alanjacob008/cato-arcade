import * as THREE from "three";
import { TOKEN_TYPES, tokenTier } from "./tokens";
import { surfaceTexture } from "./materialTextures";

/** Shared real geometry for wallet previews and the cabinet's insertion animation. */
export function createTokenModel(tierValue: number, artwork: THREE.Texture | null = null): THREE.Group {
  const tier = tokenTier(tierValue), group = new THREE.Group();
  group.name = `${TOKEN_TYPES[tier].name} arcade token`;
  const metal = new THREE.MeshStandardMaterial({ color: TOKEN_TYPES[tier].color, metalness: .88, roughness: .25, bumpMap: surfaceTexture("metal"), bumpScale: .0007 });
  const trim = new THREE.MeshStandardMaterial({ color: tier === 0 ? "#f0f5ff" : tier === 1 ? "#fff0ba" : "#effdff", metalness: .72, roughness: .18 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(.35, .35, .075, tier === 2 ? 8 : 48), metal);
  body.rotation.x = Math.PI / 2; group.add(body);
  for (const side of [-1, 1]) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(.305, .018, 8, 48), trim);
    rim.position.z = side * .043; group.add(rim);
    if (artwork) {
      const face = new THREE.Mesh(new THREE.PlaneGeometry(.70, .70), new THREE.MeshPhysicalMaterial({
        color: "#ffffff", map: artwork, transparent: true, alphaTest: .03, depthWrite: false,
        roughness: .32, metalness: 0, clearcoat: .8, emissive: "#ffffff", emissiveMap: artwork, emissiveIntensity: .035,
      }));
      face.name = "CATO mascot coin face"; face.position.z = side * .041;
      if (side < 0) face.rotation.y = Math.PI; group.add(face);
    }
  }
  if (tier === 2) {
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(.055), new THREE.MeshPhysicalMaterial({ color: "#4FE3C1", roughness: .05, metalness: 0, transmission: .5, thickness: .06, ior: 2.4, clearcoat: 1, flatShading: true }));
    gem.scale.z = .4; gem.position.set(0, -.245, .055); gem.rotation.z = Math.PI / 4; group.add(gem);
  } else {
    const ridge = new THREE.BoxGeometry(.017, .046, .07);
    for (let i = 0; i < 32; i++) {
      const angle = i * Math.PI / 16, line = new THREE.Mesh(ridge, trim);
      line.position.set(Math.cos(angle) * .343, Math.sin(angle) * .343, 0); line.rotation.z = angle; group.add(line);
    }
  }
  return group;
}
