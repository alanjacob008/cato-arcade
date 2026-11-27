import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import {clawModule} from "./claw-test-loader.mjs";
const {createArcadeSound}=await import(await clawModule("arcadeSound"));
const {createMotionFeedback}=await import(await clawModule("motionFeedback"));
const {outcomeCue,CUES}=await import(await clawModule("feedback"));

class Param {
  value=0;events=[];
  setValueAtTime(value,time){this.events.push({kind:"set",value,time});this.value=value;}
  linearRampToValueAtTime(value,time){this.events.push({kind:"linear",value,time});this.value=value;}
  exponentialRampToValueAtTime(value,time){assert(value>0);this.events.push({kind:"exponential",value,time});this.value=value;}
  setTargetAtTime(value,time,constant){assert(constant>0);this.events.push({kind:"target",value,time,constant});this.value=value;}
  cancelScheduledValues(){}
}
class Node {
  constructor(context,kind){this.context=context;this.kind=kind;this.connections=[];this.gain=new Param();this.frequency=new Param();this.Q=new Param();}
  connect(node){this.connections.push(node);return node;}
  disconnect(){this.disconnected=true;}
  start(at=0){this.started=at;this.context.active.add(this);}
  stop(at=0){this.stopAt=at;if(at<=this.context.currentTime){this.context.active.delete(this);this.onended?.();}}
}
class Context {
  currentTime=0;sampleRate=44100;state="running";nodes=[];active=new Set();destination={};
  make(kind){const node=new Node(this,kind);this.nodes.push(node);return node;}
  createGain(){return this.make("gain");}
  createOscillator(){return this.make("oscillator");}
  createBiquadFilter(){return this.make("filter");}
  createBufferSource(){return this.make("noise");}
  createDynamicsCompressor(){const node=this.make("compressor");for(const key of ["threshold","knee","ratio","attack","release"])node[key]=new Param();return node;}
  createBuffer(_channels,length){const samples=new Float32Array(length);return {getChannelData:()=>samples};}
  advance(time){this.currentTime=time;for(const node of [...this.active])if(node.stopAt!==undefined&&node.stopAt<=time){this.active.delete(node);node.onended?.();}}
}
const quietContext=new Context(),quiet=createArcadeSound(quietContext),quietNodes=quietContext.nodes.length;
quiet.motion(1,"aim");quiet.motion(1,"hoist");quiet.play("joystick");quiet.play("motor");
assert.equal(quietContext.nodes.length,quietNodes,"Default player audio never starts claw-motion or joystick sounds");
quiet.play("insert");assert(quietContext.nodes.length>quietNodes,"Insertion still has sound");quiet.dispose();
const context=new Context(),audio=createArcadeSound(context);
assert.equal(context.active.size,0,"Loading never autoplays or starts a motor");
for(const cue of ["insert","press","grab","impact","win","jackpot","miss"]){
  const before=context.nodes.length;audio.play(cue);
  const voices=context.nodes.slice(before).filter(node=>node.kind==="oscillator");
  assert.equal(voices.length,CUES[cue].length);
  assert(voices.every(node=>node.type==="square"||node.type==="triangle"),"Only retro pulse and triangle voices are used");
  if(cue==="press"){
    assert.equal(voices.length,0,"A plastic button click has no pitched beep");
    const sample=context.nodes.slice(before).find(node=>node.kind==="noise").buffer.getChannelData(0);
    assert(sample.length/context.sampleRate<.08,"The button click is short and memory-bounded");
    assert(sample.every(Number.isFinite)&&sample.some(value=>Math.abs(value)>.05),"Plastic sample contains finite audible transients");
    assert(Math.max(...sample.map(Math.abs))<1,"The synthesized click is not clipped");
    const count=context.nodes.length;audio.play("press");assert.equal(context.nodes.length,count,"Duplicate handlers for one press do not double the click");
  }
  assert(voices.every(node=>Number.isFinite(node.started)&&node.stopAt>node.started),"Every one-shot has a bounded lifetime");
  assert(context.nodes.slice(before).some(node=>node.kind==="gain"&&node.gain.events.some(event=>event.kind==="linear")),"Short attacks avoid audio clicks");
  context.advance(context.currentTime+3);assert.equal(context.active.size,0,"Completed voices are released");
}
audio.motion(.5,"aim");const firstLoop=context.nodes.length;
for(let i=0;i<120;i++)audio.motion(.2+i/200,"aim");
assert.equal(context.nodes.length,firstLoop,"All movement updates remain silent, with no motor graph");
audio.motion(0,"aim");context.advance(context.currentTime+.2);assert.equal(context.active.size,0);
audio.play("win");audio.setMuted(true);assert.equal(context.active.size,0,"Mute cancels scheduled voices immediately");
const mutedCount=context.nodes.length;audio.play("win");audio.motion(1,"aim");assert.equal(context.nodes.length,mutedCount);
audio.setMuted(false);audio.play("jackpot");audio.setHidden(true);assert.equal(context.active.size,0,"Background tabs do not retain or replay scheduled wins");
const hiddenCount=context.nodes.length;audio.play("win");audio.motion(1,"aim");assert.equal(context.nodes.length,hiddenCount);
audio.setHidden(false);audio.motion(.8,"hoist");audio.play("miss");context.advance(context.currentTime+2);assert.equal(context.active.size,0);
for(let i=0;i<100;i++){context.currentTime+=.04;audio.play("jackpot");}
assert(context.active.size<=24,"Rapid repeated sounds cannot exceed the 24-voice budget");
audio.dispose();assert.equal(context.active.size,0);const disposedCount=context.nodes.length;audio.play("win");audio.motion(1,"aim");assert.equal(context.nodes.length,disposedCount);
audio.dispose();
assert.equal(outcomeCue(false,2000),"miss","A failed draw can never get a winning cue");
assert.equal(outcomeCue(true,150),"win");assert.equal(outcomeCue(true,1000),"jackpot");

