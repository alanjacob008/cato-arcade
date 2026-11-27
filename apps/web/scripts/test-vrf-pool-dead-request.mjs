// A lane request rejected at preflight when the lane's policy expires (validator clock ahead of the
// backend) must not wedge the lane. Real runtime, signer, sender, reader and router against an
// in-memory RPC: no network. Covers: release only when the request provably never landed, return and
// renewal of the lane, and the identical request (same nonce/seed/target/threshold) settling once.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Keypair,PublicKey,SendTransactionError,SystemProgram,VersionedTransaction} from "@solana/web3.js";
import {createErPoolRuntime} from "./lib/vrf-er-pool-runtime.mjs";
import {loadClawRules} from "./lib/vrf-game.mjs";
import {discriminator,u64} from "./lib/vrf-deployment.mjs";
import {encodeSignature} from "./lib/vrf-sponsor.mjs";
import {DELEGATION_PROGRAM,ER_VALIDATOR} from "./lib/vrf-er.mjs";
import {POOL_SIZE,erPoolDelegationAddresses} from "./lib/vrf-er-pool.mjs";

const manifest=JSON.parse(await readFile(new URL("../onchain/deployment.devnet.json",import.meta.url),"utf8"));
manifest.verifiedArtifact.capabilities=["bounded-er-pool-v1"];
const program=new PublicKey(manifest.vrfProbeProgram),admin=new PublicKey(manifest.adminAuthority),now=Math.floor(Date.now()/1000);
let session={poolLanes:Array.from({length:POOL_SIZE},(_,i)=>({id:"lane-"+(i+1),key:Array.from(Keypair.generate().secretKey),attempts:[]}))};
const keys=session.poolLanes.map(lane=>Keypair.fromSecretKey(Uint8Array.from(lane.key))),pdas=keys.map(key=>erPoolDelegationAddresses(manifest,key.publicKey));
const base=new Map(),rollup=new Map(),transactions=new Map(),receipts=new Map(),landed=new Map();
const accountOf=index=>rollup.get(pdas[index].session.toBase58()).data;
// Writes the lane policy's expiry (and pause flag); the grant expiry never exceeds the policy.
function setPolicy(index,authorizedUntil,paused=false){const b=accountOf(index);b.writeBigInt64LE(BigInt(authorizedUntil),233);
  if(b.readBigInt64LE(104)>BigInt(authorizedUntil))b.writeBigInt64LE(BigInt(authorizedUntil),104);b[275]=paused?1:0;}
keys.forEach((key,i)=>{
  const p=pdas[i],b=Buffer.alloc(280),bump=PublicKey.findProgramAddressSync([Buffer.from("er-pool"),admin.toBuffer(),key.publicKey.toBuffer()],program)[1];
  discriminator("account:ErPoolSession").copy(b);admin.toBuffer().copy(b,8);key.publicKey.toBuffer().copy(b,40);ER_VALIDATOR.toBuffer().copy(b,72);
  b.writeBigInt64LE(BigInt(now),104);b[123]=bump;key.publicKey.toBuffer().copy(b,124);b.writeUInt16LE(64,164);b[231]=1;b[232]=bump;
  b.writeBigInt64LE(BigInt(now+600),233);b.writeUInt16LE(500,241);b.writeBigInt64LE(21600n,243);b.writeUInt32LE(1000,251);b.writeUInt32LE(2000,255);
  b.writeBigInt64LE(BigInt(Math.floor(now/86400)),267);
  const record=Buffer.alloc(96);record.writeBigUInt64LE(100n);ER_VALIDATOR.toBuffer().copy(record,8);program.toBuffer().copy(record,40);
  base.set(p.session.toBase58(),{owner:DELEGATION_PROGRAM,data:Buffer.alloc(0)});base.set(p.record.toBase58(),{owner:DELEGATION_PROGRAM,data:record});
  base.set(key.publicKey.toBase58(),{owner:SystemProgram.programId,lamports:5000000,data:Buffer.alloc(0)});
  rollup.set(p.session.toBase58(),{owner:program,data:b});
});
const snapshot=account=>account?{...account,data:Buffer.from(account.data)}:null;

