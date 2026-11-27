import assert from "node:assert/strict";
import {createHash,createPrivateKey,sign} from "node:crypto";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Keypair,PublicKey} from "@solana/web3.js";
import {createPoolGame} from "./lib/vrf-pool-game.mjs";
import {createClawLedger} from "./lib/claw-ledger.mjs";
import {loadClawRules} from "./lib/vrf-game.mjs";
import {createAttemptReader} from "./lib/vrf-callbacks.mjs";
import {discriminator,matchesCallback,u64} from "./lib/vrf-deployment.mjs";
import {encodeSignature} from "./lib/vrf-sponsor.mjs";
import {ER_VALIDATOR,decodeErAttempt,decodeErSession} from "./lib/vrf-er.mjs";
import {POOL_SIZE,POOL_POLICY,erPoolAddress,initializeErPoolSession,delegateErPoolSession,requestErPoolProbe,
  pauseErPoolSession,undelegateErPoolSession,decodeErPoolSession,decodeErPoolAttempt,poolCapacity} from "./lib/vrf-er-pool.mjs";

const manifest=JSON.parse(await readFile(new URL("../onchain/deployment.devnet.json",import.meta.url),"utf8"));
const program=new PublicKey(manifest.vrfProbeProgram),admin=new PublicKey(manifest.adminAuthority),now=Math.floor(Date.now()/1000);
assert.equal(POOL_SIZE,8);
const delegates=Array.from({length:POOL_SIZE},()=>Keypair.generate().publicKey),policy={...POOL_POLICY,authorizedUntil:now+604800};
const init=initializeErPoolSession(manifest,delegates[0],policy);
assert.equal(init.data.length,98);assert.equal(init.data.readUInt16LE(80),500);
assert.equal(init.data.readUInt32LE(90),1000);assert.equal(init.data.readUInt32LE(94),7000);
assert.deepEqual(init.keys.filter(key=>key.isSigner).map(key=>key.pubkey.toBase58()),[admin.toBase58()]);
assert.equal(initializeErPoolSession(manifest,delegates[0],policy,true).data.length,34);
assert.throws(()=>initializeErPoolSession(manifest,delegates[0],{...policy,batchRequests:501}),/invalid_pool_policy/);
const delegation=delegateErPoolSession(manifest,delegates[0]);
assert.deepEqual(delegation.keys.filter(key=>key.isSigner).map(key=>key.pubkey.toBase58()),[admin.toBase58()]);
assert(pauseErPoolSession(manifest,delegates[0]).keys[0].pubkey.equals(delegates[0]));
assert.equal(undelegateErPoolSession(manifest,delegates[0]).keys.length,4);
assert.equal(new Set(delegates.map(delegate=>erPoolAddress(manifest,delegate)[0].toBase58())).size,POOL_SIZE);
const accounts=new Map();
function accountFor(delegate,roll=0) {
  const b=Buffer.alloc(280),[address,bump]=erPoolAddress(manifest,delegate);
  discriminator("account:ErPoolSession").copy(b);admin.toBuffer().copy(b,8);delegate.toBuffer().copy(b,40);ER_VALIDATOR.toBuffer().copy(b,72);
  b.writeBigInt64LE(BigInt(now+100),104);b.writeUInt16LE(499,112);b.writeBigUInt64LE(1n,114);b[122]=1;b[123]=bump;
  delegate.toBuffer().copy(b,124);b.writeUInt16LE(64,164);b.writeUInt16LE(7,166);b.writeBigUInt64LE(2147483648n,168);
  b.writeBigUInt64LE(100n,176);b.writeBigUInt64LE(103n,184);b.writeUInt32LE(roll,192);b.writeUInt32LE(roll,224);b[230]=roll<2147483648?1:0;b[231]=1;b[232]=bump;
  b.writeBigInt64LE(BigInt(policy.authorizedUntil),233);b.writeUInt16LE(500,241);b.writeBigInt64LE(21600n,243);
  b.writeUInt32LE(1000,251);b.writeUInt32LE(2000,255);b.writeUInt32LE(1,259);b.writeUInt32LE(1,263);
  b.writeBigInt64LE(BigInt(Math.floor(now/86400)),267);b.writeUInt32LE(1,276);
  const account={owner:program,data:b};accounts.set(address.toBase58(),account);return account;
}
const firstAccount=accountFor(delegates[0]),decoded=decodeErPoolSession(firstAccount,manifest,delegates[0]);
assert.equal(poolCapacity(decoded,now),999);
assert.equal(poolCapacity({...decoded,paused:true},now),0);
assert.equal(poolCapacity({...decoded,authorizedUntil:now},now),0);
assert.equal(poolCapacity({...decoded,usedToday:1000},now),0);
assert.equal(poolCapacity({...decoded,usedToday:1000},(decoded.day+1)*86400),1000);
assert.equal(poolCapacity({...decoded,usedTotal:2000},now),0);
assert.equal(poolCapacity({...decoded,day:decoded.day+1},now),0);
assert.throws(()=>decodeErSession(firstAccount,manifest,delegates[0]),/er_session_mismatch/);
for(const offset of [0,8,40,72,123,232,241,254,258,263,275]){
  const changed={...firstAccount,data:Buffer.from(firstAccount.data)};changed.data[offset]^=255;
  assert.throws(()=>decodeErPoolSession(changed,manifest,delegates[0]),undefined,`Reject corrupted pool binding at ${offset}`);
}
const lockedFor=delegate=>{
  const request=requestErPoolProbe(manifest,delegate,"0",64,7,"2147483648",Buffer.alloc(32));
  assert(request.instruction.data.subarray(0,8).equals(discriminator("global:request_er_pool_probe")));
  return {nonce:"0",count:64,target:7,threshold:"2147483648",attempt:request.attempt.toBase58(),bump:request.bump,requestAuthority:delegate.toBase58(),requestSignature:"request"};
};
const lockedA=lockedFor(delegates[0]),lockedB=lockedFor(delegates[1]);accountFor(delegates[1],0xffffffff);
assert.equal(decodeErPoolAttempt(firstAccount,manifest,lockedA).success,true);
assert.throws(()=>decodeErAttempt(firstAccount,manifest,lockedA));
assert.throws(()=>decodeErPoolAttempt(firstAccount,manifest,lockedB));
assert.equal(decodeErPoolAttempt(firstAccount,manifest,{...lockedA,nonce:"1"}),null);
// Equal nonces across lanes must never share a read promise or callback receipt.
const vrf=new PublicKey(manifest.vrfProgram),[identity]=PublicKey.findProgramAddressSync([Buffer.from("identity"),program.toBuffer()],vrf);
const callbacks=new Map([lockedA,lockedB].map((locked,i)=>{
  const signature=encodeSignature(Buffer.alloc(64,20+i)),randomness=accounts.get(locked.attempt).data.subarray(192,224);
  return [locked.attempt,{signature,tx:{transaction:{message:{instructions:[{programId:vrf}]}},meta:{err:null,innerInstructions:[{instructions:[{
    programId:program,accounts:[identity,new PublicKey(locked.attempt)],data:encodeSignature(Buffer.concat([discriminator("global:consume_er_pool_probe"),randomness,u64(0)]))}]}]}}}];
}));
const reader=createAttemptReader({manifest,save:async()=>{},decode:decodeErPoolAttempt,
  callback:(tx,c,l,result)=>matchesCallback(tx,c,l,result,"consume_er_pool_probe"),
  hints:locked=>[{signature:callbacks.get(locked.attempt).signature,slot:103}],
  connection:{getAccountInfo:async address=>accounts.get(address.toBase58()),getParsedTransaction:async signature=>[...callbacks.values()].find(value=>value.signature===signature).tx}});
