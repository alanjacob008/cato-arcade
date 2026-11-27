import * as THREE from "three";
import type { PrizeBox } from "./rewards";

/** Same geometry/materials and individual poses, submitted as three instanced tiers. */
export function createPrizeBatch(scene: THREE.Scene, geometry: THREE.BufferGeometry, initial: readonly PrizeBox[], restored: readonly PrizeBox[], materials: (color: string) => THREE.Material[]) {
  const proxies = new THREE.Group(); proxies.name = "Prize pose references"; proxies.visible = false; scene.add(proxies);
  const cubes = new Map<string, THREE.Mesh>();
  const groups = new Map<string, { mesh: THREE.InstancedMesh; cubes: THREE.Mesh[]; signatures: number[][] }>();
  const restoredById = new Map(restored.map(box => [box.id, box]));
  for (const prize of initial) {
    const cube = new THREE.Mesh(geometry, materials(prize.color)), pose = restoredById.get(prize.id) ?? prize;
    cube.name = prize.id; cube.position.set(pose.center.x, pose.center.y, pose.center.z); cube.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w);
    cube.visible = restoredById.has(prize.id); cube.castShadow = cube.receiveShadow = true; proxies.add(cube); cubes.set(prize.id, cube);
    if (!groups.has(prize.color)) {
      const capacity = initial.filter(box => box.color === prize.color).length;
      const mesh = new THREE.InstancedMesh(geometry, materials(prize.color), capacity);
      mesh.name = `Instanced CATO prizes ${prize.color}`; mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(mesh); groups.set(prize.color, { mesh, cubes: [], signatures: [] });
    }
    groups.get(prize.color)!.cubes.push(cube);
  }
  function sync() {
    let changed = false;
    for (const group of groups.values()) {
      let count = 0, dirty = false;
      for (const cube of group.cubes) {
        if (!cube.visible || cube.parent !== proxies) continue;
        cube.updateMatrix();
        const values = cube.matrix.elements, previous = group.signatures[count];
        if (!previous || values.some((value, i) => value !== previous[i])) {
          group.mesh.setMatrixAt(count, cube.matrix); group.signatures[count] = [...values]; dirty = true;
        }
        count++;
      }
      if (group.mesh.count !== count) { group.mesh.count = count; dirty = true; }
      group.mesh.visible = count > 0;
      if (dirty) { group.mesh.instanceMatrix.needsUpdate = true; changed = true; }
    }
    return changed;
  }
  function canReplace(nextInitial: readonly PrizeBox[], next: readonly PrizeBox[]) {
    if (nextInitial.length !== cubes.size || new Set(nextInitial.map(box => box.id)).size !== cubes.size) return false;
    const counts = new Map<string, number>();
    for (const box of nextInitial) {
      if (!cubes.has(box.id) || !groups.has(box.color)) return false;
      counts.set(box.color, (counts.get(box.color) ?? 0) + 1);
    }
    for (const [color, count] of counts) if (count > groups.get(color)!.mesh.instanceMatrix.count) return false;
    return new Set(next.map(box => box.id)).size === next.length && next.every(box => cubes.has(box.id));
  }
  return { cubes, proxies, meshes: [...groups.values()].map(group => group.mesh), sync, canReplace,
    replace(nextInitial: readonly PrizeBox[], next: readonly PrizeBox[]) {
      if (!canReplace(nextInitial, next)) return false;
      initial = nextInitial;
      const byId = new Map(next.map(box => [box.id, box]));
      groups.forEach(group => { group.cubes = []; group.signatures = []; });
      for (const prize of nextInitial) {
        const cube = cubes.get(prize.id)!, pose = byId.get(prize.id) ?? prize;
        proxies.attach(cube); cube.material = materials(prize.color); cube.visible = byId.has(prize.id); cube.scale.setScalar(1);
        cube.position.set(pose.center.x, pose.center.y, pose.center.z); cube.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w);
        groups.get(prize.color)!.cubes.push(cube);
      }
      sync(); return true;
    },
    reset() {
      for (const prize of initial) { const cube = cubes.get(prize.id)!; proxies.attach(cube); cube.position.set(prize.center.x, prize.center.y, prize.center.z); cube.quaternion.set(prize.rotation.x, prize.rotation.y, prize.rotation.z, prize.rotation.w); cube.scale.setScalar(1); cube.visible = true; }
      sync();
    },
    dispose() { for (const group of groups.values()) { group.mesh.dispose(); scene.remove(group.mesh); } scene.remove(proxies); },
  };
}