// The ER: the validator clock runs ahead of the backend, so while `validatorAhead` is set every request
// is rejected at preflight with PoolPolicyInactive and nothing lands (no signature status at all).
let validatorAhead=true,finalizedHeight=1000,blockhashes=0,onHeightRead=null;const requests=[];
function land(bytes){
  const tx=VersionedTransaction.deserialize(bytes),message=tx.message,ix=message.compiledInstructions.at(-1),data=Buffer.from(ix.data);
  const address=message.staticAccountKeys[ix.accountKeyIndexes[1]].toBase58(),b=rollup.get(address).data,signature=encodeSignature(tx.signatures[0]);
  const nonce=data.readBigUInt64LE(8);assert.equal(nonce,b.readBigUInt64LE(114),"Only the account's next nonce can land");assert.equal(b[231],1,"No pending attempt is overwritten");
  b.writeBigUInt64LE(nonce+1n,114);b[122]=1;data.subarray(8,28).copy(b,156);b.writeBigUInt64LE(100n,176);b.writeBigUInt64LE(0n,184);b.fill(0,192,232);b[231]=0;
  b.writeUInt16LE(499,112);b.writeBigInt64LE(BigInt(Math.min(now+21600,Number(b.readBigInt64LE(233)))),104);
  b.writeUInt32LE(b.readUInt32LE(259)+1,259);b.writeUInt32LE(b.readUInt32LE(263)+1,263);b.writeUInt32LE(1,276);
  landed.set(signature,{address,nonce});receipts.set(signature,{err:null,confirmationStatus:"confirmed"});return signature;
}
const connection={getMultipleAccountsInfo:async ids=>ids.map(id=>snapshot(base.get(id.toBase58())))};
const executionConnection={
  getMultipleAccountsInfo:async ids=>ids.map(id=>snapshot(rollup.get(id.toBase58()))),
  getAccountInfo:async id=>snapshot(rollup.get(id.toBase58())),
  getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:finalizedHeight+150+(++blockhashes)}),
  getBlockHeight:async()=>{const hook=onHeightRead;onHeightRead=null;hook?.();return finalizedHeight;},
  getSignatureStatuses:async signatures=>({value:signatures.map(signature=>receipts.get(signature)??null)}),
  getSignaturesForAddress:async address=>[...landed.values()].filter(value=>value.address===address.toBase58()&&value.callback).map(value=>({signature:value.callback,err:null})).reverse(),
  getParsedTransaction:async signature=>transactions.get(signature)??null,
  async sendRawTransaction(bytes){
    const tx=VersionedTransaction.deserialize(bytes),message=tx.message,ix=message.compiledInstructions.at(-1),data=Buffer.from(ix.data),signature=encodeSignature(tx.signatures[0]);
    assert(message.staticAccountKeys[ix.programIdIndex].equals(program));
    const address=message.staticAccountKeys[ix.accountKeyIndexes[1]].toBase58(),b=rollup.get(address).data;
    if(data.subarray(0,8).equals(discriminator("global:pause_er_pool_session"))){b[275]=1;receipts.set(signature,{err:null,confirmationStatus:"confirmed"});return signature;}
    if(data.subarray(0,8).equals(discriminator("global:undelegate_er_pool_session"))){
      assert.equal(b[275],1,"Only a paused lane returns");assert.equal(b[231],1,"No pending attempt is returned");
      base.set(address,{owner:program,data:Buffer.from(b)});receipts.set(signature,{err:null,confirmationStatus:"confirmed"});return signature;
    }
    assert(data.subarray(0,8).equals(discriminator("global:request_er_pool_probe")));
    const request={address,signature,content:data.subarray(8).toString("hex"),accepted:!validatorAhead&&!b[275]&&Number(b.readBigInt64LE(233))>now};
    requests.push(request);
    if(!request.accepted)throw new SendTransactionError({action:"simulate",signature:"",transactionMessage:"Transaction simulation failed: custom program error: PoolPolicyInactive",logs:["PoolPolicyInactive"]});
    return land(bytes);
  },
};
function fulfill(attempt){
  const value=landed.get(attempt.requestSignature),b=rollup.get(value.address).data,randomness=Buffer.alloc(32);
  b.writeBigUInt64LE(103n,184);randomness.copy(b,192);b.writeUInt32LE(0,224);b[230]=1;b[231]=1;
  const callback=encodeSignature(Buffer.alloc(64,40+landed.size)),vrf=new PublicKey(manifest.vrfProgram);
  const [identity]=PublicKey.findProgramAddressSync([Buffer.from("identity"),program.toBuffer()],vrf);
  value.callback=callback;transactions.set(callback,{transaction:{message:{instructions:[{programId:vrf}]}},meta:{err:null,innerInstructions:[{instructions:[{
    programId:program,accounts:[identity,new PublicKey(value.address)],data:encodeSignature(Buffer.concat([discriminator("global:consume_er_pool_probe"),randomness,u64(value.nonce)]))}]}]}});
}