await Promise.all([reader(lockedA),reader(lockedB)]);
assert.equal(lockedA.result.success,true);assert.equal(lockedB.result.success,false);
assert.notEqual(lockedA.callbackSignature,lockedB.callbackSignature);

const rules=await loadClawRules(),boxes=rules.createPile(42);
let releaseSend;const sendGate=new Promise(resolve=>{releaseSend=resolve;});
let gate=true,active=0,peak=0,saves=0;const settled=new Set(),sent=new Set(),attemptStores=Array.from({length:POOL_SIZE},()=>[]);
const routing={},save=async()=>{saves++;},hash=pull=>createHash("sha256").update(JSON.stringify(pull)).digest("hex");
const lanes=attemptStores.map((attempts,index)=>{
  const result=id=>{
    const attempt=attempts.find(item=>item.gamePull.id===id);if(!attempt)return {pending:false,result:null,notFound:true};
    const resolved=settled.has(id)?rules.resolvePull(attempt.gamePull,()=>0,"magicblock-vrf"):null;
    if(resolved)attempt.callbackSignature="callback-"+index+"-"+id;
    return {gameId:id,pending:!resolved,submitted:sent.has(id),result:resolved,pull:attempt.gamePull,
      requestSignature:sent.has(id)?"request-"+index+"-"+id:null,callbackSignature:attempt.callbackSignature??null};
  };
  return {id:"lane-"+index,attempts:()=>attempts,has:id=>attempts.some(item=>item.gamePull.id===id),available:async()=>({ready:true,pending:false}),
    game:{async plan(pull){
      assert.equal(routing.assignments[pull.id].lane,"lane-"+index,"Route must be persisted before send");
      let attempt=attempts.find(item=>item.gamePull.id===pull.id);
      if(!attempt){attempt={gamePull:structuredClone(pull),gameFingerprint:hash(pull)};attempts.push(attempt);}
      active++;peak=Math.max(peak,active);if(gate)await sendGate;active--;sent.add(pull.id);return result(pull.id);
    },state:async id=>result(id),recordTiming:async()=>({saved:true})}};
});
const pool=createPoolGame({store:routing,lanes,save});
const basePull={id:"concurrent-0",rulesVersion:rules.RULES_VERSION,aim:rules.startingAim(boxes),tier:0,currency:"USDC",priceUsd:2};
basePull.target=rules.selectTarget(basePull.aim,boxes,0);
const pulls=Array.from({length:POOL_SIZE},(_,i)=>({...basePull,id:"concurrent-"+i}));
const plans=pulls.map(pull=>pool.plan(pull));
// Yield actual work until all eight distinct lanes reach their simulated sends.
for(let i=0;i<100&&active<POOL_SIZE;i++)await new Promise(resolve=>setImmediate(resolve));
assert.equal(active,POOL_SIZE);assert.equal(peak,POOL_SIZE);assert.equal(new Set(Object.values(routing.assignments).map(value=>value.lane)).size,POOL_SIZE);
await assert.rejects(pool.plan({...basePull,id:"ninth"}),/vrf_pool_busy/);
const duplicate=pool.plan(pulls[0]);await assert.rejects(pool.plan({...pulls[0],priceUsd:999}),/game_attempt_inputs_changed/);
releaseSend();gate=false;await Promise.all([...plans,duplicate]);assert.equal(attemptStores.flat().length,POOL_SIZE);
const selected=routing.assignments[pulls[0].id].lane;
await pool.plan(pulls[0]);assert.equal(routing.assignments[pulls[0].id].lane,selected,"Retry is pinned");
const restarted=createPoolGame({store:structuredClone(routing),lanes,save});
await restarted.plan(pulls[0]);assert.equal(attemptStores.flat().length,POOL_SIZE,"Restart never creates a replacement draw");
settled.add(pulls[0].id);assert((await pool.state(pulls[0].id)).result);
const completedSaves=saves;
await pool.state(pulls[0].id);await pool.state(pulls[0].id);
assert.equal(saves,completedSaves,"Completed result reads must not rewrite the encrypted routing state");
await pool.plan({...basePull,id:"ninth"});assert.equal(routing.assignments.ninth.lane,selected);
await assert.rejects(pool.plan({...pulls[0],tier:1}),/game_attempt_inputs_changed/);
const broken=structuredClone(routing);broken.assignments.ninth.lane="missing";
assert.throws(()=>createPoolGame({store:broken,lanes,save}),/invalid_vrf_pool_store/);
assert.equal((await pool.state("unknown")).notFound,true);assert(saves>4);
// A failed broadcast keeps its lease across restart, never switching lanes.
const failureStore={},failureAttempts=[];
const failureLane={id:"failure",attempts:()=>failureAttempts,has:()=>false,available:async()=>({ready:true,pending:false}),
  game:{plan:async()=>{throw Error("ambiguous_rpc_timeout");},state:async()=>({pending:true,result:null})}};
