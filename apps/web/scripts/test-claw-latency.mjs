import assert from "node:assert/strict";
import {createClawLatencyProbe} from "./lib/claw-latency-probe.mjs";
import {createSaveQueue} from "./lib/claw-session-store.mjs";

let clock=0,release;const started=[];
const probe=createClawLatencyProbe({region:"iad1",now:()=>clock,
  database:async()=>{started.push("db");await new Promise(resolve=>{release=resolve;});},
  base:async()=>{started.push("base");},rollup:async()=>{started.push("er");throw Error("https://private-rpc.example/?api-key=secret");},
  attestBase:async()=>{started.push("attest-base");},attestRollup:async()=>{started.push("attest-er");},
  saveStats:()=>({pending:0,lastWriteMs:20})});
const a=probe.get(),b=probe.get();assert.equal(a,b);await Promise.resolve();
assert.equal(started.length,5,"All independent read-only measurements must start together");
clock=100;release();const report=await a;
assert.equal(report.region,"iad1");assert.equal(report.probes.database.ms,100);
assert.equal(report.probes.rollupRpc.error,"latency_probe_failed");assert(!JSON.stringify(report).includes("secret"));
assert.equal((await probe.get()).checkedAt,report.checkedAt);assert.equal(started.length,5);

clock=0;let releaseWrite;const order=[];
const enqueue=createSaveQueue({save:async value=>{order.push(value.n);if(value.n===1)await new Promise(resolve=>{releaseWrite=resolve;});else clock+=30;}},()=>{}, {now:()=>clock});
const first=enqueue({n:1});for(let i=0;i<10&&!releaseWrite;i++)await Promise.resolve();assert(releaseWrite);
clock=10;const second=enqueue({n:2});assert.equal(enqueue.stats().pending,2);
clock=100;releaseWrite();await Promise.all([first,second]);assert.deepEqual(order,[1,2]);
assert.deepEqual(enqueue.stats(),{pending:0,completed:2,failed:0,lastQueueMs:90,lastWriteMs:30});
console.log("PASS: read-only parallel backend diagnostics, coalesced/cached probes, credential redaction, region reporting and signer-write queue timing without weakening ordered persistence.");
