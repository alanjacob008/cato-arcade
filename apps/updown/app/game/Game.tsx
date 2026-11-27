import { useEffect, useRef, useState } from 'react';
import { useAccount, useAccountInfo, useCollateral, useMarkPriceBySymbol, useOrderbookStream, useWalletConnector, useWsStatus } from '@orderly.network/hooks';
import { modal, useScreen } from '@orderly.network/ui';
import { DepositAndWithdrawWithDialogId, DepositAndWithdrawWithSheetId } from '@orderly.network/ui-transfer';
import { AccountStatusEnum } from '@orderly.network/types';
import { ArrowDownLeft, ArrowDownRight, ArrowUpRight, Clock3, Wallet } from 'lucide-react';
import { activeRound, dollars, gameApi, Market, Round, sameAccount, useGameQuery } from './api';
import { GAME_SYMBOL } from './market.mjs';
import { ChartPhase, PnlChart } from './PnlChart';
import { pnlPoint, recordPnl, roundSeries } from './chart-series';
import { chartDemo } from './chart-demo';
import { RoundExtension } from './RoundExtension';
import { defaultRoundDuration, durationText, roundDurations } from './timing';
import { LivePnl } from './LivePnl';
import { finalResult, roundPnl } from './pnl';
import { useRoundResults } from './use-round-results';
import { BalanceBar } from './BalanceBar';
import { AmountInput } from './AmountInput';
import { amountQuote, isolatedAvailableBalance, maximumAmount } from './amounts';
import { getDeviceAuthorization } from './device-authorization';
import { getRuntimeConfig } from '@/utils/runtime-config';
import { catPose } from './cat-pose';
import { CatHome } from '../cat';
import { sfx, useGameSfx } from '@/audio';
import '@/styles/game.css';

/** A finished round keeps its frozen line on screen this long after closing, even if the page was reloaded meanwhile. */
const CLOSED_PHASE_MS = 10 * 60000;

