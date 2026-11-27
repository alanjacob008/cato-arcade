import assert from "node:assert/strict";
import {createHash,createPublicKey,verify} from "node:crypto";
import {Keypair,PublicKey,SystemProgram,VersionedTransaction} from "@solana/web3.js";
import {SPONSOR_DEFAULTS,sponsorshipFeeKey,sponsorshipAddress,sponsorshipInstruction,decodeSponsorship,createSponsorshipChain} from "./lib/claw-sponsorship-chain.mjs";
import {createSponsorshipWorker} from "./lib/claw-sponsorship-worker.mjs";
import {discriminator,LOADER} from "./lib/vrf-deployment.mjs";
import {DEVNET_GENESIS} from "./lib/vrf-devnet.mjs";

const owner=Keypair.generate().publicKey,feeKey=Keypair.generate(),recipients=Array.from({length:4},()=>Keypair.generate().publicKey.toBase58());
const binary=Buffer.from("verified isolated funding program"),manifest={cluster:"devnet",program:Keypair.generate().publicKey.toBase58(),deploymentAuthority:owner.toBase58(),verifiedArtifact:{bytes:binary.length,sha256:createHash("sha256").update(binary).digest("hex")}};
const [vault,bump]=sponsorshipAddress(manifest,owner),now=100000000;
assert.throws(()=>createSponsorshipChain({connection:{},manifest,owner,feeKey,recipients:[...recipients,...recipients]}),/sponsorship_pool_size_upgrade_required/,
  "The inactive four-recipient funding contract must not silently cover only half an eight-lane pool");
const policy={...SPONSOR_DEFAULTS,authorizedUntil:1000000};
const data=Buffer.alloc(346);discriminator("account:SponsorshipVault").copy(data);owner.toBuffer().copy(data,8);feeKey.publicKey.toBuffer().copy(data,40);
recipients.forEach((key,i)=>new PublicKey(key).toBuffer().copy(data,72+i*32));
[policy.lowLamports,policy.targetLamports,policy.dailyLimit,policy.totalLimit,policy.reserveLamports,policy.cooldownSeconds,policy.authorizedUntil].forEach((value,i)=>data.writeBigUInt64LE(BigInt(value),200+i*8));data[256]=bump;
data.writeBigUInt64LE(1n,258);
const account={owner:new PublicKey(manifest.program),data,lamports:100000000,executable:false};
const state=decodeSponsorship(account,manifest,owner,feeKey.publicKey,recipients);assert.equal(state.policy.dailyLimit,50_000_000);
assert.throws(()=>decodeSponsorship(account,manifest,owner,feeKey.publicKey,[recipients[1],recipients[0],...recipients.slice(2)]),/recipient_mismatch/);
assert.throws(()=>decodeSponsorship({...account,owner:SystemProgram.programId},manifest,owner,feeKey.publicKey,recipients),/account_mismatch/);
assert.equal(sponsorshipFeeKey({CLAW_SPONSOR_FEE_WALLET:feeKey.publicKey.toBase58(),CLAW_SPONSOR_FEE_SECRET:JSON.stringify([...feeKey.secretKey])}).publicKey.toBase58(),feeKey.publicKey.toBase58());
assert.throws(()=>sponsorshipFeeKey({CLAW_SPONSOR_FEE_WALLET:owner.toBase58(),CLAW_SPONSOR_FEE_SECRET:JSON.stringify([...feeKey.secretKey])}),/wallet_mismatch/);
assert.throws(()=>sponsorshipFeeKey({CLAW_SPONSOR_FEE_WALLET:owner.toBase58(),CLAW_SPONSOR_FEE_SECRET:'[-1]'}),/invalid_sponsorship_fee_secret/);
const ix=sponsorshipInstruction(manifest,owner,"top_up",{keeper:feeKey.publicKey,recipient:recipients[0],index:0,nonce:0});
assert.equal(ix.keys.length,3);assert.equal(ix.keys[0].isSigner,true);assert.equal(ix.keys[2].pubkey.toBase58(),recipients[0]);assert.equal(ix.data.length,17);
assert.throws(()=>sponsorshipInstruction(manifest,owner,"top_up",{index:4}),/lane/);
let wrongGenesis=false,tamperBinary=false,sends=0;
const program=new PublicKey(manifest.program),[programData]=PublicKey.findProgramAddressSync([program.toBuffer()],LOADER);
const programHeader=Buffer.alloc(36);programHeader.writeUInt32LE(2);programData.toBuffer().copy(programHeader,4);
const loaderHeader=Buffer.alloc(45);loaderHeader.writeUInt32LE(3);loaderHeader[12]=1;owner.toBuffer().copy(loaderHeader,13);
const connection={getGenesisHash:async()=>wrongGenesis?"mainnet":DEVNET_GENESIS,
  getMultipleAccountsInfo:async keys=>keys[0].equals(program)?[{owner:LOADER,executable:true,data:programHeader},{owner:LOADER,executable:false,data:Buffer.concat([loaderHeader,tamperBinary?Buffer.alloc(binary.length):binary])}]
    :[account,{owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0),lamports:25e9},...recipients.map(()=>({owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0),lamports:0}))],
  getMinimumBalanceForRentExemption:async()=>1000000,getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:200}),
  sendRawTransaction:async bytes=>{const tx=VersionedTransaction.deserialize(bytes);assert.equal(tx.message.staticAccountKeys[0].toBase58(),feeKey.publicKey.toBase58());sends++;return (await import("./lib/vrf-sponsor.mjs")).encodeSignature(tx.signatures[0]);},
  getSignatureStatuses:async()=>({value:[null]}),getBlockHeight:async()=>100};
