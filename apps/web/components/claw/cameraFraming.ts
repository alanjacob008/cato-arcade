import * as THREE from "three";
import { MACHINE } from "./config";

export function screenDragWorldDelta(camera: THREE.Camera, screenX: number, screenY: number) {
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  const right = new THREE.Vector3(e[0], 0, e[2]).normalize();
  const towardViewer = new THREE.Vector3(e[8], 0, e[10]);
  if (towardViewer.lengthSq() < 1e-12) towardViewer.set(-right.z, 0, right.x); else towardViewer.normalize();
  return right.multiplyScalar(screenX * MACHINE.width * 1.25).addScaledVector(towardViewer, screenY * MACHINE.depth * 1.25);
}

// Include the canopy, feet and control deck; the decorative shadow may extend beyond this box.
export const CABINET_BOUNDS = new THREE.Box3(
  new THREE.Vector3(-MACHINE.width / 2 - .3, -1.6, -MACHINE.depth / 2 - .2),
  new THREE.Vector3(MACHINE.width / 2 + .3, MACHINE.height + .80, MACHINE.depth / 2 + .7),
);

/** Actual component envelopes avoid framing empty corners above the projecting control deck. */
export function cabinetFramePoints() {
  const w = MACHINE.width / 2, d = MACHINE.depth / 2, h = MACHINE.height;
  const parts = [
    new THREE.Box3(new THREE.Vector3(-w - .20, -1.6, -d - .20), new THREE.Vector3(w + .20, h + .10, d + .20)),
    new THREE.Box3(new THREE.Vector3(-w - .20, h + .05, d - .17), new THREE.Vector3(w + .20, h + .80, d + .32)),
    new THREE.Box3(new THREE.Vector3(-w - .20, -.30, d - .05), new THREE.Vector3(w + .20, .45, d + .70)),
  ];
  return parts.flatMap(bounds => [bounds.min.x, bounds.max.x].flatMap(x => [bounds.min.y, bounds.max.y].flatMap(y => [bounds.min.z, bounds.max.z].map(z => new THREE.Vector3(x, y, z)))));
}

/** Height at depth `z`, on the camera's centre line, where the frame's top edge falls (e.g. on the sign wall). */
export function frameTopAtDepth(camera: THREE.Camera, z: number) {
  camera.updateMatrixWorld();
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const edge = new THREE.Vector3(0, 1, .5).unproject(camera).sub(origin).normalize();
  return origin.y + edge.y * (z - origin.z) / edge.z;
}

export function frameCabinet(camera: THREE.OrthographicCamera | THREE.PerspectiveCamera, aspect: number, topView: boolean) {
  if (!Number.isFinite(aspect) || aspect <= 0) return;
  const bounds = CABINET_BOUNDS;
  const framePoints = cabinetFramePoints();
  if (camera instanceof THREE.PerspectiveCamera) {
    const center = bounds.getCenter(new THREE.Vector3());
    // Centered front product shot; a slight elevation retains depth through the glass.
    const direction = topView ? new THREE.Vector3(0, 1, .0001) : new THREE.Vector3(0, .12, 1).normalize();
    camera.position.copy(center).add(direction); camera.lookAt(center); camera.updateMatrixWorld();
    const inverse = camera.quaternion.clone().invert(), tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    let distance = 1;
    for (const corner of framePoints) {
      const point = corner.clone().sub(center).applyQuaternion(inverse);
      distance = Math.max(distance, Math.abs(point.x) / (tanV * aspect) + point.z, Math.abs(point.y) / tanV + point.z);
    }
    camera.aspect = aspect; camera.position.copy(center).addScaledVector(direction, distance * (topView ? 1.06 : 1.12));
    camera.lookAt(center); camera.updateProjectionMatrix(); camera.updateMatrixWorld(); return;
  }
  camera.position.set(0, topView ? 10 : 2.3, topView ? .001 : 10);
  camera.lookAt(0, topView ? 0 : 1.1, 0);
  camera.updateMatrixWorld();
  const projected = new THREE.Box3();
  for (const point of framePoints) projected.expandByPoint(point.applyMatrix4(camera.matrixWorldInverse));
  const center = projected.getCenter(new THREE.Vector3()), size = projected.getSize(new THREE.Vector3());
  const halfHeight = Math.max(size.y / 2, size.x / (2 * aspect)) * (topView ? 1.06 : 1.12);
  camera.left = center.x - halfHeight * aspect; camera.right = center.x + halfHeight * aspect;
  camera.bottom = center.y - halfHeight; camera.top = center.y + halfHeight;
  camera.updateProjectionMatrix();
}
