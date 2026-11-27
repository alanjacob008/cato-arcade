import { withBasePath } from '../utils/base-path';
import { useAccount, useCollateral, useHoldingStream, useIndexPricesStream } from '@orderly.network/hooks';
import { modal, useScreen } from '@orderly.network/ui';
import { DepositAndWithdrawWithDialogId, DepositAndWithdrawWithSheetId } from '@orderly.network/ui-transfer';
import { AccountStatusEnum } from '@orderly.network/types';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { AssetIcon } from './AssetIcon';
import { dollars } from './api';
import '../styles/portfolio.css';

/** Money tied up in open rounds: account value minus what could be withdrawn right now. Never negative. */
export const inPlay = (totalValue: number | null | undefined, availableBalance: number | null | undefined) =>
  Math.max(0, (Number(totalValue) || 0) - (Number(availableBalance) || 0));

const amountText = (token: string, n: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: token === 'USDC' ? 2 : 0, maximumFractionDigits: token === 'USDC' ? 2 : 6 }).format(n);

const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${dollars(Math.abs(n), 2)}`;
const tone = (n: number) => n > 0 ? 'nl-positive' : n < 0 ? 'nl-negative' : '';

/**
 * Balances tab. The BalanceBar above the tabs already shows account value, USDC and
 * withdrawable cash, so this view explains where the money sits: how much is in play,
 * how much can start a new round, results not yet settled, and holdings by asset.
 */
export default function Balances() {
  const { state } = useAccount();
  const ready = state.status === AccountStatusEnum.EnableTrading;
  const { totalValue, freeCollateral, availableBalance, usdcHolding, unsettledPnL } = useCollateral({ dp: 6 });
  const { data: holdings } = useHoldingStream();
  const { getIndexPrice } = useIndexPricesStream();
  const { isMobile } = useScreen();
  const fund = (activeTab: 'deposit' | 'withdraw') => modal.show(isMobile ? DepositAndWithdrawWithSheetId : DepositAndWithdrawWithDialogId, { activeTab });

  if (!ready) return <div className="nl-balances">
    <div className="nl-empty">
      <img src={withBasePath("/cato/asleep.webp")} alt=""/>
      <h3>Nothing in the jar yet.</h3>
      <p>{state.accountId ? 'Finish setting up your account to see your balance.' : 'Connect your wallet to see your balance.'}</p>
    </div>
  </div>;

  const locked = inPlay(totalValue, availableBalance);
  const unsettled = Number(unsettledPnL) || 0;
  const rows = (holdings?.length ? holdings : [{ token: 'USDC', holding: usdcHolding }])
    .filter(h => h.token === 'USDC' || h.holding !== 0)
    .map(h => ({ token: h.token, balance: h.holding, value: h.token === 'USDC' ? h.holding : h.holding * (getIndexPrice(h.token) || 0) }));

  return <div className="nl-balances">
    <div className="nl-stat-tiles nl-balances-tiles">
      <div className="nl-stat-tile nl-balances-tile nl-balances-tile-play">
        <span className="nl-label">In play</span>
        <strong>{dollars(locked, 2)}</strong>
        <small>Locked in open rounds until they close.</small>
      </div>
      <div className="nl-stat-tile nl-balances-tile">
        <span className="nl-label">Free for new rounds</span>
        <strong>{dollars(Math.max(0, Number(freeCollateral) || 0), 2)}</strong>
        <small>What you can put into your next call.</small>
      </div>
      <div className="nl-stat-tile nl-balances-tile">
        <span className="nl-label">Unsettled result</span>
        <strong className={tone(unsettled)}>{signed(unsettled)}</strong>
        <small>Round results not yet in your USDC.</small>
      </div>
    </div>
    <p className="nl-stat-caption nl-balances-caption">How your money splits between open rounds and your next call.</p>

    <section className="nl-balances-holdings" aria-label="Holdings">
      <header className="nl-balances-head">
        <div>
          <h2>Holdings</h2>
          <p>What sits in your account, by asset.</p>
        </div>
        <div className="nl-balances-actions">
          <button type="button" onClick={() => fund('deposit')} className="nl-button nl-button-amber"><ArrowDownLeft size={15}/>Deposit</button>
          <button type="button" onClick={() => fund('withdraw')} className="nl-button"><ArrowUpRight size={15}/>Withdraw</button>
        </div>
      </header>
      <div className="nl-table-scroll">
        <table className="nl-balances-table">
          <thead><tr><th>Asset</th><th className="nl-balances-num">Balance</th><th className="nl-balances-num">Value</th></tr></thead>
          <tbody>{rows.map(r => <tr key={r.token}>
            <td><span className="nl-balances-asset"><AssetIcon symbol={r.token}/><strong>{r.token}</strong></span></td>
            <td className="nl-balances-num">{amountText(r.token, r.balance)}</td>
            <td className="nl-balances-num nl-balances-value">{dollars(r.value, 2)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>
  </div>;
}
