"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import Image from "next/image";
import dynamic from "next/dynamic";
import { HiOutlineViewfinderCircle, HiOutlineWallet, HiOutlineClock, HiOutlineQuestionMarkCircle, HiOutlineTicket, HiOutlineXMark } from "react-icons/hi2";
import { countdown, type DailyArrangement } from "./daily";
import type { PullResult } from "./rewards";
import styles from "./player.module.css";
import TokenPreview from "./TokenPreview";
import UsdcAmount from "./UsdcAmount";
import ArcadeLoading from "./ArcadeLoading";
import { TOKEN_TYPES, tokenTier, type TokenTier, type WithdrawalScope } from "./tokens";
import { OutcomeToast, ResultEffects } from "./ArcadeOutcome";
import type { ClubProgress, ClubTheme } from "./clubCosmetics";
import PlayReceipts, { type PlayReceipt } from "./PlayReceipts";
import type { VrfExecution } from "./vrfExplorer";
import { createAimGesture } from "./aimGesture";
import BackgroundMusic from "./BackgroundMusic";
import shell from "./arcadeShell.module.css";
import tickets from "./receiptTickets.module.css";
import hud from "./hud.module.css";
import FairDraw, { type DrawProgress } from "./FairDraw";

const TokenShop = dynamic(() => import("./TokenShop"));
const WithdrawalDialog = dynamic(() => import("./WithdrawalDialog"));
const ArcadeTutorial = dynamic(() => import("./ArcadeTutorial"));

const amount = (cents: number) => (cents / 100).toFixed(2);
const prizeAmount = (cents: number) => cents % 100 ? amount(cents) : String(cents / 100);
const WINNINGS_NOTE = "These winnings are exclusive of price paid for the tokens";
type Props = {
  host: RefObject<HTMLDivElement | null>;
  daily: DailyArrangement; now: number; tier: number;
  loading?: { percent: number; label: string }; entering?: boolean;
  ready: boolean; busy: boolean; renderError: boolean; topView: boolean; empty: boolean; persistent: boolean;
  phase: string; result: PullResult | null; history: readonly PullResult[]; sessionWinningsCents: number; totalWinningsCents: number;
  availableWinningsCents: number; sessionWithdrawableCents: number; onWithdraw: (scope: WithdrawalScope) => number;
  tokenBalances: readonly [number, number, number];
  theme: ClubTheme; progress: ClubProgress; receipts: readonly PlayReceipt[];
  soundMuted: boolean; onSound: () => void; onActivateAudio?: () => void;
  onBuyTokens: (tier: TokenTier, quantity: number) => void | Promise<void>;
  onTier: (tier: number) => void; onDragAim: (screenX: number, screenY: number) => void;
  onView: () => void; onDrop: () => void;
  testSession?: { wallet: string; connecting: boolean; onConnect: () => void; pending: boolean; onResume: () => void;
    active: boolean; remaining: number | null; checking: boolean; error: string; onRefresh: () => void; unavailable?: boolean;
    paymentsEnabled?: boolean; pendingWithdrawal?: boolean; onWithdraw?: () => void; execution?: VrfExecution; draw?: DrawProgress | null };
};

function WinningsLabel({ id, children }: { id: string; children: ReactNode }) {
  return <span className={styles.winningsHint}><button type="button" className={styles.winningsLabel} aria-describedby={id}>{children}</button><span id={id} role="tooltip" className={styles.winningsTooltip}>{WINNINGS_NOTE}</span></span>;
}

function AnimatedAmount({ cents }: { cents: number }) {
  const [shown, setShown] = useState(cents), previous = useRef(cents);
  useEffect(() => {
    const from = previous.current, start = performance.now(), reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    // A frame's timestamp can precede `start`; clamping keeps the first frame from showing a negative amount.
    const tick = (now: number) => { const p = reduced ? 1 : Math.min(1, Math.max(0, (now - start) / 650)); setShown(Math.round(from + (cents - from) * (1 - (1 - p) ** 3))); if (p < 1) frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); previous.current = cents;
    return () => cancelAnimationFrame(frame);
  }, [cents]);
  return <span data-sign={Math.sign(shown)}>{amount(shown)}</span>;
}

