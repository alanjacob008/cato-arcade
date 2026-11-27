import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useEventEmitter, usePrivateQuery } from '@orderly.network/hooks';
import { AssetHistorySideEnum, AssetHistoryStatusEnum } from '@orderly.network/types';
import type { API } from '@orderly.network/types';
import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import { dollars } from './api';
import '../styles/pending-deposits.css';

/** Its own key (the History tab asks for size=50·n), so this poll never fights that table's SWR cache. */
export const PENDING_HISTORY_KEY = '/v1/asset/history?page=1&size=20';
export const PENDING_POLL_MS = 5_000;
/** The countdown target: most deposits land within a minute. */
export const EXPECTED_MS = 60_000;
export const LANDED_MS = 8_000;
const WINDOW_MS = 24 * 60 * 60_000;
/** After Deposit/Withdraw is opened, poll for this long so a new transfer shows up even if the WS push is late. */
export const WATCH_MS = 5 * 60_000;

export type TransferPhase = 'pending' | 'landed' | 'failed';
export type TransferItem = { id: string; deposit: boolean; amount: number; createdTime: number; phase: TransferPhase };

type Track = {
  accountId: string | undefined;
  /** Page load (or account switch): anything settled before this is old news. */
  since: number;
  /** Ids seen while still in flight during this session. */
  inFlight: ReadonlySet<string>;
  /** When this session first saw an id settle (COMPLETED / FAILED). */
  settledAt: ReadonlyMap<string, number>;
  dismissed: ReadonlySet<string>;
};

const fresh = (accountId: string | undefined): Track => ({ accountId, since: Date.now(), inFlight: new Set(), settledAt: new Map(), dismissed: new Set() });
const settled = (status: string) => status === AssetHistoryStatusEnum.COMPLETED || status === AssetHistoryStatusEnum.FAILED;
/** Same figure the History tab shows. */
const netAmount = (r: API.AssetHistoryRow) => Math.abs(Number(r.amount) - (Number(r.fee) || 0));

/** Deposits/withdrawals from the last 24h, newest first, deduped by id and tx hash. */
export function recentTransfers(rows: readonly API.AssetHistoryRow[], now: number) {
  const seen = new Set<string>();
  return rows
    .filter(r => r && (r.side === AssetHistorySideEnum.DEPOSIT || r.side === AssetHistorySideEnum.WITHDRAW) && Number(r.created_time) >= now - WINDOW_MS)
    .slice()
    .sort((a, b) => b.created_time - a.created_time)
    .filter(r => {
      const keys = [`id:${r.id}`, r.tx_id ? `tx:${r.tx_id}` : ''].filter(Boolean);
      if (keys.some(k => seen.has(k))) return false;
      keys.forEach(k => seen.add(k));
      return true;
    });
}

function observe(track: Track, rows: readonly API.AssetHistoryRow[], at: number): Track {
  let inFlight: Set<string> | undefined, settledAt: Map<string, number> | undefined;
  for (const r of recentTransfers(rows, at)) {
    if (!settled(r.trans_status)) {
      if (!track.inFlight.has(r.id)) (inFlight ??= new Set(track.inFlight)).add(r.id);
    } else if (!track.settledAt.has(r.id) && (track.inFlight.has(r.id) || r.created_time >= track.since)) {
      (settledAt ??= new Map(track.settledAt)).set(r.id, at);
    }
  }
  return inFlight || settledAt ? { ...track, inFlight: inFlight ?? track.inFlight, settledAt: settledAt ?? track.settledAt } : track;
}

/**
 * In-flight deposits/withdrawals for the balance bar. Data comes from /v1/asset/history (what
 * useAssetsHistory reads), refetched on the SDK's `wallet:changed` push and polled every 5s
 * while something is in flight or the transfer dialog was just opened; idle otherwise.
 */
