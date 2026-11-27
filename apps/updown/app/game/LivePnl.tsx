import { dollars, Round } from './api';
import { roundPnl } from './pnl';

export function LivePnl({ round, price, feeRate, connected }: { round: Round; price?: number; feeRate: number; connected: boolean }) {
  const pnl = connected ? roundPnl(round, price, feeRate) : undefined;
  return <section className="nl-live-pnl" aria-label="Live result">
    <span className="nl-label">Your result</span>
    <strong className={pnl ? pnl.net > 0 ? 'nl-positive' : pnl.net < 0 ? 'nl-negative' : '' : ''}>{dollars(pnl?.net, 4)}</strong>
    <span className="nl-result-caption">Estimated · fees included</span>
    {!pnl && <p className="nl-result-status">{!connected ? 'Price stream reconnecting…' : round.entryPrice ? 'Reconciling position fills…' : 'Waiting for your opening fill…'}</p>}
  </section>;
}
