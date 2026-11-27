import { clawModule } from "./claw-test-loader.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as THREE from "three";
const directory = new URL("../components/claw/", import.meta.url);
const compile = async name => ts.transpileModule(await readFile(new URL(name + ".ts", directory), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const url = source => "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const configUrl = url(await compile("config"));
const pileUrl = url((await compile("pile")).replace('"cannon-es"', JSON.stringify(import.meta.resolve("cannon-es"))).replace('"./config"', JSON.stringify(configUrl)));
const { createPile, settlePile, hasClearGrabPoint } = await import(pileUrl);
const gripUrl = url((await compile("clawGrip")).replace('"three"', JSON.stringify(import.meta.resolve("three"))));
const planUrl = url((await compile("prizeGrip")).replace('"three"', JSON.stringify(import.meta.resolve("three"))).replace('"./clawGrip"', JSON.stringify(gripUrl)).replace('"./config"', JSON.stringify(configUrl)));
const { planPrizeGrip } = await import(planUrl);
const pickupUrl = await clawModule("pickupPhysics");
const workerUrl = new URL(url('import {parentPort} from "node:worker_threads"; globalThis.postMessage = value => parentPort.postMessage(value);\n' + (await compile("pile.worker")).replace('"./pickupPhysics"', JSON.stringify(pickupUrl)).replace('"./pile"', JSON.stringify(pileUrl)).replace('"./prizeGrip"',JSON.stringify(planUrl)) + '\nparentPort.on("message",data=>globalThis.onmessage({data}));'));
const { createPhysicsService } = await import(url((await compile("physicsService")).replace('"./pickupPhysics"', JSON.stringify(pickupUrl)).replace('"./pile"', JSON.stringify(pileUrl)).replace('"./prizeGrip"',JSON.stringify(planUrl)).replace('"three"',JSON.stringify(import.meta.resolve("three")))));
class Adapter {
  constructor() {
    this.thread = new Worker(workerUrl);
    this.thread.on("message", data => {
      if (data.result && !Array.isArray(data.result) && data.result.rotation) assert([data.result.rotation.x,data.result.rotation.y,data.result.rotation.z,data.result.rotation.w].every(Number.isFinite),"Worker transport must serialize quaternion getters explicitly");
      this.onmessage?.({ data });
    });
    this.thread.on("error", error => this.onerror?.({ error, preventDefault() {} }));
  }
  postMessage(value) { this.thread.postMessage(value); }
  terminate() { void this.thread.terminate(); }
}
const service = createPhysicsService(() => new Adapter());
const seed = 91276, start = performance.now();
let heartbeats = 0;
const timer = setInterval(() => heartbeats++, 20);
let boxes, metric, createHeartbeats;
try {
  boxes = await service.create(seed); metric = service.metrics(); createHeartbeats = heartbeats;
  assert(heartbeats > 10, "Main-thread timers stay responsive while the real pile worker simulates");
  assert(metric.worker); assert(Object.isFrozen(boxes[0]) && Object.isFrozen(boxes[0].center));
  assert.equal(await service.create(seed), boxes, "Repeat mounts reuse the bounded immutable layout cache");
  assert.deepEqual(boxes, createPile(seed), "Worker poses/prizes are identical to the previous deterministic simulation");
  const remaining = boxes.slice(1);
  assert.deepEqual(await service.settle(remaining), settlePile(remaining), "Every worker settling frame matches the old engine");
  const target=boxes.find(box=>hasClearGrabPoint(box,boxes));
  const plan=await service.plan(target,boxes,target.grabPoint);
  assert.deepEqual(plan,planPrizeGrip(target,boxes,target.grabPoint),"Worker contact plan is identical to the original planner");
  assert(plan.position instanceof THREE.Vector3 && plan.rotation instanceof THREE.Quaternion,"Structured-cloned plans regain their vector/quaternion methods");
  const {planPrizeTransport}=await import(await clawModule("prizeTransport"));
  const {settlePickup}=await import(pickupUrl);
  const transport=planPrizeTransport(target,plan), remainder=boxes.filter(b=>b.id!==target.id);
  assert.deepEqual(structuredClone(transport),transport,"Carrier rotation and local prize offset survive worker serialization");
  assert.deepEqual(await service.pickup(remainder,transport),settlePickup(remainder,transport),"Worker extraction exactly matches the collision-coupled main-thread fallback");
  assert.equal(service.metrics().kind,"pickup");assert(service.metrics().worker);
  await assert.rejects(service.create(-1)); await assert.rejects(service.create(NaN));
} finally { clearInterval(timer); service.dispose(); }
await assert.rejects(service.create(seed), /disposed/);
const workerMeasurement = { computeMs: Math.round(metric.computeMs), roundTripMs: Math.round(metric.roundTripMs), heartbeatsDuringCreate: createHeartbeats, totalTestMs: Math.round(performance.now()-start) };
class FakeWorker { postMessage(job) { this.jobs.push(job); } terminate() { this.terminated = true; } jobs = []; }
const fake = new FakeWorker(), concurrent = createPhysicsService(() => fake);
const first = concurrent.create(802), second = concurrent.create(803);
fake.onmessage({ data: { id: fake.jobs[1].id, result: structuredClone(boxes), computeMs: 2 } });
fake.onmessage({ data: { id: fake.jobs[0].id, result: structuredClone(boxes), computeMs: 1 } });
await Promise.all([first, second]); assert.equal(fake.jobs.length, 2);
await concurrent.create(802); assert.equal(fake.jobs.length, 2);
const third = concurrent.create(804); fake.onmessage({ data: { id: fake.jobs.at(-1).id, result: structuredClone(boxes), computeMs: 1 } }); await third;
const evicted = concurrent.create(803); assert.equal(fake.jobs.length, 4, "Layout cache is capped at two seeds");
const rejection = assert.rejects(evicted, /disposed/); concurrent.dispose(); await rejection; assert(fake.terminated);
const failing = new FakeWorker(), fallback = createPhysicsService(() => failing);
const pending = fallback.settle([]); failing.onerror({ preventDefault() {} });
assert.deepEqual(await pending, settlePile([])); assert.equal(fallback.metrics().worker, false); fallback.dispose();

const { renderPixelRatio } = await import(url(await compile("renderBudget")));
for (const [w,h,dpr] of [[390,500,3],[1440,900,2],[3840,2160,3],[800,600,1]]) {
  const ratio = renderPixelRatio(w,h,dpr); assert(ratio > 0 && ratio <= dpr); assert(w*h*ratio*ratio <= 2_500_000 + 1e-6);
}

const { JAW_TRAVEL_ANGLE } = await import(gripUrl);
const { createClaw } = await import(url((await compile("createClaw")).replace('"three"', JSON.stringify(import.meta.resolve("three"))).replace('"./clawGrip"',JSON.stringify(gripUrl)).replace('"./config"',JSON.stringify(configUrl))));
const rig = createClaw(new THREE.Scene(), new THREE.MeshStandardMaterial());
const travel = rig.travelBounds, full = rig.movementBounds;
assert(travel.maxX-travel.minX > full.maxX-full.minX && travel.maxZ-travel.minZ > full.maxZ-full.minZ);
for (const x of [travel.minX,travel.maxX]) for (const z of [travel.minZ,travel.maxZ]) {
  rig.claw.position.set(x,3.5,z); rig.claw.quaternion.identity(); assert(rig.update(0,null,[],false,true));
  const compact = rig.snapshotPose(); assert(compact.angles.every(angle => angle === JAW_TRAVEL_ANGLE));
  for (const dx of [.02,.04]) { rig.claw.position.x = x===travel.maxX ? x-dx : x+dx; assert(rig.update(0,null,[],false,true)); }
  rig.claw.traverse(mesh => { if (!mesh.isMesh) return; mesh.updateWorldMatrix(true,false); const p=mesh.geometry.attributes.position;
    for(let i=0;i<p.count;i++) { const v=new THREE.Vector3().fromBufferAttribute(p,i).applyMatrix4(mesh.matrixWorld); assert(Math.abs(v.x)<1.5 && Math.abs(v.z)<1.4); }
  });
}
const source = await readFile(new URL("createMachine.ts",directory),"utf8");
const ast = ts.createSourceFile("createMachine.ts",source,ts.ScriptTarget.Latest,true);
let prepare;
function find(node) { if(ts.isPropertyAssignment(node) && node.name.getText(ast)==="prepareDrop") prepare=node.initializer; ts.forEachChild(node,find); } find(ast); assert(prepare);
const context = { claw:rig.claw, x:-.4,z:-.5,visualX:0,visualZ:0,mode:"idle",disposed:false,warming:false,boxes:[], onAim() {}, selectTarget:aim=>{assert.equal(aim.x,rig.claw.position.x);assert.equal(aim.z,rig.claw.position.z);return null;}, highestSurfaceAt:()=>null, RULES_VERSION:"test",entryPriceUsd:()=>2,arrangement:{}, performance, original:{}, cubes:new Map() };
const compiled = ts.transpileModule("const prepare="+prepare.getText(ast)+"; prepare('visible-lock',0,'USDC',{});",{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
// Closure variables are assigned by the production callback.
for(const name of ["grabHeight","pull","dx","dz","previousPhase","drawRequested","dropImpacted","result","picked","gripPlan","gripOrigin","gripPlanning"]) context[name]=null;
runInNewContext(compiled,context); assert.equal(context.pull.aim.x,rig.claw.position.x); assert.equal(context.pull.aim.z,rig.claw.position.z);
const dailyUrl = url((await compile("daily")).replaceAll('"./config"',JSON.stringify(configUrl)));
const rewardsUrl = url((await compile("rewards")).replaceAll('"./config"',JSON.stringify(configUrl)).replaceAll('"./pile"',JSON.stringify(pileUrl)).replaceAll('"./daily"',JSON.stringify(dailyUrl)));
const { selectTarget, startingAim } = await import(rewardsUrl);
let clearing = boxes, collected = 0;
while(clearing.length) {
  const preferred=startingAim(clearing), clamp=point=>({x:Math.max(travel.minX,Math.min(travel.maxX,point.x)),z:Math.max(travel.minZ,Math.min(travel.maxZ,point.z))});
  let selected=selectTarget(clamp(preferred),clearing,0);
  if(!selected) for(const box of clearing) { selected=selectTarget(clamp(box.grabPoint),clearing,0); if(selected)break; }
  if(!selected) for(let ix=0;ix<=20 && !selected;ix++) for(let iz=0;iz<=20 && !selected;iz++) selected=selectTarget({x:travel.minX+(travel.maxX-travel.minX)*ix/20,z:travel.minZ+(travel.maxZ-travel.minZ)*iz/20},clearing,0);
  assert(selected,"Compact visible bounds must still allow the complete 64-box inventory to be cleared");
  clearing=settlePile(clearing.filter(box=>box.id!==selected.box.id)).at(-1); collected++;
}
assert.equal(collected,64);
const after = { environment:"Node worker and real Three.js geometry tests; not browser FPS/TTI or actual GPU memory", worker:workerMeasurement,
  compactTravel:{width:+(travel.maxX-travel.minX).toFixed(3),depth:+(travel.maxZ-travel.minZ).toFixed(3)},
  fullOpenEnvelope:{width:+(full.maxX-full.minX).toFixed(3),depth:+(full.maxZ-full.minZ).toFixed(3)},
  steadyWebGLContexts:1, temporaryThumbnailContexts:1, renderPixelBudget:2_500_000 };
await writeFile(new URL("../../../docs/claw/performance/after.json",import.meta.url),JSON.stringify(after,null,2)+"\n");
console.log("PASS: worker/main-thread responsiveness, identical seeded poses and all settlement frames, bounded cache, job routing, disposal, fallback, pixel budget, compact corner travel/reversal, visible-position target lock and full 64-box clearance within compact bounds.");
console.log(JSON.stringify(after));
