import type { Round } from './api';

/** The confirmed result of a finished round: a close, or a cancelled opening whose filled part was closed (its result is already final). */
export const finalResult = (round: Round) => round.status === 'closed' || (round.status === 'ended_early' && round.resultPending === false) ? round.netPnl ?? round.tradingPnl : undefined;

/** Mark-based estimate, including confirmed partial closes. Funding is separate. */
export function roundPnl(round: Round, mark: number | undefined, feeRate: number) {
  const entry = round.entryPrice;
  if (!entry || !mark || !Number.isFinite(mark) || !Number.isFinite(feeRate) || !(round.quantity > 0)) return undefined;
  const sign = round.direction === 'UP' ? 1 : -1;
  const fills = (round.closeAttempts || []).filter(c => c.terminal && (c.quantity || 0) > 0);
  const closedQuantity = fills.reduce((sum, c) => sum + c.quantity!, 0);
  const remaining = Math.max(0, round.quantity - closedQuantity);
  // A position snapshot can precede its closing fill report. Wait for reconciliation.
  if (round.positionQuantity != null && Math.abs(round.positionQuantity - remaining) > round.quantity * 1e-8) return undefined;
  const realized = fills.reduce((sum, c) => sum + (c.price! - entry) * c.quantity! * sign, 0);
  const gross = realized + (mark - entry) * remaining * sign;
  const paidFees = (round.openFee ?? entry * round.quantity * feeRate) + fills.reduce((sum, c) => sum + (c.fee || 0), 0);
  const exitFee = mark * remaining * feeRate;
  const net = gross - paidFees - exitFee;
  const breakEven = remaining > 0 ? (entry * remaining * sign + paidFees - realized) / (remaining * (sign - feeRate)) : undefined;
  return { gross, paidFees, exitFee, net, breakEven, returnPercent: net / round.margin * 100 };
}

export function roundResult(round: Round) {
  if (round.status !== 'closed' || round.entryPrice == null || round.exitPrice == null || round.tradingPnl == null || round.fees == null) return undefined;
  const move = round.exitPrice - round.entryPrice;
  const gross = move * round.quantity * (round.direction === 'UP' ? 1 : -1);
  return { move, percent: move / round.entryPrice * 100, gross, correct: gross > 0, feesErasedGain: gross > 0 && round.tradingPnl < 0 };
}
