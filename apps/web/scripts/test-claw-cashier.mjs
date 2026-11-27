import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Keypair,VersionedTransaction,PublicKey} from "@solana/web3.js";
import {cashierAddresses,cashierInstruction,decodeCashierReceipt,decodeCashier,createCashierChain,CASHIER_MINT,initializeCashierInstruction} from "./lib/claw-cashier-chain.mjs";
import {discriminator} from "./lib/vrf-deployment.mjs";
import {DEVNET_GENESIS} from "./lib/vrf-devnet.mjs";

const manifest=JSON.parse(await readFile(new URL("../onchain/deployment.devnet.json",import.meta.url),"utf8"));
manifest.verifiedArtifact={capabilities:["devnet-cashier-v1"]};
const signer=Keypair.generate(),buyer=Keypair.generate(),other=Keypair.generate(),wallet=buyer.publicKey.toBase58();
const row={id:"purchase-fixture",wallet,tier:1,quantity:5,cents:2000},p=cashierAddresses(manifest,wallet,row.id);
const state=Buffer.alloc(138);discriminator("account:DevnetCashier").copy(state);new PublicKey(manifest.adminAuthority).toBuffer().copy(state,8);signer.publicKey.toBuffer().copy(state,40);CASHIER_MINT.toBuffer().copy(state,72);
state[104]=p.bump;state.writeBigUInt64LE(10_000_000_000n,106);state.writeBigInt64LE(100n,114);state.writeBigUInt64LE(1_000_000_000n,130);
const account={owner:p.program,data:state};assert.equal(decodeCashier(account,manifest,signer.publicKey).maxClaim,1_000_000_000);
assert.throws(()=>decodeCashier(account,manifest,other.publicKey),/cashier_account_mismatch/);
const badMint=Buffer.from(state);badMint[72]^=1;assert.throws(()=>decodeCashier({...account,data:badMint},manifest,signer.publicKey),/cashier_account_mismatch/);
for(const kind of ["purchase","withdrawal"]){
  const bytes=Buffer.alloc(kind==="purchase"?83:80);discriminator("account:"+(kind==="purchase"?"DevnetDepositReceipt":"DevnetWithdrawalReceipt")).copy(bytes);buyer.publicKey.toBuffer().copy(bytes,8);p.reference.copy(bytes,40);
  if(kind==="purchase"){bytes[72]=row.tier;bytes.writeUInt16LE(row.quantity,73);}bytes.writeBigUInt64LE(BigInt(row.cents)*10000n,kind==="purchase"?75:72);
  const receipt={owner:p.program,data:bytes};assert.equal(decodeCashierReceipt(kind,receipt,manifest,row).cents,row.cents);
  assert.throws(()=>decodeCashierReceipt(kind,receipt,manifest,{...row,wallet:other.publicKey.toBase58()}),/cashier_receipt_mismatch/);
  assert.throws(()=>decodeCashierReceipt(kind,receipt,manifest,{...row,id:"different"}),/cashier_receipt_mismatch/);
  assert.throws(()=>decodeCashierReceipt(kind,{...receipt,owner:other.publicKey},manifest,row),/cashier_receipt_mismatch/);
}
assert.throws(()=>cashierInstruction("purchase",manifest,signer.publicKey,{...row,cents:1}),/invalid_purchase/);
const init=initializeCashierInstruction(manifest,signer.publicKey);assert.equal(init.length,2);assert(init[1].data.subarray(0,8).equals(discriminator("global:initialize_devnet_cashier")));
let statuses=null,finalizedHeight=1,sends=0,receiptReads=[];
const connection={getGenesisHash:async()=>DEVNET_GENESIS,getAccountInfo:async(address,commitment)=>{receiptReads.push(commitment);return address.equals(p.cashier)?account:null;},
  getLatestBlockhash:async()=>({blockhash:other.publicKey.toBase58(),lastValidBlockHeight:100}),getSignatureStatuses:async()=>({value:[statuses]}),getBlockHeight:async commitment=>{assert.equal(commitment,"finalized");return finalizedHeight;},
  sendRawTransaction:async bytes=>{sends++;const tx=VersionedTransaction.deserialize(bytes);const {encodeSignature}=await import("./lib/vrf-sponsor.mjs");return encodeSignature(tx.signatures[0]);}};
const chain=createCashierChain({connection,manifest,key:signer,verified:async()=>true});
const prepared=await chain.build("purchase",row);assert.equal(prepared.signed,false);
const tx=VersionedTransaction.deserialize(Buffer.from(prepared.bytes,"base64"));tx.sign([buyer]);
const signed=Buffer.from(tx.serialize()).toString("base64"),valid=chain.verifyPurchase(signed,prepared,wallet);assert(valid.signed);
assert.throws(()=>chain.verifyPurchase(prepared.bytes,prepared,wallet),/purchase_signature_invalid/);
assert.throws(()=>chain.verifyPurchase(signed,prepared,other.publicKey.toBase58()),/purchase_signer_mismatch/);
const changed=VersionedTransaction.deserialize(Buffer.from(signed,"base64"));changed.message.recentBlockhash=buyer.publicKey.toBase58();changed.sign([signer,buyer]);
assert.throws(()=>chain.verifyPurchase(Buffer.from(changed.serialize()).toString("base64"),prepared,wallet),/purchase_transaction_changed/);
await chain.send(valid);assert.equal(sends,1);
assert.equal(await chain.receipt("purchase",row),null);assert.equal(receiptReads.at(-1),"finalized","Financial credit must wait for finalized L1 receipt");
statuses={err:{InstructionError:[0,"fixture"]},confirmationStatus:"processed"};assert.deepEqual(await chain.inspect(valid),{pending:true});
statuses={err:{InstructionError:[0,"fixture"]},confirmationStatus:"confirmed"};assert.deepEqual(await chain.inspect(valid),{pending:true});
statuses={err:{InstructionError:[0,"fixture"]},confirmationStatus:"finalized"};assert((await chain.inspect(valid)).confirmedFailure);
statuses=null;assert((await chain.inspect(valid)).pending);finalizedHeight=101;assert((await chain.inspect(valid)).expired);
const withdrawal=await chain.build("withdrawal",{...row,id:"claim-fixture",cents:200});assert(withdrawal.signed);
const payout=VersionedTransaction.deserialize(Buffer.from(withdrawal.bytes,"base64"));assert.equal(payout.message.header.numRequiredSignatures,1,"CATO sponsors payouts without a player transaction signature");
await assert.rejects(createCashierChain({connection:{...connection,getGenesisHash:async()=>"mainnet"},manifest,key:signer,verified:async()=>true}).build("purchase",row),/devnet_genesis_mismatch/);
await assert.rejects(createCashierChain({connection,manifest,key:signer,verified:async()=>false}).build("purchase",row),/cashier_program_upgrade_required/);
console.log("PASS: exact devnet mint/ATA/PDA encoding, isolated cashier authority, immutable receipt binding, price validation, both purchase signatures, rejection of changed wallet transactions, CATO-paid payouts, finalized-only financial receipts/failures and no timeout-based reroll.");