// The live player uses supplied MP3s, not the retained legacy synth above.
const {createArcadeSamples,ARCADE_SAMPLES,isSampleCue,SAMPLE_MUTE_KEY}=await import(await clawModule("arcadeSamples"));
class SampleAudio {
  paused=true;currentTime=0;plays=0;loads=0;
  constructor(src){this.src=src;}
  load(){this.loads++;}
  play(){this.plays++;this.paused=false;return Promise.resolve();}
  pause(){this.paused=true;}
  removeAttribute(name){if(name==="src")this.src="";}
}
let sampleTime=0;const samples=[],sample=createArcadeSamples(src=>{const audio=new SampleAudio(src);samples.push(audio);return audio;},()=>sampleTime);
const byCue=cue=>samples.find(audio=>audio.src.endsWith(ARCADE_SAMPLES[cue].file));
assert.equal(samples.length,6);assert(samples.every(audio=>audio.plays===0),"Preloading never autoplays");
for(const cue of ["silver","gold","diamond"])assert.equal(ARCADE_SAMPLES[cue].volume,.005,"Token selection stays at 0.5% of full volume");
assert.equal(ARCADE_SAMPLES.win.volume,.02);assert.equal(ARCADE_SAMPLES.lose.volume,.02,"Both outcome samples stay at 2% of full volume");
for(const config of Object.values(ARCADE_SAMPLES))assert((await readFile(new URL(`../public/claw/sfx/${config.file}`,import.meta.url))).length>0);
sample.play("button");assert.equal(byCue("button").plays,0);sample.activate();
for(const cue of ["button","silver","gold","diamond","win","lose"]){sampleTime+=100;sample.play(cue);assert.equal(byCue(cue).plays,1);}
sample.play("lose");assert.equal(byCue("lose").plays,1,"Capture and play handlers cannot double the same sound");
const motionPlays=samples.reduce((sum,a)=>sum+a.plays,0);for(const kind of ["aim","hoist"])for(let i=0;i<100;i++)sample.motion(.7,kind);assert.equal(samples.reduce((sum,a)=>sum+a.plays,0),motionPlays,"All claw motion stays silent");assert(!("joystick"in ARCADE_SAMPLES));
sample.motion(.5,"aim");sample.setHidden(true);assert(samples.every(audio=>audio.paused));sampleTime+=100;sample.play("win");assert.equal(byCue("win").plays,1);sample.setHidden(false);assert(samples.every(audio=>audio.paused),"Returning from a hidden tab never replays stale sounds");
sample.setMuted(true);sampleTime+=100;sample.play("button");assert.equal(byCue("button").plays,1);sample.setMuted(false);sample.dispose();assert(samples.every(audio=>audio.paused&&audio.src===""));sample.dispose();

