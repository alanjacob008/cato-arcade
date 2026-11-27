import {createHash} from "node:crypto";
import {Keypair,PublicKey,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction} from "@solana/web3.js";
import {discriminator,u64,LOADER} from "./vrf-deployment.mjs";
import {DEVNET_GENESIS} from "./vrf-devnet.mjs";
import {encodeSignature} from "./vrf-sponsor.mjs";

export const SPONSOR_DEFAULTS=Object.freeze({lowLamports:2_000_000,targetLamports:5_000_000,dailyLimit:50_000_000,
  totalLimit:250_000_000,reserveLamports:10_000_000,cooldownSeconds:60,policySeconds:7*86400});
// This separately built, inactive funding contract has a fixed four-recipient ABI.
export const SPONSOR_LANES=4;
const pub=value=>new PublicKey(value),meta=(pubkey,isWritable=false,isSigner=false)=>({pubkey:pub(pubkey),isWritable,isSigner});
const integer=value=>{if(!Number.isSafeInteger(value)||value<0)throw Error("invalid_sponsorship_integer");return value;};
export const sponsorshipAddress=(manifest,owner)=>PublicKey.findProgramAddressSync([Buffer.from("claw-sponsor-v1"),pub(owner).toBuffer()],pub(manifest.program));
export function sponsorshipFeeKey(env){
  if(!env.CLAW_SPONSOR_FEE_WALLET||!env.CLAW_SPONSOR_FEE_SECRET)throw Error("sponsorship_fee_wallet_configuration_required");
  let key;try{const bytes=JSON.parse(env.CLAW_SPONSOR_FEE_SECRET);if(!Array.isArray(bytes)||bytes.length!==64||!bytes.every(n=>Number.isInteger(n)&&n>=0&&n<=255))throw Error();key=Keypair.fromSecretKey(Uint8Array.from(bytes));}catch{throw Error("invalid_sponsorship_fee_secret");}
  if(key.publicKey.toBase58()!==env.CLAW_SPONSOR_FEE_WALLET)throw Error("sponsorship_fee_wallet_mismatch");return key;
}
export function encodeSponsorshipPolicy(policy){
  return Buffer.concat([policy.lowLamports,policy.targetLamports,policy.dailyLimit,policy.totalLimit,policy.reserveLamports,
    policy.cooldownSeconds,policy.authorizedUntil].map(n=>u64(integer(n))));
}
export function sponsorshipInstruction(manifest,owner,action,options={}){
  const [vault]=sponsorshipAddress(manifest,owner);let keys=[meta(owner,true,true),meta(vault,true)],data;
  if(action==="initialize"){
    if(options.recipients?.length!==4||new Set(options.recipients).size!==4)throw Error("invalid_sponsorship_recipients");
    keys.push(meta(SystemProgram.programId));data=Buffer.concat([pub(options.keeper).toBuffer(),...options.recipients.map(key=>pub(key).toBuffer()),encodeSponsorshipPolicy(options.policy)]);
  }else if(action==="configure")data=Buffer.concat([pub(options.keeper).toBuffer(),encodeSponsorshipPolicy(options.policy)]);
  else if(action==="set_paused"){if(typeof options.paused!=="boolean")throw Error("invalid_sponsorship_pause");data=Buffer.from([Number(options.paused)]);}
  else if(action==="withdraw")data=u64(integer(options.lamports));
  else if(action==="top_up"){
    if(!Number.isInteger(options.index)||options.index<0||options.index>3)throw Error("invalid_sponsorship_lane");
    keys=[meta(options.keeper,false,true),meta(vault,true),meta(options.recipient,true)];
    data=Buffer.concat([Buffer.from([options.index]),u64(integer(options.nonce))]);
  }else throw Error("invalid_sponsorship_action");
  return new TransactionInstruction({programId:pub(manifest.program),keys,data:Buffer.concat([discriminator("global:"+action),data])});
}
export function decodeSponsorship(account,manifest,owner,keeper,recipients){
  if(!account)return null;const b=account.data,[,bump]=sponsorshipAddress(manifest,owner);
  if(!account.owner.equals(pub(manifest.program))||account.executable||b.length!==346||!b.subarray(0,8).equals(discriminator("account:SponsorshipVault"))
    ||!b.subarray(8,40).equals(pub(owner).toBuffer())||!b.subarray(40,72).equals(pub(keeper).toBuffer())||b[256]!==bump||![0,1].includes(b[257]))throw Error("sponsorship_account_mismatch");
  if(recipients.length!==4||new Set(recipients).size!==4||recipients.some((key,i)=>!b.subarray(72+i*32,104+i*32).equals(pub(key).toBuffer())))throw Error("sponsorship_recipient_mismatch");
  const read=offset=>integer(Number(b.readBigUInt64LE(offset)));
  const policy={lowLamports:read(200),targetLamports:read(208),dailyLimit:read(216),totalLimit:read(224),reserveLamports:read(232),cooldownSeconds:read(240),authorizedUntil:read(248)};
  if(!policy.lowLamports||policy.lowLamports>=policy.targetLamports||policy.targetLamports>policy.dailyLimit||policy.dailyLimit>1e9||policy.totalLimit<policy.dailyLimit||policy.totalLimit>30e9||policy.cooldownSeconds<60||policy.cooldownSeconds>86400)throw Error("sponsorship_policy_mismatch");
  const spentToday=read(266),spentTotal=read(274);if(spentToday>policy.dailyLimit||spentTotal>policy.totalLimit)throw Error("sponsorship_budget_mismatch");
  return {policy,paused:!!b[257],day:read(258),spentToday,spentTotal,nonces:Array.from({length:4},(_,i)=>read(282+i*8)),lastTopups:Array.from({length:4},(_,i)=>read(314+i*8)),balance:integer(account.lamports)};
}

