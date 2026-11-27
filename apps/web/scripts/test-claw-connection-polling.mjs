import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const module={exports:{}};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../components/claw/connectionPolling.ts",import.meta.url),"utf8"),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports});
const {pollConnection}=module.exports;
let task=null,resolveCheck,calls=0,enabled=true;
const clock={later:(callback,ms)=>{assert.equal(task,null,"Only one future poll is scheduled");task={callback,ms};return task;},cancel:id=>{if(task===id)task=null;}};
const run=()=>{const current=task;task=null;current.callback();};
const stop=pollConnection(()=>{calls++;return new Promise(resolve=>{resolveCheck=resolve;});},()=>enabled,clock);
assert.equal(task.ms,0);run();assert.equal(calls,1);assert.equal(task,null,"A slow check cannot overlap the next check");
resolveCheck();await new Promise(setImmediate);assert.equal(task.ms,15000,"Retry waits fifteen seconds after completion");
enabled=false;run();assert.equal(calls,1,"No availability poll interrupts an active play");assert.equal(task.ms,15000);
enabled=true;run();assert.equal(calls,2);stop();resolveCheck();await new Promise(setImmediate);assert.equal(task,null,"Unmount cancels future checks, including an in-flight completion");
console.log("PASS: connection polling waits after completion, prevents overlap, respects plays and stops on unmount.");
