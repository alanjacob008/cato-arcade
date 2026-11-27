// Only the single, fenced signer coordinator runs this worker. Its queue lives in the same durable encrypted session.
export function createSponsorshipWorker({chain,store,save,now=Date.now,onAlert=()=>{}}){
  store.pending??=null;store.receipts??=[];let active=null,lastStatus={enabled:true,ready:false},lastAlert="";
  const alert=code=>{if(code!==lastAlert){lastAlert=code;onAlert(code);}return code;};
  async function tick(){
    const state=await chain.snapshot(),seconds=Math.floor(now()/1000),day=Math.floor(seconds/86400);
    lastStatus={enabled:true,ready:true,vault:state.vault,keeper:state.keeper,balanceLamports:state.balance,feeBalanceLamports:state.feeBalance,
      spentToday:state.spentToday,spentTotal:state.spentTotal,policy:state.policy,pending:store.pending?{index:store.pending.index,signature:store.pending.signature}:null,alert:null};
    if(store.pending){
      const wire=store.pending;
      // The contract's per-recipient nonce prevents a second transfer even after an ambiguous response or crash.
      if(state.nonces[wire.index]>wire.nonce){store.receipts=[{index:wire.index,nonce:wire.nonce,signature:wire.signature,at:now()},...store.receipts].slice(0,100);store.pending=null;await save();return;}
      const status=await chain.inspect(wire);
      if(status.finalized)throw Error("sponsorship_finalized_nonce_mismatch");
      if(status.failed||status.expired){store.pending=null;await save();lastStatus.alert=alert(status.failed?"sponsorship_transaction_failed":"sponsorship_transaction_expired");return;}
      if(state.feeBalance<100000){lastStatus.alert=alert("sponsorship_fee_wallet_low");return;}
      await save();await chain.send(wire);return;
    }
    if(state.paused||seconds>=state.policy.authorizedUntil){lastStatus.alert=alert("sponsorship_policy_paused_or_expired");return;}
    if(day<state.day)throw Error("sponsorship_clock_mismatch");
    if(state.feeBalance<100000){lastStatus.alert=alert("sponsorship_fee_wallet_low");return;}
    const used=day>state.day?0:state.spentToday;
    const index=state.balances.findIndex((balance,i)=>balance<state.policy.lowLamports&&(!state.lastTopups[i]||seconds-state.lastTopups[i]>=state.policy.cooldownSeconds));
    if(index<0){lastAlert="";return;}
    const amount=state.policy.targetLamports-state.balances[index];
    if(amount>state.available){lastStatus.alert=alert("sponsorship_vault_low");return;}
    if(used+amount>state.policy.dailyLimit||state.spentTotal+amount>state.policy.totalLimit){lastStatus.alert=alert("sponsorship_budget_exhausted");return;}
    const wire=await chain.build(index,state.nonces[index]);store.pending=wire;
    await save(); // Never broadcast unless the exact signed bytes have survived the fenced durable write.
    await chain.send(wire);lastAlert="";
  }
  return {tick(){active??=tick().catch(error=>{lastStatus.alert=alert(/^[a-z_]+$/.test(error.message)?error.message:"sponsorship_pending_retry");throw error;}).finally(()=>{active=null;});return active;},
    status:()=>({...lastStatus,pending:store.pending?{index:store.pending.index,signature:store.pending.signature}:null,receipts:store.receipts.map(row=>({...row}))})};
}