const rules=await loadClawRules(),boxes=rules.createPile(42),aim=rules.startingAim(boxes);
const pull=i=>({id:"wedge-"+i,rulesVersion:rules.RULES_VERSION,aim,target:rules.selectTarget(aim,boxes,0),tier:0,currency:"USDC",priceUsd:2});
const options={manifest,save:async()=>{},connection,executionConnection,rules,identity:async()=>true,verified:async()=>true,deployed:async()=>true,
  legacy:{has:()=>false,game:{plan:async()=>{throw Error("unexpected_legacy_route");}}}};
let runtime=await createErPoolRuntime({...options,session});assert((await runtime.status()).enabled,"Pool mode latches on once lanes are ready");
const attemptOf=id=>session.poolLanes.flatMap(lane=>lane.attempts).find(attempt=>attempt.gamePull?.id===id);
const laneOf=id=>session.poolLanes.findIndex(lane=>lane.attempts.some(attempt=>attempt.gamePull?.id===id));
const locked=attempt=>({nonce:attempt.nonce,seed:attempt.seed,target:attempt.target,threshold:attempt.threshold,attempt:attempt.attempt,requestAuthority:attempt.requestAuthority});
async function pauseLane(index){await runtime.plan({lane:index},"pause");runtime.invalidate();assert((await runtime.status()).lanes[index].paused);}

// 1. Three plays reach three lanes while the backend still sees capacity; every request is rejected at preflight.
for(let i=0;i<3;i++)await assert.rejects(runtime.game.plan(pull(i)),/Simulation failed/);
const lanes=[0,1,2].map(i=>laneOf("wedge-"+i));assert.equal(new Set(lanes).size,3);
const original=[0,1,2].map(i=>({...locked(attemptOf("wedge-"+i)),requestSignature:attemptOf("wedge-"+i).requestSignature,content:requests[i].content}));
for(let i=0;i<3;i++){const attempt=attemptOf("wedge-"+i);assert(attempt.requestSignature&&attempt.sponsorWire&&attempt.preflightRejected);assert.equal(attempt.nonce,"0");}
// The lanes' policies then expire on chain as well (backend clock catches up).
for(const index of lanes)setPolicy(index,now-10);runtime.invalidate();

// 2. A request that might still land is never released: the blockhash has not expired yet.
await assert.rejects(runtime.game.plan(pull(2)),/sponsor_setup_required/);
assert.equal(attemptOf("wedge-2").requestSignature,original[2].requestSignature);assert(attemptOf("wedge-2").sponsorWire);
await pauseLane(lanes[0]);
await assert.rejects(runtime.plan({lane:lanes[0]},"return"),/pool_receipt_verification_pending/,"An unexpired request still blocks return");
assert.equal(attemptOf("wedge-0").requestSignature,original[0].requestSignature);

