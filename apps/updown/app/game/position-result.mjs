const finite = value => value != null && value !== '' && Number.isFinite(Number(value));
const near = (a, b, tolerance) => finite(a) && finite(b) && Math.abs(Number(a) - Number(b)) <= tolerance;

/** Match a fully closed isolated position to this one-entry round, never just a ticker. */
export function positionResult(round, rows) {
  if (!round.openedAt || !(round.quantity > 0) || !(round.entryPrice > 0) || !Array.isArray(rows)) return;
  const matches = rows.filter(p =>
    p.symbol === round.symbol && (p.margin_mode === 'ISOLATED' || p.margin_mode === 1) &&
    String(p.position_status ?? p.status).toLowerCase() === 'closed' &&
    p.side === (round.direction === 'UP' ? 'LONG' : 'SHORT') &&
    // The history starts at the first entry fill; openedAt is the last entry fill.
    Number(p.open_timestamp) >= Number(round.openRequestedAt ?? round.createdAt) - 1000 &&
    Number(p.open_timestamp) <= round.openedAt + 1000 &&
    Number(p.close_timestamp) >= round.openedAt &&
    (!round.closedAt || Number(p.close_timestamp) <= round.closedAt + 1000) &&
    near(Math.abs(Number(p.max_position_qty)), round.quantity, round.quantity * 1e-7) &&
    near(Math.abs(Number(p.closed_position_qty)), round.quantity, round.quantity * 1e-7) &&
    near(p.avg_open_price, round.entryPrice, Math.max(1e-7, round.entryPrice * 1e-7))
  );
  if (matches.length !== 1) return;
  const p = matches[0];
  if (![p.avg_close_price, p.realized_pnl, p.trading_fee, p.accumulated_funding_fee].every(finite) || Number(p.avg_close_price) <= 0) return;
  // Use the SDK's position-history net-PnL formula. Liquidation deductions are
  // already reflected in realized_pnl; don't subtract their breakdown twice.
  const tradingPnl = Number(p.realized_pnl) - Number(p.trading_fee);
  return {
    status: 'closed', closeReason: p.type === 'liquidated' ? 'liquidation' : 'external',
    positionHistoryId: p.position_id, liquidationId: p.liquidation_id ?? undefined,
    exitPrice: Number(p.avg_close_price), closedAt: Number(p.close_timestamp),
    fees: Number(p.trading_fee), fundingFee: Number(p.accumulated_funding_fee),
    tradingPnl, netPnl: tradingPnl - Number(p.accumulated_funding_fee),
    resultSource: 'position_history', resultPending: false, error: undefined,
  };
}