const effects=[],listeners=new Map(),hookSamples=[],saved=new Map();let hookTime=0;
class Element {constructor(button){this.button=button;}closest(){return this.button;}}
const hookModule={exports:{}},document={hidden:false,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{assert.equal(listeners.get(name),fn);listeners.delete(name);}};
const hookSource=ts.transpileModule(await readFile(new URL("../components/claw/useArcadeAudio.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(hookSource,{module:hookModule,exports:hookModule.exports,document,Element,performance,
  localStorage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)},
  require:name=>name==="react"?{useRef:value=>({current:value}),useState:value=>[value,()=>{}],useCallback:fn=>fn,useEffect:fn=>effects.push(fn)}:
    {createArcadeSamples:()=>createArcadeSamples(src=>{const audio=new SampleAudio(src);hookSamples.push(audio);return audio;},()=>hookTime),isSampleCue,SAMPLE_MUTE_KEY}});
const hook=hookModule.exports.useArcadeAudio(),cleanup=effects.map(fn=>fn());
const click=(cue,disabled=false,inside=true)=>{hookTime+=100;listeners.get("click")({target:new Element({disabled,dataset:cue?{arcadeSound:cue}:{},closest:()=>inside,getAttribute:()=>null,hasAttribute:()=>false})});};
assert(hookSamples.every(audio=>audio.plays===0));click("button");hook.playCue("press");assert.equal(hookSamples[0].plays,1,"Nested primary button content and explicit drop handler produce one click");
click("diamond");assert.equal(hookSamples.find(audio=>audio.src.endsWith("coin-select-diamond.mp3")).plays,1);
const plays=()=>hookSamples.reduce((sum,a)=>sum+a.plays,0),before=plays();click("button",true);click("button",false,false);click(null);assert.equal(plays(),before,"Disabled controls, untagged secondary buttons and other games stay silent");
hookTime+=100;hook.playCue("jackpot");assert.equal(hookSamples.find(audio=>audio.src.endsWith("win.mp3")).plays,1);hook.playCue("miss");assert.equal(hookSamples.find(audio=>audio.src.endsWith("lose.mp3")).plays,1);
const mapped=plays();for(const cue of ["insert","grab","impact","motor","joystick"])hook.playCue(cue);assert.equal(plays(),mapped,"Unassigned legacy cues do not synthesize replacement sounds");
hook.toggleMuted();assert.equal(saved.get(SAMPLE_MUTE_KEY),"1");click("button");assert.equal(plays(),mapped);hook.toggleMuted();
document.hidden=true;listeners.get("visibilitychange")();assert(hookSamples.every(audio=>audio.paused));cleanup.forEach(fn=>fn?.());assert.equal(listeners.size,0);assert(hookSamples.every(audio=>audio.src===""));

const events=[],meter=createMotionFeedback((speed,kind)=>events.push({speed,kind}));
const point={x:0,y:4,z:0};meter.sample(point,1/60,0,"aim");assert.equal(events.length,0);
for(let i=1;i<=60;i++){point.x+=1/60;meter.sample(point,1/60,i*1000/60,"aim");}
assert(events.length<=14&&events.some(event=>event.speed>0),"Report real motion at a bounded rate without React updates");
meter.sample(point,1/60,1017,"aim");assert.equal(events.at(-1).speed,0,"Holding into a stationary wall is silent");
point.y-=.2;meter.sample(point,1/60,1034,"hoist");assert.equal(events.at(-1).kind,"hoist");assert(events.at(-1).speed>0);
point.y-=.2;meter.sample(point,1/60,1051,"hoist",true);assert.equal(events.at(-1).speed,0,"Hidden/waiting movement is silent");
meter.stop();point.x=9;meter.sample(point,1/60,1100,"aim");assert.equal(events.at(-1).speed,0,"Scene reset cannot create a movement burst");
console.log("PASS: six supplied MP3s, quieter selection/results, silent motion and secondary buttons, primary click deduplication, mute/hidden/unmount cleanup and delivered outcome cues.");