export function createSponsorshipChain({connection,manifest,owner,feeKey,recipients,now=Date.now}){
  if(!Array.isArray(recipients)||recipients.length!==SPONSOR_LANES)throw Error("sponsorship_pool_size_upgrade_required");
  const [vault]=sponsorshipAddress(manifest,owner),keeper=feeKey.publicKey;
  let verifiedUntil=0;
  async function verifyProgram(){
    if(manifest.cluster!=="devnet"||await connection.getGenesisHash()!==DEVNET_GENESIS)throw Error("sponsorship_devnet_required");
    const expected=manifest.verifiedArtifact;
    if(!expected||!Number.isSafeInteger(expected.bytes)||expected.bytes<1||!/^[a-f0-9]{64}$/.test(expected.sha256))throw Error("sponsorship_verified_build_required");
    if(now()<verifiedUntil)return;
    const program=pub(manifest.program),[address]=PublicKey.findProgramAddressSync([program.toBuffer()],LOADER);
    const [account,data]=await connection.getMultipleAccountsInfo([program,address],"finalized");
    if(!account?.executable||!account.owner.equals(LOADER)||account.data.length!==36||account.data.readUInt32LE(0)!==2||!account.data.subarray(4).equals(address.toBuffer())
      ||!data?.owner.equals(LOADER)||data.executable||data.data.length<45+expected.bytes||data.data.readUInt32LE(0)!==3||data.data[12]!==1
      ||!data.data.subarray(13,45).equals(pub(manifest.deploymentAuthority).toBuffer())
      ||createHash("sha256").update(data.data.subarray(45,45+expected.bytes)).digest("hex")!==expected.sha256||!data.data.subarray(45+expected.bytes).every(n=>n===0))throw Error("sponsorship_program_mismatch");
    verifiedUntil=now()+30000;
  }
  return {
    async snapshot(){await verifyProgram();const accounts=await connection.getMultipleAccountsInfo([vault,keeper,...recipients.map(pub)],"finalized");
      const state=decodeSponsorship(accounts[0],manifest,owner,keeper,recipients);if(!state)throw Error("sponsorship_vault_setup_required");
      if(accounts[1]&&(!accounts[1].owner.equals(SystemProgram.programId)||accounts[1].executable||accounts[1].data.length))throw Error("sponsorship_fee_wallet_not_system_wallet");
      const floor=await connection.getMinimumBalanceForRentExemption(346);
      const balances=accounts.slice(2).map(account=>{if(account&&(!account.owner.equals(SystemProgram.programId)||account.executable||account.data.length))throw Error("sponsorship_recipient_not_system_wallet");return account?.lamports??0;});
      return {...state,available:Math.max(0,state.balance-floor-state.policy.reserveLamports),feeBalance:accounts[1]?.lamports??0,balances,vault:vault.toBase58(),keeper:keeper.toBase58()};
    },
    async build(index,nonce){await verifyProgram();const instruction=sponsorshipInstruction(manifest,owner,"top_up",{keeper,recipient:recipients[index],index,nonce});
      const block=await connection.getLatestBlockhash("confirmed"),tx=new VersionedTransaction(new TransactionMessage({payerKey:keeper,recentBlockhash:block.blockhash,instructions:[instruction]}).compileToV0Message());tx.sign([feeKey]);
      return {index,nonce,bytes:Buffer.from(tx.serialize()).toString("base64"),signature:encodeSignature(tx.signatures[0]),block};
    },
    async inspect(wire){const result=(await connection.getSignatureStatuses([wire.signature],{searchTransactionHistory:true})).value[0];
      if(result?.confirmationStatus==="finalized")return result.err?{failed:true}:{finalized:true};
      if(result)return {pending:true};
      return {expired:await connection.getBlockHeight("finalized")>wire.block.lastValidBlockHeight};
    },
    async send(wire){await verifyProgram();const signature=await connection.sendRawTransaction(Buffer.from(wire.bytes,"base64"),{skipPreflight:false,maxRetries:2});if(signature!==wire.signature)throw Error("sponsorship_signature_mismatch");},
  };
}
