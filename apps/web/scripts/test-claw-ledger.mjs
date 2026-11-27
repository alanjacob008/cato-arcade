import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, sign, randomUUID } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import { Keypair } from "@solana/web3.js";
import { createClawLedger } from "./lib/claw-ledger.mjs";
import { createPlayerApi } from "./lib/claw-player-api.mjs";
import { loadClawRules } from "./lib/vrf-game.mjs";
import { createLedgerPhysics } from "./lib/claw-ledger-physics.mjs";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";

const folder=await mkdtemp(join(tmpdir(),"cato-ledger-test-")),filename=join(folder,"ledger.sqlite");
const creations=[];let physicsBusy=false;
const rules=await loadClawRules(),boxes=rules.createPile(2026),physics={create:async(seed,options)=>{if(physicsBusy&&options?.newWallet)throw Error("claw_service_busy_retry");creations.push(options??null);return structuredClone(boxes);},settle:async value=>structuredClone(value)};
const rows=table=>{const db=new DatabaseSync(filename,{readOnly:true});try{return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;}finally{db.close();}};
const origin="http://127.0.0.1:4322",alice=Keypair.generate(),bob=Keypair.generate();let clock=Date.UTC(2026,9,28),ready=true,plans=0;
const pulls=new Map(),released=new Set();let corrupt=false,fixtureRoll=0;
const receipt=pull=>({gameId:pull.id,pull,requestSignature:"request-"+pull.id,callbackSignature:"callback-"+pull.id,
  result:released.has(pull.id)?{...rules.resolvePull(pull,()=>fixtureRoll,"magicblock-vrf"),...(corrupt?{cents:999999}: {})}:null});
