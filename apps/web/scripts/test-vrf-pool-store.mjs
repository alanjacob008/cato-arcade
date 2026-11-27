import assert from "node:assert/strict";
import {Keypair} from "@solana/web3.js";
import {preparePoolStore} from "./lib/vrf-pool-store.mjs";
import {createErPoolRuntime} from "./lib/vrf-er-pool-runtime.mjs";

const adminAuthority=Keypair.generate().publicKey.toBase58();
const lane=i=>({id:`lane-${i+1}`,key:Array.from(Keypair.generate().secretKey),attempts:[{
  nonce:String(10+i),requestSignature:`request-${i}`,wire:`exact-signed-bytes-${i}`,
  ...(i===0?{callbackSignature:"verified-callback"}:{pending:true}),
}],...(i===1?{control:{action:"pause",wire:"exact-control-bytes"}}:{})});
const original=Array.from({length:4},(_,i)=>lane(i));
const routing={version:1,cursor:3,assignments:{existing:{lane:"lane-3",fingerprint:"a".repeat(64),phase:"active"}}};
const session={poolLanes:structuredClone(original),poolRouting:structuredClone(routing),poolEnabled:true};
let persisted,saves=0;
const keys=await preparePoolStore({session,adminAuthority,save:async()=>{persisted=structuredClone(session);saves++;}});
assert.equal(keys.length,8);assert.equal(session.poolLanes.length,8);assert.equal(saves,1);
assert.deepEqual(session.poolLanes.slice(0,4),original,"Existing signers, exact bytes, receipts and controls survive migration");
assert.deepEqual(persisted,session,"All new keys are persisted before returning");
assert.deepEqual(session.poolRouting,routing,"Existing routing and leases are not reset");
assert.equal(new Set(keys.map(key=>key.publicKey.toBase58())).size,8);
assert.equal(new Set(session.poolLanes.map(lane=>lane.id)).size,8);
assert(session.poolLanes.slice(4).every(lane=>lane.attempts.length===0&&!lane.control));
const restarted=structuredClone(persisted);
await preparePoolStore({session:restarted,adminAuthority,save:async()=>assert.fail("An eight-lane store must not be regenerated")});
assert.deepEqual(restarted,persisted);

const failed={poolLanes:structuredClone(original),poolRouting:structuredClone(routing)};
await assert.rejects(preparePoolStore({session:failed,adminAuthority,save:async()=>{throw Error("durable_write_failed");}}),/durable_write_failed/);
assert.deepEqual(failed,{poolLanes:original,poolRouting:routing},"An unsuccessful migration restores the original store");
const fresh={};await assert.rejects(preparePoolStore({session:fresh,adminAuthority,save:async()=>{throw Error("durable_write_failed");}}));
assert.equal(fresh.poolLanes,undefined);
await preparePoolStore({session:fresh,adminAuthority,save:async()=>{}});assert.equal(fresh.poolLanes.length,8);

for(const poolLanes of [null,[],original.slice(0,3),[...original,...structuredClone(original),lane(8)],Array.from({length:16},(_,i)=>lane(i))]){
  await assert.rejects(preparePoolStore({session:{poolLanes},adminAuthority,save:async()=>assert.fail("Invalid stores cannot be saved")}),/invalid_vrf_pool_store/);
}
for(const edit of [lanes=>{lanes[1].key=lanes[0].key;},lanes=>{lanes[1].key=Array.from(Keypair.fromSecretKey(Uint8Array.from(lanes[0].key)).secretKey);},lanes=>{lanes[0].key[0]=-1;},lanes=>{lanes[1].id=lanes[0].id;}]){
  const lanes=structuredClone(original);edit(lanes);
  await assert.rejects(preparePoolStore({session:{poolLanes:lanes},adminAuthority,save:async()=>assert.fail("Corrupted signers cannot be persisted")}),/invalid_vrf_pool_(store|signers)/);
}
await assert.rejects(preparePoolStore({session:{poolLanes:structuredClone(original)},adminAuthority:Keypair.fromSecretKey(Uint8Array.from(original[0].key)).publicKey.toBase58(),save:async()=>assert.fail()}),/invalid_vrf_pool_signers/);

// A failed migration must stop the actual runtime before any RPC or send path.
await assert.rejects(createErPoolRuntime({session:{poolLanes:structuredClone(original)},manifest:{adminAuthority},
  save:async()=>{throw Error("durable_write_failed");},identity:async()=>assert.fail("No RPC before durable migration")}),/durable_write_failed/);
console.log("PASS: durable four-to-eight lane migration preserves signers, signed requests, receipts, controls and routing; restart is idempotent; invalid/shrinking stores and failed persistence fail closed.");
