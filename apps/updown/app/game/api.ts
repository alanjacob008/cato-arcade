import { useCallback, useEffect, useRef, useState } from 'react';

export type Market = {
  symbol: string; display_symbol_name?: string; mark_price: number; base_imr: number;
  imr_factor: number; base_tick: number; base_min: number; base_max?: number; min_notional: number; maxLeverage: number;
  '24h_open': number; '24h_close': number; '24h_amount': number;
};
export type Round = {
  id: string; accountId: string; symbol: string; direction: 'UP' | 'DOWN'; duration: number;
  margin: number; leverage: number; quantity: number; status: string; createdAt: number;
  openedAt?: number; deadline?: number; closedAt?: number; entryPrice?: number; exitPrice?: number;
  fees?: number; tradingPnl?: number; error?: string; liquidationPrice?: number; markPrice?: number;
  openFee?: number; positionQuantity?: number;
  closeAttempts?: { terminal?: boolean; quantity?: number; price?: number; fee?: number; requestedAt?: number }[];
  extensions?: { id: string; seconds: number; acceptedAt: number; deadline: number }[];
  keyExpiration?: number;
  closeReason?: string; resultSource?: string; resultPending?: boolean;
  netPnl?: number; fundingFee?: number;
  /** Opening progress: the post-only quotes at the top of the book and, after the maker window, the market fallback. */
  fill?: RoundFill;
  /** The player cancelled while the round was opening. */
  openCancelRequested?: boolean; cancelledOpening?: boolean;
};
export type RoundFill = {
  /** What the opening orders have filled so far, of the planned `quantity`. */
  filledQuantity: number; quantity: number;
  /** Post-only quotes placed so far (requoted when the top of the book moves away). */
  quotes: number;
  /** True while everything filled came from quotes (maker fee); false once the market fallback filled anything. */
  maker: boolean;
  /** The market fallback for the remainder was sent. */
  fallback: boolean;
};
// The local worker hands out a per-process token that every request must echo.
// Inside the website the signed-in session cookie authenticates instead, and
// /game-api/session returns no token.
let session: Promise<{ token?: string; network: string }> | undefined;
async function getSession() {
  if (!session) session = fetch('/game-api/session', { signal: AbortSignal.timeout(15000) }).then(async r => { if (!r.ok) throw new Error('Round service is offline.'); return r.json(); }).catch(e => { session = undefined; throw e; });
  return session;
}
export async function gameApi<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const { token } = await getSession();
  const timeout = AbortSignal.timeout(body ? 90000 : 15000);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['X-UpDown-Token'] = token;
  const response = await fetch('/game-api' + path, { method: body ? 'POST' : 'GET', headers, credentials: 'same-origin', ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (response.status === 401) session = undefined;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The round service could not complete this request.');
  return data;
}
export function useGameQuery<T>(path: string | null, interval = 3000) {
  const [state, setState] = useState<{ path: string | null; data?: T; error: string }>({ path, error: '' });
  const reload = useRef<() => void>(() => {});
  const refresh = useCallback(() => reload.current(), []);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>, pending: AbortController | undefined;
    let lastStarted = -Infinity;
    setState({ path, error: '' });
    if (!path) { reload.current = () => {}; return; }
    async function load() {
      clearTimeout(timer);
      pending?.abort();
      const request = new AbortController(); pending = request;
      lastStarted = Date.now();
      try {
        const data = await gameApi<T>(path!, undefined, request.signal);
        if (!disposed && !request.signal.aborted) setState({ path, data, error: '' });
      } catch (e) {
        if (!disposed && !request.signal.aborted) setState(old => ({ ...old, error: e instanceof Error ? e.message : 'Connection lost.' }));
      }
      if (!disposed && !request.signal.aborted) timer = setTimeout(load, interval);
    }
    // Keep the last good data visible during refresh. Returning from a suspended
    // tab also replaces any stuck read immediately, instead of waiting 90 seconds.
    const resume = () => {
      if (document.visibilityState !== 'hidden' && Date.now() - lastStarted >= 250) void load();
    };
    reload.current = () => { void load(); };
    document.addEventListener('visibilitychange', resume);
    for (const event of ['focus', 'online', 'pageshow']) window.addEventListener(event, resume);
    void load();
    return () => {
      disposed = true; pending?.abort(); clearTimeout(timer); reload.current = () => {};
      document.removeEventListener('visibilitychange', resume);
      for (const event of ['focus', 'online', 'pageshow']) window.removeEventListener(event, resume);
    };
  }, [path, interval]);
  return { data: state.path === path ? state.data : undefined, error: state.path === path ? state.error : '', refresh };
}
/** Orderly account IDs are hex; the round service stores them lowercase. */
export const sameAccount = (a?: string | null, b?: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
export const activeRound = (r: Round) => !['closed', 'failed', 'ended_early'].includes(r.status);
export const ticker = (symbol: string) => symbol.replace(/^PERP_/, '').replace(/_USDC$/, '');
export const dollars = (n: number | undefined | null, decimals = 2) => n == null || !Number.isFinite(n) ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);
export function sizedLeverage(market?: Market, margin = 0) {
  if (!market) return 1;
  const cap = margin > 0 && market.imr_factor > 0 ? Math.pow(1 / (market.imr_factor * Math.pow(margin, .8)), 1 / 1.8) : market.maxLeverage;
  return Math.max(1, Math.floor(Math.min(market.maxLeverage, cap)));
}