/** Before the flight starts (pending or holding the opening shot), the tutorial waits at most this long. */
const INTRO_WAIT_MS = 4000;
/** Once the flight is seen: its length (INTRO_DURATION_MS, 2.5 s, in introCamera.ts) plus slack. It never fires mid-flight. */
const FLIGHT_WAIT_MS = 2500 + 1500;
/** Whatever the scene reports, the tutorial opens by then. */
const INTRO_SAFETY_MS = 15000;

/**
 * The scene's opening flight (canvas `data-intro`: holding, flying, then done or skipped) is the arcade's first
 * impression, so the first-visit tutorial waits for it to land. A cap covers a scene that never reports: 4 s
 * before the flight starts, then the flight's length plus slack once it is seen, and never while the canvas
 * says it is flying (a stall pauses the flight, it does not end it). An absolute limit still opens the tutorial
 * if the flight never lands. Under reduced motion there is no flight and the tutorial opens at once.
 */
function useIntroLanded(host: RefObject<HTMLDivElement | null>, ready: boolean) {
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    const stage = host.current;
    if (!ready || landed || !stage) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { const now = window.setTimeout(() => setLanded(true), 0); return () => window.clearTimeout(now); }
    const land = () => setLanded(true);
    const intro = () => stage.querySelector("canvas")?.dataset.intro ?? "";
    let cap = 0, flightSeen = false;
    const arm = (ms: number) => { window.clearTimeout(cap); cap = window.setTimeout(() => { if (!/^(holding|flying)$/.test(intro())) land(); }, ms); };
    const check = () => {
      const state = intro();
      if (/^(done|skipped)$/.test(state)) land();
      else if (state === "flying" && !flightSeen) { flightSeen = true; arm(FLIGHT_WAIT_MS); }
    };
    const observer = new MutationObserver(check);
    observer.observe(stage, { subtree: true, childList: true, attributeFilter: ["data-intro"] });
    const first = window.setTimeout(check, 0), safety = window.setTimeout(land, INTRO_SAFETY_MS);
    arm(INTRO_WAIT_MS);
    return () => { observer.disconnect(); window.clearTimeout(first); window.clearTimeout(cap); window.clearTimeout(safety); };
  }, [host, ready, landed]);
  return landed;
}

/** Chrome accents per tier: Silver and Gold keep their metal; Diamond is ice with a teal glow. */
const TIER_EDGE = TOKEN_TYPES.map(type => type.color), TIER_GLOW = TOKEN_TYPES.map((type, tier) => tier === 2 ? "#4FE3C1" : type.color);

function ClubDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement; ref.current?.showModal(); const modal = ref.current;
    return () => { modal?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  return <dialog ref={ref} className={`${styles.clubDialog} ${shell.dialog}`} aria-label={title} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={styles.dialogHeading}><h2>{title}</h2><button aria-label={`Close ${title}`} onClick={onClose}><HiOutlineXMark aria-hidden="true" /></button></div>{children}
  </dialog>;
}

