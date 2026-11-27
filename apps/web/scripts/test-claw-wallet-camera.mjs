import assert from 'node:assert/strict';
import * as THREE from 'three';
import {clawModule} from './claw-test-loader.mjs';
const {createWalletCamera,WALLET_ZOOM_MS,walletZoomEase}=await import(await clawModule('walletCamera'));
const {frameCabinet,CABINET_BOUNDS}=await import(await clawModule('cameraFraming'));
const {establishingShot,lookRotation}=await import(await clawModule('introCamera'));
for(const top of [false,true])for(const aspect of [.5,1.5,3]){
 const camera=new THREE.PerspectiveCamera(36,aspect,.1,500);frameCabinet(camera,aspect,top);
 const close={position:camera.position.clone(),quaternion:camera.quaternion.clone()};
 const center=CABINET_BOUNDS.getCenter(new THREE.Vector3()),back=new THREE.Vector3(0,0,1).applyQuaternion(camera.quaternion);
 const shot=establishingShot(aspect,36,0,6.5,3);
 const wide=top?{position:close.position.clone().addScaledVector(back,camera.position.distanceTo(center)*.6),quaternion:close.quaternion.clone()}:{position:shot.position,quaternion:lookRotation(shot.position,shot.target)};
 const power=[],director=createWalletCamera(camera,on=>power.push(on));director.setFraming(wide,close,false);
 for(let i=0;i<1000;i++)director.frame(.016,true);
 assert(camera.position.distanceTo(wide.position)<1e-8,'Unsigned views stay wide indefinitely');assert.equal(power.length,0);
 director.setConnected(true,false);assert.equal(power.at(-1),false);const initial=camera.position.clone();
 director.frame(.3,false);assert(camera.position.equals(initial),'Hidden frames cannot skip the zoom or power up');
 director.frame(.1,true);assert(camera.position.distanceTo(close.position)>0&&camera.position.distanceTo(wide.position)>0);assert.equal(power.at(-1),false,'Lights stay off during the dolly');
 for(let i=0;i<100;i++)director.frame(.016,true);
 assert.equal(director.state,'done');assert(camera.position.distanceTo(close.position)<1e-8);assert.equal(power.at(-1),true,'Power-on follows the completed zoom');
 const count=power.length;director.setConnected(true,false);assert.equal(power.length,count,'Repeated authentication state does not restart the reveal');
 director.setConnected(false,false);assert.equal(power.at(-1),false);for(let i=0;i<100;i++)director.frame(.016,true);assert(camera.position.distanceTo(wide.position)<1e-8);
 director.setConnected(true,true);assert(camera.position.distanceTo(close.position)<1e-8);assert.equal(power.at(-1),true,'Reduced motion places the camera before power-on');
 director.setConnected(false,true);director.setConnected(true,false);director.frame(.1,true);camera.position.x=12;director.frame(.1,true);assert.equal(camera.position.x,12,'Station panning remains independent of zoom');
 const before=camera.position.clone();director.setFraming(wide,close,false);assert(camera.position.equals(before),'Resizing while zooming retains the visible pose');
}
assert(WALLET_ZOOM_MS>=1500&&WALLET_ZOOM_MS<=2000);
// Zero acceleration at each end and continuous acceleration through the middle.
const h=.001, acceleration=t=>(walletZoomEase(t+h)-2*walletZoomEase(t)+walletZoomEase(t-h))/(h*h);
assert(Math.abs(acceleration(h))<.1&&Math.abs(acceleration(1-h))<.1);
assert(Math.abs(acceleration(.5-h)-acceleration(.5+h))<.1);
console.log('PASS: unsigned front/top views stay wide, authenticated zoom precedes power-on, hidden/reduced-motion behavior, disconnect, reframe and independent station panning.');
