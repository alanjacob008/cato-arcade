import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as THREE from "three";

const compile = async name => ts.transpileModule(await readFile(new URL(`../components/claw/${name}.ts`, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const url = source => "data:text/javascript;base64,"+Buffer.from(source).toString("base64");
const gripUrl = url((await compile("clawGrip")).replace('"three"', JSON.stringify(import.meta.resolve("three"))));
const { curvedJawPoints, curvedJawPose, clawTravelBounds, clawCablePose, pointBoxDistance, gripObstacle, GRIP_CLEARANCE, JAW_TIP_RADIUS, JAW_OPEN_ANGLE, JAW_ROOT_RADIUS, JAW_ROOT_Y } = await import(gripUrl);
const configUrl = url(await compile("config")), { MACHINE, ARENA } = await import(configUrl);
const { createClaw } = await import(url((await compile("createClaw")).replace('"three"', JSON.stringify(import.meta.resolve("three"))).replace('"./clawGrip"', JSON.stringify(gripUrl)).replace('"./config"', JSON.stringify(configUrl))));
const meshes = model => {const result=[];model.claw.traverse(object=>{if(object.isMesh)result.push(object);});return result;};
const pivots = model => {const result=[];model.claw.traverse(object=>{if(object.name==="Claw finger pivot")result.push(object);});return result;};
const tips = model => meshes(model).filter(mesh=>mesh.name==="Metal claw fingertip");
function noPenetration(model, boxes) {
  model.claw.updateMatrixWorld(true);
  for(const mesh of meshes(model)) {
    const vertices=mesh.geometry.attributes.position;
    for(let i=0;i<vertices.count;i++) {
      const world=new THREE.Vector3().fromBufferAttribute(vertices,i).applyMatrix4(mesh.matrixWorld);
      assert(Math.abs(world.x)<MACHINE.width/2 && Math.abs(world.z)<MACHINE.depth/2,"Rigid steel stays inside the glass");
      for(const box of boxes) {
        const local=world.clone().sub(new THREE.Vector3(box.center.x,box.center.y,box.center.z)).applyQuaternion(new THREE.Quaternion(box.rotation.x,box.rotation.y,box.rotation.z,box.rotation.w).invert());
        assert(Math.max(Math.abs(local.x),Math.abs(local.y),Math.abs(local.z))>=box.size/2-1e-6,"Metal geometry cannot pass through a prize");
      }
    }
  }
}
function dispose(model) {
  const geometry=new Set(),material=new Set();for(const mesh of meshes(model)){geometry.add(mesh.geometry);material.add(mesh.material);}geometry.forEach(g=>g.dispose());material.forEach(m=>m.dispose());
}
for (const rotation of [new THREE.Euler(), new THREE.Euler(Math.PI / 2, 0, 0), new THREE.Euler(.4, .3, .7)]) {
  const q=new THREE.Quaternion().setFromEuler(rotation), box={id:"target",center:{x:.15,y:1.5,z:-.1},rotation:q,size:.48};
  const top=1.5+.24*(Math.abs(2*(q.x*q.y+q.w*q.z))+Math.abs(1-2*(q.x*q.x+q.z*q.z))+Math.abs(2*(q.y*q.z-q.w*q.x)));
  for(const aim of [{x:.15,z:-.1},{x:.30,z:.05}]) {
    const model=createClaw(new THREE.Scene(),new THREE.MeshPhysicalMaterial({metalness:1}));
    model.claw.position.set(aim.x,top+GRIP_CLEARANCE+.7,aim.z);assert(model.update(0,null,[box]));
    assert.equal(pivots(model).length,3,"Exactly one animated shoulder hinge per finger");
    assert.equal(meshes(model).filter(mesh=>mesh.name==="Single hinge curved steel jaw").length,3);
    assert(!meshes(model).some(mesh=>mesh.name.includes("elbow")),"No elbow joint or two-link IK remains");
    const original=new Map(meshes(model).map(mesh=>[mesh,[...mesh.geometry.attributes.position.array]]));
    for(let step=1;step<=40;step++){model.claw.position.y=top+GRIP_CLEARANCE+.7*(1-step/40);model.update(0,box,[box]);}
    let previous=pivots(model).map(pivot=>pivot.quaternion.clone());
    for(let frame=0;frame<=80;frame++) {
      model.update(frame/80,box,[box]);
      pivots(model).forEach((pivot,i)=>{assert(pivot.quaternion.angleTo(previous[i])<.02,"Closure uses a smooth single-axis hinge rotation");assert(pivot.rotation.z>=0 && pivot.rotation.z<=JAW_OPEN_ANGLE);});
      previous=pivots(model).map(pivot=>pivot.quaternion.clone());
      if(frame%10===0) noPenetration(model,[box]);
      for(const mesh of meshes(model)){assert.deepEqual([...mesh.geometry.attributes.position.array],original.get(mesh),"Curved arms never change their geometry");assert.deepEqual(mesh.scale.toArray(),[1,1,1],"Curved arms never stretch");}
    }
    if((rotation.x===0 || rotation.x===Math.PI/2) && aim.x===.15) assert(model.gripping,"Aligned flat boxes are picked up at the terminal pads");
    if(model.gripping) {
      const angles=pivots(model).map(pivot=>pivot.rotation.z);
      const held={...box,center:new THREE.Vector3(box.center.x,box.center.y,box.center.z).sub(model.claw.position)};
      model.claw.position.set(.4,3.3,.3);model.update(1,held,[],true);assert(model.gripping);
      assert.deepEqual(pivots(model).map(pivot=>pivot.rotation.z),angles,"Hinges stay locked during transport");
      const heldWorld={...box,center:held.center.clone().add(model.claw.position)};
      noPenetration(model,[heldWorld]);
      for(const tip of tips(model)) {
        const world=tip.getWorldPosition(new THREE.Vector3());
        assert(pointBoxDistance(world,gripObstacle(heldWorld))<=JAW_TIP_RADIUS+.006,"The carried box stays at its actual pad contacts");
      }
    }
    dispose(model);
  }
}
// Empty open/close cycles have a fixed shape, fixed hinge axis and bounded angular velocity.
const smooth=createClaw(new THREE.Scene(),new THREE.MeshStandardMaterial());smooth.claw.position.set(0,3.5,0);
const points=curvedJawPoints(), constantDistance=points.at(-1).length();let previous=null;
for(let frame=0;frame<=240;frame++) {
  const closed=frame<=120?frame/120:(240-frame)/120;assert(smooth.update(closed,null));
  const joints=pivots(smooth);
  if(previous) joints.forEach((joint,i)=>assert(joint.quaternion.angleTo(previous[i])<.01,"No joint flips at full closure or reopening"));
  previous=joints.map(joint=>joint.quaternion.clone());
  for(let i=0;i<3;i++) {
    const azimuth=i*2*Math.PI/3, path=curvedJawPose(points,azimuth,joints[i].rotation.z);
    const root=new THREE.Vector3(Math.cos(azimuth)*JAW_ROOT_RADIUS,JAW_ROOT_Y,Math.sin(azimuth)*JAW_ROOT_RADIUS);
    assert(Math.abs(path.at(-1).distanceTo(root)-constantDistance)<1e-9,"Rigid fingers only rotate about their one hinge");
    const hinge=new THREE.Vector3(-Math.sin(azimuth),0,Math.cos(azimuth));
    assert(path.every(point=>Math.abs(point.dot(hinge))<1e-9),"The entire curved finger stays in its hinge plane");
  }
}
// Logical aim retains its original range; the visual motor stops safely at the glass.
const limits=createClaw(new THREE.Scene(),new THREE.MeshStandardMaterial());
limits.claw.position.set(0,3.5,0);assert(limits.update(0,null));
for(const x of [ARENA.minX,0,ARENA.maxX]) for(const z of [ARENA.minZ,0,ARENA.maxZ]) {
  limits.claw.position.set(x,3.5,z);limits.claw.quaternion.identity();limits.update(0,null);noPenetration(limits,[]);
  assert(pivots(limits).every(pivot=>pivot.rotation.z===JAW_OPEN_ANGLE),"Visual glass stops cannot distort the curved fingers");
}
// Sweep every cabinet edge/corner with swing; the motor stops instead of reshaping its fingers.
const edge=createClaw(new THREE.Scene(),new THREE.MeshStandardMaterial());edge.claw.position.set(0,3.5,0);assert(edge.update(0,null));
for(const signX of [-1,1]) for(const signZ of [-1,1]) {
  for(let step=1;step<=40;step++) {
    edge.claw.position.set(signX*1.35*step/40,3.5,signZ*1.25*step/40);edge.claw.rotation.set(.20,0,-.25);
    edge.update(0,null);noPenetration(edge,[]);
    assert(pivots(edge).every(pivot=>Math.abs(pivot.rotation.z-JAW_OPEN_ANGLE)<1e-9),"Glass never causes an elbow fold or changes the open finger shape");
  }
  edge.claw.position.set(0,3.5,0);edge.claw.quaternion.identity();edge.update(0,null);
}
// A wall contact must slide along the other axis and release cleanly on reversal.
const sliding=createClaw(new THREE.Scene(),new THREE.MeshStandardMaterial());sliding.claw.position.set(0,3.5,0);assert(sliding.update(0,null));
for(const axis of ["x","z"]) for(const sign of [-1,1]) {
  for(let frame=0;frame<=60;frame++) {
    const along=-.6+1.2*frame/60;
    sliding.claw.position.set(axis==="x"?sign*ARENA.maxX:along,3.5,axis==="z"?sign*ARENA.maxZ:along);sliding.claw.quaternion.identity();
    assert(sliding.update(0,null),"Glass contact must project position rather than freeze translation/rotation together");
    assert(Math.abs(sliding.claw.position[axis==="x"?"z":"x"]-along)<1e-9,"Claw slides freely parallel to every glass wall");
    if(frame%10===0)noPenetration(sliding,[]);
    const cable=clawCablePose(sliding.claw.position,sliding.claw.quaternion,MACHINE.height-.14);
    assert(Math.abs(cable.anchor.y-(MACHINE.height-.14))<1e-9);
    assert(cable.anchor.clone().sub(sliding.claw.position).normalize().distanceTo(new THREE.Vector3(0,1,0).applyQuaternion(sliding.claw.quaternion))<1e-9,"Cable and claw bearing always share one orientation");
  }
  const before=sliding.claw.position.clone();sliding.claw.position[axis]-=sign*.03;
  assert(sliding.update(0,null));assert(Math.abs(sliding.claw.position[axis]-before[axis]+sign*.03)<1e-9,"A valid inward movement releases the wall contact immediately");
  sliding.claw.position.set(0,3.5,0);sliding.update(0,null);
}
// Repeated corner pushes and small sway changes cannot stick rotation or detach the cable.
for(let frame=0;frame<=120;frame++) {
  const rotation=new THREE.Quaternion().setFromEuler(new THREE.Euler(.08*Math.sin(frame/15),0,.08*Math.cos(frame/15)));
  sliding.claw.position.set(ARENA.maxX,3.5,ARENA.maxZ);sliding.claw.quaternion.copy(rotation);assert(sliding.update(0,null));
  assert(sliding.claw.quaternion.angleTo(rotation)<1e-7,"Glass projection never freezes the requested pendulum orientation");
  const cable=clawCablePose(sliding.claw.position,sliding.claw.quaternion,MACHINE.height-.14);
  assert(Math.abs(cable.anchor.y-(MACHINE.height-.14))<1e-9);
  assert(cable.anchor.clone().sub(sliding.claw.position).normalize().distanceTo(new THREE.Vector3(0,1,0).applyQuaternion(rotation))<1e-9);
  if(frame%10===0)noPenetration(sliding,[]);
}
// Bounds cover the entire rigid jaw, including all intermediate hinge angles, under sway.
for(const rotation of [new THREE.Quaternion(),new THREE.Quaternion().setFromEuler(new THREE.Euler(.20,0,-.25))]) {
  const bounds=clawTravelBounds(curvedJawPoints(),rotation,MACHINE);
  for(let step=0;step<=80;step++) for(let finger=0;finger<3;finger++) {
    const path=curvedJawPose(curvedJawPoints(),finger*2*Math.PI/3,JAW_OPEN_ANGLE*step/80);
    for(const point of path) {
      point.applyQuaternion(rotation);
      for(const x of [bounds.minX,bounds.maxX]) for(const z of [bounds.minZ,bounds.maxZ]) {
        assert(Math.abs(point.x+x)<=MACHINE.width/2-.02+1e-9);
        assert(Math.abs(point.z+z)<=MACHINE.depth/2-.02+1e-9);
      }
    }
  }
}
const blocked=createClaw(new THREE.Scene(),new THREE.MeshStandardMaterial());
const obstacle={id:"blocker",center:{x:0,y:1.5,z:0},rotation:new THREE.Quaternion(),size:2};
blocked.claw.position.set(0,3.7,0);assert(blocked.update(0,null,[obstacle]));
blocked.claw.position.set(0,1.8,0);assert.equal(blocked.update(1,obstacle,[obstacle]),false);assert(!blocked.gripping);noPenetration(blocked,[obstacle]);
const pileUrl=url((await compile("pile")).replace('"cannon-es"',JSON.stringify(import.meta.resolve("cannon-es"))).replace('"./config"',JSON.stringify(configUrl)));
const {createPile,hasClearGrabPoint,surfaceAt,boxTop}=await import(pileUrl);
for(const seed of [42,2026,17]) {
  const pile=createPile(seed), exposed=pile.filter(box=>hasClearGrabPoint(box,pile)), grippedIds=new Set();
  const high=Math.max(MACHINE.height-.90,Math.min(MACHINE.height-.25,Math.max(...pile.map(boxTop))+.78));
  for(const box of exposed) for(const aim of [box.grabPoint,box.center]) {
    const rig=createClaw(new THREE.Scene(),new THREE.MeshStandardMaterial());
    const low=(surfaceAt(aim,box)??box.grabPoint.y)+GRIP_CLEARANCE;
    rig.claw.position.set(THREE.MathUtils.clamp(aim.x,ARENA.minX,ARENA.maxX),high,THREE.MathUtils.clamp(aim.z,ARENA.minZ,ARENA.maxZ));
    rig.claw.position.set(0,high,0);assert(rig.update(0,null,pile));
    rig.claw.position.set(THREE.MathUtils.clamp(aim.x,ARENA.minX,ARENA.maxX),high,THREE.MathUtils.clamp(aim.z,ARENA.minZ,ARENA.maxZ));rig.update(0,null,pile);
    for(let step=1;step<=30;step++){rig.claw.position.y=THREE.MathUtils.lerp(high,low,step/30);rig.update(0,box,pile);}
    for(let step=1;step<=30;step++) rig.update(step/30,box,pile);
    if(rig.gripping) {
      grippedIds.add(box.id);
      const held={...box,center:new THREE.Vector3(box.center.x,box.center.y,box.center.z).sub(rig.claw.position)};
      const remaining=pile.filter(other=>other.id!==box.id), startY=rig.claw.position.y;
      for(let step=1;step<=20;step++) {rig.claw.position.y=THREE.MathUtils.lerp(startY,high,step/20);rig.update(1,held,remaining,true);assert(rig.gripping,"Real-pile lift preserves original pad contacts");}
      assert(Math.abs(rig.claw.position.y-high)<.01,"A physically gripped prize can lift clear of the real pile");
    }
    dispose(rig);
  }
  assert(grippedIds.size>0,"Single-hinge fingers must still allow physical pickups in a real pile");
  console.log("Pile seed "+seed+": "+grippedIds.size+" physically grippable exposed targets.");
}
const {createClawSwing,smoothGantryPosition,releaseWallOvershoot,MAX_SWING_ANGLE}=await import(url(await compile("clawSwing")));
// Regression for the actual input + smoothing chain: long outward holds must not
// require draining invisible input before the first inward frame can move.
const wallBounds=sliding.movementBounds;
for(const fps of [30,60,120]) for(const axis of ["x","z"]) for(const sign of [-1,1]) {
  const dt=1/fps, lo=axis==="x"?wallBounds.minX:wallBounds.minZ, hi=axis==="x"?wallBounds.maxX:wallBounds.maxZ;
  const logicalLo=axis==="x"?ARENA.minX:ARENA.minZ, logicalHi=axis==="x"?ARENA.maxX:ARENA.maxZ;
  let logical=0, visual=0;
  function tick(delta) {
    const next=releaseWallOvershoot(logical,logical+delta,visual,lo,hi);
    logical=THREE.MathUtils.clamp(next.target,logicalLo,logicalHi);visual=next.visual;
    visual=smoothGantryPosition(visual,logical,dt);
    return THREE.MathUtils.clamp(visual,lo,hi);
  }
  let before;
  for(let frame=0;frame<fps*3;frame++)before=tick(sign*1.55*dt);
  assert(Math.abs(before-(sign>0?hi:lo))<1e-9,"The test reaches the visible wall after an extended outward hold");
  const oldTarget=logical-sign*1.55*dt;
  const oldVisible=THREE.MathUtils.clamp(smoothGantryPosition(visual,oldTarget,dt),lo,hi);
  assert.equal(oldVisible,before,"The fixture reproduces the old invisible-overshoot dead zone");
  const after=tick(-sign*1.55*dt);
  assert(sign*(before-after)>1e-8,"The first inward frame must visibly move away from every glass wall");
  assert(Math.abs(before-after)<=1.55*dt,"Reversal discards hidden state without teleporting the visible claw");
  for(let frame=0;frame<fps/4;frame++) {
    const next=tick(-sign*1.55*dt);assert(sign*(after-next)>0,"Inward motion keeps progressing after release");
  }
}
const pointerWall=releaseWallOvershoot(wallBounds.maxX+.3,wallBounds.maxX+.28,wallBounds.maxX+.3,wallBounds.minX,wallBounds.maxX);
assert(Math.abs(pointerWall.target-(wallBounds.maxX-.02))<1e-9 && pointerWall.visual===wallBounds.maxX,"Small pointer reversals release a saturated wall immediately");
assert.deepEqual(releaseWallOvershoot(.5,.48,.4,0,1),{target:.48,visual:.4},"Normal smoothing inside the cabinet is unchanged");
assert.deepEqual(releaseWallOvershoot(1.3,1.28,.8,0,1),{target:1.28,visual:.8},"Reversal before visible wall contact cannot snap the claw to the wall");
assert.deepEqual(releaseWallOvershoot(1.3,1.3,1.2,0,1),{target:1.3,visual:1.2},"Zero or parallel input cannot change the other axis's logical aim");
console.log("PASS: held-key wall reversal responds on the first frame at 30/60/120 FPS; pointer release, no teleport and normal smoothing preserved.");
const sway = createClawSwing(0, 0);
let pose;
for (let i = 1; i <= 30; i++) pose = sway(i / 60, 0, 1 / 60);
pose = sway(.5, 0, 1 / 60);
assert(Math.abs(pose.x) > .001, "Claw continues swinging after the gantry stops");
let max = 0;
for (let i = 0; i < 360; i++) { pose = sway(.5, 0, 1 / 60); max = Math.max(max, Math.abs(pose.x)); }
assert(max <= MAX_SWING_ANGLE && Math.abs(pose.x) < .002, "Sway is bounded and damps out");
assert.deepEqual(sway(1, 1, 1 / 60, true), { x: 0, z: 0 }, "Reduced motion suppresses sway");
for (const fps of [30, 60, 120]) {
  const quickDrag = createClawSwing(0, 0); let visualX = 0; const angles = [];
  for (let frame = 0; frame < fps * 8; frame++) {
    visualX = smoothGantryPosition(visualX, frame < fps * .1 ? 0 : .65, 1 / fps);
    angles.push(quickDrag(visualX, 0, 1 / fps).x);
  }
  assert(Math.max(...angles.map(Math.abs)) > .10, "Quick pointer drag produces a visibly strong swing, rather than cancelling itself");
  assert(Math.abs(angles[Math.round(fps * .9)]) > .05, "Claw still visibly swings after aiming has stopped");
  assert(angles.some(angle => angle > .03) && angles.some(angle => angle < -.03), "Pendulum swings back in the opposite direction");
  assert(Math.abs(angles.at(-1)) < .001, "Motion eventually settles");
}
console.log("PASS: single-hinge curved steel fingers, frozen geometry, tip contacts, locked transport, continuous angular motion, glass sliding and reversal, aligned cable/carriage, corner sway, box collision stops, real-pile pickups and pendulum sway.");
