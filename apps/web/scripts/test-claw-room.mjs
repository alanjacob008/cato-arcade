import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";
import ts from "typescript";
import * as THREE from "three";
import {clawModule} from "./claw-test-loader.mjs";
const context={font:"",fillText(){},measureText(text){return {width:text.length*40,actualBoundingBoxAscent:64,actualBoundingBoxDescent:0};}};
globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>context})};
globalThis.Image=class {set src(value){this.currentSrc=value;queueMicrotask(()=>this.onload());}};
const {loadPrizeLogo}=await import(await clawModule("prizeModel"));await loadPrizeLogo();
const {createCasinoRoom,stationSignY,REAR_WALL_FRONT_Z,NEON_SIGN_Y,NEON_SIGN_Z,NEON_SIGN_WIDTH,NEON_SIGN_HEIGHT,NEON_SIGN_TUBES}=await import(await clawModule("casinoRoom"));
const {STATION_X:ROW}=await import(await clawModule("arcadeLayout"));
const {createPavement,loadPavementTexture}=await import(await clawModule("pavementScene"));
const {MACHINE}=await import(await clawModule("config"));
const scene=new THREE.Scene();createCasinoRoom(scene);const floor=createPavement(scene);
scene.updateMatrixWorld(true);
const wall=scene.getObjectByName("Plain rear wall"),wallBox=new THREE.Box3().setFromObject(wall);
assert(wall.material.isMeshPhysicalMaterial&&wall.material.envMapIntensity===0&&wall.material.specularIntensity===0&&wall.material.clearcoat===0,"Rear wall cannot reflect a bright off-center studio softbox or direct-light hotspot");
let roomLights=0;scene.getObjectByName("CATO Casino Club lounge").traverse(object=>{if(object.isLight)roomLights++;});assert.equal(roomLights,0,"No colored point-light dots remain on the wall");
const roomMeshes=[];scene.getObjectByName("CATO Casino Club lounge").traverse(object=>{if(object.isMesh)roomMeshes.push(object.name);});
assert.deepEqual(roomMeshes.sort(),[...ROW.map(()=>"Lit neon tubes"),"Plain rear wall",...ROW.map(()=>"Station haze cone"),...ROW.map(()=>"Unlit neon tubes")],"One continuous wall, and a neon sign and a haze cone per station; no other obstructions");
assert(wallBox.min.x<=-200&&wallBox.max.x>=200,"Black wall extends far beyond both ends of the three-machine row");
assert.equal(scene.getObjectByName("Original full-color CATO sign logo"),undefined,"The sign is procedural neon, never an image logo");
const neonSigns=[];scene.traverse(object=>{if(object.name==="CATO ARCADE neon sign")neonSigns.push(object);});
assert.deepEqual(neonSigns.map(sign=>sign.getWorldPosition(new THREE.Vector3()).x),[...ROW],"A sign hangs centred over every station");
for(const sign of neonSigns){const at=sign.getWorldPosition(new THREE.Vector3());assert(at.y>MACHINE.height+1&&at.z>REAR_WALL_FRONT_Z&&at.z<REAR_WALL_FRONT_Z+.2,"Each neon hangs on the wall above its machine");}
const signMeshes=neonSigns.flatMap(sign=>sign.children);
assert.equal(new Set(signMeshes.map(mesh=>mesh.geometry)).size,1,"Every sign shares one plane");
assert.equal(new Set(signMeshes.map(mesh=>mesh.material.map)).size,2,"Every sign shares the lit and unlit canvas textures");
assert.equal(new Set(signMeshes.filter(mesh=>mesh.name==="Lit neon tubes").map(mesh=>mesh.material)).size,ROW.length,"Each sign keeps its own lit layer so it can power on in turn");
const wallShader={uniforms:{},vertexShader:"#include <worldpos_vertex>",fragmentShader:"#include <emissivemap_fragment>"};wall.material.onBeforeCompile(wallShader);
assert(wallShader.fragmentShader.includes("catoStationPool")&&ROW.every((x,i)=>wallShader.fragmentShader.includes(`catoSignLight[${i}]`)),"Warm pools and one lobe of each sign's light fall on the slats");
assert(!/186,154,255|ba9aff|a853ff/i.test(wallShader.fragmentShader),"No purple wall pools remain");
const {neonPowerLevel,NEON_POWER_ON_MS}=await import(await clawModule("neonSign"));
let dips=0,lit=false;for(let t=0;t<=NEON_POWER_ON_MS;t+=5){const on=neonPowerLevel(t)>.3;if(lit&&!on)dips++;lit=on;}
assert(dips>=2&&dips<=3,"Power-on is two or three quick flickers");assert.equal(neonPowerLevel(NEON_POWER_ON_MS),1);assert.equal(neonPowerLevel(5000),1,"Then a steady glow");
assert.equal(neonPowerLevel(0,true),1,"Reduced motion: steady at once");assert.equal(neonPowerLevel(-10),0,"Dark before power-on");
const {NEON_STAGGER_MS}=await import(await clawModule("neonSign"));assert(NEON_STAGGER_MS>=120&&NEON_STAGGER_MS<=180,"Signs light 120 to 180 ms apart");
const room=scene.getObjectByName("CATO Casino Club lounge"),levels=()=>room.signs.map(sign=>sign.level);room.update(0,false);assert.deepEqual(levels(),ROW.map(()=>0),"Signs wait for the scene to be ready");
const byX=[...ROW.keys()].sort((a,b)=>ROW[a]-ROW[b]);
room.powerOn(100,false);
byX.forEach((index,step)=>{room.update(100+step*NEON_STAGGER_MS+10,false);const now=levels();assert(now[index]>0&&now[index]<1,"The next sign down the row flickers on");byX.slice(step+1).forEach(later=>assert.equal(now[later],0,"Later signs are still dark"));});
room.update(100+(ROW.length-1)*NEON_STAGGER_MS+NEON_POWER_ON_MS+10,false);assert.deepEqual(levels(),ROW.map(()=>1),"Then every sign glows steadily");
// From the right-hand station the player's own sign lights first, then the others down the row.
const fromRight=createCasinoRoom(new THREE.Scene());fromRight.powerOn(0,false,ROW.at(-1));
const order=[...ROW.keys()].sort((a,b)=>Math.abs(ROW[a]-ROW.at(-1))-Math.abs(ROW[b]-ROW.at(-1)));
order.forEach((index,step)=>{fromRight.update(step*NEON_STAGGER_MS+10,false);assert(fromRight.signs[index].level>0,"The next sign from the player's station flickers on");order.slice(step+1).forEach(later=>assert.equal(fromRight.signs[later].level,0,"Signs further down the row are still dark"));});
const reducedRoom=new THREE.Scene(),quiet=createCasinoRoom(reducedRoom);quiet.powerOn(0,true);quiet.update(1,true);assert.deepEqual(quiet.signs.map(sign=>sign.level),ROW.map(()=>1),"Reduced motion: every sign steady at once");
quiet.setSignHeight(7.2);assert(quiet.signs.every(sign=>sign.group.position.y===7.2),"Signs can be lifted clear of a small frame");
const primed=createCasinoRoom(new THREE.Scene()),litLayers=()=>primed.signs.map(sign=>sign.glow.visible);primed.update(0,false);
assert.deepEqual(litLayers(),ROW.map(()=>false),"A dark sign skips its lit layer");
primed.primeSigns();assert.deepEqual(litLayers(),ROW.map(()=>true));
assert(primed.signs.every(sign=>sign.glowMaterial.opacity===0&&sign.glow.frustumCulled===false),"The startup render draws every lit layer once, at zero opacity, in every pass");
primed.update(16,false);assert.deepEqual(litLayers(),ROW.map(()=>false),"and the next update hides them again");
quiet.setTopView(true);let hazeShown=0;reducedRoom.traverse(object=>{if(object.name==="Station haze cone"&&object.visible)hazeShown++;});assert.equal(hazeShown,0,"Haze never fogs the top view");
assert(Math.abs(wallBox.max.z-REAR_WALL_FRONT_Z)<1e-6);
assert(Math.abs((-MACHINE.depth/2-.20)-wallBox.max.z-.15)<1e-6,"Cabinet rear frame sits 0.15 from the wall without changing gameplay coordinates");
const material=floor.material;assert.equal(material.color.getHexString(),"000000");assert(material.clearcoat>.9&&material.roughness<.2);assert.equal(material.map,null);
const shader={uniforms:{},vertexShader:"#include <worldpos_vertex>",fragmentShader:"#include <emissivemap_fragment>\n#include <opaque_fragment>"};material.onBeforeCompile(shader);
assert(!/grid/i.test(shader.fragmentShader),"The floor draws no grid lines");assert(shader.vertexShader.includes("catoFloorPosition"));
assert.strictEqual(shader.uniforms.catoPoolColor.value,floor.poolColor,"Warm station pools share one colour");
const [pr,pg,pb]=floor.poolColor.toArray();assert(pr>pg&&pg>pb,"Floor pools are warm amber, not blue");assert.equal(floor.update,undefined,"Nothing animates on the floor");
assert(shader.fragmentShader.includes("glassFresnel")&&shader.uniforms.catoReflection,"The polished floor has an actual reflected scene texture");
assert(shader.fragmentShader.includes("catoNear"),"Under each machine the stone is glossier and its reflection warmer");
const {createReflectionBudget}=await import(await clawModule("reflectionBudget"));
for(const [moving,limit]of [[false,2],[true,10]]){const budget=createReflectionBudget();let count=0;for(let frame=0;frame<60;frame++)count+=Number(budget.capture(frame*1000/60,moving));assert(count<=limit);budget.invalidate();assert(budget.capture(1001,moving));}
const savedTarget={},restoredTargets=[],renderer={getRenderTarget:()=>savedTarget,setRenderTarget:target=>restoredTargets.push(target),xr:{enabled:true},shadowMap:{autoUpdate:true}};
const camera=new THREE.PerspectiveCamera(36,1,.1,500);camera.position.set(3,6,8);camera.lookAt(0,0,0);camera.updateMatrixWorld();
// An unsupported renderer must leave gameplay rendering intact and disable the reflection.
floor.captureReflection(renderer,camera,0,false);
assert.equal(floor.visible,true);assert.equal(renderer.xr.enabled,true);assert.equal(renderer.shadowMap.autoUpdate,true);
assert.strictEqual(restoredTargets.at(-1),savedTarget);assert.equal(shader.uniforms.catoReflectionReady.value,0);
const targetChanges=restoredTargets.length;
floor.captureReflection(renderer,camera,1000,false);assert.equal(restoredTargets.length,targetChanges,"Failed reflection is not retried every frame");
floor.disposeReflection();
const luminous=[];scene.traverse(object=>{if(object.isMesh&&object.material.isMeshBasicMaterial&&!object.material.map)luminous.push(object);});
assert(luminous.every(mesh=>mesh.getWorldPosition(new THREE.Vector3()).z>REAR_WALL_FRONT_Z+.3),"No RGB strips remain on the plain rear wall");
const tasks=[];await loadPavementTexture(task=>tasks.push(task));assert.deepEqual(tasks,["diffuse","normal","arm"]);
const {createCabinet}=await import(await clawModule("createCabinet"));
const cabinetScene=new THREE.Scene(),cabinet=createCabinet(cabinetScene),fill=cabinetScene.getObjectByName("Cabinet interior fill");
const {ledMatrix,LED_COLUMNS,LED_ROWS,LED_AMBER}=await import(await clawModule("machineTypography"));
const marqueeBoard=cabinetScene.getObjectByName("LED marquee");
assert(marqueeBoard&&marqueeBoard.userData.color===LED_AMBER&&marqueeBoard.material.toneMapped===false,"The marquee is an amber LED board, lit at its own colour");
for(const message of ["CLAW MACHINE","INSERT TOKEN","GOOD LUCK","HOLD TIGHT","PRIZE TIME","YOU WON!","NEXT TIME"]){
 const {lit,width}=ledMatrix(message);assert(width<=LED_COLUMNS-4,`"${message}" fits the LED board with dark LEDs either side`);
 assert(lit[0].every(on=>!on)&&lit[LED_ROWS-1].every(on=>!on)&&lit.flat().filter(Boolean).length>20,`"${message}" is lit on the board's middle seven rows`);
}
const spill=cabinetScene.getObjectByName("Marquee spill");
assert.equal(spill,undefined,"No front-facing marquee lamp can reflect a bright spot across the LED message");
const board=cabinetScene.getObjectByName("CATO arcade cabinet").children.find(mesh=>mesh.material?.name==="LED marquee board")??marqueeBoard.parent.children.find(mesh=>mesh.material?.name==="LED marquee board");
assert(board&&board.material.roughness>=.8&&board.material.metalness===0,"The LED backing is matte rather than a shiny reflector");
const cabinetMaterials=new Set();cabinetScene.traverse(object=>{if(object.isMesh)cabinetMaterials.add(object.material);});
const roofPane=[...cabinetMaterials].find(material=>material.name==="Roof glass");
assert(roofPane&&roofPane.clearcoat===0&&roofPane.specularIntensity<.2,"The roof pane no longer mirrors the studio's overhead softbox as a white blob in the top view");
const steelHardware=[...cabinetMaterials].find(material=>material.name==="Brushed stainless steel cabinet hardware");
const rimShader={uniforms:{},vertexShader:"#include <project_vertex>",fragmentShader:"#include <lights_fragment_begin>"};steelHardware.onBeforeCompile(rimShader,null);
const [rimR,rimG,rimB]=rimShader.uniforms.catoRimColor.value.toArray();
assert(/normal\.x/.test(rimShader.fragmentShader)&&rimG>rimR&&rimB>rimR&&Math.max(rimR,rimG,rimB)<.6,"A faint mint-teal rim catches only the cabinet's right-hand edges");
const violet=color=>{const hsl={};color.getHSL(hsl);return hsl.s>.2&&hsl.h>250/360&&hsl.h<300/360;};
cabinetScene.traverse(object=>{if(object.isLight)assert(!violet(object.color),`${object.name||object.type} has no violet cast`);});
for(const material of cabinetMaterials)for(const key of ["color","emissive"])if(material[key]?.isColor)assert(!violet(material[key]),`${material.name||material.type} ${key} is not violet`);
const neon=[];cabinetScene.traverse(object=>{if(object.isMesh&&object.material.name==="Solana neon trim")neon.push(object.material);});
assert.equal(fill.intensity,.06,"Interior fill starts dim before a token is inserted");
assert(neon.length>0&&neon.every(material=>material.emissiveIntensity===.08),"Standby neon stays dim");
cabinet.setPowered(true);for(let frame=0;frame<60;frame++)cabinet.updateLighting(frame*1000/60,1/60,false);
assert(fill.intensity>.54&&fill.intensity<=.55&&neon.every(material=>material.emissiveIntensity>1.14),"Token power smoothly raises the softer cabinet lights");
cabinet.showResult(true);const feedbackAt=performance.now();cabinet.updateLighting(feedbackAt+200,1/60,true);assert(fill.intensity>.54,"Result keeps the cabinet lit");
for(let frame=0;frame<150;frame++)cabinet.updateLighting(feedbackAt+2100+frame*1000/60,1/60,false);
assert(fill.intensity<.061&&neon.every(material=>material.emissiveIntensity<.081),"Cabinet returns to dim standby after the result");
cabinet.setConnected(true);for(let frame=0;frame<60;frame++)cabinet.updateLighting(feedbackAt+6000+frame*1000/60,1/60,true);
assert(fill.intensity>.54,"Wallet connection powers the cabinet without inserting a token");
cabinet.showResult(false);for(let frame=0;frame<150;frame++)cabinet.updateLighting(performance.now()+3000+frame*1000/60,1/60,true);
assert(fill.intensity>.54,"A connected cabinet stays on after result feedback");
cabinet.setConnected(false);for(let frame=0;frame<100;frame++)cabinet.updateLighting(performance.now()+7000+frame*1000/60,1/60,true);
assert(fill.intensity<.061,"Disconnecting returns to dim standby");
cabinet.setConnected(true);const firstLight=cabinet.updateLighting(performance.now()+8000,1/60,false);
assert(firstLight>0&&firstLight<.1,"Wallet lights start with a visible low level, not an instant jump");
for(let frame=0;frame<120;frame++)cabinet.updateLighting(performance.now()+9000+frame*1000/60,1/60,false);
assert(fill.intensity>.54,"Visible wallet-light fade reaches its softer brightness");
const left=cabinetScene.getObjectByName("Front left feedback tube"),right=cabinetScene.getObjectByName("Front right feedback tube");
assert(left&&right&&left.position.z===right.position.z&&left.position.z>MACHINE.depth/2+.1,"Both feedback tubes are in front of the glazing and cannot be hidden behind the front posts");
const rearLeft=cabinetScene.getObjectByName("Rear left feedback tube"),rearRight=cabinetScene.getObjectByName("Rear right feedback tube");
assert(rearLeft&&rearRight&&rearLeft.position.x===-rearRight.position.x&&rearLeft.position.z===rearRight.position.z,"Rear corners have matching symmetric light tubes");
const tubes=[];cabinetScene.traverse(object=>{if(object.name.endsWith("feedback tube"))tubes.push(object);});assert.equal(tubes.length,4);
assert(tubes.every(tube=>tube.material===left.material),"All four tubes share the same feedback color and timing");
cabinet.showResult(true);cabinet.updateLighting(performance.now()+125,1/60,true);assert(left.material.color.g>left.material.color.r&&left.material.color.g>left.material.color.b);
cabinet.showResult(false);cabinet.updateLighting(performance.now()+125,1/60,true);assert(left.material.color.r>left.material.color.g&&left.material.color.r>left.material.color.b);
assert.equal(fill.position.x,0);assert.equal(fill.position.z,0,"Chamber lighting is centered in both axes");
const lining=["Rear","Left","Right"].map(side=>cabinetScene.getObjectByName(`${side} chamber lining`));assert(lining.every(Boolean));
assert(lining.every(panel=>panel.material===lining[0].material),"All three inner panels use the exact same material object and feedback settings");
assert.equal(lining[1].position.x,-lining[2].position.x);assert.deepEqual(lining[1].geometry.attributes.position.array,lining[2].geometry.attributes.position.array,"Side linings have identical mirrored coverage");
assert.equal(cabinetScene.getObjectByName("Right glass feedback wash"),undefined,"No separate right-side overlay remains");
for(const success of [true,false]){cabinet.showResult(success);cabinet.updateLighting(performance.now()+125,1/60,true);assert(lining[0].material.emissiveIntensity>0);assert(success?lining[0].material.emissive.g>lining[0].material.emissive.r:lining[0].material.emissive.r>lining[0].material.emissive.g,"All chamber panels share the result pulse");}
cabinet.updateLighting(performance.now()+3000,1/60,true);assert.equal(lining[0].material.emissiveIntensity,0,"Every lining clears its result emission together");
for(const name of ["Cabinet interior fill","Centered chamber light"]){const lamp=cabinetScene.getObjectByName(name);assert.equal(lamp.color.getHexString(),"ffac55","Chamber lamps stay orange");assert(lamp.intensity<=.55,"Chamber lighting is capped below the previous hot-white level");}
const {createArcadeStations,STATION_X}=await import(await clawModule("arcadeStations"));
const world=new THREE.Scene(),sample={id:"sample",color:"#f5f1fa",center:{x:0,y:1,z:0},rotation:{x:0,y:0,z:0,w:1},size:MACHINE.boxSize};
const displays=createArcadeStations(world,new THREE.BoxGeometry(.5,.5,.5),[sample],[sample],()=>[new THREE.MeshStandardMaterial()],new THREE.MeshStandardMaterial(),3.5);
assert.deepEqual(displays.stations.map(station=>station.root.position.x),[...STATION_X]);
const overhead=world.children.filter(object=>object.isSpotLight);assert.equal(overhead.length,3);
assert.deepEqual(overhead.map(light=>light.position.x),[...STATION_X]);assert.deepEqual(overhead.map(light=>light.target.position.x),[...STATION_X]);
assert(overhead.every(light=>light.penumbra===1&&!light.castShadow),"Each machine has a centered soft cone without another shadow pass");
displays.setConnected(true);for(let frame=0;frame<100;frame++)displays.update(frame*1000/60,1/60,true);assert(overhead.every(light=>light.intensity>21.9&&light.intensity<=22&&light.color.getHexString()==="ffba70"));
for(const [tier,station]of displays.stations.entries()){
 let meshes=0,lights=0;const finishes=[];station.root.traverse(object=>{if(object.isMesh&&object.parent!==station.prizes.proxies){meshes++;const finish=object.material.userData?.finishTier;if(finish)finishes.push(finish.value);}if(object.isLight)lights++;});
 assert(meshes<40,"Inactive cabinet geometry is batched rather than rendered as hundreds of parts");assert.equal(lights,0,"Inactive cabinets add no point-light shader cost");assert(finishes.length&&finishes.every(finish=>finish===tier));
}
for(const tier of [0,2,1]){displays.select(tier);assert.deepEqual(displays.stations.map(station=>station.root.visible),[0,1,2].map(index=>index!==tier));}
displays.sync([]);assert(displays.stations.every(station=>station.prizes.meshes.every(mesh=>mesh.count===0)),"Display piles mirror the authoritative visible inventory");displays.dispose();
const {createClaw}=await import(await clawModule("createClaw"));
for(const offset of STATION_X){
 const localRoot=new THREE.Scene(),shiftedRoot=new THREE.Scene();shiftedRoot.position.x=offset;shiftedRoot.updateMatrixWorld(true);
 const local=createClaw(localRoot,new THREE.MeshStandardMaterial()),shifted=createClaw(shiftedRoot,new THREE.MeshStandardMaterial());
 const obstacle={id:"obstacle",center:{x:.1,y:2.7,z:.1},rotation:new THREE.Quaternion(),size:.6};
 for(let step=0;step<=20;step++)for(const claw of [local,shifted]){
   claw.claw.position.set(.1,3.5,.1);claw.update(step/20,obstacle,[obstacle]);
 }
 assert.deepEqual(shifted.snapshotPose().angles,local.snapshotPose().angles,"Station translations cannot alter rigid-finger collision or grip angles");
 assert.deepEqual(shifted.claw.position.toArray(),local.claw.position.toArray());
}
const {marqueeChase,MARQUEE_LAP_MS,MARQUEE_BASE_GLOW}=await import(await clawModule("marqueeChase"));
assert(MARQUEE_BASE_GLOW>=.35&&MARQUEE_BASE_GLOW<=.45);assert.equal(marqueeChase(0,0,7,"waiting"),1,"The chase peaks at full glow");
for(let t=0;t<MARQUEE_LAP_MS;t+=25){const glow=[0,1,2,3,4,5,6].map(i=>marqueeChase(t,i,7,"waiting"));assert(Math.min(...glow)>=.35&&Math.min(...glow)<=.45&&Math.max(...glow)>=.6,"Every bulb keeps a warm base glow while the chase runs on top of it");}
assert.equal(MARQUEE_LAP_MS,1200);const peak=t=>[0,1,2,3,4,5,6].reduce((best,i)=>marqueeChase(t,i,7,"waiting")>marqueeChase(t,best,7,"waiting")?i:best,0);
assert.notEqual(peak(0),peak(MARQUEE_LAP_MS/2),"The bulbs chase while the machine waits");assert.equal(peak(0),peak(MARQUEE_LAP_MS),"One lap every 1.2 s");
assert([0,1,2,3,4,5,6].every(i=>marqueeChase(321,i,7,"playing")===1),"Bulbs settle during a play");
assert([0,1,2,3,4,5,6].every(i=>marqueeChase(i*977,i,7,"resting")===marqueeChase(0,0,7,"resting")),"Bulbs rest under reduced motion");
const {establishingShot,introEase,settleEase,INTRO_DURATION_MS,applyIntroFlight,lookRotation,ESTABLISHING_MAX_DISTANCE,SIGN_POWER_DELAY_MS}=await import(await clawModule("introCamera"));
assert(INTRO_DURATION_MS>=2000&&INTRO_DURATION_MS<=3000);assert.equal(introEase(0),0);assert.equal(introEase(1),1);assert.equal(settleEase(1),1);
for(let t=0;t<1;t+=.01){assert(introEase(t+.01)>=introEase(t)&&introEase(t)<=1,"Fly-in eases without overshoot");}
const {frameCabinet}=await import(await clawModule("cameraFraming"));
const machinePoints=x=>[-1.7,1.7].flatMap(dx=>[-1.6,5].flatMap(y=>[-1.4,2.1].map(z=>new THREE.Vector3(x+dx,y,z))));
// The tubes sit in the middle of the sign; only the soft glow reaches the mesh's edges.
const tubePoints=(x,y)=>[-1,1].flatMap(sx=>[-1,1].map(sy=>new THREE.Vector3(x+sx*NEON_SIGN_TUBES.width/2,y+sy*NEON_SIGN_TUBES.height/2,NEON_SIGN_Z)));
const signPlane=(x,y)=>[-1,1].flatMap(sx=>[-1,1].map(sy=>new THREE.Vector3(x+sx*NEON_SIGN_WIDTH/2,y+sy*NEON_SIGN_HEIGHT/2,NEON_SIGN_Z)));
const shotCamera=(aspect,pose)=>{const camera=new THREE.PerspectiveCamera(36,aspect,.1,500);camera.position.copy(pose.position);camera.lookAt(pose.target);camera.updateMatrixWorld();return camera;};
const inFrame=(camera,points)=>points.every(point=>{const p=point.clone().project(camera);return Math.abs(p.x)<1&&Math.abs(p.y)<1;});
const outOfFrame=(camera,points)=>{const projected=points.map(point=>point.clone().project(camera));return projected.every(p=>p.x>1)||projected.every(p=>p.x<-1)||projected.every(p=>p.y>1);};
assert(ESTABLISHING_MAX_DISTANCE<35,"The opening shot never stands inside the fog, which starts at 35");
// Stage sizes of the arcade at 1440x900, 1920x1080 and on a 390x844 phone.
for(const [label,width,height]of [["1440x900",990,782],["1920x1080",1328,962],["390x844",374,330],["narrow desktop stage",560,990]])for(const station of STATION_X){
 const landing=new THREE.PerspectiveCamera(36,width/height,.1,500);frameCabinet(landing,width/height,false);landing.position.x+=station;landing.updateMatrixWorld();
 const signY=stationSignY(landing,width,height);
 assert.equal(signY,NEON_SIGN_Y,"The larger neon remains fixed on the wall; close-up cropping is intentional");
 const shot=establishingShot(width/height,36,station,signY+NEON_SIGN_HEIGHT/2,NEON_SIGN_TUBES.width/2),open=shotCamera(width/height,shot);
 assert(shot.position.x===station&&shot.target.x===station,`${label}: a straight push-in on the player's own machine, never a sideways sweep`);
 assert(shot.position.y>landing.position.y&&shot.position.z>landing.position.z+4,`${label}: it starts higher and further back`);
 assert(shot.position.distanceTo(shot.target)<=ESTABLISHING_MAX_DISTANCE+1e-9,`${label}: in front of the fog`);
 assert(inFrame(open,[...machinePoints(station),...tubePoints(station,signY)]),`${label}: the opening shot holds the machine and its sign whole`);
 assert(new THREE.Vector3(station,MACHINE.height+12,.15).project(open).y>1,`${label}: the raised haze fixture is above the standby frame`);
 for(const other of STATION_X.filter(x=>x!==station))assert(outOfFrame(open,machinePoints(other)),`${label}: a neighbouring machine is never cut at the frame's edge`);
 const flight={started:0,duration:INTRO_DURATION_MS,ease:introEase,from:{position:shot.position,quaternion:lookRotation(shot.position,shot.target)},to:{position:landing.position.clone(),quaternion:landing.quaternion.clone()}};
 const flying=new THREE.PerspectiveCamera(36,width/height,.1,500);
 for(const t of [.2,.5,.8]){assert.equal(applyIntroFlight(flying,flight,t*INTRO_DURATION_MS),false);assert(Math.abs(flying.position.x-station)<1e-9,"The camera dollies straight in");}
 assert.equal(applyIntroFlight(flying,flight,INTRO_DURATION_MS),true);
 assert(flying.position.distanceTo(landing.position)<1e-9&&flying.quaternion.angleTo(landing.quaternion)<1e-6,`${label}: the push-in lands exactly on the station framing`);
}
// The fly-in's clock. The startup render compiles shaders and builds the scene; in a production build that one frame
// took 6.2 s, so a flight timed from the frame before it had landed before anything was painted.
const {createIntroDirector,ARCADE_REVEAL_EVENT,INTRO_REVEAL_FALLBACK_MS,INTRO_MAX_FRAME_GAP_MS,INTRO_SETTLE_MS}=await import(await clawModule("introCamera"));
assert.equal(ARCADE_REVEAL_EVENT,"cato:arcade-reveal");assert.equal(INTRO_REVEAL_FALLBACK_MS,4000);assert(INTRO_MAX_FRAME_GAP_MS>=80&&INTRO_MAX_FRAME_GAP_MS<=120);
const opening={position:new THREE.Vector3(0,9,28),quaternion:new THREE.Quaternion().setFromEuler(new THREE.Euler(-.25,0,0))},landingPose={position:new THREE.Vector3(0,3,12),quaternion:new THREE.Quaternion()};
const travelled=camera=>(opening.position.z-camera.position.z)/(opening.position.z-landingPose.position.z);
const director=()=>{const camera=new THREE.PerspectiveCamera(),intro=createIntroDirector(camera);assert.equal(intro.state,"pending");return {camera,intro};};
const flyOut=(intro,from,limit=30000)=>{let t=from;while(intro.state==="flying"&&t<from+limit){t+=1000/60;intro.frame(t,true);}return t;};
{
 const {camera,intro}=director();
 assert.equal(intro.hold(opening,landingPose),true);assert.equal(intro.state,"holding");assert(camera.position.equals(opening.position),"The first ready frame shows the opening shot");
 intro.reveal();assert.equal(intro.frame(1000,true),false,"A cue that comes before the startup render has finished never starts the clock");
 intro.rendered(7200);
 assert.equal(intro.frame(7217,true),true);assert.equal(intro.state,"flying");assert.equal(intro.flight.started,7217,"The clock starts on the first frame after the startup render");
 assert(camera.position.distanceTo(opening.position)<1e-9,"from the opening shot");
 let t=7217,previous=0;while(intro.state==="flying"&&t<20000){t+=1000/60;intro.frame(t,true);const now=travelled(camera);assert(now>=previous&&now-previous<.03,"The camera moves in a little each frame, never jumping ahead");previous=now;}
 assert.equal(intro.state,"done");assert(t>=7217+INTRO_DURATION_MS,"A 6.2 s first frame never skips the flight: all 2.5 s of it play");
 assert(camera.position.distanceTo(landingPose.position)<1e-9&&camera.quaternion.angleTo(landingPose.quaternion)<1e-6,"and it lands on the station framing");
}
{
 const {camera,intro}=director();intro.hold(opening,landingPose);intro.frame(1000,true);intro.rendered(7200);
 for(let t=7216;t<7200+INTRO_REVEAL_FALLBACK_MS;t+=50){assert.equal(intro.frame(t,true),false);assert(intro.state==="holding"&&camera.position.equals(opening.position),"No cue, no flight: the opening shot holds");}
 assert.equal(intro.frame(7200+INTRO_REVEAL_FALLBACK_MS+10,true),true,"Without the cue it flies 4 s after the startup render");
}
{
 const {intro}=director();intro.hold(opening,landingPose);intro.frame(1000,true);intro.rendered(7200);
 for(let t=7216;t<9000;t+=50)assert.equal(intro.frame(t,true),false);
 intro.reveal();assert.equal(intro.state,"holding","The cue only arms the flight");
 assert.equal(intro.frame(9000,false),false,"and never starts it in a hidden tab");
 assert.equal(intro.frame(9016,true),true);assert.equal(intro.flight.started,9016,"It starts on the next visible frame");
}
{
 const {camera,intro}=director();intro.hold(opening,landingPose);intro.frame(1000,true);intro.rendered(1100);intro.reveal();intro.frame(2000,true);
 let t=2000;while(t<2500){t+=1000/60;intro.frame(t,true);}
 intro.frame(t+3000,true);
 assert.equal(intro.state,"flying");assert(Math.abs(travelled(camera)-introEase((t-2000+INTRO_MAX_FRAME_GAP_MS)/INTRO_DURATION_MS))<1e-9,"A 3 s stall pauses the flight: it moves on by one short hitch only");
 const paused=travelled(camera);for(let k=1;k<=20;k++)intro.frame(t+3000+k*250,false);
 assert(intro.state==="flying"&&Math.abs(travelled(camera)-paused)<1e-9,"A hidden tab stops it");
 assert.equal(intro.state,"flying");flyOut(intro,t+3000+5000);assert.equal(intro.state,"done");
}
{
 const {camera,intro}=director();intro.hold(opening,landingPose);intro.settle(5000);
 assert.equal(intro.state,"flying");assert.equal(intro.flight.duration,INTRO_SETTLE_MS,"Input during the hold settles quickly onto the station");
 const t=flyOut(intro,5000);assert(intro.state==="done"&&t>=5000+INTRO_SETTLE_MS&&t<5000+INTRO_SETTLE_MS+20&&camera.position.distanceTo(landingPose.position)<1e-9);
}
{
 const {camera,intro}=director();intro.hold(opening,landingPose);intro.frame(1000,true);intro.rendered(1100);intro.reveal();intro.frame(1200,true);
 let t=1200;while(t<2000){t+=1000/60;intro.frame(t,true);}
 const at=camera.position.clone();intro.settle(t);assert.equal(intro.flight.duration,INTRO_SETTLE_MS);assert(camera.position.distanceTo(at)<1e-9,"Input during the flight settles from where the camera is");
 const end=flyOut(intro,t);assert(intro.state==="done"&&end<t+INTRO_SETTLE_MS+20);
}
{
 const {camera,intro}=director();intro.hold(opening,landingPose);assert.equal(intro.land(),true);
 assert(intro.state==="done"&&camera.position.equals(landingPose.position),"A play or a view change lands the held shot at once");
 for(const early of [d=>d.land(),d=>d.settle(1)]){const {intro:skipped}=director();early(skipped);assert.equal(skipped.state,"skipped");assert.equal(skipped.hold(opening,landingPose),false,"An input before the first ready frame skips the fly-in");}
 const moved=director(),there={position:opening.position.clone().setX(26),quaternion:opening.quaternion.clone()},thereLanding={position:landingPose.position.clone().setX(26),quaternion:landingPose.quaternion.clone()};
 moved.intro.hold(opening,landingPose);moved.intro.aim(there,thereLanding,0);assert(moved.camera.position.equals(there.position),"A held shot follows a station change or a resize");
 moved.intro.rendered(10);moved.intro.reveal();moved.intro.frame(20,true);flyOut(moved.intro,20);assert(moved.camera.position.distanceTo(thereLanding.position)<1e-9);
}
// Execute the real machine's camera/lighting integration without a WebGL context.
const {createWalletCamera}=await import(await clawModule("walletCamera"));
const machineSource=await readFile(new URL("../components/claw/createMachine.ts",import.meta.url),"utf8"),machineAst=ts.createSourceFile("createMachine.ts",machineSource,ts.ScriptTarget.Latest,true);
const glue=[];let connectGlue,revealGlue;
(function find(node){
 if(ts.isFunctionDeclaration(node)&&node.name?.text==="animate")revealGlue=node.body.statements.filter(statement=>
  ts.isVariableStatement(statement)&&statement.declarationList.declarations.some(d=>d.name.getText(machineAst)==="loadingCovered")||
  ts.isIfStatement(statement)&&statement.expression.getText(machineAst).includes("!revealed")||
  ts.isExpressionStatement(statement)&&statement.expression.getText(machineAst).startsWith("director.frame(")
 ).map(statement=>statement.getText(machineAst)).join("\n");
 if(ts.isFunctionDeclaration(node)&&["establishingPose","revealScene","endIntro","frameStation"].includes(node.name?.text))glue.push(node.getText(machineAst));
 if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>["currentPose","director","signY"].includes(d.name.getText(machineAst))))glue.push(node.getText(machineAst));
 if(ts.isPropertyAssignment(node)&&node.name.getText(machineAst)==="setConnected")connectGlue=node.initializer.getText(machineAst);
 ts.forEachChild(node,find);
})(machineAst);
assert(connectGlue);
assert(revealGlue);
const glueJs=ts.transpileModule(glue.join("\n")+"\nglobalThis.walletCamera=director;globalThis.connect="+connectGlue+";globalThis.paintReveal=(dt,render,now)=>{"+revealGlue+"};",{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
for(const top of [false,true]){
 const camera=new THREE.PerspectiveCamera(36,1.4,.1,500),power=[];let covered=true,signPower=0;
 const m={THREE,CABINET_BOUNDS:(await import(await clawModule("cameraFraming"))).CABINET_BOUNDS,frameCabinet,stationSignY,createWalletCamera,establishingShot,lookRotation,NEON_SIGN_HEIGHT,NEON_SIGN_TUBES,NEON_SIGN_Y,
  camera,cameraX:0,cameraTargetX:0,view:top?"top":"front",revealed:false,host:{clientWidth:990,clientHeight:782},
  renderer:{domElement:{dataset:{}}},room:{powerOn(){signPower++;},setSignHeight(){}},cabinet:{setConnected:on=>power.push(on)},stations:{setConnected(){}},reducedMotion:{matches:false},document:{hidden:false,querySelector:selector=>selector==="[data-arcade-loading]"&&covered?{}:null}};
 runInNewContext(glueJs,m);m.frameStation();m.paintReveal(.016,true,1000);assert.equal(signPower,0,"Neon must not flicker behind a loading cover");covered=false;m.paintReveal(.016,true,2000);assert.equal(signPower,1,"The wall neon starts only after every cover is gone");const wide=camera.position.clone();
 for(let i=0;i<1000;i++)m.walletCamera.frame(.016,true);
 assert(camera.position.equals(wide)&&power.length===0,"Real machine stays wide and dim before authentication");
 m.endIntro(true);assert(camera.position.equals(wide),"A view/input cannot bypass unsigned standby");
 m.connect(true);assert.equal(power.at(-1),false);covered=true;const still=camera.position.clone();m.paintReveal(.1,true,2100);assert(camera.position.equals(still),"Wallet zoom also waits while a loader covers the scene");covered=false;m.walletCamera.frame(.1,true);assert.equal(power.at(-1),false);
 for(let i=0;i<100;i++)m.walletCamera.frame(.016,true);assert.equal(power.at(-1),true,"Real machine powers only after its wallet zoom");
}
const {warmEnvironment}=await import(await clawModule("studioLighting"));
const studio=new THREE.Scene(),lamp=new THREE.PointLight(0xffffff),softbox=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshLambertMaterial({color:0,emissive:0xffffff}));studio.add(lamp,softbox);warmEnvironment(studio);
for(const color of [lamp.color,softbox.material.emissive]){const [r,g,b]=color.toArray();assert(r>g&&g>b,"Steel and glass reflect a warm room, not a cold white studio");}
console.log("PASS: black slat wall with warm station pools and haze, a CATO ARCADE neon over every station powering on from the player's own, amber LED marquee and glowing bulbs, warm cabinet with a faint teal rim and no violet, glossier warm floor, bounded planar reflection, and wallet-gated wide/close camera sequencing.");

{
 // The start-up warm-up compiles the scene a part at a time; compile() adds a part's own lights to the scene's, so no
 // part may hold one (it would build programs for twice the lights).
 const {compileParts}=await import(await clawModule("shaderWarmup"));
 const root=new THREE.Group(),lit=new THREE.Group(),plain=new THREE.Group(),mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());
 lit.add(new THREE.PointLight(),mesh);plain.add(new THREE.Mesh());root.add(lit,plain);
 const parts=compileParts(root);assert.deepEqual(parts,[mesh,plain],"A subtree with a light is split; one without is compiled whole");
 for(const part of parts)part.traverse(object=>assert(!object.isLight,"No part holds a light"));
 assert(/await warmScene\(renderer, world, camera, \[null, pavement\.reflectionTarget\]/.test(machineSource),"The warm-up compiles the screen pass and the reflection target's programs");
 assert(/const ready = warmPrograms\(\)\.then\(\(\) => \{\s*if \(disposed\) return;\s*warming = false;[^\n]*loop\.start\(\);/.test(machineSource),"Play is enabled and the loop starts only after the warm-up");
 // The WebGL context and the synchronous scene build each take about 200 ms on a cold start: they run a frame apart.
 assert.equal(machineSource.match(/new THREE\.WebGLRenderer\(/g)?.length,1,"One renderer per machine");
 assert(/function createRenderer\(\) \{\s*renderer = new THREE\.WebGLRenderer\(\{ canvas, antialias: true \}\);/.test(machineSource),"The renderer draws into the canvas placed in the page at build time");
 assert(/async function warmPrograms\(\) \{\s*(\/\/[^\n]*\s*)*await yieldFrame\(\); if \(disposed\) return;\s*buildStations\(\);\s*await yieldFrame\(\); if \(disposed\) return;\s*createRenderer\(\);\s*await yieldFrame\(\);[^]*?studioEnvironmentAsync\(renderer/.test(machineSource),"The standby cabinets, then the context, each a frame apart after the scene build and before the environment's compile work");
 assert.equal(machineSource.match(/createArcadeStations\(/g)?.length,1,"The standby cabinets are built once, by the warm-up");
 assert(/function buildStations\(\) \{\s*stations = createArcadeStations\([^\n]*\n\s*stations\.sync\(boxes\); stations\.select\(stationTier\);/.test(machineSource),"Late-built standby cabinets catch up on the pile and the station chosen meanwhile");
}
