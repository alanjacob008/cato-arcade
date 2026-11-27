import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { createCabinet } from "./createCabinet";
import { createClaw } from "./createClaw";
import { createPrizeBatch } from "./prizeBatch";
import { MACHINE } from "./config";
import type { PrizeBox } from "./rewards";
import { STATION_X } from "./arcadeLayout";

export { STATION_X } from "./arcadeLayout";
export const STATION_NAMES = ["Silver", "Gold", "Diamond"] as const;

/** Passive cabinets are real geometry, batched by material; only one rig runs physics. */
export function bakeStation(root: THREE.Scene) {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert(), groups = new Map<THREE.Material, { meshes: THREE.Mesh[]; geometries: THREE.BufferGeometry[] }>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || Array.isArray(object.material) || object instanceof THREE.InstancedMesh) return;
    if (!groups.has(object.material)) groups.set(object.material, { meshes: [], geometries: [] });
    const group = groups.get(object.material)!;
    const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
    group.meshes.push(object); group.geometries.push(geometry.applyMatrix4(inverse.clone().multiply(object.matrixWorld)));
  });
  const originals = new Set<THREE.BufferGeometry>();
  for (const [material, group] of groups) {
    const geometry = mergeGeometries(group.geometries);
    group.geometries.forEach(geometry => geometry.dispose());
    if (!geometry) continue;
    const mesh = new THREE.Mesh(geometry, material); mesh.name = "Batched standby cabinet"; mesh.receiveShadow = true; root.add(mesh);
    group.meshes.forEach(mesh => { mesh.removeFromParent(); originals.add(mesh.geometry); });
  }
  originals.forEach(geometry => geometry.dispose());
  const lights: THREE.Object3D[] = []; root.traverse(object => { if (object instanceof THREE.Light) lights.push(object); });
  lights.forEach(light => light.removeFromParent());
}

export function createArcadeStations(world: THREE.Scene, geometry: THREE.BufferGeometry, initial: readonly PrizeBox[], boxes: readonly PrizeBox[], materials: (color: string) => THREE.Material[], steel: THREE.Material, restY: number) {
  let connected = false;
  const overhead = STATION_X.map(offset => {
    // Soft orange ceiling cans keep white prize faces below clipping.
    const light = new THREE.SpotLight("#ffba70", 5, 13, .40, 1, 2);
    light.name = "Centered overhead machine light";
    light.position.set(offset, MACHINE.height + 8, MACHINE.depth / 2 + 2);
    light.target.position.set(offset, MACHINE.height * .4, 0);
    // Soft cone, no added shadow-map render or visible wall glare sprite.
    world.add(light, light.target); return light;
  });
  const stations = STATION_X.map((offset, tier) => {
    const root = new THREE.Scene(); root.name = `${STATION_NAMES[tier]} token machine`; root.position.x = offset; world.add(root);
    const cabinet = createCabinet(root, tier);
    cabinet.setStationOffset(offset);
    const displayRestY = MACHINE.height - .25;
    const claw = createClaw(root, steel); claw.claw.position.set(0, displayRestY, 0); claw.update(0, null, [], false, true);
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(.016, .016, MACHINE.height - .14 - displayRestY, 8), steel);
    cable.position.set(0, (MACHINE.height - .14 + displayRestY) / 2, 0); root.add(cable);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(MACHINE.width - .12, .045, .045), steel); rail.position.y = MACHINE.height - .07; root.add(rail);
    bakeStation(root);
    const prizes = createPrizeBatch(root, geometry, initial, boxes, materials); prizes.sync();
    for (const mesh of prizes.meshes) { mesh.computeBoundingSphere(); mesh.frustumCulled = true; }
    return { root, cabinet, prizes };
  });
  return {
    stations,
    select(tier: number) { stations.forEach((station, index) => { station.root.visible = index !== tier; }); },
    canReplace(nextInitial: readonly PrizeBox[], next: readonly PrizeBox[]) { return stations.every(station => station.prizes.canReplace(nextInitial, next)); },
    replace(nextInitial: readonly PrizeBox[], next: readonly PrizeBox[]) {
      stations.forEach(station => { station.prizes.replace(nextInitial, next); station.prizes.meshes.forEach(mesh => mesh.computeBoundingSphere()); });
    },
    setConnected(value: boolean) { connected = value; stations.forEach(station => station.cabinet.setConnected(value)); },
    update(now: number, dt: number, reducedMotion: boolean) {
      stations.forEach(station => station.cabinet.updateLighting(now, dt, reducedMotion));
      overhead.forEach(light => { light.intensity = THREE.MathUtils.damp(light.intensity, connected ? 22 : 5, 6, dt); });
    },
    sync(boxes: readonly PrizeBox[]) {
      const byId = new Map(boxes.map(box => [box.id, box]));
      stations.forEach(station => {
        station.prizes.cubes.forEach((cube, id) => { const box = byId.get(id); cube.visible = !!box;
          if (box) { cube.position.set(box.center.x, box.center.y, box.center.z); cube.quaternion.set(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w); }
        });
        station.prizes.sync(); station.prizes.meshes.forEach(mesh => mesh.computeBoundingSphere());
      });
    },
    dispose() { stations.forEach(station => station.prizes.dispose()); overhead.forEach(light => { light.removeFromParent(); light.target.removeFromParent(); light.dispose(); }); },
  };
}