export function usePendingTransfers({ ready, accountId, watchUntil = 0 }: { ready: boolean; accountId?: string; watchUntil?: number }) {
  const [now, setNow] = useState(Date.now);
  const [track, setTrack] = useState(() => fresh(accountId));
  const current = track.accountId === accountId ? track : fresh(accountId);
  if (current !== track) setTrack(current);

  // Poll only while something is in flight (decided from the last response) or the dialog was just opened.
  const [inFlight, setInFlight] = useState(false);
  const watching = watchUntil > now;
  const { data, mutate } = usePrivateQuery<API.AssetHistoryRow[] | { rows?: API.AssetHistoryRow[] }>(ready ? PENDING_HISTORY_KEY : null, {
    revalidateOnFocus: true,
    refreshInterval: inFlight || watching ? PENDING_POLL_MS : 0,
  });
  const rows = ready ? (Array.isArray(data) ? data : data?.rows) : undefined;
  // Layout effect: a row flipping to COMPLETED goes straight from "on its way" to "landed" with no blank frame.
  useLayoutEffect(() => {
    if (!rows) { setInFlight(false); return; }
    const at = Date.now();
    setNow(at);
    setInFlight(recentTransfers(rows, at).some(r => !settled(r.trans_status)));
    setTrack(t => observe(t, rows, at));
  }, [rows]);

  const ee = useEventEmitter();
  useEffect(() => {
    if (!ready || !ee || !mutate) return;
    const refresh = () => { void mutate(); };
    ee.on('wallet:changed', refresh);
    return () => { ee.off('wallet:changed', refresh); };
  }, [ee, mutate, ready]);

  const items = useMemo<TransferItem[]>(() => !ready || !rows ? [] : recentTransfers(rows, now).flatMap((r): TransferItem[] => {
    const base = { id: r.id, deposit: r.side === AssetHistorySideEnum.DEPOSIT, amount: netAmount(r), createdTime: Number(r.created_time) };
    if (!settled(r.trans_status)) return [{ ...base, phase: 'pending' }];
    const at = current.settledAt.get(r.id);
    if (at == null) return [];
    if (r.trans_status === AssetHistoryStatusEnum.FAILED) return current.dismissed.has(r.id) ? [] : [{ ...base, phase: 'failed' }];
    return now - at < LANDED_MS ? [{ ...base, phase: 'landed' }] : [];
  }), [ready, rows, now, current]);

  const ticking = watching || items.some(i => i.phase !== 'failed');
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  const dismiss = useCallback((id: string) => setTrack(t => ({ ...t, dismissed: new Set(t.dismissed).add(id) })), []);
  return { items, now, pending: items.some(i => i.phase === 'pending'), dismiss };
}

export function etaText(createdTime: number, now: number) {
  const left = Math.ceil((EXPECTED_MS - (now - createdTime)) / 1000);
  return left > 0 ? `about ${Math.min(left, EXPECTED_MS / 1000)}s left` : 'taking a little longer than usual…';
}

function Line({ item, now, onDismiss }: { item: TransferItem; now: number; onDismiss: (id: string) => void }) {
  const kind = item.deposit ? 'Deposit' : 'Withdrawal';
  const amount = <b className="nl-pending-amount">{dollars(item.amount)}</b>;
  if (item.phase === 'pending') return <div className="nl-pending-line">
    <Loader2 className="nl-pending-icon nl-pending-spin" size={15} aria-hidden="true"/>
    <span className="nl-pending-text">{kind} of {amount} on its way</span>
    <span className="nl-pending-eta">{etaText(item.createdTime, now)}</span>
  </div>;
  if (item.phase === 'landed') return <div className="nl-pending-line nl-pending-landed">
    <CheckCircle2 className="nl-pending-icon" size={15} aria-hidden="true"/>
    <span className="nl-pending-text">{kind} of {amount} {item.deposit ? 'landed' : 'sent to your wallet'}</span>
  </div>;
  return <div className="nl-pending-line nl-pending-failed">
    <AlertCircle className="nl-pending-icon" size={15} aria-hidden="true"/>
    <span className="nl-pending-text">{item.deposit ? 'Deposit failed. Nothing was taken.' : 'Withdrawal failed. The funds stay in your account.'}</span>
    <button type="button" className="nl-pending-dismiss" aria-label="Dismiss" onClick={() => onDismiss(item.id)}><X size={14} aria-hidden="true"/></button>
  </div>;
}

/** Full-width strip at the foot of the balance bar: one line per in-flight / just-settled transfer. */
export function PendingDeposits({ items, now, onDismiss }: { items: readonly TransferItem[]; now: number; onDismiss: (id: string) => void }) {
  if (!items.length) return null;
  return <div className="nl-pending-strip" role="status" aria-live="polite">
    {items.map(item => <Line key={item.id} item={item} now={now} onDismiss={onDismiss}/>)}
  </div>;
}
