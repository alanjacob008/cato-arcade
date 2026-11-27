import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccount, useAccountInfo, useMarkPriceBySymbol, useWsStatus } from '@orderly.network/hooks';
import { activeRound, dollars, Round, ticker, useGameQuery } from './api';
import { AssetIcon } from './AssetIcon';
import { roundPnl } from './pnl';
import '../styles/live-round.css';

const price2 = (n: number | undefined) => dollars(n, n != null && Math.abs(n) > 0 && Math.abs(n) < 1 ? 6 : 2);
/** Same reading as the game screen's countdown: "4m 05s", or seconds only under a minute ("45s"). */
export function timeLeftText(seconds: number) {
  const whole = Math.max(0, Math.ceil(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(whole / 60), rest = whole % 60;
  return minutes ? `${minutes}m ${String(rest).padStart(2, '0')}s` : `${rest}s`;
}
const signed = (n: number | undefined) => n == null || !Number.isFinite(n) ? '—' : (n > 0 ? '+' : '') + dollars(n);

/** The player's current round, shown above the portfolio tabs. Renders nothing while idle. */
export function LiveRoundPanel() {
  const { state } = useAccount();
  const { data: roundsData } = useGameQuery<{ rows: Round[] }>(state.accountId ? `/rounds?accountId=${state.accountId}` : null, 1500);
  const active = state.accountId ? roundsData?.rows?.find(activeRound) : undefined;
  if (!active) return null;
  return <LiveRoundCard round={active}/>;
}

function LiveRoundCard({ round }: { round: Round }) {
  const { data: info } = useAccountInfo();
  const streamedPrice = useMarkPriceBySymbol(round.symbol);
  const connected = useWsStatus() === 'connected';
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  const accountFee = info?.futures_taker_fee_rate;
  const feeRate = accountFee != null && Number.isFinite(Number(accountFee)) ? Number(accountFee) / 10000 : .0003;
  const price = Number((connected ? streamedPrice : undefined) || round.markPrice) || undefined;
  const live = Boolean(round.entryPrice && round.deadline && (round.status === 'open' || round.status === 'closing'));
  const pnl = live && connected ? roundPnl(round, price, feeRate) : undefined;
  const remaining = round.deadline ? Math.max(0, Math.ceil((round.deadline - now) / 1000)) : 0;
  const total = round.deadline && round.openedAt ? round.deadline - round.openedAt : round.duration * 1000;
  const elapsed = total > 0 ? Math.min(1, Math.max(0, 1 - (round.deadline! - now) / total)) : 0;
  const up = round.direction === 'UP';
  const phase = round.status === 'closing' ? 'closing' : live ? 'live' : 'opening';
  const tone = (n: number | undefined) => n == null ? '' : n > 0 ? 'nl-positive' : n < 0 ? 'nl-negative' : '';
  return <section className="nl-live-round" aria-label="Your live round" aria-live="polite">
    <div className="nl-live-round-market">
      <AssetIcon symbol={round.symbol}/>
      <strong>{ticker(round.symbol)}</strong>
      <span className={`nl-live-round-call ${up ? 'nl-positive' : 'nl-negative'}`}>{up ? '↗ Up' : '↘ Down'}</span>
    </div>
    {live ? <dl className="nl-live-round-stats">
      <div><dt>Bet</dt><dd>{dollars(round.margin)}</dd></div>
      <div><dt>Leverage</dt><dd>{round.leverage}×</dd></div>
      <div><dt>Entry</dt><dd>{price2(round.entryPrice)}</dd></div>
      <div><dt>Mark</dt><dd>{price2(price)}</dd></div>
      <div className="nl-live-round-result"><dt>Live result</dt><dd><b className={tone(pnl?.net)}>{signed(pnl?.net)}</b><small>estimate</small></dd></div>
    </dl> : <p className="nl-live-round-opening">Opening your round…</p>}
    <div className="nl-live-round-timer">
      <Link className="nl-live-round-link" to="/">Go to game →</Link>
      {live && <strong className="nl-live-round-clock">{timeLeftText(remaining)}</strong>}
      {live && <span className="nl-live-round-bar" aria-hidden="true"><i style={{ width: `${elapsed * 100}%` }}/></span>}
      <span className={`nl-live-round-pill nl-live-round-pill-${phase}`}><i/>{phase === 'closing' ? 'Closing' : phase === 'live' ? 'Live' : 'Opening'}</span>
    </div>
  </section>;
}

export default LiveRoundPanel;
