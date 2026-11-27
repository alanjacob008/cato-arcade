import { Market, sizedLeverage } from './api';

/** Quick stakes as a share of the player's usable balance (the slider's range). */
export const STAKE_PERCENTS = [10, 25, 50, 75, 100] as const;

// Orderly perp SDK isolatedMarginRate/maxQtyForIsolatedMargin reserve a fixed
// 6 bps and apply a 0.995 capacity factor, independent of broker trading fees.
const ISOLATED_FROZEN_BUFFER = .0006;
const CAPACITY_SAFETY_FACTOR = .995;
// Local execution policy, not a fee: observed mainnet isolated openings reserved
// 1.10x base margin (allocated isolated margin + opening fee). The SDK's 6 bps
// formula alone underestimates that allocation at 100x. Keep this reserve floor
// alongside live prices/account constraints; it does not change reported PnL.
const MINIMUM_MARGIN_RESERVE = .10;

export type AmountContext = {
  market?: Market;
  price?: number;
  freeCollateral?: number;
  feeRate: number;
  leverageOverride: number | null;
  accountReady: boolean;
  pricingReady?: boolean;
  orderReferencePrice?: number;
  accountMaxNotional?: number;
};

/** Isolated orders must be funded with USDC, not other collateral/cross gains. */
export function isolatedAvailableBalance(freeCollateral: number | undefined, usdcOnly: number | undefined, usdcHolding: number | undefined) {
  return [freeCollateral, usdcOnly, usdcHolding].every(value => Number.isFinite(value))
    ? Math.max(0, Math.min(freeCollateral!, usdcOnly!, usdcHolding!)) : undefined;
}

function reservedBalancePerMargin(context: AmountContext, leverage: number) {
  const referenceRatio = Math.max(context.price!, context.orderReferencePrice ?? context.price!) / context.price!;
  const reserve = Math.max(MINIMUM_MARGIN_RESERVE, leverage * Math.max(ISOLATED_FROZEN_BUFFER, context.feeRate * 2));
  return referenceRatio * (1 + reserve) / CAPACITY_SAFETY_FACTOR;
}

export function amountQuote(amount: number, context: AmountContext) {
  const { market, price, freeCollateral, feeRate, leverageOverride, accountReady } = context;
  const maxLeverage = sizedLeverage(market, amount);
  const leverage = Math.min(leverageOverride ?? maxLeverage, maxLeverage);
  const ready = accountReady && context.pricingReady !== false && Number.isFinite(freeCollateral) && freeCollateral! >= 0
    && Number.isFinite(feeRate) && feeRate >= 0 && Number.isFinite(price) && price! > 0
    && !!market && Number.isFinite(market.base_tick) && market.base_tick > 0
    && Number.isFinite(market.base_min) && market.base_min >= 0
    && Number.isFinite(market.min_notional) && market.min_notional >= 0
    && Number.isFinite(market.maxLeverage) && market.maxLeverage >= 1
    && (context.orderReferencePrice == null || (Number.isFinite(context.orderReferencePrice) && context.orderReferencePrice > 0))
    && (context.accountMaxNotional == null || (Number.isFinite(context.accountMaxNotional) && context.accountMaxNotional >= 0))
    && Number.isFinite(leverage) && leverage >= 1 && Number.isInteger(leverage);
  const validAmount = Number.isFinite(amount) && amount > 0;
  const notional = validAmount ? amount * leverage : 0;
  // Mirror the worker's base-tick rounding before checking order-size limits.
  const quantity = ready && validAmount
    ? Number((Math.floor(notional / price! / market!.base_tick) * market!.base_tick).toPrecision(12)) : 0;
  const requiredBalance = amount * reservedBalancePerMargin(context, leverage);
  const enoughSize = ready && validAmount && quantity > 0 && quantity >= market!.base_min
    && quantity * price! >= market!.min_notional;
  const withinMaxSize = ready && (market!.base_max == null || (Number.isFinite(market!.base_max) && quantity <= market!.base_max!))
    && (context.accountMaxNotional == null || notional * Math.max(price!, context.orderReferencePrice ?? price!) / price! <= context.accountMaxNotional);
  const withinBalance = ready && validAmount && requiredBalance <= freeCollateral!;
  return { ready, maxLeverage, leverage, notional, quantity, requiredBalance, enoughSize, withinMaxSize, withinBalance,
    affordable: Boolean(enoughSize && withinMaxSize && withinBalance) };
}

/** A share of the usable balance, in cents, never above the maximum itself. */
export function percentAmount(context: AmountContext, percent: number) {
  const maximum = maximumAmount(context);
  return percent >= 100 ? maximum : Math.floor(Math.round(maximum * 100) * percent / 100) / 100;
}

/** Smallest cent-denominated stake whose order meets the market's size minimums (0 when nothing is playable). */
export function minimumAmount(context: AmountContext): number {
  if (!amountQuote(.01, context).ready || !context.market || !context.price) return 0;
  const { market, price } = context;
  const leverage = sizedLeverage(market, .01);
  const notional = Math.max(market.base_min * price, market.min_notional, market.base_tick * price);
  let cents = Math.max(1, Math.floor(notional / leverage * 100));
  // Tick rounding can push the first guess under the minimum: walk up to the first amount that passes.
  for (let step = 0; step < 1000; step++, cents++) {
    const quote = amountQuote(cents / 100, context);
    if (quote.enoughSize) return cents / 100;
    if (!quote.withinMaxSize) break;
  }
  return 0;
}

/** Largest cent-denominated amount that passes the same checks as a manual entry.
 * Leverage drops at size thresholds, so affordability is not globally monotonic.
 * Evaluate the upper bound of each integer leverage tier instead of binary search.
 */
export function maximumAmount(context: AmountContext): number {
  if (!amountQuote(.01, context).ready || !context.freeCollateral || !context.market) return 0;
  const { market, freeCollateral } = context;
  const highestLeverage = Math.floor(Math.min(context.leverageOverride ?? market.maxLeverage, market.maxLeverage));
  let result = 0;
  for (let leverage = 1; leverage <= highestLeverage; leverage++) {
    let limit = freeCollateral / reservedBalancePerMargin(context, leverage);
    if (context.accountMaxNotional != null) {
      const referenceRatio = Math.max(context.price!, context.orderReferencePrice ?? context.price!) / context.price!;
      limit = Math.min(limit, context.accountMaxNotional / referenceRatio / leverage);
    }
    // At 1x the SDK clamps the dynamic leverage floor, so there is no size bound.
    if (leverage > 1 && market.imr_factor > 0) {
      limit = Math.min(limit, Math.pow(1 / (market.imr_factor * Math.pow(leverage, 1.8)), 1.25));
    }
    let cents = Math.floor(limit * 100);
    if (market.base_max != null) {
      // A raw quantity just below the next tick still rounds down to base_max.
      const maxTicks = Math.floor(market.base_max / market.base_tick + 1e-9);
      const exclusiveLimit = (maxTicks + 1) * market.base_tick * context.price! / leverage;
      cents = Math.min(cents, Math.ceil(exclusiveLimit * 100) - 1);
    }
    // Floating point at a boundary can round upward: use the actual predicate.
    for (let step = 0; step < 3 && cents > 0; step++, cents--) {
      const candidate = cents / 100;
      if (candidate <= result) break;
      if (amountQuote(candidate, context).affordable) { result = candidate; break; }
    }
  }
  return result;
}
