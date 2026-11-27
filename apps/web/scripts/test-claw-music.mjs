import assert from "node:assert/strict";
import {clawModule} from "./claw-test-loader.mjs";
const {createBackgroundMusic,createTrackQueue,BACKGROUND_VOLUME,BACKGROUND_TRACKS}=await import(await clawModule("musicPlayback"));
assert.equal(BACKGROUND_TRACKS.length,6);assert.equal(new Set(BACKGROUND_TRACKS).size,6);
{const next=createTrackQueue(BACKGROUND_TRACKS,Math.random);const round=[...Array(6)].map(next);assert.equal(new Set(round).size,6,"Each round plays every song once");
 for(let i=0;i<200;i++){const before=round.at(-1),after=next();round.push(after);if(i%6===0)assert.notEqual(after,before,"A new round never repeats the song that just ended");}}
let created=0,plays=0,pauses=0,loads=0,resolve;
const media={paused:true,preload:"auto",loop:false,volume:1,src:"",play(){plays++;this.paused=false;return Promise.resolve();},pause(){pauses++;this.paused=true;},removeAttribute(name){assert.equal(name,"src");this.src="";},load(){loads++;}};
const errors=[],player=createBackgroundMusic(()=>{created++;return media;},value=>errors.push(value));
player.setMuted(false);player.setHidden(false);assert.equal(created,0,"No music element or download before user interaction");
player.activate();await Promise.resolve();assert.equal(created,1);assert.equal(plays,1);assert.equal(media.preload,"none");assert(BACKGROUND_TRACKS.includes(media.src));assert(!media.loop,"Songs advance instead of looping one track");assert.equal(media.volume,BACKGROUND_VOLUME);assert(BACKGROUND_VOLUME<.1);
{const first=media.src;media.paused=true;media.onended();await Promise.resolve();assert.equal(plays,2,"The next song starts when one ends");assert.notEqual(media.src,first);assert(BACKGROUND_TRACKS.includes(media.src));plays=1;}
player.activate();assert.equal(plays,1,"Repeated pointer/keyboard input cannot restart the music");
player.setMuted(true);assert(media.paused);player.activate();assert.equal(plays,1);
player.setMuted(false);await Promise.resolve();assert.equal(plays,2);
player.setHidden(true);assert(media.paused);player.activate();assert.equal(plays,2);
player.setHidden(false);await Promise.resolve();assert.equal(plays,3,"An activated track resumes after returning to the tab");
player.dispose();assert(media.paused);assert.equal(media.src,"");assert.equal(loads,1);player.activate();assert.equal(plays,3);player.dispose();
const blocked=createBackgroundMusic(()=>assert.fail("Muted first visits cannot download music"));blocked.setMuted(true);blocked.activate();blocked.setHidden(true);blocked.setHidden(false);blocked.dispose();
const pendingMedia={...media,play(){plays++;return new Promise(done=>{resolve=done;});}},pending=createBackgroundMusic(()=>pendingMedia,value=>errors.push(value));
pending.activate();pending.activate();const count=plays;pending.setMuted(true);resolve();await new Promise(done=>setImmediate(done));assert.equal(plays,count);assert(pendingMedia.paused);pending.dispose();
assert(pauses>=4);
console.log("PASS: six shuffled songs start only on interaction, low volume, streaming preload, advance on end, independent mute, hidden-tab pause/resume and media cleanup.");
