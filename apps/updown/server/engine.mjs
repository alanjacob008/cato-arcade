import { ceilToTick, floorToTick, isOrderNotFound, maxLeverage, orderQuantity, topOfBook } from './orderly.mjs';
import { createHash } from 'node:crypto';
import { orderlyKeyPair } from './keys.mjs';
import { positionResult } from '../app/game/position-result.mjs';
import { GAME_SYMBOL } from '../app/game/market.mjs';

export const isActive = r => !['closed', 'failed', 'ended_early'].includes(r.status);
/** Orderly account IDs are hex; compare and store them lowercase so case can't split one account in two. */
export const normalizeAccountId = id => (typeof id === 'string' ? id.toLowerCase() : id);
// An order whose intent was saved but which Orderly still has no record of this
// long afterwards never reached it (the POST failed in transit, or the function
// was killed first). Longer than a round lease (90s, postgres-store.mjs) plus the
// request timeout (10s), so the invocation that may have sent it is gone by then.
export const ORDER_NOT_FOUND_GRACE_MS = 105_000;
// Orderly acknowledged the order but cannot find it: wait much longer before giving up on it.
export const ACKED_ORDER_NOT_FOUND_GRACE_MS = 5 * 60_000;
/** Close attempts kept per round; older attempts that filled nothing are dropped beyond this. */
export const MAX_CLOSE_ATTEMPTS = 20;
/** Opening attempts (quotes and the fallback) kept per round; older ones that filled nothing are dropped beyond this. */
export const MAX_OPEN_ATTEMPTS = 60;
/**
 * The opening order is a post-only quote at the top of the book (UP buys at the
 * best bid, DOWN sells at the best ask), requoted whenever the top moves away.
 * From the first quote, this long without a complete fill sends a market order
 * for the remainder instead; what the quotes filled is kept.
 */
export const MAKER_WINDOW_S = 20;
export const MAKER_WINDOW_MS = MAKER_WINDOW_S * 1000;
// A cancel Orderly acknowledged should show on the order within moments; after
// this it is sent again (a cancel can never add a fill, so repeating it is safe).
const CANCEL_RESEND_MS = 2_000;
/** Shown while a quote Orderly cannot find yet is being cancelled (the UI explains the wait with it). */
export const CONFIRMING_QUOTE_MESSAGE = 'Confirming whether the quote reached Orderly…';
/** Share of the planned size below which a remainder is not worth another order (dust after tick rounding). */
const FILL_EPSILON = 1e-8;
// Backoff after Orderly definitively rejects a close (e.g. a revoked key), and
// after definitive (4xx) errors while advancing a round.
const CLOSE_RETRY_BASE_MS = 2_000;
const CLOSE_RETRY_MAX_MS = 5 * 60_000;
const ERROR_RETRY_MAX_MS = 60_000;
/** Rounds the scheduler still has work for: active ones, and ended-early results awaiting confirmation. */
export const needsTick = r => isActive(r) || Boolean(r.resultPending && r.credential);
export const publicRound = ({ credential, ...round }) => round;
// Allowed round lengths in seconds (5m/10m/15m/30m). Time extensions offer the same
// increments; the browser's app/game/timing.ts roundDurations must match this list.
export const ROUND_DURATIONS = Object.freeze([300, 600, 900, 1800]);
/** A round, including every accepted extension, runs at most this long (2 hours). Time may be added at any point while it is open. */
export const MAX_ROUND_DURATION = 7200;
const terminal = status => ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(status);
const closedQuantity = r => r.closeAttempts.reduce((n, c) => n + (c.quantity || 0), 0);
/** Quantity the opening attempts have filled so far (resting partial fills included). */
const openFilled = r => Number((r.openAttempts || []).reduce((n, a) => n + (a.filled || 0), 0).toPrecision(12));
/** The public fill summary kept on the round for the UI (never credentials or raw exchange rows). */
const fillSummary = r => {
  const attempts = r.openAttempts || [];
  const marketFilled = attempts.filter(a => a.type === 'MARKET').reduce((n, a) => n + (a.filled || 0), 0);
  return {
    filledQuantity: openFilled(r), quantity: r.plannedQuantity ?? r.quantity, quotes: attempts.filter(a => a.type === 'POST_ONLY').length,
    maker: marketFilled === 0, fallback: attempts.some(a => a.type === 'MARKET'),
  };
};

/** A journal write lost a compare-and-set race: another invocation changed the round first. */
export class ConflictError extends Error {
  constructor(message = 'The round changed concurrently. Nothing was sent; it will be retried.') { super(message); this.conflict = true; }
}

/** Run `operation` over `items` with at most `limit` in flight. */
async function eachLimit(items, limit, operation) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await operation(queue.shift());
  }));
}

/**
 * Round lifecycle. Stateless between calls: every operation loads the round from
 * the store under that store's lock and writes each state change back before the
 * next exchange request. The store decides what a lock is (in-process for the
 * local file journal, a database lease for Postgres; see store.mjs and
 * postgres-store.mjs), so the same engine runs in the local worker and in
 * serverless functions where many invocations may tick the same round at once.
 *
 * Store contract (all async):
 *   get(id) -> round | undefined (with credential)
 *   listAccount(network, accountId) -> rounds, newest first
 *   dueIds(network, accountId?) -> ids of rounds that needTick
 *   insert(round) -> durable before resolving; rejects a duplicate id or a second active round
 *   save(round) -> durable before resolving; may reject with ConflictError
 *   withLock(names, fn, { wait }) -> { acquired, value }; without wait, skips when held
 */
