import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Keypair,PublicKey,SystemProgram,VersionedTransaction} from "@solana/web3.js";
import {createPublicKey,verify} from "node:crypto";
import {createErPoolRuntime} from "./lib/vrf-er-pool-runtime.mjs";
import {loadClawRules} from "./lib/vrf-game.mjs";
import {discriminator,u64} from "./lib/vrf-deployment.mjs";
import {encodeSignature} from "./lib/vrf-sponsor.mjs";
import {DELEGATION_PROGRAM,ER_VALIDATOR} from "./lib/vrf-er.mjs";
import {POOL_SIZE,POOL_POLICY,POOL_POLICY_CLOCK_MARGIN,erPoolDelegationAddresses,decodeErPoolSession} from "./lib/vrf-er-pool.mjs";

// The real runtime, signer, account decoder, callback verifier and router run
// against an in-memory RPC transport. Contract logic is tested by Rust tests.
const manifest=JSON.parse(await readFile(new URL("../onchain/deployment.devnet.json",import.meta.url),"utf8"));
manifest.verifiedArtifact.capabilities=["bounded-er-pool-v1"];
const program=new PublicKey(manifest.vrfProbeProgram),admin=new PublicKey(manifest.adminAuthority),now=Math.floor(Date.now()/1000);
const session={poolLanes:Array.from({length:POOL_SIZE},(_,i)=>({id:"lane-"+(i+1),key:Array.from(Keypair.generate().secretKey),attempts:[]}))};
const base=new Map(),rollup=new Map(),transactions=new Map(),receipts=new Map(),pending=new Map();
for(const lane of session.poolLanes){
  const key=Keypair.fromSecretKey(Uint8Array.from(lane.key)),p=erPoolDelegationAddresses(manifest,key.publicKey),b=Buffer.alloc(280);
  const bump=PublicKey.findProgramAddressSync([Buffer.from("er-pool"),admin.toBuffer(),key.publicKey.toBuffer()],program)[1];
  discriminator("account:ErPoolSession").copy(b);admin.toBuffer().copy(b,8);key.publicKey.toBuffer().copy(b,40);ER_VALIDATOR.toBuffer().copy(b,72);
  b.writeBigInt64LE(BigInt(now),104);b[123]=bump;key.publicKey.toBuffer().copy(b,124);b.writeUInt16LE(64,164);b[231]=1;b[232]=bump;
  b.writeBigInt64LE(BigInt(now+604800),233);b.writeUInt16LE(500,241);b.writeBigInt64LE(21600n,243);b.writeUInt32LE(1000,251);b.writeUInt32LE(2000,255);
  b.writeBigInt64LE(BigInt(Math.floor(now/86400)),267);
  const record=Buffer.alloc(96);record.writeBigUInt64LE(100n);ER_VALIDATOR.toBuffer().copy(record,8);program.toBuffer().copy(record,40);
  base.set(p.session.toBase58(),{owner:DELEGATION_PROGRAM,data:Buffer.alloc(0)});
  base.set(p.record.toBase58(),{owner:DELEGATION_PROGRAM,data:record});
  base.set(key.publicKey.toBase58(),{owner:SystemProgram.programId,lamports:5000000,data:Buffer.alloc(0)});
  rollup.set(p.session.toBase58(),{owner:program,data:b});
}
const snapshot=account=>account?{...account,data:Buffer.from(account.data)}:null;
let sends=0,saves=0,active=0,peak=0,release;const gate=new Promise(resolve=>{release=resolve;});let blockSends=true;
const connection={getMultipleAccountsInfo:async ids=>ids.map(id=>snapshot(base.get(id.toBase58())))};
const executionConnection={
  getMultipleAccountsInfo:async ids=>ids.map(id=>snapshot(rollup.get(id.toBase58()))),
  getAccountInfo:async id=>snapshot(rollup.get(id.toBase58())),
  getLatestBlockhash:async()=>({blockhash:admin.toBase58(),lastValidBlockHeight:9999}),
  getBlockHeight:async()=>1000,
  getSignatureStatuses:async signatures=>({value:signatures.map(signature=>receipts.get(signature)??null)}),
  getSignaturesForAddress:async address=>[...pending.values()].filter(value=>value.address===address.toBase58()&&value.callback).map(value=>({signature:value.callback,err:null})).reverse(),
  getParsedTransaction:async signature=>transactions.get(signature)??null,
  async sendRawTransaction(bytes){
    const tx=VersionedTransaction.deserialize(bytes),message=tx.message,ix=message.compiledInstructions.at(-1),data=Buffer.from(ix.data);
    assert.equal(message.header.numRequiredSignatures,1);assert(message.staticAccountKeys[ix.programIdIndex].equals(program));
    const signer=message.staticAccountKeys[0],key=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),signer.toBuffer()]),format:"der",type:"spki"});
    assert(verify(null,message.serialize(),key,tx.signatures[0]),"Runtime transaction has a valid isolated delegate signature");
    const address=message.staticAccountKeys[ix.accountKeyIndexes[1]].toBase58(),account=rollup.get(address),b=account.data;
    assert.equal(signer.toBase58(),new PublicKey(b.subarray(40,72)).toBase58());
    const signature=encodeSignature(tx.signatures[0]);
    if(data.subarray(0,8).equals(discriminator("global:pause_er_pool_session"))){b[275]=1;receipts.set(signature,{err:null,confirmationStatus:"confirmed"});return signature;}
    assert(data.subarray(0,8).equals(discriminator("global:request_er_pool_probe")));
    sends++;active++;peak=Math.max(peak,active);if(blockSends)await gate;active--;
    const nonce=data.readBigUInt64LE(8);assert.equal(nonce,b.readBigUInt64LE(114));
    assert.equal(b[231],1,"No pending attempt is overwritten");
    b.writeBigUInt64LE(nonce+1n,114);b[122]=1;
    data.subarray(8,28).copy(b,156);b.writeBigUInt64LE(100n,176);b.writeBigUInt64LE(0n,184);b.fill(0,192,232);b[231]=0;
    b.writeUInt16LE(499,112);b.writeBigInt64LE(BigInt(now+21600),104);
    b.writeUInt32LE(b.readUInt32LE(259)+1,259);b.writeUInt32LE(b.readUInt32LE(263)+1,263);b.writeUInt32LE(1,276);
    pending.set(signature,{address,nonce});receipts.set(signature,{err:null,confirmationStatus:"confirmed"});return signature;
  },
};
const rules=await loadClawRules(),boxes=rules.createPile(42),aim=rules.startingAim(boxes);
const pull=i=>({id:"runtime-"+i,rulesVersion:rules.RULES_VERSION,aim,target:rules.selectTarget(aim,boxes,0),tier:0,currency:"USDC",priceUsd:2});
const options={session,manifest,save:async()=>{saves++;},connection,executionConnection,rules,identity:async()=>true,verified:async()=>true,deployed:async()=>true,
  legacy:{has:()=>false,game:{plan:async()=>{throw Error("unexpected_legacy_route");}}}};
