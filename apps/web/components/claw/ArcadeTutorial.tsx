"use client";

import { useEffect, useRef, useState } from "react";
import { HiOutlineXMark } from "react-icons/hi2";
import { hasSeenTutorial, rememberTutorial } from "./tutorial";
import styles from "./player.module.css";
import shell from "./arcadeShell.module.css";
import onboarding from "./onboarding.module.css";

function tutorialStorage(): Storage | null {
  try { return window.localStorage; }
  catch { return null; }
}

export default function ArcadeTutorial({ ready, requested, onClose, testMode = false, fundedDevnet = false, introPending = false }: { ready: boolean; requested: boolean; onClose: () => void; testMode?: boolean; fundedDevnet?: boolean; introPending?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null), dismissed = useRef(false);
  const tutorialMode = testMode || fundedDevnet ? "devnet" : "demo";
  // The automatic first-visit opening waits until the scene's intro flight has landed; "?" opens it at any time.
  const [firstVisit, setFirstVisit] = useState(false);
  useEffect(() => {
    if (!ready || introPending || dismissed.current || hasSeenTutorial(tutorialStorage(), tutorialMode)) return;
    setFirstVisit(true);
  }, [ready, introPending, tutorialMode]);
  const open = ready && (requested || firstVisit);
  useEffect(() => {
    if (!open) return;
    const modal = dialog.current, previous = document.activeElement;
    modal?.showModal();
    return () => {
      modal?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);

  function dismiss() {
    dismissed.current = true;
    rememberTutorial(tutorialStorage(), tutorialMode);
    setFirstVisit(false);
    dialog.current?.close();
    onClose();
  }

  // Escape (or any other close request) dismisses it the same way as the X: it is remembered as seen, and focus
  // returns to where it was (the "?" button when opened from there). Backdrop clicks still do not dismiss it.
  return <dialog ref={dialog} className={`${styles.clubDialog} ${onboarding.tutorial} ${shell.dialog}`} aria-labelledby="arcade-tutorial-title"
    onCancel={event => { event.preventDefault(); dismiss(); }}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); } }}>
    <div className={styles.dialogHeading}>
      <h2 id="arcade-tutorial-title">WELCOME TO CATO ARCADE</h2>
      <button type="button" aria-label="Close tutorial" onClick={dismiss}><HiOutlineXMark aria-hidden="true" /></button>
    </div>
    <section className={onboarding.tutorialSection} aria-labelledby="tutorial-play">
      <h3 id="tutorial-play">To play the Claw game:</h3>
      <ol>
        {tutorialMode === "devnet" && <li>Press <strong>Connect Wallet</strong>, choose your wallet, then sign the login message. Signing in does not make a payment.</li>}
        <li>{testMode ? <>Press <strong>Get Test Tokens</strong> for free Silver, Gold or Diamond tokens.</> : <>Buy <strong>Silver, Gold or Diamond</strong> tokens from the panel.</>} Higher tiers have a higher chance of picking up a box.</li>
        <li><strong>Drag on the machine</strong> to aim, or <strong>swipe with one finger</strong> on your phone. Use <strong>Top View</strong> to line up above a box.</li>
        <li>Press <strong>Insert &amp; Drop</strong> to play. Open the ticket icon beside <strong>Recent plays</strong>{tutorialMode === "devnet" ? " for your VRF request and callback links." : " for your play receipts."}</li>
      </ol>
    </section>
    <div className={shell.fairNote}>
      <p>{tutorialMode === "devnet"
        ? <><strong>MagicBlock VRF</strong> decides every grab. After each play, <strong>View proof</strong> opens that draw in Solana Explorer.</>
        : <>This demo draws each grab locally in your browser. In the devnet arcade, <strong>MagicBlock VRF</strong> decides every grab and each play links to its proof.</>}</p>
    </div>
    {!testMode && <section className={onboarding.tutorialSection} aria-labelledby="tutorial-withdraw">
      <h3 id="tutorial-withdraw">To withdraw:</h3>
      <ol>
        <li>Find the <strong>Withdraw</strong> button in the right-side panel, below <strong>Cumulative Winnings</strong>.</li>
        <li>Click <strong>Withdraw</strong>, then press <strong>{fundedDevnet?"Withdraw Test USDC":"Record Demo withdrawal"}</strong>.</li>
      </ol>
    </section>}
    <p className={styles.dialogNote}>{testMode ? "Real devnet randomness. Test tokens and winnings only. Payments and withdrawals are disabled." : fundedDevnet ? "Devnet USDC only. Purchases and withdrawals use test currency; no mainnet funds." : "Tokens and withdrawals are demo credits. No real funds are transferred."}</p>
    <button type="button" className={`${styles.drop} ${onboarding.tutorialDone} ${shell.play}`} onClick={dismiss}>GOT IT — LET’S PLAY</button>
  </dialog>;
}