export class RoundEngine {
  /**
   * `maker`: open with post-only quotes at the top of the book (market fallback
   * after MAKER_WINDOW_MS). Off by default: the owner found quotes too slow to
   * fill, so rounds open at market. Enable with UPDOWN_MAKER=1.
   */
  constructor({ request, store, network, brokerId, now = Date.now, minTickMs = 0, concurrency = 4, maker = process.env.UPDOWN_MAKER === '1' }) {
    this.store = store;
    Object.assign(this, { request, network, brokerId, now, minTickMs, concurrency, maker });
    // Credentials are never used against a different network after an env switch.
    store.assertNetwork?.(network);
  }
  async save(r) { await this.store.save(r); }
  async list(accountId) { return (await this.store.listAccount(this.network, accountId)).map(publicRound); }
  /** Account that owns a round on this network, if any. */
  async owner(id) { const r = await this.store.get(id); return r && r.network === this.network ? r.accountId : undefined; }
  async start(input) {
    if (!/^[a-zA-Z0-9_-]{8,48}$/.test(input?.id || '') || !/^0x[0-9a-fA-F]{64}$/.test(input.accountId || '')) throw new Error('Invalid round or account ID.');
    const accountId = normalizeAccountId(input.accountId);
    const existingRound = async () => {
      const existing = await this.store.get(input.id);
      if (!existing) return;
      if (normalizeAccountId(existing.accountId) !== accountId) throw new Error('Round ID is already in use.');
      return publicRound(existing);
    };
    const hasActive = async () => (await this.store.listAccount(this.network, accountId)).some(isActive);
    const retried = await existingRound();
    if (retried) return retried;
    if (await hasActive()) throw new Error('Finish the active round before starting another.');
    // The game plays one market. Leverage is not a player setting: the round
    // uses the market's live maximum for its size (set below), whatever was sent.
    if (input.symbol !== GAME_SYMBOL) throw new Error('Only BTC is playable.');
    if (!['UP', 'DOWN'].includes(input.direction) || !ROUND_DURATIONS.includes(input.duration) || !Number.isFinite(input.margin) || input.margin <= 0 || !input.secretKey || input.authorize !== true) throw new Error('Invalid round settings or missing authorization.');
    // The account lock serializes starts; the round lock keeps schedulers away
    // from this round until its opening intent is durable (or it has failed).
    const held = await this.store.withLock([`account:${this.network}:${accountId}`, `round:${input.id}`], async () => {
      const raced = await existingRound();
      if (raced) return raced;
      if (await hasActive()) throw new Error('Finish the active round before starting another.');
      const credential = { accountId, secretKey: input.secretKey };
      const [info, positions, orders, algoOrders, markets, futures, leverageCap] = await Promise.all([
        this.request('/v1/client/info', credential), this.request('/v1/positions', credential),
        this.request('/v1/orders?status=INCOMPLETE&size=100', credential),
        this.request('/v1/algo/orders?status=INCOMPLETE&size=100', credential),
        this.request('/v1/public/info'), this.request('/v1/public/futures'), this.request('/v1/public/leverage'),
      ]);
      if (info.broker_id && info.broker_id !== this.brokerId) throw new Error('This account belongs to a different broker.');
      if (positions.rows?.some(p => Number(p.position_qty) !== 0) || orders.rows?.length || algoOrders.rows?.length) throw new Error('This draft needs an account with no existing positions or pending orders. Close those in Portfolio first.');
      const market = markets.rows.find(m => m.symbol === GAME_SYMBOL && m.status === 'ACTIVE');
      const quote = futures.rows.find(m => m.symbol === GAME_SYMBOL);
      if (!market || !quote || Number(quote.mark_price) <= 0) throw new Error('This market is unavailable.');
      // Always the market's current, size-sensitive maximum; input.leverage is ignored.
      const leverage = maxLeverage(market, input.margin, Number(leverageCap.max_futures_leverage));
      const quantity = orderQuantity(input.margin, leverage, Number(quote.mark_price), market);
      const round = {
        id: input.id, accountId, network: this.network, symbol: GAME_SYMBOL,
        direction: input.direction, duration: input.duration, margin: input.margin, leverage,
        quantity, plannedQuantity: quantity, status: 'preparing', createdAt: this.now(), credential,
        orderPrefix: `nl-${createHash('sha256').update(input.id).digest('hex').slice(0, 24)}`,
        // The quote price snaps to quote_tick; a remainder after a partial fill to base_tick.
        quoteTick: Number(market.quote_tick) > 0 ? Number(market.quote_tick) : undefined,
        baseTick: Number(market.base_tick) > 0 ? Number(market.base_tick) : undefined,
        openAttempts: [], openSeq: 0, closeAttempts: [],
      };
      // The durable journal exists before ANY opening order is submitted. The
      // insert also enforces one active round per account in the database.
      await this.store.insert(round);
      try {
        await this.request('/v1/client/leverages', credential, 'POST', { symbol: round.symbol, leverage: round.leverage, margin_mode: 'ISOLATED' });
      } catch (error) {
        round.status = 'failed'; delete round.credential; round.error = error.message; await this.save(round);
        return publicRound(round);
      }
      round.status = 'opening'; round.openRequestedAt = this.now();
      try {
        await this.save(round);
      } catch (error) {
        // The opening intent may not be durable, so no order is sent. Best effort
        // to record the failure; a scheduler fails a stale 'preparing' row anyway.
        Object.assign(round, { status: 'failed', error: error.message }); delete round.credential;
        await this.save(round).catch(() => {});
        throw error;
      }
      // The first quote goes out through the same machinery the scheduler uses
      // (intent saved, then sent, then the outcome recorded). A failure here
      // (e.g. the order book could not be read) leaves the round 'opening' for
      // the next tick; nothing was sent without its intent on record.
      try {
        await this.advanceOpening(round);
      } catch (error) {
        if (error.conflict) throw error;
        round.error = error.message;
        await this.save(round).catch(saveError => console.error(`Up Down: round ${round.id} send outcome not recorded: ${saveError.message}`));
      }
      return publicRound(round);
    }, { wait: false });
    if (!held.acquired) {
      const retry = await existingRound();
      if (retry) return retry;
      throw new Error('Finish the active round before starting another.');
    }
    return held.value;
  }
  /** Advance every round with pending work (optionally one account's). Returns how many were due. */
  async tick({ accountId, continueWhile } = {}) {
    const ids = await this.store.dueIds(this.network, accountId === undefined ? undefined : normalizeAccountId(accountId));
    // continueWhile: the caller's time budget. No new round is started once it
    // says stop, so an order is never sent just before the function is killed.
    await eachLimit(ids, this.concurrency, async id => (continueWhile && !continueWhile()) || this.tickRound(id).catch(error => {
      // Never let one round's storage problem stop the others. No credential is logged.
      console.error(`Up Down: round ${id} could not be advanced: ${error.message}`);
    }));
    return ids.length;
  }
  /** Advance one round unless another invocation is already doing so. */
  async tickRound(id, { force = false } = {}) {
    const held = await this.store.withLock([`round:${id}`], async () => {
      const r = await this.store.get(id);
      if (!r || r.network !== this.network || !needsTick(r)) return;
      // Many callers (players' polls, the cron sweep) may tick the same round.
      // Keep exchange reads and the repeated-flat-position checks about 1s apart.
      if (!force && this.minTickMs && this.now() - (r.tickedAt || 0) < this.minTickMs) return;
      // Back off after definitive errors (e.g. a revoked key) instead of retrying every second.
      if (!force && r.retryAt && this.now() < r.retryAt) return;
      if (this.minTickMs) r.tickedAt = this.now();
      try {
        await this.advance(r);
        if (r.errorCount) { delete r.errorCount; delete r.retryAt; }
      } catch (e) {
        if (e.conflict) return;
        r.error = e.message; r.lastErrorAt = this.now();
        if (e.definitive) {
          r.errorCount = (r.errorCount || 0) + 1;
          r.retryAt = this.now() + Math.min(1000 * 2 ** (r.errorCount - 1), ERROR_RETRY_MAX_MS);
        }
      }
      // Losing this last write to another invocation is harmless: nothing is
      // sent after it, and the winner's state stands.
      try { await this.save(r); } catch (e) { if (!e.conflict) throw e; }
    }, { wait: false });
    return held.acquired;
  }
  async order(r, clientId) { return this.request(`/v1/client/order/${encodeURIComponent(clientId)}`, r.credential); }
  /** The order by client ID, or null when Orderly says it has no such order. Other errors throw. */
  async lookupOrder(r, clientId) {
    try { return await this.order(r, clientId); } catch (error) {
      if (isOrderNotFound(error)) return null;
      throw error;
    }
  }
  /** Has an order with no record on Orderly been missing long enough to count as never received? */
  orderGone(requestedAt, acknowledged) {
    return this.now() - (requestedAt || 0) >= (acknowledged ? ACKED_ORDER_NOT_FOUND_GRACE_MS : ORDER_NOT_FOUND_GRACE_MS);
  }
  async readPosition(r) {
    const position = await this.request(`/v1/position/${r.symbol}?margin_mode=ISOLATED`, r.credential);
    if (position.margin_mode && position.margin_mode !== 'ISOLATED') throw new Error('Position margin mode does not match this round. Inspect it in Portfolio.');
    if (!Number.isFinite(Number(position.position_qty))) throw new Error('Position response is incomplete. Closure has not been confirmed.');
    return position;
  }
  /*
   * Opening. The round's `openAttempts` journal every opening order: post-only
   * quotes q{n} at the top of the book and, after MAKER_WINDOW_MS, a market
   * order m{n} for whatever is left. Exactly one attempt is live at a time, and
   * a new one is only placed once the previous is terminal on Orderly (filled,
   * cancelled, rejected) or abandoned after the not-found grace. Every send and
   * every cancel has its intent saved (compare-and-set, under the round's
   * lease) before the request, so a crash or a concurrent invocation can only
   * ever find the intent and look the order up, never place it twice.
   */
  /** Rounds opened before maker quotes exist have one market attempt under `openClientId`. */
  migrateLegacyOpening(r) {
    if (r.openAttempts) return;
    const requestedAt = r.openRequestedAt ?? r.createdAt;
    r.openAttempts = r.openClientId ? [{
      n: 0, clientId: r.openClientId, type: 'MARKET', quantity: r.quantity, requestedAt, ackAt: r.openAckAt, sendFailedAt: r.openSendFailedAt,
      terminal: false, filled: 0, fillPrice: 0, fee: 0,
    }] : [];
    r.openSeq = r.openAttempts.length;
    if (r.openClientId) r.openStartedAt = requestedAt;
  }
  /** What is still to be opened, snapped to the base tick; 0 once only dust is left. */
  openRemaining(r) {
    const remaining = floorToTick(Number((r.quantity - openFilled(r)).toPrecision(12)), r.baseTick);
    return remaining > r.quantity * FILL_EPSILON ? remaining : 0;
  }
  /** Record an opening order's fills (partial while resting, final once terminal). */
  recordOpenFill(attempt, order) {
    const filled = Number(order.total_executed_quantity ?? order.executed ?? 0);
    if (filled > 0 && (!(Number(order.average_executed_price) > 0) || !Number.isFinite(Number(order.total_fee)))) throw new Error('Opening fill details are incomplete; reconciling before continuing.');
    if (order.margin_mode && order.margin_mode !== 'ISOLATED') throw new Error('Opening order returned an unexpected margin mode. Inspect the position in Portfolio.');
    attempt.filled = filled > 0 ? filled : 0;
    attempt.fillPrice = filled > 0 ? Number(order.average_executed_price) : 0;
    attempt.fee = filled > 0 ? Number(order.total_fee || 0) : 0;
    if (filled > 0) attempt.filledAt = Number(order.updated_time) || attempt.filledAt || this.now();
    if (order.order_id) attempt.orderId = order.order_id;
    attempt.orderStatus = order.status;
  }
  /** The top of the book for this round's quote: the price it rests at, or undefined while the book is unusable (empty or crossed). */
  async quotePrice(r) {
    const top = topOfBook(await this.request(`/v1/orderbook/${encodeURIComponent(r.symbol)}?max_level=1`, r.credential));
    if (!top) return undefined;
    // Snapped away from the spread (a bid down, an ask up), so the snap itself can
    // never cross it: post-only would be refused, or worse, take.
    const price = r.direction === 'UP' ? floorToTick(top.bid, r.quoteTick) : ceilToTick(top.ask, r.quoteTick);
    if (!(price > 0) || (r.direction === 'UP' ? price >= top.ask : price <= top.bid)) return undefined;
    return { ...top, price };
  }
  /** When the maker window started: the first quote, or the opening intent while the book kept no quote from being placed. */
  windowStart(r) { return r.openStartedAt ?? r.openRequestedAt ?? r.createdAt; }
  /**
   * Keep the stored opening attempts bounded: drop the oldest terminal ones that
   * filled nothing. An abandoned quote stays until its cancel is confirmed and it
   * has had its final lookup: it may still turn up, and then it must be found.
   */
  pruneOpenAttempts(r) {
    const cancelConfirmed = a => Boolean(a.cancel?.ackAt || a.cancel?.rejectedAt);
    while (r.openAttempts.length >= MAX_OPEN_ATTEMPTS) {
      let index = r.openAttempts.findIndex(a => a.terminal && !(a.filled > 0) && !a.abandoned);
      if (index < 0) index = r.openAttempts.findIndex(a => a.terminal && !(a.filled > 0) && a.rechecked && cancelConfirmed(a));
      if (index < 0) return;
      r.openAttempts.splice(index, 1);
      r.droppedOpenAttempts = (r.droppedOpenAttempts || 0) + 1;
    }
  }
  /** Save the intent for one more opening order, then send it and record the outcome. */
  async placeOpen(r, type, quantity, price) {
    this.pruneOpenAttempts(r);
    const n = r.openSeq ?? r.openAttempts.length;
    const markets = r.openAttempts.filter(a => a.type === 'MARKET').length;
    const attempt = {
      n, type, quantity, requestedAt: this.now(), terminal: false, filled: 0, fillPrice: 0, fee: 0,
      clientId: type === 'MARKET' ? `${r.orderPrefix}-m${markets ? markets : ''}` : `${r.orderPrefix}-q${n}`,
      ...(type === 'POST_ONLY' ? { price } : {}),
    };
    r.openSeq = n + 1;
    r.openAttempts.push(attempt);
    r.openStartedAt ??= attempt.requestedAt;
    r.fill = fillSummary(r);
    // Intent is durable (compare-and-set against the state this decision was made from) before the send.
    await this.save(r);
    const body = { symbol: r.symbol, order_type: type, side: r.direction === 'UP' ? 'BUY' : 'SELL', order_quantity: quantity, margin_mode: 'ISOLATED', client_order_id: attempt.clientId };
    if (type === 'POST_ONLY') body.order_price = price;
    try {
      const ack = await this.request('/v1/order', r.credential, 'POST', body);
      attempt.ackAt = this.now();
      if (ack?.order_id) attempt.orderId = ack.order_id;
      delete r.error;
    } catch (error) {
      if (error.definitive) {
        // Orderly refused it, so no order exists. A refused quote (e.g. post-only
        // that would have crossed) is simply requoted on the next tick; a refused
        // market order with nothing filled yet fails the round as before.
        Object.assign(attempt, { terminal: true, rejectedAt: this.now(), rejected: error.message });
        if (type === 'MARKET' && openFilled(r) === 0) { r.status = 'failed'; r.error = error.message; delete r.credential; }
        else if (type === 'MARKET') r.error = `Orderly refused the fallback order (${error.message}). Keeping what the quotes filled.`;
        else { r.openRejections = (r.openRejections || 0) + 1; r.error = `Orderly refused the opening quote (${error.message}). Requoting.`; }
      } else {
        // Ambiguous (timeout, network): reconciled by client order ID, never blindly resent.
        attempt.sendFailedAt = this.now();
        r.error = error.message;
      }
    }
    // Record the send outcome. If this write is lost, the next tick still
    // reconciles the order by its client ID.
    await this.save(r);
  }
  /** Send (or resend) the cancel whose intent is already on the attempt. Cancelling is idempotent: it can never add a fill. */
  async sendCancel(r, attempt) {
    const cancel = attempt.cancel;
    try {
      await this.request(`/v1/client/order?client_order_id=${encodeURIComponent(attempt.clientId)}&symbol=${encodeURIComponent(r.symbol)}`, r.credential, 'DELETE');
      cancel.ackAt = this.now(); delete cancel.sendFailedAt; delete cancel.rejectedAt;
    } catch (error) {
      // "Already filled/cancelled" and "not found" are definitive too: the next
      // lookup shows the final state. Anything ambiguous is simply sent again.
      if (error.definitive) { cancel.rejectedAt = this.now(); cancel.rejected = error.message; }
      else cancel.sendFailedAt = this.now();
    }
    cancel.sends = (cancel.sends || 0) + 1;
    cancel.sentAt = this.now();
  }
  /**
   * Cancel a quote Orderly cannot find right now, in case it turns up: the intent
   * is saved, then the cancel sent, and sent again every CANCEL_RESEND_MS while
   * the quote stays unseen. Nothing is sent for a market order (nothing rests).
   */
  async cancelUnseen(r, attempt, reason) {
    if (attempt.type !== 'POST_ONLY') return;
    if (!attempt.cancel) { attempt.cancel = { requestedAt: this.now(), reason }; await this.save(r); }
    const { sentAt } = attempt.cancel;
    if (sentAt == null || this.now() - sentAt >= CANCEL_RESEND_MS) await this.sendCancel(r, attempt);
  }
  /** Why a resting quote should be pulled now, if at all. The book is only read when nothing else decides it. */
  async cancelReason(r, attempt) {
    // A market order never rests: even a player's cancel just waits for its terminal state.
    if (attempt.type === 'MARKET') return undefined;
    if (r.openCancelRequested) return 'player';
    if (this.now() - this.windowStart(r) >= MAKER_WINDOW_MS) return 'fallback';
    const top = topOfBook(await this.request(`/v1/orderbook/${encodeURIComponent(r.symbol)}?max_level=1`, r.credential));
    if (!top) return undefined;
    // The top moved away from our price (someone bid above / offered below us):
    // we are no longer first in line, so requote at the new top.
    const moved = r.direction === 'UP' ? top.bid > attempt.price * (1 + 1e-9) : top.ask < attempt.price * (1 - 1e-9);
    return moved ? 'moved' : undefined;
  }
  /**
   * An opening attempt is not on Orderly past the grace period. Look at the
   * position on this market before deciding: a position matching what the other
   * attempts filled means this one was never received (abandon it; a quote is
   * replaced, a market fallback keeps the fill so far or fails an empty round);
   * a larger position in this round's direction, within its size, means it did
   * execute, so the round adopts it. Anything else is not this round's and is
   * left alone. An attempt a fill was already read from demonstrably reached
   * Orderly: it is never abandoned, only cancelled (idempotently) and polled on.
   */
  async openingMissing(r, attempt) {
    if (attempt.filled > 0) {
      await this.cancelUnseen(r, attempt, 'missing');
      r.error = 'An opening quote that partly filled cannot be found on Orderly right now. Waiting for it to show again.';
      r.fill = fillSummary(r);
      await this.save(r);
      return;
    }
    const position = await this.readPosition(r);
    const qty = Number(position.position_qty);
    // What the OTHER attempts filled: this one's own (zero here) must not be counted against it.
    const already = Number((openFilled(r) - (attempt.filled || 0)).toPrecision(12));
    const sign = r.direction === 'UP' ? 1 : -1;
    const fail = error => { r.status = 'failed'; r.error = error; delete r.credential; };
    if (Math.abs(Math.abs(qty) - already) <= r.quantity * FILL_EPSILON) {
      Object.assign(attempt, { terminal: true, abandoned: true, abandonedAt: this.now(), filled: 0, fillPrice: 0, fee: 0 });
      if (attempt.type === 'POST_ONLY') {
        // Belt and braces: should it arrive late after all, it must not rest. Nothing
        // else is placed until this cancel is confirmed (see recheckAbandonedOpening).
        attempt.cancel = { requestedAt: this.now(), reason: 'abandoned' };
        await this.save(r);
        await this.sendCancel(r, attempt);
        r.error = 'An opening quote never reached Orderly. Quoting again.';
      } else if (already > 0) {
        r.error = 'The fallback opening order never reached Orderly. Keeping what the quotes filled.';
        await this.save(r);
        await this.finishOpening(r);
        return;
      } else {
        fail('The opening order never reached Orderly. No position was opened and nothing was traded.');
      }
    } else if (Math.sign(qty) !== sign || Math.abs(qty) < already || Math.abs(qty) > r.quantity * (1 + FILL_EPSILON)) {
      fail('The opening order never reached Orderly. The position on this market was not opened by this round and was left untouched; manage it in Portfolio.');
    } else {
      // It executed, but its fill cannot be read: the position's average open
      // price stands in, and the result comes from Orderly's position history
      // once the position is closed (see the flat branch of advance).
      Object.assign(attempt, { terminal: true, adopted: true, filled: Number((Math.abs(qty) - already).toPrecision(12)), fillPrice: 0, fee: 0, filledAt: this.now() });
      r.adopted = true; r.adoptedEntryPrice = Number(position.average_open_price) || undefined;
      await this.save(r);
      await this.finishOpening(r);
      return;
    }
    r.fill = fillSummary(r);
    await this.save(r);
  }
  /**
   * Abandoned opening quotes are looked up again before anything else is placed
   * and before the round opens. One that arrived late after all is cancelled
   * while it rests and its fill counts; one still unseen must have its cancel
   * confirmed by Orderly (acknowledged, or refused as unknown) before another
   * order may go out. Returns false while any of them may still rest. With
   * `final`, a quote still unseen gets no further lookups.
   */
  async recheckAbandonedOpening(r, { final = false } = {}) {
    let clear = true;
    for (const attempt of r.openAttempts) {
      if (!attempt.abandoned || attempt.rechecked) continue;
      const order = await this.lookupOrder(r, attempt.clientId);
      if (order) {
        this.recordOpenFill(attempt, order);
        if (attempt.filled > 0) attempt.lateFill = true;
        if (terminal(order.status)) { attempt.rechecked = true; continue; }
        clear = false;
      }
      if (attempt.type !== 'POST_ONLY') { if (!order && final) attempt.rechecked = true; continue; }
      // Resting after all, or its cancel never confirmed: (re)send the cancel and wait.
      const cancel = attempt.cancel ??= { requestedAt: this.now(), reason: 'abandoned' };
      const confirmed = () => Boolean(cancel.ackAt || cancel.rejectedAt);
      if (order || !confirmed()) {
        if (!cancel.ackAt || this.now() - cancel.ackAt >= CANCEL_RESEND_MS) { await this.save(r); await this.sendCancel(r, attempt); }
        if (!confirmed()) clear = false;
      }
      if (!order && final && confirmed()) attempt.rechecked = true;
    }
    return clear;
  }
  /**
   * The opening is over: the round is open on what the attempts filled, with
   * their volume-weighted entry and summed fees. Returns false (round still
   * opening) while an abandoned quote may yet rest; a late fill of one counts.
   */
  async finishOpening(r) {
    if (!(await this.recheckAbandonedOpening(r, { final: true }))) {
      r.error = 'An abandoned opening quote may still rest on Orderly. Confirming its cancel before the round opens.';
      r.fill = fillSummary(r); await this.save(r); return false;
    }
    const fills = r.openAttempts.filter(a => a.filled > 0);
    const quantity = openFilled(r);
    if (!(quantity > 0)) throw new Error('Cannot open a round on no fill.');
    r.quantity = quantity;
    r.openedAt = Math.max(...fills.map(a => a.filledAt || 0)) || this.now();
    if (r.adopted) {
      r.entryPrice = r.adoptedEntryPrice;
      delete r.openFee;
      r.error = "The opening order could not be confirmed, but this round's position is open. It closes on time as usual; its result is confirmed from Orderly afterwards.";
    } else {
      r.entryPrice = fills.reduce((n, a) => n + a.fillPrice * a.filled, 0) / quantity;
      r.openFee = fills.reduce((n, a) => n + (a.fee || 0), 0);
      delete r.error;
    }
    // An adopted fill's time is unknown: its clock runs from the first opening intent instead.
    r.deadline = (r.adopted ? (r.openStartedAt ?? r.openRequestedAt ?? r.createdAt) : r.openedAt) + r.duration * 1000;
    r.status = 'open';
    r.fill = fillSummary(r);
    // A player who cancelled while opening wants out: close what filled straight away.
    if (r.openCancelRequested) { r.closeNow = true; r.cancelledOpening = true; }
    await this.save(r);
    return true;
  }
  /** One step of the opening: reconcile the live attempt, pull it if the top moved or time is up, place the next order. */
  async advanceOpening(r) {
    this.migrateLegacyOpening(r);
    const pending = r.openAttempts.find(a => !a.terminal);
    if (pending) {
      const order = await this.lookupOrder(r, pending.clientId);
      if (!order) {
        // Not on Orderly (yet): wait out the grace, then decide by the position.
        if (this.orderGone(pending.requestedAt, pending.ackAt)) { await this.openingMissing(r, pending); return; }
        // Meanwhile a quote the player cancelled, or whose window is over, is
        // cancelled anyway (idempotent, in case it turns up) and still polled.
        if (pending.type === 'POST_ONLY' && (r.openCancelRequested || this.now() - this.windowStart(r) >= MAKER_WINDOW_MS)) {
          await this.cancelUnseen(r, pending, r.openCancelRequested ? 'player' : 'fallback');
          r.error = CONFIRMING_QUOTE_MESSAGE;
          await this.save(r);
        }
        return;
      }
      this.recordOpenFill(pending, order);
      if (!terminal(order.status)) {
        // Resting. A cancel already on record may not have been sent (crash
        // between intent and send) or may not have landed: send it again.
        if (pending.cancel) {
          if (!pending.cancel.ackAt || this.now() - pending.cancel.ackAt >= CANCEL_RESEND_MS) await this.sendCancel(r, pending);
          r.fill = fillSummary(r); await this.save(r); return;
        }
        const reason = await this.cancelReason(r, pending);
        r.fill = fillSummary(r);
        if (!reason) { await this.save(r); return; }
        pending.cancel = { requestedAt: this.now(), reason };
        await this.save(r);
        await this.sendCancel(r, pending);
        await this.save(r);
        return;
      }
      pending.terminal = true; pending.terminalAt = this.now();
      r.fill = fillSummary(r);
      await this.save(r);
    }
    // No live attempt. An abandoned quote must be confirmed gone (or its late
    // fill counted) before anything else is decided or placed.
    if (!(await this.recheckAbandonedOpening(r))) {
      r.error = 'An abandoned opening quote may still rest on Orderly. Confirming its cancel before quoting again.';
      r.fill = fillSummary(r); await this.save(r); return;
    }
    // Decide what is next from what is filled.
    const filled = openFilled(r), remaining = this.openRemaining(r);
    const last = r.openAttempts.at(-1);
    if (remaining === 0 || (filled > 0 && (r.openCancelRequested || last?.type === 'MARKET'))) { await this.finishOpening(r); return; }
    if (filled === 0 && r.openCancelRequested) {
      r.status = 'failed'; r.error = 'Cancelled before fill'; r.fill = fillSummary(r); delete r.credential; await this.save(r); return;
    }
    if (filled === 0 && last?.type === 'MARKET') {
      r.status = 'failed'; r.error = 'The opening order did not fill.'; r.fill = fillSummary(r); delete r.credential; await this.save(r); return;
    }
    if (this.now() - this.windowStart(r) >= MAKER_WINDOW_MS) {
      // The window ran out without a single quote because the book was unusable:
      // a market order must not go into such a book either, so the round fails.
      if (!r.openAttempts.length && !(await this.quotePrice(r))) {
        r.status = 'failed'; r.error = 'No usable order book. Nothing was traded.'; r.fill = fillSummary(r); delete r.credential; await this.save(r); return;
      }
      await this.placeOpen(r, 'MARKET', remaining); return;
    }
    if (!this.maker) { await this.placeOpen(r, 'MARKET', remaining); return; }
    const quote = await this.quotePrice(r);
    if (!quote) { r.error = 'The order book is unavailable; quoting again shortly.'; await this.save(r); return; }
    await this.placeOpen(r, 'POST_ONLY', remaining, quote.price);
  }
  /** Record a terminal close order's fills on its attempt. */
  recordCloseFill(attempt, order) {
    const closeQuantity = Number(order.total_executed_quantity ?? order.executed ?? 0);
    if (closeQuantity > 0 && (!(Number(order.average_executed_price) > 0) || !Number.isFinite(Number(order.total_fee)))) throw new Error('Closing fill details are incomplete; reconciling before reporting the result.');
    attempt.terminal = true;
    attempt.quantity = closeQuantity;
    attempt.price = Number(order.average_executed_price || 0);
    attempt.fee = Number(order.total_fee || 0);
  }
  /**
   * A close attempt Orderly never received is finished with nothing filled. The
   * next attempt is reduce-only like every close, so even if this one arrives
   * late it can only reduce the position, never grow or flip it.
   */
  abandonClose(attempt) {
    Object.assign(attempt, { terminal: true, quantity: 0, price: 0, fee: 0, abandoned: true, abandonedAt: this.now() });
  }
  /**
   * Before reporting a result, look up abandoned attempts once more: one that
   * did arrive late counts with its real fill. Returns false while one is live.
   */
  async recheckAbandoned(r) {
    for (const attempt of r.closeAttempts) {
      if (!attempt.abandoned || attempt.rechecked) continue;
      const order = await this.lookupOrder(r, attempt.clientId);
      if (order && !terminal(order.status)) return false;
      if (order) { this.recordCloseFill(attempt, order); if (attempt.quantity > 0) attempt.lateFill = true; }
      attempt.rechecked = true;
    }
    return true;
  }
  /** Keep the stored attempts bounded: drop the oldest ones that filled nothing. */
  pruneCloseAttempts(r) {
    while (r.closeAttempts.length >= MAX_CLOSE_ATTEMPTS) {
      let index = r.closeAttempts.findIndex(c => c.terminal && !(c.quantity > 0) && (!c.abandoned || c.rechecked));
      if (index < 0) index = r.closeAttempts.findIndex(c => c.terminal && !(c.quantity > 0));
      if (index < 0) return;
      r.closeAttempts.splice(index, 1);
      r.droppedCloseAttempts = (r.droppedCloseAttempts || 0) + 1;
    }
  }
  async recoverResult(id, input) {
    const found = await this.store.get(id);
    const accountId = normalizeAccountId(input?.accountId);
    if (!found || found.network !== this.network || normalizeAccountId(found.accountId) !== accountId || typeof input?.secretKey !== 'string' || !input.secretKey) throw new Error('Connect the account that played this round.');
    const credential = { accountId, secretKey: input.secretKey };
    const info = await this.request('/v1/client/info', credential);
    if (normalizeAccountId(info.account_id) !== accountId) throw new Error('Account authorization does not match this round.');
    const { value } = await this.store.withLock([`round:${id}`], async () => {
      const r = await this.store.get(id);
      // A cancelled opening already carries its confirmed result.
      if (r.status !== 'ended_early' || r.resultPending === false) return publicRound(r);
      const data = await this.request(`/v1/position_history?symbol=${encodeURIComponent(r.symbol)}&limit=1000`, credential);
      // Keep a small source record for reconciliation/support, never the key.
      r.resultHistory = data.rows?.filter(p => p.symbol === r.symbol && Math.abs(Number(p.open_timestamp) - r.openedAt) < 5000).slice(0, 3);
      const result = positionResult(r, data.rows);
      if (result) { Object.assign(r, result); delete r.credential; delete r.resultHistory; }
      await this.save(r); return publicRound(r);
    }, { wait: true });
    return value;
  }
  async reconcileResult(r) {
    if (!r.credential || this.now() < (r.nextResultCheckAt || 0)) return;
    r.nextResultCheckAt = this.now() + 10000;
    const data = await this.request(`/v1/position_history?symbol=${encodeURIComponent(r.symbol)}&limit=1000`, r.credential);
    const result = positionResult(r, data.rows);
    if (result) {
      // An adopted round that its own reduce-only closes flattened was not closed "externally".
      if (r.adopted && closedQuantity(r) >= r.quantity * (1 - 1e-8)) delete result.closeReason;
      Object.assign(r, result); delete r.credential; delete r.nextResultCheckAt;
    }
    await this.save(r);
  }
  async advance(r) {
    if (r.status === 'ended_early' && r.resultPending) { await this.reconcileResult(r); return; }
    if (r.status === 'preparing') {
      // The starter holds this round's lock until the opening intent is durable,
      // so a 'preparing' row seen here was abandoned: no order could have been sent.
      r.status = 'failed'; r.error = 'Worker restarted before the opening order was submitted.'; delete r.credential; await this.save(r); return;
    }
    if (r.status === 'opening') {
      await this.advanceOpening(r);
      if (r.status !== 'open') return;
    }
    if (!['open', 'closing'].includes(r.status)) return;
    const position = await this.readPosition(r);
    const remaining = Math.abs(Number(position.position_qty));
    r.positionQuantity = remaining;
    const liquidationPrice = Number(position.est_liq_price ?? position.liq_price);
    if (remaining > 0 && Number.isFinite(liquidationPrice) && liquidationPrice > 0) r.liquidationPrice = liquidationPrice;
    r.markPrice = Number(position.mark_price) || null;
    const pendingClose = r.closeAttempts.find(c => !c.terminal);
    let pendingMissing = false;
    if (pendingClose) {
      const order = await this.lookupOrder(r, pendingClose.clientId);
      if (order && terminal(order.status)) {
        this.recordCloseFill(pendingClose, order);
        await this.save(r);
        // Read the position again on the next tick after reconciling a close.
        return;
      }
      pendingMissing = !order;
      if (remaining > 0) {
        // Still live on Orderly, or not there yet: wait for it.
        if (!pendingMissing || !this.orderGone(pendingClose.requestedAt, pendingClose.ackAt)) return;
        // Never received: finish it with nothing filled; the next tick sends c{n+1}.
        this.abandonClose(pendingClose);
        r.error = 'A closing order never reached Orderly. Sending another reduce-only close.';
        await this.save(r);
        return;
      }
      // Flat while an attempt is unresolved: fall through, so a position closed
      // elsewhere (or by a late fill) is still detected and the round finalised.
    }
    if (remaining === 0) {
      // Position feeds may lag order fills. Require repeated flat snapshots.
      r.flatChecks = (r.flatChecks || 0) + 1;
      if (r.flatChecks < 3 || this.now() - r.openedAt < 3000) { await this.save(r); return; }
      if (pendingClose) {
        // A live order on a flat position finishes (reduce-only) momentarily; one
        // Orderly never received is given its grace period, then abandoned.
        if (!pendingMissing || !this.orderGone(pendingClose.requestedAt, pendingClose.ackAt)) { await this.save(r); return; }
        this.abandonClose(pendingClose);
        pendingClose.rechecked = true;
      }
      if (!(await this.recheckAbandoned(r))) { await this.save(r); return; }
      const closedQty = closedQuantity(r);
      // An adopted round's opening fill is unknown, so its result always comes from position history.
      const complete = !r.adopted && closedQty >= r.quantity * (1 - 1e-8);
      // A round the player cancelled while it was opening ends early with the
      // result of the part that had filled; its result is as final as a close.
      r.status = complete ? (r.cancelledOpening ? 'ended_early' : 'closed') : 'ended_early';
      r.closedAt = this.now();
      if (complete) {
        r.exitPrice = r.closeAttempts.reduce((n, c) => n + c.price * c.quantity, 0) / closedQty;
        r.fees = r.openFee + r.closeAttempts.reduce((n, c) => n + c.fee, 0);
        r.tradingPnl = (r.exitPrice - r.entryPrice) * r.quantity * (r.direction === 'UP' ? 1 : -1) - r.fees;
        if (r.cancelledOpening) { r.closeReason = 'cancelled'; r.resultPending = false; }
        delete r.error; delete r.closeRetryAt; delete r.closeFailures;
        delete r.credential; await this.save(r); return;
      }
      r.resultPending = true;
      r.error = 'The position has closed. Confirming its final result.';
      await this.save(r);
      await this.reconcileResult(r);
      return;
    }
    r.flatChecks = 0;
    if (Math.sign(Number(position.position_qty)) !== (r.direction === 'UP' ? 1 : -1) || remaining > r.quantity * (1 + 1e-8)) {
      throw new Error('Position changed outside this round. Automatic closing paused; manage it in Portfolio.');
    }
    if (this.now() < r.deadline && !r.closeNow) { await this.save(r); return; }
    r.status = 'closing';
    // After a definitive rejection, wait out the backoff before the next attempt.
    if (r.closeRetryAt && this.now() < r.closeRetryAt) { await this.save(r); return; }
    this.pruneCloseAttempts(r);
    const seq = r.closeSeq ?? r.closeAttempts.length;
    const close = { clientId: `${r.orderPrefix}-c${seq}`, requestedAt: this.now(), terminal: false };
    r.closeSeq = seq + 1;
    // Closing intent is durable (and, in Postgres, compare-and-set against the
    // version this decision was made from) before the order is sent.
    r.closeAttempts.push(close); await this.save(r);
    try {
      await this.request('/v1/order', r.credential, 'POST', { symbol: r.symbol, order_type: 'MARKET', side: r.direction === 'UP' ? 'SELL' : 'BUY', order_quantity: remaining, reduce_only: true, margin_mode: 'ISOLATED', client_order_id: close.clientId });
      close.ackAt = this.now();
      delete r.error; delete r.closeRetryAt; delete r.closeFailures;
    } catch (e) {
      if (e.definitive) {
        // Orderly refused it, so no order exists. Retry with exponential backoff
        // and say so plainly; a revoked key or a frozen account needs the player.
        Object.assign(close, { terminal: true, quantity: 0, price: 0, fee: 0, rejectedAt: this.now() });
        r.closeFailures = (r.closeFailures || 0) + 1;
        const wait = Math.min(CLOSE_RETRY_BASE_MS * 2 ** (r.closeFailures - 1), CLOSE_RETRY_MAX_MS);
        r.closeRetryAt = this.now() + wait;
        r.error = `Orderly rejected the closing order (${e.message}). Retrying in ${Math.ceil(wait / 1000)}s. If this continues, close the position in Portfolio.`;
      } else {
        // Ambiguous (timeout, network): reconciled by client order ID, never blindly resent.
        Object.assign(close, { sendFailedAt: this.now() });
        r.error = e.message;
      }
    }
    await this.save(r);
  }
  /** Request an early close, then advance the round straight away. */
  async close(id, accountId) {
    const mark = async () => {
      const r = await this.store.get(id);
      if (!r || r.network !== this.network || !isActive(r) || (accountId !== undefined && normalizeAccountId(r.accountId) !== normalizeAccountId(accountId))) throw new Error('No active round found.');
      // The player asking again also skips a rejection backoff (one attempt per request).
      if (!r.closeNow || r.closeRetryAt) { r.closeNow = true; delete r.closeRetryAt; await this.save(r); }
      return publicRound(r);
    };
    // Never wait for a busy round: recording closeNow sends nothing, so it may
    // be written without the lease (compare-and-set, retried on a lost race).
    // Whoever holds the round, or the next sweep, then closes it.
    const held = await this.store.withLock([`round:${id}`], mark, { wait: false });
    let value = held.value;
    if (!held.acquired) {
      for (let attempt = 0; ; attempt++) {
        try { value = await mark(); break; } catch (error) { if (!error.conflict || attempt >= 4) throw error; }
      }
    }
    await this.tickRound(id, { force: true }).catch(() => {});
    const r = await this.store.get(id);
    return r ? publicRound(r) : value;
  }
  /**
   * The player cancels a round that is still opening. Recorded without waiting
   * for a busy round (compare-and-set, no order), then advanced at once: the
   * resting quote is cancelled and confirmed; anything it filled is closed
   * reduce-only and the round ends early with that result; nothing filled fails
   * the round ("Cancelled before fill").
   */
  async cancelOpening(id, accountId) {
    const mark = async () => {
      const r = await this.store.get(id);
      if (!r || r.network !== this.network || !isActive(r) || (accountId !== undefined && normalizeAccountId(r.accountId) !== normalizeAccountId(accountId))) throw new Error('No active round found.');
      if (r.status !== 'opening') throw new Error('Only a round that is still opening can be cancelled. Use Close round early once it is open.');
      if (!r.openCancelRequested) { r.openCancelRequested = true; r.openCancelRequestedAt = this.now(); await this.save(r); }
      return publicRound(r);
    };
    const held = await this.store.withLock([`round:${id}`], mark, { wait: false });
    let value = held.value;
    if (!held.acquired) {
      for (let attempt = 0; ; attempt++) {
        try { value = await mark(); break; } catch (error) { if (!error.conflict || attempt >= 4) throw error; }
      }
    }
    await this.tickRound(id, { force: true }).catch(() => {});
    const r = await this.store.get(id);
    return r ? publicRound(r) : value;
  }
  async extend(id, input) {
    if (!input || !/^[a-zA-Z0-9_-]{8,48}$/.test(input.id || '') || !ROUND_DURATIONS.includes(input.seconds) || typeof input.secretKey !== 'string' || !input.secretKey) throw new Error('Invalid extension settings or missing account authorization.');
    const found = await this.store.get(id);
    const accountId = normalizeAccountId(input.accountId);
    if (!found || found.network !== this.network || normalizeAccountId(found.accountId) !== accountId) throw new Error('This round does not belong to the connected account.');
    const previous = (found.extensions || []).find(extension => extension.id === input.id);
    if (previous && previous.seconds !== input.seconds) throw new Error('This extension ID was used with a different duration.');
    const validate = r => {
      const remaining = r.deadline - this.now();
      if (r.status !== 'open' || r.closeNow || r.closeAttempts.length || !(r.positionQuantity > 0) || !Number.isFinite(remaining) || remaining <= 0) throw new Error('This round is already closing or has expired. Its time cannot be extended.');
      // Available for the whole round, not only in the last minute; the total length is capped instead.
      if (r.duration + input.seconds > MAX_ROUND_DURATION) throw new Error(`A round can run for at most ${MAX_ROUND_DURATION / 3600} hours in total, including added time.`);
    };
    if (!previous) validate(found);
    const credential = { accountId, secretKey: input.secretKey };
    const key = orderlyKeyPair(input.secretKey).publicKey;
    const [info, keyInfo] = await Promise.all([
      this.request('/v1/client/info', credential),
      this.request(`/v1/get_orderly_key?account_id=${encodeURIComponent(accountId)}&orderly_key=${encodeURIComponent(key)}`),
    ]);
    // /client/info authenticates the supplied key and returns account_id, but
    // its documented/live response does not include broker_id. Require the
    // authenticated account to match; reject a broker mismatch only if supplied.
    if (normalizeAccountId(info.account_id) !== accountId || (info.broker_id != null && info.broker_id !== this.brokerId)) throw new Error('Account authorization does not match this round.');
    const scopes = String(keyInfo.scope || '').split(',').map(scope => scope.trim());
    if (keyInfo.orderly_key !== key || (keyInfo.key_status && keyInfo.key_status !== 'ACTIVE') || !scopes.includes('read') || !scopes.includes('trading') || scopes.some(scope => !['read', 'trading'].includes(scope))) throw new Error('Authorize a dedicated read and trading key to increase time.');
    // Authentication stays outside the scheduler lock: a slow verification must
    // never postpone an already due close. Reload and recheck all state under the lock.
    const { value } = await this.store.withLock([`round:${id}`], async () => {
      const r = await this.store.get(id);
      const accepted = (r.extensions || []).find(extension => extension.id === input.id);
      if (accepted) {
        if (accepted.seconds !== input.seconds) throw new Error('This extension ID was used with a different duration.');
        return publicRound(r);
      }
      validate(r);
      const deadline = r.deadline + input.seconds * 1000;
      if (!Number.isSafeInteger(deadline) || !Number.isFinite(Number(keyInfo.expiration)) || Number(keyInfo.expiration) <= deadline + 60000) throw new Error('Renew round authorization before increasing time; this key expires too soon.');
      const old = { deadline: r.deadline, duration: r.duration, credential: r.credential, extensions: r.extensions, keyExpiration: r.keyExpiration };
      r.deadline = deadline; r.duration += input.seconds;
      r.credential = credential; r.keyExpiration = Number(keyInfo.expiration);
      r.extensions = [...(r.extensions || []), { id: input.id, seconds: input.seconds, acceptedAt: this.now(), deadline }];
      try { await this.save(r); } catch (error) { Object.assign(r, old); throw error; }
      return publicRound(r);
    }, { wait: true });
    return value;
  }
}