let runtime=await createErPoolRuntime(options);
const status=await runtime.status();assert.equal(status.enabled,true);assert.equal(status.remaining,POOL_SIZE*1000);
assert(!JSON.stringify(status).includes('"key"'));assert.equal(sends,0,"Status cannot spend or renew");
await assert.rejects(runtime.plan({lane:POOL_SIZE}),/invalid_pool_lane/);
assert.equal((await runtime.plan({lane:POOL_SIZE-1})).done,true,"The eighth authorized lane is addressable through admin plans");
const plans=Array.from({length:POOL_SIZE},(_,i)=>runtime.game.plan(pull(i)));
for(let i=0;i<200&&active<POOL_SIZE;i++)await new Promise(resolve=>setImmediate(resolve));
assert.equal(active,POOL_SIZE);assert.equal(peak,POOL_SIZE);
await assert.rejects(runtime.game.plan(pull(POOL_SIZE)),/vrf_pool_busy/);release();blockSends=false;await Promise.all(plans);
assert.equal(sends,POOL_SIZE);assert.equal(session.poolLanes.flatMap(lane=>lane.attempts).filter(attempt=>attempt.nonce==="0").length,POOL_SIZE);
await runtime.game.plan(pull(0));assert.equal(sends,POOL_SIZE,"Known pending request is not re-signed");
function fulfill(attempt){
  const value=pending.get(attempt.requestSignature),account=rollup.get(value.address),b=account.data,randomness=Buffer.alloc(32);
  b.writeBigUInt64LE(103n,184);randomness.copy(b,192);b.writeUInt32LE(0,224);b[230]=1;b[231]=1;
  const callback=encodeSignature(Buffer.alloc(64,30+pending.size)),vrf=new PublicKey(manifest.vrfProgram);
  const [identity]=PublicKey.findProgramAddressSync([Buffer.from("identity"),program.toBuffer()],vrf);
  value.callback=callback;transactions.set(callback,{transaction:{message:{instructions:[{programId:vrf}]}},meta:{err:null,innerInstructions:[{instructions:[{
    programId:program,accounts:[identity,new PublicKey(value.address)],data:encodeSignature(Buffer.concat([discriminator("global:consume_er_pool_probe"),randomness,u64(value.nonce)]))}]}]}});
}
const attempt0=session.poolLanes.flatMap(lane=>lane.attempts).find(attempt=>attempt.gamePull.id==="runtime-0");fulfill(attempt0);
const result=await runtime.game.state("runtime-0");assert(result.result.success);assert(result.callbackSignature);
await runtime.game.plan(pull(POOL_SIZE));assert.equal(sends,POOL_SIZE+1);
const reused=session.poolLanes.flatMap(lane=>lane.attempts).find(attempt=>attempt.gamePull.id===`runtime-${POOL_SIZE}`);
assert.equal(reused.requestAuthority,attempt0.requestAuthority);assert.equal(reused.nonce,"1");
assert.equal((await runtime.game.state("runtime-0")).callbackSignature,result.callbackSignature,"Completed receipt survives account reuse");
runtime=await createErPoolRuntime(options);await runtime.game.plan(pull(POOL_SIZE));assert.equal(sends,POOL_SIZE+1,"Runtime restart recovers exact nonce/signature");
const laneIndex=session.poolLanes.findIndex(lane=>lane.attempts.some(attempt=>attempt.gamePull.id===`runtime-${POOL_SIZE}`));
await runtime.plan({lane:laneIndex},"pause");assert.equal(sends,POOL_SIZE+1);
assert((await runtime.status()).lanes[laneIndex].paused);
await assert.rejects(runtime.plan({lane:laneIndex},"return"),/pause_and_finish_pool_attempt_first/);
fulfill(reused);runtime.invalidate();
await assert.rejects(runtime.plan({lane:laneIndex},"return"),/pool_receipt_verification_pending/);
assert((await runtime.game.state(`runtime-${POOL_SIZE}`)).result,"Late callback settles after pause");
assert.equal(session.poolLanes[laneIndex].control,undefined,"Observed pause clears its durable control");
const paused=(await runtime.status()).lanes[laneIndex],delegate=Keypair.fromSecretKey(Uint8Array.from(session.poolLanes[laneIndex].key)).publicKey;
assert.equal(decodeErPoolSession(rollup.get(paused.session),manifest,delegate).usedTotal,2);assert(saves>10);
// Broken or unavailable sessions cannot block verified independent sessions.
const brokenIndex=(laneIndex+1)%POOL_SIZE,brokenKey=Keypair.fromSecretKey(Uint8Array.from(session.poolLanes[brokenIndex].key));
const brokenPda=erPoolDelegationAddresses(manifest,brokenKey.publicKey);
rollup.get(brokenPda.session.toBase58()).owner=SystemProgram.programId;
runtime.invalidate();const degraded=await runtime.status();
assert.equal(degraded.lanes[brokenIndex].phase,"unavailable");assert(degraded.ready);
await assert.rejects(runtime.plan({lane:brokenIndex}),/pool_lane_verification_failed/);
const emptyIndex=(laneIndex+2)%POOL_SIZE,emptyKey=Keypair.fromSecretKey(Uint8Array.from(session.poolLanes[emptyIndex].key)),emptyPda=erPoolDelegationAddresses(manifest,emptyKey.publicKey);
base.delete(emptyPda.session.toBase58());base.get(emptyKey.publicKey.toBase58()).lamports=0;runtime.invalidate();
const setup=await runtime.plan({lane:emptyIndex});
assert.equal(setup.instructions.length,2);assert(setup.instructions[0].programId.equals(SystemProgram.programId));
assert(setup.instructions[1].data.subarray(0,8).equals(discriminator("global:initialize_er_pool_session")));
assert(setup.instructions.every(instruction=>instruction.keys.filter(key=>key.isSigner).every(key=>key.pubkey.equals(admin))),"Only the owner can approve initial funding and limits");
await assert.rejects(runtime.plan({lane:emptyIndex,totalLimit:999999}),/invalid_pool_lane/);
delete manifest.verifiedArtifact.capabilities;
await assert.rejects(runtime.plan({lane:emptyIndex}),/pool_program_upgrade_required/);
manifest.verifiedArtifact.capabilities=["bounded-er-pool-v1"];
// Upgrade a live four-session store. Missing new accounts must not block healthy
// old lanes or make the four new lanes ready before the owner's approvals.
const original=session.poolLanes.slice(0,4),upgradedSession={poolLanes:structuredClone(original)};
const upgraded=await createErPoolRuntime({...options,session:upgradedSession});
const upgradedStatus=await upgraded.status();assert.equal(upgradedStatus.lanes.length,8);
assert.deepEqual(upgradedSession.poolLanes.slice(0,4),original);
assert(upgradedStatus.ready,"Existing healthy sessions remain available");
assert(upgradedStatus.lanes.slice(4).every(lane=>!lane.ready&&lane.phase==="initialize"));
assert.equal(upgradedStatus.remaining,upgradedStatus.lanes.slice(0,4).reduce((sum,lane)=>sum+lane.remaining,0));
const beforeUpgradeRetry=sends;await upgraded.game.plan(pull(3));
assert.equal(sends,beforeUpgradeRetry,"A pre-migration pending draw keeps its existing request/signature");
const planTime=Math.floor(Date.now()/1000),newLanePlan=await upgraded.plan({lane:7});
assert.equal(newLanePlan.kind,"er-pool-policy");assert.equal(newLanePlan.instructions.length,2);
const expiry=Number(newLanePlan.instructions[1].data.readBigInt64LE(72));
assert(expiry>=planTime+POOL_POLICY.lifetimeSeconds-POOL_POLICY_CLOCK_MARGIN);
assert(expiry<=Math.floor(Date.now()/1000)+POOL_POLICY.lifetimeSeconds-POOL_POLICY_CLOCK_MARGIN);
assert(POOL_POLICY_CLOCK_MARGIN>=30,"A new grant must leave a usable chain-clock margin");
assert(newLanePlan.instructions.every(instruction=>instruction.keys.filter(key=>key.isSigner).every(key=>key.pubkey.equals(admin))));
console.log("PASS: actual eight-lane runtime signs isolated ER transactions in parallel, retains callbacks through account reuse/restart, and migrates four live lanes without activating new accounts before owner approval.");
