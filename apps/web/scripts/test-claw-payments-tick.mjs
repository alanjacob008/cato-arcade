// Background purchase reconciliation with a real (in-process PGlite) Postgres ledger and a stubbed cashier chain.
// Dead purchase wires (rejected at preflight, then expired) must not starve later paid purchases, and the
// finalized receipt stays the only credit path: each purchase is credited exactly once.
import assert from "node:assert/strict";
import {createPrivateKey,sign,randomUUID} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {Keypair} from "@solana/web3.js";
import {createPgClawLedger} from "./lib/claw-pg-ledger.mjs";
import {createClawPayments} from "./lib/claw-payments.mjs";
import {loadClawRules} from "./lib/vrf-game.mjs";

const database=new PGlite(),store={query:(...args)=>database.query(...args),transaction:work=>database.transaction(work)};
const rules=await loadClawRules(),boxes=rules.createPile(2026),physics={create:async()=>structuredClone(boxes),settle:async value=>structuredClone(value)};
let clock=Date.UTC(2026,10,26);
const game={concurrent:true,async plan(){throw Error("not_used");},async state(){return {notFound:true};}};
const ledger=await createPgClawLedger({store,origin:"https://arcade.example",rules,physics,game,available:async()=>true,now:()=>clock,paymentsEnabled:true});
function proof(key,challenge){const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),Buffer.from(key.secretKey.subarray(0,32))]),format:"der",type:"pkcs8"});
  return {id:challenge.id,wallet:key.publicKey.toBase58(),signature:sign(null,Buffer.from(challenge.message),privateKey).toString("hex")};}
const attackerKey=Keypair.generate(),victimKey=Keypair.generate(),attacker=attackerKey.publicKey.toBase58(),victim=victimKey.publicKey.toBase58();
for(const key of [attackerKey,victimKey])await ledger.login(proof(key,await ledger.challenge(key.publicKey.toBase58())));

// Stub chain: the attacker holds no test USDC, so every broadcast fails preflight and nothing lands.
let finalizedHeight=1000,builds=0;
const landed=new Set(),finalizedReceipts=new Set(),receiptReads=new Map(),late=new Set();
const chain={
  status:async()=>({ready:true}),
  async build(kind,row){builds++;return {bytes:"unsigned-"+builds,signature:`sig-${row.id}-${builds}`,block:{lastValidBlockHeight:finalizedHeight+150},signed:false};},
  verifyPurchase:(encoded,prepared)=>({...prepared,bytes:encoded,signed:true}),
  async send(wire){if(wire.bytes.startsWith("attacker"))throw Error("Transaction simulation failed: insufficient funds");landed.add(wire.signature);return wire.signature;},
  async inspect(wire){if(landed.has(wire.signature))return {confirmed:true};
    const expired=finalizedHeight>wire.block.lastValidBlockHeight;return {expired,pending:!expired};},
  async receipt(kind,row){
    const reads=(receiptReads.get(row.id)??0)+1;receiptReads.set(row.id,reads);
    // A deposit whose finalized receipt only becomes visible on the re-read after expiry was observed.
    if(late.has(row.id)&&finalizedHeight>2000){late.delete(row.id);return null;}
    if(kind!=="purchase"||!finalizedReceipts.has(row.id))return null;
    return {verified:true,id:row.id,wallet:row.wallet,cents:Number(row.cents),tier:row.tier,quantity:row.quantity,signature:row.wire?.signature??null,receipt:"deposit-"+row.id};
  },
};
const payments=createClawPayments({ledger,chain});
const purchaseRow=id=>database.query("SELECT * FROM claw_purchases WHERE id=$1",[id]).then(result=>result.rows[0]);
const credits=id=>database.query("SELECT count(*)::int AS n FROM claw_entries WHERE id=$1",["purchase:"+id]).then(result=>result.rows[0].n);
async function buy(wallet,prefix,tier,quantity){
  clock+=1000;const requestId=randomUUID(),plan=await payments.purchasePlan(wallet,{requestId,tier,quantity});
  const submit=payments.purchaseSubmit(wallet,{id:plan.id,signedTransaction:prefix+plan.id});
  return {id:plan.id,requestId,submit};
}

