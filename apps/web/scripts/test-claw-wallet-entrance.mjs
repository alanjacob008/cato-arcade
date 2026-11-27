import assert from "node:assert/strict";
import {clawModule} from "./claw-test-loader.mjs";
const {revealWalletLights}=await import(await clawModule("walletEntrance"));
function fakeClock(hidden=false){
 let next=0;const frames=new Map(),listeners=new Set();
 return {clock:{hidden:()=>hidden,frame:callback=>{frames.set(++next,callback);return next;},cancel:id=>frames.delete(id),visibility:callback=>{listeners.add(callback);return()=>listeners.delete(callback);}},
  paint(){const batch=[...frames.values()];frames.clear();batch.forEach(callback=>callback());},
  hide(value){hidden=value;[...listeners].forEach(callback=>callback());},frames,listeners};
}
const visible=fakeClock();let powered=0;
const cancel=revealWalletLights(()=>powered++,visible.clock);
assert.equal(powered,0,"Lights stay off while the loader removal is committed");
visible.paint();assert.equal(powered,0,"The user gets a dim scene paint first");
visible.paint();assert.equal(powered,1);visible.paint();assert.equal(powered,1);assert.equal(visible.listeners.size,0);cancel();
const hidden=fakeClock(true);let hiddenPower=0;
const stopHidden=revealWalletLights(()=>hiddenPower++,hidden.clock);hidden.paint();assert.equal(hiddenPower,0);assert.equal(hidden.frames.size,0);
hidden.hide(false);hidden.paint();assert.equal(hiddenPower,0);hidden.hide(true);hidden.paint();assert.equal(hiddenPower,0);
hidden.hide(false);hidden.paint();assert.equal(hiddenPower,0);hidden.paint();assert.equal(hiddenPower,1,"A hidden-tab reveal restarts with a visible dim paint");stopHidden();
const interrupted=fakeClock();let stale=0;
const stop=revealWalletLights(()=>stale++,interrupted.clock);interrupted.paint();stop();interrupted.paint();interrupted.hide(true);interrupted.hide(false);interrupted.paint();
assert.equal(stale,0,"Disconnect, a replaced machine or unmount cancels stale switch-on");assert.equal(interrupted.frames.size,0);assert.equal(interrupted.listeners.size,0);
console.log("PASS: dim visible paint before wallet lights, no hidden-tab switch-on, single reveal and cancellation on disconnect/replacement/unmount.");
