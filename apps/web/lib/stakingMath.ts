/**
 * Reward estimates for the CATO stake-rewards pool (deployed program
 * DEM7gtr1..., stake-rewards-program commit a16801f).
 *
 * How the program pays out: once a day the admin tops up the reward vault
 * (STAKE_REVENUE_TRANSFER_CATO, default 100 CATO) and calls distribute for
 * each staker, paying floor(stake * vaultBalance / total_staked). Fresh
 * deposits are left out until they have waited 80,000 s, and whatever is not
 * paid out stays in the vault for the next day. In steady state the full daily
 * amount therefore ends up with the stake that is earning, so:
 *
 *   share     = yourEarningStake / earningStake
 *   perDay    = share * dailyReward
 *   perYear   = perDay * 365
 *   pool APY  = dailyReward * 365 / earningStake
 *
 * For a new deposit of X the deposit grows the pool too:
 *   share = X / (earningStake + X)
 */

export type Estimate = {
  /** Fraction of the pool, 0..1. */
  share: number;
  perDay: number;
  perYear: number;
};

export function poolApy(earningStake: number, dailyReward: number): number | null {
  if (!(earningStake > 0) || !(dailyReward > 0)) return null;
  return ((dailyReward * 365) / earningStake) * 100;
}

/**
 * @param amount       CATO the wallet has (or would have) staked.
 * @param poolStake    CATO earning in the whole pool.
 * @param inPool       true when `amount` is already counted in poolStake.
 */
export function estimateRewards(
  amount: number,
  poolStake: number,
  dailyReward: number,
  inPool = false,
): Estimate {
  if (!(amount > 0) || !(dailyReward > 0)) return { share: 0, perDay: 0, perYear: 0 };
  const pool = inPool ? poolStake : poolStake + amount;
  const share = pool > 0 ? Math.min(1, amount / pool) : 0;
  const perDay = share * dailyReward;
  return { share, perDay, perYear: perDay * 365 };
}

export function formatCato(n: number, maxDigits = 2): string {
  const digits = n !== 0 && Math.abs(n) < 1 ? Math.max(maxDigits, 3) : maxDigits;
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function formatPercent(fraction: number): string {
  const pct = fraction * 100;
  if (pct === 0) return "0%";
  if (pct < 0.01) return "<0.01%";
  return `${pct.toLocaleString("en-US", { maximumFractionDigits: pct < 10 ? 2 : 1 })}%`;
}
