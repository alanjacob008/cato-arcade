import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { discriminator, decodeAttempt } from "./vrf-deployment.mjs";
import { ER_VALIDATOR, DELEGATION_PROGRAM, MAGIC_PROGRAM, MAGIC_CONTEXT, requestErProbe, decodeErSession } from "./vrf-er.mjs";

export const POOL_SIZE = 8;
export const POOL_ACCOUNT_BYTES = 280;
export const POOL_POLICY = Object.freeze({ batchRequests: 500, grantSeconds: 21600, dailyLimit: 1000, totalLimit: 7000, lifetimeSeconds: 7 * 86400 });
// The validator Clock can lag local wall time; leave room below the contract's seven-day ceiling.
export const POOL_POLICY_CLOCK_MARGIN = 60;
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const program = config => new PublicKey(config.vrfProbeProgram);
export function erPoolAddress(config, delegate) {
  return PublicKey.findProgramAddressSync([Buffer.from("er-pool"), new PublicKey(config.adminAuthority).toBuffer(), delegate.toBuffer()], program(config));
}
export function erPoolDelegationAddresses(config, delegate) {
  const [session] = erPoolAddress(config, delegate);
  return {session, buffer:PublicKey.findProgramAddressSync([Buffer.from("buffer"),session.toBuffer()],program(config))[0],
    record:PublicKey.findProgramAddressSync([Buffer.from("delegation"),session.toBuffer()],DELEGATION_PROGRAM)[0],
    metadata:PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"),session.toBuffer()],DELEGATION_PROGRAM)[0]};
}
export function validatePoolPolicy(policy) {
  if (!policy || !Number.isSafeInteger(policy.authorizedUntil) || policy.authorizedUntil <= 0
    || !Number.isInteger(policy.batchRequests) || policy.batchRequests < 1 || policy.batchRequests > 500
    || !Number.isSafeInteger(policy.grantSeconds) || policy.grantSeconds < 1 || policy.grantSeconds > 86400
    || !Number.isInteger(policy.dailyLimit) || policy.dailyLimit < 1 || policy.dailyLimit > 10000
    || !Number.isInteger(policy.totalLimit) || policy.totalLimit < 1 || policy.totalLimit > 70000) throw Error("invalid_pool_policy");
  return policy;
}
export function initializeErPoolSession(config, delegate, policy, update = false) {
  validatePoolPolicy(policy);
  const bytes=Buffer.alloc(26);
  bytes.writeBigInt64LE(BigInt(policy.authorizedUntil),0); bytes.writeUInt16LE(policy.batchRequests,8);
  bytes.writeBigInt64LE(BigInt(policy.grantSeconds),10); bytes.writeUInt32LE(policy.dailyLimit,18); bytes.writeUInt32LE(policy.totalLimit,22);
  return new TransactionInstruction({programId:program(config),
    keys:[meta(new PublicKey(config.adminAuthority),!update,true),meta(erPoolAddress(config,delegate)[0],true),...(!update?[meta(SystemProgram.programId)]:[])],
    data:Buffer.concat([discriminator("global:"+(update?"update_er_pool_policy":"initialize_er_pool_session")),
      ...(!update?[delegate.toBuffer(),ER_VALIDATOR.toBuffer()]:[]),bytes])});
}
export function delegateErPoolSession(config, delegate) {
  const p=erPoolDelegationAddresses(config,delegate);
  return new TransactionInstruction({programId:program(config),
    keys:[meta(new PublicKey(config.adminAuthority),true,true),meta(p.buffer,true),meta(p.record,true),meta(p.metadata,true),
      meta(p.session,true),meta(ER_VALIDATOR),meta(program(config)),meta(DELEGATION_PROGRAM),meta(SystemProgram.programId)],
    data:Buffer.concat([discriminator("global:delegate_er_pool_session"),delegate.toBuffer()])});
}
export function requestErPoolProbe(config,delegate,...args) {
  const request=requestErProbe(config,delegate,...args),[attempt,bump]=erPoolAddress(config,delegate);
  request.instruction.keys[1]=meta(attempt,true);
  discriminator("global:request_er_pool_probe").copy(request.instruction.data);
  return {...request,attempt,bump};
}
export function pauseErPoolSession(config,delegate) {
  return new TransactionInstruction({programId:program(config),keys:[meta(delegate,false,true),meta(erPoolAddress(config,delegate)[0],true)],
    data:discriminator("global:pause_er_pool_session")});
}
export function undelegateErPoolSession(config,delegate) {
  return new TransactionInstruction({programId:program(config),
    keys:[meta(delegate,true,true),meta(erPoolAddress(config,delegate)[0],true),meta(MAGIC_PROGRAM),meta(MAGIC_CONTEXT,true)],
    data:discriminator("global:undelegate_er_pool_session")});
}
export function decodeErPoolSession(account,config,delegate) {
  if(!account)return null;
  const b=account.data;
  if(b.length!==POOL_ACCOUNT_BYTES || !b.subarray(0,8).equals(discriminator("account:ErPoolSession")))throw Error("er_pool_session_mismatch");
  const legacy={...account,data:Buffer.concat([discriminator("account:ErSession"),b.subarray(8,233)])};
  const state=decodeErSession(legacy,config,delegate,erPoolAddress);
  const policy={authorizedUntil:Number(b.readBigInt64LE(233)),batchRequests:b.readUInt16LE(241),grantSeconds:Number(b.readBigInt64LE(243)),
    dailyLimit:b.readUInt32LE(251),totalLimit:b.readUInt32LE(255),usedToday:b.readUInt32LE(259),usedTotal:b.readUInt32LE(263),
    day:Number(b.readBigInt64LE(267)),paused:!!b[275],renewals:b.readUInt32LE(276)};
  validatePoolPolicy(policy);
  if(!Number.isSafeInteger(policy.day)||policy.day<0||![0,1].includes(b[275])||policy.usedToday>policy.dailyLimit
    ||policy.usedToday>policy.usedTotal||policy.usedTotal>policy.totalLimit||state.nextNonce!==String(policy.usedTotal)
    ||state.remaining>policy.batchRequests||state.expiresAt>policy.authorizedUntil||policy.renewals>policy.usedTotal)throw Error("er_pool_policy_mismatch");
  return {...state,...policy};
}
export function poolCapacity(state,nowSeconds=Math.floor(Date.now()/1000)) {
  if(!state||state.paused||nowSeconds>=state.authorizedUntil)return 0;
  const day=Math.floor(nowSeconds/86400);
  if(day<state.day)return 0;
  return Math.max(0,Math.min(state.totalLimit-state.usedTotal,state.dailyLimit-(day===state.day?state.usedToday:0)));
}
export function decodeErPoolAttempt(account,config,locked) {
  const delegate=new PublicKey(locked.requestAuthority),state=decodeErPoolSession(account,config,delegate);
  if(!state||!state.hasAttempt||BigInt(state.nextNonce)<=BigInt(locked.nonce))return null;
  if(state.nextNonce!==(BigInt(locked.nonce)+1n).toString()||erPoolAddress(config,delegate)[0].toBase58()!==locked.attempt)throw Error("er_pool_attempt_mismatch");
  return decodeAttempt({...account,data:Buffer.concat([discriminator("account:Attempt"),account.data.subarray(124,233)])},config,locked);
}
