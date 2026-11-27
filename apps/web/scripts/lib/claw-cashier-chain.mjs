import { createHash, createPublicKey, verify } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { discriminator, u64 } from "./vrf-deployment.mjs";
import { DEVNET_GENESIS } from "./vrf-devnet.mjs";
import { encodeSignature } from "./vrf-sponsor.mjs";

export const CASHIER_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const CASHIER_SEED = Buffer.from("cashier-devnet-v1");
const reference = id => createHash("sha256").update("cato-devnet-usdc-v1:"+id).digest();
const meta = (pubkey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
const safe = n => {const result=Number(n);if(!Number.isSafeInteger(result)||result<0)throw Error("invalid_cashier_amount");return result;};
export function cashierAddresses(manifest,wallet,id) {
  const program=new PublicKey(manifest.vrfProbeProgram),[cashier,bump]=PublicKey.findProgramAddressSync([CASHIER_SEED],program);
  const result={program,cashier,bump,vault:getAssociatedTokenAddressSync(CASHIER_MINT,cashier,true)};
  if(wallet){const buyer=new PublicKey(wallet);Object.assign(result,{wallet:buyer,token:getAssociatedTokenAddressSync(CASHIER_MINT,buyer),reference:reference(id),
    deposit:PublicKey.findProgramAddressSync([Buffer.from("cashier-deposit"),cashier.toBuffer(),buyer.toBuffer(),reference(id)],program)[0],
    claim:PublicKey.findProgramAddressSync([Buffer.from("cashier-claim"),cashier.toBuffer(),reference(id)],program)[0]});}
  return result;
}
export function decodeCashier(account,manifest,settlement) {
  if(!account)return null;
  const p=cashierAddresses(manifest),b=account.data;
  if(!account.owner.equals(p.program)||b.length!==138||!b.subarray(0,8).equals(discriminator("account:DevnetCashier"))
    ||!b.subarray(8,40).equals(new PublicKey(manifest.adminAuthority).toBuffer())||!b.subarray(40,72).equals(settlement.toBuffer())
    ||!b.subarray(72,104).equals(CASHIER_MINT.toBuffer())||b[104]!==p.bump||![0,1].includes(b[105]))throw Error("cashier_account_mismatch");
  const dailyLimit=safe(b.readBigUInt64LE(106)),day=safe(b.readBigInt64LE(114)),paidToday=safe(b.readBigUInt64LE(122)),maxClaim=safe(b.readBigUInt64LE(130));
  if(!maxClaim||maxClaim%10000||maxClaim>dailyLimit||dailyLimit>100_000_000_000||paidToday>dailyLimit)throw Error("cashier_policy_mismatch");
  return {paused:!!b[105],dailyLimit,day,paidToday,maxClaim};
}
export function decodeCashierReceipt(kind,account,manifest,row) {
  if(!account)return null;
  const p=cashierAddresses(manifest,row.wallet,row.id),b=account.data,isDeposit=kind==="purchase",amount=BigInt(row.cents)*10000n;
  if(!account.owner.equals(p.program)||b.length!==(isDeposit?83:80)||!b.subarray(0,8).equals(discriminator("account:"+(isDeposit?"DevnetDepositReceipt":"DevnetWithdrawalReceipt")))
    ||!b.subarray(8,40).equals(p.wallet.toBuffer())||!b.subarray(40,72).equals(p.reference)
    ||(isDeposit&&(b[72]!==row.tier||b.readUInt16LE(73)!==row.quantity))||b.readBigUInt64LE(isDeposit?75:72)!==amount)throw Error("cashier_receipt_mismatch");
  return {verified:true,id:row.id,wallet:row.wallet,cents:safe(row.cents),...(isDeposit?{tier:row.tier,quantity:row.quantity}:{}),receipt:(isDeposit?p.deposit:p.claim).toBase58()};
}
export function initializeCashierInstruction(manifest,settlement) {
  const p=cashierAddresses(manifest),admin=new PublicKey(manifest.adminAuthority);
  return [createAssociatedTokenAccountIdempotentInstruction(admin,p.vault,p.cashier,CASHIER_MINT),new TransactionInstruction({programId:p.program,
    keys:[meta(admin,true,true),meta(p.cashier,true),meta(CASHIER_MINT),meta(p.vault),meta(SystemProgram.programId)],
    data:Buffer.concat([discriminator("global:initialize_devnet_cashier"),settlement.toBuffer(),u64(10_000_000_000),u64(1_000_000_000)])})];
}
export function cashierInstruction(kind,manifest,settlement,row) {
  const p=cashierAddresses(manifest,row.wallet,row.id);
  if(kind==="purchase"){
    if(!Number.isInteger(row.tier)||row.tier<0||row.tier>2||!Number.isInteger(row.quantity)||row.quantity<1||row.quantity>1000
      ||safe(row.cents)!==[200,400,600][row.tier]*row.quantity)throw Error("invalid_purchase");
    const quantity=Buffer.alloc(2);quantity.writeUInt16LE(row.quantity);
    return new TransactionInstruction({programId:p.program,keys:[meta(settlement,true,true),meta(p.wallet,false,true),meta(p.cashier),meta(p.deposit,true),
      meta(CASHIER_MINT),meta(p.token,true),meta(p.vault,true),meta(TOKEN_PROGRAM_ID),meta(SystemProgram.programId)],
      data:Buffer.concat([discriminator("global:deposit_devnet_tokens"),p.reference,Buffer.from([row.tier]),quantity])});
  }
  if(kind!=="withdrawal"||!safe(row.cents))throw Error("invalid_withdrawal");
  return new TransactionInstruction({programId:p.program,keys:[meta(settlement,true,true),meta(p.cashier,true),meta(p.wallet),meta(p.claim,true),
    meta(CASHIER_MINT),meta(p.vault,true),meta(p.token,true),meta(TOKEN_PROGRAM_ID),meta(SystemProgram.programId)],
    data:Buffer.concat([discriminator("global:withdraw_devnet_winnings"),p.reference,u64(BigInt(row.cents)*10000n)])});
}
export function verifySignedPurchase(encoded,prepared,wallet) {
  if(typeof encoded!=="string"||encoded.length>4000||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw Error("invalid_signed_purchase");
  const tx=VersionedTransaction.deserialize(Buffer.from(encoded,"base64")),expected=VersionedTransaction.deserialize(Buffer.from(prepared.bytes,"base64"));
  const message=Buffer.from(tx.message.serialize());
  if(tx.version!==0||!message.equals(Buffer.from(expected.message.serialize()))||!Buffer.from(tx.signatures[0]).equals(Buffer.from(expected.signatures[0])))throw Error("purchase_transaction_changed");
  const required=tx.message.header.numRequiredSignatures,keys=tx.message.staticAccountKeys.slice(0,required);
  if(required!==2||keys[1].toBase58()!==wallet||tx.signatures.length!==required)throw Error("purchase_signer_mismatch");
  for(let i=0;i<required;i++){
    const key=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),keys[i].toBuffer()]),format:"der",type:"spki"});
    if(!verify(null,message,key,tx.signatures[i]))throw Error("purchase_signature_invalid");
  }
  return {...prepared,bytes:Buffer.from(tx.serialize()).toString("base64"),signed:true};
}

