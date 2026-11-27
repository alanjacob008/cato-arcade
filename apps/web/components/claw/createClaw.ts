import * as THREE from "three";
import { curvedJawPoints, curvedJawPose, clawTravelBounds, gripObstacle, jawSegmentHitsBox, pointBoxDistance, JAW_OPEN_ANGLE, JAW_CLOSED_ANGLE, JAW_TRAVEL_ANGLE, JAW_ROOT_RADIUS, JAW_ROOT_Y, JAW_LINK_RADIUS, JAW_TIP_RADIUS, type BoxPose } from "./clawGrip";
import { MACHINE } from "./config";
import type { ClawPose } from "./prizeGrip";

export function createClaw(scene: THREE.Scene, steel: THREE.Material) {
  const claw = new THREE.Group(); claw.name = "Single-hinge curved metal claw"; scene.add(claw);
  const motor = new THREE.Mesh(new THREE.CylinderGeometry(.11, .13, .16, 24), steel); motor.castShadow = true; claw.add(motor);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(.12, .016, 8, 24), steel); collar.rotation.x = Math.PI / 2; collar.position.y = .075; claw.add(collar);
  const points = curvedJawPoints();
  // A thick extruded ribbon forms one solid, permanently curved steel blade.
  const sides = points.map((point, i) => {
    const tangent = points[Math.min(i + 1, points.length - 1)].clone().sub(points[Math.max(0, i - 1)]).normalize();
    const normal = new THREE.Vector3(-tangent.y, tangent.x, 0).multiplyScalar(.024);
    return [point.clone().add(normal), point.clone().sub(normal)];
  });
  const outline = [...sides.map(side => side[0]), ...[...sides].reverse().map(side => side[1])];
  const shape = new THREE.Shape(outline.map(point => new THREE.Vector2(point.x, point.y)));
  const armGeometry = new THREE.ExtrudeGeometry(shape, { depth: .024, bevelEnabled: true, bevelThickness: .002, bevelSize: .002, bevelSegments: 2, steps: 1 }); armGeometry.translate(0, 0, -.012);
  const hingeGeometry = new THREE.CylinderGeometry(.052, .052, .09, 24);
  const tipGeometry = new THREE.SphereGeometry(JAW_TIP_RADIUS, 20, 12);
  const fingers = Array.from({ length: 3 }, (_, i) => {
    const azimuth = i * Math.PI * 2 / 3;
    const mount = new THREE.Group(); mount.position.set(Math.cos(azimuth) * JAW_ROOT_RADIUS, JAW_ROOT_Y, Math.sin(azimuth) * JAW_ROOT_RADIUS); mount.rotation.y = -azimuth; claw.add(mount);
    const hinge = new THREE.Mesh(hingeGeometry, steel); hinge.name = "Claw shoulder hinge"; hinge.rotation.x = Math.PI / 2; mount.add(hinge);
    const pivot = new THREE.Group(); pivot.name = "Claw finger pivot"; pivot.rotation.z = JAW_TRAVEL_ANGLE; mount.add(pivot);
    const arm = new THREE.Mesh(armGeometry, steel); arm.name = "Single hinge curved steel jaw"; pivot.add(arm);
    const tip = new THREE.Mesh(tipGeometry, steel); tip.name = "Metal claw fingertip"; tip.position.copy(points.at(-1)!); pivot.add(tip);
    for (const part of [arm, hinge, tip]) part.castShadow = part.receiveShadow = true;
    return { azimuth, pivot, angle: JAW_TRAVEL_ANGLE };
  });
  const safePosition = new THREE.Vector3(), safeRotation = new THREE.Quaternion(), transform = new THREE.Matrix4();
  let hasSafePose = false, gripping = false, lastValid = false;
  let lastInput: number[] = [], lastIds: (string | undefined)[] = [];
  const movementBounds = clawTravelBounds(points, new THREE.Quaternion(), MACHINE);
  const travelBounds = clawTravelBounds(points, new THREE.Quaternion(), MACHINE, [JAW_TRAVEL_ANGLE, JAW_TRAVEL_ANGLE, JAW_TRAVEL_ANGLE]);
  function projectGlass(position: THREE.Vector3, rotation: THREE.Quaternion, angles?: readonly number[]) {
    const bounds = clawTravelBounds(points, rotation, MACHINE, angles);
    position.set(THREE.MathUtils.clamp(position.x, bounds.minX, bounds.maxX), THREE.MathUtils.clamp(position.y, bounds.minY, bounds.maxY), THREE.MathUtils.clamp(position.z, bounds.minZ, bounds.maxZ));
  }
  function insideGlass(point: THREE.Vector3, radius: number) {
    return Math.abs(point.x) <= MACHINE.width / 2 - radius && Math.abs(point.z) <= MACHINE.depth / 2 - radius && point.y >= MACHINE.floorY + radius && point.y <= MACHINE.height - radius;
  }
  return {
    claw,
    movementBounds,
    travelBounds,
    get gripping() { return gripping; },
    activeMovementBounds(rotation = claw.quaternion) { return clawTravelBounds(points, rotation, MACHINE, fingers.map(finger => finger.angle)); },
    snapshotPose(): ClawPose { return { position: claw.position.clone(), rotation: claw.quaternion.clone(), angles: fingers.map(finger => finger.angle) }; },
    presentGripPose(pose: ClawPose) {
      claw.position.copy(pose.position); claw.quaternion.copy(pose.rotation);
      fingers.forEach((finger, i) => { finger.angle = pose.angles[i]; finger.pivot.rotation.z = pose.angles[i]; });
      projectGlass(claw.position, claw.quaternion, pose.angles); claw.updateMatrixWorld(true);
      safePosition.copy(claw.position); safeRotation.copy(claw.quaternion); hasSafePose = true; lastInput = []; lastIds = [];
    },
    update(closed: number, box: BoxPose | null, obstacles: readonly BoxPose[] = [], held = false, travel = false) {
      const input = [closed, held ? 1 : 0, travel ? 1 : 0, ...claw.position.toArray(), ...claw.quaternion.toArray(), box ? 1 : 0, obstacles.length], ids = [box?.id, ...obstacles.map(other => other.id)];
      for (const pose of box ? [box, ...obstacles] : obstacles) input.push(pose.center.x, pose.center.y, pose.center.z, pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w, pose.size);
      if (input.length === lastInput.length && input.every((value, i) => value === lastInput[i]) && ids.every((id, i) => id === lastIds[i])) {
        if (hasSafePose) { claw.position.copy(safePosition); claw.quaternion.copy(safeRotation); claw.updateMatrixWorld(true); }
        return lastValid;
      }
      lastInput = input; lastIds = ids;
      // Glass projects each axis independently. It cannot freeze tangential movement or rotation.
      const activeAngles = travel ? fingers.map(finger => Math.max(finger.angle, JAW_TRAVEL_ANGLE)) : held && closed > .99 ? fingers.map(finger => finger.angle) : undefined;
      projectGlass(claw.position, claw.quaternion, activeAngles);
      const sweepMin = claw.position.clone().min(hasSafePose ? safePosition : claw.position);
      const sweepMax = claw.position.clone().max(hasSafePose ? safePosition : claw.position);
      const colliders = obstacles.filter(other => {
        if (box?.id && other.id === box.id) return false;
        const radius = .85 + other.size * Math.sqrt(3) / 2;
        return other.center.x >= sweepMin.x - radius && other.center.x <= sweepMax.x + radius
          && other.center.y >= sweepMin.y - radius && other.center.y <= sweepMax.y + radius
          && other.center.z >= sweepMin.z - radius && other.center.z <= sweepMax.z + radius;
      }).map(gripObstacle);
      // A held box moves with the frozen fingers, so movement checks exclude that box.
      if (box && !held) colliders.push(gripObstacle(box));
      function safeFinger(azimuth: number, angle: number, matrix: THREE.Matrix4, includeHeld = false) {
        const path = curvedJawPose(points, azimuth, angle).map(point => point.applyMatrix4(matrix));
        const all = includeHeld && held && box ? [...colliders, gripObstacle({ ...box,
          center: new THREE.Vector3(box.center.x, box.center.y, box.center.z).applyMatrix4(matrix),
          rotation: new THREE.Quaternion().setFromRotationMatrix(matrix).multiply(new THREE.Quaternion(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w)) })] : colliders;
        for (let i = 0; i < path.length; i++) {
          const radius = i === 0 ? .052 : i === path.length - 1 ? JAW_TIP_RADIUS : JAW_LINK_RADIUS;
          if (!insideGlass(path[i], radius) || all.some(other => jawSegmentHitsBox(path[i], path[i], radius, other))) return false;
          if (i && all.some(other => jawSegmentHitsBox(path[i - 1], path[i], JAW_LINK_RADIUS, other))) return false;
        }
        return true;
      }
      function safeAt(position: THREE.Vector3, rotation: THREE.Quaternion) {
        projectGlass(position, rotation, activeAngles);
        transform.compose(position, rotation, new THREE.Vector3(1, 1, 1));
        return fingers.every(finger => safeFinger(finger.azimuth, finger.angle, transform));
      }
      let reached = true;
      if (hasSafePose) {
        const desiredPosition = claw.position.clone(), desiredRotation = claw.quaternion.clone();
        const steps = Math.max(1, Math.ceil(safePosition.distanceTo(desiredPosition) / .035), Math.ceil(safeRotation.angleTo(desiredRotation) / .035));
        let fraction = 0;
        for (let step = 1; step <= steps; step++) {
          const next = step / steps;
          const position = safePosition.clone().lerp(desiredPosition, next), rotation = safeRotation.clone().slerp(desiredRotation, next);
          if (!safeAt(position, rotation)) {
            let lo = fraction, hi = next;
            for (let i = 0; i < 12; i++) {
              const mid = (lo + hi) / 2;
              if (safeAt(safePosition.clone().lerp(desiredPosition, mid), safeRotation.clone().slerp(desiredRotation, mid))) lo = mid; else hi = mid;
            }
            fraction = lo; reached = false; break;
          }
          fraction = next;
        }
        claw.position.copy(safePosition).lerp(desiredPosition, fraction); claw.quaternion.copy(safeRotation).slerp(desiredRotation, fraction);
      } else if (!safeAt(claw.position, claw.quaternion)) { gripping = false; lastValid = false; return false; }
      projectGlass(claw.position, claw.quaternion, activeAngles);
      claw.updateMatrixWorld(true);
      // Collision boxes use machine-local coordinates, even at a translated station.
      const matrix = claw.matrix.clone();
      for (const finger of fingers) {
        // One scalar rotation. Stop at the first obstruction, without bending or switching poses.
        const desired = travel ? JAW_TRAVEL_ANGLE : held && closed > .99 ? finger.angle : THREE.MathUtils.lerp(JAW_OPEN_ANGLE, JAW_CLOSED_ANGLE, THREE.MathUtils.clamp(closed, 0, 1));
        const start = finger.angle, steps = Math.max(1, Math.ceil(Math.abs(desired - start) / .012));
        let previous = start;
        for (let step = 1; step <= steps; step++) {
          const next = THREE.MathUtils.lerp(start, desired, step / steps);
          if (!safeFinger(finger.azimuth, next, matrix, true)) {
            let lo = 0, hi = 1;
            for (let i = 0; i < 12; i++) {
              const mid = (lo + hi) / 2;
              if (safeFinger(finger.azimuth, THREE.MathUtils.lerp(previous, next, mid), matrix, true)) lo = mid; else hi = mid;
            }
            previous = THREE.MathUtils.lerp(previous, next, lo); break;
          }
          previous = next;
        }
        finger.angle = previous; finger.pivot.rotation.z = previous;
      }
      const target = box ? gripObstacle(held ? { ...box,
        center: new THREE.Vector3(box.center.x, box.center.y, box.center.z).applyMatrix4(matrix),
        rotation: claw.quaternion.clone().multiply(new THREE.Quaternion(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w)) } : box) : null;
      gripping = !!target && closed > .99 && fingers.every(finger => {
        const tip = curvedJawPose(points, finger.azimuth, finger.angle).at(-1)!.applyMatrix4(matrix);
        const local = tip.clone().sub(target.center).applyQuaternion(target.inverseRotation);
        const normal = local.clone().sub(local.clone().clampScalar(-target.half, target.half)).normalize().applyQuaternion(target.inverseRotation.clone().invert());
        const outward = new THREE.Vector3(Math.cos(finger.azimuth), 0, Math.sin(finger.azimuth)).applyQuaternion(claw.quaternion);
        return pointBoxDistance(tip, target) <= JAW_TIP_RADIUS + .006 && normal.dot(outward) > .25;
      });
      hasSafePose = true; safePosition.copy(claw.position); safeRotation.copy(claw.quaternion); claw.updateMatrixWorld(true); lastValid = reached;
      return reached;
    },
  };
}
