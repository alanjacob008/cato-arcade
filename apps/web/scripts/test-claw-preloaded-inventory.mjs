import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import * as THREE from "three";
import {clawModule} from "./claw-test-loader.mjs";
const {createPrizeBatch}=await import(await clawModule("prizeBatch"));
const {PRIZE_INVENTORY}=await import(await clawModule("config"));
let index=0;
const initial=PRIZE_INVENTORY.flatMap(prize=>Array.from({length:prize.count},()=>({...prize,id:`BOX-${++index}`,size:.48,center:{x:0,y:1,z:0},rotation:{x:0,y:0,z:0,w:1}})));
const materials=new Map(),pack=color=>{if(!materials.has(color))materials.set(color,[new THREE.MeshStandardMaterial({color})]);return materials.get(color);};
const scene=new THREE.Scene(),batch=createPrizeBatch(scene,new THREE.BoxGeometry(.48,.48,.48),initial,initial,pack);batch.sync();
const meshes=[...batch.meshes],buffers=meshes.map(mesh=>mesh.instanceMatrix),proxies=[...batch.cubes.values()];
const personal=initial.map((box,i)=>({...box,color:initial[(i+17)%initial.length].color,cents:initial[(i+17)%initial.length].cents,center:{x:(i%3)*.2,y:1+(i%4)*.2,z:(i%5)*.1}}));
const remaining=personal.filter((_box,i)=>i!==2&&i!==11&&i!==56),snapshot=JSON.stringify({personal,remaining});
const loose=batch.cubes.get(initial[0].id);scene.attach(loose);loose.visible=false;
assert(batch.replace(personal,remaining));
assert.strictEqual(loose.parent,batch.proxies);assert(loose.visible,"A delivered proxy is restored only from the new authoritative inventory");
assert(batch.meshes.every((mesh,i)=>mesh===meshes[i]&&mesh.instanceMatrix===buffers[i]),"Wallet layout reuses the existing GPU meshes and instance buffers");
assert([...batch.cubes.values()].every((cube,i)=>cube===proxies[i]),"Wallet sign-in cannot rebuild prize geometry or proxies");
for(const prize of personal){const cube=batch.cubes.get(prize.id);assert.strictEqual(cube.material,pack(prize.color));assert.equal(cube.visible,remaining.some(box=>box.id===prize.id));}
for(const mesh of meshes){const color=[...materials].find(([,material])=>material===mesh.material)[0],expected=remaining.filter(box=>box.color===color);assert.equal(mesh.count,expected.length);
 for(const [slot,prize]of expected.entries()){const matrix=new THREE.Matrix4();mesh.getMatrixAt(slot,matrix);const position=new THREE.Vector3().setFromMatrixPosition(matrix);assert(position.distanceTo(new THREE.Vector3(prize.center.x,prize.center.y,prize.center.z))<1e-6);}
}
const versions=meshes.map(mesh=>mesh.instanceMatrix.version);assert.equal(batch.sync(),false);assert.deepEqual(meshes.map(mesh=>mesh.instanceMatrix.version),versions);
assert.equal(JSON.stringify({personal,remaining}),snapshot,"The server's prizes and saved poses remain unchanged");
assert.equal(batch.replace(personal,[...remaining,remaining[0]]),false);assert.equal(batch.replace(personal.map((box,i)=>i?box:{...box,id:"unknown"}),remaining),false);
assert.deepEqual(meshes.map(mesh=>mesh.instanceMatrix.version),versions,"Invalid replacements are rejected before any partial GPU update");
batch.reset();assert.equal(meshes.reduce((total,mesh)=>total+mesh.count,0),64);assert.equal(batch.cubes.get(personal[0].id).position.y,personal[0].center.y,"Reset uses the new authoritative arrangement");
batch.dispose();

// Execute the real React apply callback against a warm-controller fixture.
const source=await readFile(new URL("../components/claw/AuthoritativeArcade.tsx",import.meta.url),"utf8"),ast=ts.createSourceFile("AuthoritativeArcade.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let callback;function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==="apply")callback=node.initializer.arguments[0].getText(ast);ts.forEachChild(node,visit);}visit(ast);assert(callback);
const compiled=ts.transpileModule(`exports.apply=${callback}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
for(const warm of [true,false]){
 const initialState={wallet:"",arrangement:{id:"preview"}},state={wallet:"player",arrangement:{id:"personal"},initialBoxes:personal,boxes:remaining};
 const calls=[],model={current:initialState},context={exports:{},alive:{current:true},model,machine:{current:warm?{
  replaceArrangement:(canonical,poses,arrangement)=>{assert.strictEqual(canonical,personal);assert.strictEqual(poses,remaining);assert.strictEqual(arrangement,state.arrangement);calls.push("reuse");return true;},
  applyAuthoritativeBoxes:()=>calls.push("poses"),}:null},setView:value=>assert.strictEqual(value,state),setReady:()=>calls.push("unready"),setTasks:()=>calls.push("loading"),markLoaded:()=>{},setSetup:()=>calls.push("rebuild"),client:()=>({queued:()=>null}),setQueued:()=>{}};
 vm.runInNewContext(compiled,context);context.exports.apply(state);assert.strictEqual(model.current,state);
 assert.deepEqual(calls,warm?["reuse"]:["unready","loading","rebuild"],"A warmed wallet transition never resets readiness or rebuilds its renderer");
}
console.log("PASS: authoritative wallet inventory changes colors/poses/removals in existing GPU buffers; warm sign-in skips scene rebuilding and loading.");