const failing=createPoolGame({store:failureStore,lanes:[failureLane],save:async()=>{}});
await assert.rejects(failing.plan(basePull),/ambiguous_rpc_timeout/);
assert.equal(failureStore.assignments[basePull.id].phase,"active");
await assert.rejects(failing.plan({...basePull,id:"replacement"}),/vrf_pool_busy/);
const failedRestart=createPoolGame({store:structuredClone(failureStore),lanes:[failureLane],save:async()=>{}});
await assert.rejects(failedRestart.plan({...basePull,id:"replacement"}),/vrf_pool_busy/);

// Exercise eight real authenticated ledger reservations and a queued ninth.
for(const pull of pulls)settled.add(pull.id);settled.add("ninth");await pool.recover();
const folder=await mkdtemp(join(tmpdir(),"cato-pool-")),origin="http://127.0.0.1:4322";
let ledger;
try{
  ledger=createClawLedger({filename:join(folder,"ledger.sqlite"),origin,rules,physics:{create:async()=>structuredClone(boxes),settle:async pile=>pile},game:pool,available:async()=>true});
  const wallets=Array.from({length:POOL_SIZE+1},()=>Keypair.generate()),players=[];
  for(const key of wallets){
    const wallet=key.publicKey.toBase58(),challenge=ledger.challenge(wallet);
    const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),Buffer.from(key.secretKey.subarray(0,32))]),format:"der",type:"pkcs8"});
    await ledger.login({id:challenge.id,wallet,signature:sign(null,Buffer.from(challenge.message),privateKey).toString("hex")});
    const state=await ledger.state(wallet);players.push({wallet,state});
  }
  const responses=await Promise.all(players.map(({wallet,state},i)=>ledger.play(wallet,{requestId:"player-"+i,revision:state.revision,aim:basePull.aim,tier:0})));
  await ledger.idle();
  assert.equal(pool.status().occupied,POOL_SIZE);
  assert.equal(responses.filter(response=>sent.has(response.id)).length,POOL_SIZE,"Ledger must dispatch multiple players concurrently");
  for(const {wallet}of players)assert.equal((await ledger.state(wallet)).balances[0],9);
  const queued=responses.find(response=>!sent.has(response.id));assert(queued);
  assert.equal((await ledger.state(players[responses.indexOf(queued)].wallet)).pending.error,"vrf_pool_busy_retry_same_attempt");
  const first=responses.find(response=>sent.has(response.id));settled.add(first.id);
  const firstWallet=players[responses.indexOf(first)].wallet;
  const [a,b]=await Promise.all([ledger.result(firstWallet,first.id),ledger.result(firstWallet,first.id)]);
  assert.equal(a.result.cents,b.result.cents);assert.equal((await ledger.state(firstWallet)).winningsCents,a.result.cents);
  await ledger.tick();await ledger.idle();assert(sent.has(queued.id),"Queued reservation is retried without another debit");
  assert.equal((await ledger.state(players[responses.indexOf(queued)].wallet)).balances[0],9);
}finally{await ledger?.idle();ledger?.close();await rm(folder,{recursive:true,force:true});}
console.log("PASS: isolated pool wire/account binding; equal-nonce callback isolation; eight concurrent authenticated players; durable lane leases; pinned timeout/restart recovery; bounded policy decoding; queued ninth attempt and exact-once credit.");
await import("./test-vrf-pool-store.mjs");
await import("./test-vrf-pool-runtime.mjs");