try{
  // 22 attacker purchases signed and saved ('submitted') before broadcast; every broadcast is rejected at preflight.
  const dead=[];
  for(let i=0;i<22;i++){const row=await buy(attacker,"attacker",0,1);await assert.rejects(row.submit,/simulation failed/);dead.push(row);}
  for(const row of dead)assert.equal((await purchaseRow(row.id)).status,"submitted");
  // A later victim purchase lands and its deposit receipt finalizes; the victim's tab is gone and never polls.
  const paid=await buy(victim,"victim",2,5);assert.equal((await paid.submit).payment.status,"submitted");
  finalizedReceipts.add(paid.id);assert.equal((await ledger.state(victim)).balances[2],0);

  // Rotation: while all 22 dead wires are still unexpired (they could in principle still land), they stay
  // 'submitted', yet the batch of 20 rotates and reaches the victim's purchase within two ticks.
  await payments.tick();await payments.tick();
  assert.equal((await purchaseRow(paid.id)).status,"credited");
  assert.deepEqual((await ledger.state(victim)).balances,[0,0,5]);
  for(const row of dead)assert.equal((await purchaseRow(row.id)).status,"submitted","An unexpired wire is never released");
  // A wire that landed but whose receipt is not finalized yet is never released either.
  landed.add((await purchaseRow(dead[0].id)).wire.signature);

  // Expiry: every dead attacker wire passes lastValidBlockHeight. One of them (dead[1]) did land; its finalized
  // receipt only shows up on the re-read after expiry, so it is credited, not released.
  late.add(dead[1].id);finalizedReceipts.add(dead[1].id);
  finalizedHeight=5000;
  for(let i=0;i<4;i++)await payments.tick();
  assert.equal((await purchaseRow(dead[0].id)).status,"submitted","A landed, not yet finalized wire stays pending");
  assert.equal((await purchaseRow(dead[1].id)).status,"credited");
  assert.equal(await credits(dead[1].id),1);
  for(const row of dead.slice(2)){
    const current=await purchaseRow(row.id);
    assert.equal(current.status,"quoted","A dead, expired wire leaves the pending set");
    assert(current.wire.signed&&current.wire.bytes==="attacker"+row.id,"The dead wire is kept for audit");
  }
  const pending=await ledger.pendingPayments();
  assert.deepEqual(pending.purchases.map(row=>row.id),[dead[0].id]);

  // Exactly once: more ticks and the victim's own status polls never credit again.
  for(let i=0;i<3;i++)await payments.tick();
  await payments.purchaseStatus(victim,paid.id);await payments.purchaseStatus(attacker,dead[1].id);
  assert.equal(await credits(paid.id),1);assert.deepEqual((await ledger.state(victim)).balances,[0,0,5]);
  assert.equal(await credits(dead[1].id),1);assert.equal((await ledger.state(attacker)).balances[0],1);

  // A released row resumes normally: the same requestId gets a fresh wire for the same purchase id.
  const deadSignature=(await purchaseRow(dead[2].id)).wire.signature;
  const resumed=await payments.purchasePlan(attacker,{requestId:dead[2].requestId,tier:0,quantity:1});
  assert.equal(resumed.id,dead[2].id);assert.equal(resumed.status,"quoted");assert(resumed.transaction);
  assert.notEqual(resumed.signature,deadSignature);assert.equal((await purchaseRow(dead[2].id)).wire.signed,false);
  // If a released row's deposit nevertheless finalizes (e.g. a lagging RPC view), the receipt credits it once.
  finalizedReceipts.add(dead[3].id);
  await Promise.all([payments.purchaseStatus(attacker,dead[3].id),payments.purchaseStatus(attacker,dead[3].id)]);
  await payments.purchasePlan(attacker,{requestId:dead[3].requestId,tier:0,quantity:1});
  assert.equal((await purchaseRow(dead[3].id)).status,"credited");assert.equal(await credits(dead[3].id),1);
  assert.equal((await ledger.state(attacker)).balances[0],2);
  console.log("PASS: dead expired purchase wires leave the pending set with their audit wire, batches rotate past still-pending rows, landed purchases are credited by the background loop, and every receipt credits exactly once.");
}finally{await ledger.idle();await database.close();}
