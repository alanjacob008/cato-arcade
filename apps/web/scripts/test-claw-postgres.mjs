import assert from "node:assert/strict";
import {createPrivateKey,sign,randomUUID} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {Keypair} from "@solana/web3.js";
import {createPgClawLedger} from "./lib/claw-pg-ledger.mjs";
import {createClawPayments} from "./lib/claw-payments.mjs";
import {loadClawRules} from "./lib/vrf-game.mjs";
import {createPlayerApi} from "./lib/claw-player-api.mjs";

let databaseReads=0,transactions=0;
const database=new PGlite(),store={query:(...args)=>{databaseReads++;return database.query(...args);},transaction:work=>{transactions++;return database.transaction(work);}};
const creations=[];let physicsBusy=false;
const rules=await loadClawRules(),boxes=rules.createPile(2026),physics={create:async(seed,options)=>{if(physicsBusy&&options?.newWallet)throw Error("claw_service_busy_retry");creations.push(options??null);return structuredClone(boxes);},settle:async value=>structuredClone(value)};
const count=async table=>Number((await database.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
let clock=Date.UTC(2026,10,23),ready=true,plans=0;const pulls=new Map(),released=new Set();
const receipt=pull=>({gameId:pull.id,pull,requestSignature:"request-"+pull.id,callbackSignature:"callback-"+pull.id,result:released.has(pull.id)?rules.resolvePull(pull,()=>0,"magicblock-vrf"):null});
const game={concurrent:true,async plan(pull){plans++;pulls.set(pull.id,pull);return receipt(pull);},async state(id){return pulls.has(id)?receipt(pulls.get(id)):{notFound:true};}};
const options={store,origin:"https://arcade.example",rules,physics,game,available:async()=>ready,now:()=>clock,paymentsEnabled:true};
let ledger=await createPgClawLedger(options);
const alice=Keypair.generate(),bob=Keypair.generate(),wallet=alice.publicKey.toBase58(),other=bob.publicKey.toBase58();
function proof(key,challenge){const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),Buffer.from(key.secretKey.subarray(0,32))]),format:"der",type:"pkcs8"});return {id:challenge.id,wallet:key.publicKey.toBase58(),signature:sign(null,Buffer.from(challenge.message),privateKey).toString("hex")};}
const login=async key=>ledger.login(proof(key,await ledger.challenge(key.publicKey.toBase58())));
try{
  const challenge=await ledger.challenge(wallet),signed=proof(alice,challenge);
  await assert.rejects(ledger.login({...signed,signature:"00".repeat(64)}),/invalid_wallet_proof/);
  const auth=await ledger.login(signed);await assert.rejects(ledger.login(signed),/invalid_wallet_proof/);
  assert.deepEqual(creations,[{newWallet:true}],"First sign-in creates the pile in the bounded new-wallet lane");
  // A client cannot sign a proof now for a future "Issued" time: only nonces this server issued are accepted.
  {const start=clock,later=clock+120_000,nonce="ab".repeat(32);
    const message=challenge.message.replace(/^Nonce: .*$/m,`Nonce: ${nonce}`).replace(/^Issued: .*$/m,`Issued: ${later}`).replace(/^Expires: .*$/m,`Expires: ${later+60_000}`);
    const presigned=proof(alice,{id:`${nonce}.${later}`,message});clock=later+1;
    await assert.rejects(ledger.login(presigned),/invalid_wallet_proof/,"pre-signed future proof is refused when its window arrives");clock=start;}
  // Bad signatures and forged nonces are refused before any database access or pile creation.
  {const carol=Keypair.generate(),carolWallet=carol.publicKey.toBase58(),fresh=await ledger.challenge(carolWallet),good=proof(carol,fresh);
    const reads=databaseReads,writes=transactions,made=creations.length;
    await assert.rejects(ledger.login({...good,signature:"00".repeat(64)}),/invalid_wallet_proof/);
    await assert.rejects(ledger.login({...good,id:`${"cd".repeat(16)}${fresh.id.slice(32)}`}),/invalid_wallet_proof/);
    assert.equal(databaseReads,reads,"No query before the proof verifies");assert.equal(transactions,writes);assert.equal(creations.length,made,"No pile is created for an unverified sign-in");
    // A busy new-wallet lane returns a retryable 503 without consuming the proof.
    const before=await Promise.all(["claw_players","claw_challenges","claw_sessions"].map(count));
    physicsBusy=true;const api=createPlayerApi({ledger,origin:options.origin,availability:async()=>({})});let reply;
    await api({method:"POST",headers:{origin:options.origin,"content-type":"application/json"},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(good));}},
      new URL("/api/player/login",options.origin),(status,value)=>{reply={status,value};});physicsBusy=false;
    assert.deepEqual(reply,{status:503,value:{error:"claw_service_busy_retry"}});
    assert.deepEqual(await Promise.all(["claw_players","claw_challenges","claw_sessions"].map(count)),before);
    assert.equal(await ledger.authenticate((await ledger.login(good)).token),carolWallet,"The same proof succeeds once the lane has room");}
  // Anonymous challenge requests cannot lock a wallet (or everyone) out of sign-in.
  for(let i=0;i<1005;i++)await ledger.challenge(i<10?other:Keypair.generate().publicKey.toBase58());
  const [nonce,issued]=challenge.id.split(".");
  for(const id of [`${nonce}.${Number(issued)+1}`,nonce,`${"0".repeat(64)}.${issued}`])await assert.rejects(ledger.login({...signed,id}),/invalid_wallet_proof/);
  const bobChallenge=await ledger.challenge(other);await assert.rejects(ledger.login({...proof(bob,bobChallenge),wallet}),/invalid_wallet_proof/);
  const future=await ledger.challenge(other);clock-=6000;await assert.rejects(ledger.login(proof(bob,future)),/invalid_wallet_proof/);clock+=6000;
  const late=await ledger.challenge(other);clock+=60001;await assert.rejects(ledger.login(proof(bob,late)),/invalid_wallet_proof/);clock-=60001;
  const bobProof=proof(bob,bobChallenge),[raced,lost]=await Promise.allSettled([ledger.login(bobProof),ledger.login(bobProof)]);
  assert.equal([raced,lost].filter(result=>result.status==="fulfilled").length,1);
  await login(bob);assert.equal(await ledger.authenticate(auth.token),wallet);
  // Logout revokes only the presenting session; the wallet keeps its newest five sessions.
  {const api=createPlayerApi({ledger,origin:options.origin,availability:async()=>({})});
    const http=async(route,{method="GET",body,token,source=options.origin}={})=>{let reply;await api({method,headers:{"x-cato-player-session":token,origin:source,"content-type":"application/json"},
      async *[Symbol.asyncIterator](){if(body!==undefined)yield Buffer.from(JSON.stringify(body));}},new URL("/api/player/"+route,options.origin),(status,value)=>{reply={status,value};});return reply;};
    const keep=await login(alice),drop=await login(alice);
    assert.equal((await http("logout",{method:"POST",body:{},token:drop.token,source:"https://evil.example"})).status,400);
    assert.equal((await http("logout",{method:"POST",body:{all:true},token:drop.token})).status,400);
    assert.equal((await http("logout",{token:drop.token})).status,404);
    assert.equal(await ledger.authenticate(drop.token),wallet,"Rejected logout requests revoke nothing");
    assert.deepEqual(await http("logout",{method:"POST",body:{},token:drop.token}),{status:200,value:{ok:true}});
    assert.equal((await http("state",{token:drop.token})).status,401);assert.equal((await http("logout",{method:"POST",body:{},token:drop.token})).status,401);
    assert.equal(await ledger.authenticate(keep.token),wallet);assert.equal(await ledger.authenticate(auth.token),wallet);
    const tokens=[];for(let i=0;i<6;i++){clock+=1;tokens.push((await login(bob)).token);}
    await assert.rejects(ledger.authenticate(tokens[0]),/player_authentication_required/,"Oldest session beyond the per-wallet cap is revoked");
    for(const token of tokens.slice(1))assert.equal(await ledger.authenticate(token),other);
    assert.equal(await ledger.authenticate(keep.token),wallet,"Another wallet's sessions are untouched by the cap");
    // Expired rows are pruned by reconciliation (bounded to once a minute), not by sign-in.
    const challenges=await count("claw_challenges");assert(challenges>1);clock+=61_000;await login(bob);assert.equal(await count("claw_challenges"),challenges+1,"Sign-in does not prune");
    await ledger.tick();assert.equal(await count("claw_challenges"),1,"Only the unexpired challenge remains");
    await login(bob);await ledger.tick();assert.equal(await count("claw_challenges"),2,"Pruning runs at most once a minute");}
  let state=await ledger.state(wallet);assert.equal(state.namespace,"devnet-usdc-v1");assert.deepEqual(state.balances,[0,0,0]);
  assert.equal(state.withdrawableCents,0);assert(state.paymentsEnabled);
  await assert.rejects(ledger.creditTest(wallet,{requestId:"free",tier:0,quantity:10}),/test_credit_disabled/);
  const free=await createPgClawLedger({...options,paymentsEnabled:false});
  const freeAuth=await free.login(proof(alice,await free.challenge(wallet)));assert.deepEqual(freeAuth.state.balances,[10,10,10]);
  assert.deepEqual(await free.sessionSummary(freeAuth.token),{sessionWinningsCents:0,sessionWithdrawableCents:0});
  await assert.rejects(ledger.sessionSummary(freeAuth.token),/player_authentication_required/);
  await assert.rejects(free.authenticate(auth.token),/player_authentication_required/);await assert.rejects(ledger.authenticate(freeAuth.token),/player_authentication_required/);
  const buy={requestId:randomUUID(),tier:0,quantity:10},quote=await ledger.quotePurchase(wallet,buy);
  assert.equal(Number(quote.cents),2000);assert.equal((await ledger.quotePurchase(wallet,buy)).id,quote.id);
  await assert.rejects(ledger.quotePurchase(wallet,{...buy,quantity:11}),/request_inputs_changed/);
  await assert.rejects(ledger.quotePurchase(wallet,{...buy,cents:1}),/invalid_player_request/);
  await assert.rejects(ledger.purchase(other,quote.id),/payment_not_found/);
  await assert.rejects(ledger.acceptPurchase(wallet,quote.id,{verified:true,id:quote.id,wallet,quantity:10,tier:0,cents:1}),/purchase_receipt_mismatch/);
  const paidProof={verified:true,id:quote.id,wallet,quantity:10,tier:0,cents:2000,signature:"fixture",receipt:"fixture-receipt"};
  await Promise.all([ledger.acceptPurchase(wallet,quote.id,paidProof),ledger.acceptPurchase(wallet,quote.id,paidProof)]);
  state=await ledger.state(wallet);assert.deepEqual(state.balances,[10,0,0]);assert.equal(state.winningsCents,0);
  async function win(){const current=await ledger.state(wallet),aim=current.boxes.map(box=>({x:box.grabPoint.x,z:box.grabPoint.z})).find(aim=>{try{return !!rules.selectTarget(aim,current.boxes,0);}catch{return false;}});assert(aim);
    const intent={requestId:randomUUID(),revision:current.revision,aim,tier:0};
    const [first,retry]=await Promise.all([ledger.play(wallet,intent),ledger.play(wallet,intent)]);assert.equal(first.id,retry.id);await ledger.idle();
    assert.equal((await ledger.state(wallet)).balances[0],current.balances[0]-1);released.add(first.id);
    const result=await ledger.result(wallet,first.id);assert(result.result.success);return result;
  }
  const first=await win(),prize=first.result.cents;
  assert.equal(first.state.withdrawableCents,prize);assert.equal(await ledger.sessionWinnings(auth.token),prize);
  let beforeReads=databaseReads;
  assert.deepEqual(await ledger.sessionSummary(auth.token),{sessionWinningsCents:prize,sessionWithdrawableCents:prize});
  assert.equal(databaseReads-beforeReads,1,"Player polling summaries must take one authenticated SQL round trip");
  const requests=await Promise.allSettled([ledger.reserveWithdrawal(wallet,auth.token,{requestId:"all-first",scope:"all"}),ledger.reserveWithdrawal(wallet,auth.token,{requestId:"session-first",scope:"session"})]);
  assert.equal(requests.filter(item=>item.status==="fulfilled").length,1);const claim=requests.find(item=>item.status==="fulfilled").value;
  assert.equal(Number(claim.cents),prize);assert.equal((await ledger.state(wallet)).withdrawableCents,0);
  assert.deepEqual(await ledger.sessionSummary(auth.token),{sessionWinningsCents:prize,sessionWithdrawableCents:0});
  assert.equal((await ledger.reserveWithdrawal(wallet,auth.token,{requestId:claim.request_id,scope:claim.scope})).id,claim.id);
  await assert.rejects(ledger.withdrawal(other,claim.id),/payment_not_found/);
  await assert.rejects(ledger.completeWithdrawal(wallet,claim.id,{verified:true,id:claim.id,wallet:other,cents:prize}),/withdrawal_receipt_mismatch/);
  await assert.rejects(ledger.failWithdrawal(wallet,claim.id,{confirmedFailure:false}),/confirmed_payment_failure_required/);
  await ledger.savePaymentWire("withdrawal",wallet,claim.id,{signature:"pay-one",bytes:"signed",signed:true,block:{lastValidBlockHeight:100}});
  // Recreate the service against the same durable database: the reservation and auth survive.
  ledger=await createPgClawLedger(options);assert.equal((await ledger.state(wallet)).withdrawableCents,0);assert.equal(await ledger.authenticate(auth.token),wallet);
  let delivered=false,sends=0;
  const chain={status:async()=>({ready:true}),receipt:async(kind,row)=>kind==="withdrawal"&&delivered?{verified:true,id:row.id,wallet:row.wallet,cents:Number(row.cents),signature:"pay-one",receipt:"claim-pda"}:null,
    inspect:async()=>({pending:true}),send:async()=>{sends++;delivered=true;throw Error("rpc_timeout_after_send");}};
  const payments=createClawPayments({ledger,chain});
  await assert.rejects(payments.withdrawalStatus(wallet,claim.id),/rpc_timeout_after_send/);
  assert.equal((await ledger.state(wallet)).withdrawableCents,0);
  const recovered=await payments.withdrawalStatus(wallet,claim.id);assert.equal(recovered.payment.status,"paid");assert.equal(sends,1);
  await payments.withdrawalStatus(wallet,claim.id);assert.equal(sends,1);assert.equal((await ledger.state(wallet)).winningsCents,prize);
  const second=await win();assert.equal(await ledger.sessionWithdrawable(auth.token),second.result.cents,"New session wins remain withdrawable after a full cash-out");
  ready=false;assert.equal((await ledger.result(wallet,second.id)).result.cents,second.result.cents,"Settled receipts survive sponsor exhaustion");
  assert.equal(plans,2,"Duplicate HTTP intents must not request extra VRF");
  console.log("PASS: real Postgres transactions, namespace separation, signed login, zero funded balances, disabled faucet, verified/idempotent purchases, one-token plays, exact-once winnings, concurrent session/all withdrawal reservation, cross-wallet isolation and timeout/restart payout recovery.");
}finally{await ledger.idle();await database.close();}
