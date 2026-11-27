import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import * as THREE from "three";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { runInNewContext } from "node:vm";
const compile = async (name, extension = "ts") => ts.transpileModule(await readFile(new URL(`../components/claw/${name}.${extension}`, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const url = source => "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const config = url(await compile("config")), { PRIZE_INVENTORY } = await import(config);
const prizeSource = (await compile("prizeModel")).replace('"three"', JSON.stringify(import.meta.resolve("three"))).replace('"three/addons/geometries/RoundedBoxGeometry.js"', JSON.stringify(import.meta.resolve("three/addons/geometries/RoundedBoxGeometry.js"))).replace('"three/addons/utils/BufferGeometryUtils.js"', JSON.stringify(import.meta.resolve("three/addons/utils/BufferGeometryUtils.js"))).replace('"./config"',JSON.stringify(config));
const { createPrizeGeometry } = await import(url(prizeSource));
const { createPrizeBatch } = await import(url((await compile("prizeBatch")).replace('"three"',JSON.stringify(import.meta.resolve("three")))));
const geometry=createPrizeGeometry(), scene=new THREE.Scene(), materials=new Map();
let index=0;
const boxes=PRIZE_INVENTORY.flatMap(tier=>Array.from({length:tier.count},()=>{const i=index++,rotation=new THREE.Quaternion().setFromEuler(new THREE.Euler(i*.01,i*.07,i*.03));return Object.freeze({...tier,id:`BOX-${i}`,size:.48,center:Object.freeze({x:(i%4)*.5-.75,y:Math.floor(i/16)*.5+.3,z:Math.floor(i%16/4)*.5-.75}),rotation:Object.freeze({x:rotation.x,y:rotation.y,z:rotation.z,w:rotation.w})});}));
const signature=JSON.stringify(boxes);
const pack=color=>{if(!materials.has(color))materials.set(color,Array.from({length:3},()=>new THREE.MeshBasicMaterial({color})));return materials.get(color);};
const batch=createPrizeBatch(scene,geometry,boxes,boxes,pack);assert(batch.sync());
assert.equal(batch.meshes.length,3);assert.deepEqual(batch.meshes.map(mesh=>mesh.count),[48,12,4]);
assert(batch.meshes.every(mesh=>mesh.geometry===geometry && mesh.material===pack(mesh.material[0].color.getHexString()==="7950b4"?"#7950b4":mesh.material[0].color.getHexString()==="ee9951"?"#ee9951":"#f5f1fa")));
function drawBudget(){let calls=0;scene.traverseVisible(mesh=>{if(mesh.isMesh && (!mesh.isInstancedMesh || mesh.count))calls+=mesh.geometry.groups.length||1;});return calls;}
assert.equal(drawBudget(),9,"64 real collector boxes submit three groups for each of three tiers");
for(const mesh of batch.meshes){const color=boxes.find(box=>pack(box.color)===mesh.material).color, tier=boxes.filter(box=>box.color===color);for(let i=0;i<tier.length;i++){const matrix=new THREE.Matrix4();mesh.getMatrixAt(i,matrix);const cube=batch.cubes.get(tier[i].id);cube.updateMatrix();matrix.elements.forEach((value,j)=>assert(Math.abs(value-cube.matrix.elements[j])<1e-6,"Every instanced box retains its exact pose"));}}
const versions=batch.meshes.map(mesh=>mesh.instanceMatrix.version);assert.equal(batch.sync(),false);assert.deepEqual(batch.meshes.map(mesh=>mesh.instanceMatrix.version),versions,"Static pile does not upload instance matrices every frame");
const claw=new THREE.Group();scene.add(claw);claw.position.set(.2,3,-.1);scene.updateMatrixWorld(true);
const picked=batch.cubes.get("BOX-0"), before=picked.getWorldPosition(new THREE.Vector3());claw.attach(picked);assert(picked.getWorldPosition(new THREE.Vector3()).distanceTo(before)<1e-8);
assert(batch.sync());assert.equal(batch.meshes.reduce((sum,mesh)=>sum+mesh.count,0),63);assert.equal(drawBudget(),12,"The carried prize appears once as a separate real mesh");
scene.attach(picked);picked.position.y=-.8;batch.sync();assert.equal(drawBudget(),12,"Dropping the prize never duplicates it in the pile");
picked.visible=false;batch.sync();assert.equal(drawBudget(),9,"Revealed prize is absent from pile and cabinet");
const settling=batch.cubes.get("BOX-1");settling.position.x+=.12;settling.quaternion.setFromEuler(new THREE.Euler(.2,.3,.4));assert(batch.sync());assert.equal(batch.sync(),false);
batch.reset();assert.equal(batch.meshes.reduce((sum,mesh)=>sum+mesh.count,0),64);assert.equal(drawBudget(),9);assert.equal(picked.parent,batch.proxies);
for(const box of boxes){const cube=batch.cubes.get(box.id);assert.deepEqual(cube.position.toArray(),[box.center.x,box.center.y,box.center.z]);assert.deepEqual(cube.quaternion.toArray(),[box.rotation.x,box.rotation.y,box.rotation.z,box.rotation.w]);}
assert.equal(JSON.stringify(boxes),signature,"Rendering cannot mutate the immutable prize inventory or odds data");
const partialScene=new THREE.Scene(), partial=createPrizeBatch(partialScene,geometry,boxes,boxes.slice(2),pack);partial.sync();assert.equal(partial.meshes.reduce((sum,mesh)=>sum+mesh.count,0),62,"Saved removals do not reappear on reload");
let disposed=0;batch.meshes.forEach(mesh=>mesh.addEventListener("dispose",()=>disposed++));batch.dispose();assert.equal(disposed,3);partial.dispose();geometry.dispose();materials.forEach(pack=>pack.forEach(material=>material.dispose()));
const { createShadowBudget }=await import(url(await compile("shadowBudget")));
const staticShadow=createShadowBudget();assert(staticShadow(0,[0,0]));for(let t=10;t<=2000;t+=10)assert.equal(staticShadow(t,[0,0]),false,"An unchanged scene reuses its shadow map");
assert(staticShadow(2100,[.2,0]));assert.equal(staticShadow(2110,[.3,0]),false);assert(staticShadow(2140,[.3,0]));assert(staticShadow(2200,[.3,0],true),"Settling or inventory changes invalidate the shadow");
for(const fps of [60,120,144]){const moving=createShadowBudget();let refreshes=0;for(let i=0;i<fps;i++)refreshes+=Number(moving(i*1000/fps,[i/fps]));assert(refreshes<=31 && refreshes>=20);}
const { createFrameGate }=await import(url(await compile("frameGate")));
for(const fps of [20,30,60,90,120,144,240]){const gate=createFrameGate();let frames=0;for(let i=0;i<fps*3;i++)frames+=Number(gate(i*1000/fps));assert(Math.abs(frames/3-Math.min(fps,60))<1,"60 Hz cap must preserve smoothness on both high- and low-refresh displays");assert(gate(10000),"Resume immediately after a hidden-tab pause");}
const hints=(await compile("MachineAssetHints","tsx")).replace('"react/jsx-runtime"',JSON.stringify(import.meta.resolve("react/jsx-runtime"))).replace('"./pavementAssets"',JSON.stringify(url(await compile("pavementAssets"))));
const { default: AssetHints }=await import(url(hints));const html=renderToString(createElement(AssetHints));
for(const asset of ["pixel-sans-serif.ttf","cato-mascot-transparent.png"])assert(html.includes(asset),"Initial HTML starts required font/logo assets early");
assert(!html.includes("concrete-"),"The generated glossy floor does not preload obsolete concrete scans");
const machine=await readFile(new URL("../components/claw/createMachine.ts",import.meta.url),"utf8"), ast=ts.createSourceFile("createMachine.ts",machine,ts.ScriptTarget.Latest,true);
let begin;
function find(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==="beginDrop")begin=node;ts.forEachChild(node,find);}find(ast);assert(begin);
const beginJs=ts.transpileModule(begin.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
for(const result of ["ready","failed","disposed","stale"]){let done,fail,snapshots=0;const errors=[],phases=[];
  const context={pull:{id:"locked"},mode:"prepared",dx:1,dz:1,disposed:false,gripPlanning:new Promise((resolve,reject)=>{done=resolve;fail=reject;}),gripPlan:null,gripOrigin:null,picked:null,dropStart:0,
    clawModel:{snapshotPose(){snapshots++;return {position:"actual visible pose"};}},performance:{now:()=>100},phase:value=>phases.push(value),onError:error=>errors.push(error),resolve(){throw Error("Planning cannot consume a draw");}};
  const beginDrop=runInNewContext(beginJs+"\nbeginDrop",context);beginDrop();assert.equal(context.mode,"planning");assert.equal(snapshots,0,"Claw waits for its contact plan instead of starting an incomplete descent");
  if(result==="disposed")context.disposed=true;if(result==="stale")context.pull={id:"another"};if(result==="failed")fail(Error("test worker failure"));else done();
  await new Promise(resolve=>setImmediate(resolve));
  if(result==="ready"){assert.equal(context.mode,"animating");assert.equal(snapshots,1);assert.equal(context.dropStart,100);assert.deepEqual(phases,["descending"]);}
  else if(result==="failed"){assert.equal(context.mode,"idle");assert.equal(context.pull,null);assert.equal(errors.length,1);}
  else {assert.equal(snapshots,0);assert.equal(phases.length,0);assert.equal(errors.length,0,"Stale/disposed planning cannot update the next game");}
}
// Presentation physics begins during descent and cannot wait for or consume a draw.
{
 let complete, jobs=0;
 const prize={id:"locked-prize"}, other={id:"neighbor"}, plan={durationMs:1350}, frames=[{atMs:0,boxes:[other]}];
 const context={pull:{id:"prefetch",target:{box:prize}},gripPlan:{},gripOrigin:null,gripPlanning:Promise.resolve(),pickupPlanning:null,
  mode:"prepared",disposed:false,dx:0,dz:0,boxes:[prize,other],planPrizeTransport:()=>plan,
  setup:{pickup(remaining,transport){jobs++;assert.equal(remaining.length,1);assert.strictEqual(remaining[0],other);assert.strictEqual(transport,plan);return new Promise(resolve=>{complete=()=>resolve(frames);});}},
  clawModel:{snapshotPose:()=>({})},performance:{now:()=>100},phase(){},onError(e){throw e;},resolve(){throw Error("Prefetch cannot draw");}};
 runInNewContext(beginJs+"\nbeginDrop();",context);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(jobs,1);assert.equal(context.mode,"animating","Descent must not await pickup physics");assert(context.pickupPlanning);
 complete();const ready=await context.pickupPlanning;assert.strictEqual(ready.frames,frames);assert.strictEqual(ready.transport,plan);
 assert.deepEqual(context.boxes,[prize,other],"Speculative simulation cannot remove a prize or publish future pile poses");
}
const report={environment:"Real Three.js scene graphs, lifecycle callbacks and SSR; not measured browser FPS or GPU timings",prizeMainPassGroupBudget:{before:192,after:9,carrying:12},staticInstanceUploadsAfterInitial:0,shadowRefreshHzMax:30,renderRefreshHzMax:60,initialHtmlPreloads:2,gripPlanning:"worker; descent waits for the unchanged contact plan"};
await writeFile(new URL("../../../docs/claw/performance/batching.json",import.meta.url),JSON.stringify(report,null,2)+"\n");
console.log("PASS: exact instanced transforms/materials/geometry, no duplicate carried/dropped/revealed prizes, saved removal/reset, no static GPU uploads, instance disposal, shadow invalidation/rate limit and initial HTML preloads.");console.log(JSON.stringify(report));
