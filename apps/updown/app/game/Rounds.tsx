import { withBasePath } from '../utils/base-path';
import { useAccount } from '@orderly.network/hooks';
import { finalResult, roundResult } from './pnl';
import { useRoundResults } from './use-round-results';
import { AssetIcon } from './AssetIcon';
import { activeRound, dollars, Round, ticker, useGameQuery } from './api';
import '../styles/portfolio.css';
import '../styles/rounds.css';

const durationText = (seconds: number) => seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
const isToday = (time: number | undefined) => time != null && new Date(time).toDateString() === new Date().toDateString();
const clock: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
/** Client-local, compact: "14:32" today, otherwise "9 Oct, 14:32" (locale decides order and 12/24h). */
export const whenText = (time: number) => new Intl.DateTimeFormat(undefined, isToday(time) ? clock : { day: 'numeric', month: 'short', ...clock }).format(time);
/** Round to 2 dp first so the sign and colour always match what is shown ("0.00", never "-0.00"). */
const twoDp = (n: number) => Math.round(n * 100) / 100 || 0;
const signed = (n: number, text: string) => `${n > 0 ? '+' : ''}${text}`;
const tone = (n: number) => n > 0 ? 'nl-positive' : n < 0 ? 'nl-negative' : '';

/** Direction was right but trading fees outweighed the gain: the only place this table says "fees". */
const FEES_ERASED_TITLE = 'The price moved your way, but trading fees were larger than the gain.';

/** Closed rounds stay blank unless fees erased a right call; everything else gets a pill. */
function Status({ round, feesErasedGain }: { round: Round; feesErasedGain?: boolean }) {
  if (round.closeReason === 'liquidation') return <span className="nl-rounds-status nl-rounds-status-ended nl-negative">Liquidated</span>;
  if (round.status === 'ended_early') return <span className="nl-rounds-status nl-rounds-status-ended" title="The position is closed; its final result is being confirmed.">Confirming result</span>;
  if (round.status === 'closed') return feesErasedGain ? <span className="nl-rounds-fee-tag" title={FEES_ERASED_TITLE}>after fees</span> : null;
  if (round.status === 'closing') return <span className="nl-rounds-status nl-rounds-status-closing"><i aria-hidden="true"/>Closing</span>;
  if (activeRound(round)) return <span className="nl-rounds-status nl-rounds-status-live"><i aria-hidden="true"/>Live</span>;
  const label = round.status === 'ended_early' ? 'Ended early' : round.status === 'failed' ? 'Failed' : round.status.replaceAll('_', ' ');
  return <span className="nl-rounds-status nl-rounds-status-ended" title={round.error}>{label}</span>;
}

function Result({ value }: { value: number | undefined }) {
  if (value == null) return <span className="nl-rounds-result nl-rounds-pending">—</span>;
  const cents = twoDp(value);
  return <span className={`nl-rounds-result ${tone(cents)}`}>{signed(cents, dollars(cents, 2))}</span>;
}

export default function Rounds() {
  const { state } = useAccount();
  const { data, error } = useGameQuery<{ rows: Round[] }>(state.accountId ? `/rounds?accountId=${state.accountId}` : null);
  const { rows, error: resultError } = useRoundResults(data?.rows || []);
  const finished = rows.filter(r => finalResult(r) != null);
  const allTime = finished.reduce((sum, r) => sum + finalResult(r)!, 0);
  const today = finished.filter(r => isToday(r.closedAt)).reduce((sum, r) => sum + finalResult(r)!, 0);
  const wins = finished.filter(r => finalResult(r)! > 0).length;
  const winRate = finished.length ? Math.round(wins / finished.length * 100) : 0;
  const connected = Boolean(state.accountId);

  return <div className="nl-rounds">
    <div className="nl-stat-tiles nl-rounds-stats">
      <div className="nl-stat-tile nl-rounds-stat">
        <span className="nl-label">All-time result</span>
        <strong className={connected ? tone(twoDp(allTime)) : ''}>{connected ? dollars(twoDp(allTime), 2) : '—'}</strong>
      </div>
      <div className="nl-stat-tile nl-rounds-stat">
        <span className="nl-label">Today</span>
        <strong className={connected ? tone(twoDp(today)) : ''}>{connected ? dollars(twoDp(today), 2) : '—'}</strong>
      </div>
      <div className="nl-stat-tile nl-rounds-stat">
        <span className="nl-label">Wins</span>
        <strong>{connected ? <>{wins} / {finished.length}{finished.length > 0 && <small>{winRate}%</small>}</> : '—'}</strong>
      </div>
    </div>
    <p className="nl-stat-caption nl-rounds-caption">Every round you have played, with what you walked away with.</p>
    {error && <p role="alert" className="nl-error">{error}</p>}
    {resultError && <p role="alert" className="nl-error">{resultError}</p>}
    {rows.length ? <div className="nl-table-scroll nl-rounds-scroll">
      <table className="nl-rounds-table">
        <thead><tr>
          <th>Market</th>
          <th>Trade time</th>
          <th>Game time</th>
          <th className="nl-rounds-num">Bet</th>
          <th className="nl-rounds-num">Leverage</th>
          <th className="nl-rounds-num">Entry</th>
          <th className="nl-rounds-num">Exit</th>
          <th className="nl-rounds-num">Price move</th>
          <th className="nl-rounds-num">Result</th>
          <th className="nl-rounds-status-col">Status</th>
        </tr></thead>
        <tbody>{rows.map(r => {
          const result = roundResult(r);
          const move = result ? twoDp(result.percent) : undefined;
          const up = r.direction === 'UP';
          return <tr key={r.id}>
            <td>
              <span className="nl-rounds-market">
                <AssetIcon symbol={r.symbol}/>
                <strong>{ticker(r.symbol)}</strong>
                <span className={`nl-rounds-call ${up ? 'nl-positive' : 'nl-negative'}`}><span aria-hidden="true">{up ? '↗' : '↘'}</span> {up ? 'Up' : 'Down'}</span>
              </span>
            </td>
            <td className="nl-rounds-time">{whenText(r.createdAt)}</td>
            <td className="nl-rounds-duration">{durationText(r.duration)}</td>
            <td className="nl-rounds-num">{dollars(r.margin, 2)}</td>
            <td className="nl-rounds-num nl-rounds-leverage">{r.leverage}×</td>
            <td className="nl-rounds-num">{dollars(r.entryPrice, 2)}</td>
            <td className="nl-rounds-num">{r.exitPrice == null ? <span className="nl-rounds-pending">—</span> : dollars(r.exitPrice, 2)}</td>
            <td className="nl-rounds-num">{move == null
              ? <span className="nl-rounds-pending">—</span>
              : <span className={`nl-rounds-move ${tone(move)}`}>{signed(move, move.toFixed(2))}%</span>}</td>
            <td className="nl-rounds-num"><Result value={finalResult(r)}/></td>
            <td className="nl-rounds-status-col"><Status round={r} feesErasedGain={result?.feesErasedGain}/></td>
          </tr>;
        })}</tbody>
      </table>
    </div> : <div className="nl-empty">
      <img src={withBasePath("/cato/waiting.webp")} alt=""/>
      <h3>Your story starts with a call.</h3>
      <p>{connected ? 'Your rounds will appear here.' : 'Connect your wallet to see your rounds.'}</p>
    </div>}
  </div>;
}
