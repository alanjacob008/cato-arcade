import { orderlyKeyPair } from './keys.mjs';

export class OrderlyError extends Error {
  /** @param {string} message @param {boolean} [definitive] @param {number} [code] Orderly's error code */
  constructor(message, definitive = false, code = undefined) { super(message); this.definitive = definitive; this.code = code; }
}

// Orderly answers a lookup of an order it has no record of with code -1006
// ("data not found", HTTP 400); some endpoints use -1000 "data does not exist".
export const ORDERLY_NOT_FOUND = -1006;

/** True only when Orderly itself says the requested order does not exist (never for transport errors). */
export function isOrderNotFound(error) {
  if (!(error instanceof OrderlyError)) return false;
  return error.code === ORDERLY_NOT_FOUND || (error.code === -1000 && /does not exist|not found/i.test(error.message || ''));
}

export function createOrderly(baseUrl) {
  return async function request(path, credential, method = 'GET', body) {
    const payload = body ? JSON.stringify(body) : '';
    // Orderly's DELETE endpoints (order cancels, query-string parameters) refuse
    // JSON ("Content type 'application/json' not supported") and an empty type;
    // they expect form encoding. JSON only goes with a JSON body.
    const headers = body ? { 'Content-Type': 'application/json' } : method === 'DELETE' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {};
    if (credential) {
      const key = orderlyKeyPair(credential.secretKey);
      const timestamp = String(Date.now());
      headers['orderly-account-id'] = credential.accountId;
      headers['orderly-key'] = key.publicKey;
      headers['orderly-timestamp'] = timestamp;
      headers['orderly-signature'] = Buffer.from(key.sign(timestamp + method + path + payload)).toString('base64url');
    }
    const response = await fetch(baseUrl + path, { method, headers, ...(body ? { body: payload } : {}), signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (!response.ok || !data.success) {
      // A transport error or 5xx is ambiguous: an order might have been accepted.
      throw new OrderlyError(data.message || 'Orderly request failed', response.status < 500 && response.status !== 429 && response.status !== 408, data.code);
    }
    return data.data;
  };
}

export function maxLeverage(market, margin = 0, cap = 100) {
  const base = 1 / Number(market.base_imr);
  const factor = Number(market.imr_factor);
  const sized = margin > 0 && factor > 0 ? Math.pow(1 / (factor * Math.pow(margin, .8)), 1 / 1.8) : base;
  return Math.max(1, Math.floor(Math.min(base, sized, cap)));
}

/** Snap a price to the market's quote tick (`quote_tick` from /v1/public/info); unchanged without a usable tick. */
export function roundToTick(price, tick) {
  const step = Number(tick);
  if (!(step > 0) || !Number.isFinite(price)) return price;
  return Number((Math.round(price / step) * step).toPrecision(12));
}

/** Snap a quantity (or a bid) down to the market's tick; unchanged without a usable tick. */
export function floorToTick(quantity, tick) {
  const step = Number(tick);
  if (!(step > 0) || !Number.isFinite(quantity)) return quantity;
  return Number((Math.floor(quantity / step + 1e-9) * step).toPrecision(12));
}

/** Snap a price (an ask) up to the market's tick; unchanged without a usable tick. */
export function ceilToTick(price, tick) {
  const step = Number(tick);
  if (!(step > 0) || !Number.isFinite(price)) return price;
  return Number((Math.ceil(price / step - 1e-9) * step).toPrecision(12));
}

/**
 * Best bid and ask of an orderbook snapshot (GET /v1/orderbook/{symbol}?max_level=1,
 * levels as { price, quantity } objects or [price, quantity] pairs). Undefined
 * while the book is empty or crossed, so a quote is never placed into a bad book.
 */
export function topOfBook(book) {
  const level = rows => { const row = rows?.[0]; const price = Number(Array.isArray(row) ? row[0] : row?.price); return price > 0 ? price : undefined; };
  const bid = level(book?.bids), ask = level(book?.asks);
  if (!bid || !ask || bid >= ask) return undefined;
  return { bid, ask };
}

export function orderQuantity(margin, leverage, price, market) {
  const tick = Number(market.base_tick);
  const quantity = Number((Math.floor(margin * leverage / price / tick) * tick).toPrecision(12));
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity < Number(market.base_min) || quantity > Number(market.base_max) || quantity * price < Number(market.min_notional)) {
    throw new Error('Amount does not meet this market’s order-size limits. Adjust the amount or leverage.');
  }
  return quantity;
}