// 3. The finalized height passes every saved request's lastValidBlockHeight.
finalizedHeight=5000;
// 3a. A request that did land (seen only on the read after expiry was observed) is kept, not re-signed, and settles once.
onHeightRead=()=>land(Buffer.from(attemptOf("wedge-1").sponsorWire,"base64"));
const sendsBefore=requests.length;
await runtime.game.plan(pull(1));
assert.equal(requests.length,sendsBefore,"A landed request is never re-signed or rebroadcast");
assert.equal(attemptOf("wedge-1").requestSignature,original[1].requestSignature);assert.equal(attemptOf("wedge-1").failedRequestSignature,undefined);
fulfill(attemptOf("wedge-1"));const landedResult=await runtime.game.state("wedge-1");assert(landedResult.result&&landedResult.callbackSignature);
// 3b. Sender path: before the permit gate, the dead request is released; the gate then still refuses (no capacity).
await assert.rejects(runtime.game.plan(pull(2)),/sponsor_setup_required/);
// 3c. Return path: the paused lane's dead request (not retried since expiry) is released by the return action itself.
assert.equal(attemptOf("wedge-0").requestSignature,original[0].requestSignature);assert(attemptOf("wedge-0").sponsorWire);
const returned=await runtime.plan({lane:lanes[0]},"return");assert(returned.done);
for(const i of [0,2]){
  const attempt=attemptOf("wedge-"+i);
  assert.equal(attempt.requestSignature,undefined);assert.equal(attempt.sponsorWire,undefined);
  assert.equal(attempt.failedRequestSignature,original[i].requestSignature,"The dead signature is kept for audit");
  const {requestSignature,content,...fixed}=original[i];assert.deepEqual(locked(attempt),fixed,"Nonce, seed, target, threshold and lane are unchanged");
  assert.equal(session.poolRouting.assignments["wedge-"+i].phase,"active");assert.equal(laneOf("wedge-"+i),lanes[i]);
}
assert.equal(requests.length,sendsBefore,"Releasing never sends");
await pauseLane(lanes[2]);assert((await runtime.plan({lane:lanes[2]},"return")).done,"The released lane can be returned");
runtime.invalidate();await runtime.status();

// 4. Restart from the saved state, then the owner renews both lanes' policies and delegates them again.
session=structuredClone(session);runtime=await createErPoolRuntime({...options,session});
for(const index of [lanes[0],lanes[2]]){
  setPolicy(index,now+604800);base.set(pdas[index].session.toBase58(),{owner:DELEGATION_PROGRAM,data:Buffer.alloc(0)});
}
validatorAhead=false;runtime.invalidate();
assert((await runtime.status()).lanes[lanes[0]].ready);

// 5. Retries re-sign the identical request (same nonce, count, target, threshold and seed) and it settles exactly once.
for(const i of [0,2]){
  const before=requests.length;
  await runtime.game.plan(pull(i));
  const resent=requests.slice(before);assert.equal(resent.length,1);assert(resent[0].accepted);
  assert.equal(resent[0].content,original[i].content,"The rebuilt request is byte-identical apart from the blockhash");
  assert.notEqual(resent[0].signature,original[i].requestSignature);
  const attempt=attemptOf("wedge-"+i);assert.equal(attempt.requestSignature,resent[0].signature);
  fulfill(attempt);
  const first=await runtime.game.state("wedge-"+i);assert(first.result);
  await runtime.game.plan(pull(i));await runtime.game.recover();const again=await runtime.game.state("wedge-"+i);
  assert.deepEqual(again.result,first.result);assert.equal(again.callbackSignature,first.callbackSignature);
  assert.equal(requests.length,before+1,"No further request after it landed");
  assert.equal(session.poolRouting.assignments["wedge-"+i].phase,"complete");
  assert.equal(session.poolLanes.flatMap(lane=>lane.attempts).filter(item=>item.gamePull?.id==="wedge-"+i).length,1,"One attempt per play");
  assert.equal(requests.filter(request=>request.accepted&&request.content===original[i].content).length,1,"Exactly one request for this nonce landed");
}
console.log("PASS: a lane request rejected at preflight at policy expiry is released only once it provably never landed, the lane returns and renews, and the identical nonce/seed request settles exactly once; landed or unexpired requests are never released.");
