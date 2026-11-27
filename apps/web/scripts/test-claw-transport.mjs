import * as CANNON from "cannon-es";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import * as THREE from "three";
import ts from "typescript";
import { clawModule } from "./claw-test-loader.mjs";
const { createPile, settlePile, hasClearGrabArea, hasClearGrabPoint } = await import(await clawModule("pile"));
const { planPrizeGrip } = await import(await clawModule("prizeGrip"));
const { planPrizeTransport, prizeTransportPose, isPrizeOverBay, advanceDropClock } = await import(await clawModule("prizeTransport"));
const { settlePickup, containPrize } = await import(await clawModule("pickupPhysics"));
const { createClaw } = await import(await clawModule("createClaw"));
const { MACHINE } = await import(await clawModule("config"));
const { boxDropMotion, boxDeliveryHeight, restingBoxRotation } = await import(await clawModule("delivery"));
// Reproduce an escaped cube and fast impulses at every enclosure boundary.
for (const [x,y,z] of [[-9.33,.26,1.8],[9,2,0],[0,-2,0],[0,8,0],[0,2,-8],[-1,2,1]]) {
  const body=new CANNON.Body({mass:1,position:new CANNON.Vec3(x,y,z),shape:new CANNON.Box(new CANNON.Vec3(.24,.24,.24))});
  body.quaternion.setFromEuler(.4,.7,.2);body.velocity.set(100,-100,100);containPrize(body,.48);
  for(const a of [-1,1])for(const b of [-1,1])for(const c of [-1,1]) {const corner=body.quaternion.vmult(new CANNON.Vec3(a*.24,b*.24,c*.24)).vadd(body.position);
    assert(Math.abs(corner.x)<=MACHINE.width/2+.005 && Math.abs(corner.z)<=MACHINE.depth/2+.005 && corner.y>=MACHINE.floorY-.005 && corner.y<=MACHINE.height+.005,"Fast impulses cannot leave an uncollectable prize outside the glass/floor/roof");}
}
let tested = 0, directRoutes = 0, blocked = 0, simulated = 0, blockedFixture;
for (const seed of [42, 2026]) {
  let pile = createPile(seed);
  for (const count of [64, 36, 16]) {
    if (count !== 64) pile = settlePile(pile.slice(-count)).at(-1);
    const eligible = pile.filter(b => hasClearGrabPoint(b, pile) && hasClearGrabArea(b.grabPoint, b, pile));
    for (const box of eligible) {
      const contact = planPrizeGrip(box, pile, box.grabPoint); assert(contact);
      const transport = planPrizeTransport(box, contact), scene = new THREE.Scene(), rig = createClaw(scene, new THREE.MeshStandardMaterial());
      assert(transport.durationMs <= 1750, "Every route is faster than the old 2700ms carry");
      if (transport.keys.length === 3) { directRoutes++; assert.equal(transport.durationMs,1350); assert(transport.keys.every(k => k.position.x !== 0 || k.position.z !== 0), "Direct routes do not detour through the center"); }
      const prize = new THREE.Mesh(new THREE.BoxGeometry(box.size, box.size, box.size)); prize.position.set(box.center.x, box.center.y, box.center.z); prize.quaternion.set(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w); scene.add(prize);
      rig.presentGripPose(contact); rig.claw.attach(prize);
      // The old collision gate can reject movement while its independent delivery timer advances.
      rig.claw.position.y += .02;
      const wasBlocked = !rig.update(1, transport.box, pile.filter(b => b.id !== box.id), true);
      if (wasBlocked) { blockedFixture ??= {box, contact, pile}; blocked++; console.log("Old blocked grip", seed, count, box.id); }
      for (let elapsed = 0; elapsed <= transport.durationMs; elapsed += 25) {
        const pose = prizeTransportPose(transport, elapsed); rig.presentGripPose(pose);
        assert(rig.claw.position.distanceTo(pose.position) < 1e-7, "Glass projection must not pin a planned carrier pose");
        const world = prize.getWorldPosition(new THREE.Vector3()), rotation = prize.getWorldQuaternion(new THREE.Quaternion());
        for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
          const corner = new THREE.Vector3(x, y, z).multiplyScalar(box.size / 2).applyQuaternion(rotation).add(world);
          assert(Math.abs(corner.x) < MACHINE.width / 2 + .005 && Math.abs(corner.z) < MACHINE.depth / 2 + .005 && corner.y < MACHINE.height, JSON.stringify({seed,count,id:box.id,elapsed,corner:corner.toArray(),pose,box,transport}));
        }
      }
      const finalBox = { ...box, center: prize.getWorldPosition(new THREE.Vector3()), rotation: prize.getWorldQuaternion(new THREE.Quaternion()) };
      assert(isPrizeOverBay({...finalBox,rotation:restingBoxRotation(finalBox.rotation)}), "The landed box must fit the bay too");
      assert(isPrizeOverBay(finalBox), "Every winning route delivers the whole prize over the chute");
      assert(!isPrizeOverBay(box), "A box still in the pile cannot release as if delivered");
      const fall = boxDropMotion(finalBox.center.y, boxDeliveryHeight(finalBox.rotation), 1.45); assert(fall.done);
      if (wasBlocked || (simulated < 6 && (contact.neighboringContacts > 0 || box.center.y < 1))) {
        const remaining = pile.filter(b => b.id !== box.id), start = performance.now(), frames = settlePickup(remaining, transport);
        assert.deepEqual(frames[0].boxes, remaining); assert.equal(frames.at(-1).boxes.length, remaining.length);
        assert(frames.every((f,i) => !i || f.atMs > frames[i-1].atMs));
        for (const frame of frames) for (const b of frame.boxes) {
          assert([b.center.x,b.center.y,b.center.z,b.rotation.x,b.rotation.y,b.rotation.z,b.rotation.w].every(Number.isFinite));
          const q=new THREE.Quaternion(b.rotation.x,b.rotation.y,b.rotation.z,b.rotation.w);
          for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1]) {const p=new THREE.Vector3(x,y,z).multiplyScalar(b.size/2).applyQuaternion(q).add(new THREE.Vector3(b.center.x,b.center.y,b.center.z));
            assert(Math.abs(p.x)<=MACHINE.width/2+.006 && Math.abs(p.z)<=MACHINE.depth/2+.006 && p.y>=MACHINE.floorY-.006 && p.y<=MACHINE.height+.006,"Every neighboring prize stays wholly inside the enclosure throughout extraction");}
        }
        assert(frames.some(f => f.boxes.some((b,i) => Math.hypot(b.center.x-remaining[i].center.x,b.center.y-remaining[i].center.y,b.center.z-remaining[i].center.z) > .01)), "Neighboring boxes participate in the extraction physics");
        console.log("Extraction", seed, count, box.id, contact.neighboringContacts, "neighbor contacts;", Math.round(performance.now()-start), "ms"); simulated++;
      }
      prize.geometry.dispose(); tested++;
    }
  }
}
assert(tested > 40 && simulated > 0);
assert(directRoutes > tested * .8, "Most pickups go straight from lift to bay");
assert(blocked > 0, "Regression fixture reproduces the old movement gate stopping a locked winner");
assert.equal(advanceDropClock(1500, 60, 1), 1550, "Long frames cannot skip the pickup and delivery stages");
assert.equal(advanceDropClock(1500, 0, 1), 1500, "Paused/hidden time cannot advance a drop");
const source = await readFile(new URL("../components/claw/createMachine.ts",import.meta.url),"utf8"), ast = ts.createSourceFile("machine.ts", source, ts.ScriptTarget.Latest, true);
let finish; function visit(n) { if(ts.isFunctionDeclaration(n) && n.name?.text === "finish") finish=n; ts.forEachChild(n,visit); } visit(ast);
const code = ts.transpileModule(finish.getText(ast), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
for (const state of [{landed:false,held:true,frames:false},{landed:true,held:true,frames:false},{landed:true,held:false,frames:true},{landed:true,held:false,frames:false}]) {
  const claw={}, picked={parent:state.held ? claw : {},position:{y:0},visible:true}; let completions=0, reveals=0;
  const context={result:{success:true,targetId:"won"},landed:state.landed,picked,claw,pickupFrames:state.frames ? [] : null,boxes:[{id:"won"},{id:"other"}],deliveryY:-.38,
    scene:{attach(){}},cabinet:{showResult(){reveals++;}},mode:"animating",dx:0,dz:0,pull:{},gripPlan:{},gripOrigin:{},onComplete(){completions++;}};
  runInNewContext(code+"\nfinish();",context);
  const ready=state.landed && !state.held && !state.frames;
  assert.equal(completions,Number(ready));assert.equal(reveals,Number(ready));assert.equal(picked.visible,!ready,"Prize cannot disappear before visible delivery and landing");
}
// Execute the actual engine's winning-phase and rig movement blocks, not a mirrored animation.
let animationNode; function findAnimation(n) { if(ts.isIfStatement(n) && n.expression.getText(ast) === 'mode === "animating"' && n.thenStatement.getText(ast).includes('const t = dropElapsed')) animationNode=n; ts.forEachChild(n,findAnimation); } findAnimation(ast);assert(animationNode);
const motionSource=source.slice(source.indexOf('    const traveling ='),source.indexOf('    if (mode === "idle" && now - lastAimReport'));
const motionCode=ts.transpileModule(animationNode.getText(ast)+'\n'+motionSource,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
for (const [timeScale, frameDt] of [[1, .025], [.22, 1/60], [.22, 1/30], [.22, .05]]) {
const {box,contact,pile}=blockedFixture, transport=planPrizeTransport(box,contact), scene=new THREE.Scene(), rig=createClaw(scene,new THREE.MeshStandardMaterial());
const prize=new THREE.Mesh(new THREE.BoxGeometry(box.size,box.size,box.size));prize.position.set(box.center.x,box.center.y,box.center.z);prize.quaternion.set(box.rotation.x,box.rotation.y,box.rotation.z,box.rotation.w);scene.add(prize);rig.presentGripPose(contact);rig.claw.attach(prize);
let completion=0,highest=box.center.y,impact=0;
const c={THREE,prizeTransportPose,isPrizeOverBay,boxDropMotion,boxDeliveryHeight,restingBoxRotation,clawModel:rig,claw:rig.claw,picked:prize,scene,
 transport,gripPlan:contact,gripOrigin:null,drawRequested:true,result:{success:true,targetId:box.id},pull:{target:{box}},mode:"animating",dropElapsed:1550,dropStart:0,landed:false,pickupFrames:null,
 x:0,z:0,cx:0,cy:3.3,cz:0,closed:0,grabHeight:box.grabPoint.y,lowY:contact.position.y,clawRestY:3.3,ropeTopY:4.06,
 guidedPose:null,presentationYaw:new THREE.Quaternion(),releasedRotation:new THREE.Quaternion(),restingRotation:new THREE.Quaternion(),releaseY:0,releaseFloorY:0,releaseStarted:0,dropImpacted:false,deliveryY:-.38,
 dt:frameDt,now:0,reducedMotion:{matches:false},speedFactor:()=>timeScale,swing:()=>({x:0,z:0}),ease:(t)=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);},phase(){},dx:0,dz:0,boxes:pile.filter(b=>b.id!==box.id),
 visibleBoxPoses:()=>[],currentGripBox:()=>prize.parent===rig.claw ? transport.box : null,onImpact(){impact++;},
 cabinet:{showResult(){assert(c.landed);assert(isPrizeOverBay({...box,center:prize.getWorldPosition(new THREE.Vector3()),rotation:prize.getWorldQuaternion(new THREE.Quaternion())}));}},onComplete(){completion++;},requestDraw(){throw new Error("No second draw during delivery");}};
runInNewContext(code+'\nglobalThis.finish=finish;',c);
for(let frame=0;frame<400;frame++) {c.dropElapsed=advanceDropClock(c.dropElapsed,frameDt,timeScale);c.now+=frameDt*1000;c.guidedPose=null;c.presentationYaw=new THREE.Quaternion();runInNewContext("{\n"+motionCode+"\n}",c);highest=Math.max(highest,prize.getWorldPosition(new THREE.Vector3()).y);if(completion)break;}
assert(highest>box.center.y+.75,"Winning box visibly lifts above the blocked position");assert.equal(impact,1);assert.equal(completion,1);assert.equal(prize.visible,false);assert.equal(c.mode,"idle");
}
console.log("PASS:",tested,"full/depleted-pile routes;",directRoutes,"direct routes;",blocked,"old blocked-grip cases; coupled extraction, whole-box bay clearance, landing/reveal gate and paused-frame clock.");
