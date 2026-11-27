import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import ts from "typescript";
import * as THREE from "three";
const compile=async name=>ts.transpileModule(await readFile(new URL("../components/claw/"+name+".ts",import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const url=source=>"data:text/javascript;base64,"+Buffer.from(source).toString("base64");
const configUrl=url(await compile("config")),{MACHINE}=await import(configUrl);
const gripUrl=url((await compile("clawGrip")).replace('"three"',JSON.stringify(import.meta.resolve("three"))));
const {pointBoxDistance,gripObstacle,JAW_TIP_RADIUS}=await import(gripUrl);
const planUrl=url((await compile("prizeGrip")).replace('"three"',JSON.stringify(import.meta.resolve("three"))).replace('"./config"',JSON.stringify(configUrl)).replace('"./clawGrip"',JSON.stringify(gripUrl)));
const {planPrizeGrip,prizeGripPose}=await import(planUrl);
const {createClaw}=await import(url((await compile("createClaw")).replace('"three"',JSON.stringify(import.meta.resolve("three"))).replace('"./config"',JSON.stringify(configUrl)).replace('"./clawGrip"',JSON.stringify(gripUrl))));
const fixture=(x,z,euler=new THREE.Euler())=>({id:"prize",size:.48,center:{x,y:1.5,z},rotation:new THREE.Quaternion().setFromEuler(euler)});
for(const box of [fixture(0,0),fixture(.2,-.1,new THREE.Euler(.4,.3,.7)),fixture(1.24,0),fixture(-1.24,0),fixture(1.24,1.14),fixture(-1.24,-1.14),fixture(0,0,new THREE.Euler(Math.PI/2,0,0))]) {
  const started=performance.now(),plan=planPrizeGrip(box,[box]);assert(plan,"Every tested prize needs a contact-based animation pose");
  console.log("Grip",box.center.x,box.center.z,"contacts",plan.contacts,"side",plan.sideContacts,"ms",Math.round(performance.now()-started));
  const rig=createClaw(new THREE.Scene(),new THREE.MeshPhysicalMaterial({metalness:1}));rig.claw.position.set(0,3.7,0);assert(rig.update(0,null,[],false,true));const origin=rig.snapshotPose();
  const original=new Map();rig.claw.traverse(mesh=>{if(mesh.isMesh)original.set(mesh,[...mesh.geometry.attributes.position.array]);});
  for(let t=0;t<=1550;t+=50) {
    rig.presentGripPose(prizeGripPose(origin,plan,t));
    rig.claw.traverse(mesh=>{
      if(!mesh.isMesh)return;assert.deepEqual([...mesh.geometry.attributes.position.array],original.get(mesh));
      const vertices=mesh.geometry.attributes.position;
      for(let i=0;i<vertices.count;i++) {
        const world=new THREE.Vector3().fromBufferAttribute(vertices,i).applyMatrix4(mesh.matrixWorld);
        assert(Math.abs(world.x)<MACHINE.width/2 && Math.abs(world.z)<MACHINE.depth/2,"Guided arms never leave the glass");
        const local=world.clone().sub(new THREE.Vector3(box.center.x,box.center.y,box.center.z)).applyQuaternion(box.rotation.clone().invert());
        assert(Math.max(Math.abs(local.x),Math.abs(local.y),Math.abs(local.z))>=box.size/2-1e-6,JSON.stringify({error:"Guided steel cannot penetrate the selected box",t,part:mesh.name,local:local.toArray(),position:rig.claw.position.toArray(),angles:plan.angles,approach:plan.approachAngles}));
      }
    });
  }
  assert(rig.claw.position.distanceTo(plan.position)<1e-8,"Glass clearance cannot move the final contact pose away from the prize");
  const touched=[];rig.claw.traverse(mesh=>{if(mesh.name==="Metal claw fingertip")touched.push(pointBoxDistance(mesh.getWorldPosition(new THREE.Vector3()),gripObstacle(box)));});
  assert(touched.some(distance=>distance<=JAW_TIP_RADIUS+.009),"A box cannot attach while floating below the fingertips");
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(.48,.48,.48));mesh.position.set(box.center.x,box.center.y,box.center.z);mesh.quaternion.copy(box.rotation);rig.claw.parent.add(mesh);rig.claw.attach(mesh);
  const held={...box,center:mesh.position.clone(),rotation:mesh.quaternion.clone()};
  for(let step=1;step<=20;step++) {rig.claw.position.copy(plan.position).add(new THREE.Vector3(0,step*.04,0));rig.claw.quaternion.copy(plan.rotation);rig.update(1,held,[],true);
    const distances=[];rig.claw.traverse(part=>{if(part.name==="Metal claw fingertip")distances.push(pointBoxDistance(part.getWorldPosition(new THREE.Vector3()),gripObstacle({...box,center:mesh.getWorldPosition(new THREE.Vector3()),rotation:mesh.getWorldQuaternion(new THREE.Quaternion())})));});
    assert(distances.some(distance=>distance<=JAW_TIP_RADIUS+.009),"Lift preserves contact instead of creating a hovering offset");
  }
}
console.log("PASS: guided approach, rigid geometry, selected-box/glass clearance, terminal contact before attachment and contact-preserving lift.");

const pileUrl=url((await compile("pile")).replace('"cannon-es"',JSON.stringify(import.meta.resolve("cannon-es"))).replace('"./config"',JSON.stringify(configUrl)));
const {createPile,hasClearGrabPoint,boxTop}=await import(pileUrl);
for(const seed of [42,2026,17]) {
  const pile=createPile(seed), exposed=pile.filter(box=>hasClearGrabPoint(box,pile));let allSide=0,neighborFree=0,maxMs=0;
  const high=Math.max(MACHINE.height-.90,Math.min(MACHINE.height-.25,Math.max(...pile.map(boxTop))+.78));
  for(const box of exposed) {
    const started=performance.now(),plan=planPrizeGrip(box,pile,box.grabPoint);maxMs=Math.max(maxMs,performance.now()-started);
    assert(plan,"An eligible fixed-prize box cannot lose its winning animation just because a mesh planner has no pose");
    assert(plan.contacts>=1);allSide+=Number(plan.sideContacts>=2);neighborFree+=Number(plan.neighboringContacts===0);
    const rig=createClaw(new THREE.Scene(),new THREE.MeshStandardMaterial());rig.claw.position.set(0,high,0);rig.update(0,null,pile,false,true);const origin=rig.snapshotPose();
    for(const elapsed of [0,350,650,900,1100,1300,1550]) {
      rig.presentGripPose(prizeGripPose(origin,plan,elapsed));
      rig.claw.traverse(part=>{
        if(!part.isMesh)return;const vertices=part.geometry.attributes.position;
        for(let i=0;i<vertices.count;i++) {
          const world=new THREE.Vector3().fromBufferAttribute(vertices,i).applyMatrix4(part.matrixWorld);
          assert(Math.abs(world.x)<MACHINE.width/2 && Math.abs(world.z)<MACHINE.depth/2);
          const local=world.sub(new THREE.Vector3(box.center.x,box.center.y,box.center.z)).applyQuaternion(new THREE.Quaternion(box.rotation.x,box.rotation.y,box.rotation.z,box.rotation.w).invert());
          assert(Math.max(Math.abs(local.x),Math.abs(local.y),Math.abs(local.z))>=box.size/2-1e-6,JSON.stringify({seed,box:box.id,elapsed,part:part.name,local:local.toArray()}));
        }
      });
    }
    assert(rig.claw.position.distanceTo(plan.position)<1e-8);
    const touched=[];rig.claw.traverse(part=>{if(part.name==="Metal claw fingertip")touched.push(pointBoxDistance(part.getWorldPosition(new THREE.Vector3()),gripObstacle(box)));});
    assert(touched.some(distance=>distance<=JAW_TIP_RADIUS+.009),"Every winning presentation reaches the actual prize before attachment");
    const geometries=new Set(),materials=new Set();rig.claw.traverse(part=>{if(part.isMesh){geometries.add(part.geometry);materials.add(part.material);}});geometries.forEach(geometry=>geometry.dispose());materials.forEach(material=>material.dispose());
  }
  console.log("Pile "+seed+": "+exposed.length+"/"+exposed.length+" prizes have contact poses; "+allSide+" with 2+ side pads; "+neighborFree+" clear of neighboring cubes; max plan "+Math.round(maxMs)+"ms.");
}
