import { useAccount, useCollateral } from '@orderly.network/hooks';
import { modal, useScreen } from '@orderly.network/ui';
import { DepositAndWithdrawWithDialogId, DepositAndWithdrawWithSheetId } from '@orderly.network/ui-transfer';
import { AccountStatusEnum } from '@orderly.network/types';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, LayoutGrid, Play, Wallet } from 'lucide-react';
import { dollars } from './api';
import { PendingDeposits, usePendingTransfers, WATCH_MS } from './PendingDeposits';

/** Where the third action button goes: the play screen links to the portfolio and vice versa. */
export type BalanceBarDestination = 'portfolio' | 'play';

export function BalanceBar({ destination = 'portfolio' }: { destination?: BalanceBarDestination } = {}) {
  const { state } = useAccount();
  const { totalValue, availableBalance, usdcHolding } = useCollateral({ dp: 6 });
  const ready = state.status === AccountStatusEnum.EnableTrading;
  const { isMobile } = useScreen();
  // Opening the dialog starts a short watch so a fresh transfer appears even before the WS push.
  const [watchUntil, setWatchUntil] = useState(0);
  const transfers = usePendingTransfers({ ready, accountId: state.accountId, watchUntil });
  const fund = (activeTab: string) => {
    setWatchUntil(Date.now() + WATCH_MS);
    return modal.show(isMobile ? DepositAndWithdrawWithSheetId : DepositAndWithdrawWithDialogId, { activeTab });
  };
  return <section className={`nl-balance-bar${transfers.items.length ? ' nl-balance-bar-pending' : ''}`} aria-label="Account balance">
    <div className="nl-balance-icon"><Wallet size={20}/></div>
    <div><span className="nl-label">Account value{transfers.pending && <i className="nl-pending-dot" role="img" title="A transfer is on its way; this will update" aria-label="Updating"/>}</span><strong>{ready ? dollars(totalValue) : '—'}</strong></div>
    <div className="nl-balance-detail"><span className="nl-label">USDC balance</span><b>{ready ? dollars(usdcHolding) : '—'}</b></div>
    <div className="nl-balance-detail"><span className="nl-label">Available to withdraw</span><b>{ready ? dollars(availableBalance) : '—'}</b></div>
    <div className="nl-funding-actions"><button disabled={!ready} onClick={() => fund('deposit')} className="nl-button nl-button-amber"><ArrowDownLeft size={15}/>Deposit</button><button disabled={!ready} onClick={() => fund('withdraw')} className="nl-button"><ArrowUpRight size={15}/>Withdraw</button>{destination === 'play'
      ? <Link className="nl-button" to="/"><Play size={15}/>Play</Link>
      : <Link className="nl-button" to="/portfolio"><LayoutGrid size={15}/>Portfolio</Link>}</div>
    <PendingDeposits items={transfers.items} now={transfers.now} onDismiss={transfers.dismiss}/>
  </section>;
}
