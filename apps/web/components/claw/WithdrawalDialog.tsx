"use client";
import { useEffect, useRef, useState } from "react";
import { HiOutlineXMark } from "react-icons/hi2";
import UsdcAmount from "./UsdcAmount";
import type { WithdrawalScope } from "./tokens";
import styles from "./player.module.css";
import shell from "./arcadeShell.module.css";

export default function WithdrawalDialog({ totalCents, availableCents, sessionCents, onWithdraw, onClose }: {
  totalCents: number; availableCents: number; sessionCents: number; onWithdraw: (scope: WithdrawalScope) => number; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), submitted = useRef(false);
  const [scope, setScope] = useState<WithdrawalScope>("all"), [completed, setCompleted] = useState<number | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const modal = dialog.current, previous = document.activeElement;
    modal?.showModal();
    return () => { modal?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const amount = scope === "session" ? sessionCents : availableCents;
  return <dialog ref={dialog} className={`${styles.tokenShop} ${shell.dialog}`} aria-labelledby="withdraw-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={styles.shopHeading}><h2 id="withdraw-title">Withdraw winnings</h2><button type="button" className={styles.shopClose} aria-label="Close withdrawal" onClick={onClose}><HiOutlineXMark aria-hidden="true" /></button></div>
    <p className={styles.dialogIntro}>Demo withdrawal. No wallet transfer is sent.</p>
    {completed !== null ? <div role="status" className={styles.withdrawSuccess}><strong>Demo withdrawal recorded</strong><UsdcAmount value={(completed / 100).toFixed(2)} /><p>Available balance updated. Your winnings history stays unchanged.</p><button className={`${styles.drop} ${shell.play}`} onClick={onClose}>DONE</button></div> : <form onSubmit={event => {
      event.preventDefault(); if (submitted.current || amount <= 0) return;
      submitted.current = true;
      try { setCompleted(onWithdraw(scope)); }
      catch { submitted.current = false; setError("Unable to record withdrawal. Check your available balance and try again."); }
    }}>
      <dl className={styles.withdrawBalance}><div><dt>Cumulative winnings</dt><dd><UsdcAmount value={(totalCents / 100).toFixed(2)} /></dd></div><div><dt>Previously withdrawn</dt><dd><UsdcAmount value={((totalCents - availableCents) / 100).toFixed(2)} /></dd></div></dl>
      <fieldset className={styles.withdrawOptions}><legend>Choose winnings</legend>{([
        { value: "session", label: "This session", cents: sessionCents },
        { value: "all", label: "All available winnings", cents: availableCents },
      ] as const).map(option => <label key={option.value} data-selected={scope === option.value} data-disabled={option.cents <= 0}><input type="radio" name="withdraw-scope" value={option.value} disabled={option.cents <= 0} checked={scope === option.value} onChange={() => { setScope(option.value); setError(null); }} /><span>{option.label}</span><strong><UsdcAmount value={(option.cents / 100).toFixed(2)} /></strong></label>)}</fieldset>
      <p className={styles.dialogNote}>Available = cumulative winnings minus previous withdrawals. Session winnings are part of that balance. Token purchase costs are separate.</p>
      <div className={styles.shopTotal}><span>Withdrawal amount</span><strong><UsdcAmount value={(amount / 100).toFixed(2)} /></strong></div>
      <p className={styles.networkFeeNote}>No added network fee · Covered by CATO</p>
      <button type="submit" className={`${styles.drop} ${shell.play}`} disabled={amount <= 0}>RECORD DEMO WITHDRAWAL</button>
      {error && <p role="alert">{error}</p>}
    </form>}
  </dialog>;
}