const live=createSponsorshipChain({connection,manifest,owner,feeKey,recipients,now:()=>now});
assert.equal((await live.snapshot()).balances.length,4);const signed=await live.build(0,0);await live.send(signed);assert.equal(sends,1);
const tx=VersionedTransaction.deserialize(Buffer.from(signed.bytes,"base64")),publicKey=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),feeKey.publicKey.toBuffer()]),format:"der",type:"spki"});
assert(verify(null,tx.message.serialize(),publicKey,tx.signatures[0]));
tamperBinary=true;await assert.rejects(createSponsorshipChain({connection,manifest,owner,feeKey,recipients}).snapshot(),/program_mismatch/);tamperBinary=false;
wrongGenesis=true;await assert.rejects(live.send(signed),/devnet_required/);wrongGenesis=false;
await assert.rejects(createSponsorshipChain({connection,manifest:{...manifest,verifiedArtifact:null},owner,feeKey,recipients}).snapshot(),/verified_build_required/);

const initial=()=>({...state,balance:100e6,available:80e6,feeBalance:25e9,balances:[1e6,5e6,5e6,5e6],vault:vault.toBase58(),keeper:feeKey.publicKey.toBase58()});
let current=initial(),sent=[],persisted=null,failSave=false,ambiguous=false,inspection={},built=0,alerts=[];
const store={},save=async()=>{if(failSave)throw Error("storage_unavailable");persisted=structuredClone(store);};
const chain={snapshot:async()=>structuredClone(current),build:async(index,nonce)=>({index,nonce,signature:"sig"+(++built),bytes:"fixed-signed-bytes",block:{lastValidBlockHeight:200}}),inspect:async()=>inspection,
  send:async wire=>{assert.equal(persisted.pending?.bytes,wire.bytes,"durable-before-broadcast");sent.push(wire.signature);if(ambiguous)throw Error("rpc_timeout");}};
const make=()=>createSponsorshipWorker({chain,store,save,now:()=>now,onAlert:code=>alerts.push(code)});
let worker=make();ambiguous=true;await assert.rejects(worker.tick(),/rpc_timeout/);assert.equal(sent.length,1);assert.equal(store.pending.nonce,0);
worker=make();ambiguous=false;await Promise.all([worker.tick(),worker.tick()]);assert.deepEqual(sent,["sig1","sig1"]);assert.equal(built,1);
current.nonces[0]=1;await worker.tick();assert.equal(store.pending,null);assert.equal(store.receipts.length,1);
current=initial();failSave=true;await assert.rejects(worker.tick(),/storage_unavailable/);const count=sent.length;await assert.rejects(worker.tick(),/storage_unavailable/);assert.equal(sent.length,count);
failSave=false;await worker.tick();assert.equal(sent.length,count+1);
inspection={expired:true};await worker.tick();assert.equal(store.pending,null);inspection={};
current={...initial(),available:1};await worker.tick();assert.equal(worker.status().alert,"sponsorship_vault_low");
current={...initial(),feeBalance:1};await worker.tick();assert.equal(worker.status().alert,"sponsorship_fee_wallet_low");
current={...initial(),paused:true};await worker.tick();assert.equal(worker.status().alert,"sponsorship_policy_paused_or_expired");
current={...initial(),spentToday:50e6};await worker.tick();assert.equal(worker.status().alert,"sponsorship_budget_exhausted");
assert.equal(store.pending,null);
console.log("PASS: fixed devnet program/mint-independent vault, exact recipient/keeper binding, pinned binary/genesis, real signed top-up transactions, fee-key validation, durable-before-send, ambiguous-response/restart retries, nonce settlement, concurrent tick coalescing, failed-save recovery, expiry, pause, budgets and low-balance alerts.");
