import { exactRequest } from "./claw-pg-ledger.mjs";

/** Only this service passes chain-verified receipts into the authoritative ledger. */
export function createClawPayments({ledger,chain}) {
  const jobs=new Map();
  const single=(kind,id,work)=>{
    const key=kind+":"+id;if(jobs.has(key))return jobs.get(key);
    const promise=work().finally(()=>jobs.delete(key));jobs.set(key,promise);return promise;
  };
  const publicRow=row=>({id:row.id,status:row.status,cents:Number(row.cents),signature:row.receipt?.signature??row.wire?.signature??null,
    ...(row.tier!==undefined?{tier:row.tier,quantity:row.quantity}:{scope:row.scope}),receipt:row.receipt?.receipt??null});
  async function receipt(kind,row){const proof=await chain.receipt(kind,row);if(!proof)return null;
    if(kind==="purchase")await ledger.acceptPurchase(row.wallet,row.id,proof);else await ledger.completeWithdrawal(row.wallet,row.id,proof);
    return proof;}
  async function progress(kind,wallet,id) {
    return single(kind,id,async()=>{
      let row=await ledger[kind](wallet,id);
      if(["credited","paid","failed"].includes(row.status))return publicRow(row);
      if(await receipt(kind,row))return publicRow(await ledger[kind](wallet,id));
      if(!row.wire&&kind==="purchase")return publicRow(row);
      const state=row.wire?await chain.inspect(row.wire):null;
      if(kind==="purchase"&&row.status==="submitted"&&row.wire?.signed&&(state?.expired||state?.failed)){
        // The finalized receipt stays the only credit path. Read it again now that expiry (or a finalized
        // failure) has been observed: any block that could hold this wire is finalized by now, so no receipt
        // means it never landed. Then leave the pending set as purchase-plan's rebuild does, keeping the
        // dead wire for audit. A receipt that still appears later credits the same row exactly once.
        if(await receipt(kind,row))return publicRow(await ledger[kind](wallet,id));
        return publicRow(await ledger.releasePurchase(wallet,id,row.wire.signature));
      }
      if(state?.failed&&kind==="withdrawal"){
        await ledger.failWithdrawal(wallet,id,state);return publicRow(await ledger.withdrawal(wallet,id));
      }
      if(kind==="withdrawal"&&(!row.wire||state?.expired)){
        row=await ledger.savePaymentWire(kind,wallet,id,await chain.build(kind,row),!!row.wire);
      }
      if(row.wire?.signed&&!state?.confirmed&&!state?.failed&&!state?.expired)await chain.send(row.wire);
      else if(row.wire?.signed&&kind==="withdrawal"&&state?.expired)await chain.send(row.wire);
      return publicRow(row);
    });
  }
  return {
    status:()=>chain.status(),
    async purchasePlan(wallet,body){const row=await ledger.quotePurchase(wallet,body);
      return single("purchase",row.id,async()=>{
        let current=await ledger.purchase(wallet,row.id);
        if(current.status==="credited"||await receipt("purchase",current))return {...publicRow(await ledger.purchase(wallet,row.id)),state:await ledger.state(wallet)};
        const status=current.wire?await chain.inspect(current.wire):null;
        if(current.wire?.signed&&!status?.expired&&!status?.failed)return {...publicRow(current),pending:true};
        if(!current.wire||status?.expired||status?.failed)current=await ledger.savePaymentWire("purchase",wallet,row.id,await chain.build("purchase",current),!!current.wire);
        return {...publicRow(current),transaction:current.wire.bytes,lastValidBlockHeight:current.wire.block.lastValidBlockHeight};
      });
    },
    async purchaseSubmit(wallet,body){exactRequest(body,["id","signedTransaction"]);
      await single("purchase",body.id,async()=>{let row=await ledger.purchase(wallet,body.id);
        if(row.status==="credited"||await receipt("purchase",row))return;
        if(!row.wire)throw Error("purchase_plan_required");
        const wire=chain.verifyPurchase(body.signedTransaction,row.wire,wallet),status=await chain.inspect(row.wire);
        if(status.expired||status.failed)throw Error("purchase_expired_refresh_plan");
        row=await ledger.savePaymentWire("purchase",wallet,body.id,wire);
        // The complete signed bytes are durable before first broadcast.
        await chain.send(row.wire);
      });return {payment:await progress("purchase",wallet,body.id),state:await ledger.state(wallet)};
    },
    async purchaseStatus(wallet,id){return {payment:await progress("purchase",wallet,id),state:await ledger.state(wallet)};},
    async withdraw(wallet,token,body){const row=await ledger.reserveWithdrawal(wallet,token,body);return {payment:await progress("withdrawal",wallet,row.id),state:await ledger.state(wallet)};},
    async withdrawalStatus(wallet,id){return {payment:await progress("withdrawal",wallet,id),state:await ledger.state(wallet)};},
    async tick(){const pending=await ledger.pendingPayments();await Promise.allSettled([
      ...pending.purchases.map(row=>progress("purchase",row.wallet,row.id)),...pending.withdrawals.map(row=>progress("withdrawal",row.wallet,row.id))]);},
  };
}