const game={async plan(pull){plans++;if(pulls.has(pull.id))assert.deepEqual(pulls.get(pull.id),pull);pulls.set(pull.id,structuredClone(pull));return receipt(pull);},async state(id){const pull=pulls.get(id);return pull?receipt(pull):{notFound:true};}};
const options={filename,origin,rules,physics,game,available:async()=>ready,now:()=>clock};let ledger=createClawLedger(options);
function proof(key,challenge){const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),Buffer.from(key.secretKey.subarray(0,32))]),format:"der",type:"pkcs8"});return {id:challenge.id,wallet:key.publicKey.toBase58(),signature:sign(null,Buffer.from(challenge.message),privateKey).toString("hex")};}
async function login(key){return ledger.login(proof(key,ledger.challenge(key.publicKey.toBase58())));}
const wallet=alice.publicKey.toBase58(),other=bob.publicKey.toBase58();
try {
  const challenge=ledger.challenge(wallet),signed=proof(alice,challenge);
  await assert.rejects(ledger.login({...signed,signature:"00".repeat(64)}),/invalid_wallet_proof/);
  const auth=await ledger.login(signed);assert.equal(ledger.authenticate(auth.token),wallet);
  await assert.rejects(ledger.login(signed),/invalid_wallet_proof/);
  assert.deepEqual(creations,[{newWallet:true}],"First sign-in creates the pile in the bounded new-wallet lane");
  // A client cannot sign a proof now for a future "Issued" time: only nonces this server issued are accepted.
  {const start=clock,later=clock+120_000,nonce="ab".repeat(32);
    const message=challenge.message.replace(/^Nonce: .*$/m,`Nonce: ${nonce}`).replace(/^Issued: .*$/m,`Issued: ${later}`).replace(/^Expires: .*$/m,`Expires: ${later+60_000}`);
    const presigned=proof(alice,{id:`${nonce}.${later}`,message});clock=later+1;
    await assert.rejects(ledger.login(presigned),/invalid_wallet_proof/,"pre-signed future proof is refused when its window arrives");clock=start;}
  // Bad signatures and forged nonces are refused before any database write or pile creation.
  {const carol=Keypair.generate(),carolWallet=carol.publicKey.toBase58(),before=["players","challenges","sessions","entries"].map(rows),made=creations.length;
    const fresh=ledger.challenge(carolWallet),good=proof(carol,fresh);
    await assert.rejects(ledger.login({...good,signature:"00".repeat(64)}),/invalid_wallet_proof/);
    await assert.rejects(ledger.login({...good,id:`${"cd".repeat(16)}${fresh.id.slice(32)}`}),/invalid_wallet_proof/);
    assert.deepEqual(["players","challenges","sessions","entries"].map(rows),before);assert.equal(creations.length,made,"No pile is created for an unverified sign-in");
    // A busy new-wallet lane returns a retryable error without consuming the proof.
    physicsBusy=true;await assert.rejects(ledger.login(good),/claw_service_busy_retry/);physicsBusy=false;
    assert.deepEqual(["players","challenges","sessions","entries"].map(rows),before);
    assert.equal(ledger.authenticate((await ledger.login(good)).token),carolWallet,"The same proof succeeds once the lane has room");}
  // Anonymous challenge requests cannot lock a wallet (or everyone) out of sign-in.
  for(let i=0;i<1005;i++)ledger.challenge(i<10?other:Keypair.generate().publicKey.toBase58());
  const [nonce,issued]=challenge.id.split(".");
  for(const id of [`${nonce}.${Number(issued)+1}`,nonce,`${"0".repeat(64)}.${issued}`])await assert.rejects(ledger.login({...signed,id}),/invalid_wallet_proof/);
  const bobChallenge=ledger.challenge(other);await assert.rejects(ledger.login({...proof(bob,bobChallenge),wallet}),/invalid_wallet_proof/);
  const future=ledger.challenge(other);clock-=1;await assert.rejects(ledger.login(proof(bob,future)),/invalid_wallet_proof/);clock+=1;
  const bobAuth=await ledger.login(proof(bob,bobChallenge));assert.equal(ledger.authenticate(bobAuth.token),other);
  await assert.rejects(ledger.login(proof(bob,bobChallenge)),/invalid_wallet_proof/);
  const expired=ledger.challenge(wallet);clock+=60001;await assert.rejects(ledger.login(proof(alice,expired)),/invalid_wallet_proof/);
  const foreign=createClawLedger({...options,filename:join(folder,"foreign.sqlite"),origin:"http://127.0.0.1:4999"});
  await assert.rejects(foreign.login(signed),/invalid_wallet_proof/);foreign.close();
  await login(bob);assert.throws(()=>ledger.authenticate("f".repeat(64)),/player_authentication_required/);
  let state=await ledger.state(wallet);assert.deepEqual(state.balances,[10,10,10]);assert.equal(state.winningsCents,0);assert.equal(state.withdrawableCents,0);assert.equal(state.namespace,"devnet-test-v1");
  const aim=state.boxes.map(box=>({x:box.grabPoint.x,z:box.grabPoint.z})).find(aim=>{try{return !!rules.selectTarget(aim,state.boxes,0);}catch{return false;}});assert(aim);
  const intent={requestId:"same-click",revision:state.revision,aim,tier:0};
  for(const extra of [{target:boxes[0]},{probability:1},{cents:200000},{boxes:[]},{balances:[999,999,999]},{winningsCents:9999}])await assert.rejects(ledger.play(wallet,{...intent,...extra}),/invalid_player_request/);
  const [first,duplicate]=await Promise.all([ledger.play(wallet,intent),ledger.play(wallet,intent)]);assert.equal(first.id,duplicate.id);await ledger.idle();assert.equal(plans,1);
  assert.deepEqual((await ledger.state(wallet)).balances,[9,10,10]);assert.equal(first.pull.target.box.cents,rules.selectTarget(aim,state.boxes,0).box.cents);
  await assert.rejects(ledger.play(wallet,{...intent,tier:2}),/request_inputs_changed/);
  await assert.rejects(ledger.play(wallet,{...intent,requestId:"different-click",revision:1}),/player_attempt_pending/);
  await assert.rejects(ledger.result(other,first.id,true),/attempt_not_found/);
  assert.equal((await ledger.state(other)).winningsCents,0);
  assert.throws(()=>ledger.creditTest(wallet,{requestId:"credit-during-play",tier:0,quantity:10}),/player_attempt_pending/);
  // Restart after the token reservation and broadcast. No browser save is needed.
  ledger.close();ledger=createClawLedger(options);assert.equal(ledger.authenticate(auth.token),wallet);
  assert.equal((await ledger.state(wallet)).pending.id,first.id);assert.deepEqual((await ledger.state(wallet)).balances,[9,10,10]);
  released.add(first.id);corrupt=true;await assert.rejects(ledger.result(wallet,first.id),/ledger_result_mismatch/);assert.equal((await ledger.result(other,"missing").catch(()=>null)),null);
  corrupt=false;const outcomes=await Promise.all(Array.from({length:8},()=>ledger.result(wallet,first.id)));
  assert(outcomes.every(value=>value.result.cents===first.pull.target.box.cents));state=await ledger.state(wallet);
  assert.equal(state.winningsCents,first.pull.target.box.cents);assert.equal(state.history.length,1);assert.equal(state.boxes.length,63);assert(!state.boxes.some(box=>box.id===first.pull.target.box.id));assert.equal(state.pending,null);
  assert.equal(ledger.sessionWinnings(auth.token),state.winningsCents);
  const secondVisit=await login(alice);assert.equal(ledger.sessionWinnings(secondVisit.token),0);assert.equal((await ledger.state(wallet)).winningsCents,state.winningsCents);
  const nextAim=state.boxes.map(box=>({x:box.grabPoint.x,z:box.grabPoint.z})).find(aim=>{try{return !!rules.selectTarget(aim,state.boxes,0);}catch{return false;}});
  const miss=await ledger.play(wallet,{requestId:"verified-miss",revision:state.revision,aim:nextAim,tier:0});await ledger.idle();fixtureRoll=1-1/2**32;released.add(miss.id);
  const missed=await ledger.result(wallet,miss.id);assert.equal(missed.result.success,false);assert.equal(missed.state.boxes.length,63);assert.equal(missed.state.winningsCents,state.winningsCents);
  ready=false;assert.equal((await ledger.result(wallet,first.id)).result.cents,state.winningsCents,"Recovery works after sponsor exhaustion");
  await assert.rejects(ledger.play(wallet,{requestId:"expired-revision",revision:0,aim,tier:0}),/sponsor_setup_required/);ready=true;
  await assert.rejects(ledger.play(wallet,{requestId:"stale-click",revision:0,aim,tier:0}),/stale_player_state/);
  const credit={requestId:"faucet-credit",tier:1,quantity:50};ledger.creditTest(wallet,credit);ledger.creditTest(wallet,credit);assert.equal((await ledger.state(wallet)).balances[1],60);
  assert.throws(()=>ledger.creditTest(wallet,{...credit,quantity:1}),/request_inputs_changed/);
  assert.throws(()=>ledger.creditTest(wallet,{requestId:"over-limit",tier:1,quantity:51}),/daily_test_credit_limit_reached/);
  // Empty-space drops consume exactly one token, never request VRF or award money.
  state=await ledger.state(wallet);const before=plans;
  const empty=await ledger.play(wallet,{requestId:"empty",revision:state.revision,aim:{x:-1.3,z:1.2},tier:1});await ledger.idle();
  const emptyResult=await ledger.result(wallet,empty.id);assert.equal(emptyResult.result.roll,null);assert.equal(emptyResult.result.cents,0);assert.equal(plans,before);assert.equal(emptyResult.state.balances[1],59);
  // HTTP boundary rejects spoofed sessions/origins/oversized bodies, and cannot
  // expose admin or future purchase/withdrawal mutations through player routes.
  const handler=createPlayerApi({ledger,origin,availability:async()=>({cluster:"devnet"})});
  async function http(route,{method="GET",body,token=auth.token,source=origin}={}){let response;const req={method,headers:{"x-cato-player-session":token,origin:source,"content-type":"application/json"},async *[Symbol.asyncIterator](){if(body!==undefined)yield Buffer.from(typeof body==="string"?body:JSON.stringify(body));}};await handler(req,new URL("/api/player/"+route,origin),(status,value)=>{response={status,value};});return response;}
  assert.equal((await http("state",{token:"bad"})).status,401);
  assert.equal((await http("test-credit",{method:"POST",source:"https://evil.example",body:credit})).status,400);
  assert.equal((await http("test-credit",{method:"POST",body:"x".repeat(2049)})).value.error,"request_too_large");
  assert.equal((await http("withdraw",{method:"POST",body:{cents:10000}})).status,404);
  assert.equal((await http("deposit",{method:"POST",body:{quantity:10000}})).status,404);
  // Logout revokes only the presenting session; the wallet keeps its newest five sessions.
  {const keep=await login(alice),drop=await login(alice);
    assert.equal((await http("logout",{method:"POST",body:{},token:drop.token,source:"https://evil.example"})).status,400);
    assert.equal((await http("logout",{method:"POST",body:{all:true},token:drop.token})).status,400);
    assert.equal((await http("logout",{token:drop.token})).status,404);
    assert.equal(ledger.authenticate(drop.token),wallet,"Rejected logout requests revoke nothing");
    assert.deepEqual(await http("logout",{method:"POST",body:{},token:drop.token}),{status:200,value:{ok:true}});
    assert.equal((await http("state",{token:drop.token})).status,401);assert.equal((await http("logout",{method:"POST",body:{},token:drop.token})).status,401);
    assert.equal(ledger.authenticate(keep.token),wallet);assert.equal(ledger.authenticate(auth.token),wallet);
    const tokens=[];for(let i=0;i<6;i++){clock+=1;tokens.push((await login(bob)).token);}
    assert.throws(()=>ledger.authenticate(tokens[0]),/player_authentication_required/,"Oldest session beyond the per-wallet cap is revoked");
    for(const token of tokens.slice(1))assert.equal(ledger.authenticate(token),other);
    assert.equal(ledger.authenticate(keep.token),wallet,"Another wallet's sessions are untouched by the cap");
    // Expired rows are pruned by reconciliation (bounded to once a minute), not by sign-in.
    const challenges=rows("challenges");assert(challenges>0);clock+=61_000;await login(bob);assert.equal(rows("challenges"),challenges+1,"Sign-in does not prune");
    await ledger.tick();assert.equal(rows("challenges"),1,"Only the unexpired challenge remains");
    await login(bob);await ledger.tick();assert.equal(rows("challenges"),2,"Pruning runs at most once a minute");}
  for(let i=0;i<10;i++){const state=await ledger.state(wallet);const drop=await ledger.play(wallet,{requestId:`spend-last-${i}`,revision:state.revision,aim:{x:-1.3,z:1.2},tier:2});await ledger.idle();assert((await ledger.result(wallet,drop.id)).result);}
  const exhausted=await ledger.state(wallet);assert.equal(exhausted.balances[2],0);
  await assert.rejects(ledger.play(wallet,{requestId:"no-token",revision:exhausted.revision,aim,tier:2}),/insufficient_tokens/);
  // Reopening retains the credited total and fixed namespace, not browser values.
  const total=emptyResult.state.winningsCents;ledger.close();ledger=createClawLedger(options);assert.equal((await ledger.state(wallet)).winningsCents,total);
  clock+=12*3600_000;assert.throws(()=>ledger.authenticate(auth.token),/player_authentication_required/);
  // Exercise the actual browser client against this API, including a lost
  // response after a successful reservation/credit and a fresh client instance.
  const storage=new Map(),browserHandler=createPlayerApi({ledger,origin,availability:async()=>({cluster:"devnet"})});let signatures=0,losePlay=true,loseCredit=true;
  const browserModule={exports:{}},clientSource=ts.transpileModule(await readFile(new URL("../components/claw/authoritativeClient.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),Buffer.from(alice.secretKey.subarray(0,32))]),format:"der",type:"pkcs8"});
  const browserFetch=async(url,options={})=>{const headers=Object.fromEntries(Object.entries(options.headers??{}).map(([key,value])=>[key.toLowerCase(),value]));if(options.method==="POST")headers.origin=origin;let response;
    await browserHandler({method:options.method??"GET",headers,async *[Symbol.asyncIterator](){if(options.body)yield Buffer.from(options.body);}},new URL(url,origin),(status,value)=>{response={status,value};});
    if(url.endsWith("/play")&&losePlay){losePlay=false;throw Error("lost_response");}
    if(url.endsWith("/test-credit")&&loseCredit){loseCredit=false;throw Error("lost_response");}
    return {ok:response.status===200,status:response.status,json:async()=>JSON.parse(JSON.stringify(response.value))};};
  vm.runInNewContext(clientSource,{module:browserModule,exports:browserModule.exports,fetch:browserFetch,AbortSignal,TextEncoder,setTimeout,crypto:{randomUUID},
    sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}});
  const aliceWallet={address:()=>alice.publicKey.toBase58(),connect:async()=>alice.publicKey.toBase58(),signTransaction:async value=>value,
    signMessage:async message=>{signatures++;return sign(null,Buffer.from(message),privateKey);}};
  const browser=browserModule.exports.createAuthoritativeClient(aliceWallet),signedState=await browser.connect();assert.equal(signedState.sessionWinningsCents,0);
  const lostIntent={requestId:"lost-browser-response",revision:signedState.revision,aim:{x:-1.3,z:1.2},tier:1};
  await assert.rejects(browser.begin(lostIntent),/The game is unavailable right now/);assert.equal(browser.queued().requestId,lostIntent.requestId);
  const same=await browser.begin(lostIntent);await ledger.idle();assert.equal(browser.queued(),null);
  const received=await browser.resolve(same.id);assert.equal(received.state.balances[1],signedState.balances[1]-1);
  const reload=browserModule.exports.createAuthoritativeClient(aliceWallet);assert.equal((await reload.connect()).balances[1],received.state.balances[1]);assert.equal(signatures,1,"Session restore needs no extra wallet signature");
  await assert.rejects(reload.addTokens(1,3),/The game is unavailable right now/);const credited=await reload.addTokens(1,3);assert.equal(credited.balances[1],received.state.balances[1]+3,"Lost credit response cannot mint twice");
  // Browser sign-out forgets the stored token and revokes it on the backend.
  {const stored=JSON.parse(storage.get("cato-authoritative-devnet-auth-v1")).token;assert.equal(ledger.authenticate(stored),wallet);
    reload.signOut();assert(!storage.has("cato-authoritative-devnet-auth-v1"));await new Promise(resolve=>setTimeout(resolve,20));
    assert.throws(()=>ledger.authenticate(stored),/player_authentication_required/,"Signed-out token is revoked server-side");}
  // Physics scheduling: settlements run first on their own worker and never queue behind new-wallet piles;
  // the new-wallet lane is bounded. Only the order changes, never a job's input or output.
  {const workers=[],spawn=()=>{const fake=new EventEmitter();fake.sent=[];fake.postMessage=message=>fake.sent.push(message);fake.terminate=async()=>{};workers.push(fake);return fake;};
    const scheduled=createLedgerPhysics({spawn,newWalletLimit:2}),[mainWorker,signupWorker]=workers,done=[];
    const track=(name,promise)=>promise.then(value=>{done.push(name);return value;});
    const signupA=track("signupA",scheduled.create(11,{newWallet:true})),signupB=track("signupB",scheduled.create(12,{newWallet:true}));
    await assert.rejects(scheduled.create(13,{newWallet:true}),/claw_service_busy_retry/,"Sign-up piles beyond the limit get a retryable busy error");
    const rotateA=track("rotateA",scheduled.create(21)),rotateB=track("rotateB",scheduled.create(22)),settled=track("settle",scheduled.settle(["pile"]));
    assert.deepEqual(signupWorker.sent.map(job=>job.seed),[11],"One sign-up pile runs at a time");
    assert.deepEqual(mainWorker.sent.map(job=>job.kind+":"+(job.seed??job.boxes)),["create:21"],"Sign-ups never occupy the settlement worker");
    const reply=(worker,boxes)=>{worker.emit("message",{id:worker.sent.at(-1).id,boxes});return new Promise(resolve=>setImmediate(resolve));};
    await reply(mainWorker,"rotated-21");
    assert.deepEqual(mainWorker.sent.at(-1),{kind:"settle",boxes:["pile"],id:mainWorker.sent.at(-1).id},"A queued settlement runs before an earlier queued rotation");
    await reply(mainWorker,"settled");assert.equal(mainWorker.sent.at(-1).seed,22);await reply(mainWorker,"rotated-22");
    assert.deepEqual(done,["rotateA","settle","rotateB"],"Settlement finished while both sign-up piles were still outstanding");
    assert.equal(await settled,"settled");assert.equal(await rotateA,"rotated-21");assert.equal(await rotateB,"rotated-22");
    await reply(signupWorker,"signup-11");assert.equal(await signupA,"signup-11");assert.equal(signupWorker.sent.at(-1).seed,12);
    const signupC=scheduled.create(14,{newWallet:true});await reply(signupWorker,"signup-12");assert.equal(await signupB,"signup-12");
    signupWorker.emit("exit",1);await assert.rejects(signupC,/canonical_physics_unavailable/);await scheduled.close();}
  // Real workers under contention produce byte-identical results to the direct canonical rules.
  const worker=createLedgerPhysics();try {
    const contended=[worker.create(2026,{newWallet:true}),worker.create(2027,{newWallet:true})];
    const [settledPile,rotated]=await Promise.all([worker.settle(boxes.slice(1)),worker.create(2026)]);
    assert.equal(JSON.stringify(settledPile),JSON.stringify(rules.settlePile(boxes.slice(1)).at(-1)),"Worker computes canonical post-removal poses");
    assert.equal(JSON.stringify(rotated),JSON.stringify(boxes),"Worker computes the same canonical initial pile");
    const [first2026,first2027]=await Promise.all(contended);
    assert.equal(JSON.stringify(first2026),JSON.stringify(boxes));assert.equal(JSON.stringify(first2027),JSON.stringify(rules.createPile(2027)),"New-wallet lane computes identical piles");
  }finally{await worker.close();}
  console.log("PASS: signed single-use wallet login, persistent scoped devnet ledger, canonical odds/inventory, forged-input rejection, atomic one-token reservation, cross-wallet isolation, restart recovery, exact-once winnings/removal, empty drops, bounded idempotent test credits, and HTTP auth/origin/body limits.");
} finally {await ledger.idle();ledger.close();await rm(folder,{recursive:true,force:true});}