export function createCashierChain({connection,manifest,key,verified}) {
  async function ready() {
    if(await connection.getGenesisHash()!==DEVNET_GENESIS)throw Error("devnet_genesis_mismatch");
    if(!manifest.verifiedArtifact.capabilities?.includes("devnet-cashier-v1")||!await verified())throw Error("cashier_program_upgrade_required");
    const p=cashierAddresses(manifest),state=decodeCashier(await connection.getAccountInfo(p.cashier,"confirmed"),manifest,key.publicKey);
    if(!state)throw Error("cashier_setup_required");if(state.paused)throw Error("cashier_paused");return state;
  }
  return {
    async status(){try{const state=await ready(),p=cashierAddresses(manifest);return {ready:true,cluster:"devnet",mint:CASHIER_MINT.toBase58(),vault:p.vault.toBase58(),...state};}catch(error){return {ready:false,error:/^[a-z_]+$/.test(error.message)?error.message:"cashier_unavailable"};}},
    async build(kind,row){const state=await ready();if(kind==="withdrawal"&&BigInt(row.cents)*10000n>BigInt(state.maxClaim))throw Error("withdrawal_exceeds_cashier_limit");
      const instructions=[];
      if(kind==="withdrawal"){const p=cashierAddresses(manifest,row.wallet,row.id);instructions.push(createAssociatedTokenAccountIdempotentInstruction(key.publicKey,p.token,p.wallet,CASHIER_MINT));}
      instructions.push(cashierInstruction(kind,manifest,key.publicKey,row));
      const block=await connection.getLatestBlockhash("confirmed"),tx=new VersionedTransaction(new TransactionMessage({payerKey:key.publicKey,recentBlockhash:block.blockhash,instructions}).compileToV0Message());tx.sign([key]);
      return {bytes:Buffer.from(tx.serialize()).toString("base64"),signature:encodeSignature(tx.signatures[0]),block,signed:kind==="withdrawal"};
    },
    async receipt(kind,row){
      if(await connection.getGenesisHash()!==DEVNET_GENESIS||!await verified())throw Error("cashier_program_verification_failed");
      const p=cashierAddresses(manifest,row.wallet,row.id),address=kind==="purchase"?p.deposit:p.claim;
      const account=await connection.getAccountInfo(address,"finalized"),proof=decodeCashierReceipt(kind,account,manifest,row);
      if(!proof)return null;
      // Receipt PDAs are immutable, unique per intent and written atomically with TransferChecked.
      return {...proof,signature:row.wire?.signature??null,cluster:"devnet",mint:CASHIER_MINT.toBase58()};
    },
    async inspect(wire){
      const result=(await connection.getSignatureStatuses([wire.signature],{searchTransactionHistory:true})).value[0];
      if(result?.err)return result.confirmationStatus==="finalized"?{failed:true,confirmedFailure:true,signature:wire.signature}:{pending:true};
      if(result?.confirmationStatus==="confirmed"||result?.confirmationStatus==="finalized")return {confirmed:true};
      // Do not replace a transaction based on elapsed wall time or an RPC timeout.
      const expired=await connection.getBlockHeight("finalized")>wire.block.lastValidBlockHeight;
      return {expired,pending:!expired};
    },
    async send(wire){if(!wire.signed)throw Error("wallet_signature_required");await ready();
      const signature=await connection.sendRawTransaction(Buffer.from(wire.bytes,"base64"),{skipPreflight:false,maxRetries:2});
      if(signature!==wire.signature)throw Error("cashier_signature_mismatch");return signature;},
    verifyPurchase:verifySignedPurchase,
  };
}
