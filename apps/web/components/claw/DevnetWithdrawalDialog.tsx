"use client";
import {useEffect,useRef,useState} from "react";
import {HiOutlineXMark} from "react-icons/hi2";
import UsdcAmount from "./UsdcAmount";
import styles from "./player.module.css";
import shell from "./arcadeShell.module.css";

export default function DevnetWithdrawalDialog({available,session,pending,onClose,onWithdraw}:{available:number;session:number;pending?:{id:string;cents:number}|null;onClose:()=>void;
  onWithdraw:(scope:"session"|"all")=>Promise<{cents:number;signature:string|null}>}){
  const ref=useRef<HTMLDialogElement>(null),locked=useRef(false);
  const [scope,setScope]=useState<"session"|"all">("all"),[busy,setBusy]=useState(false),[error,setError]=useState(""),[complete,setComplete]=useState<{cents:number;signature:string|null}|null>(null);
  useEffect(()=>{const node=ref.current;node?.showModal();return()=>node?.close();},[]);
  const amount=pending?.cents??(scope==="session"?session:available);
  return <dialog ref={ref} className={`${styles.tokenShop} ${shell.dialog}`} aria-labelledby="devnet-withdraw-title" onCancel={onClose}>
    <div className={styles.shopHeading}><h2 id="devnet-withdraw-title">Withdraw devnet USDC</h2><button className={styles.shopClose} aria-label="Close withdrawal" onClick={onClose}><HiOutlineXMark /></button></div>
    <p className={styles.dialogIntro}>Test USDC only · Sent to your connected wallet</p>
    {complete?<div role="status" className={styles.withdrawSuccess}><strong>Devnet USDC sent</strong><UsdcAmount value={(complete.cents/100).toFixed(2)} />{complete.signature&&<a href={`https://explorer.solana.com/tx/${encodeURIComponent(complete.signature)}?cluster=devnet`} target="_blank" rel="noreferrer">View transaction</a>}<button className={`${styles.drop} ${shell.play}`} onClick={onClose}>DONE</button></div>
      :<form onSubmit={async event=>{event.preventDefault();if(locked.current||amount<=0)return;locked.current=true;setBusy(true);setError("");try{setComplete(await onWithdraw(scope));}catch(value){setError(value instanceof Error?value.message.replaceAll("_"," "):"Withdrawal is pending. Resume it to check status.");}finally{locked.current=false;setBusy(false);}}}>
        {!pending&&<fieldset className={styles.withdrawOptions}><legend>Choose winnings</legend>{([{value:"session",label:"This session",cents:session},{value:"all",label:"All available",cents:available}]as const).map(option=><label key={option.value} data-selected={scope===option.value} data-disabled={!option.cents}><input type="radio" name="devnet-withdraw-scope" checked={scope===option.value} disabled={busy||!option.cents} onChange={()=>setScope(option.value)} /><span>{option.label}</span><strong><UsdcAmount value={(option.cents/100).toFixed(2)} /></strong></label>)}</fieldset>}
        <div className={styles.shopTotal}><span>{pending?"Reserved withdrawal":"Withdrawal amount"}</span><strong><UsdcAmount value={(amount/100).toFixed(2)} /></strong></div>
        <p className={styles.networkFeeNote}>Network fees covered by CATO</p>
        <button className={`${styles.drop} ${shell.play}`} type="submit" disabled={busy||amount<=0}>{busy?"CONFIRMING ON SOLANA…":pending?"RESUME WITHDRAWAL":"WITHDRAW TEST USDC"}</button>
        {error&&<p role="alert">{error}</p>}
      </form>}
  </dialog>;
}
