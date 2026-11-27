import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as THREE from "three";
const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const config = dataUrl(compile(await readFile(new URL("../components/claw/config.ts", import.meta.url), "utf8")));
const source = compile(await readFile(new URL("../components/claw/cameraFraming.ts", import.meta.url), "utf8")).replace('"./config"', JSON.stringify(config)).replace('"three"', JSON.stringify(import.meta.resolve("three")));
const { cabinetFramePoints, frameCabinet, screenDragWorldDelta } = await import(dataUrl(source));
const { STATION_X } = await import(dataUrl(compile(await readFile(new URL("../components/claw/arcadeLayout.ts", import.meta.url), "utf8"))));
const restoredView = new THREE.OrthographicCamera(-4, 4, 3, -3, .1, 120);
frameCabinet(restoredView, 1.4, false);
assert.deepEqual(restoredView.position.toArray(), [0, 2.3, 10], "Default camera is centered in front of the machine");
for (const [width, height] of [[288, 146], [350, 300], [744, 400], [480, 250], [800, 580], [1300, 936]]) {
  for (const topView of [false, true]) {
    for (const camera of [new THREE.OrthographicCamera(-4, 4, 3, -3, .1, 40), new THREE.PerspectiveCamera(34, 1, .1, 120)]) {
    frameCabinet(camera, width / height, topView);
    assert.equal(camera.position.x,0,"Both views stay centered on the cabinet");
    const right = screenDragWorldDelta(camera, .1, 0), opposite = screenDragWorldDelta(camera, -.1, 0), depth = screenDragWorldDelta(camera, 0, .1);
    assert.equal(right.y, 0); assert.equal(depth.y, 0);
    assert(right.clone().add(opposite).length() < 1e-9 && right.length() > 0 && depth.length() > 0, "Horizontal-plane aiming remains finite and reversible in both camera views");
    assert(Math.abs(right.z)<1e-9 && right.x>0 && Math.abs(depth.x)<1e-9 && depth.z>0,"Front/top dragging keeps horizontal and depth axes separate");
    for (const corner of cabinetFramePoints()) {
      const point = corner.project(camera);
      assert(Math.abs(point.x) < .95 && Math.abs(point.y) < .95 && Math.abs(point.z) < 1, `Clipped cabinet at ${width}×${height}, top=${topView}`);
    }
    }
  }
}
// A neighboring cabinet must stay outside the whole shot, not merely have its center offscreen.
for (const aspect of [.5, 1.4, 2, 2.5, 3.6, 4]) for (const topView of [false, true]) {
  for (const camera of [new THREE.OrthographicCamera(-4, 4, 3, -3, .1, 500), new THREE.PerspectiveCamera(36, 1, .1, 500)]) {
    frameCabinet(camera, aspect, topView);
    for (const selected of STATION_X) {
      const positioned = camera.clone(); positioned.position.x += selected; positioned.updateMatrixWorld();
      for (const neighbor of STATION_X.filter(x => x !== selected)) {
        const points = cabinetFramePoints().map(point => point.add(new THREE.Vector3(neighbor, 0, 0)).project(positioned));
        assert(points.every(point => point.x > 1.05) || points.every(point => point.x < -1.05),
          `Neighbor ${neighbor} enters station ${selected}'s frame: aspect=${aspect}, top=${topView}`);
      }
    }
  }
}
console.log("PASS: full cabinet fits phone, tablet, desktop and short landscape viewports in both camera views.");
