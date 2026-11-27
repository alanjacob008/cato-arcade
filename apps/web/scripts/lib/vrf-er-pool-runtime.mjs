import {PublicKey,SystemProgram,VersionedTransaction} from "@solana/web3.js";
import {createGameService} from "./vrf-game.mjs";
import {createPoolGame} from "./vrf-pool-game.mjs";
import {preparePoolStore} from "./vrf-pool-store.mjs";
import {createSponsoredSender,encodeSignature,releaseDeadRequest} from "./vrf-sponsor.mjs";
import {createAttemptReader} from "./vrf-callbacks.mjs";
import {singleFlightCache} from "./vrf-rpc-transport.mjs";
import {matchesCallback,walletTransaction} from "./vrf-deployment.mjs";
import {DELEGATION_PROGRAM,ER_FUNDING,checkErDelegation} from "./vrf-er.mjs";
import {POOL_SIZE,POOL_POLICY,POOL_POLICY_CLOCK_MARGIN,erPoolAddress,erPoolDelegationAddresses,decodeErPoolSession,decodeErPoolAttempt,
  requestErPoolProbe,initializeErPoolSession,delegateErPoolSession,pauseErPoolSession,undelegateErPoolSession,poolCapacity} from "./vrf-er-pool.mjs";

export async function createErPoolRuntime({session,manifest,save,connection,executionConnection,rules,identity,verified,deployed,legacy}) {
  const keys=await preparePoolStore({session,adminAuthority:manifest.adminAuthority,save});
  session.poolRouting??={};
  const hints=new Map(),hintKey=locked=>[locked.attempt,locked.nonce].join(":");
  const refresh=createAttemptReader({connection:executionConnection,manifest,save,decode:decodeErPoolAttempt,
    callback:(tx,config,locked,result)=>matchesCallback(tx,config,locked,result,"consume_er_pool_probe"),
    hints:locked=>hints.get(hintKey(locked))??[]});
  const delegation=keys.map(key=>singleFlightCache(async()=>{
    const p=erPoolDelegationAddresses(manifest,key.publicKey);
    const [record,root]=await connection.getMultipleAccountsInfo([p.record,p.session]);
    if(!root?.owner.equals(DELEGATION_PROGRAM))throw Error("er_pool_not_delegated");
    return checkErDelegation(record,manifest);
  },15000));
  const permit=async index=>{
    await Promise.all([identity(),delegation[index].get()]);
    return decodeErPoolSession(await executionConnection.getAccountInfo(erPoolAddress(manifest,keys[index].publicKey)[0]),manifest,keys[index].publicKey);
  };
  const statuses=singleFlightCache(async()=>{
    await identity();
    const addresses=keys.flatMap(key=>{const p=erPoolDelegationAddresses(manifest,key.publicKey);return [p.session,key.publicKey,p.record];});
    const accounts=await connection.getMultipleAccountsInfo(addresses);
    const rollupAddresses=keys.map(key=>erPoolAddress(manifest,key.publicKey)[0]);
    const delegated=accounts.some((account,i)=>i%3===0&&account?.owner.equals(DELEGATION_PROGRAM));
    const local=delegated?await executionConnection.getMultipleAccountsInfo(rollupAddresses):[];
    let controlsChanged=false;
    const lanes=keys.map((key,i)=>{
      const account=accounts[i*3],base={id:session.poolLanes[i].id,index:i,address:key.publicKey.toBase58(),
        session:rollupAddresses[i].toBase58(),balanceSol:(accounts[i*3+1]?.lamports??0)/1e9,ready:false,remaining:0,pending:false};
      try {
      if(!account)return {...base,phase:"initialize"};
      const isDelegated=account.owner.equals(DELEGATION_PROGRAM);
      if(!isDelegated&&!account.owner.equals(new PublicKey(manifest.vrfProbeProgram)))throw Error("er_pool_owner_mismatch");
      if(isDelegated)checkErDelegation(accounts[i*3+2],manifest);
      const state=decodeErPoolSession(isDelegated?local[i]:account,manifest,key.publicKey);
      if(!state)throw Error("er_pool_account_missing");
      const control=session.poolLanes[i].control;
      if(control&&(control.action==="pause"&&state.paused||control.action==="return"&&!isDelegated)){
        delete session.poolLanes[i].control;controlsChanged=true;
      }
      const remaining=poolCapacity(state);
      return {...base,...state,grantRemaining:state.remaining,remaining,ready:isDelegated&&remaining>0,
        phase:isDelegated?"delegated":state.paused||state.authorizedUntil<=Date.now()/1000||state.usedTotal>=state.totalLimit?"update":"delegate"};
      } catch {
        // Fail this lane closed without blocking independently verified lanes.
        return {...base,phase:"unavailable",error:"pool_lane_verification_failed"};
      }
    });
    if(lanes.some(lane=>lane.ready)&&!session.poolEnabled){session.poolEnabled=true;await save();}
    if(controlsChanged)await save();
    return lanes;
  },1500);
  const lanes=session.poolLanes.map((store,index)=>{
    const key=keys[index];
    const sender=createSponsoredSender({connection:executionConnection,key,manifest,save,refreshAttempt:refresh,
      requestFactory:requestErPoolProbe,permitState:async()=>{
        const state=await permit(index);return state?{...state,remaining:poolCapacity(state),expiresAt:state.authorizedUntil}:null;
      }});
    const game=createGameService({session:store,rules,manifest,save,deployed:verified,requestAuthority:key.publicKey.toBase58(),
      prepare:()=>{throw Error("pool_wallet_signing_not_supported");},refreshAttempt:refresh,sendSponsored:sender,
      requestProbe:(config,...args)=>requestErPoolProbe(config,key.publicKey,...args),maxAttempts:70000,
      nextNonce:async()=>{const state=await permit(index);if(!state||state.pending)throw Error("er_pool_session_pending_or_missing");return state.nextNonce;}});
    return {id:store.id,game,has:id=>store.attempts.some(attempt=>attempt.gamePull?.id===id),attempts:()=>store.attempts,
      available:async()=>(await statuses.get())[index]};
  });
  const game=createPoolGame({store:session.poolRouting,lanes,save,enabled:()=>!!session.poolEnabled,legacy});
  await save();
  async function fixedAction(index,action) {
    const state=(await statuses.get())[index],store=session.poolLanes[index],key=keys[index];
    if(state.phase!=="delegated")throw Error("er_pool_not_delegated");
    if(action==="return"&&(!state.paused||state.pending))throw Error("pause_and_finish_pool_attempt_first");
    // A request that provably never landed (expired, no attempt for its nonce) is not in flight. Release it
    // with its nonce/seed/target kept, so the identical request is re-signed after renewal.
    if(action==="return")for(const attempt of store.attempts.filter(attempt=>attempt.requestSignature&&!attempt.callbackSignature))
      await releaseDeadRequest({connection:executionConnection,refreshAttempt:refresh,save},attempt);
    if(action==="return"&&store.attempts.some(attempt=>attempt.requestSignature&&!attempt.callbackSignature))throw Error("pool_receipt_verification_pending");
    const instruction=action==="pause"?pauseErPoolSession(manifest,key.publicKey):undelegateErPoolSession(manifest,key.publicKey);
    let pending=store.control;
    if(pending&&pending.action!==action)throw Error("pool_control_confirmation_pending");
    if(!pending){
      const block=await executionConnection.getLatestBlockhash(),tx=walletTransaction(key.publicKey,block.blockhash,[instruction],[key]);
      pending={action,wire:Buffer.from(tx.serialize()).toString("base64"),signature:encodeSignature(tx.signatures[0]),block};
      store.control=pending;await save();
    }
    const receipt=(await executionConnection.getSignatureStatuses([pending.signature],{searchTransactionHistory:true})).value[0];
    if(receipt?.err){delete store.control;await save();throw Error("pool_control_failed_refresh_status");}
    if(receipt?.confirmationStatus==="confirmed"||receipt?.confirmationStatus==="finalized"){delete store.control;await save();statuses.invalidate();delegation[index].invalidate();return {done:true,signature:pending.signature};}
    if(await executionConnection.getBlockHeight("finalized")>pending.block.lastValidBlockHeight){
      // Expired controls are idempotent; discard only after expiry is observed.
      delete store.control;await save();statuses.invalidate();throw Error("pool_control_expired_refresh_status");
    }
    const signature=await executionConnection.sendRawTransaction(VersionedTransaction.deserialize(Buffer.from(pending.wire,"base64")).serialize(),{skipPreflight:false,maxRetries:3});
    if(signature!==pending.signature)throw Error("pool_control_receipt_mismatch");
    statuses.invalidate();
    return {done:true,signature,description:"Control submitted. Refresh to verify confirmation before the next action."};
  }
  return {
    game,
    attempts:()=>session.poolLanes.flatMap(lane=>lane.attempts),
    async status(){
      const states=await statuses.get();
      return {...game.status(),enabled:!!session.poolEnabled,ready:states.some(lane=>lane.ready),
        remaining:states.reduce((n,lane)=>n+(lane.phase==="delegated"?lane.remaining:0),0),
        dailyLimit:states.reduce((n,lane)=>n+(lane.dailyLimit??0),0),
        lifetimeRemaining:states.reduce((n,lane)=>n+Math.max(0,(lane.totalLimit??0)-(lane.usedTotal??0)),0),
        lanes:states};
    },
    async plan(body,action="setup"){
      if(!body||Object.keys(body).join()!=="lane"||!Number.isInteger(body.lane)||body.lane<0||body.lane>=POOL_SIZE)throw Error("invalid_pool_lane");
      if(!manifest.verifiedArtifact.capabilities?.includes("bounded-er-pool-v1")||!await deployed())throw Error("pool_program_upgrade_required");
      const index=body.lane,state=(await statuses.get())[index],delegate=keys[index].publicKey;
      if(action==="pause"||action==="return")return fixedAction(index,action);
      if(state.phase==="unavailable")throw Error("pool_lane_verification_failed");
      if(state.phase==="delegated")return {done:true,description:"Pool session is already delegated. Its contract renews grants automatically within the approved policy."};
      if(state.phase==="delegate")return {instructions:[delegateErPoolSession(manifest,delegate)],kind:"er-pool-delegate",
        description:`Delegate ${state.id} to the pinned devnet validator. It has an owner-approved daily and lifetime request limit.`};
      const policy={...POOL_POLICY,authorizedUntil:Math.floor(Date.now()/1000)+POOL_POLICY.lifetimeSeconds-POOL_POLICY_CLOCK_MARGIN,
        totalLimit:Math.min(70000,(state.usedTotal??0)+POOL_POLICY.totalLimit)};
      const funding=Math.max(0,ER_FUNDING-Math.round(state.balanceSol*1e9)),instructions=[];
      if(funding)instructions.push(SystemProgram.transfer({fromPubkey:new PublicKey(manifest.adminAuthority),toPubkey:delegate,lamports:funding}));
      instructions.push(initializeErPoolSession(manifest,delegate,policy,state.phase==="update"));
      return {instructions,kind:"er-pool-policy",
        description:`Authorize ${state.id}: grants of 500, at most 1,000 requests per UTC day and ${policy.totalLimit-(state.usedTotal??0)} additional requests total, expiring just under 7 days (60-second clock margin). Fund only this isolated signer up to 0.005 devnet SOL. No automatic SOL top-up or treasury access. A second approval delegates it.`};
    },
    invalidate(){statuses.invalidate();delegation.forEach(cache=>cache.invalidate());},
    async notify(hint){
      await Promise.allSettled(session.poolLanes.flatMap(lane=>lane.attempts.filter(attempt=>attempt.requestSignature&&!attempt.callbackSignature)).map(async locked=>{
        const key=hintKey(locked),prior=hints.get(key)??[];
        if(!prior.some(item=>item.signature===hint.signature))hints.set(key,[...prior,hint].slice(-3));
        await refresh(locked);if(!locked.callbackSignature)await refresh(locked);if(locked.callbackSignature)hints.delete(key);
      }));
      statuses.invalidate();
    },
  };
}