export default function PlayerArcade({ host, daily, now, tier, ready, busy, renderError, topView, empty, persistent, loading, entering = false,
  phase, result, history, sessionWinningsCents, totalWinningsCents, availableWinningsCents, sessionWithdrawableCents, onWithdraw, tokenBalances, theme, progress, receipts, soundMuted, onSound, onActivateAudio, onBuyTokens, onTier, onDragAim, onView, onDrop, testSession }: Props) {
  const connectNeeded = !!testSession && !testSession.wallet;
  const fundedDevnet=!!testSession?.paymentsEnabled,freeTest=!!testSession&&!fundedDevnet;
  const unavailable = entering || !ready || busy || connectNeeded || !!testSession?.pending || !!testSession?.unavailable, selected = TOKEN_TYPES[tier];
  const playDisabled = entering || !!testSession?.connecting || (testSession ? busy || (connectNeeded ? testSession.connecting || !!testSession.unavailable : testSession.unavailable ? testSession.checking : !ready || (!testSession.pending && (!testSession.active || empty))) : unavailable || empty);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [shopOpen, setShopOpen] = useState(false), [dialog, setDialog] = useState<"receipts" | "club" | "help" | null>(null);
  const gesture = useRef(createAimGesture());
  // Result moments only follow the delivered, verified outcome, never a play still in motion.
  const settled = result && !busy ? result : null, celebrating = !!settled?.success;
  const introLanded = useIntroLanded(host, ready && !entering);
  useEffect(() => {
    const htmlOverflow = document.documentElement.style.overflow, bodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = document.body.style.overflow = "hidden";
    return () => { document.documentElement.style.overflow = htmlOverflow; document.body.style.overflow = bodyOverflow; };
  }, []);

  return <main className={`${styles.arcade} ${shell.arcade}`} data-theme={theme} data-claw-audio="true">
    <header className={`${styles.header} ${shell.header}`}>
      <a href="/" className={`${styles.brand} ${shell.brand}`} aria-label="CATO Arcade home"><Image src="/claw/cato-mascot-transparent.png" width={34} height={34} alt="" /><span>CATO<small>ARCADE</small></span></a>
      <div className={`${styles.headerRight} ${shell.headerControls}`}><span className={styles.localBadge}>{testSession ? "DEVNET" : "LOCAL PREVIEW"}</span>
        <button className={styles.wallet} disabled={!ready || entering || !testSession || !!testSession.wallet || testSession.connecting || busy} title={testSession?.wallet || (testSession ? "Connect the devnet test wallet" : "Wallet connection is coming soon")} onClick={testSession?.onConnect}><HiOutlineWallet />{testSession?.wallet ? <span className={hud.address}>{`${testSession.wallet.slice(0, 5)}…${testSession.wallet.slice(-4)}`}</span> : testSession?.connecting ? "Connecting…" : "Connect wallet"}</button><button className={styles.avatar} aria-label="Open club pass" onClick={() => setDialog("club")}>C</button></div>
    </header>
    <div className={styles.content}>
      {testSession && <div className={`${styles.testNotice} ${shell.notice}`}><span>{fundedDevnet?"DEVNET USDC · Test currency only. No mainnet funds.":"DEVNET PREVIEW · Free test tokens. Payments and withdrawals are disabled."}</span><strong>{testSession.unavailable ? "Connection interrupted" : testSession.remaining === null ? "Checking sponsored plays…" : `${testSession.remaining} sponsored ${testSession.remaining === 1 ? "play" : "plays"} left`}</strong></div>}
      <section className={`${styles.reset} ${shell.reset}`} aria-label="Daily machine reset"><p><HiOutlineClock aria-hidden="true" />All claw machines get reset at 23:59 UTC.</p><div>Your next reset is in: <strong>{countdown(daily.resetsAt, now)}</strong></div></section>
      <div className={`${styles.layout} ${shell.layout}`}>
        <section className={styles.machine} aria-label="Claw machine">
          <div className={`${styles.stage} ${shell.stage}`}>
            <div className={`${styles.stageTop} ${shell.switches}`}><button className={styles.viewButton} disabled={entering || !ready || busy || !!testSession?.pending} onClick={onView}><span className={hud.viewLabel}>{topView ? "Front view" : "Top view"}</span><HiOutlineViewfinderCircle aria-hidden="true" /></button><button className={styles.helpButton} aria-label="How to play" onClick={() => setDialog("help")}><HiOutlineQuestionMarkCircle /></button></div>
            <div className={`${styles.outcome} ${hud.outcomeDock}`} role="status" aria-live="polite" aria-atomic="true">{result && !busy ? <OutcomeToast key={result.pullId} success={result.success} cents={result.cents} noTarget={result.targetId === null} /> : phase === "error" ? <OutcomeToast key="error" success={false} error /> : null}</div>
            {result && !busy && <ResultEffects key={result.pullId} success={result.success} cents={result.cents} />}
            <div ref={host} className={styles.canvas} tabIndex={0} role="group" aria-label="Aim the claw" aria-describedby="claw-aim-help" aria-disabled={unavailable}
              onPointerDown={event => { if (!gesture.current.start(event, !unavailable)) return; onActivateAudio?.(); event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus({ preventScroll: true }); }}
              onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(); const delta = gesture.current.move(event, !unavailable, rect.width, rect.height); if (delta) onDragAim(delta.x, delta.y); }}
              onPointerUp={event => gesture.current.end(event.pointerId)} onPointerCancel={event => gesture.current.end(event.pointerId)} onLostPointerCapture={event => gesture.current.end(event.pointerId)} />
            {!ready && !renderError && <div className={styles.loading}><ArcadeLoading compact progress={loading?.percent} label={loading?.label} draw={testSession ? "vrf" : "local"} /></div>}
            {renderError && <div className={styles.loading} role="alert">Your browser couldn’t load the machine. Try a browser with WebGL enabled.</div>}
            {empty && !busy && <span className={styles.playing}>All boxes collected. A fresh machine is on its way.</span>}
            <div className={styles.stageBottom}><span id="claw-aim-help"><span className={styles.mouseHint}>Drag to aim</span><span className={styles.touchHint}>Swipe on the machine to aim</span><span className={styles.keyboardHint}> · WASD / arrows · Space to play</span></span></div>
            <BackgroundMusic effectsMuted={soundMuted} onToggleEffects={onSound} />
          </div>
        </section>
        <aside className={`${styles.console} ${shell.console}`} aria-label="Play options">
          <div className={`${styles.tokenHeading} ${shell.tokenHeading}`}><h2>YOUR TOKENS</h2><button className={styles.buyTokens} disabled={unavailable} onClick={() => setShopOpen(true)}>{freeTest ? "GET TEST TOKENS" : "BUY TOKENS"}</button></div>
          <div className={`${styles.prices} ${styles.tokenOptions} ${styles.selectionTrack} ${shell.tokens}`} aria-label="Token type" data-disabled={entering || !ready || busy || !!testSession?.pending} style={{ "--selection": tier, "--token-accent": selected.color } as CSSProperties}><div className={styles.selection} aria-hidden="true" />
            {TOKEN_TYPES.map((type, option) => <button key={type.name} data-arcade-sound={type.name.toLowerCase()} style={{ "--button-glow": TIER_GLOW[option], "--button-edge": TIER_EDGE[option] } as CSSProperties} aria-pressed={tier === option} aria-label={`${type.name} token, ${type.priceCents / 100} USDC, ${tokenBalances[option]} available`} disabled={entering || !ready || busy || !!testSession?.pending} onClick={() => onTier(option)}><span className={`${styles.chipWell} ${shell.chipWell}`}><TokenPreview tier={tokenTier(option)} /><span className={`${styles.tokenCount} ${shell.count}`}>×{tokenBalances[option]}</span></span><strong>{type.name}</strong><UsdcAmount value={type.priceCents / 100} /></button>)}</div>
          <button className={`${styles.drop} ${shell.play}`} data-arcade-sound={connectNeeded || !testSession?.unavailable && !testSession?.pending && tokenBalances[tier] > 0 ? "button" : undefined} disabled={playDisabled} aria-busy={busy} onClick={() => { if (testSession?.unavailable) testSession.onRefresh(); else if (connectNeeded) testSession!.onConnect(); else if (testSession?.pending) testSession.onResume(); else if (tokenBalances[tier]) onDrop(); else setShopOpen(true); }}>{busy ? "IN PLAY" : connectNeeded ? testSession?.connecting ? "CONNECTING…" : "CONNECT WALLET" : testSession?.unavailable ? testSession.checking ? "RECONNECTING…" : "RETRY CONNECTION" : testSession?.pending ? "RESUME ATTEMPT" : testSession && !testSession.active ? "SPONSORED PLAYS UNAVAILABLE" : tokenBalances[tier] ? "INSERT & DROP" : freeTest ? "GET TEST TOKENS" : "BUY TOKENS"}</button>
          <FairDraw mode={testSession ? "vrf" : "local"} busy={busy} result={result} receipts={receipts} execution={testSession?.execution} draw={testSession?.draw} />
          {testSession && <div className={`${styles.testStatus} ${shell.status}`}><span role="status" aria-live="polite">{busy ? "Playing…" : testSession.pending ? "Your test token is reserved. Resume this attempt." : testSession.unavailable ? "Connection interrupted. Retry to reconnect; your tokens are saved." : !testSession.wallet ? "Connect your wallet, then sign the login message to play." : testSession.active ? "Network fees covered by CATO" : "Ask the test host to renew sponsored plays."}</span>{testSession.error && <p role="alert">{testSession.error.replaceAll("_", " ")}</p>}{!busy && !testSession.pending && <button className={styles.textButton} disabled={testSession.checking} onClick={testSession.onRefresh}>{testSession.checking ? "Checking…" : "Refresh availability"}</button>}</div>}
          <section className={`${styles.winnings} ${shell.score}`} aria-label="Prize winnings">
            <div className={`${styles.winningsTitle} ${shell.scoreLabel}`}><WinningsLabel id="session-winnings-note">{testSession ? "SESSION TEST WINNINGS" : "SESSION WINNINGS"}</WinningsLabel></div>
            <div className={`${styles.sessionAmount} ${shell.scoreAmount}${celebrating ? ` ${hud.scoreFlash}` : ""}`} data-sign={Math.sign(sessionWinningsCents)}><UsdcAmount value={<AnimatedAmount cents={sessionWinningsCents} />} /></div>
            <dl className={styles.netWinnings}><div><dt><WinningsLabel id="cumulative-winnings-note">{testSession ? "Cumulative test winnings" : "Cumulative Winnings"}</WinningsLabel></dt><dd data-sign={Math.sign(totalWinningsCents)}><UsdcAmount value={amount(totalWinningsCents)} /></dd></div></dl>
            <div className={`${styles.withdrawRow} ${shell.cashout}`}><span>{freeTest ? "Test balance only" : "Available to withdraw"}<strong><UsdcAmount value={amount(freeTest ? totalWinningsCents : availableWinningsCents)} /></strong></span>
              <button disabled={freeTest || unavailable || availableWinningsCents <= 0&&!testSession?.pendingWithdrawal} title={freeTest ? "Withdrawals are disabled in this devnet preview" : undefined}
                onClick={() => {if(fundedDevnet)testSession?.onWithdraw?.();else setWithdrawOpen(true);}}>{testSession?.pendingWithdrawal?"CHECK WITHDRAWAL":"WITHDRAW"}</button>
            </div>
          </section>
          <section className={`${styles.activityCard} ${shell.activity}`} aria-label="Recent plays" data-has-plays={history.length > 0}><div className={styles.activityHeading}><h2>Recent plays</h2><button className={styles.textButton} onClick={() => setDialog("receipts")} aria-label="Open play receipts"><HiOutlineTicket /></button></div><div className={`${styles.recent} ${tickets.miniStrip}`} aria-label="Recent play results">{history.length ? history.slice(0, 5).map((entry, index) => <span className={`${tickets.miniTicket}${index === 0 && settled?.pullId === entry.pullId ? ` ${hud.fresh}` : ""}`} key={entry.pullId} data-win={entry.success}>{entry.success ? <UsdcAmount value={`+${prizeAmount(entry.cents)}`} /> : "MISS"}</span>) : <p>NO PLAYS YET</p>}</div></section>
        </aside>
      </div>
      {!persistent && <p className={styles.storageNote}>Your progress is saved for this session only.</p>}
    </div>
    {withdrawOpen && !testSession && <WithdrawalDialog totalCents={totalWinningsCents} availableCents={availableWinningsCents} sessionCents={sessionWithdrawableCents} onWithdraw={onWithdraw} onClose={() => setWithdrawOpen(false)} />}
    {shopOpen && <TokenShop initialTier={tier} onClose={() => setShopOpen(false)} onBuy={onBuyTokens} testMode={freeTest} fundedDevnet={fundedDevnet} />}
    {dialog === "receipts" && <ClubDialog title={testSession ? "Your VRF receipts" : "Your play receipts"} onClose={() => setDialog(null)}><PlayReceipts receipts={receipts} devnet={!!testSession} execution={testSession?.execution} freeTest={freeTest} /></ClubDialog>}
    {dialog === "club" && <ClubDialog title="Your club pass" onClose={() => setDialog(null)}><div className={`${styles.passCard} ${shell.pass}`}><Image src="/claw/cato-brand-logo.png" width={56} height={56} alt="CATO cat" /><div><span>CATO CASINO CLUB</span><strong>Guest player</strong><small>{progress.plays} plays · {progress.catches} catches · {progress.rareCatches} rare catches</small></div></div></ClubDialog>}
    {ready && !entering && <ArcadeTutorial ready={ready} introPending={!introLanded} requested={dialog === "help"} onClose={() => setDialog(null)} testMode={freeTest} fundedDevnet={fundedDevnet} />}
    {entering && <div className={styles.entryLoading} aria-label="Loading your arcade"><ArcadeLoading progress={loading?.percent} label={testSession?.connecting ? "Connecting your wallet" : loading?.label} draw={testSession ? "vrf" : "local"} /></div>}
  </main>;
}