export default function Game() {
  const { account, state, isSubAccount } = useAccount();
  const { connect } = useWalletConnector();
  const { isMobile } = useScreen();
  const { data: info } = useAccountInfo();
  const { freeCollateral, freeCollateralUSDCOnly, usdcHolding } = useCollateral({ dp: 6 });
  const { data: marketData, error: marketError } = useGameQuery<{ rows: Market[]; updatedAt: number }>('/markets', 5000);
  const { data: roundsData, error: roundError, refresh } = useGameQuery<{ rows: Round[] }>(state.accountId ? `/rounds?accountId=${state.accountId}` : null, 1500);
  const { data: health, error: healthError } = useGameQuery<{ ready: boolean; network: string; time: number; timeExtensions?: boolean }>('/health', 3000);
  const [amount, setAmount] = useState('5');
  const [duration, setDuration] = useState<number>(defaultRoundDuration);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  // The click that started the latest order: the chart shows "sending" from here until the round reports its fill.
  const [sending, setSending] = useState<{ since: number; id: string }>();
  const [, bumpSeries] = useState(0);
  const starting = useRef(false);
  const connectedAccount = useRef(state.accountId);
  connectedAccount.current = state.accountId;
  const pendingId = useRef<string>();
  const { rows: rounds } = useRoundResults(roundsData?.rows || []);
  const active = rounds.find(activeRound);
  const publicMarket = (marketData?.rows || []).find(m => m.symbol === GAME_SYMBOL);
  const market = publicMarket && { ...publicMarket, imr_factor: Math.max(publicMarket.imr_factor, Number(info?.imr_factor?.[GAME_SYMBOL]) || 0) };
  const [orderbook] = useOrderbookStream(GAME_SYMBOL, undefined, { level: 1, padding: false });
  const ask = Number(orderbook.asks?.[0]?.[0]);
  const bid = Number(orderbook.bids?.[0]?.[0]);
  const bookReady = Number.isFinite(ask) && ask > 0 && Number.isFinite(bid) && bid > 0;
  const streamedPrice = useMarkPriceBySymbol(GAME_SYMBOL);
  const streamConnected = useWsStatus() === 'connected';
  const price = Number((streamConnected ? streamedPrice : undefined) || active?.markPrice || market?.mark_price) || undefined;
  const margin = Number(amount);
  const ready = state.status === AccountStatusEnum.EnableTrading;
  const accountFee = info?.futures_taker_fee_rate;
  const feeRate = accountFee != null && Number.isFinite(Number(accountFee)) ? Number(accountFee) / 10000 : .0003;
  // Leverage is never chosen: every round opens at the market's maximum for its size (the service enforces it too).
  const amountContext = { market, price, freeCollateral: isolatedAvailableBalance(freeCollateral, freeCollateralUSDCOnly, usdcHolding), feeRate, leverageOverride: null,
    orderReferencePrice: bookReady ? Math.max(ask, bid) : undefined, accountMaxNotional: info?.max_notional?.[GAME_SYMBOL],
    accountReady: ready && Boolean(state.accountId) && !isSubAccount, pricingReady: Boolean(info) && streamConnected && bookReady };
  const quote = amountQuote(margin, amountContext);
  const { leverage } = quote;
  // Nothing playable in the account: the idle chart offers the deposit flow instead of two dead buttons.
  const noFunds = ready && quote.ready && maximumAmount(amountContext) <= 0;
  const remaining = active?.deadline ? Math.max(0, Math.ceil((active.deadline - now) / 1000)) : duration;
  const livePnl = active && streamConnected ? roundPnl(active, price, feeRate) : undefined;
  const locked = Boolean(active) || busy;
  const canStart = !locked && quote.affordable && health?.ready && !healthError && !marketError && !roundError;
  const last = rounds.find(r => !activeRound(r));
  const lastResult = last && finalResult(last);
  const record = winRecord(rounds);
  // Chart phase. A fill is only ever reported by the round itself: "open" needs a real entry price.
  const filled = Boolean(active && (active.status === 'open' || active.status === 'closing') && active.entryPrice);
  // Sound: ka-ching on the fill, payout / loss on the result (the big payout from half the stake up), ticks through the
  // last ten seconds (app/audio).
  useGameSfx({ activeId: active?.id, filled, last: last && { id: last.id, result: lastResult, stake: last.margin }, remaining: filled && active?.status === 'open' ? remaining : undefined });
  const sendingRound = active && !filled ? active : undefined;
  const sendingSince = sendingRound ? Math.min(sending?.since ?? Infinity, sendingRound.createdAt || Infinity) : sending?.since;
  // Opening progress from the service: the quotes' partial fills ("Filled 40%"); nothing until something filled.
  const fillProgress = sendingRound?.fill && sendingRound.fill.filledQuantity > 0 && sendingRound.fill.quantity > 0
    ? `Filled ${Math.min(99, Math.round(sendingRound.fill.filledQuantity / sendingRound.fill.quantity * 100))}%` : undefined;
  // While a quote Orderly cannot find yet is being cancelled (player cancel or window end), the service says so
  // (CONFIRMING_QUOTE_MESSAGE in server/engine.mjs); the sending block shows it rather than a silent wait.
  const confirmingQuote = sendingRound?.status === 'opening' && sendingRound.error?.startsWith('Confirming whether the quote reached Orderly') ? sendingRound.error : undefined;
  const chartRound = filled ? active : !active && last && last.status !== 'failed' ? last : undefined;
  const chartPoints = roundSeries(chartRound?.id);
  const closedPhase = Boolean(!active && !sending && chartRound && (chartPoints.length > 0 || (chartRound.closedAt != null && now - chartRound.closedAt < CLOSED_PHASE_MS)));
  const phase: ChartPhase = filled ? 'open' : sendingRound || (sending && !active) ? 'sending' : closedPhase ? 'closed' : 'idle';
  // Dev only: ?chartDemo=sending|winning|losing|closed shows the chart phases with a synthetic round (see chart-demo.ts).
  const demo = import.meta.env.DEV ? chartDemo(typeof location === 'undefined' ? '' : location.search, now) : undefined;
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(timer); }, []);
  useEffect(() => { pendingId.current = undefined; setError(''); setSending(undefined); }, [state.accountId]);
  // The sending phase ends when the round fills, or when the service reports a newer round that is no longer active.
  useEffect(() => {
    if (sending && (filled || (!active && rounds.some(r => r.createdAt >= sending.since || r.id === sending.id)))) setSending(undefined);
  }, [sending, filled, active, rounds]);
  // One sample per second of the unrealised net result, plus one on every price tick (same-second samples replace each other).
  const sample = useRef(() => {});
  sample.current = () => {
    if (!filled || !active || !streamConnected) return;
    const point = pnlPoint(active, price, feeRate, Date.now());
    if (point) { recordPnl(active.id, point); bumpSeries(n => n + 1); }
  };
  useEffect(() => { sample.current(); }, [price, active, feeRate, streamConnected, filled]);
  useEffect(() => { const timer = setInterval(() => sample.current(), 1000); return () => clearInterval(timer); }, []);
  async function start(direction: 'UP' | 'DOWN') {
    if (starting.current || !state.accountId || !canStart) return;
    starting.current = true;
    const accountId = state.accountId;
    setBusy(true); setError('');
    const id = pendingId.current ||= crypto.randomUUID().replaceAll('-', '');
    setSending({ since: Date.now(), id });
    sfx.play(direction === 'UP' ? 'call-up' : 'call-down');
    try {
      const key = await getDeviceAuthorization(account, getRuntimeConfig('VITE_ORDERLY_BROKER_ID') || 'demo', Date.now() + (duration + 120) * 1000);
      if (connectedAccount.current !== accountId) throw new Error('Your account changed during authorization. Choose a direction again.');
      const round = await gameApi<Round>('/rounds', { id, accountId: state.accountId, secretKey: key.secretKey, symbol: GAME_SYMBOL, direction, duration, margin, leverage, authorize: true });
      pendingId.current = undefined;
      if (round.status === 'failed') throw new Error(round.error || 'The round could not start.');
      refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to start the round.'); setSending(undefined); refresh(); }
    finally { starting.current = false; setBusy(false); }
  }
  async function extendTime(seconds: number, id: string) {
    if (!active || !state.accountId || !sameAccount(active.accountId, state.accountId) || isSubAccount || busy) throw new Error('Connect the account that opened this round.');
    setBusy(true);
    try {
      const requiredUntil = (active.deadline || Date.now()) + (seconds + 60) * 1000;
      const key = await getDeviceAuthorization(account, getRuntimeConfig('VITE_ORDERLY_BROKER_ID') || 'demo', requiredUntil);
      if (connectedAccount.current !== active.accountId) throw new Error('Connect the account that opened this round.');
      await gameApi(`/rounds/${active.id}/extend`, { id, seconds, accountId: state.accountId, secretKey: key.secretKey });
      refresh();
    } finally { setBusy(false); }
  }
  // True while the close request itself is in flight: the button reads "Closing…" until the round reports closing.
  const [closing, setClosing] = useState(false);
  async function closeEarly() {
    if (!active) return;
    sfx.play('close');
    setBusy(true); setClosing(true); setError('');
    try { await gameApi(`/rounds/${active.id}/close`, {}); refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to request a close.'); }
    finally { setBusy(false); setClosing(false); }
  }
  // Cancel while opening: the service pulls the resting quote; a partial fill is closed and the round ends with its result.
  async function cancelOpening() {
    if (!active || active.status !== 'opening' || busy) return;
    setBusy(true); setClosing(true); setError('');
    try { await gameApi(`/rounds/${active.id}/cancel`, {}); refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to cancel the call.'); }
    finally { setBusy(false); setClosing(false); }
  }
  const serviceOffline = Boolean(healthError) || (health != null && !health.ready);
  const pose = catPose({ connected: state.status >= AccountStatusEnum.Connected, active: Boolean(active), liveResult: livePnl?.net, last, now });
  const openDeposit = () => modal.show(isMobile ? DepositAndWithdrawWithSheetId : DepositAndWithdrawWithDialogId, { activeTab: 'deposit' });
  // Idle chart: the call itself, front and centre. Same handlers as the panel's buttons, so either pair starts the round.
  const idleCall = <div className="nl-chart-cta" data-state={!ready ? 'connect' : noFunds ? 'deposit' : 'play'}>
    {!ready ? <>
      <h2 data-cat-avoid="">Call the next {durationText(duration)}</h2>
      <p data-cat-avoid="">Up or down? Connect a wallet and the clock starts on your call.</p>
      {state.status >= AccountStatusEnum.Connected
        ? <p className="nl-chart-cta-note" data-cat-avoid="">Finish enabling trading from the wallet menu above.</p>
        : <button type="button" className="nl-button nl-button-amber nl-chart-cta-connect" onClick={() => void connect()}><Wallet size={18}/>Connect wallet</button>}
    </> : noFunds ? <>
      <h2 data-cat-avoid="">Add funds to play</h2>
      <p data-cat-avoid="">Your account has nothing usable for a round yet. Deposit USDC and your first call is one tap away.</p>
      <button type="button" className="nl-button nl-button-amber nl-chart-cta-deposit" onClick={() => void openDeposit()}><ArrowDownLeft size={18}/>Deposit to play</button>
    </> : <>
      <div className="nl-direction-buttons nl-chart-directions"><button disabled={!canStart} className="nl-up nl-chart-up" onClick={() => void start('UP')}><span>UP ▲</span></button><button disabled={!canStart} className="nl-down nl-chart-down" onClick={() => void start('DOWN')}><span>DOWN ▼</span></button></div>
      <p className="nl-chart-cta-summary" data-cat-avoid=""><b>{margin > 0 && Number.isFinite(margin) ? dollars(margin) : '—'}</b> · <b>{durationText(duration)}</b></p>
    </>}
  </div>;
  return <main className="nl-shell nl-game-shell">
    <div className="nl-page-heading nl-game-heading"><div><h1>Up or <em>down</em>?</h1><p>Call it. Watch the clock. Win or lose on Cato's luck.</p></div></div>
    <BalanceBar/>
    {(healthError || marketError || roundError) && <div role="alert" className="nl-error">{healthError || marketError || roundError} {active && 'An active round may still be open. Check Portfolio before taking another action.'}</div>}
    <div className="nl-game-grid">
      <section className="nl-market-panel" data-cat-platform="">
        <div className="nl-chart-toolbar"><span>Round result</span>{record.streak >= 2 && <span className="nl-streak" role="status">🔥 {record.streak} in a row</span>}<span className="nl-record">Your record <b>{record.played ? `${record.wins}W · ${record.losses}L` : '—'}</b></span><div className="nl-live"><i/> {streamConnected ? 'LIVE' : 'RECONNECTING'}</div></div>
        <div className="nl-chart-area"><PnlChart phase={phase} points={chartPoints} margin={chartRound?.margin} sendingSince={sendingSince} now={now}
          progress={fillProgress ?? confirmingQuote} onCancel={sendingRound?.status === 'opening' && !sendingRound.openCancelRequested && !busy ? () => void cancelOpening() : undefined}
          span={active?.openedAt && active.deadline ? active.deadline - active.openedAt : undefined} countdown={phase === 'open' && active?.status === 'open' ? timeLeftText(remaining) : undefined}
          final={phase === 'closed' && chartRound ? finalResult(chartRound) : undefined} note={phase === 'open' && active?.status === 'closing' ? 'Closing…' : phase === 'closed' && chartRound?.closeReason === 'liquidation' ? 'Liquidated' : undefined}
          idle={idleCall} {...demo}/></div>
        <footer className="nl-round-strip nl-panel-footer"><Clock3 size={18}/><span>{active ? 'Your round is in motion' : 'Every round starts with a call'}</span><b>{active ? `${timeLeftText(remaining)} remaining` : durationText(duration)}</b></footer>
      </section>
      <div className="nl-side-column">
        <section className="nl-cat-panel">
          <CatHome pose={pose}/>
        </section>
        <aside className="nl-play-panel" data-cat-platform="">
          <div className="nl-card-heading"><span className="nl-eyebrow">YOUR CALL</span></div>
          <div className="nl-play-body">
            {active ? <div className="nl-active-round" aria-live="polite">
              <div className="nl-active-hero">
              <div className="nl-active-head"><h2>Your call</h2><span className={`nl-active-direction ${active.direction === 'UP' ? 'nl-positive' : 'nl-negative'}`} role="img" aria-label={active.direction === 'UP' ? 'Up' : 'Down'}>{active.direction === 'UP' ? <ArrowUpRight size={22} strokeWidth={2.5}/> : <ArrowDownRight size={22} strokeWidth={2.5}/>}</span></div>
              <div className="nl-countdown">{active.status === 'open' ? <TimeLeft seconds={remaining}/> : active.status === 'closing' ? '…' : '↗'}</div>
              <progress value={active.deadline ? Math.max(0, active.duration - remaining) : 0} max={active.duration}/>
              <div className="nl-countdown-meta"><small>{active.status === 'open' ? 'TIME LEFT' : active.status === 'opening' && fillProgress ? `OPENING · ${fillProgress.toUpperCase()}` : active.status.replaceAll('_', ' ').toUpperCase()}</small></div>
              </div>
              {/* Round controls, right under the timer for the whole round: add time, then close early. Neither waits for the last minute. */}
              <div className="nl-round-controls">
                {health?.timeExtensions && <RoundExtension round={active} now={now} disabled={busy || !ready || Boolean(healthError || roundError)} onExtend={extendTime}/>}
                {active.status === 'opening'
                  ? <button onClick={() => void cancelOpening()} disabled={busy || active.openCancelRequested} aria-busy={closing || active.openCancelRequested || undefined} className="nl-button nl-full nl-close-early nl-cancel-opening">{active.openCancelRequested || closing ? 'Cancelling…' : 'Cancel call'}</button>
                  : <button onClick={closeEarly} disabled={busy || active.status === 'closing'} aria-busy={closing || active.status === 'closing' || undefined} className="nl-button nl-full nl-close-early">{active.status === 'closing' ? 'Confirming closing fills…' : closing ? 'Closing…' : 'Close round early'}</button>}
              </div>
              <div className="nl-result-card">
                <LivePnl round={active} price={price} feeRate={feeRate} connected={streamConnected}/>
                <dl className="nl-details"><div><dt>Your stake</dt><dd>{dollars(active.margin)}</dd></div></dl>
              </div>
              {active.error && <p className="nl-error" role="alert">{active.error}</p>}
            </div> : <div className="nl-entry">
              <AmountInput value={amount} onChange={setAmount} context={amountContext} disabled={locked || !health?.ready || Boolean(healthError || marketError || roundError)}/>
              <div className="nl-field-label"><label htmlFor="round-duration">Round length</label><Clock3 size={14} aria-hidden="true"/></div><div className="nl-duration" id="round-duration" role="group" aria-label="Round duration">{roundDurations.map(([n, label]) => <button key={n} disabled={busy} aria-pressed={duration === n} className={duration === n ? 'selected' : ''} onClick={() => setDuration(n)}>{label}</button>)}</div>
              {quote.ready && margin > 0 && !quote.withinMaxSize && <p className="nl-field-error">That stake is over the table limit. Choose Max or a smaller amount.</p>}
              {quote.ready && margin > 0 && quote.enoughSize && !quote.withinBalance && <p className="nl-field-error">This amount is above your available balance. Choose Max or add funds.</p>}
              {isSubAccount && <p className="nl-field-error">Sub-accounts can't play. Switch to your main account.</p>}
              {noFunds && <button type="button" className="nl-button nl-button-amber nl-full nl-panel-deposit" onClick={() => void openDeposit()}><ArrowDownLeft size={16}/>Deposit to play</button>}
              <div className="nl-direction-buttons"><button disabled={!canStart} className="nl-up" onClick={() => void start('UP')}><span>UP ▲</span></button><button disabled={!canStart} className="nl-down" onClick={() => void start('DOWN')}><span>DOWN ▼</span></button></div>
              {!ready && <p className="nl-connect-hint">Connect your wallet and enable trading to play.</p>}
            </div>}
            {busy && !active && <p className="nl-fineprint" role="status">Starting round... Check your wallet if authorization is requested.</p>}
            {error && <p className="nl-error" role="alert">{error}</p>}
            {serviceOffline && <p className="nl-service-offline" role="status">Round service offline.</p>}
          </div>
          <footer className="nl-last-strip nl-panel-footer">{last ? <>Last round · <b>Called</b>{last.direction === 'UP' ? <ArrowUpRight className="nl-last-direction" size={14} strokeWidth={2.5} role="img" aria-label="Up"/> : <ArrowDownRight className="nl-last-direction" size={14} strokeWidth={2.5} role="img" aria-label="Down"/>} · {last.closeReason === 'liquidation' && <span className="nl-negative">Liquidated · </span>}<b className={lastResult == null ? '' : lastResult > 0 ? 'nl-positive' : lastResult < 0 ? 'nl-negative' : ''}>{lastResult == null ? last.status === 'ended_early' ? 'Confirming result' : last.status.replaceAll('_', ' ') : `${lastResult > 0 ? '+' : ''}${dollars(lastResult)}`}</b></> : 'No rounds yet. Your first call shows here.'}</footer>
        </aside>
      </div>
    </div>
  </main>;
}

/** Wins, losses and the current winning streak over the finished rounds (newest first). Unreconciled rounds count for nothing. */
function winRecord(rounds: Round[]) {
  let wins = 0, losses = 0, streak = 0, streakOpen = true;
  for (const round of rounds) {
    if (activeRound(round)) continue;
    const result = finalResult(round);
    if (result == null || result === 0) { streakOpen = false; continue; }
    if (result > 0) { wins++; if (streakOpen) streak++; } else { losses++; streakOpen = false; }
  }
  return { wins, losses, streak, played: wins + losses };
}
/** Whole minutes and zero-padded seconds ("4m 05s"); seconds only under a minute ("32s"). */
function timeLeftParts(seconds: number) {
  const whole = Math.max(0, Math.ceil(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(whole / 60), rest = whole % 60;
  return minutes ? { minutes, seconds: String(rest).padStart(2, '0') } : { seconds: String(rest) };
}
function timeLeftText(seconds: number) {
  const t = timeLeftParts(seconds);
  return t.minutes ? `${t.minutes}m ${t.seconds}s` : `${t.seconds}s`;
}
/** Big countdown with smaller unit letters; its text reads exactly like timeLeftText. */
function TimeLeft({ seconds }: { seconds: number }) {
  const t = timeLeftParts(seconds);
  return <span className="nl-time-left">{t.minutes ? <>{t.minutes}<span className="nl-unit">m</span> </> : null}{t.seconds}<span className="nl-unit">s</span></span>;
}

