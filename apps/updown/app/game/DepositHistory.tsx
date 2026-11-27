import { withBasePath } from '../utils/base-path';
import { useEffect, useMemo, useState } from 'react';
import { useAccount, useAssetsHistory, useChainInfo } from '@orderly.network/hooks';
import { AccountStatusEnum, AssetHistorySideEnum, AssetHistoryStatusEnum } from '@orderly.network/types';
import type { API } from '@orderly.network/types';
import { ArrowDownLeft, ArrowUpRight, ExternalLink } from 'lucide-react';
import { getSolscanExplorerBaseUrl } from '@/utils/solana-explorer';
import { dollars } from './api';

/** Rows fetched per "page"; Load more grows the single request by this much. */
export const LEDGER_PAGE = 50;

const isToday = (time: number) => new Date(time).toDateString() === new Date().toDateString();
const clock: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
/** Client-local, compact: "14:32" today, otherwise "9 Oct, 14:32" (same as the Rounds tab). */
export const ledgerWhen = (time: number) => new Intl.DateTimeFormat(undefined, isToday(time) ? clock : { day: 'numeric', month: 'short', ...clock }).format(time);

export const shortHash = (tx: string) => tx.length > 10 ? `${tx.slice(0, 4)}…${tx.slice(-4)}` : tx;

export function statusText(status: string | undefined): 'Completed' | 'Failed' | 'Pending' {
  if (status === AssetHistoryStatusEnum.COMPLETED) return 'Completed';
  if (status === AssetHistoryStatusEnum.FAILED) return 'Failed';
  return 'Pending';
}

/** Deposits and withdrawals only, newest first. */
export function ledgerRows(rows: readonly API.AssetHistoryRow[]) {
  return rows
    .filter(r => r.side === AssetHistorySideEnum.DEPOSIT || r.side === AssetHistorySideEnum.WITHDRAW)
    .slice()
    .sort((a, b) => b.created_time - a.created_time);
}

type ChainRow = { chain_id: string | number; explorer_base_url?: string };

function txUrl(row: API.AssetHistoryRow, chains: ChainRow[] | undefined) {
  if (!row.tx_id) return undefined;
  const chain = chains?.find(c => Number(c.chain_id) === Number(row.chain_id));
  const base = chain?.explorer_base_url || getSolscanExplorerBaseUrl(row.chain_id);
  return base ? `${base.replace(/\/+$/, '')}/tx/${row.tx_id}` : undefined;
}

function Ledger() {
  const [pages, setPages] = useState(1);
  // No side filter: /v1/asset/history returns deposits and withdrawals together, already
  // interleaved by time, so one request keeps pagination honest across both.
  const [fetched, { meta, isLoading }] = useAssetsHistory({ page: 1, pageSize: LEDGER_PAGE * pages });
  const { data: chainInfo } = useChainInfo();
  const chains = Array.isArray(chainInfo) ? chainInfo as ChainRow[] : undefined;

  // Growing the page size changes the request key; keep the last rows on screen meanwhile.
  const [previous, setPrevious] = useState<readonly API.AssetHistoryRow[]>([]);
  useEffect(() => { if (fetched.length) setPrevious(fetched); }, [fetched]);
  const source = fetched.length || !isLoading ? fetched : previous;
  const rows = useMemo(() => ledgerRows(source), [source]);
  const total = meta?.total ?? 0;
  const more = total > source.length;

  if (!rows.length) return isLoading
    ? <p className="nl-muted nl-ledger-loading">Loading…</p>
    : <div className="nl-empty">
      <img src={withBasePath("/cato/waiting.webp")} alt=""/>
      <h3>A clean slate.</h3>
      <p>No deposits or withdrawals yet.</p>
    </div>;

  return <>
    <div className="nl-table-scroll nl-ledger-scroll">
      <table className="nl-ledger-table">
        <thead><tr>
          <th>Type</th><th>Time</th><th className="nl-ledger-num">Amount</th><th>Status</th><th className="nl-ledger-end">Tx</th>
        </tr></thead>
        <tbody>{rows.map(r => {
          const deposit = r.side === AssetHistorySideEnum.DEPOSIT;
          const net = Math.abs(Number(r.amount) - (Number(r.fee) || 0));
          const status = statusText(r.trans_status);
          const href = txUrl(r, chains);
          return <tr key={r.id}>
            <td><span className={`nl-ledger-type ${deposit ? 'nl-ledger-deposit' : 'nl-ledger-withdraw'}`}>{deposit ? <ArrowDownLeft size={12} aria-hidden="true"/> : <ArrowUpRight size={12} aria-hidden="true"/>}{deposit ? 'Deposit' : 'Withdraw'}</span></td>
            <td className="nl-ledger-time">{ledgerWhen(r.created_time)}</td>
            <td className="nl-ledger-num">
              <span className={`nl-ledger-amount ${deposit ? 'nl-positive' : 'nl-negative'}`} title={r.fee ? `${dollars(r.fee, 2)} fee deducted` : undefined}>{deposit ? '+' : '−'}{dollars(net, 2)}</span>
            </td>
            <td><span className={`nl-ledger-status nl-ledger-status-${status.toLowerCase()}`}>{status}</span></td>
            <td className="nl-ledger-end">{r.tx_id
              ? href
                ? <a className="nl-ledger-tx" href={href} target="_blank" rel="noreferrer" title={r.tx_id}>{shortHash(r.tx_id)}<ExternalLink size={11} aria-hidden="true"/></a>
                : <span className="nl-ledger-tx" title={r.tx_id}>{shortHash(r.tx_id)}</span>
              : <span className="nl-ledger-none">—</span>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {more && <div className="nl-ledger-more">
      <button type="button" className="nl-button" disabled={isLoading} onClick={() => setPages(p => p + 1)}>{isLoading ? 'Loading…' : 'Load more'}</button>
    </div>}
  </>;
}

/** History tab: every deposit and withdrawal in one table. */
export default function DepositHistory() {
  const { state } = useAccount();
  const ready = state.status === AccountStatusEnum.EnableTrading;
  return <div className="nl-ledger">
    <p className="nl-ledger-caption">Money in and out of your account, newest first.</p>
    {ready ? <Ledger key={state.accountId}/> : <div className="nl-empty">
      <img src={withBasePath("/cato/waiting.webp")} alt=""/>
      <h3>Nothing here yet.</h3>
      <p>{state.accountId ? 'Finish setting up your account to see your history.' : 'Connect your wallet to see your history.'}</p>
    </div>}
  </div>;
}
